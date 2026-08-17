jQuery(function ($) {

    let cuw_data = cuw_template.data;
    let cuw_i18n = cuw_template.i18n;
    let cuw_is_rtl = cuw_template.is_rtl;

    /* Offer */
    window.cuw_offer = {
        // init
        init: function () {
            this.event_listeners();
            if ($("#cuw-ppu-offer").length) {
                cuw_offer.update_ppu_totals($("#cuw-ppu-offer"));
            }
        },

        // update price when change variant
        update_price: function (select, section) {
            let variant = select.find('option:selected');
            section.find('.cuw-product-price, .cuw-page-product-price, .cuw-ppu-product-price').html(variant.data('price_html'));
            section.find('.cuw-ppu-order-totals').data('price', variant.data('price')).data('tax', variant.data('tax'));
            section.find('.cuw-qty').prop('max', variant.data('stock_qty'));
            if (variant.data('image')) {
                section.find('.cuw-product-image, .cuw-page-product-image, .cuw-ppu-product-image').html(variant.data('image'));
            }
        },

        // update the closest quantity input on click press plus or minus button
        update_quantity: function (button) {
            let wrapper = button.parent();
            let input = wrapper.find('input'),
                val = parseFloat(input.val()) || 0,
                max = parseFloat(input.attr('max')) || '',
                min = parseFloat(input.attr('min')) || 0,
                step = parseFloat(input.attr('step')) || 1;

            if (button.is('.cuw-plus')) {
                if (max && (val >= max)) input.val(max);
                else input.val(val + step);
            } else {
                if (min && (val <= min)) input.val(min);
                else if (val > 0) input.val(val - step);
            }

            val = parseFloat(input.val()); // to get current value
            wrapper.find('.cuw-minus').css('opacity', min === val ? 0.6 : 1);
            wrapper.find('.cuw-plus').css('opacity', max === val ? 0.6 : 1);
            input.trigger('change');
        },

        // to check inputting quantity
        check_quantity: function (input) {
            let product_quantity = parseInt(input.val());
            let max_quantity = parseInt(input.prop('max'));
            if (product_quantity > max_quantity) {
                input.val(max_quantity);
            }
            input.closest('.quantity-input').find('.cuw-plus').css('opacity', product_quantity >= max_quantity ? 0.6 : 1);
            input.closest('.cuw-offer, .cuw-page, .cuw-product, .cuw-product-row').find('.variant-select').trigger('change');
        },

        update_ppu_totals: function (section) {
            let qty = section.find(".cuw-ppu-product-quantity .cuw-qty").val();
            if (qty === undefined) {
                qty = section.find(".cuw-ppu-order-totals").data('qty');
            }
            let product_price = section.find(".cuw-ppu-order-totals").data('price');
            let tax = section.find(".cuw-ppu-order-totals").data('tax');
            let order_total = section.find(".cuw-ppu-order-totals").data('order_total');

            let subtotal = parseFloat(product_price) * parseFloat(qty);
            let subtotal_tax = parseFloat(tax) * parseFloat(qty);
            let updated_order_total = parseFloat(order_total) + subtotal + subtotal_tax;
            section.find(".cuw-ppu-subtotal").html(cuw_helper.format_price(subtotal));
            section.find(".cuw-ppu-tax").html(cuw_helper.format_price(subtotal_tax));
            section.find(".cuw-ppu-total").html(cuw_helper.format_price(updated_order_total));
        },

        // to load event listeners
        event_listeners: function () {
            $(document).on("click", ".cuw-offer .quantity-input .cuw-plus, .cuw-offer .quantity-input .cuw-minus", function () {
                cuw_offer.update_quantity($(this));
            });

            $(document).on("click", ".cuw-page .quantity-input .cuw-plus, .cuw-page .quantity-input .cuw-minus", function () {
                cuw_offer.update_quantity($(this));
            });

            $(document).on("change", ".cuw-offer .variant-select", function () {
                cuw_offer.update_price($(this), $(this).closest('.cuw-offer'));
            });

            $(document).on("input", '.cuw-offer .cuw-qty, #cuw-ppu-offer .cuw-qty', function () {
                cuw_offer.check_quantity($(this));
            });

            $(document).on("change", '#cuw-ppu-offer .cuw-qty', function () {
                cuw_offer.update_ppu_totals($("#cuw-ppu-offer"));
            });

            $(document).on("change", ".cuw-page .variant-select", function () {
                cuw_offer.update_price($(this), $(this).closest('.cuw-page'));
                cuw_offer.update_ppu_totals($("#cuw-ppu-offer"));
            });
        },
    }

    /* Products */
    window.cuw_products = {
        // init
        init: function () {
            this.event_listeners();
            this.load_sections();
        },

        // load all available sections
        load_sections: function () {
            $(".cuw-products").each(function (index, section) {
                cuw_products.load_section($(section));
            });
        },

        // load specific section
        load_section: function (section) {
            section.find('.variant-select').trigger('change');
            cuw_products.update_prices(section);
        },

        // get all products
        get_all_products: function (section) {
            let products = [];
            section.find('.cuw-product').each(function (index, product) {
                if ($(product).find(".cuw-product-checkbox").length || $(product).data('key')) {
                    products.push($(product));
                }
            });
            return products;
        },

        // get chosen products
        get_chosen_products: function (section) {
            let products = [];
            section.find('.cuw-product').each(function (index, product) {
                if ($(product).find(".cuw-product-checkbox").prop("checked") || $(product).data('key')) {
                    products.push($(product));
                }
            });
            return products;
        },

        // update modal product prices
        update_product_row: function (section, product_row) {
            let price_column = product_row.find('.cuw-product-price');
            let product_id = product_row.data('product_id'), variant_id;
            if (!product_id) {
                product_id = product_row.data('id');
            }

            let product = section.find('.cuw-product[data-id="' + product_id + '"]').first();
            let variant_select = product_row.find('.variant-select').first();
            if (variant_select && variant_select.length) {
                variant_id = variant_select.val();
                let variant = variant_select.find('option[value="' + variant_id + '"]').first();
                product.data('regular_price', variant.data('regular_price'));
                product.data('price', variant.data('price'));
                if (product_id) {
                    product.closest('.cuw-products').find('.cuw-product[data-id="' + product_id + '"]').data('regular_price', variant.data('regular_price'));
                    product.closest('.cuw-products').find('.cuw-product[data-id="' + product_id + '"]').data('price', variant.data('price'));
                }
                product.find('.cuw-product-variation-id').val(variant_id);
                product.find('.cuw-product-variation-attributes-json').val(JSON.stringify(variant_select.data('chosen_attributes')));
                product_row.find('.cuw-product-variation-id').val(variant_id);
                product_row.find('.cuw-qty').prop('max', variant.data('stock_qty'));
                if (variant.data('image')) {
                    if (section.data('change_image') != 'only_row') {
                        product.find('.cuw-product-image').html(variant.data('image'));
                    }
                    product_row.find('.cuw-product-image').html(variant.data('image'));
                }
                price_column.html(variant.data('price_html'));
                //price_column.html(cuw_helper.get_price_html(variant.data('price'), variant.data('regular_price')));
            } else if (price_column.html() === '') {
                price_column.html(product.find('.cuw-product-price').html());
                //price_column.html(cuw_helper.get_price_html(product.data('price'), product.data('regular_price')));
            }
        },

        // update pricing section
        update_prices: function (section, data = {}) {
            if (section.closest('.cuw-modal').length > 0) {
                section = section.closest('.cuw-modal');
            }
            let regular_price_total = 0, price_total = 0, items = 0, main_price = 0, main_item = 0, addons_price = 0,
                addon_items = 0;
            let total_items = this.get_all_products(section).length;
            let main_product_id = parseInt(section.find('[name="main_product_id"]').val());
            this.get_chosen_products(section).forEach(function (product) {
                let quantity = 1;
                if (product.find('.quantity-input .cuw-qty').length > 0) {
                    quantity = parseFloat(product.find('.quantity-input .cuw-qty').first().val());
                } else if (product.data('quantity')) {
                    quantity = parseFloat(product.data('quantity'));
                }
                if (main_product_id === product.data('id')) {
                    main_price = parseFloat(product.data('price')) * quantity;
                    main_item = 1;
                } else {
                    addons_price += parseFloat(product.data('price')) * quantity;
                    addon_items++;
                }
                regular_price_total += parseFloat(product.data('regular_price')) * quantity;
                price_total += parseFloat(product.data('price')) * quantity;
                items++;
            });

            let total_savings = regular_price_total - price_total;
            let at_least_items = parseInt(section.find(".cuw-buy-section").find(".cuw-add-to-cart").data('at_least_items')) || 1;
            if (items >= at_least_items) {
                section.find(".cuw-buy-section .cuw-message").hide();
                if (section.find(".cuw-buy-section .cuw-actions").first().data('inactive') === 'disable') {
                    section.find(".cuw-buy-section .cuw-actions").show();
                    section.find(".cuw-buy-section .cuw-actions").find(":input").prop('disabled', false);
                } else {
                    section.find(".cuw-buy-section .cuw-actions").show();
                }
                section.find(".cuw-buy-section .cuw-prices").show();

                section.find(".cuw-main-item").html(main_item);
                section.find(".cuw-addon-items").html(addon_items);
                section.find(".cuw-total-items").html(items);
                section.find(".cuw-main-price").html(cuw_helper.get_price_html(main_price));
                section.find(".cuw-addons-price").html(cuw_helper.get_price_html(addons_price));

                if (section.data('main_product_price')) {
                    regular_price_total += parseFloat(section.data('main_product_regular_price'));
                    price_total += parseFloat(section.data('main_product_price'));
                }

                section.find(".cuw-total-price").html(cuw_helper.get_price_html(price_total, regular_price_total));
                if (price_total == 0) {
                    section.find('.cuw-total-price-section').hide();
                } else {
                    section.find('.cuw-total-price-section').show();
                }
            } else {
                if (section.find(".cuw-buy-section .cuw-actions").first().data('inactive') === 'disable') {
                    section.find(".cuw-buy-section .cuw-actions").find(":input").prop('disabled', true);
                } else {
                    section.find(".cuw-buy-section .cuw-actions").hide();
                }
                section.find(".cuw-buy-section .cuw-prices").hide();
                section.find(".cuw-buy-section .cuw-message").show();
            }
            if (total_savings > 0) {
                section.find('.cuw-total-savings').not('[data-hidden="1"]').show();
                section.find('.cuw-total-savings .cuw-saved-amount').html(cuw_helper.get_price_html(total_savings));
            } else {
                section.find('.cuw-total-savings').not('[data-hidden="1"]').hide();
                section.find('.cuw-total-savings .cuw-saved-amount').html('');
            }
            if (data.cart_subtotal) {
                section.find('.cuw-cart-subtotal').html(data.cart_subtotal);
            }
            this.update_add_to_cart_text(section, items, total_items);
            this.update_cta_button(section);

            jQuery(document.body).trigger('cuw_product_prices_updated', [{
                regular_price_total: regular_price_total,
                price_total: price_total,
                items: items,
                main_item: main_item,
                main_price: main_price,
                addon_items: addon_items,
                addons_price: addons_price,
                total_savings: total_savings,
                available_items: total_items,
                other_data: data,
            }, section]);
        },

        update_cta_button: function (section) {
            let disable = false;
            this.get_chosen_products(section).forEach(function (product) {
                if (product.hasClass('is_variable')) {
                    if (product.find('.variant-select').val() === '' || product.find('.cuw-product-variation-id').val() === '') {
                        disable = true;
                        return false; // break
                    }
                }
            });
            section.find('.cuw-add-to-cart').not('[data-choose_variants="1"]').prop('disabled', disable);
        },

        // update inputs
        update_inputs: function (product, show = true) {
            let inputs = product.find(':input').not('input[type="checkbox"]');
            let product_id = product.data('id');
            if (show) {
                inputs.prop("disabled", false);
                product.css('opacity', '1');
                if (product_id) {
                    product.closest('.cuw-products').find('.cuw-product[data-id="' + product_id + '"]').css('opacity', '1');
                }
                product.find('.cuw-plus, .cuw-minus, .cuw-attributes-section').css('pointer-events', 'all');

                product.find('.cuw-remove-item-from-cart, .cuw-added-text, .cuw-added-icon').hide();
                product.find('.cuw-add-product-to-cart').show();
            } else {
                inputs.prop("disabled", true);
                product.css('opacity', '0.8');
                if (product.hasClass('cuw-recommendation-product')) {
                    product.find('.cuw-redirect-to-cart').show();
                }
                if (product_id) {
                    product.closest('.cuw-products').find('.cuw-product[data-id="' + product_id + '"]').css('opacity', '0.8');
                }
                product.find('.cuw-plus, .cuw-minus, .cuw-attributes-section').css('pointer-events', 'none');

                product.find('.cuw-add-product-to-cart').hide();
                product.find('.cuw-remove-item-from-cart, .cuw-added-text, .cuw-added-icon').show();
            }
        },

        // update add to cart text
        update_add_to_cart_text: function (section, chosen_items_count, total_items_count) {
            if (section.find(".cuw-buy-section").find(".cuw-add-to-cart").data('buy_now')) {
                return;
            }
            let text = section.find(".cuw-buy-section").find(".cuw-add-to-cart").data('text');
            if (text && !text.includes('{items_text}') && !text.includes('{items_count}')) {
                text = text;
            } else if (text && chosen_items_count > 1) {
                let items_text = '';
                let items_count = chosen_items_count + ' ' + cuw_i18n.add_to_cart.items;
                if (cuw_i18n.add_to_cart.number_to_text[chosen_items_count]) {
                    items_text = cuw_i18n.add_to_cart.number_to_text[chosen_items_count];
                } else if (chosen_items_count === total_items_count) {
                    items_text = cuw_i18n.add_to_cart.all_items;
                } else {
                    items_text = cuw_i18n.add_to_cart.selected_items;
                }
                text = text.replace('{items_text}', items_text).replace('{items_count}', items_count);
            } else {
                text = cuw_i18n.add_to_cart.text;
            }
            section.find(".cuw-add-to-cart").html(text);
        },

        // update badges
        update_badges: function (product) {
            if (product.find('.cuw-badge').data('hidden') == '1') return;

            let save_text = product.find('.cuw-badge').data('save_text');
            let regular_price = product.data('regular_price');
            let price = product.data('price');

            if (regular_price === '' || price === '' || !save_text) return;

            if (regular_price === price) {
                product.find('.cuw-badge').hide();
            } else {
                let amount = cuw_helper.format_price(regular_price - price);
                let percentage = cuw_helper.format_percentage((regular_price - price) / regular_price * 100);
                let text = save_text.replace('{price}', amount).replace('{percentage}', percentage);
                product.find('.cuw-badge').html(text).show();
            }
        },

        // update carousel actions
        carousel_update_actions: function (section) {
            let slider = section.find(".cuw-carousel-slider");
            if (slider[0].scrollLeft === 0) {
                section.find(".cuw-previous").css('opacity', 0.5);
            } else if (Math.abs(slider[0].scrollLeft) + slider[0].clientWidth == slider[0].scrollWidth) {
                section.find(".cuw-next").css('opacity', 0.5);
            } else {
                section.find(".cuw-previous, .cuw-next").css('opacity', 1);
            }
        },

        // carousel scroll items
        carousel_scroll_items: function (section, action) {
            let slider = section.find(".cuw-carousel-slider");
            let item_gap = parseInt(slider.data('gap')) || 18;
            let item_width = parseInt(slider.find(':first-child').width());
            if (action.hasClass('cuw-next')) {
                slider.animate({
                    scrollLeft: (cuw_is_rtl ? '-=' : '+=') + (item_width + item_gap),
                    behaviour: 'smooth'
                }, 10);
            } else if (action.hasClass('cuw-previous')) {
                slider.animate({
                    scrollLeft: (cuw_is_rtl ? '+=' : '-=') + (item_width + item_gap),
                    behaviour: 'smooth'
                }, 10);
            }
        },

        // to load event listeners
        event_listeners: function () {
            $(document).on("click", ".cuw-products .cuw-product-image", function () {
                let checkbox = $(this).closest(".cuw-product").find(".cuw-product-checkbox").first();
                checkbox.prop("checked", !checkbox.prop("checked")).trigger("change");
            });

            $(document).on('click', '.cuw-carousel .cuw-scroll-action', function () {
                cuw_products.carousel_scroll_items($(this).closest(".cuw-carousel"), $(this));
            });

            $('.cuw-carousel .cuw-carousel-slider').on('scroll', function () {
                cuw_products.carousel_update_actions($(this).closest(".cuw-carousel"));
            });

            $(".single_variation_wrap").on("show_variation", function (event, variation) {
                $('.cuw-product-addons').each(function (index, section) {
                    $(section).data('main_product_regular_price', variation.display_regular_price);
                    $(section).data('main_product_price', variation.display_price);
                    cuw_products.update_prices($(section));
                });
            });

            $(document).on("change", ".cuw-products .cuw-product-checkbox", function () {
                cuw_products.update_inputs($(this).closest(".cuw-product"), $(this).is(":checked"));
                cuw_products.update_prices($(this).closest(".cuw-products"));
            });

            $(document).on("click", ".cuw-products .quantity-input .cuw-plus, .cuw-products .quantity-input .cuw-minus", function () {
                cuw_offer.update_quantity($(this));
            });

            $(document).on("change", '.cuw-products .quantity-input .cuw-qty', function () {
                cuw_products.update_prices($(this).closest(".cuw-products"));
            });

            $(document).on("input", '.cuw-products .quantity-input .cuw-qty', function () {
                cuw_offer.check_quantity($(this));
            });

            $(document).on("change", ".cuw-products .variant-select", function () {
                cuw_products.update_product_row($(this).closest(".cuw-products"), $(this).closest(".cuw-product-row"));
                cuw_products.update_prices($(this).closest(".cuw-products"));
                cuw_products.update_badges($(this).closest(".cuw-product-row"));
            });

            $(document).on("cuw_products_load_section", function (event, section) {
                cuw_products.load_section(section);
            });

            $(document).on("click", '.cuw-cart-addon-products .cuw-toggle-addons', function () {
                $(this).closest(".cuw-cart-addon-products").find(".cuw-products").slideToggle();
                $(this).closest(".cuw-cart-addon-products").find(".cuw-addon-arrow-up").toggle();
                $(this).closest(".cuw-cart-addon-products").find(".cuw-addon-arrow-down").toggle();
            });

            $(document).on("click", '.cuw-attributes-select .cuw-reset-attributes', function (event) {
                event.preventDefault();
                $(this).closest('.cuw-attributes-select').find('select').each(function (index, element) {
                    $(element).html($(element).data('attribute_html'));
                });

                $(this).closest('.cuw-attributes-select').find('select').trigger('change');
            });

            $(document).on("change", '.cuw-attributes-select select', function () {
                cuw_variations.update_attributes_fields($(this).closest('.cuw-attributes-select'));

                var chosen_attributes = cuw_variations.get_chosen_attributes($(this).closest('.cuw-attributes-select'));
                var chosen_attribute_data = cuw_variations.find_matching_variants(
                    $(this).closest('.cuw-attributes-select').data('product_variations'),
                    chosen_attributes.data
                );

                var section = $(this).closest('.cuw-attributes-section');
                var variant_select = section.find('.variant-select');
                if (chosen_attribute_data.length === 1 && chosen_attributes.count === chosen_attributes.chosenCount) {
                    chosen_attribute_data = chosen_attribute_data.shift();
                    variant_select.val(chosen_attribute_data.id).prop('selected', true);
                    variant_select.data('chosen_attributes', chosen_attributes.data);
                    variant_select.trigger('change');
                    $(this).closest('.cuw-offer, .cuw-page').find('.cuw-button, .cuw-checkbox, .cuw-page-button, .cuw-ppu-accept-button')
                        .prop('disabled', false)
                        .css({'pointer-events': 'all', 'opacity': '1'});
                    $(this).closest('#cuw-ppu-offer').find('.cuw-ppu-order-totals-table').css('display', 'table');
                    $(this).closest('.cuw-product').find('.cuw-add-product-to-cart')
                        .prop('disabled', false)
                        .css({'pointer-events': 'all', 'opacity': '1'});
                } else if (chosen_attribute_data.length === 0 && chosen_attributes.count === chosen_attributes.chosenCount) {
                    // fail case, so we can ignore it
                } else {
                    variant_select.data('chosen_attributes', '[]');
                    variant_select.val('').prop('selected', true);
                    variant_select.trigger('change');
                    $(this).closest('.cuw-offer, .cuw-page').find('.cuw-button, .cuw-checkbox, .cuw-page-button, .cuw-ppu-accept-button')
                        .prop('disabled', true)
                        .css({'pointer-events': 'none', 'opacity': '0.8'});
                    $(this).closest('#cuw-ppu-offer').find('.cuw-ppu-order-totals-table').css('display', 'none');
                    $(this).closest('.cuw-product').find('.cuw-add-product-to-cart')
                        .prop('disabled', true)
                        .css({'pointer-events': 'none', 'opacity': '0.8'});
                }

                section.find('.cuw-reset-attributes').css('display', chosen_attributes.chosenCount > 0 ? 'block' : 'none');
            });
        },
    }

    /* Variation */
    window.cuw_variations = {

        update_attributes_fields: function (variation_section) {
            var product_variations = variation_section.data('product_variations');
            var currently_chosen_attributes = cuw_variations.get_chosen_attributes(variation_section).data;

            variation_section.find('select').each(function (index, element) {
                var current_attribute_select = $(element),
                    current_attribute_name = current_attribute_select.data('attribute_name'),
                    attached_options_count = 0,
                    new_attribute_select = $('<select/>'),
                    option_gt_filter = ':gt(0)',
                    selected_attribute_value = current_attribute_select.val() || '',
                    selected_attribute_value_valid = true;

                if (!current_attribute_select.data('attribute_html')) {
                    var reference_select = current_attribute_select.clone();
                    reference_select.find('option').removeAttr('attached').prop('disabled', false).prop('selected', false);
                    current_attribute_select.data('attribute_options', reference_select.find('option' + option_gt_filter).get());
                    current_attribute_select.data('attribute_html', reference_select.html());
                }

                new_attribute_select.html(current_attribute_select.data('attribute_html'));

                var check_attributes = $.extend(true, {}, currently_chosen_attributes);
                check_attributes[current_attribute_name] = '';
                var variations_data = cuw_variations.find_matching_variants(product_variations, check_attributes);

                for (var num in variations_data) {
                    if (typeof (variations_data[num]) !== 'undefined') {
                        var variation_attributes = variations_data[num].attributes;
                        for (var attribute_name in variation_attributes) {
                            if (variation_attributes.hasOwnProperty(attribute_name)) {
                                var attribute_value = variation_attributes[attribute_name], variation_active = '';
                                if (attribute_name === current_attribute_name) {
                                    if (variations_data[num].is_active) {
                                        variation_active = 'enabled';
                                    }
                                    if (attribute_value) {
                                        attribute_value = $('<div/>').html(attribute_value).text();
                                        var option_elements = new_attribute_select.find('option');
                                        if (option_elements.length) {
                                            for (var i = 0, length = option_elements.length; i < length; i++) {
                                                var option_element = $(option_elements[i]),
                                                    option_value = option_element.val();
                                                if (attribute_value === option_value) {
                                                    option_element.addClass('attached ' + variation_active);
                                                    break;
                                                }
                                            }
                                        }
                                    } else {
                                        new_attribute_select.find('option:gt(0)').addClass('attached ' + variation_active);
                                    }
                                }
                            }
                        }
                    }
                }

                attached_options_count = new_attribute_select.find('option.attached').length;

                if (selected_attribute_value) {
                    selected_attribute_value_valid = false;
                    if (0 !== attached_options_count) {
                        new_attribute_select.find('option.attached.enabled').each(function () {
                            var option_value = $(this).val();
                            if (selected_attribute_value === option_value) {
                                selected_attribute_value_valid = true;
                                return false;
                            }
                        });
                    }
                }

                if (attached_options_count > 0 && selected_attribute_value && selected_attribute_value_valid) {
                    new_attribute_select.find('option:first').remove();
                    option_gt_filter = '';
                }

                new_attribute_select.find('option' + option_gt_filter + ':not(.attached)').remove();

                current_attribute_select.html(new_attribute_select.html());
                current_attribute_select.find('option' + option_gt_filter + ':not(.enabled)').prop('disabled', true);

                if (selected_attribute_value) {
                    if (selected_attribute_value_valid) {
                        current_attribute_select.val(selected_attribute_value);
                    } else {
                        current_attribute_select.val('').trigger('change');
                    }
                } else {
                    current_attribute_select.val('');
                }
            });
        },

        find_matching_variants: function (variations_data, attributes) {
            var matching = [];
            for (var i = 0; i < variations_data.length; i++) {
                var variation = variations_data[i];

                if (cuw_variations.is_attributes_match(variation.attributes, attributes)) {
                    matching.push(variation);
                }
            }
            return matching;
        },

        is_attributes_match: function (variation_attributes, attributes) {
            var match = true;
            for (var attr_name in variation_attributes) {
                if (variation_attributes.hasOwnProperty(attr_name)) {
                    var value_1 = variation_attributes[attr_name];
                    var value_2 = attributes[attr_name];
                    if (value_1 !== undefined && value_2 !== undefined && value_1.length !== 0 && value_2.length !== 0 && value_1 !== value_2) {
                        match = false;
                    }
                }
            }
            return match;
        },

        get_chosen_attributes: function (variation_section) {
            var data = {}, count = 0, chosen = 0;
            variation_section.find('select').each(function (index, element) {
                var attribute_name = $(element).data('attribute_name');
                var value = $(element).val() || '';
                if (value.length > 0) {
                    chosen++;
                }
                count++;
                data[attribute_name] = value;
            });
            return {
                'count': count,
                'chosenCount': chosen,
                'data': data,
            };
        },
    }

    /* Helper */
    window.cuw_helper = {
        // format price
        format_price: function (price, tag = '') {
            price = parseFloat(price).toFixed(cuw_data.woocommerce.price.decimals);
            price = price.replace(".", cuw_data.woocommerce.price.decimal_separator);
            let split = price.split(cuw_data.woocommerce.price.decimal_separator);
            split[0] = split[0].replace(/\B(?=(\d{3})+(?!\d))/g, cuw_data.woocommerce.price.thousand_separator);
            price = split.join(cuw_data.woocommerce.price.decimal_separator);
            price = cuw_data.woocommerce.price.format.replace('%1$s', cuw_data.woocommerce.price.symbol).replace('%2$s', price);
            return tag ? '<' + tag + '>' + price + '</' + tag + '>' : price;
        },

        // get price html
        get_price_html: function (price, regular_price = null) {
            if (regular_price && regular_price > price) {
                return this.format_price(regular_price, 'del') + ' ' + this.format_price(price, 'ins');
            }
            return this.format_price(price, 'ins');
        },

        // get discount text
        get_discount_text: function (discount_type, discount_value) {
            let discount_text = '';
            if (discount_type === 'percentage' && discount_value !== '') {
                discount_text = cuw_helper.format_percentage(discount_value);
            } else if (discount_type === 'fixed_price' && discount_value !== '') {
                discount_text = cuw_helper.format_price(discount_value);
            } else if (discount_type === 'free') {
                discount_text = cuw_i18n.free;
            }
            return discount_text;
        },

        // to format discount percentage
        format_percentage: function (price, round = true) {
            if (price === '') return price;

            if (round) {
                price = Math.round(price * 100) / 100;
                price = price.toFixed(2);
                price = price.replace(/\.?0+$/, '');
            }
            return price += '%';
        },
    }

    /* Spinner */
    window.cuw_spinner = {
        // show spinner
        show: function (section) {
            if (typeof section === 'string') {
                section = $(section).first();
            }
            if (section.block) {
                $(section).block({message: null, overlayCSS: {background: '#fff', opacity: 0.6}});
            }
        },

        // hide spinner
        hide: function (section) {
            if (typeof section === 'string') {
                section = $(section).first();
            }
            if (section.unblock) {
                $(section).unblock();
            }
        }
    }

    /* Model */
    window.cuw_modal = {
        // show modal
        show: function (modal, temp = false) {
            if (typeof modal === 'string') {
                modal = $(modal).first();
            }
            modal.show();
            modal.find('.cuw-modal-close').click(function () {
                temp ? modal.remove() : modal.hide()
            });
            $(window).click(function (event) {
                if ($(event.target).hasClass('cuw-modal')) {
                    temp ? modal.remove() : modal.hide()
                }
            });
            $(document).keydown(function (event) {
                if (event.keyCode === 27) {
                    temp ? modal.remove() : modal.hide()
                }
            });
        },

        // hide modal
        hide: function (modal) {
            if (typeof modal === 'string') {
                modal = $(modal).first();
            }
            modal.hide();
        }
    }

    /* Init */
    $(document).ready(function () {
        cuw_offer.init();
        cuw_products.init();
    });

});