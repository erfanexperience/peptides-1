/**
 * ConvesioPay Accelerated Checkout (standalone express area).
 *
 * Renders express buttons above checkout form and calls the
 * accelerated backend endpoint directly after wallet authorization.
 */
(function () {
    'use strict';

    const CONFIG = Object.freeze({
        wrapperId: 'peachpay-convesiopay-accelerated-checkout',
        mountId: 'peachpay-convesiopay-accelerated-express-mount'
    });

    const state = {
        component: null,
        mounted: false,
        submitting: false,
        redirecting: false,
        applePaySessionPrimed: false,
        lastApplePayPrimeSignature: '',
        googlePaySessionPrimed: false,
        lastGooglePayPrimeSignature: '',
        lastServerTotals: null,
        applePaySelectedShippingMethod: '',
        lastApplePayShippingAddress: null,
        applePaySheetActive: false,
        googlePaySheetActive: false,
        // In-flight prime promises — coalesces concurrent calls so only one
        // recalculate request is in-flight per wallet at any given time.
        primingApplePay: null,
        primingGooglePay: null,
        // Debounce timer for scheduleMount.
        mountTimer: null,
        submitGuardBound: false,
        submitOverlayTimer: null,
        // Idempotency key for the current payment attempt. Generated once when
        // the user starts a payment and cleared after success/failure so that a
        // retry (second tap) gets a fresh key while re-submissions of the same
        // attempt are deduplicated by the backend.
        currentIdempotencyKey: null,
        // Product page context: set on init and refreshed on variation/quantity change.
        // null on non-product pages; object with product_id/quantity/variation_id/variation
        // on product pages.
        productContext: null
    };

    function getSettings() {
        return window.peachpay_convesiopay_unified_data || {};
    }

    /**
     * Returns the merchant label to display in the Apple Pay / Google Pay sheet.
     *
     * Priority:
     *   1. WP store name  — get_bloginfo('name') passed from PHP as store_name.
     *      This is what customers recognise; it appears as "Pay [store_name]" in
     *      the sheet.
     *   2. Site hostname  — PHP passes the bare domain as store_url so the sheet
     *      always shows something meaningful even when the site title is blank.
     *   3. integration_name — the ConvesioPay API integration identifier, which
     *      may not be store-branded.
     *   4. Static default 'PeachPay'.
     *
     * Stripe's express-checkout element uses the same priority: store name first,
     * then domain, then plugin default.
     */
    function getMerchantLabel() {
        const settings = getSettings();
        const storeName = toSafeString(settings.store_name || '').trim();
        if (storeName) {
            return storeName;
        }
        const storeUrl = toSafeString(settings.store_url || '').trim();
        if (storeUrl) {
            return storeUrl;
        }
        return toSafeString(settings.integration_name || 'PeachPay');
    }

    function toBoolYes(value) {
        return String(value || '').toLowerCase() === 'yes';
    }

    function isCheckoutContext() {
        if (document.querySelector('form.checkout')) {
            return true;
        }
        if (document.querySelector('.wc-block-checkout')) {
            return true;
        }
        return window.location.pathname.indexOf('/checkout') !== -1;
    }

    function isCartContext() {
        // Don't match checkout page as cart (some themes have both selectors on checkout).
        if (isCheckoutContext()) {
            return false;
        }
        // Classic cart.
        if (document.querySelector('.cart-collaterals') ||
            document.querySelector('form.woocommerce-cart-form') ||
            document.querySelector('.wc-proceed-to-checkout')) {
            return true;
        }
        // Block cart.
        if (document.querySelector('.wc-block-cart') ||
            document.querySelector('.wp-block-woocommerce-cart')) {
            return true;
        }
        return false;
    }

    function isProductPage() {
        // Never match checkout or cart pages as a product page.
        if (isCheckoutContext() || isCartContext()) {
            return false;
        }
        // WordPress adds single-product body class on single product pages.
        if (document.body.classList.contains('single-product')) {
            return true;
        }
        // Fallback: classic WooCommerce product page has a form.cart inside .product.
        if (document.querySelector('.product form.cart')) {
            return true;
        }
        return false;
    }

    /**
     * Read the current product context from the add-to-cart form.
     * Returns null if no product form is found.
     * This is called fresh on every prime and order build so that quantity
     * and variation changes are reflected without requiring a page reload.
     */
    function getProductContext() {
        const form = document.querySelector('form.cart');
        if (!form) {
            return null;
        }

        // Product ID: WooCommerce injects a hidden product_id input for variable
        // products; for simple products the value lives on [name="add-to-cart"].
        let productId = 0;
        const productIdInput = form.querySelector('input[name="product_id"]');
        if (productIdInput) {
            productId = parseInt(productIdInput.value, 10) || 0;
        }
        if (!productId) {
            const addToCartInput = form.querySelector('button[name="add-to-cart"], input[name="add-to-cart"]');
            if (addToCartInput) {
                productId = parseInt(addToCartInput.value, 10) || 0;
            }
        }
        // Last resort: postid-{n} body class injected by WordPress.
        if (!productId) {
            const match = document.body.className.match(/\bpostid-(\d+)\b/);
            if (match) {
                productId = parseInt(match[1], 10) || 0;
            }
        }

        // Quantity.
        const qtyInput = form.querySelector('input.qty, input[name="quantity"]');
        const quantity = Math.max(1, parseInt((qtyInput && qtyInput.value) || '1', 10) || 1);

        // Variation ID (only present for variable products once a variation is chosen).
        const variationIdInput = form.querySelector('input[name="variation_id"]');
        const variationId = parseInt((variationIdInput && variationIdInput.value) || '0', 10) || 0;

        // Variation attributes (select[name="attribute_*"] inputs).
        const variation = {};
        form.querySelectorAll('[name^="attribute_"]').forEach(function (el) {
            const attrName = el.name; // e.g. "attribute_pa_color"
            variation[attrName] = toSafeString(el.value || '');
        });

        const ctx = {
            product_id: productId,
            quantity: quantity
        };
        if (variationId) {
            ctx.variation_id = variationId;
        }
        if (Object.keys(variation).length > 0) {
            ctx.variation = variation;
        }
        return ctx;
    }

    // Product types that are never supported for accelerated checkout on the
    // product page — mirrors PHP validate_product_for_accelerated_checkout().
    var UNSUPPORTED_PRODUCT_PAGE_TYPES = ['grouped', 'external', 'composite'];

    // Product types that require a resolved variation_id before the buttons
    // can be shown — extends the existing 'variable' guard to cover
    // WooCommerce Subscriptions' 'variable-subscription' type.
    var VARIABLE_LIKE_TYPES = ['variable', 'variable-subscription'];

    function canRender() {
        const settings = getSettings();
        const accel = settings.accelerated_checkout || {};
        const appleEnabled = toBoolYes(accel.applepay_enabled);
        const googleEnabled = toBoolYes(accel.googlepay_enabled);
        const hasWallet = appleEnabled || googleEnabled;
        const hasSdkConfig = Boolean(settings?.convesiopay_config?.apiKey);
        if (!hasWallet || !hasSdkConfig) {
            return false;
        }
        if (isCheckoutContext() && toBoolYes(accel.checkout_enabled)) {
            return true;
        }
        if (isCartContext() && toBoolYes(accel.cart_enabled)) {
            return true;
        }
        if (isProductPage() && toBoolYes(accel.product_enabled)) {
            const ctx = getProductContext();
            if (!ctx || !ctx.product_id) {
                return false;
            }

            // Block product types that are never supported on the product page.
            // PHP passes the type via product_type in the script data.
            const productType = settings.product_type || null;
            if (productType && UNSUPPORTED_PRODUCT_PAGE_TYPES.indexOf(productType) !== -1) {
                return false;
            }

            // Variable and variable-subscription products require a resolved
            // variation_id before showing the buttons so the user cannot open
            // the payment sheet before selecting their options.
            const isVariableLike = productType
                ? VARIABLE_LIKE_TYPES.indexOf(productType) !== -1
                : Boolean(document.querySelector('form.cart [name^="attribute_"]'));

            if (isVariableLike && !ctx.variation_id) {
                return false;
            }

            return true;
        }
        return false;
    }

    function getPageContext() {
        if (isProductPage()) {
            return 'product';
        }
        if (isCheckoutContext()) {
            return 'checkout';
        }
        if (isCartContext()) {
            return 'cart';
        }
        return '';
    }

    function getCartUiContainer() {
        return document.querySelector('.cart_totals') ||
            document.querySelector('.wc-block-cart__payment-options') ||
            document.querySelector('.wc-block-cart__sidebar');
    }

    function getNoticeContainer() {
        return getCheckoutForm() || getCartUiContainer();
    }

    // Returns true only when the classic WooCommerce checkout form is present.
    // Used to choose between element-level .block() (classic checkout) and
    // page-wide $.blockUI() (block checkout, cart, product page).
    function isClassicCheckoutContext() {
        return Boolean(getCheckoutForm());
    }

    function getUiLockTarget() {
        return getCheckoutForm() || getCartUiContainer();
    }

    function getProceedToCheckoutButton() {
        return document.querySelector('.wc-proceed-to-checkout .checkout-button') ||
            document.querySelector('.checkout-button.button');
    }

    function setProceedToCheckoutDisabled(disabled) {
        const button = getProceedToCheckoutButton();
        if (!button) {
            return;
        }

        if ('disabled' in button) {
            button.disabled = Boolean(disabled);
        } else if (disabled) {
            button.setAttribute('disabled', 'disabled');
        } else {
            button.removeAttribute('disabled');
        }

        if (disabled) {
            button.setAttribute('aria-disabled', 'true');
            button.classList.add('disabled');
            if (button instanceof HTMLAnchorElement) {
                if (!button.hasAttribute('data-pp-accel-orig-tabindex') && button.hasAttribute('tabindex')) {
                    button.setAttribute('data-pp-accel-orig-tabindex', button.getAttribute('tabindex') || '');
                }
                button.setAttribute('tabindex', '-1');
                button.style.pointerEvents = 'none';
            }
            return;
        }

        button.removeAttribute('aria-disabled');
        button.classList.remove('disabled');
        if (button instanceof HTMLAnchorElement) {
            if (button.hasAttribute('data-pp-accel-orig-tabindex')) {
                const originalTabindex = button.getAttribute('data-pp-accel-orig-tabindex');
                if (originalTabindex) {
                    button.setAttribute('tabindex', originalTabindex);
                } else {
                    button.removeAttribute('tabindex');
                }
                button.removeAttribute('data-pp-accel-orig-tabindex');
            } else {
                button.removeAttribute('tabindex');
            }
            button.style.pointerEvents = '';
        }
    }

    function invalidatePrimedWalletSessions() {
        state.applePaySessionPrimed = false;
        state.googlePaySessionPrimed = false;
    }

    function ensureStyles() {
        const id = 'peachpay-convesiopay-accelerated-style';
        if (document.getElementById(id)) {
            return;
        }
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
            #${CONFIG.wrapperId} {
                margin: 0 0 16px 0;
            }
            #${CONFIG.wrapperId}.pp-accelerated-blocks {
                margin-bottom: 24px;
            }
            #${CONFIG.wrapperId} #${CONFIG.mountId} {
                min-height: 46px;
            }
            #${CONFIG.wrapperId} #${CONFIG.mountId} #convesiopay-checkout {
                width: 100% !important;
            }
            #${CONFIG.wrapperId}.pp-accelerated-blocks #${CONFIG.mountId} {
                min-height: 40px;
            }
            #${CONFIG.wrapperId} .pp-accelerated-divider {
                margin-top: 16px;
                text-align: center;
                color: #757575;
                font-size: 0.875em;
            }

            #${CONFIG.wrapperId} .convesiopay-checkout .adyen-payment__express {
                width: 100% !important;
                grid-gap: 12px !important;
                display: grid !important;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)) !important;

                .adyen-payment__express-wallet {
                    width: 100% !important;
                    max-width: none !important;

                    .google-pay-button-container {
                        display: block !important;

                        .gpay-card-info-container-fill, .gpay-card-info-container-fill > .gpay-card-info-container {
                            display: flex !important;
                        }
                    }
                }
            }

            .wc-block-cart__payment-options #${CONFIG.wrapperId} .convesiopay-checkout .adyen-payment__express {
                grid-template-columns: 1fr !important;
            }

            /* Product page: displayed below the add-to-cart form */
            #${CONFIG.wrapperId}.pp-accelerated-product {
                margin: 16px 0 8px 0;
                width: 100%;
            }
            #${CONFIG.wrapperId}.pp-accelerated-product .pp-accelerated-divider {
                margin-bottom: 12px;
                text-align: center;
                color: #757575;
                font-size: 0.875em;
            }
            #${CONFIG.wrapperId}.pp-accelerated-product #${CONFIG.mountId} {
                min-height: 46px;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Locate the DOM node that the accelerated checkout wrapper should be
     * mounted into (or before).
     *
     * Priority order for each context (matches Stripe's approach):
     *   1. PHP-injected container  — emitted by PeachPay_ConvesioPay_Accelerated_Checkout_Element
     *                                via woocommerce_after_add_to_cart_form /
     *                                woocommerce_proceed_to_checkout /
     *                                woocommerce_checkout_before_customer_details
     *   2. JS fallback              — querySelector heuristics for themes that
     *                                bypass standard WC template hooks, and for
     *                                WooCommerce Blocks (which don't fire classic hooks)
     *
     * Returns { parent, beforeNode, isProduct?, isCart?, isBlocks? } or null.
     */
    function findInsertionAnchor() {
        // ── Checkout page ─────────────────────────────────────────────────────

        // PHP container (classic checkout, woocommerce_checkout_before_customer_details).
        var phpCheckout = document.getElementById('pp-accelerated-checkout-checkout');
        if (phpCheckout) {
            return { parent: phpCheckout, beforeNode: null };
        }

        // Blocks checkout fallback.
        var blocksForm =
            document.querySelector('form.wc-block-checkout__form') ||
            document.querySelector('.wc-block-checkout__form');
        if (blocksForm) {
            return { parent: blocksForm, beforeNode: blocksForm.firstElementChild || null, isBlocks: true };
        }

        // Classic checkout fallback (themes that skip the before_customer_details hook).
        var checkoutForm =
            document.querySelector('form.checkout.woocommerce-checkout') ||
            document.querySelector('form.checkout');
        if (checkoutForm) {
            return { parent: checkoutForm, beforeNode: checkoutForm.firstElementChild || null };
        }

        // ── Cart page ─────────────────────────────────────────────────────────

        // PHP container (classic cart, woocommerce_proceed_to_checkout).
        var phpCart = document.getElementById('pp-accelerated-checkout-cart');
        if (phpCart) {
            return { parent: phpCart, beforeNode: null, isCart: true };
        }

        // Blocks cart fallback.
        var cartPaymentOptions = document.querySelector('.wc-block-cart__payment-options');
        if (cartPaymentOptions) {
            return { parent: cartPaymentOptions, beforeNode: cartPaymentOptions.firstElementChild || null, isBlocks: false, isCart: true };
        }

        // Classic cart fallback — insert above the Proceed to Checkout button.
        var proceedButton =
            document.querySelector('.cart_totals .wc-proceed-to-checkout') ||
            document.querySelector('.wc-proceed-to-checkout');
        if (proceedButton && proceedButton.parentNode) {
            return { parent: proceedButton.parentNode, beforeNode: proceedButton, isCart: true };
        }

        // ── Product page ──────────────────────────────────────────────────────

        // PHP container (woocommerce_after_add_to_cart_form).
        var phpProduct = document.getElementById('pp-accelerated-checkout-product');
        if (phpProduct) {
            return { parent: phpProduct, beforeNode: null, isProduct: true };
        }

        // Fallback — insert immediately after the Add to Cart form.
        var productCartForm =
            document.querySelector('.single-product form.cart') ||
            document.querySelector('.product form.cart') ||
            document.querySelector('form.cart');
        if (productCartForm && productCartForm.parentNode) {
            return { parent: productCartForm.parentNode, beforeNode: productCartForm.nextSibling || null, isProduct: true };
        }

        return null;
    }

    function syncWrapperLayout(wrapper, isBlocks, isCart, isProduct) {
        if (!wrapper) {
            return;
        }
        wrapper.classList.toggle('pp-accelerated-blocks', Boolean(isBlocks));
        wrapper.classList.toggle('pp-accelerated-product', Boolean(isProduct));

        const mountNode = wrapper.querySelector('#' + CONFIG.mountId);
        if (!mountNode) {
            return;
        }

        if (isBlocks) {
            // Use --cart or --checkout suffix to match Stripe's class convention.
            const pageSuffix = isCart ? 'cart' : 'checkout';

            // Re-use an existing express container regardless of previous suffix,
            // then update className to match the current page context.
            let expressContainer = wrapper.querySelector('.wc-block-components-express-payment');
            if (!expressContainer) {
                expressContainer = document.createElement('div');
                expressContainer.setAttribute('aria-disabled', 'false');
                expressContainer.setAttribute('aria-live', 'polite');
                wrapper.insertBefore(expressContainer, wrapper.firstChild || null);
            }
            expressContainer.className = 'wc-block-components-express-payment wc-block-components-express-payment--' + pageSuffix;

            let titleContainer = expressContainer.querySelector('.wc-block-components-express-payment__title-container');
            if (!titleContainer) {
                titleContainer = document.createElement('div');
                titleContainer.className = 'wc-block-components-express-payment__title-container';
                expressContainer.appendChild(titleContainer);
            }
            let titleNode = titleContainer.querySelector('.wc-block-components-express-payment__title');
            if (!titleNode) {
                titleNode = document.createElement('h2');
                titleNode.className = 'wc-block-components-express-payment__title';
                titleContainer.appendChild(titleNode);
            }
            titleNode.textContent = 'Accelerated Checkout';

            let content = expressContainer.querySelector('.wc-block-components-express-payment__content');
            if (!content) {
                content = document.createElement('div');
                content.className = 'wc-block-components-express-payment__content';
                expressContainer.appendChild(content);
            }

            if (!content.querySelector('.wc-block-components-notices')) {
                const notices = document.createElement('div');
                notices.className = 'wc-block-components-notices';
                content.appendChild(notices);
            }

            if (!content.querySelector('.wc-block-components-notices__snackbar')) {
                const snackbar = document.createElement('div');
                snackbar.className = 'wc-block-components-notices__snackbar wc-block-components-notice-snackbar-list';
                snackbar.setAttribute('tabindex', '-1');
                snackbar.innerHTML = '<div></div>';
                content.appendChild(snackbar);
            }

            let eventButtons = content.querySelector('.wc-block-components-express-payment__event-buttons');
            if (!eventButtons) {
                eventButtons = document.createElement('ul');
                eventButtons.className = 'wc-block-components-express-payment__event-buttons';
                content.appendChild(eventButtons);
            }

            let eventButtonItem = eventButtons.querySelector('#' + CONFIG.mountId + '-event-button');
            if (!eventButtonItem) {
                eventButtonItem = document.createElement('li');
                eventButtonItem.id = CONFIG.mountId + '-event-button';
                eventButtons.appendChild(eventButtonItem);
            }

            let mountHost = eventButtonItem.querySelector('.pp-accelerated-mount-host');
            if (!mountHost) {
                mountHost = document.createElement('div');
                mountHost.className = 'pp-accelerated-mount-host';
                eventButtonItem.appendChild(mountHost);
            }
            if (mountNode.parentNode !== mountHost) {
                mountHost.appendChild(mountNode);
            }

            // Re-use or create continue rule, updating class to match current context.
            let continueRule = wrapper.querySelector('.wc-block-components-express-payment-continue-rule');
            if (!continueRule) {
                continueRule = document.createElement('div');
                wrapper.appendChild(continueRule);
            }
            continueRule.className = 'wc-block-components-express-payment-continue-rule wc-block-components-express-payment-continue-rule--' + pageSuffix;
            continueRule.textContent = 'Or continue below';

            // Remove legacy classic divider when blocks structure is active.
            const legacyDivider = wrapper.querySelector('.pp-accelerated-divider');
            if (legacyDivider && legacyDivider.parentNode) {
                legacyDivider.parentNode.removeChild(legacyDivider);
            }
            return;
        }

        // Switch back to lightweight classic layout when not in blocks.
        // Remove any blocks express container regardless of suffix (--checkout or --cart).
        const blocksContainer = wrapper.querySelector('.wc-block-components-express-payment');
        if (blocksContainer && blocksContainer.parentNode) {
            blocksContainer.parentNode.removeChild(blocksContainer);
        }
        const continueRule = wrapper.querySelector('.wc-block-components-express-payment-continue-rule');
        if (continueRule && continueRule.parentNode) {
            continueRule.parentNode.removeChild(continueRule);
        }

        if (isProduct) {
            // Product page layout: divider ABOVE the buttons (buttons appear below add-to-cart).
            let dividerNode = wrapper.querySelector('.pp-accelerated-divider');
            if (!dividerNode) {
                dividerNode = document.createElement('div');
                dividerNode.className = 'pp-accelerated-divider';
                wrapper.insertBefore(dividerNode, wrapper.firstChild || null);
            }
            dividerNode.textContent = '— Or —';
            if (mountNode.parentNode !== wrapper) {
                wrapper.appendChild(mountNode);
            }
        } else {
            if (mountNode.parentNode !== wrapper) {
                wrapper.insertBefore(mountNode, wrapper.firstChild || null);
            }
            let dividerNode = wrapper.querySelector('.pp-accelerated-divider');
            if (!dividerNode) {
                dividerNode = document.createElement('div');
                wrapper.appendChild(dividerNode);
            }
            dividerNode.className = isCart
                ? 'wc-block-components-express-payment-continue-rule wc-block-components-express-payment-continue-rule--cart pp-accelerated-divider'
                : 'pp-accelerated-divider';
            dividerNode.textContent = isCart ? 'Or' : '— OR —';
        }
    }

    function ensureWrapper() {
        const anchor = findInsertionAnchor();
        if (!anchor || !anchor.parent) {
            return null;
        }
        let wrapper = document.getElementById(CONFIG.wrapperId);
        if (wrapper) {
            // Keep wrapper in the desired location if checkout DOM refresh moves/replaces nodes.
            if (wrapper.parentNode !== anchor.parent) {
                if (anchor.beforeNode) {
                    anchor.parent.insertBefore(wrapper, anchor.beforeNode);
                } else {
                    anchor.parent.appendChild(wrapper);
                }
            }
            syncWrapperLayout(wrapper, Boolean(anchor.isBlocks), Boolean(anchor.isCart), Boolean(anchor.isProduct));
            return wrapper;
        }

        wrapper = document.createElement('div');
        wrapper.id = CONFIG.wrapperId;
        wrapper.innerHTML = `<div id="${CONFIG.mountId}"></div>`;
        syncWrapperLayout(wrapper, Boolean(anchor.isBlocks), Boolean(anchor.isCart), Boolean(anchor.isProduct));
        if (anchor.beforeNode) {
            anchor.parent.insertBefore(wrapper, anchor.beforeNode);
        } else {
            anchor.parent.appendChild(wrapper);
        }
        return wrapper;
    }

    function showError(message) {
        const container = getNoticeContainer();
        if (!container) {
            console.error('[ConvesioPay Accelerated]', message);
            return;
        }
        clearError();
        const safeMessage = toSafeString(message || 'Unable to complete accelerated checkout.');
        const notice = document.createElement('div');
        notice.className = 'woocommerce-NoticeGroup woocommerce-NoticeGroup-checkout pp-convesiopay-accelerated-checkout-notice';
        notice.innerHTML = '<ul class="woocommerce-error" role="alert"><li>' + safeMessage + '</li></ul>';
        container.insertBefore(notice, container.firstChild || null);
    }

    function clearError() {
        const existing = document.querySelectorAll('.pp-convesiopay-accelerated-checkout-notice');
        if (!existing || existing.length === 0) {
            return;
        }
        existing.forEach(function (node) {
            if (node && node.parentNode) {
                node.parentNode.removeChild(node);
            }
        });
    }

    function getCheckoutForm() {
        return document.querySelector('form.checkout.woocommerce-checkout') ||
            document.querySelector('form.checkout');
    }

    function getCheckoutFormJquery() {
        if (!window.jQuery) {
            return null;
        }
        const form = getCheckoutForm();
        return form ? window.jQuery(form) : null;
    }

    function setPlaceOrderDisabled(disabled) {
        const buttons = document.querySelectorAll(
            '#place_order, button[name="woocommerce_checkout_place_order"], form.checkout button[type="submit"]'
        );
        buttons.forEach(function (button) {
            if (!(button instanceof HTMLButtonElement) && !(button instanceof HTMLInputElement)) {
                return;
            }
            button.disabled = Boolean(disabled);
            if (disabled) {
                button.setAttribute('aria-disabled', 'true');
            } else {
                button.removeAttribute('aria-disabled');
            }
        });
    }

    function lockAcceleratedUi() {
        const $ = window.jQuery;
        const blockOptions = {
            message: null,
            overlayCSS: {
                background: '#fff',
                opacity: 0.6
            }
        };

        document.body.classList.add('processing');
        setPlaceOrderDisabled(true);
        setProceedToCheckoutDisabled(true);

        if (state.submitOverlayTimer) {
            clearTimeout(state.submitOverlayTimer);
            state.submitOverlayTimer = null;
        }

        if ($) {
            if (isClassicCheckoutContext()) {
                // Classic checkout: block just the checkout form, matching the
                // standard WooCommerce place-order processing overlay exactly.
                const $form = getCheckoutFormJquery();
                if ($form && $form.length && typeof $form.block === 'function') {
                    $form.block(blockOptions);
                }
            } else {
                // Block checkout, classic/block cart, product page: the accelerated
                // button sits outside any form element, so page-wide $.blockUI() is
                // the correct approach. This is identical to what Stripe's
                // payment-request.js uses for its express checkout button in the
                // same non-classic-checkout contexts.
                if (typeof $.blockUI === 'function') {
                    $.blockUI(blockOptions);
                }
            }
        }

        state.submitOverlayTimer = setTimeout(function () {
            if (!state.submitting && !state.redirecting) {
                return;
            }
            accelLog('Accelerated checkout UI lock failsafe released.');
            state.submitting = false;
            state.redirecting = false;
            unlockAcceleratedUi();
        }, 15000);
    }

    function unlockAcceleratedUi() {
        const $ = window.jQuery;

        if (state.submitOverlayTimer) {
            clearTimeout(state.submitOverlayTimer);
            state.submitOverlayTimer = null;
        }

        if ($) {
            if (isClassicCheckoutContext()) {
                const $form = getCheckoutFormJquery();
                if ($form && $form.length && typeof $form.unblock === 'function') {
                    $form.unblock();
                }
            } else {
                if (typeof $.unblockUI === 'function') {
                    $.unblockUI();
                }
            }
        }

        document.body.classList.remove('processing');
        setPlaceOrderDisabled(false);
        setProceedToCheckoutDisabled(false);
    }

    function bindAcceleratedCheckoutSubmitGuard() {
        if (state.submitGuardBound) {
            return;
        }
        state.submitGuardBound = true;

        document.addEventListener('submit', function (event) {
            const form = event.target && event.target.closest ? event.target.closest('form.checkout') : null;
            if (!form || !state.submitting) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
        }, true);

        document.addEventListener('click', function (event) {
            const target = event.target && event.target.closest
                ? event.target.closest('#place_order, button[name="woocommerce_checkout_place_order"], form.checkout button[type="submit"], .wc-proceed-to-checkout .checkout-button, .checkout-button.button')
                : null;
            if (!target || !state.submitting) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
        }, true);
    }

    function toSafeString(value) {
        if (value === null || typeof value === 'undefined') {
            return '';
        }
        return String(value);
    }

    function accelLog(message, data) {
        try {
            if (typeof console === 'undefined' || typeof console.log !== 'function') {
                return;
            }
            if (typeof data === 'undefined') {
                console.log('[ConvesioPay Accelerated]', message);
                return;
            }
            console.log('[ConvesioPay Accelerated]', message, data);
        } catch (_e) {
            // no-op
        }
    }

    function normalizeWalletType(event) {
        const candidates = [
            event?.paymentMethod,
            event?.type,
            event?.paymentData?.paymentMethod,
            event?.paymentData?.type
        ].map((v) => toSafeString(v).toLowerCase());

        if (candidates.some((v) => v.includes('apple'))) {
            return 'applepay';
        }
        if (candidates.some((v) => v.includes('google'))) {
            return 'googlepay';
        }
        return '';
    }

    function hasSuccessfulAuth(event) {
        return Boolean(
            event?.isSuccessful === true ||
            toSafeString(event?.status).toLowerCase() === 'authorized' ||
            event?.token ||
            event?.paymentToken ||
            event?.paymentData?.token
        );
    }

    function extractEventToken(event) {
        return toSafeString(
            event?.token ||
            event?.paymentToken ||
            event?.paymentData?.token ||
            event?.data?.token ||
            ''
        );
    }

    function mapAddress(raw) {
        const source = raw || {};
        // Native Apple Pay contacts use addressLines[] (array), locality (city),
        // administrativeArea (state/province), and countryCode instead of country.
        // The ConvesioPay SDK may expose the raw Apple Pay contact object, so we
        // must handle both the SDK-normalised field names and the native AP ones.
        const addressLines = Array.isArray(source.addressLines) ? source.addressLines : [];
        return {
            line1: toSafeString(source.line1 || source.address1 || source.houseNumberOrName || addressLines[0] || ''),
            line2: toSafeString(source.line2 || source.address2 || source.street || addressLines[1] || ''),
            city: toSafeString(source.city || source.locality || ''),
            state: toSafeString(source.state || source.stateOrProvince || source.administrativeArea || ''),
            postal_code: toSafeString(source.postalCode || source.postal_code || source.zip || ''),
            // Prefer countryCode (ISO 2-letter, e.g. "US") over country (full name,
            // e.g. "United States"). Native Apple Pay contacts always have countryCode;
            // SDK-normalised objects use country but already normalise it to the ISO code.
            country: toSafeString(source.countryCode || source.country || '')
        };
    }

    function getCustomerFallbackFromDom() {
        const emailInput =
            document.querySelector('#billing_email') ||
            document.querySelector('input[name="billing_email"]') ||
            document.querySelector('input[type="email"]');
        const firstNameInput =
            document.querySelector('#billing_first_name') ||
            document.querySelector('input[name="billing_first_name"]');
        const lastNameInput =
            document.querySelector('#billing_last_name') ||
            document.querySelector('input[name="billing_last_name"]');
        const phoneInput =
            document.querySelector('#billing_phone') ||
            document.querySelector('input[name="billing_phone"]');

        return {
            email: toSafeString(emailInput?.value || ''),
            first_name: toSafeString(firstNameInput?.value || ''),
            last_name: toSafeString(lastNameInput?.value || ''),
            phone: toSafeString(phoneInput?.value || '')
        };
    }

    function getAddressFallbackFromDom(prefix) {
        const pick = (field) =>
            document.querySelector(`#${prefix}_${field}`) ||
            document.querySelector(`input[name="${prefix}_${field}"]`) ||
            document.querySelector(`select[name="${prefix}_${field}"]`);
        return {
            line1: toSafeString(pick('address_1')?.value || ''),
            line2: toSafeString(pick('address_2')?.value || ''),
            city: toSafeString(pick('city')?.value || ''),
            state: toSafeString(pick('state')?.value || ''),
            postal_code: toSafeString(pick('postcode')?.value || ''),
            country: toSafeString(pick('country')?.value || '')
        };
    }

    function getAmountSnapshot() {
        if (state.lastServerTotals && Number.isFinite(Number(state.lastServerTotals.total_minor))) {
            return {
                currency: toSafeString(state.lastServerTotals.currency || 'USD').toUpperCase(),
                total_minor: Math.max(0, Math.round(Number(state.lastServerTotals.total_minor)))
            };
        }
        const settings = getSettings();
        const totalMinor = Number.isFinite(Number(settings?.cart_total))
            ? Math.max(0, Math.round(Number(settings.cart_total) * 100))
            : 0;
        return {
            currency: toSafeString(settings?.currency || 'USD').toUpperCase(),
            total_minor: totalMinor
        };
    }

    function minorToMajorString(minor) {
        const safeMinor = Number.isFinite(Number(minor)) ? Number(minor) : 0;
        return (safeMinor / 100).toFixed(2);
    }

    function getSupportedCountries() {
        // Prefer the list of allowed shipping countries from WooCommerce settings
        // (passed via wp_localize_script). Falls back to a minimal safe set so the
        // button is never invisible for stores that haven't configured this yet.
        const settings = getSettings();
        const fromSettings = settings?.accelerated_checkout?.allowed_countries;
        if (Array.isArray(fromSettings) && fromSettings.length > 0) {
            return fromSettings;
        }
        return ['US', 'CA', 'GB'];
    }

    function parseMajorToMinor(value) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) {
            return 0;
        }
        return Math.max(0, Math.round(amount * 100));
    }

    function getAcceleratedFeeLabel(walletType) {
        const settings = getSettings();
        const feeConfig = settings?.fee_config || {};
        const normalizedWalletType = toSafeString(walletType || 'applepay').toLowerCase();
        const configuredLabel = toSafeString(feeConfig?.[normalizedWalletType]?.label || '').trim();
        if (configuredLabel) {
            return configuredLabel;
        }
        return 'Payment gateway fee';
    }

    function normalizeApplePayCartItems(items) {
        if (!Array.isArray(items) || items.length === 0) {
            return [];
        }
        return items
            .map(function (item, index) {
                const label = toSafeString(item?.label || 'Item ' + (index + 1));
                const amountMinor = Number.isFinite(Number(item?.amount_minor))
                    ? Math.max(0, Math.round(Number(item.amount_minor)))
                    : parseMajorToMinor(toSafeString(item?.amount || '0.00'));
                return {
                    label: label,
                    amount_minor: amountMinor
                };
            })
            .filter(function (item) {
                return Boolean(item.label);
            });
    }

    function getSelectedShippingMethodLabel(shippingMethods, selectedShippingMethod) {
        if (!Array.isArray(shippingMethods) || shippingMethods.length === 0) {
            return 'Shipping';
        }
        const selectedId = toSafeString(selectedShippingMethod || '');
        const matchingMethod = shippingMethods.find(function (method) {
            return toSafeString(method?.identifier || '') === selectedId;
        });
        const label = toSafeString(matchingMethod?.label || shippingMethods[0]?.label || 'Shipping');
        return label ? 'Shipping via ' + label : 'Shipping';
    }

    function buildApplePayLineItems(cartItems, shippingMinor, taxMinor, feeMinor, discountMinor, shippingLabel) {
        const safeShippingMinor = Math.max(0, Number(shippingMinor || 0));
        const safeTaxMinor = Math.max(0, Number(taxMinor || 0));
        const safeFeeMinor = Math.max(0, Number(feeMinor || 0));
        const safeDiscountMinor = Math.max(0, Number(discountMinor || 0));
        const safeShippingLabel = toSafeString(shippingLabel || 'Shipping');
        const normalizedCartItems = normalizeApplePayCartItems(cartItems);
        const itemsSubtotalMinor = normalizedCartItems.reduce(function (sum, item) {
            return sum + Math.max(0, Number(item?.amount_minor || 0));
        }, 0);
        const lineItems = normalizedCartItems.map(function (item) {
            return {
                label: item.label,
                amount: item.amount_minor,
                type: 'final'
            };
        });

        lineItems.push({
            label: 'Subtotal',
            amount: itemsSubtotalMinor,
            type: 'final'
        });

        if (safeDiscountMinor > 0) {
            lineItems.push({ label: 'Discount', amount: safeDiscountMinor * -1, type: 'final' });
        }

        if (safeFeeMinor > 0) {
            lineItems.push({
                label: getAcceleratedFeeLabel('applepay'),
                amount: safeFeeMinor,
                type: 'final'
            });
        }

        lineItems.push(
            { label: safeShippingLabel, amount: safeShippingMinor, type: 'final' },
            { label: 'Tax', amount: safeTaxMinor, type: 'final' }
        );

        return lineItems;
    }

    function normalizeShippingMethods(methods) {
        if (!Array.isArray(methods) || methods.length === 0) {
            return [];
        }
        return methods
            .map(function (method, index) {
                const identifier = toSafeString(method?.identifier || 'shipping_' + index);
                const amountMajor = toSafeString(method?.amount || '0.00');
                const amountMinor = parseMajorToMinor(amountMajor);
                return {
                    label: toSafeString(method?.label || 'Shipping'),
                    detail: toSafeString(method?.detail || ''),
                    amount_major: amountMajor,
                    amount_minor: amountMinor,
                    identifier: identifier
                };
            })
            .filter(function (method) {
                return Boolean(method.identifier);
            });
    }

    function buildServerTotalsSnapshot(responseBody) {
        const settings = getSettings();
        const subtotalMajor = toSafeString(responseBody?.subtotal || '0.00');
        const shippingMajor = toSafeString(responseBody?.shipping || '0.00');
        const taxMajor = toSafeString(responseBody?.tax || '0.00');
        const totalMajor = toSafeString(responseBody?.total || '0.00');
        const feeMajor = toSafeString(responseBody?.applepay_fee || '0.00');
        const discountMajor = toSafeString(responseBody?.discount || '0.00');
        const shippingMethods = normalizeShippingMethods(responseBody?.shipping_methods || []);
        const selectedShippingMethod = toSafeString(responseBody?.selected_shipping_method || shippingMethods[0]?.identifier || '');
        const cartItems = normalizeApplePayCartItems(responseBody?.cart_items || []);

        return {
            currency: toSafeString(settings?.currency || 'USD').toUpperCase(),
            subtotal_major: subtotalMajor,
            shipping_major: shippingMajor,
            tax_major: taxMajor,
            total_major: totalMajor,
            subtotal_minor: parseMajorToMinor(subtotalMajor),
            discount_major: discountMajor,
            shipping_minor: parseMajorToMinor(shippingMajor),
            tax_minor: parseMajorToMinor(taxMajor),
            total_minor: parseMajorToMinor(totalMajor),
            discount_minor: parseMajorToMinor(discountMajor),
            fee_major: feeMajor,
            fee_minor: parseMajorToMinor(feeMajor),
            cart_items: cartItems,
            shipping_methods: shippingMethods,
            selected_shipping_method: selectedShippingMethod
        };
    }

    /**
     * Parse a WooCommerce-formatted price string to a float.
     * Handles both "1,234.56" (US) and "1.234,56" (EU) decimal conventions.
     */
    function parseWooCommercePrice(text) {
        let clean = (text || '').replace(/[^\d.,]/g, '');
        if (!clean) return null;
        const lastDot   = clean.lastIndexOf('.');
        const lastComma = clean.lastIndexOf(',');
        if (lastComma > lastDot) {
            // EU convention: 1.234,56 — comma is the decimal separator.
            clean = clean.replace(/\./g, '').replace(',', '.');
        } else {
            // US convention: 1,234.56 — dot is the decimal separator.
            clean = clean.replace(/,/g, '');
        }
        const value = parseFloat(clean);
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    /**
     * Read the currently displayed product price from the page DOM.
     * WooCommerce updates these elements live when a variation is chosen, so
     * this always reflects the price the customer is looking at.
     * Returns a float, or null if the price cannot be determined.
     */
    function getProductPageDOMPrice() {
        const selectors = [
            '.summary .price ins .woocommerce-Price-amount.amount bdi',
            '.summary .price ins .woocommerce-Price-amount.amount',
            '.summary .price .woocommerce-Price-amount.amount bdi',
            '.summary .price .woocommerce-Price-amount.amount',
            '.entry-summary .price ins .woocommerce-Price-amount.amount bdi',
            '.entry-summary .price .woocommerce-Price-amount.amount bdi',
        ];
        for (let i = 0; i < selectors.length; i++) {
            const el = document.querySelector(selectors[i]);
            if (el) {
                const val = parseWooCommercePrice(el.textContent || '');
                if (val !== null) return val;
            }
        }
        return null;
    }

    /**
     * Build a serverTotalsSnapshot from the product page DOM price.
     *
     * Shipping and tax are left at zero — they will be filled in by the first
     * onShippingAddressChange callback when the customer actually opens the
     * payment sheet.  Using DOM price here avoids touching the WC cart during
     * page load entirely.
     */
    function buildProductPageInitialTotals() {
        const price = getProductPageDOMPrice();
        if (price === null) return null;
        const priceMajor = price.toFixed(2);
        return buildServerTotalsSnapshot({
            subtotal: priceMajor,
            discount: '0.00',
            shipping: '0.00',
            tax: '0.00',
            total: priceMajor,
            applepay_fee: '0.00',
            cart_items: [],
            shipping_methods: [],
        });
    }

    /**
     * Return a Promise that resolves to the initial serverTotalsSnapshot for
     * session priming.
     *
     * Product page: read price from the DOM — no server call, no cart mutation.
     *   The cart injection (empty_cart + add_to_cart) is deferred until the
     *   customer opens the payment sheet and provides a shipping address.
     *   This matches Stripe's express-checkout behaviour exactly.
     *
     * Cart / checkout page: fetch from server as usual (cart already has items,
     *   no injection happens, just a read + recalculate).
     */
    function getInitialTotalsPromise(walletType) {
        if (isProductPage()) {
            const domTotals = buildProductPageInitialTotals();
            if (domTotals) {
                // Seed state so callbacks that read lastServerTotals before the
                // first onShippingAddressChange get a non-null starting point.
                state.lastServerTotals = domTotals;
                return Promise.resolve(domTotals);
            }
            // DOM price unreadable (edge case) — fall through to server.
        }
        return fetchUpdatedTotals(null, null, undefined, walletType)
            .catch(function () {
                return state.lastServerTotals || buildServerTotalsSnapshot({
                    subtotal: '0.00',
                    shipping: '0.00',
                    tax: '0.00',
                    total: '0.00',
                    shipping_methods: []
                });
            });
    }

    function buildApplePayErrorResponse(message) {
        const errorMessage = toSafeString(message || 'Unable to update totals for Apple Pay.');
        if (typeof window.ApplePayError === 'function') {
            return [new window.ApplePayError('unknown', 'postalAddress', errorMessage)];
        }
        return [{ code: 'unknown', message: errorMessage }];
    }

    function mapAppleShippingContact(contact) {
        const source = contact || {};
        return {
            country: toSafeString(source.countryCode || source.country || '').toUpperCase(),
            state: toSafeString(source.administrativeArea || source.state || ''),
            postcode: toSafeString(source.postalCode || source.postcode || '')
        };
    }

    async function fetchUpdatedTotals(shippingMethod, shippingAddress, shippingAmountMajor, walletType) {
        const settings = getSettings();
        const endpoint = toSafeString(settings?.accelerated_recalculate_route || '');
        if (!endpoint) {
            accelLog('Recalculate endpoint missing from settings.');
            throw new Error('Accelerated recalculate endpoint is not configured.');
        }

        const restNonce = toSafeString(settings?.rest_nonce || settings?.nonce || '');
        const headers = {
            'Content-Type': 'application/json'
        };
        if (restNonce) {
            headers['X-WP-Nonce'] = restNonce;
        }

        const requestPayload = {
            shipping_method: shippingMethod ? toSafeString(shippingMethod) : null,
            shipping_amount: typeof shippingAmountMajor !== 'undefined' && shippingAmountMajor !== null
                ? toSafeString(shippingAmountMajor)
                : null,
            shipping_address: shippingAddress && typeof shippingAddress === 'object'
                ? {
                    country: toSafeString(shippingAddress.country || ''),
                    state: toSafeString(shippingAddress.state || ''),
                    postcode: toSafeString(shippingAddress.postcode || '')
                }
                : {},
            wallet_type: toSafeString(walletType || '')
        };

        // For product page context, always read fresh product context so that
        // quantity/variation changes between taps are reflected without a page reload.
        if (isProductPage()) {
            const productCtx = getProductContext();
            if (productCtx && productCtx.product_id) {
                // Keep state in sync for buildPayload() later.
                state.productContext = productCtx;
                requestPayload.page_context = 'product';
                requestPayload.product_id = productCtx.product_id;
                requestPayload.quantity = productCtx.quantity;
                if (productCtx.variation_id) {
                    requestPayload.variation_id = productCtx.variation_id;
                }
                if (productCtx.variation && Object.keys(productCtx.variation).length > 0) {
                    requestPayload.variation = productCtx.variation;
                }
            }
        }
        accelLog('Recalculate request started.', requestPayload);

        const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify(requestPayload)
        });
        const body = await response.json().catch(function () {
            return {};
        });

        if (!response.ok || !body || body.success !== true) {
            accelLog('Recalculate request failed.', {
                status: response.status,
                body: body
            });
            const error = new Error(toSafeString(body?.message || 'Unable to recalculate totals.'));
            error.code = toSafeString(body?.error_code || '');
            error.status = Number(response.status || 0);
            throw error;
        }

        const snapshot = buildServerTotalsSnapshot(body);
        state.lastServerTotals = snapshot;
        if (toSafeString(snapshot.selected_shipping_method)) {
            state.applePaySelectedShippingMethod = toSafeString(snapshot.selected_shipping_method);
        }
        accelLog('Recalculate request succeeded.', {
            subtotal: snapshot.subtotal_major,
            shipping: snapshot.shipping_major,
            fee: snapshot.applepay_fee_major,
            tax: snapshot.tax_major,
            total: snapshot.total_major,
            selected_shipping_method: snapshot.selected_shipping_method,
            shipping_methods_count: Array.isArray(snapshot.shipping_methods) ? snapshot.shipping_methods.length : 0
        });
        return snapshot;
    }

    // function buildApplePayShippingMethodsForCallback(methods) {
    //     if (!Array.isArray(methods) || methods.length === 0) {
    //         return [];
    //     }
    //     return methods.map(function (method) {
    //         const majorAmount = toSafeString(
    //             method?.amount_major ||
    //             minorToMajorString(Number(method?.amount_minor || 0))
    //         );
    //         return {
    //             label: toSafeString(method?.label || 'Shipping'),
    //             detail: toSafeString(method?.detail || ''),
    //             amount: majorAmount,
    //             identifier: toSafeString(method?.identifier || '')
    //         };
    //     });
    // }

    function buildApplePayShippingMethodsForCallback(methods, selectedId) {
        if (!Array.isArray(methods) || methods.length === 0) {
            return [];
        }
    
        const normalized = methods.map(function (method) {
            const majorAmount = toSafeString(
                method?.amount_major ||
                minorToMajorString(Number(method?.amount_minor || 0))
            );
    
            return {
                label: toSafeString(method?.label || 'Shipping'),
                detail: toSafeString(method?.detail || ''),
                amount: majorAmount,
                identifier: toSafeString(method?.identifier || '')
            };
        });
    
        // Keep the selected method at the top so the sheet reflects the current choice.
        if (selectedId) {
            normalized.sort(function (a, b) {
                if (a.identifier === selectedId) return -1;
                if (b.identifier === selectedId) return 1;
                return 0;
            });
        }
    
        return normalized;
    }

    // SDK docs require shippingMethods.amount as a number in minor units for createApplePaySession.
    // This is distinct from callback return values which use major-unit strings.
    function buildApplePayShippingMethodsForSession(methods) {
        if (!Array.isArray(methods) || methods.length === 0) {
            return [];
        }
        return methods.map(function (method) {
            return {
                label: toSafeString(method?.label || 'Shipping'),
                detail: toSafeString(method?.detail || ''),
                amount: Number(method?.amount_minor || 0),
                identifier: toSafeString(method?.identifier || '')
            };
        });
    }

    function buildApplePayUpdatePayload(updatedTotals) {
        const selectedId = toSafeString(updatedTotals.selected_shipping_method || '');
        const payload = {
            newTotal: buildApplePayTotalObject(updatedTotals.total_minor, updatedTotals.currency),
            newLineItems: buildApplePayLineItemsForCallback(
                updatedTotals.cart_items,
                updatedTotals.shipping_minor,
                updatedTotals.tax_minor,
                updatedTotals.fee_minor,
                updatedTotals.discount_minor,
                getSelectedShippingMethodLabel(updatedTotals.shipping_methods, selectedId)
            ),
            // Always pass updated shipping methods so the sheet reflects the rates
            // available for the new address — without this, the list shown to the
            // customer stays frozen at the methods from the initial session setup.
            newShippingMethods: buildApplePayShippingMethodsForCallback(updatedTotals.shipping_methods || [], selectedId),
            errors: []
        };

        accelLog('Apple Pay shipping update payload built.', {
            selected_shipping_method: selectedId,
            total: updatedTotals.total_major,
            shipping_methods_count: payload.newShippingMethods.length
        });

        return payload;
    }

    function buildApplePayTotalObject(amountMinor, currency) {
        const settings = getSettings();
        return {
            label: getMerchantLabel(),
            amount: minorToMajorString(amountMinor),
            type: 'final',
            currency: toSafeString(currency || 'USD').toUpperCase()
        };
    }

    function buildApplePayLineItemsForCallback(cartItems, shippingMinor, taxMinor, feeMinor, discountMinor, shippingLabel) {
        return buildApplePayLineItems(cartItems, shippingMinor, taxMinor, feeMinor, discountMinor, shippingLabel).map(function (item) {
            return {
                label: item.label,
                amount: minorToMajorString(item.amount),
                type: item.type || 'final'
            };
        });
    }

    function toConvesioAddress(address) {
        const source = address || {};
        return {
            houseNumberOrName: toSafeString(source.line1 || ''),
            street: toSafeString(source.line2 || ''),
            city: toSafeString(source.city || ''),
            stateOrProvince: toSafeString(source.state || ''),
            postalCode: toSafeString(source.postal_code || ''),
            country: toSafeString(source.country || '')
        };
    }

    function isCompleteConvesioAddress(address) {
        return Boolean(
            toSafeString(address?.houseNumberOrName) &&
            toSafeString(address?.street) &&
            toSafeString(address?.city) &&
            toSafeString(address?.stateOrProvince) &&
            toSafeString(address?.postalCode) &&
            toSafeString(address?.country)
        );
    }

    function buildPayload(event) {
        const settings = getSettings();
        const walletType = normalizeWalletType(event);
        const token = toSafeString(event?.token || event?.paymentToken || event?.paymentData?.token || '');

        // ConvesioPay SDK may expose the contact data under several different shapes:
        //   - Normalised: event.customer / event.billingAddress / event.shippingAddress
        //   - Wrapped:    event.paymentData.{customer|billingAddress|shippingAddress}
        //   - Native AP:  event.shippingContact / event.billingContact (same field names as
        //                 ApplePayPaymentContact — givenName, familyName, emailAddress,
        //                 phoneNumber, addressLines[], locality, administrativeArea, countryCode)
        //
        // We probe all shapes and pick the first non-empty value for each field so that
        // wallet-provided data is always preferred over the checkout form fallback.
        const eventCustomer = event?.customer || event?.paymentData?.customer
            || event?.shippingContact || event?.paymentData?.shippingContact
            || event?.billingContact  || event?.paymentData?.billingContact
            || {};
        const fallbackCustomer = getCustomerFallbackFromDom();

        const billingRaw = event?.billingAddress  || event?.paymentData?.billingAddress
            || event?.billingContact              || event?.paymentData?.billingContact
            || {};
        const shippingRaw = event?.shippingAddress || event?.paymentData?.shippingAddress
            || event?.shippingContact             || event?.paymentData?.shippingContact
            || {};

        // Handle both normalised firstName/lastName and native AP givenName/familyName.
        const firstName = toSafeString(
            eventCustomer?.firstName  || eventCustomer?.givenName  || fallbackCustomer.first_name || ''
        );
        const lastName  = toSafeString(
            eventCustomer?.lastName   || eventCustomer?.familyName || fallbackCustomer.last_name  || ''
        );
        const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

        const customer = {
            name:       fullName || toSafeString(eventCustomer?.name || ''),
            first_name: firstName,
            last_name:  lastName,
            // Native AP uses emailAddress / phoneNumber; SDK may normalise to email / phone.
            email: toSafeString(eventCustomer?.email        || eventCustomer?.emailAddress || fallbackCustomer.email || ''),
            phone: toSafeString(eventCustomer?.phone        || eventCustomer?.phoneNumber  || fallbackCustomer.phone || '')
        };

        const billingAddress = mapAddress(billingRaw);
        const shippingAddress = mapAddress(shippingRaw);

        const fallbackBilling = getAddressFallbackFromDom('billing');
        const fallbackShipping = getAddressFallbackFromDom('shipping');

        const mergedBilling = {
            line1: billingAddress.line1 || fallbackBilling.line1,
            line2: billingAddress.line2 || fallbackBilling.line2,
            city: billingAddress.city || fallbackBilling.city,
            state: billingAddress.state || fallbackBilling.state,
            postal_code: billingAddress.postal_code || fallbackBilling.postal_code,
            country: billingAddress.country || fallbackBilling.country
        };
        const mergedShipping = {
            line1: shippingAddress.line1 || fallbackShipping.line1 || mergedBilling.line1,
            line2: shippingAddress.line2 || fallbackShipping.line2 || mergedBilling.line2,
            city: shippingAddress.city || fallbackShipping.city || mergedBilling.city,
            state: shippingAddress.state || fallbackShipping.state || mergedBilling.state,
            postal_code: shippingAddress.postal_code || fallbackShipping.postal_code || mergedBilling.postal_code,
            country: shippingAddress.country || fallbackShipping.country || mergedBilling.country
        };

        // Re-use the key that was generated when the payment attempt started so
        // that re-submissions of the same attempt (e.g. a race between two submit
        // calls) are deduplicated by the backend. The key is cleared in
        // submitAccelerated after the response so a fresh attempt gets a new key.
        if (!state.currentIdempotencyKey) {
            let generated = '';
            try {
                generated = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : '';
            } catch (_e) {
                generated = '';
            }
            if (!generated) {
                generated = 'pp-cp-accel-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
            }
            state.currentIdempotencyKey = generated;
        }
        const idempotencyKey = state.currentIdempotencyKey;

        const orderPayload = {
            wallet_type: walletType || (toBoolYes(settings?.accelerated_checkout?.applepay_enabled) ? 'applepay' : 'googlepay'),
            page_context: getPageContext() || 'checkout',
            idempotency_key: idempotencyKey,
            convesiopay_payment_token: token,
            customer: customer,
            billing_address: mergedBilling,
            shipping_address: mergedShipping,
            selected_shipping_method: toSafeString(state.applePaySelectedShippingMethod || state.lastServerTotals?.selected_shipping_method || ''),
            amount_snapshot: getAmountSnapshot(),
            nonce: toSafeString(settings?.rest_nonce || settings?.nonce || '')
        };

        // Attach product context when on a product page so the backend can build
        // an isolated cart with only this product for order creation.
        if (isProductPage()) {
            // Re-read fresh so the most recent quantity / variation is captured,
            // even if the user tweaked it after opening the wallet sheet.
            const productCtxForOrder = state.productContext || getProductContext();
            if (productCtxForOrder && productCtxForOrder.product_id) {
                orderPayload.product_id = productCtxForOrder.product_id;
                orderPayload.quantity = productCtxForOrder.quantity;
                if (productCtxForOrder.variation_id) {
                    orderPayload.variation_id = productCtxForOrder.variation_id;
                }
                if (productCtxForOrder.variation && Object.keys(productCtxForOrder.variation).length > 0) {
                    orderPayload.variation = productCtxForOrder.variation;
                }
            }
        }

        return orderPayload;
    }

    function buildApplePaySessionPayload(serverTotals) {
        const settings = getSettings();
        const fallbackCustomer = getCustomerFallbackFromDom();
        const fallbackBilling = getAddressFallbackFromDom('billing');
        const fallbackShipping = getAddressFallbackFromDom('shipping');
        const totals = serverTotals || state.lastServerTotals || buildServerTotalsSnapshot({
            subtotal: '0.00',
            shipping: '0.00',
            tax: '0.00',
            total: '0.00',
            shipping_methods: []
        });
        const supportedCountries = getSupportedCountries();
        const selectedShippingMinor = totals.shipping_minor;
        const taxMinor = totals.tax_minor;
        const shippingLabel = getSelectedShippingMethodLabel(
            totals.shipping_methods,
            totals.selected_shipping_method
        );

        const name = [fallbackCustomer.first_name, fallbackCustomer.last_name]
            .filter(Boolean)
            .join(' ')
            .trim();

        const billingAddress = toConvesioAddress(fallbackBilling);
        const shippingAddress = toConvesioAddress({
            line1: fallbackShipping.line1 || fallbackBilling.line1,
            line2: fallbackShipping.line2 || fallbackBilling.line2,
            city: fallbackShipping.city || fallbackBilling.city,
            state: fallbackShipping.state || fallbackBilling.state,
            postal_code: fallbackShipping.postal_code || fallbackBilling.postal_code,
            country: fallbackShipping.country || fallbackBilling.country
        });

        const lineItems = buildApplePayLineItems(
            totals.cart_items,
            selectedShippingMinor,
            taxMinor,
            totals.fee_minor,
            totals.discount_minor,
            shippingLabel
        );

        const payload = {
            integration: toSafeString(settings?.integration_name || 'PeachPay'),
            returnUrl: window.location.href,
            amount: Number(totals.total_minor || 0),
            currency: toSafeString(totals.currency || 'USD'),
            email: toSafeString(fallbackCustomer.email || ''),
            name: toSafeString(name || ''),
            shippingType: 'shipping',
            supportedCountries: supportedCountries,
            shippingMethods: buildApplePayShippingMethodsForSession(totals.shipping_methods),
            lineItems: lineItems,
            onShippingAddressChange: async function (shippingContact) {
                try {
                    const mappedAddress = mapAppleShippingContact(shippingContact);
                    state.lastApplePayShippingAddress = mappedAddress;
                    const preferredShippingMethod = toSafeString(
                        state.applePaySelectedShippingMethod ||
                        totals.selected_shipping_method ||
                        ''
                    );
                    let updatedTotals;
                    try {
                        updatedTotals = await fetchUpdatedTotals(
                            preferredShippingMethod || null,
                            mappedAddress,
                            toSafeString(state.lastServerTotals?.shipping_major || totals.shipping_major || ''),
                            'applepay'
                        );
                    } catch (error) {
                        // If previous method is no longer valid for the new address, retry with backend fallback.
                        if (toSafeString(error?.code) === 'invalid_shipping_method') {
                            updatedTotals = await fetchUpdatedTotals(
                                null,
                                mappedAddress,
                                toSafeString(state.lastServerTotals?.shipping_major || totals.shipping_major || ''),
                                'applepay'
                            );
                        } else {
                            throw error;
                        }
                    }
                    accelLog('Apple Pay address change update payload.', {
                        country: toSafeString(shippingContact?.countryCode || shippingContact?.country || ''),
                        selected_shipping_method: updatedTotals.selected_shipping_method,
                        shipping_methods_count: Array.isArray(updatedTotals.shipping_methods) ? updatedTotals.shipping_methods.length : 0,
                        shipping_method_ids: Array.isArray(updatedTotals.shipping_methods)
                            ? updatedTotals.shipping_methods.map(function (m) { return toSafeString(m?.identifier || ''); })
                            : []
                    });
                    return buildApplePayUpdatePayload(updatedTotals);
                } catch (error) {
                    return {
                        errors: buildApplePayErrorResponse(error?.message)
                    };
                }
            },
            onShippingMethodChange: async function (shippingMethod) {
                try {
                    const selectedIdentifier = toSafeString(
                        shippingMethod?.identifier ||
                        shippingMethod?.id ||
                        shippingMethod?.value ||
                        ''
                    );
                    if (selectedIdentifier) {
                        state.applePaySelectedShippingMethod = selectedIdentifier;
                    }
                    // IMPORTANT: always pass the Apple Pay address that was set by the most
                    // recent onShippingAddressChange. Without it, the backend falls back to
                    // the WC customer's restored address (the checkout form address), which
                    // returns wrong-country shipping zones — e.g. US methods when India is
                    // selected. This was the root cause of methods flipping back after
                    // Apple Pay auto-fired onShippingMethodChange following an address change.
                    const updatedTotals = await fetchUpdatedTotals(
                        selectedIdentifier || null,
                        state.lastApplePayShippingAddress || null,
                        toSafeString(state.lastServerTotals?.shipping_major || ''),
                        'applepay'
                    );
                    return buildApplePayUpdatePayload(updatedTotals);
                } catch (error) {
                    return {
                        errors: buildApplePayErrorResponse(error?.message)
                    };
                }
            },
            onPaymentMethodChange: async function (_paymentMethod) {
                try {
                    // Do not reset shipping selection on payment method changes.
                    const selectedIdentifier = toSafeString(state.applePaySelectedShippingMethod || '');
                    const updatedTotals = await fetchUpdatedTotals(
                        selectedIdentifier || null,
                        state.lastApplePayShippingAddress || null,
                        toSafeString(state.lastServerTotals?.shipping_major || ''),
                        'applepay'
                    );
                    return {
                        newTotal: buildApplePayTotalObject(updatedTotals.total_minor, updatedTotals.currency),
                        errors: []
                    };
                } catch (error) {
                    return {
                        errors: buildApplePayErrorResponse(error?.message)
                    };
                }
            }
        };

        // Do NOT inject a placeholder shipping method when the list is empty.
        // The Apple Pay JS API treats an empty shippingMethods array as "pending"
        // and shows a loading state until onShippingAddressChange fires with the
        // user's actual address. Injecting a fake method here causes the sheet to
        // flash the wrong country's methods (e.g. US methods when the user's Apple
        // Pay default address is India) before the real rates arrive.
        if (!Array.isArray(payload.shippingMethods)) {
            payload.shippingMethods = [];
        }

        if (isCompleteConvesioAddress(billingAddress)) {
            payload.billingAddress = billingAddress;
        }
        if (isCompleteConvesioAddress(shippingAddress)) {
            payload.shippingAddress = shippingAddress;
        }

        return payload;
    }

    function buildGooglePaySessionPayload(serverTotals) {
        const settings = getSettings();
        const totals = serverTotals || state.lastServerTotals || buildServerTotalsSnapshot({
            subtotal: '0.00',
            shipping: '0.00',
            tax: '0.00',
            total: '0.00',
            shipping_methods: []
        });

        return {
            integration: toSafeString(settings?.integration_name || 'PeachPay'),
            returnUrl: window.location.href,
            amount: Number(totals.total_minor || 0),
            currency: toSafeString(totals.currency || 'USD'),
            // Shipping address collection — required so orders aren't created with
            // a blank shipping address when the customer uses Google Pay.
            shippingAddressRequired: true,
            allowedShippingCountries: getSupportedCountries(),
            onShippingAddressChange: async function (shippingAddress) {
                try {
                    const mappedAddress = {
                        country: toSafeString(
                            shippingAddress?.countryCode ||
                            shippingAddress?.country || ''
                        ).toUpperCase(),
                        state: toSafeString(
                            shippingAddress?.administrativeArea ||
                            shippingAddress?.state || ''
                        ),
                        postcode: toSafeString(
                            shippingAddress?.postalCode ||
                            shippingAddress?.postcode || ''
                        )
                    };
                    const updatedTotals = await fetchUpdatedTotals(
                        null,
                        mappedAddress,
                        null,
                        'googlepay'
                    );
                    // Google Pay callback return format: updated total and line items
                    // using major-unit strings (same contract as Apple Pay callbacks).
                    return {
                        newTotal: {
                            label: getMerchantLabel(),
                            amount: minorToMajorString(updatedTotals.total_minor),
                            type: 'final'
                        },
                        newLineItems: buildApplePayLineItemsForCallback(
                            updatedTotals.cart_items,
                            updatedTotals.shipping_minor,
                            updatedTotals.tax_minor,
                            updatedTotals.fee_minor,
                            updatedTotals.discount_minor,
                            getSelectedShippingMethodLabel(
                                updatedTotals.shipping_methods,
                                updatedTotals.selected_shipping_method
                            )
                        )
                    };
                } catch (error) {
                    return {
                        error: toSafeString(error?.message || 'Unable to recalculate totals.')
                    };
                }
            }
        };
    }

    function primeApplePaySession() {
        if (!state.component || typeof state.component.createApplePaySession !== 'function') {
            return Promise.resolve(false);
        }

        // Coalesce concurrent calls — if a prime is already in-flight, return the
        // same promise so we never send two recalculate requests in parallel and
        // never call createApplePaySession() twice before the first resolves.
        if (state.primingApplePay) {
            return state.primingApplePay;
        }

        state.primingApplePay = getInitialTotalsPromise('applepay')
            .then(function (totals) {
                const sessionPayload = buildApplePaySessionPayload(totals);
                const amount = Number(sessionPayload.amount || 0);
                const currency = toSafeString(sessionPayload.currency || '').toUpperCase();
                const integration = toSafeString(sessionPayload.integration || '');
                const returnUrl = toSafeString(sessionPayload.returnUrl || '');

                // Per docs: amount/currency/integration/returnUrl are required. Minimum amount is 50 minor units.
                if (!integration || !returnUrl || amount < 50 || currency.length !== 3) {
                    state.applePaySessionPrimed = false;
                    return false;
                }

                sessionPayload.currency = currency;
                const signature = [
                    toSafeString(sessionPayload.integration),
                    toSafeString(sessionPayload.returnUrl),
                    toSafeString(sessionPayload.amount),
                    toSafeString(sessionPayload.currency),
                    toSafeString(sessionPayload.email),
                    toSafeString(totals?.selected_shipping_method || '')
                ].join('|');

                if (state.applePaySessionPrimed && signature === state.lastApplePayPrimeSignature) {
                    return true;
                }
                accelLog('Creating Apple Pay session.', { amount: sessionPayload.amount, currency: sessionPayload.currency });
                return Promise.resolve(state.component.createApplePaySession(sessionPayload))
                    .then(function () {
                        state.applePaySessionPrimed = true;
                        state.lastApplePayPrimeSignature = signature;
                        return true;
                    })
                    .catch(function () {
                        state.applePaySessionPrimed = false;
                        return false;
                    });
            })
            .finally(function () {
                // Clear the in-flight promise so the next call after resolution
                // can start a fresh prime if the session has since been invalidated.
                state.primingApplePay = null;
            });

        return state.primingApplePay;
    }

    function primeGooglePaySession() {
        if (!state.component || typeof state.component.createGooglePaySession !== 'function') {
            return Promise.resolve(false);
        }

        // Coalesce concurrent calls — same pattern as primeApplePaySession.
        if (state.primingGooglePay) {
            return state.primingGooglePay;
        }

        state.primingGooglePay = getInitialTotalsPromise('googlepay')
            .then(function (totals) {
                const sessionPayload = buildGooglePaySessionPayload(totals);
                const amount = Number(sessionPayload.amount || 0);
                const currency = toSafeString(sessionPayload.currency || '').toUpperCase();
                const integration = toSafeString(sessionPayload.integration || '');
                const returnUrl = toSafeString(sessionPayload.returnUrl || '');

                // Per docs: amount/currency/integration/returnUrl are required. Minimum amount is 50 minor units.
                if (!integration || !returnUrl || amount < 50 || currency.length !== 3) {
                    state.googlePaySessionPrimed = false;
                    return false;
                }

                sessionPayload.currency = currency;
                const signature = [
                    toSafeString(sessionPayload.integration),
                    toSafeString(sessionPayload.returnUrl),
                    toSafeString(sessionPayload.amount),
                    toSafeString(sessionPayload.currency)
                ].join('|');

                if (state.googlePaySessionPrimed && signature === state.lastGooglePayPrimeSignature) {
                    return true;
                }

                return Promise.resolve(state.component.createGooglePaySession(sessionPayload))
                    .then(function () {
                        state.googlePaySessionPrimed = true;
                        state.lastGooglePayPrimeSignature = signature;
                        accelLog('Google Pay session primed.', {
                            amount: sessionPayload.amount,
                            currency: sessionPayload.currency
                        });
                        return true;
                    })
                    .catch(function () {
                        state.googlePaySessionPrimed = false;
                        return false;
                    });
            })
            .finally(function () {
                state.primingGooglePay = null;
            });

        return state.primingGooglePay;
    }

    function bindApplePayPriming() {
        const wrapper = document.getElementById(CONFIG.wrapperId);
        if (!wrapper || wrapper.dataset.applepayPrimeBound === '1') {
            return;
        }

        wrapper.dataset.applepayPrimeBound = '1';
        wrapper.addEventListener('click', function (event) {
            const target = event.target && event.target.closest
                ? event.target.closest('.adyen-checkout__applepay__button, .apple-pay-button, [data-payment-method*="apple"]')
                : null;
            if (!target) {
                return;
            }
            state.applePaySheetActive = true;
            primeApplePaySession();
        });
    }

    function bindGooglePayPriming() {
        const wrapper = document.getElementById(CONFIG.wrapperId);
        if (!wrapper || wrapper.dataset.googlepayPrimeBound === '1') {
            return;
        }

        wrapper.dataset.googlepayPrimeBound = '1';
        wrapper.addEventListener('click', function (event) {
            const target = event.target && event.target.closest
                ? event.target.closest('.google-pay-button, [data-payment-method*="google"], [data-payment-method*="gpay"]')
                : null;
            if (!target) {
                return;
            }
            state.googlePaySheetActive = true;
            primeGooglePaySession();
        });
    }

    function submitAccelerated(payload) {
        const settings = getSettings();
        const endpoint = toSafeString(settings?.accelerated_checkout_route || '');
        if (!endpoint) {
            showError('Accelerated checkout endpoint is not configured.');
            return Promise.resolve();
        }

        const restNonce = toSafeString(settings?.rest_nonce || settings?.nonce || '');
        const headers = {
            'Content-Type': 'application/json'
        };
        if (restNonce) {
            headers['X-WP-Nonce'] = restNonce;
        }

        state.submitting = true;
        state.redirecting = false;
        clearError();
        lockAcceleratedUi();

        return fetch(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify(payload)
        })
            .then((response) =>
                response.json().then((body) => ({ ok: response.ok, status: response.status, body: body }))
            )
            .then((result) => {
                if (!result.ok || !result.body || result.body.success !== true) {
                    const message = result?.body?.message || 'Accelerated checkout failed. Please try again.';
                    showError(message);
                    // Clear the key so the next attempt (re-tap) gets a fresh one.
                    state.currentIdempotencyKey = null;
                    return;
                }
                const redirectUrl = toSafeString(result.body.redirect_url || '');
                if (!redirectUrl) {
                    showError('Missing redirect URL from accelerated checkout response.');
                    state.currentIdempotencyKey = null;
                    return;
                }
                // Keep the key alive until after navigation so any duplicate
                // in-flight request still hits the cached result on the backend.
                state.redirecting = true;
                window.location.assign(redirectUrl);
            })
            .catch(() => {
                showError('Network error while processing accelerated checkout.');
                state.currentIdempotencyKey = null;
            })
            .finally(() => {
                // Always restore interactivity on failure. On success we keep
                // the checkout visually locked until navigation completes.
                if (state.redirecting) {
                    return;
                }
                state.submitting = false;
                unlockAcceleratedUi();
            });
    }

    function handleApplePaySuccess(event) {
        state.applePaySheetActive = false;
        const settings = getSettings();
        const accel = settings.accelerated_checkout || {};
        if (!toBoolYes(accel.applepay_enabled)) {
            return;
        }

        const token = extractEventToken(event);
        if (!token) {
            showError('Apple Pay authorization is missing a payment token.');
            return;
        }

        const payload = buildPayload(event);
        payload.wallet_type = 'applepay';
        payload.convesiopay_payment_token = token;
        submitAccelerated(payload);
    }

    function handleGooglePaySuccess(event) {
        state.googlePaySheetActive = false;
        const settings = getSettings();
        const accel = settings.accelerated_checkout || {};
        if (!toBoolYes(accel.googlepay_enabled)) {
            return;
        }

        const token = extractEventToken(event);
        if (!token) {
            showError('Google Pay authorization is missing a payment token.');
            return;
        }

        const payload = buildPayload(event);
        payload.wallet_type = 'googlepay';
        payload.convesiopay_payment_token = token;
        submitAccelerated(payload);
    }

    function handleComponentChange(event) {
        if (!state.component || !state.mounted) {
            return;
        }

        const walletType = normalizeWalletType(event);
        if (!walletType) {
            return;
        }

        if (!hasSuccessfulAuth(event)) {
            // Re-prime is safe even while submitting (it only updates totals for the
            // next session — it does not interfere with an in-flight submission).
            // Do not re-prime while the wallet sheet is open — re-priming
            // mid-session calls createApplePaySession() / createGooglePaySession()
            // again, which resets the sheet back to its default shipping selection.
            if (walletType === 'applepay' && !state.applePaySheetActive) {
                primeApplePaySession();
            } else if (walletType === 'googlepay' && !state.googlePaySheetActive) {
                primeGooglePaySession();
            }
            return;
        }

        // Do not start a second submission if one is already in-flight.
        if (state.submitting) {
            return;
        }

        if (walletType === 'applepay') {
            handleApplePaySuccess(event);
            return;
        }

        if (walletType === 'googlepay') {
            handleGooglePaySuccess(event);
            return;
        }
    }

    function mountExpressComponent() {
        if (!canRender()) {
            // Hide the wrapper if it already exists — covers the case where a
            // variation was selected (buttons shown), then the customer clicked
            // "Clear" / "Select option" to deselect it.  Without this the buttons
            // remain visible with no valid product to purchase.
            const existingWrapper = document.getElementById(CONFIG.wrapperId);
            if (existingWrapper) {
                existingWrapper.style.display = 'none';
            }
            return;
        }
        if (!window.ConvesioPay) {
            return;
        }

        ensureStyles();
        const wrapper = ensureWrapper();
        if (!wrapper) {
            return;
        }
        // Restore visibility in case it was hidden by a previous canRender() = false pass.
        wrapper.style.display = '';
        if (state.mounted && state.component) {
            bindApplePayPriming();
            bindGooglePayPriming();
            // Only reprime if the session has been invalidated (e.g. after an
            // updated_checkout event resets the flags) or totals haven't been
            // fetched yet. Unconditional repriming here would race with an
            // in-flight submission and reset the Apple Pay sheet mid-session.
            if (!state.applePaySessionPrimed || !state.lastServerTotals) {
                primeApplePaySession();
            }
            if (!state.googlePaySessionPrimed || !state.lastServerTotals) {
                primeGooglePaySession();
            }
            return;
        }

        const settings = getSettings();
        const accel = settings.accelerated_checkout || {};
        const appleEnabled = toBoolYes(accel.applepay_enabled);
        const googleEnabled = toBoolYes(accel.googlepay_enabled);
        const apiKey = toSafeString(settings?.convesiopay_config?.apiKey || '');
        if (!apiKey) {
            return;
        }

        const cpay = window.ConvesioPay(apiKey);
        const email = toSafeString(
            document.querySelector('#billing_email')?.value ||
            document.querySelector('input[name="billing_email"]')?.value ||
            ''
        );
        const disabledMethods = {
            // ConvesioPay docs: disabledPaymentMethods expects camelCase keys.
            // Express mode should never expose cards.
            cards: true,
            applePay: !appleEnabled,
            googlePay: !googleEnabled
        };

        const componentConfig = {
            environment: toSafeString(settings?.convesiopay_config?.api_url || '').includes('qa') ? 'test' : 'live',
            clientKey: toSafeString(settings?.convesiopay_config?.clientKey || ''),
            integration: toSafeString(settings?.integration_name || 'PeachPay'),
            theme: toSafeString(settings?.checkout_theme || 'light'),
            express: true,
            disabledPaymentMethods: disabledMethods
        };
        if (email) {
            componentConfig.customerEmail = email;
        }

        try {
            const component = cpay.component(componentConfig);
            component.on('change', handleComponentChange);

            // Cancel: user dismissed the wallet sheet without completing payment.
            // Reset sheet-related state so priming and idempotency key start fresh.
            component.on('cancel', function () {
                state.applePaySheetActive = false;
                state.googlePaySheetActive = false;
                state.lastServerTotals = null;
                state.currentIdempotencyKey = null;
                // Re-prime immediately so the next tap is ready without delay.
                primeApplePaySession();
                primeGooglePaySession();
            });

            // Click: some SDK versions expose an onClick event with a resolve()
            // contract similar to Stripe ECE. If present, resolve it with current
            // shipping requirements so the wallet sheet opens correctly.
            component.on('click', function (event) {
                if (event && typeof event.resolve === 'function') {
                    event.resolve({
                        shippingAddressRequired: true,
                        allowedShippingCountries: getSupportedCountries(),
                        shippingRates: buildApplePayShippingMethodsForCallback(
                            (state.lastServerTotals && state.lastServerTotals.shipping_methods) || [],
                            state.applePaySelectedShippingMethod || ''
                        )
                    });
                }
            });
            const mountResult = component.mount('#' + CONFIG.mountId);
            if (mountResult && typeof mountResult.then === 'function') {
                mountResult
                    .then(function () {
                        state.component = component;
                        state.mounted = true;
                        bindApplePayPriming();
                        bindGooglePayPriming();
                        primeApplePaySession();
                        primeGooglePaySession();
                    })
                    .catch(function () {
                        showError('Unable to mount accelerated checkout component.');
                    });
                return;
            }
            state.component = component;
            state.mounted = true;
            bindApplePayPriming();
            bindGooglePayPriming();
            primeApplePaySession();
            primeGooglePaySession();
        } catch (_e) {
            showError('Unable to initialize accelerated checkout.');
        }
    }

    function scheduleMount() {
        // Debounce: collapse rapid-fire calls (e.g. from MutationObserver firing
        // multiple times during a WooCommerce DOM update) into a single mount attempt.
        if (state.mountTimer) {
            clearTimeout(state.mountTimer);
        }
        state.mountTimer = setTimeout(function () {
            state.mountTimer = null;
            mountExpressComponent();
        }, 50);
    }

    function bindRefreshEvents() {
        if (window.jQuery) {
            window.jQuery(document.body).on('updated_checkout', function () {
                // If the Apple Pay sheet is currently open, ignore this event entirely.
                // WooCommerce fires updated_checkout whenever the WC session changes —
                // including after our own onShippingAddressChange / onShippingMethodChange
                // callbacks modify the shipping method. Responding while the sheet is
                // active would schedule primeApplePaySession(), which calls fetchUpdatedTotals
                // with a null address. That sends shipping_address: {} to the backend, which
                // then uses the restored WC customer address (the checkout form's country,
                // e.g. US) and returns wrong-country shipping methods, overwriting the
                // correct ones the sheet just received.
                if (state.applePaySheetActive || state.googlePaySheetActive) {
                    return;
                }

                // WooCommerce has recalculated the cart (address change, coupon applied,
                // shipping method change in the form, etc.). Invalidate primed sessions so
                // the next mount re-fetches fresh totals with the current cart state.
                invalidatePrimedWalletSessions();
                scheduleMount();
            });

            // Cart page events: WooCommerce fires these when cart items change,
            // totals are recalculated, or cart fragments are refreshed (e.g. after
            // applying a coupon or changing quantity). Re-prime wallet sessions so
            // the next tap shows up-to-date amounts.
            window.jQuery(document.body).on(
                'updated_cart_totals wc_fragments_refreshed added_to_cart removed_from_cart',
                function () {
                    if (state.applePaySheetActive || state.googlePaySheetActive) {
                        return;
                    }
                    invalidatePrimedWalletSessions();
                    scheduleMount();
                }
            );
        }

        const observer = new MutationObserver(function () {
            if (!state.mounted) {
                scheduleMount();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Product page: invalidate primed sessions when quantity or variation changes
        // so the wallet sheet always shows the correct total for the selected options.
        if (isProductPage()) {
            const productForm = document.querySelector('form.cart');
            if (productForm) {
                productForm.addEventListener('change', function (e) {
                    if (!e.target) {
                        return;
                    }
                    const name = toSafeString(e.target.name || '');
                    // Quantity input or any attribute select changed.
                    if (name === 'quantity' || name.indexOf('attribute_') === 0) {
                        state.productContext = getProductContext();
                        invalidatePrimedWalletSessions();
                        // Remount/reprime — canRender() guards against repriming
                        // when a variable product has no variation selected.
                        scheduleMount();
                    }
                });
            }

            if (window.jQuery) {
                // WooCommerce fires found_variation when the customer selects a
                // complete set of attributes for a variable product.
                window.jQuery(document.body).on('found_variation', function (_event, variation) {
                    const variationId = Number(variation?.variation_id || 0);
                    const productCtx = getProductContext();
                    if (productCtx) {
                        productCtx.variation_id = variationId;
                        if (variation && variation.attributes) {
                            productCtx.variation = variation.attributes;
                        }
                        state.productContext = productCtx;
                    }
                    invalidatePrimedWalletSessions();
                    scheduleMount();
                });

                // reset_data fires when the customer clears/changes variation selection.
                window.jQuery(document.body).on('reset_data', function () {
                    const productCtx = getProductContext();
                    if (productCtx) {
                        productCtx.variation_id = 0;
                        productCtx.variation = {};
                        state.productContext = productCtx;
                    }
                    // canRender() will return false for variable products without a
                    // variation, so the buttons will be hidden until a valid choice.
                    invalidatePrimedWalletSessions();
                    scheduleMount();
                });
            }
        }
    }

    function init() {
        // Seed the product context before mounting so the first prime has access
        // to the current product ID / quantity / variation immediately.
        if (isProductPage()) {
            state.productContext = getProductContext();
        }
        scheduleMount();
        bindRefreshEvents();
        bindAcceleratedCheckoutSubmitGuard();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
