/**
 * ConvesioPay – Unified Classic Checkout
 *
 * Purpose:
 * - Provide a clean, modular checkout integration for ConvesioPay.
 * - Preserve WooCommerce’s native checkout lifecycle and event flow.
 * - Rely on backend-calculated totals and fees (server-authoritative model).
 * - Support multiple payment methods (Card, Apple Pay, Google Pay, BTCPay, etc.)
 *   through a single, unified runtime state.
 *
 * Design Principles:
 * - Backend-first fee and total calculation (no frontend fee mirroring).
 * - Idempotent event handling to avoid duplicate execution on AJAX refreshes.
 * - Compatible with WooCommerce checkout re-rendering and fragment updates.
 * - Safe coexistence with checkout builders (e.g. FunnelKit / similar tools).
 *
 * Notes:
 * - This file is a refactor target intended to replace legacy production logic.
 * - The existing production script remains untouched until feature parity
 *   and behavioral equivalence are fully validated.
 * - All checkout state synchronization must be resilient to multiple
 *   `update_checkout` and `updated_checkout` cycles.
 */
(function ($) {
    'use strict';

    /**
     * Immutable configuration/constants for Classic checkout.
     */
    const CONFIG = Object.freeze({
        gatewayId: 'peachpay_convesiopay_unified',
        containerId: 'convesiopay-unified-payment-container',
        mountNodeId: 'convesiopay-persistent-sdk-mount',
        selectedMethodField: 'convesiopay_selected_method',
        sessionAction: 'peachpay_store_convesiopay_method',
        checkoutFormSelector: 'form.checkout',
        paymentMethodSelector: 'input[name="payment_method"]',
        defaultMethod: 'card',
        allowedMethods: ['card', 'applepay', 'googlepay', 'btcpay'],
        methodIntentSuppressionMs: 1800,
        checkoutRefreshDebounceMs: 220,
        customerContextDebounceMs: 450,
        overlayClearFastMs: 80,
        gatewayDeselectionRecheckMs: 150,
        overlayClearSlowMs: 220,
        cardReadinessTimeoutMs: 3000,
        peachpay_is_advanced_logging_enabled: false
    });

    /**
     * Runtime state holder.
     * Keep mutations centralized so event flows are easier to reason about.
     */
    const state = {
        initialized: false,
        mounted: false,
        component: null,
        mountNode: null,
        mountGeneration: 0,
        currentMethod: null,
        paymentConfirmedData: null,
        cardTokenLifecycle: 'empty',
        submitGeneration: 0,
        cardSecuredFieldsReady: false,
        cardReadinessRecoveryAttempted: false,
        cardUserInteractionStarted: false,
        cardReadinessTimerContext: null,
        pendingCardReadyRefreshReason: '',
        cardComponentValid: false,
        cardComponentErrors: {},
        cardValidationErrorMessage: '',
        btcSession: null,
        btcSessionSignature: '',
        btcListenerBound: false,
        lastSyncedMethod: '',
        lastKnownCartTotal: 0,
        lastKnownAmountCurrencySignature: '',
        applePaySessionPrimed: false,
        applePaySessionSignature: '',
        googlePaySessionSignature: '',
        googlePaySessionPrimed: false,
        googlePayUiLockUntilMs: 0,
        lastKnownFeeAmount: 0,
        lastCustomerSignature: '',
        lastKnownCustomerEmail: '',
        refreshingSessions: false,
        pendingSessionRefreshReason: '',
        methodSwitchInProgress: false,
        methodSwitchTarget: '',
        methodSwitchFallbackUnlock: null,
        explicitMethodIntent: '',
        explicitMethodIntentAtMs: 0,
        suppressCardComponentChangeUntilMs: 0,
        submitInProgress: false,
        allowNativeSubmitOnce: false,
        nativeSubmitBypassCount: 0,
        lastSubmitPreflightError: '',
        submitOverlayLocked: false,
        submitOverlayFailsafeTimer: null,
        overlayCleanupBound: false,
        overlayObserver: null,
        timers: {
            checkoutRefresh: null,
            customerContext: null,
            overlaySweep: null,
            nativeSubmitHandoff: null,
            cardReadiness: null,
            gatewayDeselectionRecheck: null
        }
    };

    /** @type {{containerNode: HTMLElement|null, mountNode: HTMLElement|null, hadContainer: boolean, hadMountNode: boolean, mountGeneration: number}|null} */
    let paymentDomSnapshotForDiagnostics = null;

    /**
     * Read localized unified configuration from WordPress.
     *
     * @returns {Object}
     */
    function getConfig() {
        return window.peachpay_convesiopay_unified_data || {};
    }

    /**
     * Resolve active checkout form selector for classic checkout and order-pay.
     *
     * @returns {string}
     */
    function getCheckoutFormSelector() {
        if (document.querySelector('form.checkout')) {
            return 'form.checkout';
        }
        if (document.querySelector('form#order_review')) {
            return 'form#order_review';
        }
        return CONFIG.checkoutFormSelector;
    }

    /**
     * Resolve active checkout form jQuery object.
     *
     * @returns {jQuery}
     */
    function getCheckoutForm() {
        return $(getCheckoutFormSelector());
    }

    /**
     * Whether current request context is order-pay.
     *
     * @returns {boolean}
     */
    function isOrderPayContext() {
        const config = getConfig();
        if (typeof config.is_order_pay !== 'undefined') {
            return Boolean(config.is_order_pay);
        }
        return window.location.pathname.includes('/order-pay/');
    }

    /**
     * Whether advanced debug logging is enabled from localized PHP config.
     *
     * @returns {boolean}
     */
    function isAdvancedLoggingEnabled() {
        try {
            const raw = getConfig().peachpay_is_advanced_logging_enabled;
            if (typeof raw === 'string') {
                const normalized = raw.trim().toLowerCase();
                return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
            }
            if (typeof raw === 'number') {
                return raw === 1;
            }
            if (typeof raw === 'boolean') {
                return raw;
            }
            return Boolean(CONFIG.peachpay_is_advanced_logging_enabled);
        } catch (error) {
            // Logging guard must never break checkout behavior.
            return false;
        }
    }

    /**
     * Safely prepare debug context for console logging.
     * Guards against circular references and exotic values.
     *
     * @param {*} context
     * @returns {*}
     */
    function getSafeDebugContext(context) {
        if (typeof context === 'undefined') {
            return undefined;
        }
        if (context === null) {
            return null;
        }
        const contextType = typeof context;
        if (contextType === 'string' || contextType === 'number' || contextType === 'boolean') {
            return context;
        }
        if (context instanceof Error) {
            return {
                name: context.name,
                message: context.message,
                stack: context.stack
            };
        }
        try {
            return JSON.parse(JSON.stringify(context));
        } catch (error) {
            return {
                note: 'Unserializable debug context',
                contextType: Object.prototype.toString.call(context)
            };
        }
    }

    /**
     * Print debug logs only when advanced logging is enabled.
     *
     * @param {string} message
     * @param {Object=} context
     */
    function debugLog(message, context) {
        try {
            if (!isAdvancedLoggingEnabled()) {
                return;
            }
            const safeMessage = String(message || '');
            if (typeof context === 'undefined') {
                console.log('[ConvesioPay][ClassicV2]', safeMessage);
                return;
            }
            console.log('[ConvesioPay][ClassicV2]', safeMessage, getSafeDebugContext(context));
        } catch (error) {
            // Debug logging must be no-op on any unexpected runtime issue.
        }
    }

    /**
     * Defer Google Pay session refreshes while the PaymentRequest sheet is opening/open.
     *
     * @param {string=} source
     */
    function lockGooglePayUiRefresh(source) {
        state.googlePayUiLockUntilMs = Date.now() + 15000;
        debugLog('Google Pay UI refresh lock set', {
            source: source || 'unspecified',
            lockedUntil: state.googlePayUiLockUntilMs
        });
    }

    /**
     * Check whether Google Pay session refresh should be deferred.
     *
     * @returns {boolean}
     */
    function isGooglePayUiRefreshLocked() {
        return state.googlePayUiLockUntilMs > Date.now();
    }

    /**
     * Determine if BTCPay/crypto method is enabled in configuration.
     *
     * @returns {boolean}
     */
    function isBtcpayEnabled() {
        const activeMethods = getConfig().active_methods || [];
        if (!Array.isArray(activeMethods) || activeMethods.length === 0) {
            return false;
        }
        return activeMethods.includes('crypto') || activeMethods.includes('btcpay');
    }

    /**
     * Determine if Apple Pay is enabled in configuration.
     *
     * @returns {boolean}
     */
    function isApplePayEnabled() {
        const activeMethods = getConfig().active_methods || [];
        if (!Array.isArray(activeMethods) || activeMethods.length === 0) {
            return false;
        }
        return activeMethods.includes('applepay') || activeMethods.includes('applePay');
    }

    /**
     * Determine if Google Pay is enabled in configuration.
     *
     * @returns {boolean}
     */
    function isGooglePayEnabled() {
        const activeMethods = getConfig().active_methods || [];
        if (!Array.isArray(activeMethods) || activeMethods.length === 0) {
            return false;
        }
        return activeMethods.includes('googlepay') || activeMethods.includes('googlePay') || activeMethods.includes('google-pay');
    }

    /**
     * Determine if Card is enabled in configuration.
     *
     * Backward compatibility:
     * if active_methods is missing/empty, assume card is enabled.
     *
     * @returns {boolean}
     */
    function isCardEnabled() {
        const activeMethods = getConfig().active_methods || [];
        if (!Array.isArray(activeMethods) || activeMethods.length === 0) {
            return true;
        }
        return activeMethods.includes('card');
    }

    /**
     * Validate whether a given internal method is currently enabled.
     *
     * @param {string} method
     * @returns {boolean}
     */
    function isMethodEnabled(method) {
        const normalized = String(method || '').toLowerCase();
        if (normalized === 'applepay') {
            return isApplePayEnabled();
        }
        if (normalized === 'googlepay') {
            return isGooglePayEnabled();
        }
        if (normalized === 'btcpay') {
            return isBtcpayEnabled();
        }
        if (normalized === 'card') {
            return isCardEnabled();
        }
        return false;
    }

    /**
     * Get native checkout disabled method flags for the ConvesioPay SDK.
     *
     * @returns {{cards: boolean, applePay: boolean, googlePay: boolean}}
     */
    function getDisabledPaymentMethodsConfig() {
        const disabled = getConfig().disabled_payment_methods || {};
        return {
            cards: Boolean(disabled.cards),
            applePay: Boolean(typeof disabled.applePay !== 'undefined' ? disabled.applePay : disabled.applepay),
            googlePay: Boolean(typeof disabled.googlePay !== 'undefined' ? disabled.googlePay : disabled.googlepay)
        };
    }

    /**
     * Get/create persistent mount node reference used by SDK.
     *
     * @returns {HTMLElement}
     */
    function getOrCreateMountNode() {
        // If the mount node is not created, create it.
        if (!state.mountNode) {
            // Create the mount node.
            const node = document.createElement('div');
            node.id = CONFIG.mountNodeId;
            // // Set the style of the mount node to avoid layout shifts.
            // node.style.minHeight = '300px';
            // node.style.minWidth = '100%';
            // // Set the width of the mount node to 100%.
            // node.style.width = '100%';
            // Set the mount node to the state.
            state.mountNode = node;
        }
        // Return the mount node.
        return state.mountNode;
    }

    /**
     * Attach mount node to current unified container.
     *
     * @returns {boolean}
     */
    function attachMountNodeToContainer() {
        const container = document.getElementById(CONFIG.containerId);
        if (!container) {
            return false;
        }
        const mountNode = getOrCreateMountNode();
        if (mountNode.parentNode !== container) {
            if (mountNode.parentNode) {
                mountNode.parentNode.removeChild(mountNode);
            }
            container.innerHTML = '';
            container.appendChild(mountNode);
        }
        return true;
    }

    /**
     * Parse a price string (with optional locale separators) to integer cents.
     *
     * @param {string} orderTotal - Raw price text (e.g. "$1,234.56").
     * @returns {number} Amount in cents, or 0 if unparseable.
     */
    function parsePriceToCents(orderTotal) {
        try {
            if (!orderTotal || typeof orderTotal !== 'string') {
                return 0;
            }
            const decimalSep = String(window.wc_checkout_params?.currency_format_decimal_sep || '.');
            const thousandSep = String(window.wc_checkout_params?.currency_format_thousand_sep || ',');
            const raw = String(orderTotal).replace(/[^\d.,-]/g, '').trim();
            if (!raw) {
                return 0;
            }
            let normalized = raw;
            if (thousandSep) {
                const escapedThousand = thousandSep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                normalized = normalized.replace(new RegExp(escapedThousand, 'g'), '');
            }
            if (decimalSep && decimalSep !== '.') {
                const escapedDecimal = decimalSep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                normalized = normalized.replace(new RegExp(escapedDecimal, 'g'), '.');
            }
            if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
                const lastDot = normalized.lastIndexOf('.');
                const lastComma = normalized.lastIndexOf(',');
                const splitAt = Math.max(lastDot, lastComma);
                if (splitAt >= 0) {
                    const integerPart = normalized.slice(0, splitAt).replace(/[.,]/g, '');
                    const decimalPart = normalized.slice(splitAt + 1).replace(/[.,]/g, '');
                    normalized = integerPart + (decimalPart ? '.' + decimalPart : '');
                } else {
                    normalized = normalized.replace(/[.,]/g, '');
                }
            }
            const amount = parseFloat(normalized);
            if (Number.isNaN(amount)) {
                return 0;
            }
            return Math.round(amount * 100);
        } catch (e) {
            debugLog('[ConvesioPay Classic] Error parsing price to cents', { error: e });
            return 0;
        }
    }

    /**
     * Get current rendered order total as integer cents.
     * Tries DOM (WooCommerce and FunnelKit selectors) then backend cart_total
     * so Apple Pay/BTCPay sessions work when the review table is missing or delayed.
     *
     * @returns {number}
     */
    function getCurrentCartTotalCents() {
        const orderPayData = getConfig().order_pay || {};
        if (isOrderPayContext() && orderPayData && orderPayData.order_id) {
            const serverTotal = Number(orderPayData.total || 0);
            if (Number.isFinite(serverTotal) && serverTotal > 0) {
                const cents = Math.round(serverTotal * 100);
                debugLog('[ConvesioPay Classic] Resolved checkout total from DOM/config', {
                    resolvedBy: 'order_pay_config',
                    cents: cents,
                    rawText: String(serverTotal)
                });
                return cents;
            }
        }

        function logResolvedCheckoutTotal(resolvedBy, cents, rawText) {
            debugLog('[ConvesioPay Classic] Resolved checkout total from DOM/config', {
                resolvedBy: resolvedBy,
                cents: cents,
                rawText: String(rawText || '').trim()
            });
        }

        const primarySelector = '.woocommerce-checkout-review-order-table .order-total .amount';
        const $primaryAmounts = $(primarySelector);
        if ($primaryAmounts.length > 1) {
            debugLog('[ConvesioPay Classic] Multiple primary total amount nodes detected; using first match', {
                count: $primaryAmounts.length
            });
        }
        let cents = parsePriceToCents($primaryAmounts.first().text());
        if (cents > 0) {
            logResolvedCheckoutTotal('primary:' + primarySelector, cents, $primaryAmounts.first().text());
            return cents;
        }
        const fallbackSelectors = [
            '.shop_table .order-total .amount',
            '.fkwcs-place-order-total .amount',
            '.fkwcs-place-order-total',
            '.cart-subtotal .amount',
            '.order_total .amount',
            '.order-total .amount'
        ];
        for (let i = 0; i < fallbackSelectors.length; i++) {
            const text = $(fallbackSelectors[i]).first().text();
            cents = parsePriceToCents(text);
            if (cents > 0) {
                logResolvedCheckoutTotal('fallback:' + fallbackSelectors[i], cents, text);
                return cents;
            }
        }
        const configTotal = getConfig().cart_total != null ? getConfig().cart_total : (window.convesiopayCartTotal != null ? window.convesiopayCartTotal : 0);
        cents = Math.round(Number(configTotal) * 100);
        logResolvedCheckoutTotal('config:cart_total', cents, configTotal);
        return cents;
    }

    /**
     * Retrieve the checkout order identifier (real or temporary).
     *
     * Determines the appropriate order reference to use during checkout.
     * The function follows a fallback strategy:
     *
     * 1. If on the order-received page, return the real WooCommerce order ID
     *    from the URL query parameter (?order=).
     * 2. If on the checkout page before order creation, return the temporary
     *    session ID provided by backend configuration.
     * 3. If no temporary ID is available, generate a runtime fallback
     *    temporary identifier.
     *
     * This ensures that every payment attempt has a unique and traceable
     * reference even before WooCommerce creates the real order.
     *
     * @returns {string} Order identifier (real order ID or temporary session ID).
     */
    function getOrderNumber() {
        const orderPayData = getConfig().order_pay || {};
        if (isOrderPayContext() && orderPayData && orderPayData.order_id) {
            return String(orderPayData.order_id);
        }

        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get('order');
        if (orderId) {
            return orderId;
        }
        const tempSessionId = getConfig().temp_session_id;
        if (tempSessionId) {
            return tempSessionId;
        }
        return 'TEMP-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    }

    /**
     * Collect and validate checkout order data.
     *
     * Retrieves:
     * - Order amount
     * - Currency
     * - Order number (real or temporary)
     *
     * Ensures required values exist before allowing
     * token processing or checkout submission.
     *
     * @returns {Object} Order data object.
     * @returns {boolean} returns.isValid - Whether required fields are present.
     * @returns {number} returns.amount - Order total amount.
     * @returns {string} returns.currency - Order currency code.
     * @returns {string} returns.orderNumber - Order reference.
     */
    function getOrderData() {
        const orderPayData = getConfig().order_pay || {};
        const amount = getCurrentCartTotalCents();
        let first = String($('#billing_first_name').val() || '').trim();
        let last = String($('#billing_last_name').val() || '').trim();
        let email = String($('#billing_email').val() || '').trim();
        let currency = (getConfig().currency && String(getConfig().currency).trim()) || 'USD';

        if (isOrderPayContext() && orderPayData && orderPayData.order_id) {
            first = first || String(orderPayData.billing_first_name || '').trim();
            last = last || String(orderPayData.billing_last_name || '').trim();
            email = email || String(orderPayData.billing_email || '').trim();
            currency = String(orderPayData.currency || currency || 'USD').trim();
        }

        return {
            isValid: amount > 0,
            orderNumber: getOrderNumber(),
            amount: amount,
            currency: currency,
            email: email,
            name: (first + ' ' + last).trim() || 'Customer'
        };
    }

    /**
     * Build a compact amount/currency signature for runtime update guards.
     *
     * @param {Object=} orderData
     * @returns {string}
     */
    function getAmountCurrencySignature(orderData) {
        const data = orderData || getOrderData();
        const amount = Number.isFinite(Number(data?.amount)) ? String(Math.round(Number(data.amount))) : '0';
        const currency = String(data?.currency || '').trim().toUpperCase();
        return amount + '|' + currency;
    }

    /**
     * Whether the active in-component method is Card.
     *
     * @returns {boolean}
     */
    function isCardMethodActive() {
        return resolveMethod() === 'card';
    }

    /**
     * Get the mounted card fields root inside the persistent component mount.
     *
     * @returns {Element|null}
     */
    function getCardSecuredFieldsForm() {
        const mountNode = document.getElementById(CONFIG.mountNodeId);
        const root = mountNode || document.getElementById(CONFIG.containerId);
        return root ? root.querySelector('.adyen-payment__new-card-form, [data-vgs-collect], .vgs-collect-form, [class*="adyen-checkout__card"], [class*="adyen-checkout__secured"], [class*="adyen-checkout"]') : null;
    }

    /**
     * Get the active component mount root.
     *
     * @returns {Element|null}
     */
    function getCardSecuredFieldsRoot() {
        return document.getElementById(CONFIG.mountNodeId) || document.getElementById(CONFIG.containerId);
    }

    /**
     * Determine whether an iframe belongs to VGS secured card collection.
     *
     * @param {HTMLIFrameElement} iframe
     * @returns {boolean}
     */
    function isVgsSecuredFieldIframe(iframe) {
        const source = String(iframe.getAttribute('src') || iframe.src || '').toLowerCase();
        return source.includes('verygoodvault.com') || source.includes('vault.convesiopay.com');
    }

    /**
     * Determine whether an element contains legacy VGS secured field iframes.
     *
     * @param {Element} element
     * @returns {boolean}
     */
    function hasLegacyVgsSecuredFields(element) {
        return Array.from(element.querySelectorAll('iframe')).filter(isVgsSecuredFieldIframe).length >= 3;
    }

    /**
     * Determine whether the ConvesioPay SDK reported configured card secured fields.
     * The OpenAPI contract covers server APIs only; iframe lifecycle readiness comes
     * from the JS SDK's onConfigSuccess callback. Keep DOM fallback limited to VGS.
     *
     * @param {Object=} event
     * @returns {boolean}
     */
    function isCardConfigSuccessEvent(event) {
        if (!event || typeof event !== 'object') {
            return true;
        }

        const eventType = typeof event.type === 'string' ? event.type.toLowerCase() : '';
        if (eventType && eventType !== 'card' && eventType !== 'scheme') {
            return false;
        }

        return event.iframesConfigured !== false;
    }

    /**
     * Mark card fields ready from the SDK readiness callback.
     *
     * @param {Object=} event
     * @param {number=} mountGeneration
     * @param {Object|null=} component
     * @returns {boolean}
     */
    function handleCardConfigSuccess(event, mountGeneration, component) {
        if (!isCurrentMountContext(mountGeneration, component)) {
            return false;
        }

        if (!isCardConfigSuccessEvent(event)) {
            return false;
        }

        return markCardSecuredFieldsReady('on_config_success', mountGeneration, component);
    }

    /**
     * Determine if legacy VGS secured fields are present as a DOM fallback.
     *
     * @returns {boolean}
     */
    function hasConfiguredCardSecuredFields() {
        const root = getCardSecuredFieldsRoot();
        if (!root) {
            return false;
        }

        return hasLegacyVgsSecuredFields(root);
    }

    /**
     * Advance the mounted component generation so stale async callbacks can no-op.
     *
     * @param {string=} reason
     * @returns {number}
     */
    function advanceMountGeneration(reason) {
        state.mountGeneration += 1;
        debugLog('[ConvesioPay Classic] Advanced component mount generation', {
            generation: state.mountGeneration,
            reason: reason || 'unspecified',
            submitInProgress: state.submitInProgress
        });
        if (state.submitInProgress) {
            logSubmitPaymentDomRiskDuringSubmit('mount_generation_advanced_during_submit', {
                reason: reason || 'unspecified',
                generation: state.mountGeneration
            });
        }
        return state.mountGeneration;
    }

    /**
     * Check whether an async callback still belongs to the active component.
     *
     * @param {number=} mountGeneration
     * @param {Object|null=} component
     * @returns {boolean}
     */
    function isCurrentMountContext(mountGeneration, component) {
        if (typeof mountGeneration !== 'undefined' && Number(mountGeneration) !== Number(state.mountGeneration)) {
            return false;
        }
        if (component && component !== state.component) {
            return false;
        }
        return true;
    }

    /**
     * Mark card secured fields ready and release any deferred session refresh.
     *
     * @param {string} source
     * @param {number=} mountGeneration
     * @param {Object|null=} component
     * @returns {boolean}
     */
    function markCardSecuredFieldsReady(source, mountGeneration, component) {
        if (!isCurrentMountContext(mountGeneration, component)) {
            debugLog('[ConvesioPay Classic] Ignored stale Card readiness callback', {
                source: source || 'unspecified',
                callbackGeneration: mountGeneration || null,
                currentGeneration: state.mountGeneration
            });
            return false;
        }

        if (state.cardSecuredFieldsReady) {
            return true;
        }

        state.cardSecuredFieldsReady = true;
        clearCardReadinessTimer();

        debugLog('[ConvesioPay Classic] Card secured fields ready', {
            source: source || 'unspecified',
            generation: state.mountGeneration
        });

        if (state.pendingCardReadyRefreshReason) {
            const nextReason = state.pendingCardReadyRefreshReason;
            state.pendingCardReadyRefreshReason = '';
            setTimeout(function () {
                if (!isCurrentMountContext(mountGeneration, component)) {
                    return;
                }
                refreshSessionsInPlace(nextReason);
            }, 0);
        }

        return true;
    }

    /**
     * Update card readiness from the DOM fallback check.
     *
     * @param {string} source
     * @param {number=} mountGeneration
     * @param {Object|null=} component
     * @returns {boolean}
     */
    function updateCardReadinessFromDom(source, mountGeneration, component) {
        if (!isCurrentMountContext(mountGeneration, component) || !isCardMethodActive()) {
            return false;
        }

        if (hasConfiguredCardSecuredFields()) {
            return markCardSecuredFieldsReady(source || 'dom_fallback', mountGeneration, component);
        }
        return false;
    }

    /**
     * Clear only card readiness timers/transient readiness state.
     *
     * @param {string=} reason
     */
    function resetCardReadinessState(reason) {
        clearCardReadinessTimer();
        state.cardSecuredFieldsReady = false;
        state.pendingCardReadyRefreshReason = '';
        state.cardUserInteractionStarted = false;
        if (reason) {
            debugLog('[ConvesioPay Classic] Card readiness state reset', {
                reason: reason
            });
        }
    }

    /**
     * Clear the current Card readiness timer and its mount context.
     */
    function clearCardReadinessTimer() {
        if (state.timers.cardReadiness) {
            clearTimeout(state.timers.cardReadiness);
            state.timers.cardReadiness = null;
        }
        state.cardReadinessTimerContext = null;
    }

    /**
     * Remount once if the initial Card shell never configures secured fields.
     *
     * @param {string} reason
     */
    function recoverUnreadyCardFields(reason) {
        if (state.cardReadinessRecoveryAttempted || state.cardUserInteractionStarted || state.cardComponentValid || state.paymentConfirmedData) {
            return;
        }

        state.cardReadinessRecoveryAttempted = true;
        debugLog('[ConvesioPay Classic] Recovering unready card secured fields with one remount', {
            reason: reason || 'unspecified'
        });

        resetMountedComponentState('card_secured_fields_unready');
        mountComponent().catch(function (error) {
            console.warn('[ConvesioPay] Card secured fields recovery remount failed. error: ' + error);
        });
    }

    /**
     * Wait for Card secured fields via the shared checkout observer, then remount once if empty.
     *
     * @param {string} reason
     */
    function scheduleCardReadinessMonitor(reason, mountGeneration, component) {
        const expectedGeneration = typeof mountGeneration !== 'undefined' ? mountGeneration : state.mountGeneration;
        const expectedComponent = component || state.component;
        if (!expectedComponent || state.cardSecuredFieldsReady) {
            return;
        }
        if (!isCurrentMountContext(expectedGeneration, expectedComponent) || !isCardMethodActive()) {
            return;
        }

        if (updateCardReadinessFromDom(reason || 'readiness_monitor_start', expectedGeneration, expectedComponent)) {
            return;
        }

        if (state.timers.cardReadiness) {
            return;
        }

        const timerContext = {
            generation: expectedGeneration,
            component: expectedComponent
        };
        state.cardReadinessTimerContext = timerContext;
        state.timers.cardReadiness = setTimeout(function () {
            if (state.cardReadinessTimerContext === timerContext) {
                state.timers.cardReadiness = null;
                state.cardReadinessTimerContext = null;
            }

            if (state.cardSecuredFieldsReady) {
                return;
            }

            if (!isCurrentMountContext(expectedGeneration, expectedComponent)) {
                return;
            }

            if (!state.mounted || !state.component || !isUnifiedGatewaySelected() || !isCardMethodActive()) {
                return;
            }

            if (updateCardReadinessFromDom(reason || 'readiness_monitor_timeout', expectedGeneration, expectedComponent)) {
                return;
            }

            recoverUnreadyCardFields(reason || 'card_secured_fields_timeout');
        }, CONFIG.cardReadinessTimeoutMs);
    }

    /**
     * Defer Card amount/session updates until secured fields are configured.
     *
     * @param {string=} reason
     * @returns {boolean}
     */
    function shouldDeferForCardReadiness(reason) {
        const mountGeneration = state.mountGeneration;
        const component = state.component;
        if (!isCardMethodActive() || state.cardSecuredFieldsReady || updateCardReadinessFromDom(reason || 'readiness_preflight', mountGeneration, component)) {
            return false;
        }

        if (reason) {
            state.pendingCardReadyRefreshReason = reason;
        }
        scheduleCardReadinessMonitor(reason || 'card_readiness_deferred', mountGeneration, component);
        return true;
    }

    /**
     * Update component transaction amount/currency without remounting.
     * Uses SDK updateAmount() when available, otherwise returns unsupported.
     *
     * @param {string} reason
     * @param {boolean=} force
     * @returns {Promise<{supported: boolean, ok: boolean, skipped: boolean, signature: string}>}
     */
    async function applyRuntimeAmountUpdate(reason, force) {
        const shouldForce = Boolean(force);
        if (!state.component || typeof state.component.updateAmount !== 'function') {
            console.error('[ConvesioPay Classic v2] component.updateAmount not found');
            return { supported: false, ok: false, skipped: false, signature: '' };
        }

        const orderData = getOrderData();
        const signature = getAmountCurrencySignature(orderData);
        if (shouldDeferForCardReadiness(reason || 'runtime_amount_update')) {
            debugLog('[ConvesioPay Classic] Deferring runtime amount update until Card secured fields are ready', {
                reason: reason || 'unspecified',
                signature: signature
            });
            return { supported: true, ok: true, skipped: true, signature: signature };
        }

        if (!orderData.isValid) {
            debugLog('[ConvesioPay Classic] Skipping runtime amount update: invalid order data', {
                reason: reason || 'unspecified',
                amount: orderData.amount,
                currency: orderData.currency
            });
            console.error('[ConvesioPay Classic v2] Skipping runtime amount update: invalid order data');
            return { supported: true, ok: false, skipped: false, signature: '' };
        }

        if (!shouldForce && signature && signature === state.lastKnownAmountCurrencySignature) {
            debugLog('[ConvesioPay Classic] Skipping runtime amount update: signature unchanged', {
                reason: reason || 'unspecified',
                signature: signature,
                previousSignature: state.lastKnownAmountCurrencySignature,
                amount: orderData.amount,
                currency: orderData.currency,
                forced: shouldForce,
                submitInProgress: state.submitInProgress,
                mountGeneration: state.mountGeneration
            });
            return { supported: true, ok: true, skipped: true, signature: signature };
        }

        const previousSignature = state.lastKnownAmountCurrencySignature;
        const amountUpdateContext = {
            reason: reason || 'unspecified',
            amount: orderData.amount,
            currency: orderData.currency,
            signature: signature,
            previousSignature: previousSignature,
            signatureChanged: Boolean(previousSignature && previousSignature !== signature),
            forced: shouldForce,
            submitInProgress: state.submitInProgress,
            mountGeneration: state.mountGeneration
        };

        try {
            // Update the amount/currency in-place using the component.updateAmount method to charge accurate amounts by cards/Apple Pay/BtcPay
            await state.component.updateAmount({
                amount: orderData.amount,
                currency: orderData.currency
            });

            state.lastKnownAmountCurrencySignature = signature;
            state.lastKnownCartTotal = orderData.amount;
            debugLog('[ConvesioPay Classic] Runtime amount updated via updateAmount', amountUpdateContext);
            return { supported: true, ok: true, skipped: false, signature: signature };
        } catch (objectCallError) {
            try {
                // Update the amount/currency in-place using the component.updateAmount method to charge accurate amounts by cards/Apple Pay/BtcPay
                await state.component.updateAmount(orderData.amount, orderData.currency);
                
                state.lastKnownAmountCurrencySignature = signature;
                state.lastKnownCartTotal = orderData.amount;
                debugLog('[ConvesioPay Classic] Runtime amount updated via updateAmount(args)', amountUpdateContext);
                return { supported: true, ok: true, skipped: false, signature: signature };
            } catch (argsCallError) {
                debugLog('[ConvesioPay Classic] Runtime amount update failed; falling back to session rebuild', Object.assign({}, amountUpdateContext, {
                    objectCallError: objectCallError,
                    argsCallError: argsCallError
                }));
                return { supported: true, ok: false, skipped: false, signature: signature };
            }
        }
    }

    /**
     * Update component customer email without remounting.
     * Uses SDK updateEmail() when available. Only updates when email value actually changes.
     *
     * @param {string=} newEmail - Optional email; if omitted, reads from #billing_email.
     * @returns {{ supported: boolean, ok: boolean, skipped: boolean }}
     */
    function applyRuntimeEmailUpdate(newEmail) {
        if (!state.component || typeof state.component.updateEmail !== 'function') {
            return { supported: false, ok: false, skipped: false };
        }
        const email = String(
            (newEmail !== undefined && newEmail !== null ? newEmail : ($('#billing_email').val() || ''))
        ).trim();
        if (email === state.lastKnownCustomerEmail) {
            return { supported: true, ok: true, skipped: true };
        }
        try {
            state.component.updateEmail(email);
            state.lastKnownCustomerEmail = email;
            debugLog('[ConvesioPay Classic] Runtime email updated via updateEmail', { email: email });
            return { supported: true, ok: true, skipped: false };
        } catch (error) {
            debugLog('[ConvesioPay Classic] Runtime email update failed', { email: email, error: error });
            return { supported: true, ok: false, skipped: false };
        }
    }

    /**
     * Detect whether Apple Pay session error indicates readiness race.
     *
     * @param {*} error
     * @returns {boolean}
     */
    function isApplePaySessionNotReadyError(error) {
        const message = String(error?.message || error || '').toLowerCase();
        return (
            message.includes('createapplepaysession') ||
            message.includes('not initialized') ||
            message.includes('not available')
        );
    }

    /**
     * Create Apple Pay session with bounded retries for SDK readiness races.
     *
     * @param {Object} params
     * @param {Object=} options
     * @returns {Promise<*>}
     */
    async function createApplePaySessionWithRetry(params, options) {
        const maxAttempts = Number(options?.maxAttempts || 3);
        const delayMs = Number(options?.delayMs || 450);
        let attempt = 0;
        let lastError = null;
        while (attempt < maxAttempts) {
            try {
                return await state.component.createApplePaySession(params);
            } catch (error) {
                lastError = error;
                const isRetryable = isApplePaySessionNotReadyError(error);
                if (!isRetryable || attempt >= (maxAttempts - 1)) {
                    throw error;
                }
                await new Promise(function (resolve) {
                    setTimeout(resolve, delayMs);
                });
            }
            attempt += 1;
        }
        throw lastError || new Error('Apple Pay session creation failed');
    }

    /**
     * Detect retryable Google Pay session readiness failures.
     *
     * @param {*} error
     * @returns {boolean}
     */
    function isGooglePaySessionNotReadyError(error) {
        const message = String(error?.message || error || '').toLowerCase();
        return (
            message.includes('creategooglepaysession') ||
            message.includes('not initialized') ||
            message.includes('not available') ||
            message.includes('required to use this method')
        );
    }

    /**
     * Create Google Pay session with bounded retries for SDK readiness races.
     *
     * @param {Object} params
     * @param {Object=} options
     * @returns {Promise<*>}
     */
    async function createGooglePaySessionWithRetry(params, options) {
        const maxAttempts = Number(options?.maxAttempts || 3);
        const delayMs = Number(options?.delayMs || 450);
        let attempt = 0;
        let lastError = null;
        while (attempt < maxAttempts) {
            try {
                return await state.component.createGooglePaySession(params);
            } catch (error) {
                lastError = error;
                const isRetryable = isGooglePaySessionNotReadyError(error);
                if (!isRetryable || attempt >= (maxAttempts - 1)) {
                    throw error;
                }
                await new Promise(function (resolve) {
                    setTimeout(resolve, delayMs);
                });
            }
            attempt += 1;
        }
        throw lastError || new Error('Google Pay session creation failed');
    }

    /**
     * Clear stale Apple Pay authorization when amount/currency signature changes.
     *
     * @param {string} reason
     * @param {string=} nextSignature
     */
    function clearApplePayAuthorizationIfSet(reason, nextSignature) {
        const method = String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase();
        if (method !== 'applepay') {
            return;
        }
        debugLog('[ConvesioPay Classic] Clearing stale Apple Pay authorization', {
            reason: reason || 'unspecified',
            previousSignature: state.lastKnownAmountCurrencySignature,
            nextSignature: nextSignature || ''
        });
        state.paymentConfirmedData = null;
        state.currentMethod = resolveMethod();
        window.convesiopayPaymentToken = null;
        window.convesiopayApplePayPaymentData = null;
    }

    /**
     * Clear stale Google Pay authorization when amount/currency signature changes.
     *
     * @param {string} reason
     * @param {string=} nextSignature
     */
    function clearGooglePayAuthorizationIfSet(reason, nextSignature) {
        const method = String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase();
        if (method !== 'googlepay') {
            return;
        }
        debugLog('[ConvesioPay Classic] Clearing stale Google Pay authorization', {
            reason: reason || 'unspecified',
            previousSignature: state.lastKnownAmountCurrencySignature,
            nextSignature: nextSignature || ''
        });
        state.paymentConfirmedData = null;
        state.currentMethod = resolveMethod();
        window.convesiopayPaymentToken = null;
        window.convesiopayGooglePayPaymentData = null;
    }

    /**
     * Ensure a stable transaction ID exists for current checkout lifecycle.
     *
     * @returns {string}
     */
    function getOrCreateTransactionId() {
        if (window.peachpayTransactionId) {
            return window.peachpayTransactionId;
        }
        window.peachpayTransactionId = 'convesio-tx-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);
        return window.peachpayTransactionId;
    }

    /**
     * Write/replace hidden field on checkout form.
     *
     * @param {string} name
     * @param {string} value
     */
    function addHiddenField(name, value) {
        const $form = getCheckoutForm();
        if (!$form.length) {
            return;
        }
        const selector = 'input[name="' + name + '"]';
        const $existing = $form.find(selector);
        if ($existing.length) {
            if ($existing.val() !== String(value)) {
                $existing.val(value);
            }
            return;
        }

        $('<input>').attr('type', 'hidden').attr('name', name).attr('value', value).prependTo($form);
    }

    /**
     * Persist the generated payment token in internal state.
     *
     * This allows the token to be reused during checkout submission
     * without regenerating it.
     *
     * @param {string} token - Secure payment token from SDK.
     * @returns {void}
     */
    function storePaymentToken(token) {
        if (!token) {
            return;
        }
        window.convesiopayPaymentToken = token;
        addHiddenField('convesiopay_payment_token', token); // Add the payment token to the hidden field.
    }

    /**
     * Build non-sensitive token debug metadata.
     *
     * @param {string} token
     * @returns {Object}
     */
    function getTokenDebugMetadata(token) {
        const normalizedToken = String(token || '').trim();
        return {
            tokenPrefix: normalizedToken.substring(0, 8),
            tokenLength: normalizedToken.length
        };
    }

    /**
     * Check whether card confirmation data belongs to the current amount/currency context.
     *
     * @param {Object|null} paymentData
     * @param {Object} orderData
     * @returns {boolean}
     */
    function isMatchingCardPaymentContext(paymentData, orderData) {
        if (!paymentData || String(paymentData.paymentMethod || '').toLowerCase() !== 'card') {
            return false;
        }

        const token = String(paymentData.token || '').trim();
        const paymentAmount = Number(paymentData.amount);
        const orderAmount = Number(orderData?.amount);
        const paymentCurrency = String(paymentData.currency || '').trim().toUpperCase();
        const orderCurrency = String(orderData?.currency || '').trim().toUpperCase();

        return Boolean(
            token &&
            Number.isFinite(paymentAmount) &&
            Number.isFinite(orderAmount) &&
            Math.round(paymentAmount) === Math.round(orderAmount) &&
            paymentCurrency &&
            paymentCurrency === orderCurrency
        );
    }

    /**
     * Remove stale card token state when amount/currency no longer matches.
     *
     * @param {string} reason
     * @param {Object=} orderData
     * @returns {void}
     */
    function clearStaleCardPaymentToken(reason, orderData) {
        const confirmedMethod = String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase();
        const currentToken = String(window.convesiopayPaymentToken || '').trim();
        const shouldClearGlobal = confirmedMethod === 'card' || resolveMethod() === 'card';

        if (confirmedMethod === 'card') {
            debugLog('[ConvesioPay Classic] Clearing stale card token context', Object.assign({
                reason: reason || 'unspecified',
                previousAmount: state.paymentConfirmedData?.amount || '',
                previousCurrency: state.paymentConfirmedData?.currency || '',
                nextAmount: orderData?.amount || '',
                nextCurrency: orderData?.currency || '',
                source: 'paymentConfirmedData'
            }, getTokenDebugMetadata(state.paymentConfirmedData?.token)));
            state.paymentConfirmedData = null;
        }

        if (shouldClearGlobal) {
            window.convesiopayPaymentToken = null;
            getCheckoutForm().find('input[name="convesiopay_payment_token"]').remove();
            if (currentToken) {
                debugLog('[ConvesioPay Classic] Cleared card token global cache', Object.assign({
                    reason: reason || 'unspecified',
                    source: 'window.convesiopayPaymentToken'
                }, getTokenDebugMetadata(currentToken)));
            }
        }
    }

    /**
     * Resolve a reusable card token only when it is tied to the current amount/currency.
     *
     * @param {Object} orderData
     * @returns {{ token: string, source: string }}
     */
        function getReusableCardToken(orderData) {
            clearStaleCardPaymentToken('card_token_preflight_requires_fresh_token', orderData);
            return { token: '', source: '' };
        }
        function consumeCardTokenAtHandoff() {
            if (String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase() !== 'card') return;
            state.cardTokenLifecycle = 'submitted_consumed'; state.paymentConfirmedData = null;
            window.convesiopayPaymentToken = null; window.convesiopayCardPaymentData = null;
        }
        function resetCardTokenLifecycle(reason, removePayload) {
            state.submitGeneration += 1; state.cardTokenLifecycle = 'empty'; state.paymentConfirmedData = null;
            window.convesiopayPaymentToken = null; window.convesiopayCardPaymentData = null;
            if (state.timers.nativeSubmitHandoff) { clearTimeout(state.timers.nativeSubmitHandoff); state.timers.nativeSubmitHandoff = null; }
            if (removePayload) getCheckoutForm().find('input[name="convesiopay_payment_token"], input[name="payment_method_data"]').remove();
            debugLog('[ConvesioPay Classic] Reset card token lifecycle', { reason: reason || 'unspecified' });
        }

        /**
         * Persist non-sensitive token invalidation metadata for the next checkout submit.
     *
     * @param {string} reason
     * @param {string} token
     * @returns {void}
     */
    function addTokenInvalidationMetadata(reason, token) {
        addHiddenField('convesiopay_token_invalidated_reason', String(reason || ''));
        addHiddenField('convesiopay_token_invalidated_at', String(Date.now()));
        addHiddenField('convesiopay_previous_token_prefix', String(token || '').trim().substring(0, 8));
    }

    /**
     * Read token invalidation metadata that should travel with payment_method_data.
     *
     * @returns {Object}
     */
    function getTokenInvalidationMetadata() {
        const $form = getCheckoutForm();
        const reason = String($form.find('input[name="convesiopay_token_invalidated_reason"]').val() || '').trim();
        if (!reason) {
            return {};
        }

        return {
            convesiopay_token_invalidated_reason: reason,
            convesiopay_token_invalidated_at: String($form.find('input[name="convesiopay_token_invalidated_at"]').val() || '').trim(),
            convesiopay_previous_token_prefix: String($form.find('input[name="convesiopay_previous_token_prefix"]').val() || '').trim().substring(0, 8)
        };
    }

    /**
     * Remove one-shot token invalidation metadata after it is copied to payment_method_data.
     *
     * @returns {void}
     */
    function clearTokenInvalidationMetadata() {
        getCheckoutForm().find('input[name="convesiopay_token_invalidated_reason"], input[name="convesiopay_token_invalidated_at"], input[name="convesiopay_previous_token_prefix"]').remove();
    }

    /**
     * Clear card token data after Woo rejects the payment request as invalid.
     *
     * @param {string=} reason
     * @returns {void}
     */
    function clearCardPaymentTokenAfterInvalidRequest(reason) {
        const confirmedMethod = String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase();
        if (confirmedMethod === 'card') {
            state.paymentConfirmedData = null;
        }
        const currentToken = String(window.convesiopayPaymentToken || '').trim();
        if (reason) {
            addTokenInvalidationMetadata(reason, currentToken);
        }
        window.convesiopayPaymentToken = null;
        const $form = getCheckoutForm();
        $form.find('input[name="convesiopay_payment_token"]').remove();
        $form.find('input[name="payment_method_data"]').each(function () {
            const value = String($(this).val() || '');
            let removeField = false;
            try {
                const payload = JSON.parse(value);
                const payloadMethod = String(payload?.paymentMethod || '').toLowerCase();
                const payloadToken = String(payload?.convesiopay_payment_token || '').trim();
                removeField = payloadMethod === 'card' || (currentToken && payloadToken === currentToken);
            } catch (_error) {
                removeField = value.indexOf('"paymentMethod":"card"') !== -1 || (currentToken && value.indexOf(currentToken) !== -1);
            }
            if (removeField) {
                $(this).remove();
            }
        });
        if (reason) {
            debugLog('[ConvesioPay Classic] Cleared card token data after invalid payment request', {
                reason: reason
            });
        }
    }

    const RETRYABLE_CARD_TOKEN_USER_MESSAGE = 'We couldn’t validate your card details. Please review your card information and try again.';
    const DECLINED_NO_CHARGE_ERROR_CODE = 'convesiopay-declined-no-charge';
    const DECLINED_NO_CHARGE_NOTICE_SELECTOR = '[data-peachpay-error-code="' + DECLINED_NO_CHARGE_ERROR_CODE + '"]';

    function parseCheckoutErrorHtml(errorMessage) {
        if (!errorMessage || typeof window.DOMParser === 'undefined') return null;
        try { return new window.DOMParser().parseFromString(String(errorMessage), 'text/html'); } catch (_error) { return null; }
    }

    function getCheckoutErrorText(errorMessage) {
        const parsed = parseCheckoutErrorHtml(errorMessage);
        return String(parsed?.body?.textContent || '') || getCheckoutForm().find('.woocommerce-NoticeGroup-checkout, .woocommerce-error').text();
    }

    function hasDeclinedNoChargeNotice(errorMessage) {
        const parsed = parseCheckoutErrorHtml(errorMessage);
        if (parsed?.querySelector(DECLINED_NO_CHARGE_NOTICE_SELECTOR)) return true;
        return Boolean(getCheckoutForm().get(0)?.querySelector(DECLINED_NO_CHARGE_NOTICE_SELECTOR));
    }

    /**
     * Check whether plain text contains Woo's technical invalid payment request error.
     *
     * @param {string} message
     * @returns {boolean}
     */
    function hasInvalidPaymentRequest503Text(message) {
        return String(message || '').indexOf('ConvesioPay API error (HTTP 503)') !== -1 && String(message || '').indexOf('Invalid payment request') !== -1;
    }

    /**
     * Check whether plain text contains ConvesioPay's generic failed card payment status.
     *
     * @param {string} message
     * @returns {boolean}
     */
    function hasPaymentStatusErrorText(message) {
        return String(message || '').indexOf('Payment failed with status: Error') !== -1;
    }

    /**
     * Check whether checkout is currently using ConvesioPay card.
     *
     * @returns {boolean}
     */
    function isConvesioPayCardCheckoutActive() {
        const $form = getCheckoutForm();
        const $paymentMethods = $form.find('input[name="payment_method"]');
        const selectedGateway = String($paymentMethods.filter(':checked').val() || ($paymentMethods.length === 1 ? $paymentMethods.val() : '') || '').trim();
        const selectedMethod = resolveMethod();

        return selectedGateway === CONFIG.gatewayId && selectedMethod === 'card';
    }

    /**
     * Detect retryable Woo checkout errors caused by a ConvesioPay card payment token.
     *
     * @param {*} errorMessage
     * @returns {string}
     */
    function getRetryableCardTokenInvalidationReason(errorMessage) {
        if (!isConvesioPayCardCheckoutActive()) {
            return '';
        }

        const message = getCheckoutErrorText(errorMessage);

        if (hasInvalidPaymentRequest503Text(message) || /Invalid payment request, token not found/i.test(message)) {
            return 'checkout_error_http_503_invalid_payment_request';
        }
        if (hasPaymentStatusErrorText(message)) {
            return 'checkout_error_payment_status_error';
        }
        return '';
    }

    /**
     * Check whether plain text contains a retryable ConvesioPay card token error.
     *
     * @param {string} message
     * @returns {boolean}
     */
    function hasRetryableCardTokenErrorText(message) {
        return hasInvalidPaymentRequest503Text(message) || hasPaymentStatusErrorText(message);
    }

    /**
     * Replace technical retryable card-token checkout notices with a user-friendly message.
     *
     * @param {*} errorMessage
     * @returns {void}
     */
    function replaceRetryableCardTokenNotice(errorMessage) {
        const eventMessage = getCheckoutErrorText(errorMessage);
        const eventHasRetryableCardTokenError = hasRetryableCardTokenErrorText(eventMessage);

        const replaceNoticeText = function () {
            const $form = getCheckoutForm();
            if (!$form.length) {
                return;
            }

            const $errorNotices = $form.find('.woocommerce-NoticeGroup-checkout .woocommerce-error, .woocommerce-error');
            const $listItems = $errorNotices.find('li');
            let replaced = false;

            $listItems.each(function () {
                if (hasRetryableCardTokenErrorText(this.textContent || '')) {
                    this.textContent = RETRYABLE_CARD_TOKEN_USER_MESSAGE;
                    replaced = true;
                }
            });

            if (!replaced && eventHasRetryableCardTokenError && $listItems.length === 1) {
                $listItems.get(0).textContent = RETRYABLE_CARD_TOKEN_USER_MESSAGE;
                replaced = true;
            }

            if (replaced) {
                return;
            }

            $errorNotices.each(function () {
                const $notice = $(this);
                if ($notice.find('li').length) {
                    return;
                }
                if (hasRetryableCardTokenErrorText(this.textContent || '') || (eventHasRetryableCardTokenError && $errorNotices.length === 1)) {
                    this.textContent = RETRYABLE_CARD_TOKEN_USER_MESSAGE;
                }
            });
        };

        replaceNoticeText();
        setTimeout(replaceNoticeText, 0);
    }

    /**
     * Inject payment data into the WooCommerce checkout form.
     *
     * Adds hidden input fields containing:
     * - Payment token
     * - Order number
     * - Payment method
     * - Any additional metadata required by backend
     *
     * Ensures the server receives all necessary data
     * during form submission.
     *
     * @returns {void}
     */
    function addPaymentDataToForm() {
        const txId = getOrCreateTransactionId(); // Get the transaction id.
        addHiddenField('peachpay_transaction_id', txId); // Add the transaction id to the hidden field.

        const method = state.paymentConfirmedData?.paymentMethod || state.currentMethod || CONFIG.defaultMethod;
        const payload = {
            peachpay_transaction_id: String(txId), // Add the transaction id to the payload.
            payment_method_type: String(method) // Add the payment method type to the payload.
        };

        if (state.paymentConfirmedData) {
            payload.paymentMethod = String(state.paymentConfirmedData.paymentMethod || ''); // Add the payment method to the payload.
            payload.status = String(state.paymentConfirmedData.status || ''); // Add the status to the payload.
            payload.paymentId = String(state.paymentConfirmedData.paymentId || ''); // Add the payment id to the payload.
            if (state.paymentConfirmedData.token) {
                payload.convesiopay_payment_token = String(state.paymentConfirmedData.token); // Add the payment token to the payload.
                storePaymentToken(state.paymentConfirmedData.token); // Store the payment token.
            }
            if (method === 'applepay') {
                addHiddenField('applepay_amount', String(state.paymentConfirmedData.amount || ''));
                addHiddenField('applepay_currency', String(state.paymentConfirmedData.currency || ''));
            } else if (method === 'googlepay') {
                payload.googlepay_amount = String(state.paymentConfirmedData.amount || '');
                payload.googlepay_currency = String(state.paymentConfirmedData.currency || '');
                addHiddenField('googlepay_amount', String(state.paymentConfirmedData.amount || ''));
                addHiddenField('googlepay_currency', String(state.paymentConfirmedData.currency || ''));
            }
        } else if (window.convesiopayPaymentToken && resolveMethod() !== 'card') {
            payload.convesiopay_payment_token = String(window.convesiopayPaymentToken);
            storePaymentToken(window.convesiopayPaymentToken);
        }

        const tokenInvalidationMetadata = getTokenInvalidationMetadata();
        Object.assign(payload, tokenInvalidationMetadata);

        addHiddenField('payment_method_data', JSON.stringify(payload)); // Add the payment method data to the hidden field.
        addHiddenField(CONFIG.selectedMethodField, resolveMethod()); // Add the selected method field to the hidden field.

        if (tokenInvalidationMetadata.convesiopay_token_invalidated_reason) {
            clearTokenInvalidationMetadata();
        }
    }

    /**
     * Enable checkout submit button.
     */
    function enableSubmitButton() {
        getCheckoutForm().find('#place_order').prop('disabled', false);
    }

    /**
     * Disable checkout submit button.
     */
    function disableSubmitButton() {
        getCheckoutForm().find('#place_order').prop('disabled', true);
    }

    /**
     * Determine whether mounted component appears available for checkout.
     *
     * @returns {boolean}
     */
    function hasPaymentMethodsAvailable() {
        if (!state.mounted || !state.component || !isUnifiedGatewaySelected()) {
            return false;
        }
        if (isCardMethodActive() && !state.cardSecuredFieldsReady && !updateCardReadinessFromDom('payment_methods_available', state.mountGeneration, state.component)) {
            return false;
        }
        const container = document.getElementById(CONFIG.containerId);
        return Boolean(container && container.querySelector('[class*="adyen-checkout"], iframe, button, [role="button"]'));
    }

    /**
     * Update the checkout submit button state.
     *
     * Enables or disables the checkout button based on:
     * - Payment method selection
     * - Token availability
     * - Component validation state
     *
     * Prevents order submission unless payment is ready.
     *
     * @returns {void}
     */
    function updateSubmitButtonState() {
        const selected = getSelectedGatewayId();
        if (!selected) {
            return;
        }
        if (selected !== CONFIG.gatewayId) {
            enableSubmitButton();
            return;
        }
        if (hasPaymentMethodsAvailable()) {
            enableSubmitButton();
        } else {
            disableSubmitButton();
        }
    }

    /**
     * Get selected Woo gateway id from radio group.
     *
     * @returns {string}
     */
    function getSelectedGatewayId() {
        return $(CONFIG.paymentMethodSelector + ':checked').val() || '';
    }

    /**
     * Check whether unified gateway is currently selected.
     *
     * @returns {boolean}
     */
    function isUnifiedGatewaySelected() {
        return getSelectedGatewayId() === CONFIG.gatewayId;
    }

    /**
     * Resolve AJAX URL for session sync calls.
     *
     * @returns {string}
     */
    function getAjaxUrl() {
        return window.peachpay_convesiopay_unified_data?.ajax_url || window.wc_checkout_params?.ajax_url || '/wp-admin/admin-ajax.php';
    }

    /**
     * Ensure hidden method field exists and matches provided value.
     *
     * @param {string} method
     */
    function setSelectedMethodField(method) {
        const $form = getCheckoutForm();
        if (!$form.length) {
            return;
        }

        const selector = 'input[name="' + CONFIG.selectedMethodField + '"]';
        const $existing = $form.find(selector);
        if ($existing.length) {
            $existing.val(method);
            return;
        }

        $('<input>')
            .attr('type', 'hidden')
            .attr('name', CONFIG.selectedMethodField)
            .val(method)
            .prependTo($form);
    }

    /**
     * Resolve internal method from runtime + hidden field fallback.
     *
     * @returns {'card'|'applepay'|'googlepay'|'btcpay'}
     */
    function resolveMethod() {
        const runtime = String(state.currentMethod || '').toLowerCase();
        if (CONFIG.allowedMethods.includes(runtime) && isMethodEnabled(runtime)) {
            return runtime;
        }

        const hidden = String($('input[name="' + CONFIG.selectedMethodField + '"]').val() || '').toLowerCase();
        if (CONFIG.allowedMethods.includes(hidden) && isMethodEnabled(hidden)) {
            return hidden;
        }

        const confirmed = String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase();
        if (CONFIG.allowedMethods.includes(confirmed) && isMethodEnabled(confirmed)) {
            return confirmed;
        }

        if (isMethodEnabled(CONFIG.defaultMethod)) {
            return CONFIG.defaultMethod;
        }
        return 'card';
    }

    /**
     * On Classic page load, normalize initial method to card to match
     * component default behavior and prevent stale session wallet selection.
     */
    function normalizeInitialMethodToCard() {
        if (!isUnifiedGatewaySelected()) {
            return;
        }
        let initialMethod = '';
        if (isCardEnabled()) {
            initialMethod = 'card';
        } else if (isApplePayEnabled()) {
            initialMethod = 'applepay';
        } else if (isGooglePayEnabled()) {
            initialMethod = 'googlepay';
        } else if (isBtcpayEnabled()) {
            initialMethod = 'btcpay';
        }
        if (!initialMethod) {
            return;
        }
        state.currentMethod = initialMethod;
        setSelectedMethodField(initialMethod);
        debugLog('[ConvesioPay Classic] Initial method normalized on load', {
            method: initialMethod
        });
    }

    /**
     * Trigger WooCommerce checkout refresh in a debounced way.
     * Backend remains source of truth for totals and fees.
     */
    function scheduleCheckoutRefresh() {
        if (!isUnifiedGatewaySelected()) {
            return;
        }

        if (state.timers.checkoutRefresh) {
            clearTimeout(state.timers.checkoutRefresh);
        }

        // Schedule the checkout refresh.
        state.timers.checkoutRefresh = setTimeout(function () {
            try {
                debugLog('[ConvesioPay Classic] Triggering debounced update_checkout', {
                    method: resolveMethod(),
                    debounceMs: CONFIG.checkoutRefreshDebounceMs
                });
                $(document.body).trigger('update_checkout');
            } catch (error) {
                console.warn('[ConvesioPay] Failed to trigger update_checkout. error: ' + error);
            }
        }, CONFIG.checkoutRefreshDebounceMs);
    }

    /**
     * Trigger immediate Woo checkout refresh.
     */
    function triggerCheckoutRefreshNow() {
        if (!isUnifiedGatewaySelected()) {
            return;
        }
        if (state.timers.checkoutRefresh) {
            clearTimeout(state.timers.checkoutRefresh);
            state.timers.checkoutRefresh = null;
        }
        try {
            debugLog('[ConvesioPay Classic] Triggering immediate update_checkout', { method: resolveMethod() });
            $(document.body).trigger('update_checkout');
        } catch (error) {
            console.warn('[ConvesioPay] Failed to trigger immediate update_checkout. error: ' + error);
        }
    }

    /**
     * Persist selected internal method in Woo session.
     *
     * @param {'card'|'applepay'|'btcpay'} method
     * @returns {Promise<boolean>}
     */
    function syncMethodToSession(method) {
        if (!method || !CONFIG.allowedMethods.includes(method) || !isMethodEnabled(method)) {
            return Promise.resolve(false);
        }

        let formData;
        try {
            setSelectedMethodField(method);
            formData = new FormData();
            formData.append('action', CONFIG.sessionAction);
            formData.append(CONFIG.selectedMethodField, method);
        } catch (error) {
            debugLog('[ConvesioPay Classic] Method sync setup failed', { method: method, error: error });
            return Promise.resolve(false);
        }

        return fetch(getAjaxUrl(), {
            method: 'POST',
            credentials: 'same-origin',
            body: formData
        })
            .then((response) => {
                return response.json().catch(function () {
                    debugLog('[ConvesioPay Classic] Method sync response JSON parse failed', { method: method });
                    return {};
                });
            })
            .then((payload) => {
                const ok = !(payload && payload.success === false);
                if (!ok) {
                    console.warn('[ConvesioPay] Method session sync returned unsuccessful payload.');
                }
                return ok;
            })
            .catch(() => {
                console.warn('[ConvesioPay] Method session sync request failed.');
                return false;
            });
    }

    /**
     * Sync method only when changed and schedule backend recalculation.
     *
     * @param {'card'|'applepay'|'btcpay'} method
     */
    function syncMethodIfChanged(method) {
        if (!method || method === state.lastSyncedMethod || !isMethodEnabled(method)) {
            return;
        }

        debugLog('[ConvesioPay Classic] Syncing internal method to session', {
            from: state.lastSyncedMethod || null,
            to: method
        });
        syncMethodToSession(method).then((success) => {
            if (success) {
                state.lastSyncedMethod = method;
                debugLog('[ConvesioPay Classic] Method sync succeeded', { method: method });

                // Schedule the checkout refresh.
                scheduleCheckoutRefresh();
            }
        });
    }

    /**
     * Inject the cpay spinner keyframe stylesheet once into the document head.
     */
    function ensureCpaySpinnerStyles() {
        if (document.getElementById('cpay-spin-style')) {
            return;
        }
        const s = document.createElement('style');
        s.id = 'cpay-spin-style';
        s.textContent = '@keyframes cpaySpin{to{transform:rotate(360deg)}}';
        document.head.appendChild(s);
    }

    /**
     * Lock/unlock in-component interaction while method change is recalculating.
     *
     * @param {boolean} locked
     * @param {string=} method
     */
    function setMethodInteractionLock(locked, method) {
        // order-pay uses a pre-created order and does not require
        // checkout total/fee recalculation lock during method changes.
        if (isOrderPayContext()) {
            return;
        }

        const container = document.getElementById(CONFIG.containerId);
        if (!container) {
            return;
        }
        const lockId = CONFIG.containerId + '-interaction-lock';
        let lockEl = document.getElementById(lockId);
        if (locked) {
            ensureCpaySpinnerStyles();
            if (!lockEl) {
                lockEl = document.createElement('div');
                lockEl.id = lockId;
                lockEl.style.position = 'absolute';
                lockEl.style.inset = '0';
                lockEl.style.zIndex = '20';
                lockEl.style.background = 'rgba(255,255,255,0.6)';
                lockEl.style.pointerEvents = 'all';
                lockEl.style.display = 'flex';
                lockEl.style.alignItems = 'center';
                lockEl.style.justifyContent = 'center';
                lockEl.style.borderRadius = '4px';
                lockEl.setAttribute('aria-hidden', 'true');
                lockEl.innerHTML = '<div style="width:24px;height:24px;border:3px solid #ddd;border-top-color:#555;border-radius:50%;animation:cpaySpin .65s linear infinite;"></div>';
            }
            const style = window.getComputedStyle(container);
            if (style.position === 'static') {
                container.dataset.cpayLockPositionAdjusted = '1';
                container.style.position = 'relative';
            }
            if (!container.contains(lockEl)) {
                container.appendChild(lockEl);
            }
            disableSubmitButton();
            return;
        }
        if (lockEl && lockEl.parentNode) {
            lockEl.parentNode.removeChild(lockEl);
        }
        if (container.dataset.cpayLockPositionAdjusted === '1') {
            container.style.position = '';
            delete container.dataset.cpayLockPositionAdjusted;
        }
        updateSubmitButtonState();
    }

    /**
     * End method-switch lock if session refresh queue is settled.
     *
     * @param {string} reason
     */
    function maybeCompleteMethodSwitch(reason) {
        if (!state.methodSwitchInProgress) {
            return;
        }
        if (state.refreshingSessions || state.pendingSessionRefreshReason) {
            setTimeout(function () {
                maybeCompleteMethodSwitch(reason);
            }, 100);
            return;
        }
        if (state.methodSwitchFallbackUnlock) {
            clearTimeout(state.methodSwitchFallbackUnlock);
            state.methodSwitchFallbackUnlock = null;
        }
        debugLog('[ConvesioPay Classic] Method switch completed', {
            method: state.methodSwitchTarget,
            reason: reason || 'unspecified'
        });
        state.methodSwitchInProgress = false;
        state.methodSwitchTarget = '';
        setMethodInteractionLock(false);
    }

    /**
     * Handle internal method switch flow with checkout recalculation guard.
     * Prevents fast-click races where wallet/card uses stale totals.
     *
     * @param {'card'|'applepay'|'googlepay'|'btcpay'|null} method
     * @param {string} source
     */
    function startInternalMethodSwitchFlow(method, source) {
        if (!method || !CONFIG.allowedMethods.includes(method) || !isMethodEnabled(method)) {
            return;
        }
        const previous = String(resolveMethod() || '').toLowerCase();
        if (previous === method && !state.methodSwitchInProgress) {
            return;
        }

        state.currentMethod = method;
        setSelectedMethodField(method);
        mirrorServerTotals();

        if (state.methodSwitchInProgress && state.methodSwitchTarget === method) {
            return;
        }

        state.methodSwitchInProgress = true;
        state.methodSwitchTarget = method;
        setMethodInteractionLock(true, method);
        debugLog('[ConvesioPay Classic] Method switch started', { previous: previous, next: method, source: source });

        if (state.methodSwitchFallbackUnlock) {
            clearTimeout(state.methodSwitchFallbackUnlock);
        }
        state.methodSwitchFallbackUnlock = setTimeout(function () {
            debugLog('[ConvesioPay Classic] Method switch fallback unlock fired', { target: state.methodSwitchTarget });
            state.methodSwitchInProgress = false;
            state.methodSwitchTarget = '';
            setMethodInteractionLock(false);
        }, 9000);

        syncMethodToSession(method).then(function (success) {
            if (!success) {
                debugLog('[ConvesioPay Classic] Method switch aborted: sync failed', { method: method });
                state.methodSwitchInProgress = false;
                state.methodSwitchTarget = '';
                setMethodInteractionLock(false);
                return;
            }
            state.lastSyncedMethod = method;

            // order-pay does not rely on update_checkout fee/total refresh.
            // Complete the method switch immediately to keep interaction smooth.
            if (isOrderPayContext()) {
                state.methodSwitchInProgress = false;
                state.methodSwitchTarget = '';
                setMethodInteractionLock(false);
                updateSubmitButtonState();
                return;
            }

            triggerCheckoutRefreshNow();
        }).catch(function (error) {
            debugLog('[ConvesioPay Classic] Method switch failed unexpectedly', { method: method, error: error });
            state.methodSwitchInProgress = false;
            state.methodSwitchTarget = '';
            setMethodInteractionLock(false);
        });
    }

    /**
     * Capture explicit user method intent from direct UI interactions.
     * This is used to prevent immediate SDK "card" change bounces
     * right after an explicit wallet selection.
     *
     * @param {'card'|'applepay'|'googlepay'|'btcpay'|null} method
     */
    function markExplicitMethodIntent(method) {
        if (!method || !CONFIG.allowedMethods.includes(method)) {
            return;
        }
        state.explicitMethodIntent = method;
        state.explicitMethodIntentAtMs = Date.now();
        if (method === 'applepay' || method === 'googlepay') {
            state.suppressCardComponentChangeUntilMs = Date.now() + CONFIG.methodIntentSuppressionMs;
            return;
        }
        state.suppressCardComponentChangeUntilMs = 0;
    }

    /**
     * Whether card component-change should be ignored temporarily because
     * explicit wallet intent is still within suppression window.
     *
     * @returns {boolean}
     */
    function shouldSuppressCardComponentChange() {
        const now = Date.now();
        const explicitIntent = String(state.explicitMethodIntent || '').toLowerCase();
        const effectiveTarget = String(state.methodSwitchTarget || state.currentMethod || '').toLowerCase();
        const withinWindow = now <= Number(state.suppressCardComponentChangeUntilMs || 0);
        return (
            withinWindow &&
            (explicitIntent === 'applepay' || explicitIntent === 'googlepay') &&
            effectiveTarget === explicitIntent
        );
    }

    /**
     * Parse numeric amount from rendered price string.
     *
     * @param {string} value
     * @returns {number}
     */
    function parseAmount(value) {
        return parseFloat(String(value || '').replace(/[^0-9.-]/g, '')) || 0;
    }

    /**
     * Get canonical order review table row amount element.
     *
     * @param {Element|null} row
     * @returns {Element|null}
     */
    function getAmountElement(row) {
        if (!row) {
            return null;
        }
        return row.querySelector('.woocommerce-Price-amount bdi') ||
            row.querySelector('.woocommerce-Price-amount') ||
            row.querySelector('.amount bdi') ||
            row.querySelector('.amount') ||
            row.querySelector('td:last-child');
    }

    /**
     * Visibility guard for mirrored cloned/template checkout rows.
     *
     * @param {Element|null} el
     * @returns {boolean}
     */
    function isVisible(el) {
        if (!el || !(el instanceof Element) || el.offsetParent === null) {
            return false;
        }

        const hiddenAncestor = el.closest('[hidden], [aria-hidden="true"], .hidden, .d-none, .sr-only, template');
        if (hiddenAncestor) {
            return false;
        }

        const style = window.getComputedStyle(el);
        return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0);
    }

    /**
     * Presentation-only mirror from canonical Woo totals to visible clones.
     * No fee calculation is performed here.
     */
    function mirrorServerTotals() {
        const table = document.querySelector('.woocommerce-checkout-review-order-table');
        if (!table) {
            return;
        }

        const canonicalFeeRow = table.querySelector('tr.fee');
        const canonicalTotalRow = table.querySelector('tr.order-total');
        const canonicalFeeLabel = canonicalFeeRow?.querySelector('th')?.textContent?.trim() || '';
        const canonicalFeeAmount = getAmountElement(canonicalFeeRow)?.textContent?.trim() || '';
        const canonicalTotal = getAmountElement(canonicalTotalRow)?.textContent?.trim() || '';

        state.lastKnownFeeAmount = canonicalFeeAmount ? parseAmount(canonicalFeeAmount) : 0;

        if (canonicalFeeAmount) {
            Array.from(document.querySelectorAll('tr.fee, .fee')).forEach((row) => {
                if (!row || row === canonicalFeeRow || !isVisible(row)) {
                    return;
                }

                // Never mutate fee rows that belong to canonical Woo review table.
                if (row.closest('.woocommerce-checkout-review-order-table')) {
                    return;
                }

                const label = row.querySelector('th');
                const amount = getAmountElement(row);
                const labelText = String(label?.textContent || '').trim().toLowerCase();

                // Keep wallet/store-credit rows untouched; they are independent fee lines.
                if (
                    labelText.includes('wallet') ||
                    labelText.includes('store credit') ||
                    labelText.includes('via wallet')
                ) {
                    return;
                }

                if (label && canonicalFeeLabel) {
                    label.textContent = canonicalFeeLabel;
                }
                if (amount) {
                    amount.textContent = canonicalFeeAmount;
                }
                row.style.display = '';
            });
        }

        if (canonicalTotal) {
            Array.from(document.querySelectorAll('tr.order-total, .order-total')).forEach((row) => {
                if (!row || row === canonicalTotalRow || !isVisible(row)) {
                    return;
                }
                const amount = getAmountElement(row);
                if (amount) {
                    amount.textContent = canonicalTotal;
                }
            });
        }
    }

    /**
     * Remove stale blockUI overlays in payment wrapper.
     */
    function clearPaymentOverlay() {
        try {
            // Only clear inside payment box.
            const $payment = $('#payment, .woocommerce-checkout-payment');
            if ($payment.length && typeof $payment.unblock === 'function') {
                $payment.unblock();
            }
            // Remove blockUI nodes only from payment container.
            $payment.find('.blockUI, .blockOverlay, .blockMsg').remove();
            // Keep Woo form/review-order processing state untouched.
            $payment.removeClass('processing');
            $payment.each(function () {
                this.style.removeProperty('position');
                this.style.removeProperty('overflow');
                this.style.removeProperty('min-height');
                this.removeAttribute('aria-busy');
            });

        } catch (error) {
            console.warn('[ConvesioPay] Failed to clear stale checkout overlay.');
        }
    }

    /**
     * Centralized checkout overlay lock/unlock control with safety fallback.
     *
     * @param {boolean} locked
     * @param {string=} reason
     */
    function setCheckoutProcessingOverlay(locked, reason) {
        try {
            const $form = getCheckoutForm();
            const $payment = $('#payment, .woocommerce-checkout-payment');

            if (locked) {
                state.submitOverlayLocked = true;
                if (state.submitOverlayFailsafeTimer) {
                    clearTimeout(state.submitOverlayFailsafeTimer);
                    state.submitOverlayFailsafeTimer = null;
                }

                disableSubmitButton();
                $form.addClass('processing');
                $(document.body).addClass('processing');

                if ($payment.length && typeof $payment.block === 'function') {
                    $payment.block({
                        message: null,
                        overlayCSS: {
                            background: '#fff',
                            opacity: 0.6
                        }
                    });
                }

                state.submitOverlayFailsafeTimer = setTimeout(function () {
                    if (!state.submitInProgress && !state.submitOverlayLocked) {
                        return;
                    }
                    debugLog('[ConvesioPay Classic] Submit overlay failsafe retained unresolved submit lock', {
                        reason: reason || 'unspecified'
                    });
                }, 15000);
                return;
            }

            state.submitOverlayLocked = false;
            if (state.submitOverlayFailsafeTimer) {
                clearTimeout(state.submitOverlayFailsafeTimer);
                state.submitOverlayFailsafeTimer = null;
            }
            clearPaymentOverlay();
            setTimeout(clearPaymentOverlay, CONFIG.overlayClearFastMs);
            $form.removeClass('processing');
            $(document.body).removeClass('processing');
        } catch (_error) {
            clearPaymentOverlay();
        }
    }

    /**
     * Bind persistent overlay cleanup guards for late-injected blockUI overlays.
     */
    function bindOverlayCleanupGuards() {
        if (state.overlayCleanupBound) {
            return;
        }
        state.overlayCleanupBound = true;

        $(document)
            .off('ajaxStop.convesiopayClassicOverlay ajaxComplete.convesiopayClassicOverlay')
            .on('ajaxStop.convesiopayClassicOverlay ajaxComplete.convesiopayClassicOverlay', function () {
                if (!isUnifiedGatewaySelected()) {
                    return;
                }
                clearPaymentOverlay();
                if (state.timers.overlaySweep) {
                    clearTimeout(state.timers.overlaySweep);
                }
                state.timers.overlaySweep = setTimeout(clearPaymentOverlay, 140);
            });

        try {
            const observedRoot = document.querySelector(getCheckoutFormSelector()) || document.body;
            if (observedRoot && typeof MutationObserver !== 'undefined') {
                state.overlayObserver = new MutationObserver(function (mutations) {
                    if (!isUnifiedGatewaySelected()) {
                        return;
                    }
                    if (!state.cardSecuredFieldsReady && isCardMethodActive()) {
                        const readinessContext = state.cardReadinessTimerContext || {
                            generation: state.mountGeneration,
                            component: state.component
                        };
                        updateCardReadinessFromDom(
                            'readiness_observer',
                            readinessContext.generation,
                            readinessContext.component
                        );
                    }
                    let hasOverlay = false;
                    for (let i = 0; i < mutations.length; i += 1) {
                        const mutation = mutations[i];
                        if (
                            mutation.type === 'attributes' &&
                            mutation.target &&
                            mutation.target.nodeType === 1 &&
                            mutation.target.classList &&
                            mutation.target.classList.contains('blockUI')
                        ) {
                            hasOverlay = true;
                            break;
                        }
                        if (!mutation.addedNodes || !mutation.addedNodes.length) {
                            continue;
                        }
                        for (let j = 0; j < mutation.addedNodes.length; j += 1) {
                            const node = mutation.addedNodes[j];
                            if (!node || node.nodeType !== 1) {
                                continue;
                            }
                            const className = String(node.className || '');
                            if (
                                className.includes('blockUI') ||
                                className.includes('blockOverlay') ||
                                (typeof node.querySelector === 'function' && node.querySelector('.blockUI.blockOverlay'))
                            ) {
                                hasOverlay = true;
                                break;
                            }
                        }
                        if (hasOverlay) {
                            break;
                        }
                    }
                    if (hasOverlay) {
                        clearPaymentOverlay();
                        if (state.timers.overlaySweep) {
                            clearTimeout(state.timers.overlaySweep);
                        }
                        state.timers.overlaySweep = setTimeout(clearPaymentOverlay, 120);
                        setTimeout(clearPaymentOverlay, 260);
                    }
                });
                state.overlayObserver.observe(observedRoot, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['style', 'class']
                });
            }
        } catch (_error) {
            // Guard only; should never interrupt checkout.
        }
    }

    /**
     * Create BTCPay session through existing WordPress AJAX endpoint.
     *
     * @returns {Promise<{success:boolean, session?:string, message?:string, disabled?:boolean}>}
     */
    function createBTCPaySession() {
        if (!isBtcpayEnabled()) {
            return Promise.resolve({ success: false, disabled: true, message: 'BTCPay disabled' });
        }

        const orderData = getOrderData();
        if (!orderData.isValid) {
            return Promise.resolve({ success: false, message: 'Invalid order data' });
        }
        const currentSignature = getAmountCurrencySignature(orderData);
        if (
            state.btcSession &&
            state.btcSessionSignature &&
            currentSignature &&
            state.btcSessionSignature === currentSignature
        ) {
            return Promise.resolve({ success: true, session: state.btcSession });
        }

        return new Promise((resolve) => {
            try {
                $.ajax({
                    url: window.peachpay_convesiopay_unified_data?.ajax_url || getAjaxUrl(),
                    method: 'POST',
                    data: {
                        action: 'peachpay_convesiopay_create_btcpay_session',
                        nonce: window.peachpay_convesiopay_unified_data?.nonce || '',
                        integration: getConfig().integration_name,
                        returnUrl: window.location.href,
                        orderNumber: orderData.orderNumber,
                        amount: orderData.amount,
                        currency: orderData.currency,
                        email: orderData.email,
                        name: orderData.name
                    },
                    success: function (response) {
                        if (response.success && response.data?.session) {
                            state.btcSession = response.data.session;
                            state.btcSessionSignature = currentSignature;
                            resolve({ success: true, session: state.btcSession });
                            return;
                        }
                        const message = response.data?.message || response.message || 'Failed to create BTCPay session';
                        resolve({
                            success: false,
                            message: message,
                            disabled: message.toLowerCase().includes('disabled')
                        });
                    },
                    error: function (_xhr, _status, error) {
                        resolve({ success: false, message: String(error || 'AJAX request failed') });
                    }
                });
            } catch (error) {
                console.warn('[ConvesioPay] BTCPay session AJAX setup failed. error: ' + error);
                resolve({ success: false, message: 'BTCPay AJAX setup failed' });
            }
        });
    }

    /**
     * Bind BTCPay postMessage listener once.
     */
    function setupBtcPayMessageListener() {
        if (state.btcListenerBound) {
            return;
        }
        state.btcListenerBound = true;

        window.addEventListener('message', (event) => {
                try {
                if (!isAllowedPaymentMessageOrigin(event.origin)) {
                    return;
                }

                let data = event.data;
                if (typeof data === 'string') {
                    try {
                        data = JSON.parse(data);
                    } catch (error) {
                        console.warn('[ConvesioPay] BTCPay message parsing failed. error: ' + error);
                        return;
                    }
                }

                if (data?.status !== 'Processing') {
                    return;
                }

                const orderData = getOrderData();
                state.paymentConfirmedData = {
                    paymentId: data.invoiceId || '',
                    invoiceId: data.invoiceId || '',
                    status: 'Processing',
                    paymentMethod: 'btcpay',
                    amount: orderData.amount,
                    currency: orderData.currency,
                    orderNumber: orderData.orderNumber,
                    token: 'btc-session-' + (state.btcSession || '')
                };
                state.currentMethod = 'btcpay';
                addPaymentDataToForm();
                setTimeout(function () {
                    autoClickPlaceOrderButton();
                }, 500);
                } catch (error) {
                console.warn('[ConvesioPay] BTCPay postMessage handling failed. error: ' + error);
            }
        });
    }

    /**
     * Parse origin string safely.
     *
     * @param {string} value
     * @returns {string}
     */
    function getOriginSafe(value) {
        try {
            if (!value) {
                return '';
            }
            return new URL(value, window.location.origin).origin;
        } catch (error) {
            console.warn('[ConvesioPay] Error parsing origin. error: ' + error);
            return '';
        }
    }

    /**
     * Validate postMessage origin using strict allowlist.
     *
     * Sources:
     * - `peachpay_convesiopay_unified_data.btcpay_allowed_origins` (preferred)
     * - static ConvesioPay hosts and configured API URL origin
     *
     * @param {string} origin
     * @returns {boolean}
     */
    function isAllowedPaymentMessageOrigin(origin) {
        if (!origin) {
            return false;
        }

        const configured = getConfig().btcpay_allowed_origins;
        const configOrigins = Array.isArray(configured)
            ? configured.map((item) => getOriginSafe(String(item))).filter(Boolean)
            : [];

        const defaultOrigins = [
            'https://checkout.convesiopay.com',
            'https://api.convesiopay.com',
            'https://api-qa.convesiopay.com',
            getOriginSafe(getConfig().convesiopay_config?.api_url)
        ].filter(Boolean);

        const allowlist = configOrigins.length > 0 ? configOrigins : defaultOrigins;
        return allowlist.includes(origin);
    }

    /**
     * Safely read className from HTML/SVG nodes.
     *
     * @param {Element|null} element
     * @returns {string}
     */
    function getClassNameSafe(element) {
        if (!element) {
            return '';
        }
        const className = element.className;
        if (typeof className === 'string') {
            return className;
        }
        if (className && typeof className.baseVal === 'string') {
            return className.baseVal;
        }
        return '';
    }

    /**
     * Detect internal method from accordion header click context.
     *
     * @param {Element|null} accordionHeader
     * @returns {'card'|'applepay'|'googlepay'|'btcpay'|null}
     */
    function detectMethodFromAccordionHeader(accordionHeader) {
        if (!accordionHeader) {
            return null;
        }

        const accordionItem = accordionHeader.closest('.accordion-item');
        const classSignal = (
            getClassNameSafe(accordionHeader) + ' ' +
            (accordionItem ? getClassNameSafe(accordionItem) : '')
        ).toLowerCase();
        // Include the header markup so icon-only headers (for example the
        // PeachPay OneClick saved-card logo) still expose their structural
        // marker classes even when the header has no visible text.
        const htmlSignal = (
            (accordionItem ? String(accordionItem.outerHTML || '').substring(0, 700) : '') + ' ' +
            String(accordionHeader.outerHTML || '')
        ).toLowerCase();

        // Wallet-specific detection must always win before any card fallback.
        if (
            classSignal.includes('btc-pay') ||
            classSignal.includes('btcpay') ||
            classSignal.includes('crypto') ||
            htmlSignal.includes('btc-pay') ||
            htmlSignal.includes('btcpay')
        ) {
            return 'btcpay';
        }

        if (
            classSignal.includes('apple-pay') ||
            classSignal.includes('applepay') ||
            htmlSignal.includes('apple-pay') ||
            htmlSignal.includes('applepay')
        ) {
            return 'applepay';
        }

        if (
            classSignal.includes('google-pay') ||
            classSignal.includes('googlepay') ||
            htmlSignal.includes('google-pay') ||
            htmlSignal.includes('googlepay')
        ) {
            return 'googlepay';
        }

        // PeachPay OneClick saved-card header and other stored/new card containers.
        if (
            htmlSignal.includes('convesio-one-header') ||
            htmlSignal.includes('convesio-one') ||
            classSignal.includes('oneclick') ||
            classSignal.includes('one-click') ||
            classSignal.includes('saved-card') ||
            classSignal.includes('stored-payment') ||
            classSignal.includes('new-card') ||
            classSignal.includes('card-container') ||
            classSignal.includes('card')
        ) {
            return 'card';
        }

        const headerText = String(accordionHeader.textContent || '').toLowerCase();
        if (headerText.includes('crypto') || headerText.includes('bitcoin') || headerText.includes('btc')) {
            return 'btcpay';
        }
        if (headerText.includes('apple')) {
            return 'applepay';
        }
        if (headerText.includes('google')) {
            return 'googlepay';
        }
        if (
            (headerText.includes('card') ||
                headerText.includes('credit') ||
                headerText.includes('debit') ||
                headerText.includes('saved') ||
                headerText.includes('secure')) &&
            !headerText.includes('apple') &&
            !headerText.includes('google') &&
            !headerText.includes('crypto') &&
            !headerText.includes('bitcoin')
        ) {
            return 'card';
        }

        return null;
    }

    /**
     * Apply detected method to runtime and trigger fee/session sync.
     *
     * @param {'card'|'applepay'|'btcpay'|null} method
     */
    function applyDetectedInternalMethod(method) {
        // Truly unknown accordion clicks must not force a method switch. Leaving
        // the current internal method untouched avoids clobbering a valid wallet
        // or card selection with a null/invalid value.
        if (!method) {
            debugLog('[ConvesioPay Classic] Ignoring accordion click with no detectable method');
            return;
        }
        markExplicitMethodIntent(method);
        startInternalMethodSwitchFlow(method, 'accordion_click');
    }

    /**
     * Bind delegated click listener for internal payment method tabs/accordion.
     * Some SDK UI method switches are not consistently emitted via change events.
     */
    function bindInternalMethodSelectionEvents() {
        const container = document.getElementById(CONFIG.containerId);
        if (!container) {
            return;
        }
        if (container.dataset.methodBindingAdded === 'true') {
            return;
        }
        container.dataset.methodBindingAdded = 'true';

        container.addEventListener(
            'click',
            function (event) {
                const target = event.target;
                if (!target || typeof target.closest !== 'function') {
                    return;
                }
                if (
                    resolveMethod() === 'googlepay' &&
                    target.closest(
                        'button, [role="button"], iframe, .adyen-checkout__button, .adyen-checkout__googlepay, .adyen-checkout__googlepay__button, .google-pay-button'
                    )
                ) {
                    lockGooglePayUiRefresh('googlepay_action_click');
                }
                const accordionHeader = target.closest('.accordion-header');
                if (!accordionHeader) {
                    return;
                }
                const detectedMethod = detectMethodFromAccordionHeader(accordionHeader); // Detect the method from the accordion header.
                applyDetectedInternalMethod(detectedMethod); // Apply the detected internal method.
            },
            true
        );
    }

    /**
     * Refresh Apple Pay/Google Pay/BTCPay sessions without unmounting component.
     *
     * @param {string} reason
     */
    async function refreshSessionsInPlace(reason) {
        if (state.refreshingSessions) {
            if (reason) {
                state.pendingSessionRefreshReason = reason;
            }
            return;
        }

        if (!state.mounted || !state.component || !isUnifiedGatewaySelected()) {
            return;
        }

        if (shouldDeferForCardReadiness(reason || 'session_refresh')) {
            debugLog('[ConvesioPay Classic] Deferring session refresh until Card secured fields are ready', {
                reason: reason || 'unspecified'
            });
            return;
        }

        try {
            state.refreshingSessions = true;

            const orderData = getOrderData();
            debugLog('[ConvesioPay Classic] Refreshing sessions in-place', {
                reason: reason || 'unspecified',
                amount: orderData.amount,
                currency: orderData.currency,
                isValid: orderData.isValid,
                method: resolveMethod()
            });
            if (!orderData.isValid) {
                debugLog('[ConvesioPay Classic] Skipping session refresh: invalid order data', {
                    reason: reason || 'unspecified',
                    amount: orderData.amount,
                    currency: orderData.currency
                });
                return;
            }

            const previousAmountCurrencySignature = state.lastKnownAmountCurrencySignature;
            const runtimeAmountResult = await applyRuntimeAmountUpdate(reason || 'session_refresh', false);
            const amountCurrencySignature = runtimeAmountResult.signature || getAmountCurrencySignature(orderData);
            const isUpdatedCheckoutAmountCurrencyChange = reason === 'updated_checkout_amount_currency_change';
            const amountCurrencyChanged = Boolean(
                amountCurrencySignature &&
                amountCurrencySignature !== previousAmountCurrencySignature
            );

            if (isApplePayEnabled()) {
                const shouldRebuildApplePaySession = (
                    !runtimeAmountResult.supported ||
                    !runtimeAmountResult.ok ||
                    !state.applePaySessionPrimed ||
                    !state.applePaySessionSignature ||
                    state.applePaySessionSignature !== amountCurrencySignature ||
                    (isUpdatedCheckoutAmountCurrencyChange && amountCurrencyChanged)
                );
                if (!shouldRebuildApplePaySession) {
                    debugLog('[ConvesioPay Classic] Skipping Apple Pay session rebuild: amount/currency unchanged', {
                        reason: reason || 'unspecified',
                        signature: amountCurrencySignature,
                        previousSignature: previousAmountCurrencySignature,
                        sessionSignature: state.applePaySessionSignature,
                        skipped: runtimeAmountResult.skipped,
                        applePaySessionPrimed: state.applePaySessionPrimed
                    });
                } else {
                    try {
                        // Create the Apple Pay session if it's enabled.
                        await createApplePaySessionWithRetry({
                            integration: getConfig().integration_name || 'PeachPay',
                            returnUrl: window.location.href,
                            amount: orderData.amount,
                            currency: orderData.currency,
                            email: orderData.email,
                            name: orderData.name
                        });
                        state.applePaySessionPrimed = true;
                        state.applePaySessionSignature = amountCurrencySignature;
                    } catch (error) {
                        state.applePaySessionPrimed = false;
                        state.applePaySessionSignature = '';
                        console.warn('[ConvesioPay] Apple Pay session refresh failed. error: ' + error);
                    }
                }
            } else {
                state.applePaySessionPrimed = false;
                state.applePaySessionSignature = '';
            }

            if (isGooglePayEnabled()) {
                try {
                    const googlePayUiLocked = isGooglePayUiRefreshLocked();
                    const shouldRebuildGooglePaySession = (
                        !runtimeAmountResult.supported ||
                        !runtimeAmountResult.ok ||
                        !state.googlePaySessionPrimed ||
                        !state.googlePaySessionSignature ||
                        state.googlePaySessionSignature !== amountCurrencySignature
                    );
                    if (googlePayUiLocked) {
                        debugLog('Skipping Google Pay session refresh while UI lock is active', {
                            reason: reason || 'unspecified',
                            signature: amountCurrencySignature,
                            previousSignature: state.googlePaySessionSignature,
                            primed: state.googlePaySessionPrimed
                        });
                    } else if (shouldRebuildGooglePaySession) {
                        await createGooglePaySessionWithRetry({
                            integration: getConfig().integration_name || 'PeachPay',
                            returnUrl: window.location.href,
                            orderNumber: orderData.orderNumber,
                            amount: orderData.amount,
                            currency: orderData.currency,
                            email: orderData.email,
                            name: orderData.name
                        });
                    }
                    if (!googlePayUiLocked) {
                        state.googlePaySessionPrimed = true;
                        state.googlePaySessionSignature = amountCurrencySignature;
                    }
                } catch (error) {
                    state.googlePaySessionSignature = '';
                    state.googlePaySessionPrimed = false;
                    console.warn('[ConvesioPay] Google Pay session refresh failed. error: ' + error);
                }
            } else {
                state.googlePaySessionSignature = '';
                state.googlePaySessionPrimed = false;
            }

            if (isBtcpayEnabled()) {
                try {
                    // Create the BTCPay session if it's enabled.
                    const btc = await createBTCPaySession();
                    if (btc.success && btc.session) {
                        state.btcSession = btc.session;
                        try {
                            // Create the BTCPay intent if it's enabled.
                            await state.component.createBTCPayIntent({ session: state.btcSession });
                            setupBtcPayMessageListener();
                        } catch (intentError) {
                            console.warn('[ConvesioPay] BTCPay intent refresh failed. error: ' + intentError);
                        }
                    }
                } catch (error) {
                    console.warn('[ConvesioPay] BTCPay session refresh failed. error: ' + error);
                }
            } else {
                // If the BTC Pay is not enabled, set the BTC session to null.
                state.btcSession = null;
                state.btcSessionSignature = '';
            }

            state.lastKnownAmountCurrencySignature = getAmountCurrencySignature(orderData);

        } finally {
            state.refreshingSessions = false;

            if (state.pendingSessionRefreshReason) {
                const nextReason = state.pendingSessionRefreshReason;
                state.pendingSessionRefreshReason = '';
                setTimeout(function () {
                    refreshSessionsInPlace(nextReason);
                }, 0);
            }
        }
    }

    /**
     * Handles card component change events (no tokenization on change).
     *
     * This function is triggered whenever the card component emits a change event.
     * It only updates submit button state. Card token is created once when the user
     * clicks Place order (in runSubmitPreflightFlow) to avoid 429 rate limits from
     * repeated createToken() calls while typing (e.g. cardholder name).
     *
     * @param {Object} event - Card component change event.
     * @param {boolean} event.isValid - Indicates whether the card details are fully valid.
     *
     * @returns {void}
     */
    function getCardValidationErrorMessage(errors) {
        if (!errors || typeof errors !== 'object') return '';
        for (const field of ['number', 'expiry', 'cvc']) {
            const error = errors[field];
            const message = typeof error === 'string' ? error : (error?.message || error?.hint || '');
            if (typeof message === 'string' && message.trim()) return message.trim();
        }
        return '';
    }

    /**
     * Count secured card iframes inside the active mount root.
     *
     * @param {Element|null} root
     * @returns {{securedFieldIframeCount: number, totalIframeCount: number}}
     */
    function countSecuredFieldIframes(root) {
        if (!root) {
            return {
                securedFieldIframeCount: 0,
                totalIframeCount: 0
            };
        }
        const iframes = Array.from(root.querySelectorAll('iframe'));
        return {
            securedFieldIframeCount: iframes.filter(isVgsSecuredFieldIframe).length,
            totalIframeCount: iframes.length
        };
    }

    /**
     * Build a safe diagnostic snapshot for submit-time card field state.
     * Does not read iframe values (cross-origin); only structural/SDK proxies.
     *
     * @param {string=} checkpoint
     * @param {Object=} extra
     * @returns {Object}
     */
    function getSubmitCardFieldDiagnostics(checkpoint, extra) {
        const mountNode = state.mountNode || document.getElementById(CONFIG.mountNodeId);
        const container = document.getElementById(CONFIG.containerId);
        const root = getCardSecuredFieldsRoot();
        const iframeCounts = countSecuredFieldIframes(root);
        const errorKeys = [];

        if (state.cardComponentErrors && typeof state.cardComponentErrors === 'object') {
            Object.keys(state.cardComponentErrors).forEach(function (key) {
                const value = state.cardComponentErrors[key];
                if (value === null || typeof value === 'undefined') {
                    return;
                }
                if (typeof value === 'string' && !value.trim()) {
                    return;
                }
                errorKeys.push(key);
            });
        }

        const diagnostics = {
            checkpoint: checkpoint || 'unspecified',
            submitInProgress: state.submitInProgress,
            mountGeneration: state.mountGeneration,
            cardUserInteractionStarted: state.cardUserInteractionStarted,
            cardSecuredFieldsReady: state.cardSecuredFieldsReady,
            cardComponentValid: state.cardComponentValid,
            cardComponentErrorKeys: errorKeys,
            cardValidationErrorMessage: state.cardValidationErrorMessage || '',
            securedFieldIframeCount: iframeCounts.securedFieldIframeCount,
            totalIframeCount: iframeCounts.totalIframeCount,
            mountNodeConnected: Boolean(mountNode && mountNode.isConnected),
            mountNodeParentIsContainer: Boolean(mountNode && container && mountNode.parentNode === container),
            componentAlive: Boolean(state.component && typeof state.component.createToken === 'function'),
            componentMounted: state.mounted
        };

        if (extra && typeof extra === 'object') {
            Object.assign(diagnostics, extra);
        }

        return diagnostics;
    }

    /**
     * Log submit-time card field diagnostics when advanced logging is enabled.
     *
     * @param {string} message
     * @param {string} checkpoint
     * @param {Object=} extra
     */
    function logSubmitCardFieldDiagnostics(message, checkpoint, extra) {
        debugLog(message, getSubmitCardFieldDiagnostics(checkpoint, extra));
    }

    /**
     * Log when checkout DOM/fragment behavior may have cleared card inputs during submit.
     *
     * @param {string} reason
     * @param {Object=} context
     */
    function logSubmitPaymentDomRiskDuringSubmit(reason, context) {
        if (!state.submitInProgress) {
            return;
        }
        debugLog('[ConvesioPay Classic] Payment DOM/input risk during submit', Object.assign({
            reason: reason || 'unspecified'
        }, getSubmitCardFieldDiagnostics('submit_dom_risk'), context || {}));
    }

    function getResolvedCardTokenizationError(tokenResult) {
        const error = tokenResult?.error;
        if (!error || typeof error !== 'object') return '';
        const message = typeof error.message === 'string' ? error.message : (typeof error.hint === 'string' ? error.hint : '');
        return message.trim() || 'Card authorization could not be created. Please review your card details and try again.';
    }

    /**
     * Resolve a user-facing message from a createToken() rejection.
     *
     * Only the SDK's `{ error: { message | hint } }` shape carries copy written for
     * the customer. Everything else (thrown Errors, transport failures) is internal
     * and must never reach the checkout notice, not even stringified.
     *
     * @param {*} tokenError
     * @returns {string}
     */
    function getCardTokenizationRejectionMessage(tokenError) {
        return getResolvedCardTokenizationError(tokenError)
            || getCardValidationErrorMessage(state.cardComponentErrors)
            || 'Card authorization could not be created. Please review your card details and try again.';
    }

    function handleCardComponentChange(event) {
        state.cardComponentValid = event?.isValid === true;
        state.cardComponentErrors = event?.errors || {};
        state.cardValidationErrorMessage = getCardValidationErrorMessage(state.cardComponentErrors);
        if (state.submitInProgress && event?.isValid !== true) {
            logSubmitCardFieldDiagnostics('[ConvesioPay Classic] Card component change during submit', 'submit_card_change_invalid', {
                isValid: event?.isValid === true
            });
        }
        if (!event?.isValid || !state.component) {
            return;
        }
        // A validated card change proves the secured card fields are configured
        // and functional. Some integrations (e.g. non-VGS "express") never surface
        // the onConfigSuccess or legacy-VGS-iframe readiness signals, which would
        // otherwise leave `cardSecuredFieldsReady` false forever — keeping the
        // Place Order button permanently disabled and deferring session refreshes
        // indefinitely. Treat a valid change as readiness so the button enables
        // and any pending session refresh runs.
        if (!state.cardSecuredFieldsReady) {
            markCardSecuredFieldsReady('card_component_valid_change');
        }
        updateSubmitButtonState();
    }


    /**
     * Whether a card change event carries evidence of real customer entry.
     * Initial SDK card events are often empty/invalid and must not suppress recovery.
     *
     * @param {*} value
     * @returns {boolean}
     */
    function hasNonEmptyNestedValue(value) {
        if (value === null || typeof value === 'undefined') {
            return false;
        }
        if (typeof value === 'string') {
            return value.trim() !== '';
        }
        if (typeof value === 'number') {
            return Number.isFinite(value);
        }
        if (typeof value === 'boolean') {
            return value === true;
        }
        if (Array.isArray(value)) {
            return value.some(hasNonEmptyNestedValue);
        }
        if (typeof value === 'object') {
            return Object.keys(value).some(function (key) {
                return hasNonEmptyNestedValue(value[key]);
            });
        }
        return false;
    }

    /**
     * Detect card payment method values that imply shopper-entered card data.
     * SDK bootstrap change events may contain static identifiers such as
     * `{ type: 'scheme' }`; those must not block readiness recovery.
     *
     * @param {Object} paymentMethod
     * @returns {boolean}
     */
    function hasMeaningfulCardPaymentMethodData(paymentMethod) {
        if (!paymentMethod || typeof paymentMethod !== 'object') {
            return false;
        }

        const staticKeys = {
            checkoutAttemptId: true,
            storedPaymentMethodId: true,
            type: true
        };

        return Object.keys(paymentMethod).some(function (key) {
            return !staticKeys[key] && hasNonEmptyNestedValue(paymentMethod[key]);
        });
    }

    /**
     * Detect meaningful card input from SDK change payloads.
     *
     * @param {Object} event
     * @returns {boolean}
     */
    function hasMeaningfulCardUserInteractionEvent(event) {
        if (event?.type !== 'card') {
            return false;
        }
        if (event?.isValid === true) {
            return true;
        }

        const cardData = event?.data?.paymentMethod || event?.paymentMethod || {};
        if (hasMeaningfulCardPaymentMethodData(cardData)) {
            return true;
        }

        return false;
    }

    /**
     * Mark recovery as unsafe because the shopper appears to be interacting with Card.
     *
     * @param {string=} source
     */
    function markCardUserInteractionStarted(source) {
        if (state.cardUserInteractionStarted) {
            return;
        }
        state.cardUserInteractionStarted = true;
        debugLog('[ConvesioPay Classic] Card user interaction detected', {
            source: source || 'unspecified',
            mountGeneration: state.mountGeneration,
            submitInProgress: state.submitInProgress
        });
    }

    /**
     * Bind DOM-level Card interaction guards because card iframes may report invalid
     * change events while a shopper is still typing.
     *
     * @param {number} mountGeneration
     * @param {Object} component
     */
    function bindCardUserInteractionGuards(mountGeneration, component) {
        const mountNode = getOrCreateMountNode();
        if (!mountNode || mountNode.dataset.cpayCardInteractionGeneration === String(mountGeneration)) {
            return;
        }
        mountNode.dataset.cpayCardInteractionGeneration = String(mountGeneration);

        const onCardInteraction = function (event) {
            if (!isCurrentMountContext(mountGeneration, component)) {
                return;
            }
            if (event?.isTrusted === false) {
                return;
            }
            const cardForm = mountNode.querySelector('.adyen-payment__new-card-form, [data-vgs-collect], .vgs-collect-form, [class*="adyen-checkout__card__"], [class*="adyen-checkout__secured"], .adyen-checkout__field, .adyen-checkout__input-wrapper');
            if (!cardForm || !event?.target || (event.target !== cardForm && !cardForm.contains(event.target))) {
                return;
            }
            markCardUserInteractionStarted('card_dom_interaction');
        };

        ['pointerdown', 'keydown', 'input'].forEach(function (eventName) {
            mountNode.addEventListener(eventName, onCardInteraction, { passive: true });
        });
    }

    /**
     * Handle Apple Pay successful authorization event.
     *
     * @param {Object} event
     */
    function handleApplePaySuccess(event) {
        if (!isApplePayEnabled()) {
            return;
        }

        const token = event?.token ?? event?.paymentData?.token ?? event?.data?.token ?? null;
        if (!token) {
            return;
        }

        const orderData = getOrderData(); // Get the order data.
        if (!orderData.isValid) {
            return;
        }

        state.paymentConfirmedData = {
            paymentId: null,
            status: 'authorized',
            paymentMethod: 'applepay',
            amount: event.paymentData?.amount || orderData.amount,
            currency: event.paymentData?.currency || orderData.currency,
            orderNumber: orderData.orderNumber,
            token: token
        };
        state.currentMethod = 'applepay'; // Update the current method in the state.
        state.btcSession = null;
        state.btcSessionSignature = '';
        storePaymentToken(token); // Store the payment token.
        addPaymentDataToForm(); // Add the payment data to the form.

        setTimeout(function () {
            autoClickPlaceOrderButton(); // Auto-click the place order button.
        }, 500);
    }

    /**
     * Handle Google Pay successful authorization event.
     *
     * @param {Object} event
     */
    function handleGooglePaySuccess(event) {
        if (!isGooglePayEnabled()) {
            return;
        }

        const token = event?.token ?? event?.paymentData?.token ?? event?.data?.token ?? null;
        if (!token) {
            return;
        }

        const orderData = getOrderData();
        if (!orderData.isValid) {
            return;
        }

        state.paymentConfirmedData = {
            paymentId: event?.paymentId ?? event?.paymentData?.paymentId ?? event?.id ?? null,
            status: String(event?.status || event?.paymentData?.status || 'authorized'),
            paymentMethod: 'googlepay',
            amount: event?.paymentData?.amount || event?.amount || orderData.amount,
            currency: event?.paymentData?.currency || event?.currency || orderData.currency,
            orderNumber: orderData.orderNumber,
            token: token
        };
        state.currentMethod = 'googlepay';
        state.btcSession = null;
        state.btcSessionSignature = '';
        storePaymentToken(token);
        window.convesiopayGooglePayPaymentData = state.paymentConfirmedData;
        addPaymentDataToForm();

        setTimeout(function () {
            autoClickPlaceOrderButton();
        }, 500);
    }

    /**
     * Main SDK change event dispatcher.
     *
     * @param {Object} event
     */
    function handleComponentChange(event, mountGeneration, component) {
        if (!isCurrentMountContext(mountGeneration, component)) {
            return;
        }

        updateSubmitButtonState(); // Update the submit button state.
        if (event?.type === 'card') {
            if (hasMeaningfulCardUserInteractionEvent(event)) {
                markCardUserInteractionStarted('card_component_change');
            }
            updateCardReadinessFromDom('card_component_change', mountGeneration, component);
        }
        if (event?.type === 'card' && shouldSuppressCardComponentChange()) {
            debugLog('[ConvesioPay Classic] Suppressed card component change due to explicit Apple Pay intent', {
                currentMethod: state.currentMethod,
                methodSwitchTarget: state.methodSwitchTarget,
                explicitMethodIntent: state.explicitMethodIntent,
                suppressUntil: state.suppressCardComponentChangeUntilMs
            });
            return;
        }

        if (
            event?.type &&
            CONFIG.allowedMethods.includes(event.type) &&
            isMethodEnabled(event.type) &&
            event.type !== state.currentMethod
        ) {
            const effectiveMethod = String(state.methodSwitchTarget || state.currentMethod || '').toLowerCase();
            const isCardBounceOverWallet = event.type === 'card' && (effectiveMethod === 'applepay' || effectiveMethod === 'googlepay');
            if (!isCardBounceOverWallet) {
                startInternalMethodSwitchFlow(event.type, 'component_change');
            }
        }

        if (event?.type === 'card') {
            handleCardComponentChange(event); // Handle the card component change.
        } else if (event?.type === 'applepay' && isApplePayEnabled() && event?.isSuccessful) {
            handleApplePaySuccess(event); // Handle the Apple Pay success.
        } else if (event?.type === 'googlepay' && isGooglePayEnabled() && event?.isSuccessful) {
            handleGooglePaySuccess(event);
        }
    }

    /**
     * Mount component and initialize in-component handlers.
     */
    async function mountComponent() {
        debugLog('[ConvesioPay Classic] Mounting Classic v2 component');
        let mountGeneration = 0;
        let component = null;
        try {
            // Attach the mount node to the container.
            const attached = attachMountNodeToContainer();

            // If the mount node is not attached, return.
            if (!attached) {
                return;
            }

            // Get the mount node.
            const mountNode = getOrCreateMountNode();

            // Do not inject custom loader text; rely on Woo/theme loader visuals.
            mountNode.innerHTML = '';
            mountGeneration = advanceMountGeneration('mount_component');
            resetCardReadinessState('mount_component');

            // Get the configuration.
            const config = getConfig();
            const apiKey = config.convesiopay_config?.apiKey || config.apiKey;
            const clientKey = config.convesiopay_config?.clientKey || config.clientKey;
            const integration = config.integration_name || config.integrationName;
            if (!apiKey || !integration) {
                mountNode.innerHTML = '<p style="color:red;">ConvesioPay configuration is missing.</p>';
                return;
            }

            // Create the ConvesioPay instance.
            const cpay = window.ConvesioPay(apiKey);

            // Get customer email (no fallback; only attach when we have one, like classic).
            const rawEmail = $('#billing_email').val();
            const customerEmail = rawEmail && String(rawEmail).trim() !== '' ? String(rawEmail).trim() : null;

            const componentConfig = {
                environment: config.convesiopay_config?.api_url?.includes('qa') ? 'test' : 'live',
                clientKey: clientKey,
                integration: integration,
                theme: config.checkout_theme || 'light',
                disabledPaymentMethods: getDisabledPaymentMethodsConfig(),
                onConfigSuccess: function (event) {
                    if (!component) {
                        return;
                    }
                    if (!isCurrentMountContext(mountGeneration, component)) {
                        return;
                    }
                    if (!handleCardConfigSuccess(event, mountGeneration, component)) {
                        scheduleCardReadinessMonitor('on_config_success', mountGeneration, component);
                    }
                }
            };
            if (customerEmail) {
                componentConfig.customerEmail = customerEmail;
            }

            // Create the component.
            component = cpay.component(componentConfig);

            // Set the component to the state before mount so same-tick config callbacks
            // can prove they belong to the active component.
            state.component = component;

            // Mount the component to the mount node.
            component.mount('#' + CONFIG.mountNodeId);

            // Bind the change event to the component.
            component.on('change', function (event) {
                handleComponentChange(event, mountGeneration, component);
            });
            bindCardUserInteractionGuards(mountGeneration, component);

            state.lastKnownCustomerEmail = customerEmail !== null ? customerEmail : '';

            // Set the mounted flag to true.
            state.mounted = true;
            debugLog('[ConvesioPay Classic] Component mounted', {
                environment: config.convesiopay_config?.api_url?.includes('qa') ? 'test' : 'live',
                integration: integration
            });
            scheduleCardReadinessMonitor('initial_mount', mountGeneration, component);

            // Bind internal method tab/accordion detection for reliable method switch sync.
            bindInternalMethodSelectionEvents();

            // Refresh the sessions.
            await refreshSessionsInPlace('initial_mount');

            if (!isCurrentMountContext(mountGeneration, component)) {
                return component;
            }

            // Update the submit button state.
            updateSubmitButtonState();

            // Return the component.
            return component;
        } catch (error) {
            console.warn('[ConvesioPay] Component mount failed. error: ' + error);
            if (!mountGeneration || isCurrentMountContext(mountGeneration, component)) {
                state.mounted = false;
                state.component = null;
            }
        }
    }

    /**
     * Ensure mounted component exists for current checkout container.
     */
    function ensureComponentMounted() {
        try {
            // If the unified gateway is not selected, do not mount the component.
            if (!isUnifiedGatewaySelected()) {
                return;
            }

            // If the ConvesioPay library is not loaded, wait for it to load and try again.
            if (!window.ConvesioPay) {
                setTimeout(ensureComponentMounted, 100);
                return;
            }

            // Get the container element.
            const container = document.getElementById(CONFIG.containerId);
            // If the container element is not found, do not mount the component.
            if (!container) {
                console.error(`[ConvesioPay Classic v2] #${CONFIG.containerId} Container not found`);
                return;
            }

            // If the component is already mounted, do not mount it again.
            if (state.mounted && state.component) {
                // Get the mount node.
                const mountNode = getOrCreateMountNode();

                // If the mount node is already in the container, do not mount it again.
                if (mountNode.parentNode === container) {
                    bindInternalMethodSelectionEvents();

                    // Refresh the sessions.
                    refreshSessionsInPlace('already_mounted_refresh');
                    return;
                }

                // Container changed (WC re-rendered and orphaned the mount node).
                // Do not move mounted iframe DOM between parents — remount cleanly.
                debugLog('[ConvesioPay Classic] Card component container orphaned; remounting cleanly', {
                    reason: 'component_container_changed',
                    containerId: CONFIG.containerId,
                    submitInProgress: state.submitInProgress,
                    mountGeneration: state.mountGeneration,
                    cardComponentValid: state.cardComponentValid,
                    hadMountNode: Boolean(state.mountNode)
                });
                logSubmitPaymentDomRiskDuringSubmit('component_container_orphaned_during_submit', {
                    reason: 'component_container_changed'
                });
                try {
                    if (typeof state.component.unmount === 'function') {
                        state.component.unmount();
                    }
                } catch (error) {
                    console.warn('[ConvesioPay] Component unmount failed during remount path. error: ' + error);
                }
                // Reset mount state.
                state.mounted = false;
                state.component = null;
                state.mountNode = null;
                // Reset session-primed flags so the new component gets fresh sessions.
                // Without this, refreshSessionsInPlace('initial_mount') skips session
                // creation because the old signatures still match, leaving the new
                // component without an Apple Pay / Google Pay session (stuck/unclickable).
                state.applePaySessionPrimed = false;
                state.applePaySessionSignature = '';
                state.googlePaySessionPrimed = false;
                state.googlePaySessionSignature = '';
                // Clear any active Google Pay UI refresh lock. Otherwise the new
                // component's initial_mount refresh would skip Google Pay session
                // creation while the lock is still ticking, leaving it unclickable.
                state.googlePayUiLockUntilMs = 0;

                advanceMountGeneration('component_container_changed');
                resetCardReadinessState('component_container_changed');
                state.cardReadinessRecoveryAttempted = false;
            }

            // Mount the component.
            mountComponent().catch((error) => {
                // Keep checkout operational even if mount fails.
                console.warn('[ConvesioPay] Component mount failed. error: ' + error);
            });
        } catch (error) {
            console.warn('[ConvesioPay] ensureComponentMounted failed. error: ' + error);
        }
    }

    /**
     * Unmount and clear transient unified component state.
     *
     * @param {string=} reason
     */
    function resetMountedComponentState(reason) {
        advanceMountGeneration(reason || 'component_reset');
        try {
            if (state.component && typeof state.component.unmount === 'function') {
                state.component.unmount();
            }
        } catch (error) {
            console.warn('[ConvesioPay] Component unmount failed during cleanup. error: ' + error);
        }
        state.component = null;
        state.mounted = false;
        state.mountNode = null;
        resetCardReadinessState(reason || 'component_reset');
        if (reason !== 'card_secured_fields_unready') {
            state.cardReadinessRecoveryAttempted = false;
        }
        state.paymentConfirmedData = null;
        state.cardComponentValid = false;
        state.cardComponentErrors = {};
        state.cardValidationErrorMessage = '';
        state.btcSession = null;
        state.btcSessionSignature = '';
        state.applePaySessionPrimed = false;
        state.applePaySessionSignature = '';
        state.googlePaySessionPrimed = false;
        state.googlePaySessionSignature = '';
        state.googlePayUiLockUntilMs = 0;
        window.convesiopayPaymentToken = null;
        window.convesiopayApplePayPaymentData = null;
        window.convesiopayGooglePayPaymentData = null;
        if (reason) {
            debugLog('[ConvesioPay Classic] Mounted component state reset', {
                reason: reason
            });
        }
    }

    /**
     * Trigger Woo submit handoff after external method confirmation.
     * Uses the same guarded async preflight path as manual submit.
     */
    function autoClickPlaceOrderButton() {
        if (!state.paymentConfirmedData || String(state.paymentConfirmedData.paymentMethod || '').toLowerCase() === 'card') return;
        runSubmitPreflightFlow('auto_click_after_confirmation');
    }

    /**
     * Derive an internal reason code from a thrown submit-preflight failure.
     *
     * Rejection values are not always Errors (the payment SDK rejects with plain
     * objects), so they must never be stringified into a reason code.
     *
     * @param {*} error
     * @returns {string}
     */
    function getSubmitPreflightReasonCode(error) {
        if (typeof error === 'string' && error.trim()) {
            return error.trim();
        }
        const message = typeof error?.message === 'string' ? error.message.trim() : '';
        return message || 'unknown_error';
    }

    /**
     * Map internal submit-preflight reason to a user-visible checkout message.
     *
     * @param {string} reason
     * @returns {string}
     */
    function getSubmitPreflightErrorMessage(reason) {
        const code = String(reason || '').toLowerCase();
        const messageMap = {
            method_switch_in_progress: 'Payment method update is still in progress. Please wait a moment and try again.',
            runtime_amount_update_failed: 'Checkout total is still updating. Please wait a moment and try again.',
            card_token_missing: 'Card authorization is not ready. Please check card details and try again.',
            card_token_timeout: 'Card authorization timed out. Please try again.',
            payment_not_confirmed: 'Payment authorization is not ready. Please try again.',
            invalid_order_data: 'Checkout data is incomplete. Please review your billing details and try again.',
            checkout_form_not_found: 'Checkout form is not available. Please refresh and try again.',
            checkout_form_invalid: 'Please complete all required checkout fields before placing your order.',
            card_component_invalid: state.cardValidationErrorMessage || 'Card authorization is not ready. Please check card details and try again.',
            card_tokenization_error: state.cardValidationErrorMessage || 'Card authorization could not be created. Please review your card details and try again.',
            checkout_form_submit_unavailable: 'Checkout submission is temporarily unavailable. Please refresh and try again.'
        };
        if (messageMap[code]) {
            return messageMap[code];
        }
        // Unmapped reasons are internal codes or raw SDK/runtime failures, never
        // safe to render verbatim in the checkout notice.
        return 'We could not process your payment. Please try again.';
    }

    /**
     * Show a standard Woo checkout error notice.
     *
     * @param {string} message
     * @returns {void}
     */
    function showCheckoutErrorNotice(message) {
        const $form = getCheckoutForm();
        if (!$form.length) {
            return;
        }
        const safeMessage = $('<div>').text(String(message || '')).html();
        const noticeHtml = '<div class="woocommerce-NoticeGroup woocommerce-NoticeGroup-checkout convesiopay-checkout-notice"><ul class="woocommerce-error" role="alert"><li>' + safeMessage + '</li></ul></div>';
        $form.find('.convesiopay-checkout-notice').remove();
        $form.find('.woocommerce-NoticeGroup-checkout, .woocommerce-error').first().remove();
        $form.prepend(noticeHtml);
        try {
            $('html, body').animate({ scrollTop: Math.max($form.offset().top - 120, 0) }, 220);
        } catch (_error) {
            // UX guard only.
        }
    }

    /**
     * Perform strictly sequential submit preflight and handoff to Woo submit.
     *
     * Order is guaranteed:
     * runtime amount update -> payment data readiness -> hidden data injection -> Woo submit.
     *
     * @param {string=} source
     * @returns {Promise<boolean>}
     */
    async function runSubmitPreflightFlow(source) {
        if (!isUnifiedGatewaySelected()) {
            return true;
        }

        // If the submit is already in progress, return false.
        if (state.submitInProgress) {
            return false;
        }

        // Set the submit in progress flag to true.
        state.submitInProgress = true;
        setCheckoutProcessingOverlay(true, source || 'submit_preflight');
        logSubmitCardFieldDiagnostics('[ConvesioPay Classic] Submit preflight started', 'submit_preflight_started', {
            source: source || 'submit_preflight',
            method: resolveMethod()
        });

        try {
            // If the method switch is in progress, throw an error.
            if (state.methodSwitchInProgress) {
                throw new Error('method_switch_in_progress');
            }

            // If the component is mounted and the update amount function exists, apply the runtime amount update.
            if (state.component && typeof state.component.updateAmount === 'function') {
                const runtimeUpdate = await applyRuntimeAmountUpdate('submit_preflight', true);
                logSubmitCardFieldDiagnostics('[ConvesioPay Classic] Submit preflight after updateAmount', 'submit_preflight_after_updateAmount', {
                    source: source || 'submit_preflight',
                    runtimeUpdateSkipped: runtimeUpdate.skipped,
                    runtimeUpdateOk: runtimeUpdate.ok,
                    runtimeUpdateSupported: runtimeUpdate.supported
                });
                if (runtimeUpdate.supported && !runtimeUpdate.ok) {
                    throw new Error('runtime_amount_update_failed');
                }
            }

            const currentMethod = resolveMethod();
            const orderData = getOrderData();
            if (!orderData.isValid) {
                throw new Error('invalid_order_data');
            }

            if (
                currentMethod === 'card' &&
                String(state.paymentConfirmedData?.paymentMethod || '').toLowerCase() === 'card' &&
                !isMatchingCardPaymentContext(state.paymentConfirmedData, orderData)
            ) {
                clearStaleCardPaymentToken('submit_preflight_card_context_mismatch', orderData);
            }

            if (!state.paymentConfirmedData) {
                if (currentMethod === 'card') {
                    if (!state.component) {
                        debugLog('[ConvesioPay Classic] Blocking card tokenization: component invalid', {
                            source: source || 'submit_preflight',
                            amount: orderData.amount,
                            currency: orderData.currency,
                            errors: state.cardComponentErrors
                        });
                        throw new Error('card_component_invalid');
                    }

                    // The mounted component's own createToken() result/error is authoritative;
                    // do not gate on the locally cached state.cardComponentValid flag.
                    const reusableToken = getReusableCardToken(orderData);
                    logSubmitCardFieldDiagnostics('[ConvesioPay Classic] Submit preflight immediately before createToken', 'submit_preflight_pre_createToken', {
                        source: source || 'submit_preflight',
                        amount: orderData.amount,
                        currency: orderData.currency,
                        hasReusableToken: Boolean(reusableToken.token)
                    });
                    let tokenAttemptSettled = false;
                    const token = await Promise.race([
                            Promise.resolve().then(function () {
                                // Create the card token.
                                return state.component.createToken({
                                    amount: orderData.amount,
                                    currency: orderData.currency
                                });
                            }).catch(function (tokenError) {
                                // createToken() runs a microtask later than this attempt started,
                                // so a remount can tear the component down in between. That is a
                                // component failure, not a problem with the customer's card.
                                if (!state.component || typeof state.component.createToken !== 'function') {
                                    throw new Error('card_component_invalid');
                                }
                                const message = getCardTokenizationRejectionMessage(tokenError);
                                debugLog('[ConvesioPay Classic] Card tokenization rejected', Object.assign({
                                    source: source || 'submit_preflight',
                                    errorType: String(tokenError?.error?.type || 'unknown'),
                                    settled: tokenAttemptSettled,
                                    message: message
                                }, getSubmitCardFieldDiagnostics('submit_tokenization_rejected')));
                                // A rejection that lost the timeout race must not overwrite the
                                // notice the customer is already reading.
                                if (!tokenAttemptSettled) {
                                    state.cardValidationErrorMessage = message;
                                }
                                throw new Error('card_tokenization_error');
                            }),
                            new Promise(function (_resolve, reject) {
                                setTimeout(function () {
                                    reject(new Error('card_token_timeout'));
                                }, 10000);
                            })
                        ]).finally(function () {
                            tokenAttemptSettled = true;
                        });
                    debugLog('[ConvesioPay Classic] Submit preflight card token fallback resolved', {
                        source: source || 'submit_preflight',
                        amount: orderData.amount,
                        currency: orderData.currency,
                        tokenSource: reusableToken.source || 'createToken',
                        usedExistingToken: Boolean(reusableToken.token),
                        hasToken: Boolean(token),
                        tokenPrefix: String(token || '').trim().substring(0, 8),
                        tokenLength: String(token || '').trim().length
                    });
                    const tokenizationError = getResolvedCardTokenizationError(token);
                    if (tokenizationError) {
                        state.cardValidationErrorMessage = tokenizationError;
                        throw new Error('card_tokenization_error');
                    }
                    if (typeof token !== 'string' || !token.trim()) {
                        throw new Error('card_token_missing');
                    }
                    state.paymentConfirmedData = {
                        paymentId: 'card_' + Date.now(),
                        status: 'succeeded',
                        paymentMethod: 'card',
                        amount: orderData.amount,
                        currency: orderData.currency,
                        orderNumber: orderData.orderNumber,
                        token: token,
                        createdAt: Date.now()
                    };
                    state.currentMethod = 'card';

                    state.cardTokenLifecycle = 'fresh';
                } else {
                    throw new Error('payment_not_confirmed');
                }
            }

            // Add the payment data to the form.
            addPaymentDataToForm();

            // Get the form element.
            const formEl = getCheckoutForm().get(0);

            // If the form element is not found, throw an error.
            if (!formEl) {
                throw new Error('checkout_form_not_found');
            }

            // If the form element is not valid, throw an error.
            if (typeof formEl.reportValidity === 'function' && !formEl.reportValidity()) {
                throw new Error('checkout_form_invalid');
            }

            consumeCardTokenAtHandoff();

            // Allow Woo's submit to run: when we trigger('submit') below, Woo may re-fire checkout_place_order.
            // Allow exactly those two native passes, then block any further clicks.
            state.allowNativeSubmitOnce = true;
            state.nativeSubmitBypassCount = 2;
            setCheckoutProcessingOverlay(false, 'submit_handoff');
            // Woo-standard: keep Place Order disabled until redirect. Re-enable only on error (catch / releaseSubmitLockIfActive).
            $(formEl).trigger('submit');

            state.lastSubmitPreflightError = '';
            window.convesiopayClassicLastSubmitPreflightError = '';

            // Keep submit lock active during native handoff to block multi-click submissions.
            // If Woo submit pipeline does not progress, this timer safely releases the lock.
            if (state.timers.nativeSubmitHandoff) {
                clearTimeout(state.timers.nativeSubmitHandoff);
            }
            state.timers.nativeSubmitHandoff = setTimeout(function () {
                if (!state.submitInProgress) {
                    return;
                }

                // The server may still own an unresolved Classic attempt. Do not turn
                // a timer into permission for another submit; a definitive checkout
                // response is the only path that can release this advisory lock.
                debugLog('[ConvesioPay Classic] Native submit handoff remains unresolved');
            }, 8000);

            return true;
        } catch (error) {
            const reason = getSubmitPreflightReasonCode(error);
            state.lastSubmitPreflightError = reason;
            window.convesiopayClassicLastSubmitPreflightError = reason;
            debugLog('[ConvesioPay Classic] Submit preflight failed', {
                source: source || 'submit_preflight',
                reason: reason
            });
            debugLog('[ConvesioPay Classic] Submit preflight reason code', {
                reasonCode: reason,
                method: resolveMethod(),
                source: source || 'submit_preflight'
            });
            state.submitInProgress = false;
            state.allowNativeSubmitOnce = false;
            state.nativeSubmitBypassCount = 0;
            if (state.timers.nativeSubmitHandoff) {
                clearTimeout(state.timers.nativeSubmitHandoff);
                state.timers.nativeSubmitHandoff = null;
            }
            setCheckoutProcessingOverlay(false, 'submit_preflight_error');

            // Woo-standard: re-enable Place Order on error so the user can fix and try again.
            updateSubmitButtonState();

            // Show the checkout error notice.
            showCheckoutErrorNotice(getSubmitPreflightErrorMessage(reason));
            return false;
        }
    }

    /**
     * Release submit re-entry lock when Woo keeps user on checkout.
     *
     * @param {string=} reason
     */
    function releaseSubmitLockIfActive(reason) {
        if (!state.submitInProgress && !state.allowNativeSubmitOnce && !state.submitOverlayLocked) {
            return;
        }
        debugLog('[ConvesioPay Classic] Releasing submit lock', {
            reason: reason || 'unspecified',
            submitInProgress: state.submitInProgress,
            allowNativeSubmitOnce: state.allowNativeSubmitOnce
        });
        state.submitInProgress = false;
        state.allowNativeSubmitOnce = false;
        state.nativeSubmitBypassCount = 0;
        if (state.timers.nativeSubmitHandoff) {
            clearTimeout(state.timers.nativeSubmitHandoff);
            state.timers.nativeSubmitHandoff = null;
        }

        // Set the checkout processing overlay to false.
        setCheckoutProcessingOverlay(false, reason || 'submit_lock_release');

        // Update the submit button state.
        updateSubmitButtonState();
    }

    /**
     * Synchronous checkout event gate for unified flow.
     * Delegates all async submit work to runSubmitPreflightFlow().
     *
     * @param {Event} event
     * @returns {boolean}
     */
    function handleCheckoutSubmission(event) {
        if (!isUnifiedGatewaySelected()) {
            return true;
        }
        if (state.allowNativeSubmitOnce && state.nativeSubmitBypassCount > 0) {
            state.nativeSubmitBypassCount -= 1;
            if (state.nativeSubmitBypassCount <= 0) {
                state.allowNativeSubmitOnce = false;
                state.nativeSubmitBypassCount = 0;
            }
            return true;
        }
        if (state.submitInProgress) {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }
            if (event && typeof event.stopPropagation === 'function') {
                event.stopPropagation();
            }
            if (event && typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            return false;
        }

        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        if (event && typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        if (event && typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }

        // Woo-standard: disable Place Order immediately on first click to prevent double-submit and show processing state.
        disableSubmitButton();

        // Run the submit preflight flow.
        runSubmitPreflightFlow('checkout_submit_event');
        return false;
    }

    /**
     * Keep basic method + fee mirror state aligned with current selection.
     */
    function reconcileMethodAndMirror() {
        if (!isUnifiedGatewaySelected()) {
            return;
        }
        const method = resolveMethod(); // Get the current selected method inside the cpay unified [card, applepay, btcpay]
        state.currentMethod = method; // Update the current method in the state.
        setSelectedMethodField(method); // Set the selected method field in the form.
        syncMethodIfChanged(method); // Sync the method if changed.
        mirrorServerTotals(); // Mirror the server totals.
        updateSubmitButtonState(); // Update the submit button state.
    }

    /**
     * Compute customer signature used for debounced context refresh checks.
     *
     * @returns {string}
     */
    function getCustomerSignature() {
        const email = String($('#billing_email').val() || '').trim().toLowerCase();
        const first = String($('#billing_first_name').val() || '').trim();
        const last = String($('#billing_last_name').val() || '').trim();
        return [email, first, last].join('|');
    }

    /**
     * Detect Woo update_order_review AJAX requests.
     *
     * @param {Object=} settings jQuery ajax settings
     * @returns {boolean}
     */
    function isUpdateOrderReviewAjaxRequest(settings) {
        if (!settings) {
            return false;
        }
        const url = String(settings.url || '');
        if (url.indexOf('update_order_review') !== -1) {
            return true;
        }
        const data = settings.data;
        if (typeof data === 'string' && data.indexOf('update_order_review') !== -1) {
            return true;
        }
        return false;
    }

    /**
     * Parse checkout fragment map from update_order_review XHR.
     *
     * @param {XMLHttpRequest} xhr
     * @returns {Object|null}
     */
    function parseCheckoutFragmentsFromXhr(xhr) {
        if (!xhr) {
            return null;
        }
        let parsed = xhr.responseJSON;
        if (!parsed && xhr.responseText) {
            try {
                parsed = JSON.parse(xhr.responseText);
            } catch (error) {
                return null;
            }
        }
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        if (parsed.fragments && typeof parsed.fragments === 'object') {
            return parsed.fragments;
        }
        return parsed;
    }

    /**
     * Log whether PHP payment-fragment preservation was applied on update_order_review.
     *
     * @param {XMLHttpRequest} xhr
     */
    function logCheckoutFragmentPreservationFromXhr(xhr) {
        if (!isAdvancedLoggingEnabled()) {
            return;
        }
        const fragments = parseCheckoutFragmentsFromXhr(xhr);
        if (!fragments) {
            debugLog('[ConvesioPay Classic] update_order_review response had no parseable fragments');
            return;
        }
        const fragmentKeys = Object.keys(fragments);
        const fullPaymentKey = '.woocommerce-checkout-payment';
        const placeOrderKey = '.woocommerce-checkout-payment .form-row.place-order';
        const hasFullPaymentFragment = Object.prototype.hasOwnProperty.call(fragments, fullPaymentKey);
        const hasPlaceOrderFragment = Object.prototype.hasOwnProperty.call(fragments, placeOrderKey);
        const unifiedSelectedInDom = isUnifiedGatewaySelected();
        const preservationApplied = unifiedSelectedInDom && !hasFullPaymentFragment && hasPlaceOrderFragment;
        const paymentRelatedKeys = fragmentKeys.filter(function (key) {
            return key.indexOf('checkout-payment') !== -1 || key.indexOf('place-order') !== -1;
        });
        debugLog('[ConvesioPay Classic] update_order_review fragment preservation', {
            unifiedSelectedInDom: unifiedSelectedInDom,
            hasFullPaymentFragment: hasFullPaymentFragment,
            hasPlaceOrderFragment: hasPlaceOrderFragment,
            preservationApplied: preservationApplied,
            preservationSkipped: unifiedSelectedInDom && hasFullPaymentFragment,
            paymentRelatedFragmentKeys: paymentRelatedKeys,
            fragmentKeyCount: fragmentKeys.length,
            submitInProgress: state.submitInProgress
        });
        if (state.submitInProgress && unifiedSelectedInDom && hasFullPaymentFragment) {
            logSubmitPaymentDomRiskDuringSubmit('fragment_preservation_skipped_during_submit', {
                hasFullPaymentFragment: hasFullPaymentFragment,
                hasPlaceOrderFragment: hasPlaceOrderFragment,
                preservationApplied: preservationApplied
            });
        }
    }

    /**
     * Snapshot payment container/mount nodes before Woo replaces checkout fragments.
     */
    function snapshotPaymentDomBeforeCheckoutUpdate() {
        if (!isAdvancedLoggingEnabled()) {
            return;
        }
        const container = document.getElementById(CONFIG.containerId);
        const mountNode = state.mountNode || document.getElementById(CONFIG.mountNodeId);
        paymentDomSnapshotForDiagnostics = {
            containerNode: container || null,
            mountNode: mountNode || null,
            hadContainer: Boolean(container),
            hadMountNode: Boolean(mountNode),
            mountGeneration: state.mountGeneration
        };
        debugLog('[ConvesioPay Classic] update_checkout (before fragment replace)', {
            hadContainer: paymentDomSnapshotForDiagnostics.hadContainer,
            hadMountNode: paymentDomSnapshotForDiagnostics.hadMountNode,
            unifiedSelectedInDom: isUnifiedGatewaySelected(),
            mountGeneration: state.mountGeneration,
            submitInProgress: state.submitInProgress
        });
    }

    /**
     * Compare payment DOM node identity after updated_checkout.
     */
    function logPaymentDomPreservationAfterCheckoutUpdate() {
        if (!isAdvancedLoggingEnabled()) {
            paymentDomSnapshotForDiagnostics = null;
            return;
        }
        const snapshot = paymentDomSnapshotForDiagnostics;
        paymentDomSnapshotForDiagnostics = null;
        if (!snapshot) {
            return;
        }
        const container = document.getElementById(CONFIG.containerId);
        const mountNode = state.mountNode || document.getElementById(CONFIG.mountNodeId);
        const continuity = {
            containerSameNode: Boolean(snapshot.containerNode && snapshot.containerNode === container),
            containerStillInDocument: Boolean(snapshot.containerNode && document.contains(snapshot.containerNode)),
            mountNodeSameNode: Boolean(snapshot.mountNode && snapshot.mountNode === mountNode),
            mountNodeParentIsContainer: Boolean(mountNode && container && mountNode.parentNode === container),
            mountGenerationBefore: snapshot.mountGeneration,
            mountGenerationAfter: state.mountGeneration,
            mountGenerationChanged: snapshot.mountGeneration !== state.mountGeneration,
            unifiedSelectedInDom: isUnifiedGatewaySelected(),
            submitInProgress: state.submitInProgress
        };
        debugLog('[ConvesioPay Classic] updated_checkout payment DOM continuity', continuity);
        if (
            state.submitInProgress &&
            (continuity.mountGenerationChanged || !continuity.containerSameNode || !continuity.mountNodeSameNode)
        ) {
            logSubmitPaymentDomRiskDuringSubmit('updated_checkout_dom_continuity_break', continuity);
        }
    }

    /**
     * Bind advanced-logging diagnostics for checkout fragment preservation.
     */
    function bindCheckoutFragmentDiagnostics() {
        $(document.body)
            .off('update_checkout.convesiopayClassicFragmentDiag')
            .on('update_checkout.convesiopayClassicFragmentDiag', function () {
                snapshotPaymentDomBeforeCheckoutUpdate();
            });

        $(document)
            .off('ajaxSuccess.convesiopayClassicFragmentDiag')
            .on('ajaxSuccess.convesiopayClassicFragmentDiag', function (_event, xhr, settings) {
                if (!isUpdateOrderReviewAjaxRequest(settings)) {
                    return;
                }
                logCheckoutFragmentPreservationFromXhr(xhr);
            });
    }

    /**
     * Unified updated_checkout orchestrator.
     */
    function onUpdatedCheckout() {
        clearPaymentOverlay(); // Clear the payment overlay.
        setTimeout(clearPaymentOverlay, CONFIG.overlayClearFastMs);
        setTimeout(clearPaymentOverlay, CONFIG.overlayClearSlowMs);
        if (!isUnifiedGatewaySelected()) {
            if (!state.timers.gatewayDeselectionRecheck) {
                state.timers.gatewayDeselectionRecheck = setTimeout(function () {
                    state.timers.gatewayDeselectionRecheck = null;
                    if (!isUnifiedGatewaySelected()) {
                        resetMountedComponentState('updated_checkout_gateway_deselected');
                    }
                }, CONFIG.gatewayDeselectionRecheckMs);
            }
            logPaymentDomPreservationAfterCheckoutUpdate();
            return;
        }
        if (state.timers.gatewayDeselectionRecheck) {
            clearTimeout(state.timers.gatewayDeselectionRecheck);
            state.timers.gatewayDeselectionRecheck = null;
        }
        ensureComponentMounted();
        reconcileMethodAndMirror(); // Keep the method and fee mirror state aligned with current selection.

        const orderData = getOrderData();
        const total = orderData.amount; // Get the current cart total.
        const amountCurrencySignature = getAmountCurrencySignature(orderData);
        debugLog('[ConvesioPay Classic] updated_checkout orchestrator', {
            total: total,
            lastKnownTotal: state.lastKnownCartTotal,
            amountCurrencySignature: amountCurrencySignature,
            lastKnownAmountCurrencySignature: state.lastKnownAmountCurrencySignature,
            amountSignatureChanged: Boolean(
                amountCurrencySignature &&
                amountCurrencySignature !== state.lastKnownAmountCurrencySignature
            ),
            method: resolveMethod(),
            submitInProgress: state.submitInProgress,
            mountGeneration: state.mountGeneration
        });
        if (
            amountCurrencySignature &&
            amountCurrencySignature !== state.lastKnownAmountCurrencySignature
        ) {
            state.lastKnownCartTotal = total; // Update the last known cart total.
            clearStaleCardPaymentToken('updated_checkout_amount_currency_change', orderData);
            clearApplePayAuthorizationIfSet('updated_checkout_amount_currency_change', amountCurrencySignature);
            clearGooglePayAuthorizationIfSet('updated_checkout_amount_currency_change', amountCurrencySignature);
            if (orderData.isValid) {
                refreshSessionsInPlace('updated_checkout_amount_currency_change'); // Refresh/update runtime amount in place.
            } else {
                state.lastKnownAmountCurrencySignature = amountCurrencySignature;
                state.applePaySessionPrimed = false;
                state.applePaySessionSignature = '';
                state.googlePaySessionPrimed = false;
                state.googlePaySessionSignature = '';
                state.btcSession = null;
                state.btcSessionSignature = '';
                debugLog('[ConvesioPay Classic] Invalidated payment sessions for zero/invalid checkout total', {
                    reason: 'updated_checkout_amount_currency_change',
                    amount: orderData.amount,
                    currency: orderData.currency,
                    signature: amountCurrencySignature
                });
            }
        }

        if (state.methodSwitchInProgress) {
            const targetMethod = state.methodSwitchTarget;
            if (targetMethod === 'applepay' || targetMethod === 'googlepay' || targetMethod === 'btcpay') {
                refreshSessionsInPlace('method_switch_finalize_' + targetMethod).finally(function () {
                    maybeCompleteMethodSwitch('updated_checkout_finalize_' + targetMethod);
                });
            } else {
                maybeCompleteMethodSwitch('updated_checkout_finalize_card');
            }
        }

        logPaymentDomPreservationAfterCheckoutUpdate();
    }

    /**
     * Determine whether Woo's response definitively permits one fresh customer retry.
     * Unknown, pending, and malformed errors deliberately keep the in-flight lock.
     *
     * @param {*} errorMessage
     * @returns {boolean}
     */
    function isDefinitivelyRetryableCheckoutError(errorMessage) {
        if (hasDeclinedNoChargeNotice(errorMessage)) return true;
        const normalizedMessage = String(getCheckoutErrorText(errorMessage) || '');

        return Boolean(
            getRetryableCardTokenInvalidationReason(errorMessage)
            || (
                normalizedMessage.indexOf('ConvesioPay') !== -1
                && /\b(Refused|Blocked)\b/i.test(normalizedMessage)
            )
        );
    }

    function handleCheckoutError(errorMessage) {
        resetCardTokenLifecycle('checkout_error', true);
        const tokenInvalidationReason = getRetryableCardTokenInvalidationReason(errorMessage);
        if (tokenInvalidationReason) {
            clearCardPaymentTokenAfterInvalidRequest(tokenInvalidationReason);
            replaceRetryableCardTokenNotice(errorMessage);
        }
        if (isDefinitivelyRetryableCheckoutError(errorMessage)) {
            // This only restores the button for an explicit new customer action.
            // It never triggers another submit.
            releaseSubmitLockIfActive('checkout_error_definitively_retryable');
        }
    }

    /**
     * Register Woo checkout event handlers once.
     */
    function bindCheckoutEvents() {
        bindOverlayCleanupGuards();
        bindCheckoutFragmentDiagnostics();

        // Bind the change event to the payment method selector. E.g When the user changes the payment method.
        $(document.body)
            .off('change.convesiopayClassicGateway', CONFIG.paymentMethodSelector)
            .on('change.convesiopayClassicGateway', CONFIG.paymentMethodSelector, function () {
                const selected = $(this).val();
                if (selected === CONFIG.gatewayId) {
                    reconcileMethodAndMirror(); // Keep the method and fee mirror state aligned with current selection.
                    setTimeout(function () {
                        ensureComponentMounted(); // Ensure the component is mounted after Woo updates the payment box.
                    }, 0);
                } else {
                    resetMountedComponentState('payment_method_change_gateway_deselected');
                }
                setTimeout(clearPaymentOverlay, CONFIG.overlayClearFastMs);
                setTimeout(clearPaymentOverlay, CONFIG.overlayClearSlowMs);
            });

        // Bind the updated_checkout event to the checkout form. E.g When the user updates the checkout form.
        $(document.body)
            .off('updated_checkout.convesiopayClassic')
            .on('updated_checkout.convesiopayClassic', function () {
                onUpdatedCheckout(); // Trigger the updated checkout event.
            });

        $(document.body)
            .off('checkout_error.convesiopayClassic')
            .on('checkout_error.convesiopayClassic', function (_event, errorMessage) {
                handleCheckoutError(errorMessage);
            });

        // Bind the input event to the billing email, first name, and last name. E.g When the user updates the billing email, first name, or last name.
        $(document)
            .off('input.convesiopayClassicContext change.convesiopayClassicContext', '#billing_email, #billing_first_name, #billing_last_name')
            .on('input.convesiopayClassicContext change.convesiopayClassicContext', '#billing_email, #billing_first_name, #billing_last_name', function () {
                if (state.timers.customerContext) {
                    clearTimeout(state.timers.customerContext);
                }
                state.timers.customerContext = setTimeout(function () {
                    const signature = getCustomerSignature();
                    if (!signature || signature === state.lastCustomerSignature) {
                        return;
                    }
                    state.lastCustomerSignature = signature;
                    // Update component email only when billing email has changed (no-op if only name changed).
                    applyRuntimeEmailUpdate();
                    reconcileMethodAndMirror(); // Keep the method and fee mirror state aligned with current selection.
                    refreshSessionsInPlace('customer_context_change'); // Refresh the sessions in place.
                }, CONFIG.customerContextDebounceMs);
            });

        /**
         * Bind WooCommerce checkout submission events.
         *
         * Woo triggers two possible JS events when the user clicks "Place order":
         *
         * 1. checkout_place_order_{gateway_id}
         *    → Fired only when this specific payment gateway is selected.
         *
         * 2. checkout_place_order
         *    → Generic event fired for all gateways.
         *
         * We bind to BOTH events for maximum compatibility because:
         * - Some themes/plugins only trigger the generic event.
         * - Some Woo flows trigger the gateway-specific event.
         * - AJAX reloads can behave inconsistently across environments.
         *
         * Both events route to the same handler (handleCheckoutSubmission),
         * which contains internal guards to prevent duplicate processing.
         *
         * The `.off()` call ensures we remove any previously attached handlers
         * (important because Woo checkout reloads via AJAX and could otherwise
         * stack duplicate listeners).
         */
        const $checkoutForm = getCheckoutForm();
        if ($checkoutForm.is('form.checkout')) {
            $checkoutForm
                .off('checkout_place_order_' + CONFIG.gatewayId + '.convesiopayClassic')
                .on('checkout_place_order_' + CONFIG.gatewayId + '.convesiopayClassic', handleCheckoutSubmission);

            $checkoutForm
                .off('checkout_place_order.convesiopayClassic')
                .on('checkout_place_order.convesiopayClassic', handleCheckoutSubmission);
        }

        // order-pay path does not consistently fire checkout_place_order hooks.
        // Bind native submit so preflight + hidden field injection still run.
        $(document)
            .off('submit.convesiopayClassic', 'form.checkout, form#order_review')
            .on('submit.convesiopayClassic', 'form.checkout, form#order_review', handleCheckoutSubmission);

        // A bfcache restore is not a server outcome. Refresh display state only; never
        // auto-submit or clear an unresolved lock that may still represent server ownership.
        $(window)
            .off('pageshow.convesiopayClassic')
            .on('pageshow.convesiopayClassic', function (event) {
                if (event.originalEvent && event.originalEvent.persisted) {
                    resetCardTokenLifecycle('pageshow_bfcache', true);
                    onUpdatedCheckout();
                }
            });

    }

    // Add CSS to hide payment method label when it's the only payment method
    function addClassicCheckoutStyles() {
        const styleId = 'convesiopay-unified-classic-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* Hide payment method label when ConvesioPay is the only payment method */
                ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified:only-child > label {
                    display: none !important;
                }
                /* Remove padding when it's the only payment method */
                ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified:only-child .payment_box {
                    padding: 0 !important;
                    margin: 0 !important;
                }

                /* Fixed Card Holder Name Input height and border */
                ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified input[name='holderName'] {
                    min-height: auto !important;
                    border: none !important;
                }

                /* Fixed Card Holder Name Input Margin */
                #payment ul li input[type=text][name='holderName'] {
                    margin: 0 !important;
                }

                /* Fixed Adyen Checkbox label display */
                ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified .adyen-checkout__store-details .adyen-checkout__checkbox::before {
                    display: block !important;
                }

                /* Keep ConvesioPay SDK OTP inputs from inheriting broad checkout text input styles. */
                #payment ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified #convesiopay-persistent-sdk-mount #convesiopay-checkout .two-factor-auth-section .code-input.verification-code-input {
                    display: flex !important;
                    flex-direction: row !important;
                    justify-content: center !important;
                    flex-wrap: nowrap !important;
                    gap: 8px !important;
                }

                #payment ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified #convesiopay-persistent-sdk-mount #convesiopay-checkout .two-factor-auth-section .code-input.verification-code-input input.code-input__digit[type="text"] {
                    width: 48px !important;
                    min-width: 48px !important;
                    max-width: 48px !important;
                    height: 48px !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    box-sizing: border-box !important;
                    text-align: center !important;
                    flex: 0 0 48px !important;
                }

                @media (max-width: 400px) {
                    #payment ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified #convesiopay-persistent-sdk-mount #convesiopay-checkout .two-factor-auth-section .code-input.verification-code-input {
                        gap: 6px !important;
                    }

                    #payment ul.wc_payment_methods li.payment_method_peachpay_convesiopay_unified #convesiopay-persistent-sdk-mount #convesiopay-checkout .two-factor-auth-section .code-input.verification-code-input input.code-input__digit[type="text"] {
                        width: 40px !important;
                        min-width: 40px !important;
                        max-width: 40px !important;
                        height: 40px !important;
                        flex: 0 0 40px !important;
                    }
                }

                /*
                #convesiopay-unified-payment-container .loading-input__spinner {
                    display: none !important;
                }
                */
                #convesiopay-unified-payment-container.loading-in-progress {
                    min-height: 300px !important;
                    min-width: 100% !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                }

                #convesiopay-unified-payment-container.loading-in-progress .adyen-checkout,
                #convesiopay-unified-payment-container.loading-in-progress [class*="adyen-checkout"] {
                    min-height: 280px !important;
                    min-width: 100% !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * Initialize refactor architecture.
     * Safe to call multiple times; binding is namespaced and idempotent.
     */
    function init() {
        if (state.initialized) {
            debugLog('[ConvesioPay Classic] init called after initialization; running onUpdatedCheckout only');
            onUpdatedCheckout(); // Trigger initial checkout update.
            return;
        }

        state.initialized = true;
        const initialOrderData = getOrderData();
        state.lastKnownCartTotal = initialOrderData.amount;
        state.lastKnownAmountCurrencySignature = getAmountCurrencySignature(initialOrderData);
        state.lastCustomerSignature = getCustomerSignature();
        getOrCreateTransactionId(); // Ensure transaction ID exists before any submit.
        debugLog('[ConvesioPay Classic] Initializing Classic v2', {
            advancedLogging: isAdvancedLoggingEnabled(),
            initialTotal: state.lastKnownCartTotal,
            activeMethods: getConfig().active_methods || []
        });
        normalizeInitialMethodToCard(); // Keep CPay + Woo selected method aligned to card on refresh.
        bindCheckoutEvents(); // Bind all checkout events.
        onUpdatedCheckout(); // Trigger initial checkout update.
        ensureComponentMounted(); // Ensure the component is mounted.
    }

    // Bootstrap only for classic checkout pages.
    $(document).ready(function () {
        const isBlocksCheckout = document.querySelector('.wc-block-checkout') ||
            document.querySelector('.wp-block-woocommerce-checkout') ||
            document.querySelector('.wc-convesiopay-unified-blocks-content');

        if (isBlocksCheckout) {
            return;
        }

        // Add CSS to hide payment method label when it's the only payment method
        addClassicCheckoutStyles();

        // Entry point for the script.
        init();
    });
})(jQuery);
