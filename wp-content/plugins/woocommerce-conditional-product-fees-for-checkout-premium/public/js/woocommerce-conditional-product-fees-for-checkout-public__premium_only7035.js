(function ($) {
    'use strict';

    /**
     * All of the code for your public-facing JavaScript source
     * should reside in this file.
     *
     * Note: It has been assumed you will write jQuery code here, so the
     * $ function reference has been prepared for usage within the scope
     * of this function.
     *
     * This enables you to define handlers, for when the DOM is ready:
     *
     * $(function() {
     *
     * });
     *
     * When the window is loaded:
     *
     * $( window ).load(function() {
     *
     * });
     *
     * ...and/or other possibilities.
     *
     * Ideally, it is not considered best practise to attach more than a
     * single DOM-ready or window-load handler for a particular page.
     * Although scripts in the WordPress core, Plugins and Themes may be
     * practising this, we should strive to set a better example in our own work.
     */
    $(document).on('change', 'input[name="payment_method"]', function () {
        $('body').trigger('update_checkout');
    });
    if ($('#billing_state').length) {
        $(document).on('change', '#billing_state', function () {
            $('body').trigger('update_checkout');
        });
    }

    $(document).ready(function ($) {

        /**
         * Block Compatiblility
         */
        init_tooltip();

        // Apply fee on change state of payment method selection
        let previouslyChosenPaymentMethod = '';
        if ( typeof wp !== 'undefined' && wp.data && typeof wc !== 'undefined' && wc.wcBlocksData ) {
            wp.data.subscribe( function () {
                const chosenPaymentMethod =
                wp.data.select( wc.wcBlocksData.PAYMENT_STORE_KEY ).getActivePaymentMethod();
                if ( chosenPaymentMethod !== previouslyChosenPaymentMethod ) {
                    previouslyChosenPaymentMethod = chosenPaymentMethod;
                    // addFeeDataInSession();
                }
            }, wc.wcBlocksData.PAYMENT_STORE_KEY );
        }

        // Tooltip toggle on click
        $(document).on('click', '.wcpfc-fee-tooltip', function () {
            $('.wcpfc-fee-tooltiptext').toggle();
        });

        // Function to update the fee label
        updateFeeLabel();

        // Also run it whenever the DOM updates (e.g., when items are added/removed)
        const observer = new MutationObserver(updateFeeLabel);
        observer.observe(document.body, { childList: true, subtree: true });
    });

    function updateFeeLabel() {  
        $.each( wcpfc_public_vars.fee_tooltip_data, function( fee_slug, fee_html ){
            if( $('.wc-block-components-totals-fees__'+fee_slug).length > 0 ) {
                var $valueElement = $('.wc-block-components-totals-fees__'+fee_slug).find('.wc-block-components-totals-item__value');
                if ($valueElement.length && $('.wcpfc-help-tip-'+fee_slug).length === 0) {
                    var $tooltip = $('<span class="wc-wcpfc-help-tip wc-block-components-tooltip wcpfc-help-tip-' + fee_slug + '" data-tip="' + fee_html + '"></span>');
                    $valueElement.after($tooltip);
                }
            }
        });
        init_tooltip();
    }

    function init_tooltip() {
        setTimeout( function(){ 
            $('.wc-wcpfc-help-tip').each(function () {
                return $(this).tipTip({ 
                    content: $(this).data('tip'),
                    keepAlive: true, 
                    edgeOffset: 2 
                });
            });
        }, 1000 );
    }
})(jQuery);
