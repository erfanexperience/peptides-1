jQuery(function ($) {

    let cuw_ajax_url = cuw_frontend.ajax_url;
    let cuw_ajax_nonce = cuw_frontend.ajax_nonce;
    let cuw_is_cart = (cuw_frontend.is_cart == '1');
    let cuw_is_checkout = (cuw_frontend.is_checkout == '1');
    let cuw_has_cart_block = (cuw_frontend.has_cart_block == '1');
    let cuw_has_checkout_block = (cuw_frontend.has_checkout_block == '1');
    let cuw_dynamic_offer_display_enabled = (cuw_frontend.dynamic_offer_display_enabled == '1');

    var cuw_page_action_performing = false;

    /* Actions */
    window.cuw_actions = {
        // add offer to cart
        add_offer_to_cart: function (offer) {
            let offer_id = offer.data('id');
            if (!offer_id) {
                return;
            }

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'add_offer_to_cart',
                    offer_id: offer_id,
                    quantity: offer.find('[name="quantity"]').val() || 1,
                    variation_id: offer.find('[name="variation_id"]').val() || 0,
                    variation_attributes: offer.find('[name="variation_id"]').data('chosen_attributes') || [],
                    location: offer.closest('.cuw-offers').data('location') || '',
                    nonce: cuw_ajax_nonce || ''
                },
                beforeSend: function () {
                    cuw_spinner.show(offer);
                    offer.find('.cuw-offer :input').prop('disabled', true);
                },
                success: function (response) {
                    if (response.success && response.data) {
                        jQuery(document.body).trigger('cuw_offer_added_to_cart', [response.data, offer]);

                        cuw_actions.update_fragments();

                        if (response.data.cart_item_key) {
                            offer.data('cart_item_key', response.data.cart_item_key);
                            offer.addClass('cuw-offer-added');
                            offer.find('.cuw-offer-cta-section .cuw-offer-cta-text').hide();
                            offer.find('.cuw-offer-cta-section .cuw-offer-added-text').show();
                            offer.find('.cuw-product-quantity, .cuw-product-variants').css('pointer-events', 'none');
                            offer.find('.cuw-product-quantity, .cuw-product-variants').css('opacity', '0.8');
                        } else {
                            offer.find('.cuw-checkbox').prop('checked', false);
                        }

                        if (response.data.remove_offer) {
                            if (response.data.notice) {
                                $(response.data.notice).insertBefore(offer);
                            }
                            offer.fadeOut(1000, function () {
                                $(this).remove();
                            });
                        } else {
                            cuw_spinner.hide(offer);
                        }

                        if (response.data.remove_all_offers) {
                            $('.cuw-offer').fadeOut(1000, function () {
                                $(this).remove();
                            });
                        }
                    }
                    offer.find('.cuw-offer :input').prop('disabled', false);
                }
            });
        },

        remove_offer_from_cart: function (offer) {
            let key = offer.data('cart_item_key');
            if (!key) {
                return;
            }

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'remove_item_from_cart',
                    item_key: key,
                    nonce: cuw_ajax_nonce || ''
                },
                beforeSend: function () {
                    cuw_spinner.show(offer);
                },
                success: function (response) {
                    cuw_actions.update_fragments();
                    if (response.data.item_removed) {
                        offer.removeClass('cuw-offer-added');
                        offer.find('.cuw-offer-cta-section .cuw-offer-added-text').hide();
                        offer.find('.cuw-offer-cta-section .cuw-offer-cta-text').show();
                        offer.find('.cuw-product-quantity, .cuw-product-variants').css('pointer-events', 'all');
                        offer.find('.cuw-product-quantity, .cuw-product-variants').css('opacity', '1.0');
                    }
                    cuw_spinner.hide(offer);
                },
            });
        },

        // perform action
        perform_action: function (action) {
            let params = action.data();
            params.checked = action.find('input[type=checkbox]').is(':checked');

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'perform_action',
                    params: params,
                    nonce: cuw_ajax_nonce || ''
                },
                beforeSend: function () {
                    cuw_spinner.show(action);
                    $('.cuw-action :input').prop('disabled', true);
                },
                success: function (response) {
                    if (response.success && response.data) {
                        jQuery(document.body).trigger('cuw_action_performed', [response.data, action]);

                        if (response.data.reload_page) {
                            location.reload(true); // to reload page if requires.
                        }

                        if (response.data.trigger) {
                            jQuery(document.body).trigger(response.data.trigger, {});
                        }

                        cuw_spinner.hide(action);

                        if (!response.data.remove) {
                            action.find('input[type=checkbox]').prop('checked', response.data.checked ? true : false);
                            action.data('lock', response.data.lock ? true : false);
                        } else {
                            action.remove();
                        }
                    }
                    $('.cuw-action :input').prop('disabled', false);
                }
            });
        },

        // to perform post-purchase upsells action
        perform_ppu_action: function (action) {
            cuw_spinner.show($('#cuw-ppu-offer'));
            $('#cuw-ppu-offer [name="cuw_ppu_action"]').val(action);
            $('#cuw-ppu-offer').submit();
        },

        // add chosen products to cart
        add_products_to_cart: function (section, choose_variants = false) {
            if (choose_variants) {
                let chosen_product_ids = [];
                let chosen_variable_product_ids = [];
                cuw_products.get_chosen_products(section).forEach(function (product) {
                    chosen_product_ids.push(product.data('id'));
                    if (product.hasClass('is_variable')) {
                        chosen_variable_product_ids.push(product.data('id'));
                    }
                });
                if (chosen_variable_product_ids.length > 0) {
                    let modal = section.find('.cuw-modal').first();
                    modal.find('.cuw-product-row').each(function (index, row) {
                        if (chosen_product_ids.includes($(row).data('product_id'))) {
                            cuw_products.update_product_row(section, $(row));
                            $(row).show();
                        } else {
                            $(row).hide();
                        }
                    });
                    cuw_products.update_prices(section);
                    cuw_modal.show(modal);
                } else {
                    this.add_products_to_cart(section, false);
                }
            } else {
                cuw_spinner.show(section.find(".cuw-buy-section, .cuw-modal-content"));
                section.find('form').submit();
            }
        },

        // add product to cart
        add_product_to_cart: function (section, product) {
            let page = this.get_page(section);

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'add_product_to_cart',
                    campaign_id: section.data('campaign_id') || 0,
                    product_id: product.data('id') || 0,
                    quantity: product.find('[name="quantity"]').val() || 1,
                    variation_id: product.find('[name="variation_id"]').val() || 0,
                    variation_attributes: product.find('[name="variation_id"]').data('chosen_attributes') || [],
                    page: page,
                    nonce: cuw_ajax_nonce || ''
                },
                beforeSend: function () {
                    cuw_spinner.show(product);
                    product.find('.cuw-add-product-to-cart, .cuw-remove-item-from-cart').prop('disabled', true).css('opacity', 0.8);
                },
                success: function (response) {
                    if (response.success && response.data) {
                        if (response.data.item_key && response.data.cart_subtotal) {
                            product.data('key', response.data.item_key);
                            cuw_products.update_inputs(product, false);
                            cuw_products.update_prices(section, response.data);
                            cuw_actions.update_fragments(page);
                        }
                    }
                    cuw_spinner.hide(product);
                    product.find('.cuw-add-product-to-cart, .cuw-remove-item-from-cart').prop('disabled', false).css('opacity', 1);
                },
            });
        },

        // remove item from cart
        remove_item_from_cart: function (section, product) {
            let key = product.data('key');
            if (!key) {
                return;
            }

            let page = this.get_page(section);

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'remove_item_from_cart',
                    item_key: key,
                    page: page,
                    nonce: cuw_ajax_nonce || ''
                },
                beforeSend: function () {
                    cuw_spinner.show(product);
                    product.find('.cuw-add-product-to-cart, .cuw-remove-item-from-cart').prop('disabled', true).css('opacity', 0.8);
                },
                success: function (response) {
                    if (response.success && response.data) {
                        if (response.data.item_removed && response.data.cart_subtotal) {
                            product.data('key', '');
                            cuw_products.update_inputs(product, true);
                            cuw_products.update_prices(section, response.data);
                            cuw_actions.update_fragments(page);
                        }
                    }
                    cuw_spinner.hide(product);
                    product.find('.cuw-add-product-to-cart, .cuw-remove-item-from-cart').prop('disabled', false).css('opacity', 1);
                },
            });
        },

        // add addon product to cart
        add_addon_to_cart: function (section, product) {
            let wrapper = product;
            if (product.closest('.cart_item').length) {
                wrapper = product.closest('.cart_item');
            }

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'add_addon_to_cart',
                    campaign_id: section.data('campaign_id') || 0,
                    product_id: product.data('id') || 0,
                    quantity: section.data('quantity') || 0,
                    variation_id: product.data('variant_id') || product.val() || 0,
                    main_item_key: section.data('main_item_key') || '',
                    nonce: cuw_ajax_nonce || ""
                },
                beforeSend: function () {
                    cuw_spinner.show(wrapper);
                },
                success: function (response) {
                    if (response.success && response.data && response.data.item_key) {
                        cuw_actions.update_fragments('cart');
                    }
                    cuw_spinner.hide(wrapper);
                },
            });
        },

        // remove addon item from cart
        remove_addon_from_cart: function (section, product) {
            let key = product.data('item_key');
            if (!key) {
                return;
            }

            let wrapper = product;
            if (product.closest('.cart_item').length) {
                wrapper = product.closest('.cart_item');
            }

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'remove_addon_from_cart',
                    item_key: key,
                    nonce: cuw_ajax_nonce || ""
                },
                beforeSend: function () {
                    cuw_spinner.show(wrapper);
                },
                success: function (response) {
                    if (response.success && response.data) {
                        cuw_actions.update_fragments('cart');
                    }
                    cuw_spinner.hide(wrapper);
                    product.data('lock', false);
                },
            });
        },

        // change cart item variant
        change_cart_item_variant: function (section, variant) {
            let key = section.data('item_key');
            if (!key) {
                return;
            }

            let wrapper = variant;
            if (variant.closest('.cart_item').length > 0) {
                wrapper = variant.closest('.cart_item');
            }

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'change_cart_item_variant',
                    item_key: key,
                    variation_id: variant.val() || 0,
                    nonce: cuw_ajax_nonce || ""
                },
                beforeSend: function () {
                    cuw_spinner.show(wrapper);
                },
                success: function (response) {
                    if (response.success && response.data) {
                        cuw_actions.update_fragments('cart');
                    }
                    cuw_spinner.hide(wrapper);
                },
            });
        },

        // to get page
        get_page: function (section = null) {
            let page = '';
            if (section !== null) {
                page = section.data('page') ? section.data('page') : section.closest('.cuw-modal').data('page');
            }
            return page;
        },

        // to update page fragments
        update_fragments: function (page = '') {
            if (page === 'cart' || cuw_is_cart) {
                jQuery(document.body).trigger('wc_update_cart');
                jQuery(document.body).trigger('cuw_cart_page_updated');
            } else if (page === 'checkout' || cuw_is_checkout) {
                jQuery(document.body).trigger('update_checkout');
                jQuery(document.body).trigger('cuw_checkout_page_updated');
            } else {
                jQuery(document.body).trigger('wc_fragment_refresh');
                jQuery(document.body).trigger('cuw_fragment_refreshed');
            }

            if (cuw_has_cart_block || cuw_has_checkout_block) {
                setTimeout(function () {
                    jQuery(document.body).trigger('added_to_cart', {});
                }, 0);
            }
        },

        // to get the product details in popup
        show_product_details_popup: function (section, product_id) {
            cuw_spinner.show(section);

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: false,
                data: {
                    action: 'cuw_ajax',
                    method: 'get_product_details_popup',
                    product_id: product_id,
                    nonce: cuw_ajax_nonce || ''
                },
                success: function (response) {
                    if (response.data.html) {
                        $('body').append(response.data.html);
                        cuw_modal.show($('#cuw-modal-product-details-' + product_id), true);
                        $('#cuw-modal-product-details-' + product_id + ' .variant-select').trigger('change');
                    }
                    cuw_spinner.hide(section);
                },
            });
        },

        // to update the product image
        update_product_image: function (section, product_id) {
            cuw_spinner.show(section.find(".cuw-product-image"));

            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                async: true,
                data: {
                    action: 'cuw_ajax',
                    method: 'get_offer_image',
                    product_id: product_id,
                    nonce: cuw_ajax_nonce || ''
                },
                success: function (response) {
                    cuw_spinner.hide(section.find('.cuw-product-image'));
                    if (response.data.html) {
                        if (section.find('.cuw-product-image a').length > 0) {
                            section.find('.cuw-product-image a').html(response.data.html);
                        } else {
                            section.find('.cuw-product-image').html(response.data.html);
                        }
                    }
                },
            });
        },
    }

    $(document).on("change", ".cuw-product-addons .cuw-product .cuw-product-checkbox", function () {
        let addons_count = $('.cuw-product-addons .cuw-product-checkbox:checked').length;
        $('.cuw-product-addons-pricing-section').css('display', (addons_count > 0 ? 'flex' : 'none'));
        $(this).closest('.cuw-product').find('.cuw-product-quantity').toggle($(this).prop('checked'));
        $(this).closest('.cuw-product').find('.cuw-product-variants').toggle($(this).prop('checked'));
    });

    $(document).on("click", ".cuw-modal-product-detail", function () {
        cuw_actions.show_product_details_popup($(this).closest('.cuw-container'), $(this).data('id'));
    });

    $(document).on("click", ".cuw-products .cuw-product .cuw-add-product-to-cart", function () {
        cuw_actions.add_product_to_cart($(this).closest('.cuw-products'), $(this).closest('.cuw-product'));
    });

    $(document).on("change", ".cuw-cart-item-variants .variant-select", function () {
        cuw_actions.change_cart_item_variant($(this).closest('.cuw-cart-item-variants'), $(this).find("option:selected"));
    });

    $(document).on("click", ".cuw-products .cuw-product .cuw-remove-item-from-cart", function () {
        cuw_actions.remove_item_from_cart($(this).closest('.cuw-products'), $(this).closest('.cuw-product'));
    });

    $(document).on("click", ".cuw-cart-addon-products .cuw-products .cuw-product input[type=checkbox]", function () {
        if ($(this).is(":checked")) {
            cuw_actions.add_addon_to_cart($(this).closest('.cuw-products'), $(this).closest('.cuw-product'));
        } else {
            cuw_actions.remove_addon_from_cart($(this).closest('.cuw-products'), $(this).closest('.cuw-product'));
        }
    });

    $(document).on("click", ".cuw-offer input[type=checkbox], .cuw-offer button", function () {
        let offer = $(this).closest('.cuw-offer');
        if (!offer.hasClass('cuw-offer-added')) {
            cuw_actions.add_offer_to_cart(offer);
        } else {
            cuw_actions.remove_offer_from_cart(offer);
        }
    });

    $(document).on("click", ".cuw-action input[type=checkbox], .cuw-action button", function () {
        cuw_actions.perform_action($(this).closest('.cuw-action'));
    });

    $(document).on("click", ".cuw-products .cuw-add-to-cart", function () {
        cuw_actions.add_products_to_cart($(this).closest(".cuw-products"), $(this).data('choose_variants') == '1');
    });

    $(".cuw-page .cuw-qty").change(function () {
        $(".cuw-page .cuw-qty").val($(this).val());
        $('.cuw-hidden-product-quantity').val($(this).val());
    }).trigger('change');

    $(".cuw-page .variant-select").change(function () {
        $(".cuw-page .variant-select").val($(this).val());
        $('.cuw-hidden-product-variant').val($(this).val());
    }).trigger('change');

    $(".cuw-page-offer-form, .cuw-page-offer-accept").submit(function () {
        cuw_spinner.show($(this));
        cuw_page_action_performing = true;
    });

    $(".cuw-offer-decline-link").click(function () {
        cuw_page_action_performing = true;
        $(".cuw-offer-decline-link").css({'pointer-events': 'none', 'opacity': '0.8'});
    });

    $("#cuw-ppu-offer .cuw-ppu-ignore-offers").click(function () {
        cuw_actions.perform_ppu_action('ignore_offers');
    });

    $("#cuw-ppu-offer .cuw-ppu-accept-button").click(function () {
        cuw_actions.perform_ppu_action('accept_offer');
    });

    $("#cuw-ppu-offer .cuw-ppu-decline-button, #cuw-ppu-offer .cuw-ppu-decline-link").click(function () {
        cuw_actions.perform_ppu_action('decline_offer');
    });

    jQuery(document.body).on('click', '.cuw-custom-trigger', function () {
        cuw_spinner.show($(this).closest('.cuw-modal').find('.cuw-modal-body'));
        $($(this).data('target')).trigger($(this).data('event'));
    });

    jQuery(document.body).on('cuw_update_offers', function (event, campaign_type = '') {
        if ($('.cuw-offers').length === 0 || campaign_type === '') {
            return;
        }

        $.ajax({
            type: 'post',
            url: cuw_ajax_url,
            async: false,
            data: {
                action: 'cuw_ajax',
                method: 'get_all_offers_html',
                campaign_type: campaign_type,
                nonce: cuw_ajax_nonce || ''
            },
            success: function (response) {
                if (response.data && response.data.html) {
                    $.each(response.data.html, function (location, html) {
                        $('.cuw-offers[data-location="' + location + '"]').html(html);
                    });
                }
            },
        });
    });

    if (cuw_dynamic_offer_display_enabled) {
        if (cuw_is_cart || cuw_has_cart_block) {
            jQuery(document.body).on('applied_coupon removed_coupon', function () {
                jQuery(document.body).trigger('cuw_update_offers', ['cart_upsells']);
            });
        } else if (cuw_is_checkout || cuw_has_checkout_block) {
            jQuery(document.body).on('applied_coupon_in_checkout removed_coupon_in_checkout', function () {
                jQuery(document.body).trigger('cuw_update_offers', ['checkout_upsells']);
            });
        }
    }

    jQuery(document.body).on('cuw_show_upsell_popup', function (event, data, element) {
        if (data.dynamic_content) {
            $.ajax({
                type: 'post',
                url: cuw_ajax_url,
                data: {
                    action: 'cuw_ajax',
                    method: 'get_upsell_popup',
                    campaign_id: data.campaign_id,
                    product_id: data.product_id,
                    trigger: data.trigger,
                    page: data.page,
                    nonce: cuw_ajax_nonce || ''
                },
                success: function (response) {
                    if (response.success && response.data && response.data.campaign_id && response.data.html) {
                        let campaign_id = response.data.campaign_id;
                        if ($('#cuw-modal-' + campaign_id).length > 0) {
                            $('#cuw-modal-' + campaign_id).find('.cuw-cart-subtotal').html(response.data.cart_subtotal);
                        } else {
                            $('body').append(response.data.html);
                        }

                        cuw_modal.show($('#cuw-modal-' + campaign_id), true);

                        // to add scroll action event listener
                        if (cuw_products && cuw_products.carousel_update_actions) {
                            $('#cuw-modal-' + campaign_id + ' .cuw-carousel .cuw-carousel-slider').on('scroll', function () {
                                cuw_products.carousel_update_actions($(this).closest(".cuw-carousel"));
                            });
                        }
                    }
                },
            });
        } else if (data.campaign_id) {
            let modal = $('#cuw-modal-' + data.campaign_id);
            if (modal.length > 0) {
                modal.data('shown', true);
                cuw_modal.show(modal);
            }
        }
    });

    jQuery(document.body).on('checkout_error', function () {
        cuw_modal.hide('.cuw-modal');
    });

    let messages = $(".cuw-page-timer");
    if (messages.length > 0) {
        let element = messages.first();
        let message = element.data('message');
        let params = new URLSearchParams(window.location.search);
        let unique_id = params.get('cuw_order_id');
        if (params.get('cuw_ppu_offer')) {
            unique_id = params.get('cuw_ppu_offer') + '_' + (params.get('cuw_order') || '');
        }
        if (!unique_id) {
            return;
        }
        let duration = (element.data('minutes') * 60) + element.data('seconds'), minutes, seconds;
        if (Cookies && unique_id) {
            let duration_from_cookie = Cookies.get("cuw_timer_" + unique_id);
            if (duration_from_cookie !== undefined) {
                duration = duration_from_cookie;
            }
        }
        setInterval(function () {
            if (duration >= 0) {
                minutes = parseInt(duration / 60, 10);
                seconds = parseInt(duration % 60, 10);
                minutes = minutes < 10 ? "0" + minutes : minutes;
                seconds = seconds < 10 ? "0" + seconds : seconds;
                messages.html(message.replace('{minutes}', minutes).replace('{seconds}', seconds));
                if (duration === 0) {
                    if (params.get('cuw_ppu_offer')) {
                        cuw_actions.perform_ppu_action('decline_offer');
                    } else if (!cuw_page_action_performing) {
                        window.location = element.data('redirect');
                    }
                }
                if (Cookies && unique_id) {
                    Cookies.set("cuw_timer_" + unique_id, duration);
                }
                duration--;
            }
        }, 1000);
    }

});