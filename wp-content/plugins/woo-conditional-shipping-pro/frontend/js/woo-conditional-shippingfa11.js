jQuery(document).ready(function($) {
	/**
	 * Notices in checkout
	 */
	$( document.body ).on( 'updated_checkout', function() {
		let noticesEl = $( '#wcs-notices-pending' );

		if ( noticesEl.length > 0 ) {
			// Clear existing notices
			$( '#wcs-notices' ).remove();

			let shippingMethods = $( '.woocommerce-shipping-totals ul.woocommerce-shipping-methods' );
			
			if ( shippingMethods.length > 0 ) {
				shippingMethods.after( noticesEl );
				noticesEl.css( 'display', 'block' ).attr( 'id', 'wcs-notices' );
			}
		}
	} );

	/**
	 * Notices in cart
	 */
	 $( document.body ).on( 'wcs_updated_cart', function() {
		let noticesEl = $( '#wcs-notices-pending' );

		if ( noticesEl.length > 0 ) {
			// Clear existing notices
			$( '#wcs-notices' ).remove();

			let shippingMethods = $( '.woocommerce-shipping-totals ul.woocommerce-shipping-methods' );
			
			if ( shippingMethods.length > 0 ) {
				shippingMethods.after( noticesEl );
				noticesEl.css( 'display', 'block' ).attr( 'id', 'wcs-notices' );
			}
		}
	} );
	$( document.body ).trigger( 'wcs_updated_cart' );
	$( document.body ).on( 'updated_cart_totals', function() {
		$( document.body ).trigger( 'wcs_updated_cart' );
	} );

	/**
	 * Trigger checkout update if some field that is used
	 * for conditions is updated. Some fields such as email
	 * don't trigger checkout update by default
	 */
	function wcsTriggerCheckoutUpdate() {
		if ( typeof conditional_shipping_settings != 'undefined' ) {
			$.each( conditional_shipping_settings.trigger_fields, function( index, value ) {
				$( document.body ).on( 'change', 'input[name="' + value + '"]', function() {
					$( document.body ).trigger( 'update_checkout' );
				} );

				if ( value.indexOf('shipping_') !== -1 ) {
					var billingValue = value.replace( 'shipping', 'billing' );
					if ( $.inArray( billingValue, conditional_shipping_settings.trigger_fields ) === -1 ) {
						$( document.body ).on( 'change', 'input[name="' + billingValue + '"]', function() {
							$( document.body ).trigger( 'update_checkout' );
						} );
					}
				}
			} );
		}
	}
	wcsTriggerCheckoutUpdate();
});
