function wpae_add_honeypot_field(){
	jQuery('form.mc4wp-form').append(wpa_hidden_field); //mc4wp	 
	jQuery('form.quform-form').append(wpa_hidden_field); //QU Form	 
	jQuery(wpa_hidden_field).insertAfter('input.wpae_initiator'); // For All using initiator // EED/ BuddyPress/ HTML FORMS 
	jQuery('form.avia_ajax_form').append(wpa_hidden_field); //For Avia Builder / Enfold Theme	
	jQuery('.nf-form-layout form').append(wpa_hidden_field); // FOR Ninja Forms	
	jQuery('#edd-blocks-form__register').append(wpa_hidden_field); // FOR EDD Blocks Registration Form. No hooks currently. 	
	jQuery('form.brxe-form').append(wpa_hidden_field); // FOR BRICKS BUILDER FORM
	jQuery('form.forminator-custom-form').append(wpa_hidden_field); // FOR FORMINATOR
	jQuery('form.wpmtst-submission-form').append(wpa_hidden_field); // FOR Strong Testimonial
	jQuery('form.fc-form').append(wpa_hidden_field); // For Formcraft
	jQuery('form#order_review').append(wpa_hidden_field); 
	jQuery('form.mailpoet_form').append(wpa_hidden_field); // FOR MAILPOET
	jQuery('form.wsf-form').append(wpa_hidden_field); // FOR MAILPOET	
	jQuery('form.jet-form-builder').append(wpa_hidden_field); // FOR JET FORM BUILDER
	jQuery('form.brxe-brf-pro-forms').append(wpa_hidden_field); // FOR Bricksforge
	jQuery('form.sib_signup_form').append(wpa_hidden_field); // FOR Mailin - Brevo (Send IN Blue)
	jQuery('form.youzify-membership-login-form').append(wpa_hidden_field); // Youzify Login Form
	jQuery('form.fl-contact-form').append(wpa_hidden_field); // Beaver Builder Contact Form	
	jQuery('form.srfm-form').append(wpa_hidden_field); // For Sure Forms
	jQuery('form.everest-form').append(wpa_hidden_field); // For Everest Forms
	jQuery('.bit-form form').append(wpa_hidden_field); // For Bit Forms

	if (jQuery('form.woocommerce-checkout input#wpae_initiator').length === 0) {
    	jQuery('form.woocommerce-checkout').append(wpa_hidden_field);
	}
}

jQuery(document).ready(function(){
	// GRAVITY FORMS FIXES
	jQuery(document).on('gform_post_render', function(event, form_id, current_page){
		wpae_reinitalize_after_form_load();
	});

	// FOR EASY DIGITAL DOWNLOADS
	jQuery(document).on('edd_gateway_loaded', function (gateway){ 
		wpae_reinitalize_after_form_load();
	});

	// FOR NINJA FORMS
	jQuery(document).on( 'nfFormReady', function() { 
	   	wpae_reinitalize_after_form_load();
	});

	if (typeof nfRadio !== 'undefined') { 	
		nfRadio.channel("forms").on("before:submit", function(e) {	
			$honeypotLen = jQuery('input[name='+wpa_field_name+']').length;
			if (parseInt($honeypotLen) > 0 ){
				var extra = e.get('extra');		
				extra.wpa_field_name 	= wpa_field_name
				extra.wpa_field_value 	= jQuery('input[name='+wpa_field_name+']').val();
				extra.alt_s 			= jQuery('input[name=alt_s]').val();
				e.set('extra', extra);
			}		
		});
	}
	// EOF FOR NINJA FORMS

	// FOR MAILPOET
	if (typeof MailPoet !== 'undefined' && typeof MailPoet.Ajax !== 'undefined' && typeof MailPoet.Ajax.getParams === 'function') { 
		(function(wapeMailpoetGetParams) {
		  MailPoet.Ajax.getParams = function() {
		    const wapeMailpoetParams = wapeMailpoetGetParams.call(this); // Call original function
		    wapeMailpoetParams[wpa_field_name] 		= jQuery('input[name='+wpa_field_name+']').val();
			wapeMailpoetParams.alt_s 				= jQuery('input[name=alt_s]').val();
		    return wapeMailpoetParams;
		  };
		})(MailPoet.Ajax.getParams); // Pass original function as an argument
	}
	// EOF MAILPOET	


	// FOR WS FORM	
	 jQuery(document).on('wsf-rendered', function(e, form, form_id, instance_id) {
     	wpae_reinitalize_after_form_load();
     }); 
	// EOF WS FORM

	jQuery(document).on('yith_welrp_popup_template_loaded', function(event, popup, context) { // YITH POPUP LOGIN
	    // SINCE THIS IS FOR LOGIN, REGISTER, no need to use wpae_reinitalize_after_form_load.
	    jQuery('form.yith-welrp-form').append(wpa_hidden_field);
	});

	// FOR BEAVER BUILDER
	jQuery.ajaxSetup({
        beforeSend: function(jqXHR, settings) {
            // Check if this is the contact form submit action
             if (typeof settings.data === 'string' && settings.data.includes('action=fl_builder_email')) {
                
                var wpaFieldName 	= wpa_field_name; // Assign the dynamic field name here if needed
                var wpaFieldValue 	= jQuery('input[name=' + wpaFieldName + ']').val();
                var altSValue 		= jQuery('input[name=alt_s]').val();
                
                // Append custom field data to the original ajax data
                settings.data += '&' + encodeURIComponent(wpaFieldName) + '=' + encodeURIComponent(wpaFieldValue);
                settings.data += '&alt_s=' + encodeURIComponent(altSValue);
            }
        }
    });
});

jQuery(document).ajaxComplete(function(event, xhr, settings) { //WHEN FORMS LOADED VIA AJAX
    wpae_reinitalize_after_form_load();
});

function wpae_reinitalize_after_form_load(){
	jQuery('.wpa_hidden_field').remove();
	jQuery('#altEmail_container, .altEmail_container').remove();
	wpa_add_honeypot_field();
	wpae_add_honeypot_field();
	if (wpa_add_test == 'yes'){
		wpa_add_test_block();
	}
}