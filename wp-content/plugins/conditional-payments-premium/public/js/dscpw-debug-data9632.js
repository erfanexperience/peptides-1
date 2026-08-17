jQuery(document).ready(function($) {
    if (window.wc && window.wc.blocksCheckout) {
        const { registerCheckoutFilters } = window.wc.blocksCheckout;
        // Adjust cart item class of the order summary items.
        registerCheckoutFilters('dscpw-debug-mode', {
            cartItemClass: (value, extensions, args) => {
                setTimeout(() => {
                    const paymentMethods = {};
                    const options = document.querySelectorAll('.wc-block-components-radio-control__option');
                
                    options.forEach(option => {
                        const input = option.querySelector('input[type="radio"]');
                        const label = option.querySelector('.wc-block-components-payment-method-label');
                        
                        if (input && label) {
                            const value = input.value;
                            const text = label.textContent;
                            paymentMethods[value] = `${text} (${value})`;
                        }
                    });

                    var debug_html = jQuery(extensions.dscpw_debug_data.data);

                    const before_filter = Object.values(extensions.dscpw_debug_data.payment_methods).map(method => 
                        method.replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    ).join('<br>');

                    const after_filter = Object.values(paymentMethods).map(method => 
                    method.replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    ).join('<br>');

                    debug_html.find('.before-filter-methods').html(before_filter);
                    debug_html.find('.after-filter-methods').html(after_filter);

                    if (args && args.context === 'summary') {
                        $('#dscpw-debug').html(debug_html.html());
                    }
                    if (supportsLocalStorage()) {
                        const status = localStorage.getItem('dscpw_debug_status') === 'true';
                        $('#dscpw-debug-contents').toggle(status);
                        $('#dscpw-debug').toggleClass('closed', !status);
                    }
                }, 1500);
                
                return value;
            }
        });
    }
    $(document.body).on('updated_checkout', function(event, response) {
        if (response && response.fragments && response.fragments['#dscpw-debug']) {
            $('#dscpw-debug').html(response.fragments['dscpw-debug']);
        }
    });

    /**
     * Debug functionality for the Conditional Payments for WooCommerce plugin.
     */
    const dscpwDebug = {
        init() {
            this.bindEvents();
            this.initializeDebugStatus();
        },

        bindEvents() {
            $(document.body).on('click', '#dscpw-debug-header', () => this.toggleDebug());
            $(document.body).on('updated_checkout dscpw_updated_debug', () => this.initializeDebugStatus());
        },

        toggleDebug() {
            const debugContainer = $('#dscpw-debug');
            const debugContents = $('#dscpw-debug-contents');
            const isVisible = debugContents.is(':visible');

            debugContainer.toggleClass('closed', isVisible);
            debugContents.slideToggle(200, () => this.updateDebugStatus());
        },

        updateDebugStatus() {
            if (supportsLocalStorage()) {
                const isVisible = $('#dscpw-debug-contents').is(':visible');
                localStorage.setItem('dscpw_debug_status', isVisible ? 'true' : 'false');
            }
        },

        initializeDebugStatus() {
            if (supportsLocalStorage()) {
                const status = localStorage.getItem('dscpw_debug_status') === 'true';
                $('#dscpw-debug-contents').toggle(status);
                $('#dscpw-debug').toggleClass('closed', !status);
            }
        }
    };

    function supportsLocalStorage() {
        try {
            const enabled = 'enabled';
            localStorage.setItem(enabled, enabled);
            localStorage.removeItem(enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    dscpwDebug.init();
});
