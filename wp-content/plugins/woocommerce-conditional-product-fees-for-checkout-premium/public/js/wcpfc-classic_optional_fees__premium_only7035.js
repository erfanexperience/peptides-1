(function ($) {
    'use strict';

    /**
     * This script is used to handle the classic cart and checkout based optional fees functionality
     */
    $(document).ready(function ($) {
        // Clear localStorage if the cart is empty
        $(document.body).on('wc_cart_emptied', function () {
            localStorage.removeItem('wcpfc_browser_data');
            localStorage.removeItem('wcpfc_cart_hand_checked');
        });

        // Event listeners for fee changes on cart and checkout pages
        $(document).on('change', '.woocommerce-cart .optional_fee_container input[type="checkbox"], .woocommerce-cart .optional_fee_container select, .woocommerce-cart .optional_fee_container input[type="radio"]', function () {
            classicAddFeeDataInSession();
            dropdown_check();
        });

        $(document).on('change', '.woocommerce-checkout .optional_fee_container input[type="checkbox"], .woocommerce-checkout .optional_fee_container select, .woocommerce-checkout .optional_fee_container input[type="radio"]', function () {
            classicAddFeeDataInSession();
            dropdown_check();
        });

        // If the checkout page is present, set the data from the localStorage to the fields
        if( $('.woocommerce-checkout').length > 0 ) {

            let customDataApplied = false;

            $(document.body).on('updated_checkout', function () {

                // If the data has already been applied, return
                if (customDataApplied) {
                    return;
                }

                // Set the data as applied
                customDataApplied = true;
                
                if (localStorage.getItem('wcpfc_browser_data') !== null ) {
                    classicUpdateFieldsBasedOnStoredData();
                }

                // We first need to set the data in the localStorage before updating the fields based on the stored data
                if ($('.woocommerce-checkout .optional_fee_container').length > 0 ) {
                    classicAddFeeDataInSession();
                    dropdown_check();
                }
            });
        }

        // If the cart page is present, set the data from the localStorage to the fields
        if( $('.woocommerce-cart').length > 0 ) {
            
            if (localStorage.getItem('wcpfc_browser_data') !== null ) {
                classicUpdateFieldsBasedOnStoredData();
            }
            if ($('.woocommerce-cart .optional_fee_container').length > 0 ) {
                classicAddFeeDataInSession();
                dropdown_check();
            }
        }
    });

    /**
     * Functions for the classic cart and checkout based optional fees functionality
     */
    // Block UI
    function classicBlockUI() {
        $('.woocommerce-checkout .woocommerce-checkout-payment, .woocommerce-checkout .shop_table, .woocommerce-cart .optional_fee_container').block({
            message: null,
            overlayCSS: { background: '#fff', opacity: 0.6 }
        });
    }

    // Unblock UI
    function classicUnblockUI() {
        $('.woocommerce-checkout .woocommerce-checkout-payment, .woocommerce-checkout .shop_table, .woocommerce-cart .optional_fee_container').unblock();
    }

    // Update fields based on stored data
    function classicUpdateFieldsBasedOnStoredData() {

        if (window.wc && window.wc.blocksCheckout) {
            return;
        }

        const storedData = JSON.parse(localStorage.getItem('wcpfc_browser_data')) || [];
        
        $('.optional_fee_container input[type="checkbox"], .optional_fee_container input[type="radio"]').each(function () {
            updateInputState($(this), storedData);
        });
    
        $('.optional_fee_container select').each(function () {
            const selectedValue = parseInt($(this).data('value'));
            $(this).val(storedData.includes(selectedValue) ? 'yes' : 'no');
        });
        
        dropdown_check();
    }

    // State change of element
    function updateInputState(inputElement, storedData) {
        
        // Determine if fee id exists in storedData (fee applied)
        const feeId = parseInt(inputElement.val());
        const feeApplied = storedData.includes(feeId);

        if (inputElement.attr('type') === 'checkbox') {
            // For checkbox: checked if fee applied, unchecked otherwise
            inputElement.prop('checked', feeApplied);
        } else if (inputElement.attr('type') === 'radio') {
            // For radio: select 'Yes' if applied, 'No' if not
            // Radio 'yes' value is typically 'yes', 'no' is typically 'no'
            if (inputElement.val().toLowerCase() === 'yes') {
                inputElement.prop('checked', feeApplied);
            } else if (inputElement.val().toLowerCase() === 'no') {
                inputElement.prop('checked', !feeApplied);
            }
        }
    }

    // Check if the dropdown is checked
    function dropdown_check() {
        $('.input-dropdown').each(function () {
            $(this).next(':hidden').remove();
            if ('yes' === $(this).val() || 'Yes' === $(this).val()) {
                $('<input>').attr({
                    type: 'hidden',
                    name: 'wef_fees_id_array_' + $(this).data('value') + '[]',
                    value: $(this).data('value'),
                }).insertAfter($(this));
            }
        });
    }

    // Add fee data to session classic method
    function classicAddFeeDataInSession() {

        if (window && window.wc && window.wc.blocksCheckout) {
            return;
        }

        const isCartPage = $('.woocommerce-cart').length > 0;
        const isCheckoutPage = $('.woocommerce-checkout').length > 0;

        if (!isCartPage && !isCheckoutPage) { return; }

        classicBlockUI();

        let sendData = [];
        const data = classicCollectFeeData(); // Get the current fee data
        
        var checkbox;
        var radio;
        var dropdown;
        var dropdownValue;

        if (isCartPage) {
            checkbox = $('.woocommerce-cart .optional_fee_container').find('input[type="checkbox"]:checked');
            radio = $('.woocommerce-cart .optional_fee_container').find('input[type="radio"]:checked');
            dropdown = $('.woocommerce-cart .optional_fee_container').find('select');
            dropdownValue = (dropdown.length > 0) ? dropdown.val() : undefined;
            
            if (checkbox.is(':checked') || radio.val() !== '' || (dropdownValue !== undefined && dropdownValue.toLowerCase() === 'yes')) {
                localStorage.setItem('wcpfc_browser_data', JSON.stringify(data));
                localStorage.setItem('wcpfc_cart_hand_checked', true);
                sendData = data;
            } else {
                localStorage.removeItem('wcpfc_browser_data');
                localStorage.setItem('wcpfc_cart_hand_checked', false);
                sendData = [];
            }
            
            if ($('.cart_item').length > 0) {
                
                // Send the array of fee IDs via AJAX
                // Optimized AJAX request with error handling
                try {
                    $.post( woocommerce_params.ajax_url, {
                        action: 'wcpfc_pro_cart_optional_fees_ajax__premium_only',
                        fees_ids: sendData
                    }).done(function(response) {
                        if (response) {
                            $(document.body).trigger('wc_update_cart');
                        }
                        classicUnblockUI();
                    }).fail(function(jqXHR, textStatus, errorThrown) {
                        console.error('Optional fees AJAX (cart) request failed:', textStatus, errorThrown);
                        classicUnblockUI();
                    });
                } catch (err) {
                    console.error('An unexpected error occurred while sending optional fees (cart):', err);
                    classicUnblockUI();
                }
            }
        } 
        if (isCheckoutPage) {
            sendData = JSON.parse(localStorage.getItem('wcpfc_browser_data')) || [];
            var cartChecked = localStorage.getItem('wcpfc_cart_hand_checked');
            if (cartChecked !== null && cartChecked === 'true') {
                localStorage.setItem('wcpfc_browser_data', JSON.stringify(data));
                localStorage.setItem('wcpfc_cart_hand_checked', true);
                sendData = data;
            } else {
                checkbox = $('.woocommerce-checkout .optional_fee_container').find('.input-checkbox');
                radio = $('.woocommerce-checkout .optional_fee_container').find('input[type="radio"]:checked');
                dropdown = $('.woocommerce-checkout .optional_fee_container').find('select');
                dropdownValue = (dropdown.length > 0) ? dropdown.val() : undefined;
                if (checkbox.is(':checked') || radio.val() !== '' || (dropdownValue !== undefined && dropdownValue.toLowerCase() === 'yes')) {
                    localStorage.setItem('wcpfc_browser_data', JSON.stringify(data));
                    localStorage.setItem('wcpfc_cart_hand_checked', true);
                    sendData = data;
                } else {
                    localStorage.removeItem('wcpfc_browser_data');
                    localStorage.setItem('wcpfc_cart_hand_checked', false);
                    sendData = [];
                }
            }
            // Send the array of fee IDs via AJAX
            try {
                $.post( woocommerce_params.ajax_url, {
                    action: 'wcpfc_pro_cart_optional_fees_ajax__premium_only',
                    fees_ids: sendData
                }).done(function(response) {
                    if (response) {
                        setTimeout(function () {
                            $(document.body).trigger('update_checkout');
                            classicUnblockUI();
                        }, 200);
                    }
                }).fail(function(jqXHR, textStatus, errorThrown) {
                    console.error('Optional fees AJAX request failed:', textStatus, errorThrown);
                    classicUnblockUI();
                });
            } catch (err) {
                console.error('An unexpected error occurred while sending optional fees:', err);
                classicUnblockUI();
            }
        }
    }

    // Collect fee data from checkboxes, selects, and radios classic method
    function classicCollectFeeData() {
            
        const data = [];
        $('.optional_fee_container')
            .find('input[type="checkbox"]:checked, select, input[type="radio"]:checked')
            .each(function () {
            const $this = $(this);
            const value = $this.val(); // Value of the input, select, or radio

            if ($this.is('input[type="checkbox"]')) {
                // For checkboxes, we expect a numeric value (fee ID)
                if (value && !isNaN(value)) {
                    data.push(parseInt(value, 10));
                }
            } else if ($this.is('select')) {
                // For select inputs, check if the value is 'yes'
                if (value.toLowerCase() === 'yes') {
                    const feeValue = $this.data('value'); // Using the data-value attribute
                    if (feeValue && !isNaN(feeValue)) {
                        data.push(parseInt(feeValue, 10));
                    }
                }
            } else if ($this.is('input[type="radio"]')) {
                // For radios, we expect a numeric value for 'Yes' option
                if (value && !isNaN(value)) {
                    data.push(parseInt(value, 10));
                }
            }
        });
        
        return data;
    }
})(jQuery);