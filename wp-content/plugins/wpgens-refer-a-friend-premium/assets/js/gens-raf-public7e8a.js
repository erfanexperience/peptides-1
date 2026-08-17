/* eslint-disable */
(function ($) {
    'use strict';

    function gensRafValidateEmail(email) {
        var re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
        return re.test(String(email).toLowerCase());
    }

    function gens_set_cookie(name, value, days) {
        var expires = '';
        if (days) {
            var date = new Date();
            date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
            expires = '; expires=' + date.toUTCString();
        }
        document.cookie = name + '=' + (value || '') + expires + '; path=/';
    }

    function gens_get_cookie(name) {
        var nameEQ = name + "=";
        var ca = document.cookie.split(';');
        for(var i=0;i < ca.length;i++) {
            var c = ca[i];
            while (c.charAt(0)==' ') c = c.substring(1,c.length);
            if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
        }
        return null;
    }

    //Javascript GET cookie parameter
    const urlParams = new URLSearchParams(window.location.search);
    const myParam = urlParams.get('raf');
    var $_GET = {};
    document.location.search.replace(/\??(?:([^=]+)=([^&]*)&?)/g, function () {
        function decode(s) {
            return decodeURIComponent(s.split('+').join(' '));
        }

        $_GET[decode(arguments[1])] = decode(arguments[2]);
    });

    // Get time var defined in woo backend
    var $time = 1;
    if (typeof gens_raf !== 'undefined' && gens_raf.cookieTime !== '') {
        $time = parseInt(gens_raf.cookieTime);
    }

    //If raf is set, add cookie.
    if ((typeof $_GET['raf'] !== 'undefined' && $_GET['raf'] !== null) || myParam) {
        //console.log(window.location.hostname);
        gens_set_cookie('gens_raf', myParam ? myParam : $_GET['raf'], $time);
    }

    if (typeof gens_raf.modal !== 'undefined' && gens_raf.modal) {
        const delay = gens_raf.modal_delay ? gens_raf.modal_delay * 1000 : 0;
        setTimeout(function () {
            const modalElement = document.getElementById('raf-modal');
            if (modalElement) {
                modalElement.style.display = 'flex';
            }
        }, delay);
    }

    // Share Shortcode
    $.fn.rafSocShare = function (opts) {
        var $this = this;

        opts = $.extend(
            {
                attr: 'href',
                linked_in: false,
                pinterest: false,
                whatsapp: false,
            },
            opts
        );

        for (var opt in opts) {
            if (opts[opt] === false) {
                continue;
            }

            switch (opt) {
                case 'facebook':
                    var url = 'https://www.facebook.com/sharer/sharer.php?u=';
                    var name = 'Facebook';
                    _popup(url, name, opts[opt], 400, 640);
                    break;

                case 'twitter':
                    var posttitle = $('.gens-referral_share__tw').data('title');
                    var via = $('.gens-referral_share__tw').data('via');
                    var url = 'https://twitter.com/intent/tweet?via=' + via + '&text=' + encodeURIComponent(posttitle) + '&url=';
                    var name = 'Twitter';
                    _popup(url, name, opts[opt], 440, 600);
                    break;

                case 'whatsappDesktop':
                    var posttitle = $('.gens-referral_share__wade').data('title');
                    var url = 'whatsapp://send?text=' + encodeURIComponent(posttitle) + '%20';
                    var name = 'WhatsApp Desktop';
                    _popup(url, name, opts[opt], 600, 600);
                    break;

                case 'linked_in':
                    var url = 'https://www.linkedin.com/shareArticle?mini=true&url=';
                    var name = 'LinkedIn';
                    _popup(url, name, opts[opt], 570, 520);
                    break;

                case 'pinterest':
                    var url = 'https://www.pinterest.com/pin/create/link/?url=';
                    var name = 'Pinterest';
                    _popup(url, name, opts[opt], 500, 800);
                    break;

                case 'whatsapp':
                    var posttitle = $('.gens-referral_share__wa').data('title');
                    var name = 'Whatsapp';
                    var url = 'whatsapp://send?text=' + encodeURIComponent(posttitle) + '%20';
                    _popup(url, name, opts[opt], 500, 800);
                    break;

                case 'viber':
                    var posttitle = $('.gens-referral_share__viber').data('title');
                    var name = 'Whatsapp';
                    var url = 'viber://forward?text=' + encodeURIComponent(posttitle) + '%20';
                    _popup(url, name, opts[opt], 500, 800);
                    break;

                default:
                    break;
            }
        }

        function _popup(url, name, opt, height, width) {
            if (opt !== false && $this.find(opt).length) {
                $this.on('click', opt, function (e) {
                    e.preventDefault();

                    var top = screen.height / 2 - height / 2;
                    var left = screen.width / 2 - width / 2;
                    var share_link = $(this).attr(opts.attr);

                    if (name === 'Whatsapp') {
                        window.location = url + encodeURIComponent(share_link) + '%20';
                        return true;
                    } else if (name === 'WhatsApp Desktop') {
                        window.open(url, name, 'menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=' + height + ',width=' + width + ',top=' + top + ',left=' + left);
                    } else {
                        window.open(
                            url + encodeURIComponent(share_link),
                            name,
                            'menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=' + height + ',width=' + width + ',top=' + top + ',left=' + left
                        );
                    }

                    return false;
                });
            }
        }
        return;
    };

    function gensCopyText(text) {
        function selectElementText(element) {
            if (document.selection) {
                var range = document.body.createTextRange();
                range.moveToElementText(element);
                range.select();
            } else if (window.getSelection) {
                var range = document.createRange();
                range.selectNode(element);
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
            }
        }
        var element = document.createElement('DIV');
        element.textContent = text;
        element.style.backgroundColor = '#fff';
        element.style.color = '#000';
        document.body.appendChild(element);
        selectElementText(element);
        document.execCommand('copy');
        element.remove();
    }

    function checkAndRestoreReferralState() {
        // Check if user previously generated their own referral code
        var generatedCode = gens_get_cookie('gens_raf_generated');
        var legacyCode = gens_get_cookie('gens_raf_guest');
        var hasGuestReferral = false;
        var referralLink = '';
        
        // Check for user's own generated codes
        if (generatedCode && generatedCode.indexOf('ref') === 0) {
            hasGuestReferral = true;
            referralLink = window.location.origin + '/?raf=' + generatedCode;
        }
        // Check for legacy guest referral system
        else if (legacyCode) {
            hasGuestReferral = true;
            referralLink = window.location.origin + '/?raf=' + encodeURIComponent(legacyCode);
        }
        
        // Handle guest referral sections
        if (hasGuestReferral) {
            // Update referral link display
            $('.gens-raf__url strong').text(referralLink);
            
            // Update input field if exists
            const input = $('.gens-raf-field--link');
            if (input.length) {
                input.val(referralLink);
            }
            
            // Update share links
            $('.gens-referral_share')
                .find('a')
                .each(function () {
                    var $href = $(this).attr('href');
                    if ($href) {
                        // Replace existing raf parameter or add new one
                        var newHref = $href.replace(/(\?|&)raf=[^&]*/, '');
                        var codeToUse = generatedCode || legacyCode;
                        newHref += (newHref.indexOf('?') === -1 ? '?' : '&') + 'raf=' + encodeURIComponent(codeToUse);
                        $(this).attr('href', newHref);
                    }
                });
            
            // Update data attributes
            $('.gens-refer-a-friend').attr('data-link', referralLink);
            
            // Show guest referral section, hide generation form
            $('.gens-refer-a-friend--guest').addClass('raf-show-guest');
            $('.gens-refer-a-friend--generate').removeClass('raf-show-generate');
        } else {
            // No guest referral - show generation form (includes disabled message when guests not allowed)
            $('.gens-refer-a-friend--generate').addClass('raf-show-generate');
            $('.gens-refer-a-friend--guest').removeClass('raf-show-guest');
        }
    }

    function populateEmailFromURL() {
        // Check for email and name parameters in URL
        const urlParams = new URLSearchParams(window.location.search);
        const emailParam = urlParams.get('email');
        const nameParam = urlParams.get('name');
        
        // Check for order data in data attributes (thank you page context)
        const $container = $('.gens-refer-a-friend, .gens-refer-a-friend--generate');
        const orderEmail = $container.attr('data-order-email');
        const orderName = $container.attr('data-order-name');
        
        // Prioritize order data over URL params (thank you page takes precedence)
        const finalEmail = orderEmail || emailParam;
        const finalName = orderName || nameParam;
        
        if (finalEmail && gensRafValidateEmail(finalEmail)) {
            // Only populate if user doesn't already have a generated referral code
            var generatedCode = gens_get_cookie('gens_raf_generated');
            var legacyCode = gens_get_cookie('gens_raf_guest');
            
            if (!generatedCode && !legacyCode) {
                // Populate the guest email field
                $('.gens-raf-guest-email').val(finalEmail);
                
                // Populate the name field if available
                if (finalName) {
                    $('.gens-raf-guest-name').val(finalName);
                }
                
                // Auto-generate the referral form immediately
                setTimeout(function() {
                    // Check if we can generate automatically (guest email field exists and is visible)
                    var $emailField = $('.gens-raf-guest-email');
                    var $nameField = $('.gens-raf-guest-name');
                    var $generateButton = $('.gens-raf-generate-link');
                    
                    if ($emailField.length && $generateButton.length && $emailField.is(':visible')) {
                        // Clear any existing error messages before auto-generation
                        $('.gens-raf-error-message').remove();
                        // Trigger the generation automatically
                        $generateButton.trigger('click');
                    }
                }, 100);
            }
        }
    }

    jQuery(document).ready(function () {
        // Check for existing referral code in cookie and restore state
        checkAndRestoreReferralState();
        
        // Populate email field from URL parameter if present
        populateEmailFromURL();
        
        $('.gens-referral_share').rafSocShare({
            facebook: '.gens-referral_share__fb',
            twitter: '.gens-referral_share__tw',
            whatsappDesktop: '.gens-referral_share__wade',
            linked_in: '.gens-referral_share__ln',
            pinterest: '.gens-referral_share__pin',
            whatsapp: '.gens-referral_share__wa',
            viber: '.gens-referral_share__viber',
        });

        $('#js--gens-email-clone').on('click', function (e) {
            e.preventDefault();
            var $clone = $('#gens-referral_share__email').children().first().clone();
            $clone.insertBefore('#js--gens-email-clone').find('input').val('');
        });

        $('.raf-close').on('click', function (e) {
            e.preventDefault();
            $('#raf-modal').hide();
        });

        $('#js--gens-email-remove').on('click', function (e) {
            e.preventDefault();
            if ($('.gens-referral_share__email__inputs').length > 1) {
                $('#gens-referral_share__email').find('.gens-referral_share__email__inputs').last().remove();
            }
        });

        $('#gens-referral_share__email').submit(function (e) {
            e.preventDefault();
            var valid = true;
            $('.gens-referral_share__email__inputs').each(function () {
                var emailInput = $(this).find("input[type='email']");
                emailInput.removeClass('error');
                if (!validateEmail(emailInput.val())) {
                    valid = false;
                    emailInput.addClass('error');
                }
            });
            if (valid === true) {
                gensAjaxSubmit();
            }
        });

        // Click to copy
        $('.gens-ctc').on('click', function () {
            var that = this;
            var text = $(this).text();
            var copied = $(this).data('text');
            var raf_link = $(this).parent().find('strong').text();
            var copied;
            gensCopyText(raf_link);
            $(this).text(copied);
            setTimeout(function () {
                $(that).text(text);
            }, 1500);
        });

        const copyInputs = Array.from(document.querySelectorAll('.gens-copy'));
        copyInputs.forEach((input) => {
            input.addEventListener('click', function () {
                const input = this.querySelector('input');
                const copyIcon = this.querySelector('.gens-copy-icon');
                const copiedIcon = this.querySelector('.gens-copied-icon');

                navigator.clipboard
                    .writeText(input.value)
                    .then(() => {
                        copyIcon.style.display = 'none';
                        copiedIcon.style.display = 'block';

                        setTimeout(() => {
                            copyIcon.style.display = 'block';
                            copiedIcon.style.display = 'none';
                        }, 2000);
                    })
                    .catch((err) => {
                        console.error('Could not copy text: ', err);
                    });
            });
        });

        // Generate referral link from guest email
        $('body').on('click', '.gens-raf-generate-link', function () {
            var $button = $(this);
            var valid = true;
            var $email = $('.gens-raf-guest-email');
            var $name = $('.gens-raf-guest-name');
            
            // Reset error states and clear any existing error messages
            $email.removeClass('error');
            $('.gens-raf-error-message').remove();
            
            if (!validateEmail($email.val())) {
                valid = false;
                $email.addClass('error');
                return;
            }
            
            if (valid === true) {
                // Disable button and show loading
                $button.prop('disabled', true).text('Generating...');
                
                // Make AJAX call to generate referral code
                jQuery.ajax({
                    type: 'POST',
                    url: gens_raf.ajax_url,
                    data: {
                        action: 'gens_generate_guest_referral',
                        email: $email.val(),
                        name: $name.val(),
                        nonce: gens_raf.nonce
                    },
                    success: function (response) {
                        if (response.success) {
                            var data = response.data;
                            
                            // Clear any error messages
                            $('.gens-raf-error-message').remove();
                            
                            // Update referral link display
                            $('.gens-raf__url strong').text(data.referral_link);
                            
                            // Update input field if exists
                            const input = $('.gens-raf-field--link');
                            if (input.length) {
                                input.val(data.referral_link);
                            }
                            
                            // Update share links
                            $('.gens-referral_share')
                                .find('a')
                                .each(function () {
                                    var $href = $(this).attr('href');
                                    // Replace existing raf parameter or add new one
                                    var newHref = $href.replace(/(\?|&)raf=[^&]*/, '');
                                    newHref += (newHref.indexOf('?') === -1 ? '?' : '&') + 'raf=' + data.referral_code;
                                    $(this).attr('href', newHref);
                                });
                            
                            // Update data attributes
                            $('.gens-refer-a-friend').attr('data-link', data.referral_link);
                            $('.gens-refer-a-friend').attr('data-name', $name.val());
                            
                            // Show/hide appropriate sections using CSS classes
                            $('.gens-refer-a-friend--generate').removeClass('raf-show-generate');
                            $('.gens-refer-a-friend--guest').addClass('raf-show-guest');
                            
                            // Set cookie with referral code (not email anymore)
                            gens_set_cookie('gens_raf', data.referral_code, 7);
                            // Track that this was a user-generated code (not an incoming referral)
                            gens_set_cookie('gens_raf_generated', data.referral_code, 7);
                            
                            // Show success message if provided
                            if (data.message) {
                                // You can add a success notification here if needed
                                console.log(data.message);
                            }
                            
                        } else {
                            // Handle error - show inline error message below button
                            showInlineError($button, response.data.message || 'Failed to generate referral link');
                        }
                    },
                    error: function () {
                        // Handle network error - show inline error message below button
                        showInlineError($button, 'Network error. Please try again.');
                    },
                    complete: function () {
                        // Re-enable button
                        $button.prop('disabled', false).text('Generate');
                    }
                });
            }
        });

        // Function to show inline error message below button
        function showInlineError($button, message) {
            // Remove any existing error messages
            $('.gens-raf-error-message').remove();
            
            // Create error message element
            var $errorMsg = $('<div class="gens-raf-error-message" style="color: #d63638; font-size: 14px; margin-top: 8px; display: block;">' + message + '</div>');
            
            // Insert error message after the button's parent container
            var $buttonContainer = $button.closest('.gens-raf-field, .gens-raf-generate-guest');
            if ($buttonContainer.length) {
                $buttonContainer.after($errorMsg);
            } else {
                // Fallback: insert after button
                $button.after($errorMsg);
            }
        }

        // Refresh on email change
        var typingTimer;
        var gensDoneTypingInterval = 1000;

        $('#billing_email').on('input', function () {
            window.clearTimeout(typingTimer);
            typingTimer = window.setTimeout(() => gensDoneTyping('email'), gensDoneTypingInterval);
        });

        $('#shipping_email').on('input', function () {
            window.clearTimeout(typingTimer);
            typingTimer = window.setTimeout(() => gensDoneTyping('email'), gensDoneTypingInterval);
        });

        $('#billing_phone').on('input', function () {
            window.clearTimeout(typingTimer);
            typingTimer = window.setTimeout(() => gensDoneTyping('phone'), gensDoneTypingInterval);
        });

        function validateEmail(email) {
            return gensRafValidateEmail(email);
        }

        function gensDoneTyping(type) {
            if (type === 'email') {
                var val = $('#billing_email').val();
                if (val.indexOf('@') > -1) {
                    jQuery(document.body).trigger('update_checkout');
                }
            } else {
                jQuery(document.body).trigger('update_checkout');
            }
        }

        function gensAjaxSubmit() {
            $("#gens-referral_share__email input[type='submit']").prop('disabled', true);
            var data = new Array();
            var link = $('.gens-refer-a-friend').data('link');
            var name = $('.gens-refer-a-friend').data('name');
            $('.gens-referral_share__email__inputs').each(function () {
                var email = $(this).find("input[type='email']").val();
                var text = $(this).find("input[type='text']").val();
                if (email != '') {
                    var valueToPush = {};
                    valueToPush.email = email;
                    valueToPush.name = text;
                    data.push(valueToPush);
                }
            });

            jQuery.ajax({
                type: 'POST',
                url: gens_raf.ajax_url,
                data: {
                    data: data,
                    link: link,
                    name: name,
                    action: 'gens_share_via_email',
                    nonce: gens_raf.nonce,
                },
                success: function (data) {
                    // Remove form and say thx
                    $('.gens-raf-submit-success').show();
                    $('.gens-raf-send-emails').hide();
                    var $success = "<div class='gens-raf-mail-share'>" + gens_raf.success_msg + '</div>';
                    $('.gens-referral_share__email__inputs').not(':first').remove();
                    $('.gens-referral_share__email__inputs').find('input').val('');
                    $("#gens-referral_share__email input[type='submit']").prop('disabled', false);
                    $('.gens-referral_share__email').after($success);
                    setTimeout(function (d) {
                        $('.gens-raf-mail-share').remove();
                        $('.gens-raf-submit-success').hide();
                        $('.gens-raf-send-emails').show();
                    }, 4500);
                },
            });
            return false;
        }
    });
})(jQuery);
