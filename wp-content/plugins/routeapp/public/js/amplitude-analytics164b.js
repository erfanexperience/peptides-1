/**
 * Amplitude Analytics Integration for Route Widget
 * Handles analytics tracking for widget interactions in WooCommerce
 *
 * @package RouteApp
 * @version 1.0.0
 */

(function ($, window) {
    'use strict';

    let amplitudeInstance = null;

    /**
     * Initialize Amplitude analytics
     *
     * @returns {boolean} - Returns true if initialization successful
     */
    function initializeAmplitude() {
        // Check if Amplitude SDK is loaded
        if (!window.amplitude) {
            console.warn('Amplitude SDK not loaded');
            return false;
        }

        try {
            // Safely check if cartData exists before accessing its properties
            if (typeof cartData === 'undefined' || !cartData || !cartData.amplitudeKey) {
                console.error('Amplitude API key not found');
                return false;
            }

            // Initialize Amplitude if not already initialized
            if (!window.amplitudeInitialized) {
                window.amplitude.init(cartData.amplitudeKey, {
                    transport: 'beacon',
                    flushIntervalMillis: 0,
                    flushQueueSize: 1,
                    fetchRemoteConfig: true,

                    deviceId: cartData.cartId,

                    /**
                     * Use localStorage for both - more reliable in iframes
                     */
                    identityStorage: 'localStorage',

                    autocapture: {
                        attribution: false,
                        pageViews: false,
                        sessions: true,
                        formInteractions: false,
                        fileDownloads: false,
                        elementInteractions: false,
                        pageUrlEnrichment: false,
                        webVitals: false,
                    }
                });

                window.amplitudeInitialized = true;
                console.log('Amplitude initialized successfully');
            }

            // Set the Amplitude instance for tracking functions
            amplitudeInstance = window.amplitude;
            return true;
        } catch (error) {
            console.error('Failed to initialize Amplitude:', error);
            return false;
        }
    }

    /**
     * Get common analytics attributes
     *
     * @param {Object} additionalConfig - Additional data to merge
     * @returns {Object} - Analytics attributes object
     */
    function getAnalyticsAttributes(additionalConfig = {}) {
        const pathname = window.location.pathname;
        const pageType = pathname === "/cart/" || pathname === "/cart" ? 'cart' :
                        pathname === "/checkout/" || pathname === "/checkout" ? 'checkout' : 'unknown';

        return {
            app: {
                name: '@route/woocommerce-widget',
                version: '1.0.0'
            },
            cart: {
                id: cartData.cartId,
                subtotal: parseFloat(cartData.subtotal)
            },
            widgetVersion: 'optimal',
            environment: cartData.environment,
            merchant: {
                id: cartData.merchantId
            },
            pageType: pageType,
            platform: {
                id: 'woocommerce'
            },
            premium: {
                amount: cartData.totalRouteFee || 0.98,
                currency: cartData.currency
            },
            widget: {
                id: cartData.widgetId
            },
            ...additionalConfig
        };
    }

    /**
     * Track widget render decision event
     */
    function trackWidgetRenderDecision() {
        if (!amplitudeInstance) {
            console.warn('Amplitude not initialized - skipping widget render tracking');
            return;
        }

        try {
            const attributes = getAnalyticsAttributes();

            amplitudeInstance.track('widget_render_decision', attributes);
        } catch (error) {
            console.error('Failed to track widget render:', error);
        }
    }

    /**
     * Track widget info modal change event
     *
     * @param {string} action - Action type ('opened' or 'closed')
     */
    function trackWidgetInfoChange(action) {
        if (!amplitudeInstance) {
            console.warn('Amplitude not initialized - skipping info change tracking');
            return;
        }

        try {
            const attributes = getAnalyticsAttributes({
                action: action, // 'opened' or 'closed'
                timestamp: new Date().toISOString()
            });

            amplitudeInstance.track('widget_info_change', attributes);
        } catch (error) {
            console.error('Failed to track info change:', error);
        }
    }

    /**
     * Track protection toggle event
     *
     * @param {boolean} isProtected - Whether protection is enabled
     */
    function trackWidgetProtectChange(isProtected) {
        if (!amplitudeInstance) {
            console.warn('Amplitude not initialized - skipping protect change tracking');
            return;
        }

        try {
            const attributes = getAnalyticsAttributes({
                protectionEnabled: isProtected,
                action: isProtected ? 'added' : 'removed',
                timestamp: new Date().toISOString()
            });

            amplitudeInstance.track('widget_protect_change', attributes);
        } catch (error) {
            console.error('Failed to track protect change:', error);
        }
    }

    /**
     * Check if Amplitude is initialized and ready
     *
     * @returns {boolean}
     */
    function isInitialized() {
        return amplitudeInstance !== null && window.amplitudeInitialized === true;
    }

    // Export to window object
    window.RouteAmplitudeAnalytics = {
        initialize: initializeAmplitude,
        trackWidgetRender: trackWidgetRenderDecision,
        trackInfoChange: trackWidgetInfoChange,
        trackProtectChange: trackWidgetProtectChange,
        isInitialized: isInitialized
    };

})(jQuery, window);

