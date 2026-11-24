/*
 * Catalog Display (customersearch.html)
 *
 * A standalone shop window. It reads the live item shelf through
 * items/itemSearchTable, keeps the search/sort/price state in one place and
 * renders a full-width grid. The PDF export is a deliberate second layout:
 * clean white pages, product photographs, no buttons and no theme colours.
 */
PosnicPro.customersearch = {
    state: {
        page: 1,
        limit: 24,
        search: '',
        sort: 'new',
        min: 0,
        max: 500000,
        items: [],
        total: 0,
        totalPages: 1
    },
    _requestToken: 0,
    _sliderReady: false,

    t: function (key, fallback) {
        try {
            if (PosnicPro.i18n && typeof PosnicPro.i18n.t === 'function') {
                return PosnicPro.i18n.t(key, fallback);
            }
        } catch (e) { /* fall through to the English label */ }
        return fallback;
    },

    esc: function (value) {
        return $('<span>').text(value == null ? '' : value).html();
    },

    currency: function () {
        return PosnicPro.local.get('currencySign') || '';
    },

    money: function (value) {
        var n = Number(value);
        if (!Number.isFinite(n)) n = 0;
        return this.currency() + ' ' + n.toFixed(2);
    },

    imageOf: function (item) {
        var image = item && item.image;
        if (!image || image === 'item.svg') {
            return 'static/images/default/item.svg';
        }
        return image;
    },

    priceOf: function (item) {
        var selling = Number(item && item.selling_price) || 0;
        var discountAmount = Number(item && item.discount_amount) || 0;
        var discountPercentage = Number(item && item.discount_percentage) || 0;
        var price = selling;
        if (discountAmount > 0) {
            price = selling - discountAmount;
        } else if (discountPercentage > 0) {
            price = selling - (selling * (discountPercentage / 100));
        }
        return Math.max(0, Math.round(price * 100) / 100);
    },

    branchIdOf: function (entry) {
        var id = entry && entry.branch_id;
        if (id && typeof id === 'object') {
            id = id.$oid || id.toString();
        }
        return id ? String(id) : '';
    },

    init: function () {
        var self = this;
        if (self._initialised) return;
        self._initialised = true;

        if (typeof PosnicPro.themeManager !== 'undefined') {
            try {
                PosnicPro.themeManager.init();
                window.addEventListener('storage', function (e) {
                    if (e.key === 'posnic_theme_settings') PosnicPro.themeManager.init();
                });
            } catch (e) { /* theme is optional */ }
        }

        self.checkPermission();
        self.bind();
        self.startSlider();
    },

    checkPermission: function () {
        var self = this;
        if (typeof db === 'undefined' || !db.customerPlan) return;
        db.customerPlan.get('1').then(function (data) {
            if (data && data.read === false) {
                PosnicPro.alert('warning', self.t('lang_you_are_unauthorized', 'You are Unauthorized'));
            }
        }).catch(function () { /* the server still checks every request */ });
    },

    bind: function () {
        var self = this;
        var timer = null;

        $('#catalog_search').on('input', function () {
            var value = $(this).val();
            $('#catalog_search_clear').prop('hidden', !value);
            clearTimeout(timer);
            timer = setTimeout(function () {
                self.state.search = String(value || '').trim();
                self.load(1);
            }, 280);
        });

        $('#catalog_search_clear').on('click', function () {
            $('#catalog_search').val('').trigger('focus');
            $(this).prop('hidden', true);
            self.state.search = '';
            self.load(1);
        });

        $('#filter_customer_search').on('change', function () {
            self.state.sort = $(this).val() || 'new';
            self.load(1);
        });

        $('#catalog_refresh').on('click', function () {
            self.load(self.state.page);
        });

        $('#catalog_pdf').on('click', function () {
            self.exportPdf();
        });

        $('#catalog_price_toggle').on('click', function () {
            var panel = $('#catalog_price_panel');
            var hidden = !panel.prop('hidden');
            panel.prop('hidden', hidden);
            $(this).attr('aria-expanded', String(!hidden));
        });

        $('#catalog_empty_reset').on('click', function () {
            $('#catalog_search').val('');
            $('#catalog_search_clear').prop('hidden', true);
            $('#filter_customer_search').val('new');
            self.state.search = '';
            self.state.sort = 'new';
            self.state.min = 0;
            self.state.max = 500000;
            if (self._sliderReady && $('#range-slider').data('ionRangeSlider')) {
                $('#range-slider').data('ionRangeSlider').update({ from: 0, to: 500000 });
            }
            self.updatePriceOutput();
            self.load(1);
        });
    },

    startSlider: function () {
        var self = this;
        var $slider = $('#range-slider');
        var started = false;

        if ($slider.length && typeof $slider.ionRangeSlider === 'function') {
            $slider.ionRangeSlider({
                type: 'double',
                skin: 'flat',
                grid: true,
                min: 0,
                max: 1000000,
                from: 0,
                to: 500000,
                prefix: self.currency() ? self.currency() + ' ' : '',
                prettify: function (n) {
                    return Number(n).toLocaleString();
                },
                onStart: function (data) {
                    if (started) return;
                    started = true;
                    self._sliderReady = true;
                    self.applySlider(data);
                    self.load(1);
                },
                onFinish: function (data) {
                    self.applySlider(data);
                    self.load(1);
                }
            });
        }

        if (!started) {
            self.updatePriceOutput();
            self.load(1);
        }
    },

    applySlider: function (data) {
        data = data || {};
        this.state.min = Number(data.from);
        this.state.max = Number(data.to);
        if (!Number.isFinite(this.state.min)) this.state.min = 0;
        if (!Number.isFinite(this.state.max)) this.state.max = 500000;
        this.updatePriceOutput();
    },

    updatePriceOutput: function () {
        var min = Number(this.state.min) || 0;
        var max = Number(this.state.max) || 0;
        $('#catalog_price_output').text(this.money(min) + ' - ' + this.money(max));
    },

    load: function (page) {
        var self = this;
        if (page) self.state.page = page;
        var token = ++self._requestToken;
        self.setLoading(true);

        PosnicPro.get({
            url: 'items/itemSearchTable',
            data: {
                page: self.state.page,
                limit: self.state.limit,
                filter: self.state.sort,
                search: self.state.search,
                starting_price: self.state.min,
                ending_price: self.state.max
            }
        }, function (response) {
            if (token !== self._requestToken) return;
            self.setLoading(false);
            if (!response || response.type !== 'success' || !response.data) {
                self.showError((response && response.message) || self.t('lang_could_not_load_products', 'Could not load products.'));
                return;
            }
            var payload = response.data || {};
            self.state.items = payload.list || [];
            self.state.total = Number(payload.total) || 0;
            self.state.totalPages = Math.max(1, Number(payload.total_pages) || 1);
            if (self.state.page > self.state.totalPages && self.state.totalPages > 0) {
                self.load(self.state.totalPages);
                return;
            }
            self.render();
        }, function (xhr) {
            if (token !== self._requestToken) return;
            self.setLoading(false);
            var message = self.t('lang_could_not_load_products', 'Could not load products.');
            try {
                var parsed = JSON.parse(xhr.responseText);
                message = (parsed && parsed.message) || message;
            } catch (e) { /* keep the fallback */ }
            self.showError(message);
        });
    },

    setLoading: function (on) {
        $('#catalog_loading').prop('hidden', !on);
    },

    render: function () {
        var self = this;
        var items = self.state.items || [];
        var total = self.state.total;
        var productWord = total === 1
            ? self.t('lang_product', 'product')
            : self.t('lang_products', 'products');

        $('#catalog_count').text(total.toLocaleString() + ' ' + productWord);
        $('#catalog_page_label').text(
            self.t('lang_page', 'Page') + ' ' + self.state.page + ' / ' + self.state.totalPages
        );

        if (!items.length) {
            self.showEmpty();
            $('#catalog_pager').empty();
            return;
        }

        $('#catalog_empty').prop('hidden', true);
        $('#list-item').html(items.map(function (item) {
            return self.card(item);
        }).join(''));
        self.renderPager();
    },

    card: function (item) {
        var self = this;
        var id = self.esc(item._id);
        var name = self.esc(item.item_name || item.name || '');
        var category = self.esc(item.category_name || '');
        var image = self.esc(self.imageOf(item));
        var price = self.priceOf(item);
        var selling = Number(item.selling_price) || 0;
        var hasDiscount = selling > price + 0.004;
        var stock = item.available_quantity;
        var hasStock = stock !== undefined && stock !== null && stock !== '';
        var stockNumber = Number(stock);
        var stockLabel = '';
        if (hasStock && Number.isFinite(stockNumber)) {
            stockLabel = stockNumber > 0
                ? '<span class="catalog-stock-dot">' + self.esc(self.t('lang_in_stock', 'In Stock')) + '</span>'
                : '<span class="catalog-stock-dot is-out">' + self.esc(self.t('lang_sold_out', 'Sold Out')) + '</span>';
        }

        return '<article class="catalog-card" data-id="' + id + '">'
            + '<button type="button" class="catalog-card-media" onclick="PosnicPro.customersearch.viewCustomerViewItem(\'' + id + '\');" aria-label="' + self.esc(self.t('lang_view_details', 'View details')) + '">'
            + '<img loading="lazy" decoding="async" src="' + image + '" alt="' + name + '">'
            + '</button>'
            + '<div class="catalog-card-body">'
            + '<div class="catalog-card-topline"><span class="catalog-category">' + category + '</span>' + stockLabel + '</div>'
            + '<h3 class="catalog-card-name">' + name + '</h3>'
            + '<div class="catalog-card-bottom">'
            + '<div class="catalog-price">'
            + '<span class="catalog-price-now">' + self.esc(self.money(price)) + '</span>'
            + (hasDiscount ? '<span class="catalog-price-was">' + self.esc(self.money(selling)) + '</span>' : '')
            + '</div>'
            + '<button type="button" class="catalog-view" onclick="PosnicPro.customersearch.viewCustomerViewItem(\'' + id + '\');" aria-label="' + self.esc(self.t('lang_view_details', 'View details')) + '">'
            + '<i class="feather icon-arrow-up-right" aria-hidden="true"></i>'
            + '</button>'
            + '</div>'
            + '</div>'
            + '</article>';
    },

    renderPager: function () {
        var self = this;
        var page = self.state.page;
        var total = self.state.totalPages;
        var $pager = $('#catalog_pager');
        if (total <= 1) {
            $pager.empty();
            return;
        }

        var buttons = [];
        var button = function (to, label, disabled, current) {
            return '<button type="button" class="catalog-page-button' + (current ? ' is-current' : '') + '"'
                + (disabled ? ' disabled' : '')
                + (current ? ' aria-current="page"' : '')
                + ' onclick="PosnicPro.customersearch.goToPage(' + to + ');">' + label + '</button>';
        };

        buttons.push(button(page - 1, '&larr;', page <= 1, false));
        var start = Math.max(1, page - 2);
        var end = Math.min(total, page + 2);
        if (start > 1) {
            buttons.push(button(1, '1', false, page === 1));
            if (start > 2) buttons.push('<span class="catalog-page-ellipsis">...</span>');
        }
        for (var n = start; n <= end; n++) {
            buttons.push(button(n, String(n), false, n === page));
        }
        if (end < total) {
            if (end < total - 1) buttons.push('<span class="catalog-page-ellipsis">...</span>');
            buttons.push(button(total, String(total), false, page === total));
        }
        buttons.push(button(page + 1, '&rarr;', page >= total, false));
        $pager.html(buttons.join(''));
    },

    goToPage: function (page) {
        var target = Number(page);
        if (!Number.isFinite(target)) return;
        target = Math.max(1, Math.min(this.state.totalPages, target));
        if (target === this.state.page) return;
        this.load(target);
        var shell = document.querySelector('.catalog-shell');
        if (shell && typeof shell.scrollIntoView === 'function') {
            shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    },

    nextPage: function () {
        this.goToPage(this.state.page + 1);
    },

    previousPage: function () {
        this.goToPage(this.state.page - 1);
    },

    showEmpty: function () {
        var self = this;
        $('#list-item').empty();
        $('#catalog_empty h2').text(self.t('lang_no_products_found', 'No products found'));
        $('#catalog_empty p').text(self.t('lang_no_products_found_hint', 'Try another search or widen the price range.'));
        $('#catalog_empty').prop('hidden', false);
    },

    showError: function (message) {
        var self = this;
        $('#list-item').empty();
        $('#catalog_pager').empty();
        $('#catalog_count').text('0 ' + self.t('lang_products', 'products'));
        $('#catalog_page_label').text('');
        $('#catalog_empty h2').text(self.t('lang_could_not_load_products', 'Could not load products.'));
        $('#catalog_empty p').text(message || self.t('lang_try_again', 'Try again.'));
        $('#catalog_empty').prop('hidden', false);
    },

    viewCustomerViewItem: function (id) {
        var self = this;
        if (!id) return;

        $('#catalog_main_image').attr('src', 'static/images/default/item.svg').attr('alt', '');
        $('#catalog_thumbs').empty();
        $('#item_view_category').text('');
        $('#customer_item_name').text(self.t('lang_loading_4', 'Loading ...'));
        $('#item_view_sellingprice_discount').text('');
        $('#item_view_sellingprice').text('');
        $('#catalog_original_price_wrap').prop('hidden', true);
        $('#catalog_stock').prop('hidden', true).removeClass('is-out').text('');
        $('#item_view_discriptions').text('');
        $('#catalog_branch_list').empty();
        $('#catalog_branch_details').empty();
        $('#view_item_details').modal('show');

        PosnicPro.get('items/' + encodeURIComponent(id), function (response) {
            if (!response || response.type !== 'success' || !response.data) {
                PosnicPro.alert('error', (response && response.message) || self.t('lang_could_not_open_this_item', 'Could not open this product.'));
                return;
            }
            self.renderDetail(response.data);
        }, function (xhr) {
            var message = self.t('lang_could_not_open_this_item', 'Could not open this product.');
            try {
                var parsed = JSON.parse(xhr.responseText);
                message = (parsed && parsed.message) || message;
            } catch (e) { /* keep the fallback */ }
            PosnicPro.alert('error', message);
        });
    },

    renderDetail: function (data) {
        var self = this;
        var name = data.name || data.item_name || '';
        var category = data.category_name || '';
        var selling = Number(data.selling_price) || 0;
        var discountAmount = Number(data.discount_amount) || 0;
        var discountPercentage = Number(data.discount_percentage) || 0;
        var price = selling;
        if (discountAmount > 0) {
            price = selling - discountAmount;
        } else if (discountPercentage > 0) {
            price = selling - (selling * (discountPercentage / 100));
        }
        price = Math.max(0, Math.round(price * 100) / 100);
        var hasDiscount = selling > price + 0.004;

        $('#customer_item_name').text(name);
        $('#item_view_category').text(category);
        $('#item_view_sellingprice_discount').text(self.money(price));
        $('#item_view_sellingprice').text(self.money(selling));
        $('#catalog_original_price_wrap').prop('hidden', !hasDiscount);

        var stock = data.available_quantity;
        var stockNumber = Number(stock);
        if (stock !== undefined && stock !== null && stock !== '' && Number.isFinite(stockNumber)) {
            var $stock = $('#catalog_stock');
            $stock.prop('hidden', false).toggleClass('is-out', stockNumber <= 0);
            if (stockNumber > 0) {
                var unit = data.item_unit ? ' ' + data.item_unit : '';
                $stock.text(self.t('lang_in_stock', 'In Stock') + ': ' + stockNumber + unit);
            } else {
                $stock.text(self.t('lang_sold_out', 'Sold Out'));
            }
        } else {
            $('#catalog_stock').prop('hidden', true);
        }

        var description = data.description || data.item_description || '';
        $('#item_view_discriptions').text(description);

        var images = [];
        if (data.image && data.image !== 'item.svg') images.push(data.image);
        var multi = Array.isArray(data.multi_image) ? data.multi_image : [];
        multi.forEach(function (entry) {
            var src = entry && (entry.name || entry.image || entry);
            if (typeof src === 'string' && src && images.indexOf(src) === -1) images.push(src);
        });
        if (!images.length) images.push('static/images/default/item.svg');
        self.renderGallery(images);

        var branches = Array.isArray(data.branch_access) ? data.branch_access : [];
        var $branches = $('#catalog_branch_list');
        if (!branches.length) {
            $branches.html('<span class="catalog-branch-details">' + self.esc(self.t('lang_available_in_all_branches', 'Available in all branches')) + '</span>');
            return;
        }
        $branches.html(branches.map(function (entry) {
            var branchId = self.branchIdOf(entry);
            var label = entry.branch_name || branchId;
            return '<button type="button" class="catalog-branch-chip" data-branch="' + self.esc(branchId) + '">'
                + self.esc(label) + '</button>';
        }).join(''));
        $branches.off('click.catalog').on('click.catalog', '.catalog-branch-chip', function () {
            var branchId = $(this).data('branch');
            if (!branchId) return;
            $branches.find('.catalog-branch-chip').removeClass('is-active');
            $(this).addClass('is-active');
            self.getBranchDetails(branchId);
        });
    },

    renderGallery: function (images) {
        var self = this;
        var $main = $('#catalog_main_image');
        var setMain = function (src) {
            $main.attr('src', src).attr('alt', '');
            $main.off('error.catalog').on('error.catalog', function () {
                $(this).off('error.catalog').attr('src', 'static/images/default/item.svg');
            });
        };
        setMain(images[0]);

        var $thumbs = $('#catalog_thumbs');
        if (images.length <= 1) {
            $thumbs.empty();
            return;
        }
        $thumbs.html(images.map(function (src, index) {
            return '<button type="button" class="catalog-thumb' + (index === 0 ? ' is-active' : '') + '" data-src="' + self.esc(src) + '" aria-label="' + self.esc(self.t('lang_view_details', 'View details')) + '">'
                + '<img src="' + self.esc(src) + '" alt="">'
                + '</button>';
        }).join(''));
        $thumbs.off('click.catalog').on('click.catalog', '.catalog-thumb', function () {
            $thumbs.find('.catalog-thumb').removeClass('is-active');
            $(this).addClass('is-active');
            setMain($(this).data('src'));
        });
    },

    getBranchDetails: function (id) {
        var self = this;
        var $details = $('#catalog_branch_details');
        $details.html('<span class="catalog-loading"><span class="catalog-spinner" aria-hidden="true"></span> ' + self.esc(self.t('lang_loading_4', 'Loading ...')) + '</span>');
        PosnicPro.get('branches/' + encodeURIComponent(id), function (response) {
            if (!response || response.type !== 'success' || !response.data) {
                $details.text(self.t('lang_could_not_load_this_branch', 'Could not load this branch.'));
                return;
            }
            var branch = response.data;
            var lines = [];
            if (branch.branch_name) lines.push('<strong>' + self.esc(branch.branch_name) + '</strong>');
            if (branch.store_address) lines.push(self.esc(branch.store_address));
            if (branch.store_telephone) lines.push(self.esc(branch.store_telephone));
            if (branch.store_email) lines.push(self.esc(branch.store_email));
            $details.html(lines.join('<br>') || self.esc(self.t('lang_no_branch_details', 'No branch details.')));
        }, function () {
            $details.text(self.t('lang_could_not_load_this_branch', 'Could not load this branch.'));
        });
    },

    exportPdf: function () {
        var self = this;
        if (!self.state.items.length) {
            PosnicPro.alert('warning', self.t('lang_no_products_to_export', 'There are no products to export.'));
            return;
        }

        var $button = $('#catalog_pdf');
        var original = $button.html();
        $button.prop('disabled', true).html('<i class="feather icon-loader" aria-hidden="true"></i><span class="catalog-button-label">'
            + self.esc(self.t('lang_preparing_pdf', 'Preparing PDF ...')) + '</span>');

        var wrapper = null;
        var finish = function () {
            if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
            $button.prop('disabled', false).html(original);
        };

        PosnicPro.lazy.load('html2canvas')
            .then(function () { return PosnicPro.lazy.load('jspdf'); })
            .then(function () {
                var C = (window.jspdf && typeof window.jspdf.jsPDF === 'function') ? window.jspdf.jsPDF
                    : (typeof window.jsPDF === 'function') ? window.jsPDF
                    : (typeof window.jspdf === 'function') ? window.jspdf
                    : null;
                if (!C) throw new Error(self.t('lang_pdf_tools_not_loaded_refresh_and_retry', 'PDF tools not loaded - refresh and retry.'));

                wrapper = self.buildPdfSheet();
                return self.waitForImages(wrapper).then(function () {
                    var pages = Array.prototype.slice.call(wrapper.querySelectorAll('.catalog-pdf-page'));
                    var pdf = new C({ unit: 'mm', format: 'a4', orientation: 'portrait' });
                    var chain = Promise.resolve();
                    pages.forEach(function (page, index) {
                        chain = chain.then(function () {
                            return window.html2canvas(page, {
                                scale: 2,
                                useCORS: true,
                                backgroundColor: '#ffffff',
                                width: page.scrollWidth,
                                height: page.scrollHeight,
                                windowWidth: page.scrollWidth,
                                windowHeight: page.scrollHeight,
                                logging: false
                            });
                        }).then(function (canvas) {
                            if (index > 0) pdf.addPage();
                            var pageWidth = 210;
                            var pageHeight = 297;
                            var margin = 10;
                            var contentWidth = pageWidth - margin * 2;
                            var contentHeight = pageHeight - margin * 2;
                            var imageWidth = contentWidth;
                            var imageHeight = (canvas.height * imageWidth) / canvas.width;
                            if (imageHeight > contentHeight) {
                                imageHeight = contentHeight;
                                imageWidth = (canvas.width * imageHeight) / canvas.height;
                            }
                            var x = (pageWidth - imageWidth) / 2;
                            pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', x, margin, imageWidth, imageHeight);
                        });
                    });
                    return chain;
                }).then(function () {
                    var stamp = new Date();
                    var name = 'catalog-'
                        + stamp.getFullYear() + '-'
                        + String(stamp.getMonth() + 1).padStart(2, '0') + '-'
                        + String(stamp.getDate()).padStart(2, '0') + '.pdf';
                    pdf.save(name);
                });
            })
            .then(finish, function (error) {
                finish();
                PosnicPro.alert('error', self.t('lang_pdf_export_failed', 'Could not create the PDF.') + ' '
                    + (error && error.message ? error.message : ''));
            });
    },

    waitForImages: function (root) {
        var images = Array.prototype.slice.call(root.querySelectorAll('img'));
        return Promise.all(images.map(function (image) {
            if (image.complete) return Promise.resolve();
            return new Promise(function (resolve) {
                image.onload = resolve;
                image.onerror = resolve;
            });
        }));
    },

    buildPdfSheet: function () {
        var self = this;
        var items = self.state.items || [];
        var perPage = 12;
        var pageCount = Math.max(1, Math.ceil(items.length / perPage));
        var wrapper = document.createElement('div');
        wrapper.id = 'catalog_pdf_sheet';

        var shop = PosnicPro.local.get('shop_name')
            || PosnicPro.local.get('branch_name')
            || PosnicPro.local.get('store_name')
            || document.title.replace(/·.*$/, '').trim()
            || 'Posnic';
        var title = self.t('lang_customersearch_title', 'Catalog Display');
        var generated = new Date().toLocaleString();
        var currency = self.currency() || '';

        for (var pageIndex = 0; pageIndex < pageCount; pageIndex++) {
            var chunk = items.slice(pageIndex * perPage, (pageIndex + 1) * perPage);
            var cards = chunk.map(function (item) {
                return self.pdfCard(item);
            }).join('');
            var page = document.createElement('div');
            page.className = 'catalog-pdf-page';
            page.innerHTML = '<div class="catalog-pdf-head">'
                + '<div><p class="catalog-pdf-brand">POSNIC</p><h1>' + self.esc(title) + '</h1></div>'
                + '<div class="catalog-pdf-meta"><strong>' + self.esc(shop) + '</strong><br>'
                + self.esc(generated) + '<br>' + self.esc(self.t('lang_page', 'Page')) + ' '
                + (pageIndex + 1) + ' / ' + pageCount + '</div>'
                + '</div>'
                + '<div class="catalog-pdf-grid">' + cards + '</div>'
                + '<div class="catalog-pdf-foot"><span>'
                + self.esc(self.t('lang_catalog_pdf_note', 'Prices are shown in the shop currency.'))
                + (currency ? ' (' + self.esc(currency) + ')' : '')
                + '</span><span>' + self.esc(shop) + '</span></div>';
            wrapper.appendChild(page);
        }

        document.body.appendChild(wrapper);
        return wrapper;
    },

    pdfCard: function (item) {
        var self = this;
        var image = self.imageOf(item);
        var price = self.priceOf(item);
        var selling = Number(item.selling_price) || 0;
        var hasDiscount = selling > price + 0.004;
        return '<div class="catalog-pdf-card">'
            + '<div class="catalog-pdf-image"><img loading="eager" decoding="async" src="' + self.esc(image) + '" alt=""></div>'
            + '<div class="catalog-pdf-body">'
            + '<span class="catalog-pdf-category">' + self.esc(item.category_name || '') + '</span>'
            + '<span class="catalog-pdf-name">' + self.esc(item.item_name || item.name || '') + '</span>'
            + '<div class="catalog-pdf-price"><span class="catalog-pdf-now">' + self.esc(self.money(price)) + '</span>'
            + (hasDiscount ? '<span class="catalog-pdf-was">' + self.esc(self.money(selling)) + '</span>' : '')
            + '</div></div></div>';
    }
};

$(function () {
    PosnicPro.customersearch.init();
});
