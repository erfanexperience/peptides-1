(function ($) {
    'use strict';

    /**
     * This script is used to handle the block based optional fees functionality
     */
    $(document).ready(function ($) {
        // Event listeners for fee changes on cart and checkout pages
        $(document).on('change', '.woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block input[type="checkbox"], .woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block select, .woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block input[type="radio"]', function () {
            addFeeDataInSession();
        });


        $(document).on('change', '.woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block input[type="checkbox"], .woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block select, .woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block input[type="radio"]', function () {
            addFeeDataInSession();
        });

        // Initial load: Apply optional fees and update stored data
        setTimeout(function () {
            if (localStorage.getItem('wcpfc_browser_data') !== null) {
                updateFieldsBasedOnStoredData();
            }

            if ($('.woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block').length > 0 || $('.woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block').length > 0) {
                addFeeDataInSession();
            }
        }, 100);
    });

    // Block UI
    function blockUI() {
        $('.wp-block-woocommerce-checkout, .wp-block-woocommerce-cart').block({
            message: null,
            overlayCSS: { background: '#fff', opacity: 0.6 }
        });
    }

    // Unblock UI
    function unblockUI() {
        $('.wp-block-woocommerce-checkout, .wp-block-woocommerce-cart').unblock();
    }

    // Collect fee data from checkboxes, selects, and radios
    function collectFeeDataOnChange() {

        const data = [];
        $('.wp-block-woocommerce-checkout-optional-fee-block')
            .find('input[type="checkbox"]:checked, select, input[type="radio"]:checked')
            .each(function () {
            const $this = $(this);
            const value = $this.val();

            if ($this.is('input[type="checkbox"]')) {
                // For checkboxes, we expect a numeric value (fee ID)
                if (value && !isNaN(value)) {
                    data.push(parseInt(value, 10));
                }
            } else if ($this.is('select') || $this.is('input[type="radio"]')) {
                // For select inputs, check if the value is 'yes'
                if (value.toLowerCase() === 'yes') {
                    const feeValue = $this.data('value'); // Using the data-value attribute
                    if (feeValue && !isNaN(feeValue)) {
                        data.push(parseInt(feeValue, 10));
                    }
                }
            }
        });

        return data;
    }

    // Update WooCommerce Blocks checkout with fee data
    function updateFeeData(data) {

        let feeData = data || [];
        if (!Array.isArray(feeData) || feeData.length === 0 || feeData === undefined || feeData === null) {
            feeData = collectFeeDataOnChange();
        }
        
        const { select } = wp.data;
        const { PAYMENT_STORE_KEY } = window.wc.wcBlocksData;
        const chosenPaymentMethod = select( PAYMENT_STORE_KEY ).getActivePaymentMethod();

        wc.blocksCheckout.extensionCartUpdate({
            namespace: 'woocommerce-conditional-product-optional-fees',
            data: {
                fees_ids: feeData,
                payment_method: chosenPaymentMethod,
            } 
        }).then(function () {
            setTimeout(function () {
                $(document.body).trigger('wc_fragment_refresh');
            }, 300);
            unblockUI();
        }).catch(function (error) {
            console.error('Error updating fee data:', error);
            unblockUI();
        });
    }

    // Add fee data to session
    function addFeeDataInSession() {

        if (!window || !window.wc || !window.wc.blocksCheckout) {
            return;
        }

        const isCartPage = $('.wp-block-woocommerce-cart').length > 0;
        const isCheckoutPage = $('.wp-block-woocommerce-checkout').length > 0;

        if (!isCartPage && !isCheckoutPage) { return; }

        blockUI();

        let sendData = [];
        const data = collectFeeDataOnChange();

        var checkbox;
        var radio;
        var dropdown;
        var dropdownValue;
        
        if (isCartPage) {
            // Select all checkboxes and radio buttons dynamically
            checkbox = $('.woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block').find('.input-checkbox');
            radio = $('.woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block').find('input[type="radio"]:checked');
            dropdown = $('.woocommerce-cart .wp-block-woocommerce-checkout-optional-fee-block').find('select');

            // Check if the dropdown exists and has a value
            dropdownValue = (dropdown.length > 0) ? dropdown.val() : undefined;  // Check if the dropdown exists
            
            // Check if the checkbox is checked, or a "Yes" radio button is selected, or a valid dropdown option is selected
            if (checkbox.is(':checked') || radio.val() === 'yes' || (dropdownValue !== undefined && dropdownValue === 'Yes')) {
                localStorage.setItem('wcpfc_browser_data', JSON.stringify(data));
                localStorage.setItem('wcpfc_cart_hand_checked', true);
                sendData = data;
            } else {
                localStorage.removeItem('wcpfc_browser_data');
                localStorage.setItem('wcpfc_cart_hand_checked', false);
                sendData = [];
            }
        }

        if (isCheckoutPage) {
            var cartChecked = localStorage.getItem('wcpfc_cart_hand_checked');
            if (cartChecked !== null && cartChecked === 'true') {
                if( data !== null && data.length > 0 ) {
                    localStorage.setItem('wcpfc_browser_data', JSON.stringify(data));
                    localStorage.setItem('wcpfc_cart_hand_checked', true);
                    sendData = data;
                } else {
                    localStorage.removeItem('wcpfc_browser_data');
                    localStorage.setItem('wcpfc_cart_hand_checked', false);
                    sendData = [];
                }
            } else {
                checkbox = $('.woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block').find('.input-checkbox');
                radio = $('.woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block').find('input[type="radio"]:checked');
                dropdown = $('.woocommerce-checkout .wp-block-woocommerce-checkout-optional-fee-block').find('select');
                dropdownValue = (dropdown.length > 0) ? dropdown.val() : undefined;

                if (checkbox.is(':checked') || radio.val() === 'yes' || (dropdownValue !== undefined && dropdownValue === 'Yes')) {
                    localStorage.setItem('wcpfc_browser_data', JSON.stringify(data));
                    localStorage.setItem('wcpfc_cart_hand_checked', true);
                    sendData = data;
                } else {
                    localStorage.removeItem('wcpfc_browser_data');
                    localStorage.setItem('wcpfc_cart_hand_checked', false);
                    sendData = [];
                }
            }
        }

        updateFeeData(sendData);
    }

    // Update fields based on stored data
    function updateFieldsBasedOnStoredData() {

        const isCartPage = $('.wp-block-woocommerce-cart').length > 0;
        const isCheckoutPage = $('.wp-block-woocommerce-checkout').length > 0;
        if (!isCheckoutPage && !isCartPage) { return; }

        const storedData = JSON.parse(localStorage.getItem('wcpfc_browser_data')) || [];

        $('.wp-block-woocommerce-checkout-optional-fee-block input[type="checkbox"]').each(function () {
            updateInputState($(this), storedData);
        });

        $('.wp-block-woocommerce-checkout-optional-fee-block select').each(function () {
            const selectedValue = parseInt($(this).data('value'));
            $(this).val(storedData.includes(selectedValue) ? 'Yes' : 'No');
        });

        $('.wp-block-woocommerce-checkout-optional-fee-block input[type="radio"]').each(function () {
            // Find the group of radio buttons by name (each fee ID has a distinct name group)
            const feeRadioName = $(this).attr('name');
            // Only run once per group, on the 'yes' button (to avoid duplication)
            if ($(this).val().toLowerCase() === 'yes') {
                // Find all radios in the current group
                const $group = $('input[type="radio"][name="' + feeRadioName + '"]');
                // Find the 'yes' and 'no' buttons in this group
                const $yesRadio = $group.filter(function() { return $(this).val().toLowerCase() === 'yes'; });
                const $noRadio = $group.filter(function() { return $(this).val().toLowerCase() === 'no'; });

                // The fee ID value is stored in data-value for 'yes', or may need to get from any in the group that has a non-empty data-value
                // Get feeId from yes button (should always have it)
                const feeId = parseInt($yesRadio.data('value'));
                const feeApplied = storedData.includes(feeId);

                // Set checked state: only one in group checked at a time
                if (feeApplied) {
                    $yesRadio.prop('checked', true);
                    $noRadio.prop('checked', false);
                } else {
                    $yesRadio.prop('checked', false);
                    $noRadio.prop('checked', true);
                }
            }
        });
    }

    function updateInputState(inputElement, storedData) {
        const value = parseInt(inputElement.val());      
        if (( value === 0 || value === '' || value === null || typeof value === 'undefined') ) {
            inputElement.prop('checked', true);
        } else {
            inputElement.prop('checked', storedData.includes(value));
        }
    }

})(jQuery);