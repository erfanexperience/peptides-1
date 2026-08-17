(function ($) {
	'use strict';
	$(document).ready(function () {
		$('.woocommerce-billing-fields input, .woocommerce-billing-fields select, .woocommerce-billing-fields textarea,.woocommerce-shipping-fields input, .woocommerce-shipping-fields select, .woocommerce-shipping-fields textarea').on('change', function() {
			$('body').trigger('update_checkout');
		});

		function conditional_payments_trigger() {
			if ( typeof dscpw_conditional_payments_settings !== 'undefined' ) {
				$.each( dscpw_conditional_payments_settings.name_address_fields, function( index, value ) {
					$( document.body ).on( 'change', 'input[name="' + value + '"]', function() {
						$( document.body ).trigger( 'update_checkout' );
					} );

					if ( value.indexOf('shipping_') !== -1 ) {
						var billingValue = value.replace( 'shipping', 'billing' );
						if ( $.inArray( billingValue, dscpw_conditional_payments_settings.name_address_fields ) === -1 ) {
							$( document.body ).on( 'change', 'input[name="' + billingValue + '"]', function() {
								$( document.body ).trigger( 'update_checkout' );
							} );
						}
					}
					if ( 'previous_order' === value ) {
						$( document.body ).on( 'change', 'input[name="billing_email"]', function() {
							$( document.body ).trigger( 'update_checkout' );
						} );
					}
				} );
			}
		}
		conditional_payments_trigger();
		/* <fs_premium_only> */
		$( 'form.checkout' ).on( 'change', 'input[name^="payment_method"]', function() {
            $( 'body' ).trigger( 'update_checkout' );
        });
		/* </fs_premium_only> */
	});
})(jQuery);