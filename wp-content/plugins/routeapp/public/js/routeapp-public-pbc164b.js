(function ($) {
    "use strict";


    jQuery(function ($) {
        const UPDATED_CART_TOTALS_EVENT = 'updated_cart_totals';
        const UPDATED_CHECKOUT_EVENT = 'updated_checkout';
        const UPDATE_CHECKOUT_EVENT = 'update_checkout';
        const CHECKED_SHIPPING_METHOD = '#shipping_method li .shipping_method:checked';
        const ROUTE_WIDGET_ID = '#RouteWidget';
        const PROTECTION_COOKIE = '.routeapp-checkbox-cookie';
        const ROUTE_READY_MAX_ATTEMPTS = 100;
        const ROUTE_READY_INTERVAL_MS = 100;

        const RouteConfig = {
            env: '.routeapp-env',
            ajax_url: '.routeapp-ajax-url',
            store_domain: '.routeapp-store-domain',
            store_name: '.routeapp-store-name',
            currency: '.routeapp-currency',
            merchant_id: '.routeapp-merchant-id',
            subtotal: '.routeapp-subtotal',
            app_endpoint_widget_check: 'woo_check_widget',
            app_endpoint_widget_update: 'woo_get_ajax_data',
            is_cart_page: window.location.pathname === "/cart/",
            invalid_shipping_method: '.routeapp-invalid-shipping-method',
            checkbox: null
        };

        let Protect = null;
        let widgetInitialized = false;
        let domObserver = null;

        function isWidgetDomReady() {
            return $(ROUTE_WIDGET_ID).length > 0 && $(RouteConfig.subtotal).length > 0;
        }

        function isRouteProtectionReady() {
            return !!(window.Route && window.Route.Protection && typeof window.Route.Protection.render === 'function');
        }

        /**
         * WooCommerce Blocks checkout may hydrate after jQuery ready; wait for DOM and Route.Protection.
         */
        function whenWidgetReady(callback) {
            if (domObserver) {
                domObserver.disconnect();
                domObserver = null;
            }

            let attempts = 0;
            let finished = false;

            function tryReady() {
                if (finished) {
                    return;
                }
                if (isWidgetDomReady() && isRouteProtectionReady()) {
                    finished = true;
                    if (domObserver) {
                        domObserver.disconnect();
                        domObserver = null;
                    }
                    callback(window.Route.Protection);
                    return;
                }
                attempts += 1;
                if (attempts >= ROUTE_READY_MAX_ATTEMPTS) {
                    finished = true;
                    if (domObserver) {
                        domObserver.disconnect();
                        domObserver = null;
                    }
                    console.error('Route widget: not ready after waiting', {
                        domReady: isWidgetDomReady(),
                        routeReady: isRouteProtectionReady(),
                        widgetNodes: $(ROUTE_WIDGET_ID).length,
                        subtotalNodes: $(RouteConfig.subtotal).length
                    });
                    return;
                }
                setTimeout(tryReady, ROUTE_READY_INTERVAL_MS);
            }

            domObserver = new MutationObserver(tryReady);
            domObserver.observe(document.body, { childList: true, subtree: true });

            tryReady();
        }

        function getCheckboxStatus() {
            if (!window.Route || !window.Route.Coverage) {
                return null;
            }
            if ($(PROTECTION_COOKIE).length) {
                return $(PROTECTION_COOKIE).val() === 'Route.Coverage.ActiveByDefault'
                    ? Route.Coverage.ActiveByDefault
                    : Route.Coverage.InactiveByDefault;
            }
            return Route.Coverage.ActiveByDefault;
        }

        function getRouteappAjaxUrl() {
            return $(RouteConfig.ajax_url).length ?
                $(RouteConfig.ajax_url).val() : (
                    typeof window.wc_add_to_cart_params != "undefined" ?
                        window.wc_add_to_cart_params.ajax_url :
                        window.wc_routeapp_ajaxurl
                );
        }

        function triggerCheckoutUpdate() {
            $("body").trigger(UPDATE_CHECKOUT_EVENT);
        }

        function triggerCartUpdate() {
            $($(document.body)
                .find('[name="update_cart"]'))
                .prop('disabled', false)
                .trigger('click');
        }

        /**
         * Check if WooCommerce blocks checkout is available
         * @returns {boolean}
         */
        function isBlocksCheckoutAvailable() {
            return typeof wc !== 'undefined' &&
                   typeof wc.blocksCheckout !== 'undefined' &&
                   typeof wc.blocksCheckout.extensionCartUpdate === 'function';
        }

        /**
         * Trigger cart revalidation for WooCommerce blocks checkout
         * This ensures the cart visually updates when Route is toggled
         */
        function triggerBlocksCheckoutCartUpdate() {
            if (!isBlocksCheckoutAvailable()) {
                triggerCheckoutUpdate();
                return;
            }

            try {
                wc.blocksCheckout.extensionCartUpdate({
                    namespace: 'route-widget-integration',
                    data: {
                        checkbox: RouteConfig.checkbox === Route.Coverage.ActiveByDefault
                    }
                }).catch(function(error) {
                    console.error('Route widget: Cart update failed:', error);
                }).finally(function() {
                    triggerCheckoutUpdate();
                });
            } catch (error) {
                console.error('Route widget: Error triggering blocks checkout update:', error);
                triggerCheckoutUpdate();
            }
        }

        function updateFee() {
            let checkbox = RouteConfig.checkbox == Route.Coverage.ActiveByDefault;
            $.ajax({
                type: "POST",
                url: getRouteappAjaxUrl(),
                data: {
                    "action": RouteConfig.app_endpoint_widget_update,
                    "checkbox": checkbox
                },
                success: function () {
                    if (isBlocksCheckoutAvailable()) {
                        triggerBlocksCheckoutCartUpdate();
                    } else if (RouteConfig.is_cart_page) {
                        triggerCartUpdate();
                    } else {
                        triggerCheckoutUpdate();
                    }

                    // Track protection change using RouteAmplitudeAnalytics
                    if (window.RouteAmplitudeAnalytics) {
                        RouteAmplitudeAnalytics.trackProtectChange(checkbox);
                    }
                }
            });
        }

        function renderWidget(subtotal) {
            if (!Protect || !isWidgetDomReady()) {
                return;
            }
            if (document.getElementsByClassName("route-div").length > 1){
                let elems = document.getElementsByClassName("route-div");
                let elementsSize = elems.length - 1;
                for (let idx = 0; idx < elementsSize; idx++) {
                    elems[0].remove();
                }
            }
            let environment = Route.Environment.Production;
            if ($(RouteConfig.env).val()!== 'Route.Environment.Production') {
                environment = Route.Environment.Stage;
            }
            Protect.render({
                storeDomain: $(RouteConfig.store_domain).val(),
                subtotal: subtotal,
                currency: $(RouteConfig.currency).val(),
                environment: environment,
                status: RouteConfig.checkbox,
                merchantId: $(RouteConfig.merchant_id).val(),
                storeName: $(RouteConfig.store_name).val(),
                app: {
                  name: "@route/woocommerce-widget",
                  version: "1.0.0",
                  platformId: "woocommerce",
                },
            });
        }

        function checkWidgetShow() {
            if (!isWidgetDomReady()) {
                return;
            }
            let shipping_method = $(CHECKED_SHIPPING_METHOD).length ? $(CHECKED_SHIPPING_METHOD).val() : false;
            jQuery.ajax({
                type: "POST",
                url: getRouteappAjaxUrl(),
                data: {
                    "action": "get_route_checkout",
                    shipping_method
                },
                success: function(result) {
                    if (result['routeapp-subtotal']) {
                        $(ROUTE_WIDGET_ID).show();
                        renderWidget(result['routeapp-subtotal']);
                        // Track widget render using RouteAmplitudeAnalytics
                        if (window.RouteAmplitudeAnalytics) {
                            RouteAmplitudeAnalytics.trackWidgetRender();
                        }
                    } else {
                        $(ROUTE_WIDGET_ID).hide();
                    }
                }
            });
        }

        /**
         * Re-render when Blocks hydration clears #RouteWidget after a successful render.
         */
        function watchWidgetContainer() {
            const el = document.querySelector(ROUTE_WIDGET_ID);
            if (!el || el.dataset.routeappWatch === '1') {
                return;
            }
            el.dataset.routeappWatch = '1';
            new MutationObserver(function () {
                if (!Protect || !isWidgetDomReady()) {
                    return;
                }
                if (el.childElementCount === 0) {
                    renderWidget($(RouteConfig.subtotal).val());
                }
            }).observe(el, { childList: true, subtree: true });
        }

        function initWidget(protection) {
            if (widgetInitialized) {
                renderWidget($(RouteConfig.subtotal).val());
                return;
            }
            widgetInitialized = true;
            Protect = protection;
            RouteConfig.checkbox = getCheckboxStatus();

            //listeners
            $(document.body).on(UPDATED_CART_TOTALS_EVENT, checkWidgetShow);
            $(document.body).on(UPDATED_CHECKOUT_EVENT, checkWidgetShow);

            // Initialize Amplitude analytics using RouteAmplitudeAnalytics
            if (window.RouteAmplitudeAnalytics) {
                RouteAmplitudeAnalytics.initialize();
            }

            // Set up event listeners for info modal tracking
            // Listen for clicks on Route widget info buttons
            $(document).on('click', '#RouteWidget .pw-info-icon', function() {
                if (window.RouteAmplitudeAnalytics) {
                    RouteAmplitudeAnalytics.trackInfoChange('opened');
                }
            });

            // Listen for modal close events
            $(document).on('click', '#RouteWidget .route-modal__close', function() {
                if (window.RouteAmplitudeAnalytics) {
                    RouteAmplitudeAnalytics.trackInfoChange('closed');
                }
            });

            if (!$(RouteConfig.invalid_shipping_method).length) {
                renderWidget($(RouteConfig.subtotal).val());
                Protect.on('status_change', (event) => {
                    RouteConfig.checkbox = event.to===1 ? Route.Coverage.ActiveByDefault : Route.Coverage.InactiveByDefault;
                    updateFee();
                });
                watchWidgetContainer();
            }
        }

        whenWidgetReady(initWidget);
    });
})(jQuery);
