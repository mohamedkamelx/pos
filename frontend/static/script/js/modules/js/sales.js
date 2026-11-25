PosnicPro.sales = {
    /* Array Declaration */
    extraDiscount: [],
    addLineTable: [],
    addSalesLineTable: [],
    returnSalesLineTable: [],
    SaleTableLineItems: [],
    addSalesItemChars: [],
    EditRecentSaleParams: [],
    submissionInProgress: false,
    _idempotencyKey: null,
    idempotencyKey: function () {
        if (!PosnicPro.sales._idempotencyKey) {
            if (typeof window.crypto.randomUUID === 'function') {
                PosnicPro.sales._idempotencyKey = window.crypto.randomUUID();
            } else {
                var bytes = new Uint8Array(16);
                window.crypto.getRandomValues(bytes);
                PosnicPro.sales._idempotencyKey = Array.from(bytes, function (value) {
                    return value.toString(16).padStart(2, '0');
                }).join('');
            }
        }
        return PosnicPro.sales._idempotencyKey;
    },
    resetIdempotencyKey: function () {
        PosnicPro.sales._idempotencyKey = null;
    },
    submissionJournal: function () {
        return window.PosnicOrderJournal.create(window.localStorage, function () {
            return {
                server: API_URL,
                branch: PosnicPro.local.get('branch_id_set'),
                user: PosnicPro.local.get('userid')
            };
        }, function (key, fallback) { return PosnicPro.i18n.t(key, fallback); });
    },
    recentSaleAction: false,
    recentSaleId: '',
    editSaleAction: false,
    editSaleId: '',
    salesId: '',
    refundSaleAction: false,
    refundSaleId: '',
    SaleAction: 'add',
    salesExchange: false,
    return_remove: null,
    deleteConfirmation: false,
    paymentOnlyMode: false,
    originalSaleData: null,
    defaultCustomer: true,
    saleProcess: null,
    callbackRegistry: {
        name: '',
        arguments: ''
    },
    sub: function (value1, value2) {
        var sub = value1 - value2;
        return sub;
    },
    /*
     * Price a sale line from the amounts the sale stores. Prices are final:
     * the subtotal is price x quantity, and the discount is either a per-unit
     * amount or a percentage of that subtotal. Nothing is added on top.
     */
    lineTotals: function (price, qty, discountValue, isPercent) {
        var quantity = Number(qty) || 0;
        var subtotal = (Number(price) || 0) * quantity;
        var value = Number(discountValue) || 0;
        var discount = isPercent ? subtotal * (value / 100) : value * quantity;
        return { subtotal: subtotal, discount: discount, total: subtotal - discount };
    },
    readLineTotals: function (id) {
        return PosnicPro.sales.lineTotals(
            $('#addSalesLineItemSellingPrice_' + id).text(),
            $('#touchsale_item_qty' + id).val(),
            $('#addSalesLineItemDiscount_' + id).text(),
            $('#discountSign' + id).text() === '%'
        );
    },
    showAdd: function () {
        PosnicPro.sales.resetIdempotencyKey();
        $('#ask_checkout_payment').remove();
        // ✅ Reset submission flag when opening new sale
        PosnicPro.sales.submissionInProgress = false;
        $("#save_btn").prop('disabled', false);
        $("#save_submit").removeClass('disabled');

        $('.addDisc-hide-show').hide();
        if (PosnicPro.sales.syncNotesCellSpan) { PosnicPro.sales.syncNotesCellSpan(); }
        $('#extraDisc').prop('disabled', false);
        $('#extraDisc').removeClass('extraDisc');
        $('#percentIcon, #rupeeIcon').css('pointer-events', 'auto').css('opacity', '1');
        PosnicPro.HideSideBarModal();
        $('.return_sale_only_show').hide();
        $('.RoundOff-hide-show').hide();
        $("#viewtest,#payment_id").show();
        $('#customer_current_balance').val();
        $('#Partial_amount').val();
        $('#table_return_page,#table_sale_page').find('table').removeAttr('id');
        PosnicPro.sales.EditRecentSaleParams = [];
        var myobj = document.getElementById("table_return_page");
        myobj.remove();
        var newDiv = document.createElement("div");
        newDiv.id = "table_return_page";
        var element = document.getElementById("table_return_page_parent");
        element.appendChild(newDiv);
        $('#sales_table').find('table').attr('id', 'sales_new_items_table');
        $('#show-sale-already-return-table').hide();
        if (PosnicPro.sales.SaleAction === 'return' || PosnicPro.sales.SaleAction === 'edit') {
            PosnicPro.sales.setDefaults();
        }
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $(".vertical-menu li a").removeClass("active");
        PosnicPro.collapseMenuForWorkspace();
        $("#sales_new_item_name").css("display", "block");
        $('#image_sidebar_dashboard,#image_sidebar_salehistry').hide();
        $('.dashboard_img_menu').hide();
        $('#image_sidebar_newsale').show();
        /* The words are the same call either way; only the type sizes below
           still depend on the language. */
        $("#sales-text-change").text(PosnicPro.i18n.t('lang_addvariant_title', 'New'));
        $('.changeSalesBtnText').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
        if (PosnicPro.i18n.is('ta')) {
            $('.payment_detail').addClass('tm_payment');
            $('.sales_new_class th').addClass('tm_fontsize');
            $('.items_head').addClass('tm_font12');
            $('.pay_amount_total').addClass('tm_font13');
        } else {
            $('.btn-payment-mode').removeClass('tm_payment');
            $('.sales_new_class th').removeClass('tm_fontsize');
            $('.items_head').removeClass('tm_font12');
            $('.pay_amount_total').removeClass('tm_font13');
        }
        $(".sale_table_head_hide").text('');
        $(".sale_table_head_text").text(PosnicPro.i18n.t('lang_action', 'Action'));
        $("#refund_pay_total,#refund_sub_total,#refund_pay_hide,#refund_sub_hide").hide();
        $("#sales_new_items_table,#paymentdisplay,#return_disc,#return_discount").removeClass("customer-display-hide");
        /***Clear addlineitem table**/
        $(".save_return_submit,#sub_hide,#sub_total_hide,#pay_hide,#pay_total_hide,#items_view_hide,#payment_note").show();
        $(".payment_note").addClass("customer-display-hide");
        $("#return_view_hide,#button_return,#check_button,#return_button").css("display", "none");
        PosnicPro.sales.setSaleDefaults();
        $('.page_loader,#osk-container,#closeSaleButton,#closeEditButton,.return_discount_show').hide();
        $('.page-title-box,#holdSaleButton,#clearSaleButton,.return_discount_hide').show();
                        if (PosnicPro.sales && PosnicPro.sales.syncActionTooltips) { PosnicPro.sales.syncActionTooltips(); }
        /*New Sales*/
        var displayPage = 'sales';
        $('#' + displayPage + '_new').show();
        db.saleAutoFocus.get('1').then(function (data) {
            if (PosnicPro.sales._focusAfterCompletedSale || (data && data.addSale === true)) {
                PosnicPro.sales._focusAfterCompletedSale = false;
                $('#sales_new_item_name').focus();
            } else {
                $('#sales_new_item_name').blur();
            }
        });
        $('#time-format').addClass('commonDate');
        $('#time-format').removeClass('commonEditDate');
        PosnicPro.commonDate();
        if (PosnicPro.sales.applySaleDateLock) { PosnicPro.sales.applySaleDateLock(); }
        $('#v-pills-dashboard-tab,.sales_new_shortcut').addClass('active');
        $('#v-pills-dashboard').addClass('show active');
        $('.vertical-menu li a#view_touchsales_page').addClass('active');
        $("#time-format").attr('readOnly', 'true');
        $("#time-format").prop('disabled', false);
        $('.payment_detail').removeClass('active')
        if (PosnicPro.local.get('balance_view') === 'true') {
            $(".infobar-settings-sidebar-overlay").css({ "background": "transparent", "position": "initial" });
            $("#infobar-settings-sidebar-tender-details").removeClass("sidebarview");
            $('.salesBalanceAmount').show();
            $('#sales_save_button').hide();
        } else {
            $('.salesBalanceAmount').hide();
            $('#sales_save_button').show();
        }


        PosnicPro.sales.recentMenu.recentSalesTabDetails();
        const pickedItem = PosnicPro.palette?.takeItem('sales/new');
        if (pickedItem) PosnicPro.sales.itemsMenu.addToLineItemsList(pickedItem.id);
        $("#paymentreturnhistory").hide();
        var loader = $(".loader-sales-balance");
        loader.find(".loadingSpinner:first").remove();
    },
    showEdit: function (id) {
        // ✅ Reset submission flag when opening edit sale
        PosnicPro.sales.submissionInProgress = false;
        $("#save_btn").prop('disabled', false);
        $("#save_submit").removeClass('disabled');


        $('#percentIcon, #rupeeIcon').css('pointer-events', 'auto').css('opacity', '1');
        PosnicPro.sales.defaultCustomer = false;
        $('[data-toggle="tooltip"]').tooltip("hide");
        $('#sales_new_items_table tbody').html('');

        $('#time-format').removeClass('commonDate');
        $('#time-format').addClass('commonEditDate');
        $("#sales-text-change").text(PosnicPro.i18n.t('lang_action_edit', 'Edit'));
        $(".sale_table_head_hide").text('');
        $(".sale_table_head_text").text(PosnicPro.i18n.t('lang_action', 'Action'));
        $('.return_sale_only_show').hide();
        $("#viewtest,#payment_id").show();
        $('#table_return_page,#table_sale_page').find('table').removeAttr('id');
        $('#sales_table').find('table').attr('id', 'sales_new_items_table');
        $('#show-sale-already-return-table').hide();
        $('#v-pills-dashboard-tab').addClass('active');
        $('#v-pills-dashboard').addClass('show active');

        $("#refund_pay_total,#refund_sub_total,#refund_pay_hide,#refund_sub_hide").hide();
        $(".save_return_submit,#sub_hide,#sub_total_hide,#pay_hide,#pay_total_hide").show();
        $("#payment_note").show();
        $("#items_view_hide").css("display", "block");
        $("#return_view_hide,#check_button,#return_button,#button_return").css("display", "none");
        PosnicPro.sales.recentMenu.recentSalesTabDetails();
        PosnicPro.sales.view.showSalesEditPage(id);

        $("#time-format").attr('readOnly', 'true');
        $("#time-format").prop('disabled', true);
        $("#paymentreturnhistory").hide();
        var loader = $(".loader-sales-balance");
        loader.find(".loadingSpinner:first").remove();
    },
    showDelete: function (id) {
        if (PosnicPro.local.get('usertype') !== 'super_admin' || PosnicPro.local.get('allow_sale_hard_delete') !== 'true') {
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_sale_hard_delete_disabled', 'Hard delete of sales is disabled in Sales settings'));
            return;
        }
        PosnicPro.deleteTableRowData(id, 'sales');
        if (!PosnicPro.deleteConfirmation) $('.removeText').text(PosnicPro.i18n.t('lang_sale_hard_delete_confirm', 'Hard delete removes this sale from Sales History and moves its data to Recycle Bin.') + ' ' + PosnicPro.i18n.t('lang_sale_delete_stock_warning', 'Stock will be added back for inventory-tracked items. Untracked items are not changed.'));
    },
    showPdf: function (id) {
        PosnicPro.sales.view.salesPdf(id);
    },
    showPrint: function (id) {
        PosnicPro.sales.view.printSale(id, 'sale');
    },
    showPayment: function (id) {
        /*
         * "Take Payment" on a bill settles that bill. It used to reopen the
         * whole edit screen and pre-fill the amount already paid, which made
         * the button look like it worked while recording nothing. The cashier
         * has already chosen the bill here, so the amount does not need to be
         * typed again: read the outstanding figure the sale endpoint attaches
         * and record exactly that through the normal debt ledger.
         */
        if (typeof PosnicPro.aclLoaded === 'function' && PosnicPro.aclLoaded()
            && !PosnicPro.checkAccess('customer', 'write')) {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_you_do_not_have_permission_for_that', 'You do not have permission for that.'));
            return;
        }
        if (PosnicPro.sales._settling && PosnicPro.sales._settling[id]) return;
        PosnicPro.sales._settling = PosnicPro.sales._settling || {};
        PosnicPro.sales._settling[id] = true;

        var release = function () {
            delete PosnicPro.sales._settling[id];
        };
        var idOf = function (value) {
            if (!value) return '';
            if (typeof value === 'string') return value;
            if (value.$oid) return String(value.$oid);
            return String(value._id || value.id || value);
        };

        PosnicPro.get('sales/' + encodeURIComponent(id), function (response) {
            if (!response || response.type !== 'success' || !response.data) {
                release();
                PosnicPro.alert('error', (response && response.message)
                    || PosnicPro.i18n.t('lang_that_could_not_be_found_try_refreshing_the', 'That could not be found. Try refreshing the page.'));
                return;
            }
            var sale = response.data;
            var debt = sale.debt_account || {};
            var partyId = idOf(debt.party_id || sale.customer_id || sale.customer);
            if (!partyId) {
                release();
                PosnicPro.alert('warning', PosnicPro.i18n.t('lang_choose_a_customer', 'Choose a customer.'));
                return;
            }

            var remaining = Number(
                debt.invoice_remaining != null ? debt.invoice_remaining
                    : (sale.payment_pending != null ? sale.payment_pending : sale.balance)
            ) || 0;
            if (!(remaining > 0.004)) {
                release();
                PosnicPro.alert('warning', PosnicPro.i18n.t('lang_nothing_outstanding_for_this_party', 'There is no outstanding balance for this party.'));
                return;
            }

            var sign = PosnicPro.local.get('currencySign') || '';
            var amountText = remaining.toFixed(2) + ' ' + sign;
            var message = PosnicPro.i18n.t(
                'lang_settle_bill_confirm',
                'Settle this bill? {amount} will be recorded as paid.'
            ).replace('{amount}', amountText);
            if (!window.confirm(message)) {
                release();
                return;
            }

            var branchId = idOf(sale.branch_id || sale.branch) || PosnicPro.local.get('branch_id_set') || '';
            var recordId = idOf(sale._id || sale.id || id);
            /*
             * A retried request must not create a second payment. The server
             * already de-duplicates on request_id; a key tied to the bill,
             * its current balance and the calendar day keeps an accidental
             * retry idempotent without blocking a genuine later settlement.
             */
            var requestId = ['settle', recordId, remaining.toFixed(2), new Date().toISOString().slice(0, 10)].join(':');
            PosnicPro.post({
                url: 'debts/settle',
                data: JSON.stringify({
                    party_type: 'customer',
                    party_id: partyId,
                    record_id: recordId,
                    branch_id: branchId,
                    request_id: requestId,
                    note: PosnicPro.i18n.t('lang_settle_bill_note', 'Bill settled from sales history')
                })
            }, function (result) {
                release();
                if (!result || result.type !== 'success') {
                    if (result && result.message) PosnicPro.alert('error', result.message);
                    return;
                }
                PosnicPro.alert('success', PosnicPro.i18n.t('lang_bill_settled', 'Bill settled.'));
                if (typeof PosnicPro.sales.loadHistory === 'function') {
                    PosnicPro.sales.loadHistory();
                }
            }, function (xhr) {
                release();
                var result = xhr && (xhr.responseJSON || null);
                if (!result || !result.message) {
                    PosnicPro.alert('error', PosnicPro.i18n.t(
                        'lang_something_went_wrong_try_again_and_check_t',
                        'Something went wrong. Try again, and check the network if it keeps happening.'
                    ));
                }
            });
        }, function () {
            release();
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_something_went_wrong_try_again_and_check_t', 'Something went wrong. Try again, and check the network if it keeps happening.'));
        });
    },
    showReturnPrint: function (id) {
        PosnicPro.sales.view.returnPrintSales(id);
    },
    showHold: function (id) {
        // Payment state is set after the saved sale loads, not on a timer.
        PosnicPro.sales.defaultCustomer = false;
        $('[data-toggle="tooltip"]').tooltip("hide");
        $('#time-format').removeClass('commonDate');
        $('#time-format').addClass('commonEditDate');
        $(".sale_table_head_hide").text('');
        $(".sale_table_head_text").text(PosnicPro.i18n.t('lang_action', 'Action'));
        $('.return_sale_only_show').hide();
        $("#viewtest,#payment_id").show();
        $('#table_return_page,#table_sale_page').find('table').removeAttr('id');
        $('#sales_table').find('table').attr('id', 'sales_new_items_table');
        PosnicPro.collapseMenuForWorkspace();
        $('#show-sale-already-return-table').hide();
        $('#v-pills-dashboard-tab').addClass('active');
        $('#v-pills-dashboard').addClass('show active');
        $("#refund_pay_total,#refund_sub_total,#refund_pay_hide,#refund_sub_hide").hide();
        $(".save_return_submit,#sub_hide,#sub_total_hide,#pay_hide,#pay_total_hide").show();
        $("#payment_note").show();
        $("#items_view_hide").css("display", "block");
        $("#return_view_hide,#check_button,#return_button,#button_return").css("display", "none");
        PosnicPro.sales.recentMenu.recentSalesTabDetails();
        PosnicPro.sales.showSalesHoldPage(id);
        // After retrieving a parked sale, jump to the Items tab - the cashier's
        // next step is almost always to add more items, not stay on Recent Sales.
        $('#home-tab-justified').trigger('click');
        $("#time-format").attr('readOnly', 'true');
        $("#paymentreturnhistory").hide();
        var loader = $(".loader-sales-balance");
        loader.find(".loadingSpinner:first").remove();
    },
    showSalesHoldPage: function (id) {
        PosnicPro.sales.view.showSalesEditPage(id);
    },
    /* #/sales/<id>: the invoice opens in the right pane - never a popup. */
    showDetails: function (id) {
        var self = PosnicPro.sales;
        if (self._openDocId === String(id) && $('#sales_detail_card').is(':visible')) { return; }
        PosnicPro.sales.showDataTablePage._chromeOnly = true;
        try { PosnicPro.sales._historyChrome(); } finally { PosnicPro.sales.showDataTablePage._chromeOnly = false; }
        self.loadHistory(1);
        self.openDoc(id);
    },
    viewSaleDetails: function (id) {
        PosnicPro.sales.showDetails(id);
    },
    _historyChrome: function () {
        PosnicPro.HideSideBarModal();
        $('.page_loader,#osk-container').hide();
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $('.vertical-menu li a').removeClass('active');
        $('#v-pills-dashboard-tab,#view_sales_page').addClass('active');
        $('#v-pills-dashboard').addClass('show active');
        $('.page-title-box,#sales,#view_sales_table,#showsalesbody').show();
    },
    showDataTablePage: function () {
        PosnicPro.sales.recentSaleAction = false;
        var loader = $(".loader-table-sale");
        loader.find(".loadingSpinner:first").remove();
        PosnicPro.dashboard.datePicker();
        PosnicPro.HideSideBarModal();
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $(".vertical-layout").removeClass("toggle-menu");
        $(".vertical-menu li a").removeClass("active");
        $('#v-pills-dashboard-tab,#view_sales_page').addClass('active');
        $('#v-pills-dashboard').addClass('show active');
        $('.page_loader,#osk-container,#closeSaleButton,#closeEditButton').hide();
        $('.page-title-box,#sales,#view_sales_table,#showsalesbody').show();
        $('#view_sales_per_page').closest('.form-group').show();
        $('.card.m-b-30.sales_header .ecommerce-pagination').closest('.card.m-b-30').show();
        PosnicPro.sales.mountHistoryFilters();
        PosnicPro.sales.closeDoc();
        PosnicPro.sales.loadHistory(1);
        $('#image_sidebar_dashboard,#image_sidebar_newsale').hide();
        $('.dashboard_img_menu').hide();
        $('#image_sidebar_salehistry').show();
        var loader = $(".loader-sales-balance");
        loader.find(".loadingSpinner:first").remove();
    },
    /*
     * The shared filter bar on Sales History - the same one the item list and
     * quotes use.
     *
     * It writes into data('filters') and calls the same salesTable, so the
     * endpoint keeps taking the blob it always took. salesTable then re-applies
     * its own sale_process $ne rule on top, which is why this must NOT set that
     * key: the exclusion belongs to the list, not to what anybody filtered,
     * and a bar that wrote it would have the two arguing over one field.
     *
     * Named mountHistoryFilters rather than mountFilters because
     * PosnicPro.sales also owns the quote list, which mounts its own bar under
     * a different key - two things called mountFilters on one namespace is a
     * coin toss for whoever reads it next.
     */
    mountHistoryFilters: function () {
        if (!$('#sales_filter_panel').length) { return; }
        PosnicPro.listFilter.mount({
            key: 'sales',
            onRefresh: function () { return PosnicPro.sales.loadHistory(); },
            onClear: function () { PosnicPro.sales._saleFacets = {}; },
            primaryControls: function (row, state, filterButton) {
                var self = PosnicPro.sales;
                self._saleFacets = self._saleFacets || {};
                var scope = [PosnicPro.local.get('branch_id_set'),PosnicPro.local.get('userid')].join('/');
                if (self._facetScope !== scope) self._saleFacets = {};
                self._facetScope = scope;
                var facets = self._saleFacets;
                function group(key, label, control) {
                    var box = $('<div class="sales-filter-field">').insertBefore(control);
                    var id = 'sales_filter_' + key;
                    var field = control.is('select,input') ? control : control.find('select,input').first();
                    field.attr('id', id);
                    $('<label>').attr('for', id).text(label).appendTo(box);
                    return box.append(control);
                }
                var query = group('query', 'Search sales', row.find('.lf-search')).addClass('sales-query-group');
                query.find('input').attr('type','search');
                group('field', 'Search in', row.find('.lf-field'));
                var date = group('date', 'Sale date', row.find('.lf-preset-wrap')).addClass('sales-date-group');
                var quick = $('#sales_quick_controls').empty();
                var dialog = document.getElementById('sales_filter_dialog');
                var slot = PosnicPro.listFilter.searchBar(quick, filterButton, PosnicPro.i18n.t('lang_filter_sales','Filter sales'));
                var exact = row.find('.lf-exact');
                function placeControls() {
                    PosnicPro.listFilter.queryHint(query.find('.lf-q'), 'sales', !dialog.open);
                    if (dialog.open) { row.prepend(query, date); query.append(exact); }
                    else { row.append(exact); quick.prepend(date); slot.append(query); }
                }
                $(dialog).off('.salesControls').on('salesOpen.salesControls close.salesControls', placeControls);
                placeControls();
                ['seller', 'customer'].forEach(function (key) {
                    var label = key === 'seller' ? PosnicPro.i18n.t('lang_sold_by', 'Sold by') : PosnicPro.i18n.t('lang_newcustomer_title', 'Customer');
                    var input = $('<input type="text" autocomplete="off" class="form-control form-control-sm">')
                        .attr('placeholder', key === 'seller' ? PosnicPro.i18n.t('lang_all_sellers', 'All sellers') : PosnicPro.i18n.t('lang_all_customers', 'All customers'))
                        .val(facets[key]?.label || '').appendTo(row);
                    var box = group(key, label, input);
                    var clear = $('<button type="button" class="sales-facet-clear">&times;</button>')
                        .attr('aria-label', 'Clear ' + label).appendTo(box).toggle(!!facets[key])
                        .on('click', function () { input.val('').trigger('input').trigger('focus'); });
                    if (key === 'seller') {
                        $('<button type="button" class="sales-mine"><lang class="lang_my_sales">My sales</lang></button>').prependTo(box)
                            .toggle(facets.seller?.id !== 'me').on('click', function () {
                                facets.seller = {id:'me',label:PosnicPro.i18n.t('lang_my_sales', 'My sales')};
                                input.val('My sales'); clear.show(); $(this).hide(); self.loadHistory(1);
                            });
                    }
                    if (typeof input.autocomplete !== 'function') { input.prop('disabled', true); return; }
                    input.autocomplete({
                        appendTo:box, minChars:0, deferRequestBy:200, triggerSelectOnValidInput:false,
                        lookup: function (query, done) {
                            PosnicPro.get({url:'sales/historyFilterOptions', data:{field:key, query:query}}, function(r) {
                                done({suggestions:(r.data || []).map(function(o){return {value:o.label,data:o.value};})});
                            }, function(){done({suggestions:[]});});
                        },
                        onSelect: function(choice){
                            facets[key] = {id:choice.data,label:choice.value}; clear.show(); box.find('.sales-mine').show();
                            self.loadHistory(1);
                        }
                    });
                    input.on('focus',function(){input.autocomplete('getSuggestions',this.value);})
                        .on('input',function(){if(!this.value && facets[key]) {delete facets[key];clear.hide();box.find('.sales-mine').show();self.loadHistory(1);}});
                });
            },
            defaultPreset: 'today',
            rows: '#sales_list_rows',
            container: '#sales_filter_search',
            suggestionContainer: '#sales_filter_scope',
            button: '#sales_filter_btn',
            searchPlaceholder: PosnicPro.i18n.t('lang_search_sale_records', 'Search sales by bill number, customer or phone'),
            dateField: PosnicPro.i18n.t('lang_date_title', 'Date'),
            searchFields: [
                { value: 'all', label: PosnicPro.i18n.t('lang_all_fields', 'All fields') },
                { value: 'sales_id', label: PosnicPro.i18n.t('lang_bill_no', 'Bill number') },
                { value: 'customer_name', label: PosnicPro.i18n.t('lang_newcustomer_title', 'Customer') },
                { value: 'customer_phone', label: PosnicPro.i18n.t('lang_phone_title', 'Phone') }
            ],
            /* Suggestions come from the customers this till already uses. */
            typeahead: 'customer',
            typeaheadField: 'customer_name',
            onChange: function () { PosnicPro.sales.loadHistory(1); }
        });
        PosnicPro.listSort.mount('sales', {
            options: [
                { v: 'date_desc', l: PosnicPro.i18n.t('lang_sale_time_newest', 'Sale date & time: newest first'), i: 'clock' },
                { v: 'date_asc', l: PosnicPro.i18n.t('lang_sale_time_oldest', 'Sale date & time: oldest first'), i: 'rotate-ccw' },
                { v: 'recent', l: PosnicPro.i18n.t('lang_order_created_newest', 'Order created: newest first'), i: 'clock' },
                { v: 'updated_desc', l: PosnicPro.i18n.t('lang_updated_newest', 'Last updated: newest first'), i: 'clock' },
                { v: 'total_desc', l: PosnicPro.i18n.t('lang_highest_bill_first', 'Highest bill first'), i: 'arrow-down' },
                { v: 'total_asc', l: PosnicPro.i18n.t('lang_lowest_bill_first', 'Lowest bill first'), i: 'arrow-up' },
                { v: 'items_desc', l: PosnicPro.i18n.t('lang_most_items_first', 'Most items first'), i: 'layers' }
            ],
            onChange: function () { PosnicPro.sales.loadHistory(1); }
        });
    },


    mountProvenanceHistory: function () {
        $('#sales_history_staff_label').text(PosnicPro.i18n.t('lang_staff', 'Staff'));
        if ($.fn.autocomplete) {
            ['staff', 'device'].forEach(function (field) {
                var input = $('#sales_history_' + field), branch = PosnicPro.local.get('branch_id_set') || '';
                if (input.data('historyBranch') === branch) return;
                if (input.data('historyBranch') !== undefined) { input.autocomplete('dispose'); input.val('').removeData('filterValue'); }
                input.data('historyBranch', branch);
                var request = 0;
                input.autocomplete({
                    appendTo: input.parent(), minChars: 0, deferRequestBy: 180, maxHeight: 264, triggerSelectOnValidInput: false,
                    showNoSuggestionNotice: true, noSuggestionNotice: PosnicPro.i18n.t('lang_no_records', 'No Records'),
                    lookup: function (query, done) {
                        var version = ++request;
                        input.autocomplete('setOptions', { noSuggestionNotice: PosnicPro.i18n.t('lang_no_records', 'No Records') });
                        PosnicPro.get({ url: 'sales/historyFilterOptions', data: { branch: branch, field: field, query: query } }, function (r) {
                            if (version !== request || input.data('historyBranch') !== branch) return;
                            if (!r || r.type !== 'success') input.autocomplete('setOptions', { noSuggestionNotice: PosnicPro.i18n.t('lang_desktop_retry', 'Try again') });
                            var options = r && r.type === 'success' && Array.isArray(r.data) ? r.data : [];
                            done({ suggestions: options.map(function (o) { return { value: o.label + (field === 'device' && o.value !== o.label ? ' · ' + o.value : ''), data: o.value }; }) });
                        }, function () { if (version === request && input.data('historyBranch') === branch) { input.autocomplete('setOptions', { noSuggestionNotice: PosnicPro.i18n.t('lang_desktop_retry', 'Try again') }); done({ suggestions: [] }); } });
                    },
                    beforeRender: function (container) {
                        var id = input.attr('id') + '-choices';
                        $(container).addClass('sales-history-options').attr({ id: id, role: 'listbox' }).find('.autocomplete-suggestion').attr('role', 'option');
                        input.attr({ 'aria-controls': id, 'aria-expanded': 'true' });
                    },
                    onHide: function () { input.attr('aria-expanded', 'false'); },
                    onSelect: function (choice) {
                        input.data('filterValue', choice.data);
                        PosnicPro.sales.loadHistory(1);
                    }
                });
                input.off('.historyPicker').on('focus.historyPicker click.historyPicker', function () {
                    if (!input.autocomplete().visible) input.autocomplete('getSuggestions', this.value);
                }).on('blur.historyPicker',function () { request++; });
            });

        }
        $('#sales_history_staff, #sales_history_device').off('input.history').on('input.history', function () {
            $(this).removeData('filterValue');
            clearTimeout(PosnicPro.sales._orderFilterTimer);
            if (!this.value) PosnicPro.sales.loadHistory(1);
            else PosnicPro.sales._orderFilterTimer = setTimeout(function () {
                PosnicPro.sales.loadHistory(1);
            }, 350);
        });
        $('#sales_provenance_reset').off('click.history').on('click.history', function () {
            var mounted = PosnicPro.listFilter._mounted && PosnicPro.listFilter._mounted.sales;
            if (mounted) {
                PosnicPro.sales._saleFacets = {};
                mounted.state = { search: '', field: 'all', exact: false, preset: 'all', from: null, to: null, extra: {} };
                PosnicPro.listFilter.render('sales');
            }
            PosnicPro.sales.loadHistory(1);
        });
    },

    paintHistoryFilters: function () {
        var host = $('#sales_active_filters').empty(), count = 0;
        var add = function (label, remove) {
            count += 1;
            $('<button type="button" class="btn btn-sm btn-light border">').text(label).append('<span class="lf-chip-remove" aria-hidden="true">×</span>').attr('aria-label', 'Remove ' + label).on('click', function () { remove(); PosnicPro.sales.loadHistory(1); }).appendTo(host);
        };
        var mounted = PosnicPro.listFilter._mounted && PosnicPro.listFilter._mounted.sales;
        if (mounted) {
            if (mounted.state.preset !== 'all') {
                add(PosnicPro.listFilter.dateLabel(mounted.state), function () {
                    Object.assign(mounted.state, {preset:'all', from:null, to:null});
                    PosnicPro.listFilter.render('sales');
                });
            }
            if (mounted.state.search) {
                var terms = [mounted.state.search];
                if (mounted.state.field !== 'all') terms.unshift(String(mounted.state.field).replace(/_/g, ' '));
                if (mounted.state.exact) terms.push('Exact');
                add(terms.join(' · '), function () { mounted.state.search = ''; mounted.state.field = 'all'; mounted.state.exact = false; PosnicPro.listFilter.render('sales'); });
            }

        }
        var facets = PosnicPro.sales._saleFacets || {};
        Object.keys(facets).forEach(function(key) {
            if(facets[key]) add(facets[key].label || facets[key],function(){delete facets[key];PosnicPro.listFilter.render('sales');});
        });
        ['staff', 'device'].forEach(function (field) {
            var input = $('#sales_history_' + field);
            if (!input.val()) return;
            var label = input.is('select') ? input.find('option:selected').text() : input.val();
            add(label, function () { input.val('').removeData('filterValue'); });
        });
        $('#sales_filter_btn .lf-count').remove();
        $('#sales_filter_btn').toggleClass('lf-btn-active', count > 0);
        if (count) $('<span class="lf-count">').text(count).appendTo('#sales_filter_btn');
    },

    _histPage: 1,
    HIST_PAGE_SIZE: 25,
    _histRows: [],
    _openDocId: null,
    paintHistorySummary: function (summary) {
        var host = $('#sales_history_summary').empty();
        var t = PosnicPro.i18n.t;
        if (!summary) { host.text(t('lang_refresh_failed', 'Refresh failed')); return; }
        var chip = function (label, value) {
            $('<span class="sales-history-stat">').append($('<span>').text(label), $('<strong>').text(value)).appendTo(host);
        };
        chip(t('lang_salecut_title', 'Sales'), summary.count);
        (summary.currencies || []).forEach(function (group) {
            var money = function (amount) { return (group.currencyCode || group.currencySymbol || PosnicPro.local.get('currencySign') || '') + ' ' + Number(amount).toLocaleString(undefined, { minimumFractionDigits: group.currencyDigits, maximumFractionDigits: group.currencyDigits }); };
            chip(t('lang_total', 'Total'), money(group.total));
        });
        if (!summary.currencies.length) chip(t('lang_total', 'Total'), (PosnicPro.local.get('currencySign') || '') + ' 0.00');
        if (summary.cancelled) chip(t('lang_cancelled', 'Cancelled'), summary.cancelled);
    },
    loadHistory: function (page) {
        clearTimeout(PosnicPro.sales._orderFilterTimer);
        PosnicPro.sales.mountHistoryFilters();
        PosnicPro.sales.mountProvenanceHistory();
        PosnicPro.sales.paintHistoryFilters();
        var self = PosnicPro.sales;
        var requestId = self._historyRequestId = (self._historyRequestId || 0) + 1;
        $('#sales_history_summary').text(PosnicPro.i18n.t('lang_loading_2', 'Loading...'));
        if (page) { self._histPage = page; }
        var filters = PosnicPro.listFilter.legacyFilters('sales', { dateKey: 'date' });
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        PosnicPro.listFilter.request('sales', {
            url: 'sales',
            data: (function () {
                var d = { page: self._histPage, limit: self.HIST_PAGE_SIZE, filters: JSON.stringify(filters), include_summary: 'true' };
                var facets = self._saleFacets || {};
                if(facets.seller) d.seller = facets.seller.id;
                if(facets.customer) d.customerLookup = facets.customer.id;
                var sv = PosnicPro.listSort.value('sales');
                if (sv) { d.sort = sv; }
                [['ordered_by','#sales_history_staff'],['order_device','#sales_history_device']].forEach(function (field) {
                    var value = String($(field[1]).data('filterValue') || $(field[1]).val() || '').trim();
                    if (value) d[field[0]] = value;
                });
                self._lastHistoryQuery = Object.assign({}, d);
                return d;
            }())
        }, function (response) {
            var data = (response && response.data) || {};
            var list = data.list || [];
            if (requestId !== self._historyRequestId) return;
            self._histRows = list;
            self.paintHistorySummary(data.summary);
            if (!list.length) {
                var filtered = PosnicPro.listFilter.activeCount('sales') > 0;
                $('#sales_list_rows').html('<div class="text-center text-muted p-t-20 p-b-20">'
                    + (filtered ? PosnicPro.i18n.t('lang_no_sales_match_this_filter', 'No sales match this filter.') : PosnicPro.i18n.t('lang_no_sales_yet_the_first_bill_will_appear_he', 'No sales yet - the first bill will appear here.')) + '</div>');
                $('#sales_list_paging').html('');
                return;
            }
            var cur = PosnicPro.local.get('currencySign');
            var historySort = PosnicPro.listSort.value('sales');
            var timeLabel = historySort === 'recent' ? PosnicPro.i18n.t('lang_order_created', 'Order created') : historySort === 'updated_desc' ? PosnicPro.i18n.t('lang_last_updated', 'Last updated') : PosnicPro.i18n.t('lang_sale_date_time', 'Sale date & time');
            var html = '<div class="table-responsive"><table class="table table-borderless">'
                + '<thead><tr><th><lang class="lang_bill">Bill #</lang></th><th><lang class="lang_newcustomer_title">Customer</lang></th><th><lang class="lang_sold_by">Sold by</lang></th><th class="sl-col-date">' + esc(timeLabel) + '</th>'
                + '<th class="text-right sl-col-items"><lang class="lang_itemdetail_title">Items</lang></th><th class="text-right"><lang class="lang_total_title">Total</lang></th>'
                + '<th class="text-center"><lang class="lang_userstatus">Status</lang></th></tr></thead><tbody>';
            list.forEach(function (r) {
                var historyTime = historySort === 'recent' ? r.created_date : historySort === 'updated_desc' ? r.updated_date : r.string_date || r.date;
                var digits = Number.isInteger(r.currencyDigits) && r.currencyDigits >= 0 && r.currencyDigits <= 4 ? r.currencyDigits : 2;
                var partial = /partial/i.test(String(r.payment_status || ''));
                var unpaid = partial || String(r.payment_status || '').toLowerCase() === 'unpaid';
                var proc = String(r.sale_process || '');
                var cancelled = /^(cancel|cancelled|canceled)$/i.test(proc.trim()) || /^(cancel|cancelled|canceled)$/i.test(String(r.payment_status || '').trim());
                var pill = cancelled
                    ? '<span class="rs-pill cancelled"><lang class="lang_cancelled">Cancelled</lang></span>'
                    : /return/i.test(proc)
                    ? '<span class="rs-pill hold">' + esc(proc) + '</span>'
                    : partial
                        ? '<span class="rs-pill unpaid"><lang class="lang_partial">Partial</lang></span>'
                    : unpaid
                        ? '<span class="rs-pill unpaid"><lang class="lang_unpaid">Unpaid</lang></span>'
                        : '<span class="rs-pill paid"><lang class="lang_paid">Paid</lang></span>';
                html += '<tr class="md-row sales-row highlight-select' + (self._openDocId === String(r._id) ? ' is-active' : '') + '"'
                    + ' data-id="' + esc(r._id) + '" style="cursor:pointer;">'
                    + '<td>' + esc(r.sales_id) + '</td>'
                    + '<td>' + esc(r.customer_name || 'Walk-in') + '</td>'
                    + '<td>' + esc(r.sold_by || '—') + '</td>'
                    + '<td class="sl-col-date">' + esc(historyTime ? PosnicPro.convertDate(historyTime) : '-') + '</td>'
                    + '<td class="text-right sl-col-items">' + esc(r.number_of_items != null ? r.number_of_items : (r.items || []).length) + '</td>'
                    + '<td class="text-right">' + cur + '&nbsp;' + (Number(r.sales_total) || 0).toFixed(digits) + '</td>'
                    + '<td class="text-center">' + pill + '</td>'
                    + '</tr>';
            });
            html += '</tbody></table></div>';
            $('#sales_list_rows').html(html);
            self.renderHistoryPager(Number(data.total) || list.length);
        }, function () {
            if (requestId !== self._historyRequestId) return;
            self.paintHistorySummary(null);
            $('#sales_list_rows').html('<div class="text-center text-muted p-t-20 p-b-20"><lang class="lang_could_not_load_sales_try_again">Could not load sales - try again.</lang></div>');
        });
    },
    renderHistoryPager: function (total) {
        var self = PosnicPro.sales;
        var p = self._histPage, size = self.HIST_PAGE_SIZE;
        var pages = Math.ceil(total / size) || 1;
        var label = total + ' ' + (total === 1 ? PosnicPro.i18n.t('lang_sale_2', 'sale') : PosnicPro.i18n.t('lang_sales', 'sales'));
        if (pages > 1) { label = 'Page ' + p + ' of ' + pages + ' \u00b7 ' + label; }
        var btn = function (to, text, off, cls) {
            return '<button type="button" class="btn btn-sm ' + (cls || 'btn-secondary-rgba') + ' q-pg-btn"' + (off ? ' disabled' : '')
                + ' onclick="PosnicPro.sales.goHistoryPage(' + to + ');">' + text + '</button>';
        };
        var html = '';
        if (pages > 1) {
            html += btn(p - 1, '&laquo;', p <= 1);
            var end = Math.min(pages, Math.max(1, p - 2) + 4);
            var start = Math.max(1, end - 4);
            for (var n = start; n <= end; n++) {
                html += '<span class="q-pg-num">' + btn(n, n, false, n === p ? 'btn-primary-rgba' : 'btn-secondary-rgba') + '</span>';
            }
        }
        html += '<span class="q-pg-count">' + label + '</span>';
        if (pages > 1) { html += btn(p + 1, '&raquo;', p >= pages); }
        $('#sales_list_paging').html(html);
    },
    goHistoryPage: function (n) {
        if (!n || n < 1) { return; }
        PosnicPro.sales._histPage = n;
        PosnicPro.sales.loadHistory();
    },
    /* ---- the invoice pane ---- */
    /* A quick look at a bill WITHOUT leaving the page you are on. The
       recent-sales rail lives on the NEW SALE screen - its View eye used
       to navigate into the sales-history split, dumping the cashier off
       the till mid-shift (owner: "keep the user in same page itself").
       The same invoice sheet now opens in a modal; the history page stays
       one deliberate click away, never an accident. */
    peekSale: function (id) {
        if (!$('#sale_peek_modal').length) {
            $('body').append(
                '<div class="modal fade close_on_esc" id="sale_peek_modal" tabindex="-1" role="dialog" aria-hidden="true">'
                + '<div class="modal-dialog modal-lg" role="document"><div class="modal-content">'
                + '<div class="modal-header" style="align-items:center;">'
                + '<h5 class="modal-title" id="sale_peek_title"><lang class="lang_bill_2">Bill</lang></h5>'
                + '<button type="button" class="close" data-dismiss="modal" aria-label="Close" data-t-aria-label="lang_close_title"><span aria-hidden="true">&times;</span></button>'
                + '</div>'
                + '<div class="modal-body" id="sale_peek_body" style="max-height:70vh; overflow-y:auto;"></div>'
                + '<div class="modal-footer" id="sale_peek_footer" style="justify-content:space-between;"></div>'
                + '</div></div></div>');
        }
        $('#sale_peek_title').text(PosnicPro.i18n.t('lang_bill_2', 'Bill'));
        $('#sale_peek_footer').html('');
        $('#sale_peek_body').html('<div class="text-center text-muted" style="padding:40px;"><lang class="lang_loading_4">Loading ...</lang></div>');
        $('#sale_peek_modal').modal('show');
        PosnicPro.get('sales/' + id, function (response) {
            if (response.type !== 'success' || !response.data) {
                $('#sale_peek_body').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_bill">Could not open this bill.</lang></div>');
                return;
            }
            var d = response.data;
            var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
            $('#sale_peek_title').text(d.sales_id || 'Bill');
            $('#sale_peek_footer').html(
                '<a href="javascript:void(0)" class="q-muted" style="font-size:13px;"'
                + ' onclick="$(\'#sale_peek_modal\').modal(\'hide\'); hasher.setHash(\'sales/' + esc(d._id || id) + '\');">'
                + 'Open in Sales history &rarr;</a>'
                + '<button type="button" class="btn btn-sm btn-light" onclick="PosnicPro.sales.showPrint(\'' + esc(d._id || id) + '\'); return false;">'
                + '<i class="feather icon-printer mr-1"></i>Print</button>');
        }, function () {
            $('#sale_peek_body').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_bill">Could not open this bill.</lang></div>');
        });
    },
    openDoc: function (id) {
        var self = PosnicPro.sales;
        if (!PosnicPro.masterDetail.inSplit('#sales_split', 'saleshist-split')) {
            PosnicPro.masterDetail.enter('#sales_split', 'saleshist-split');
            $('#sales_detail_card').show();
        }
        self._openDocId = String(id);
        $('#sales_list_rows tr.sales-row').removeClass('is-active');
        $('#sales_list_rows tr.sales-row[data-id="' + id + '"]').addClass('is-active');
        if (window.location.hash.slice(2) !== 'sales/' + id) {
            hasher.setHash('sales/' + id);
        }
        $('#sales_doc').html('<div class="text-center text-muted" style="padding:60px;"><lang class="lang_loading_4">Loading ...</lang></div>');
        PosnicPro.get('sales/' + id, function (response) {
            if (response.type !== 'success' || !response.data) {
                $('#sales_doc').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_sale">Could not open this sale.</lang></div>');
                return;
            }
            PosnicPro.sales.renderSaleDoc(response.data);
            PosnicPro.ACLForModule('sales');
        }, function () {
            $('#sales_doc').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_sale">Could not open this sale.</lang></div>');
        });
    },
    closeDoc: function () {
        PosnicPro.sales._openDocId = null;
        $('#sales_detail_card').hide();
        $('#sales_list_rows tr.sales-row').removeClass('is-active');
        PosnicPro.masterDetail.leave('#sales_split', 'saleshist-split');
        if (/^sales\/[0-9a-f]{24}$/i.test(window.location.hash.slice(2))) {
            hasher.setHash('sales');
        }
    },
    /* The sale as its own INVOICE sheet - the same q-sheet language every
       document in the product wears. */
    buildSaleSheet: function (d) {
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        var money = function (v) { return PosnicPro.local.get('currencySign') + '&nbsp;' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); };
        var real = function (v) { return v && v !== 'null' && v !== 'undefined' ? v : ''; };
        var unpaid = /partial|^unpaid$/i.test(String(d.payment_status || ''));
        var proc = String(d.sale_process || '');
        var cancelled = /^(cancel|cancelled|canceled)$/i.test(proc.trim()) || /^(cancel|cancelled|canceled)$/i.test(String(d.payment_status || '').trim());
        var stamp = cancelled ? PosnicPro.i18n.t('lang_cancelled', 'Cancelled').toUpperCase()
            : /return/i.test(proc) ? proc.toUpperCase()
            : /partial/i.test(String(d.payment_status || '')) ? PosnicPro.i18n.t('lang_partially_paid_3', 'PARTIALLY PAID')
            : unpaid ? PosnicPro.i18n.t('lang_unpaid_2', 'UNPAID') : PosnicPro.i18n.t('lang_paid_2', 'PAID');
        var logo = PosnicPro.local.get('branchimage');
        var seller = '<div class="q-seller">'
            + (logo && logo !== 'store.png' ? '<img loading="lazy" decoding="async" class="q-logo" src="' + esc(logo) + '" alt="">' : '')
            + '<div class="q-shop">' + esc(PosnicPro.local.get('branchname') || '') + '</div>';
        var addr = real(PosnicPro.local.get('branchaddress'));
        var ph = real(PosnicPro.local.get('branchphone'));
        var em = real(PosnicPro.local.get('branchemail'));
        if (addr) { seller += '<div class="q-muted">' + esc(addr) + '</div>'; }
        if (ph || em) { seller += '<div class="q-muted">' + esc(ph) + (ph && em ? ' &middot; ' : '') + esc(em) + '</div>'; }
        seller += '</div>';
        var title = '<div class="q-title-block">'
            + '<div class="q-num">' + esc(d.sales_id) + '</div>'
            + '<div class="q-muted">Date: ' + esc(d.string_date ? String(d.string_date).slice(0, 10) : (d.date ? String(d.date).slice(0, 10) : '-')) + '</div>'
            + '<div class="q-status" data-status="' + (cancelled ? 'cancelled' : /return/i.test(proc) ? 'returned' : unpaid ? 'unpaid' : 'paid') + '">' + esc(stamp) + '</div>'
            + '</div>';
        var billto = '<div class="q-billto"><div class="q-label"><lang class="lang_bill_to_2">Bill To</lang></div>'
            + '<div class="q-cust">' + esc(d.customer_name || 'Walk-in customer') + '</div>'
            + (real(d.customer_phone) ? '<div class="q-muted">Phone: ' + esc(d.customer_phone) + '</div>' : '')
            + (real(d.customer_email) ? '<div class="q-muted">' + esc(d.customer_email) + '</div>' : '')
            + '</div>';
        var items = '<div class="table-responsive"><table class="q-items"><thead><tr>'
            + '<th>#</th><th><lang class="lang_newitem_title">Item</lang></th><th class="text-right"><lang class="lang_qty_title">Quantity</lang></th>'
            + '<th class="text-right"><lang class="lang_price_title">Price</lang></th><th class="text-right"><lang class="lang_amount_title">Amount</lang></th>'
            + '</tr></thead><tbody>';
        var displayLines = Array.isArray(d.receipt_line_rows) ? d.receipt_line_rows.map(function (line) {
            return { item_name: line.name, item_quantity: line.qty, item_unit: line.unit, item_base_price: line.rate, display_amount: line.amount };
        }) : (d.items || []);
        displayLines.forEach(function (l, i) {
            var unit = Number(l.item_base_price);
            if (!Number.isFinite(unit)) {
                unit = Number(l.item_price) || 0;
            }

            items += '<tr><td>' + (i + 1) + '</td><td>' + esc(l.item_name) + '</td>'
                + '<td class="text-right">' + esc(l.item_quantity) + ' ' + esc(l.item_unit || '') + '</td>'
                + '<td class="text-right">' + money(unit) + '</td>'
                + '<td class="text-right">' + money(l.display_amount != null ? l.display_amount : unit * (Number(l.item_quantity) || 0)) + '</td></tr>';
        });
        items += '</tbody><tfoot>'
            + '<tr class="q-sub"><td colspan="4" class="text-right"><lang class="lang_subtotal">Subtotal</lang></td>'
            + '<td class="text-right">' + money(d.sales_sub_total) + '</td></tr>'
            + (Number(d.discount) > 0
                ? '<tr class="q-sub"><td colspan="4" class="text-right"><lang class="lang_discount_title">Discount</lang></td><td class="text-right">-' + money(d.discount) + '</td></tr>'
                : '')
            + [
                ['Additional discount', -(Number(d.sale_extra_discount) || 0)],
                ['Round off', Number(d.sales_round_off) || 0]
            ].concat((d.charges || []).map(function (c) { return [c.name, Number(c.amount) || 0]; }))
                .filter(function (row) { return row[1] !== 0; })
                .map(function (row) { return '<tr class="q-sub"><td colspan="4" class="text-right">' + esc(row[0])
                    + '</td><td class="text-right">' + money(row[1]) + '</td></tr>'; }).join('')
            + '<tr class="q-grand"><th colspan="4" class="text-right"><lang class="lang_total">TOTAL</lang></th>'
            + '<th class="text-right">' + money(d.sales_total) + '</th></tr>'
            + (function () {
                /*
                 * A bill and the customer account are one story. Show the
                 * payment position where the reader is already looking - under
                 * the total - instead of a small corner note. The server
                 * attaches `debt_account` with the amount paid at the counter,
                 * every later collection allocated to this bill, and what is
                 * still owed. Older documents fall back to their own saved
                 * payment fields so a bill never loses its history.
                 */
                var total = Number(d.sales_total != null ? d.sales_total : (d.total != null ? d.total : d.items_total)) || 0;
                var debt = d.debt_account || null;
                var paidAtSale = null;
                if (debt && debt.paid_at_sale != null) {
                    paidAtSale = Number(debt.paid_at_sale) || 0;
                } else if (d.paid_amount != null && Number.isFinite(Number(d.paid_amount))) {
                    paidAtSale = Number(d.paid_amount) || 0;
                } else if (d.partial_amounts != null && Number.isFinite(Number(d.partial_amounts))) {
                    paidAtSale = Number(d.partial_amounts) || 0;
                } else if (String(d.partial_check) === 'true') {
                    paidAtSale = Number(d.partial_balance) || 0;
                } else if (/^(paid|completed)$/i.test(String(d.payment_status || ''))) {
                    paidAtSale = total;
                } else {
                    paidAtSale = 0;
                }
                var paidLater = debt && debt.paid_at_sale != null
                    ? Number(debt.paid_later) || 0
                    : 0;
                /*
                 * The statement's invoice total and remaining are the ledger's
                 * own arithmetic. Prefer them so an account credit or a
                 * historical adjustment cannot make Paid + Remaining disagree
                 * with the bill; fall back to the document fields when the
                 * ledger has no invoice row for this sale.
                 */
                var accountTotal = debt && debt.invoice_total != null
                    ? Number(debt.invoice_total) || 0
                    : total;
                var remaining = debt && debt.invoice_remaining != null
                    ? Number(debt.invoice_remaining)
                    : Number(d.payment_pending);
                var paidTotal;
                if (debt && debt.invoice_remaining != null) {
                    paidTotal = Math.min(accountTotal, Math.max(0, accountTotal - remaining));
                } else {
                    paidTotal = Math.min(total, paidAtSale + paidLater);
                }
                if (!Number.isFinite(remaining) || remaining < 0) {
                    remaining = Math.max(0, total - paidTotal);
                }
                if (remaining < 0.004) remaining = 0;

                var paymentRows = [];
                var salePayments = Array.isArray(d.payments) ? d.payments : [];
                if (debt && debt.paid_at_sale != null) {
                    if (paidAtSale > 0) {
                        paymentRows.push({
                            date: d.receipt_date || d.date || d.created_date,
                            label: d.payment_mode || PosnicPro.i18n.t('lang_paid_at_sale', 'Paid at sale'),
                            amount: paidAtSale
                        });
                    }
                    (Array.isArray(debt.payments) ? debt.payments : []).forEach(function (payment) {
                        if (!(Number(payment.amount) > 0)) return;
                        paymentRows.push({
                            date: payment.date,
                            label: payment.note || payment.reference || PosnicPro.i18n.t('lang_paid_later', 'Paid later'),
                            amount: Number(payment.amount) || 0
                        });
                    });
                } else if (salePayments.length) {
                    salePayments.forEach(function (payment) {
                        if (!(Number(payment.amount) > 0)) return;
                        paymentRows.push({
                            date: payment.date,
                            label: payment.method || payment.reference || payment.notes || PosnicPro.i18n.t('lang_payment_2', 'Payment'),
                            amount: Number(payment.amount) || 0
                        });
                    });
                    if (!(paidTotal > 0)) {
                        paidTotal = paymentRows.reduce(function (sum, row) { return sum + row.amount; }, 0);
                    }
                } else if (paidTotal > 0) {
                    paymentRows.push({
                        date: d.receipt_date || d.date || d.created_date,
                        label: d.payment_mode || PosnicPro.i18n.t('lang_payment_2', 'Payment'),
                        amount: paidTotal
                    });
                }

                var fmtDT = function (value) {
                    if (!value) return '';
                    // Use the statement formatter so a collection is shown in
                    // the shop's timezone, not the browser's.
                    if (PosnicPro.debts && PosnicPro.debts.formatDateTime) {
                        return PosnicPro.debts.formatDateTime(value);
                    }
                    if (typeof moment !== 'undefined') {
                        var m = moment(value);
                        if (m.isValid()) return m.format('YYYY-MM-DD HH:mm');
                    }
                    return String(value).replace('T', ' ').slice(0, 16);
                };
                var html = '';
                if (paymentRows.length) {
                    html += '<tr class="q-payment-history"><td colspan="5">'
                        + '<div class="q-payment-history-list">'
                        + paymentRows.map(function (row) {
                            return '<div class="q-payment-line">'
                                + '<span class="q-payment-date">' + esc(fmtDT(row.date)) + '</span>'
                                + '<span class="q-payment-label">' + esc(row.label) + '</span>'
                                + '<span class="q-payment-amount">' + money(row.amount) + '</span>'
                                + '</div>';
                        }).join('')
                        + '</div></td></tr>';
                }
                html += '<tr class="q-due"><th colspan="4" class="text-right">'
                    + '<lang class="lang_remaining">Remaining</lang></th>'
                    + '<th class="text-right q-due-amount">' + money(remaining) + '</th></tr>';
                var accountId = debt && debt.party_id ? debt.party_id : (d.customer_id || '');
                var accountBalance = debt && debt.outstanding != null ? debt.outstanding : d.customer_balance;
                if (accountId && accountBalance != null && Number.isFinite(Number(accountBalance))) {
                    var partyType = debt && debt.party_type ? debt.party_type : 'customer';
                    var statementLabel = partyType === 'supplier'
                        ? PosnicPro.i18n.t('lang_supplier_statement', 'Supplier statement')
                        : PosnicPro.i18n.t('lang_customer_statement', 'Customer statement');
                    html += '<tr class="q-account"><td colspan="4" class="text-right">'
                        + esc(statementLabel) + '</td>'
                        + '<td class="text-right"><a href="javascript:void(0)" class="q-account-link"'
                        + ' onclick="if(PosnicPro.debts&&PosnicPro.debts.openStatement){PosnicPro.debts.openStatement(\''
                        + esc(partyType) + '\', \'' + esc(accountId) + '\');}return false;">'
                        + money(accountBalance) + '</a></td></tr>';
                }
                return html;
            })()
            + '</tfoot></table></div>';
        var footer = '<div class="q-footer">';
        if (real(d.payment_description)) {
            footer += '<div class="q-block"><div class="q-label"><lang class="lang_payment_2">Payment</lang></div><div class="q-muted">' + esc(d.payment_description) + '</div></div>';
        }
        if (real(d.sales_description)) {
            footer += '<div class="q-block"><div class="q-label"><lang class="lang_notes_title">Notes</lang></div><div class="q-muted">' + esc(d.sales_description) + '</div></div>';
        }
        footer += '</div>';
        return '<div class="q-sheet">'
            + '<div class="q-head">' + seller + title + '</div>'
            + billto + items + footer
            + '</div>';
    },
    /* Email the bill's PDF - the address defaults to the customer's own. */
    emailSale: function (id, defaultEmail) {
        swal({
            title: PosnicPro.i18n.t('lang_email_this_bill', 'Email this bill'),
            text: defaultEmail ? 'Leave empty to send to ' + defaultEmail : 'Where should the PDF go?',
            input: 'text',
            inputPlaceholder: defaultEmail || 'customer@example.com',
            showCancelButton: true,
            confirmButtonText: 'Send'
        }).then(function (result) {
            if (result && result.dismiss) { return; }
            var typed = typeof result === 'string' ? result : (result && result.value) || '';
            var to = $.trim(typed) || defaultEmail;
            if (!to) { PosnicPro.alert('warning', PosnicPro.i18n.t('lang_no_email_address_to_send_to', 'No email address to send to.')); return; }
            PosnicPro.get({ url: 'sales/salesMailPdf', data: { id: id, email: to } }, function (r) {
                PosnicPro.alert(r.type || 'success', r.message || 'Sent');
            }, function (xhr) {
                var resp = {}; try { resp = jQuery.parseJSON(xhr.responseText) || {}; } catch (e) { }
                PosnicPro.alert('error', resp.message || 'Could not send the email');
            });
        }).catch(function () { /* dismissed */ });
    },
    renderSaleDoc: function (d) {
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        var id = String(d._id || d.id || PosnicPro.sales._openDocId);
        var partial = /partial/i.test(String(d.payment_status || ''));
        var unpaid = partial || String(d.payment_status || '').toLowerCase() === 'unpaid';
        var proc = String(d.sale_process || '');
        var cancelled = /^(cancel|cancelled|canceled)$/i.test(proc.trim()) || /^(cancel|cancelled|canceled)$/i.test(String(d.payment_status || '').trim());
        var pill = cancelled
            ? '<span class="rs-pill cancelled"><lang class="lang_cancelled">Cancelled</lang></span>'
            : /return/i.test(proc)
            ? '<span class="rs-pill hold">' + esc(proc) + '</span>'
            : partial ? '<span class="rs-pill unpaid"><lang class="lang_partial">Partial</lang></span>'
            : unpaid ? '<span class="rs-pill unpaid"><lang class="lang_unpaid">Unpaid</lang></span>' : '<span class="rs-pill paid"><lang class="lang_paid">Paid</lang></span>';
        var toolbar = '<div class="p-doc-toolbar">'
            + '<button type="button" class="btn btn-sm btn-light" title="Show or hide the list" data-t-title="lang_show_or_hide_the_list" aria-label="Show or hide the list" data-t-aria-label="lang_show_or_hide_the_list" onclick="PosnicPro.masterDetail.toggleRail(\'#sales_split\');"><i class="feather icon-sidebar"></i></button>'
            + '<span class="p-doc-title">' + esc(d.sales_id) + '</span>' + pill
            + '<span class="ml-auto"></span>'
            + (unpaid && !cancelled
                ? '<button type="button" class="btn btn-sm btn-primary" data-module="customer" data-access="write" onclick="PosnicPro.sales.showPayment(\'' + esc(id) + '\');"><i class="feather icon-credit-card mr-1"></i><lang class="lang_settle_bill">Settle Bill</lang></button>'
                : '')
            + '<div class="btn-group" data-sale-edit-menu data-module="sales" data-access="write">'
            + '<button type="button" class="btn btn-sm btn-light dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" aria-label="Edit" data-t-aria-label="lang_edit_title"><i class="feather icon-edit-2 mr-1"></i><lang class="lang_edit_title">Edit</lang></button>'
            + '<div class="dropdown-menu dropdown-menu-right" data-sale-edit-actions>'
            + '<button type="button" class="dropdown-item" onclick="hasher.setHash(\'sales/' + esc(id) + '/edit\');"><i class="feather icon-edit-2 mr-2"></i><lang class="lang_edit_this_bill">Edit this bill</lang></button>'
            + '</div></div>'
            + '<div class="btn-group">'
            + '<button type="button" class="btn btn-sm btn-light dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><lang class="lang_share">Share</lang></button>'
            + '<div class="dropdown-menu dropdown-menu-right">'
            + '<a class="dropdown-item" href="javascript:void(0)" onclick="PosnicPro.sales.showPrint(\'' + esc(id) + '\'); return false;"><i class="feather icon-printer mr-2"></i>Print</a>'
            + '<a class="dropdown-item" href="javascript:void(0)" onclick="PosnicPro.sales.showPdf(\'' + esc(id) + '\'); return false;"><i class="feather icon-file mr-2"></i>Download PDF</a>'
            + '<a class="dropdown-item" href="javascript:void(0)" onclick="PosnicPro.sales.emailSale(\'' + esc(id) + '\', \'' + esc(d.customer_email || '') + '\');"><i class="feather icon-mail mr-2"></i>Email</a>'
            + '</div></div>'
            + (!/return/i.test(proc)
                ? '<div class="btn-group">'
                    + '<button type="button" class="btn btn-sm btn-light dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><lang class="lang_tab_more">More</lang></button>'
                    + '<div class="dropdown-menu dropdown-menu-right">'
                    + '<a class="dropdown-item" data-module="sales" data-access="write" href="javascript:void(0)" onclick="hasher.setHash(\'sales/' + esc(id) + '/return\');"><i class="feather icon-corner-up-left mr-2"></i>Return items</a>'
                    + (PosnicPro.local.get('usertype') === 'super_admin' && PosnicPro.local.get('allow_sale_hard_delete') === 'true' ? '<a class="dropdown-item text-danger" data-module="sales" data-access="delete" href="javascript:void(0)" onclick="PosnicPro.sales.showDelete(\'' + esc(id) + '\');"><i class="feather icon-trash-2 mr-2"></i><lang class="lang_delete_sale">Delete sale</lang></a>' : '')
                    + '</div></div>'
                : '')
            + '<button type="button" class="btn btn-sm btn-light" title="Close and show the full list" data-t-title="lang_close_and_show_the_full_list" aria-label="Close" data-t-aria-label="lang_close_title" onclick="PosnicPro.sales.closeDoc();"><i class="feather icon-x"></i></button>'
            + '</div>';
        $('#sales_doc').html(toolbar + '<div class="doc-scroll">' + PosnicPro.sales.buildSaleSheet(d) + '</div>');
    },
    searchItem: function (id) {
        var matched = false;
        for (var key in PosnicPro.sales.SaleTableLineItems) {
            if (PosnicPro.sales.SaleTableLineItems.hasOwnProperty(key)) {
                if (PosnicPro.sales.SaleTableLineItems[key].item_id === id) {
                    matched = PosnicPro.sales.SaleTableLineItems[key];
                }
            }
        }
        return matched;
    },
    /*ADD SALES LINE ITEMS ADD IN ADD SALE PRODUCT TABLE*/
    /*
     * Price lists (V4): the selected customer's category prices newly
     * added lines - a per-item override wins, else the percentage rule,
     * else the normal selling price. Applied ONCE per line at add time.
     * Changing the customer mid-sale does not reprice lines already on
     * the sale (documented default - re-add the line to reprice it).
     */
    _customerCategoryId: '',
    _priceLists: null,
    _priceListsAt: 0,
    _loadPriceLists: function () {
        if (PosnicPro.sales._priceLists && (Date.now() - PosnicPro.sales._priceListsAt) < 60000) { return; }
        PosnicPro.get({ url: 'setting/priceLists', data: {} }, function (r) {
            PosnicPro.sales._priceLists = (r && r.data) || [];
            PosnicPro.sales._priceListsAt = Date.now();
        }, function () { PosnicPro.sales._priceLists = []; });
    },
    _applyPriceList: function (params) {
        if (params._priceListApplied) { return params; }
        params._priceListApplied = true;
        var catId = PosnicPro.sales._customerCategoryId;
        var lists = PosnicPro.sales._priceLists;
        if (!catId || !lists || !lists.length) { return params; }
        var list = null;
        for (var i = 0; i < lists.length; i++) {
            if (String(lists[i].customer_category_id) === String(catId)) { list = lists[i]; break; }
        }
        if (!list) { return params; }
        var itemId = String(params.product_id || params.id || params.item_id);
        var override = null;
        (list.item_overrides || []).forEach(function (o) {
            if (String(o.item_id) === itemId) { override = o; }
        });
        var oldPrice = Number(params.selling_price) || 0;
        var newPrice = oldPrice;
        if (override) {
            newPrice = Number(override.price);
        } else if (list.percent_off) {
            newPrice = oldPrice * (1 - Number(list.percent_off) / 100);
            newPrice = Math.round(newPrice * 100) / 100;
        }
        if (Number.isFinite(newPrice) && newPrice >= 0 && newPrice !== oldPrice) {
            // Both fields move together: inclusive de-grossing and discount
            // math downstream read either.
            params.selling_price = newPrice;
            params.mrp_price = newPrice;
        }
        return params;
    },
    /*
     * AN ITEM PRICED ON THE DAY IS NOT AN ITEM PRICED AT NOTHING.
     *
     * Owner: "we will not bill with 0 for sure. we need to add with amount
     * only. its daily price or market price item. needs to be handled
     * properly."
     *
     * The sale screen reads the catalogue price into the line, and a
     * market-price item has no catalogue price, so it went onto the bill at
     * zero and nothing said a word.
     *
     * ASKED WHEN THE LINE IS ADDED, not refused when the bill is paid. The
     * operator is standing at this screen now; the customer is waiting at the
     * till later. Refusing at payment time would be correct and useless.
     *
     * The same rule the server uses, so the two doors agree: the shop marked
     * it open_price, or it simply has no price. A RETURN is left alone - that
     * is repricing something already sold, and today's rate is the wrong
     * question for it.
     */
    _needsTodaysPrice: function (params) {
        if (!params) { return false; }
        if (params._priceAsked) { return false; }
        if (PosnicPro.sales.SaleAction === 'return') { return false; }
        if (params.open_price === true || params.open_price === 'true') { return !(PosnicPro.saleExtensions && PosnicPro.saleExtensions.policy('useDefaultOpenPrice') && Number(params.selling_price) > 0); }
        return !(Number(params.selling_price) > 0);
    },
    askTodaysPrice: function (params) {
        var name = params.item_name || params.name || 'This item';
        swal({
            title: PosnicPro.i18n.t('lang_price_today', 'Price today'),
            text: name + ' is priced on the day. What is it today?',
            input: 'text',
            inputPlaceholder: '0.00',
            showCancelButton: true,
            confirmButtonText: PosnicPro.i18n.t('lang_add_to_sale', 'Add to sale')
        }).then(function (result) {
            if (result && result.dismiss) { return; }
            var typed = typeof result === 'string' ? result : (result && result.value) || '';
            var price = Number($.trim(typed));
            /* Nothing is not an answer. The line is dropped rather than added
               at zero, which is the whole point of the gate. */
            if (!(price > 0)) {
                PosnicPro.alert('warning', name + ' was not added, because it needs today\'s price.');
                return;
            }
            /* The same ceiling the server applies: a fat finger is the likeliest
               way a wrong number arrives, and ten lakh for an item should not be
               accepted quietly. */
            if (price > 1000000) {
                PosnicPro.alert('warning', typed + ' looks wrong for ' + name + '. Check the price.');
                return;
            }
            /* Both fields move together, the same rule the price list follows -
               inclusive de-grossing and the discount maths downstream read
               either one. */
            params._priceAsked = true;
            params.selling_price = price;
            params.mrp_price = price;
            PosnicPro.sales.addSalesLineItems(params);
        }).catch(function () { /* dismissed */ });
    },
    addSalesLineItems: function (params) {
        if (!params._quantityConfirmed && PosnicPro.sales.isWeighedItem && PosnicPro.sales.isWeighedItem(params) && PosnicPro.sales.SaleAction !== 'return') {
            PosnicPro.sales.askSearchQuantity(Object.assign({}, params, { _searchDetailsLoaded: true }), params.id || params.item_id);
            return;
        }
        // Recency (owner feedback): every added item feeds the recent list -
        // written here so search, scan, camera, tiles and recents all count.
        if (PosnicPro.sales._recentPush && params.sales_type !== 'instant') {
            PosnicPro.sales._recentPush('recent_items', {
                id: params.product_id || params.id || params.item_id,
                name: params.item_name || params.name,
                price: params.selling_price,
                image: params.image || 'item.svg'
            }, 'id');
        }
        if (params.selling_units && params.selling_units.length && !params._sellingUnitChosen) {
            PosnicPro.sales.chooseSellingUnit(params, function (chosen) { PosnicPro.sales.addSalesLineItems(chosen); });
            return;
        }
        // Price list first, so the customer's price reaches the line.
        if (PosnicPro.sales.SaleAction !== 'return'
            && PosnicPro.sales.searchItem(params.id ? params.id : params.item_id) === false) {
            params = PosnicPro.sales._applyPriceList(params);
        }
        // An item priced on the day is asked for before it can reach the bill.
        if (PosnicPro.sales._needsTodaysPrice(params)) {
            PosnicPro.sales.askTodaysPrice(params);
            return;
        }
        var item = PosnicPro.sales.searchItem(params.id);
        // if (item !== false) {
        //     // existing item, do not add
        //     return;
        // }
        $('table#sales_new_items_table tr#sales_new_tablerow_content_area').remove();
        var item_quantity = (typeof (params.item_quantity) != "undefined" && params.item_quantity !== null) ? params.item_quantity : 1;
        if (PosnicPro.sales.editSaleAction === true) {
            PosnicPro.sales.recentMenu.setEditSalesDetails();
        }
        // Imported/catalogue products may omit discount fields entirely.
        params.discount_amount = Number(params.discount_amount) || 0;
        params.discount_percentage = Number(params.discount_percentage) || 0;
        var addSalesLineDiscount = (params.discount_amount > 0) ? params.discount_amount : params.discount_percentage;
        var Discount = (params.discount_amount > 0) ? params.discount_amount : params.selling_price * (params.discount_percentage / 100);
        var currencySign = PosnicPro.local.get('currencySign');
        var discountSign = (params.discount_amount > 0) ? currencySign : '%';
        if ((params.discount_amount > 0)) {
            var discount_percentages = '' + discountSign + '' + addSalesLineDiscount + '';
        } else {
            var discount_percentages = '' + addSalesLineDiscount + '' + discountSign + '';

        }
        var isDiscountAmount = params.discount_amount > 0;
        var discountDisplay = isDiscountAmount ? currencySign + addSalesLineDiscount : addSalesLineDiscount + discountSign;
        var id = params.id ? params.id : params.item_id;
        var item_name = PosnicPro.itemName ? PosnicPro.itemName(params) : (params.item_name || params.name);
        var item_description = '';
        if (typeof (params.item_description) !== "undefined" && params.item_description !== null) {
            item_description = params.item_description;
        }
        // Normalize any HTML description into plain text so it looks clean in the textarea
        if (item_description && typeof item_description === 'string') {
            item_description = $('<div>').html(item_description).text();
        }
        var item = PosnicPro.sales.searchItem(id);

        if (item !== false) {
            if (PosnicPro.sales.SaleAction === 'return') {
                return false;
            } else {
                var lineqty = params.available_quantity - placedQty;
                /*
                 * parseFloat, not parseInt.
                 *
                 * Adding the same item twice adds the two quantities. With
                 * parseInt, 0.300kg of onions already in the cart read as 0,
                 * so scanning them again replaced the weight with a whole
                 * number - the customer was billed 1kg for 600g.
                 */
                item_quantity = (lineqty === 0) ? item_quantity
                    : parseFloat(item_quantity) + parseFloat($('#touchsale_item_qty' + id).val());
            }
        }
        if (params.track_inventory === true && params.negative_stock === false) {
            var placedQty = $('#touchsale_item_qty' + id).val();
            if (params.available_quantity <= placedQty) {
                $('#touchsale_item_qty' + id).val(params.available_quantity);
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                return false;
            }
        }

        /*While Refund Sale If Add New Item SalesExchange Should be True - Ordertype Set Into Exchange*/
        var ordertype = (PosnicPro.sales.salesExchange === true) ? 'exchange' : PosnicPro.sales.SaleAction;
        if ((PosnicPro.sales.SaleAction === 'return')) {
            $('#payment_description').editable('setValue', PosnicPro.sales.EditRecentSaleParams.payment_description);
            $('#sales_description').editable('setValue', PosnicPro.sales.EditRecentSaleParams.sales_description);

            if (PosnicPro.sales.EditRecentSaleParams && typeof PosnicPro.sales.EditRecentSaleParams.discount_description !== 'undefined') {
                var discountNote = PosnicPro.sales.EditRecentSaleParams.discount_description || '';
                if (discountNote === '') {
                    $('#discount_description').text('').val('').hide();
                    $('#click_discount_description').css({ color: '#506fe4' });
                } else {
                    $('#discount_description').val(discountNote).hide();
                    $('#discount_description').editable('setValue', discountNote);
                    $('#click_discount_description').css({ color: '#5fd799' });
                }
            }
            var updateReturnPrice = params.selling_price * 1;
            var PriceReturnDiscount = Discount * 1;
            var updateReturnLineTotal = updateReturnPrice - PriceReturnDiscount;
            var return_line_total = updateReturnLineTotal;
            //            $('.changeSalesBtnText').text(PosnicPro.i18n.t('lang_return_title', 'Return'));
            $('.salesBalanceAmount').hide();
            $('.changeSalesBtnText').text(PosnicPro.i18n.t('lang_action_return_sale_btn', 'Return'));
            $('#closeSaleButton').show();
            $("#return_disc").css("display", "none");
            $('#sales_new_customer_name').val(PosnicPro.sales.EditRecentSaleParams.customer_name);
            $(".vertical-layout").removeClass("toggle-menu");
            $('#v-pills-dashboard-tab').addClass('active');
            $('#v-pills-dashboard').addClass('show active');
            var addLineItemQty = '<div class="input-group">' +
                '<div class="input-group-prepend" id = ' + id + '  onclick="PosnicPro.sales.quantity.qtyreturnDecrease(this.id,0);">' +
                '<span class="btn btn-secondary-rgba button_qty_check"><i class="feather icon-minus"></i></span>' +
                '</div>' +
                '<input type="text" class="form-control cart-qty font_size14" style="text-align:center;background-color:#fff;" minlength="1" maxlength="7" size="3" min="0" max="10000" inputmode="decimal" name="addSalesLineItemQty" id="touchsale_item_return_qty' + id + '" value=' + item_quantity + ' onfocusout="PosnicPro.sales.quantity.returntextOnChange(\'' + id + '\');"  oninput="this.value = PosnicPro.minmax(this.value, 0, 100000)" onkeypress="PosnicPro.validate(event)" autocomplete="off">' +
                '<div class="input-group-append" id = ' + id + '  onclick="PosnicPro.sales.quantity.qtyreturnDecrease(this.id,1);">' +
                '<span class="btn btn-success-rgba button_qty_check"><i class="feather icon-plus"></i></span>' +
                '</div>' +
                '</div>';
            var removeLineItem = '<button type="button" class="btn-danger-rgba mb-1" onclick="PosnicPro.sales.quantity.removeReturnsalesLineRowItems(\'' + id + '\');" aria-label="Move to returns" data-t-aria-label="lang_move_to_returns"><i class="feather icon-arrow-right-circle"></i></button>';
        } else {
            var addLineItemQty = '<div class="input-group">' +
                '<div class="input-group-prepend">' +
                '<span class="btn btn-secondary-rgba button_qty_check" id = ' + id + '  onclick="PosnicPro.sales.quantity.qtyIncreaseDecrease(this.id,0,\'' + params.track_inventory + '\',\'' + params.negative_stock + '\');" style="width:45px;"><i class="feather icon-minus custom_minus" style="margin-left:-7px;"></i></span>' +
                '</div>' +
                '<input type="text" class="form-control cart-qty font_size14 rec_sale_inp_val" minlength="1" maxlength="7" size="4" min="0" max="100000" inputmode="decimal" name="addSalesLineItemQty" id="touchsale_item_qty' + id + '" value=' + item_quantity + ' oninput="this.value = PosnicPro.minmax(this.value, 0, 100000); PosnicPro.sales.quantity.textOnChange(\'' + id + '\',\'' + params.track_inventory + '\',\'' + params.negative_stock + '\');" onfocusout="PosnicPro.sales.quantity.normalizeInput(\'' + id + '\');" onkeypress="PosnicPro.validate(event)" style="text-align:center;background-color:#fff;width:140px;text-align: center; max-width:120px !important;">' +
                '<div class="input-group-append">' +
                '<span class="btn btn-success-rgba button_qty_check" id = ' + id + '  onclick="PosnicPro.sales.quantity.qtyIncreaseDecrease(this.id,1,\'' + params.track_inventory + '\',\'' + params.negative_stock + '\');" style="width:45px;"><i class="feather icon-plus custom_plus" style="margin-left:-7px;"></i></span>' +
                '</div>' +
                '</div>';
            // matches the edit pencil beside it: same size, same hover plate
            var removeLineItem = '<a href="javascript:void(0)" class="sale-line-act sale-line-del custom_remove" title="Remove this line" data-t-title="lang_remove_this_line" onclick="PosnicPro.sales.removeAddsalesLineRowItems(\'' + id + '\');"><i class="feather icon-trash-2"></i></a>';
        }
        var returnqty = 0;
        var mrpPrice = Number(params.selling_price) || 0;
        var lineMath = PosnicPro.sales.lineTotals(
            mrpPrice,
            item_quantity,
            addSalesLineDiscount,
            params.discount_amount <= 0 && params.discount_percentage > 0
        );
        var PriceDiscount = lineMath.discount;
        var line_total = lineMath.total;
        var discount = PriceDiscount;
        var returndiscount = Discount;

        var inlinePrice = '';
        var inlineDiscount = '';
        /* pencils removed - double-click quick edit replaced them */

        var inlineNote =
            '<span class="sales-inline-hide p-1">' +
            '<i class="feather icon-edit-1 text-primary item-note-icon" ' +
            'onclick="return PosnicPro.sales.openItemNoteModal(this);" ' +
            'data-id="' + id + '" data-toggle="tooltip" title="Item note" data-t-title="lang_item_note" ' +
            'style="cursor:pointer;"></i>' +
            '<a href="#" id="item_note_' + id + '" class="item-note-editable" style="display:none;"></a>' +
            '</span>';

        var colWidth = 'width="30%"';
        let item_unit = (typeof (params.unit) != "undefined" && params.unit !== null) ? params.unit : "qty";
        // whole-line editor door (owner ask): one pencil, every field
        var saleEditIcon = (PosnicPro.local.get('sale_quick_edit') === 'disable') ? '' :
            '<a href="javascript:void(0)" class="sale-line-act sale-line-edit" data-id="' + id + '" title="Edit price, quantity, discount" data-t-title="lang_edit_price_qty_discount"><i class="feather icon-edit-2"></i></a>';
        var amountWeightButton = PosnicPro.sales.isWeighedItem(params) ? '<button type="button" class="btn btn-sm btn-outline-primary sale-weight-amount" data-id="' + id + '" title="Weigh for a requested amount" data-t-title="lang_weigh_for_a_requested_amount"><i class="feather icon-target" aria-hidden="true"></i> By amount</button>' : '';
        var rowHTMLLine = '<tr id="touch_row_' + id + '" class="touch-sales-hover-effect border-top pt-3"' + (saleEditIcon ? ' data-sale-edit="' + id + '" tabindex="0"' : '') + '> ' +
            '    <td id="addSalesLineItemName_' + id + '" class="font_size14" data-id="' + PosnicPro.escapeHtml(item_name) + '" ' + colWidth + '>' + PosnicPro.escapeHtml(item_name) + inlineNote + '</td>' +
            '    <td id="addSalesLineItemQty_' + id + '" class="text-center add_circle font_size14">' + addLineItemQty + amountWeightButton + '</td>' +
            '    <td name ="addSalesLineItemUnit" id="addSalesLineItemUnit_' + id + '" class="text-center">' + item_unit + '</td>' +
            '    <td name ="addSalesLineItemPrice" id="addSalesLineItemPrice_' + id + '" class="font_size14" >' + mrpPrice.toFixed(2) + inlinePrice + '</td>' +
            '    <td name ="addSalesLineItemDiscount" id="addSalesLineItemDiscountprint_' + id + '" class="text-center font_size14" >' + discount_percentages + inlineDiscount + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td name ="addSalesLineTotal" id="addSalesLineTotal_' + id + '" class="font_size14" >' + line_total.toFixed(2) + '</td>' +
            '    <td id="addSalesRemoveLineItem_' + id + '" class="text-center font_size14">' + saleEditIcon + removeLineItem +
            '    </td>' +
            '    <td name="addSalesLineItemId" id="addSalesLineItemId_' + id + '" data-product-id="' + PosnicPro.escapeHtml(params.product_id || params.item_id || id) + '" data-line-id="' + PosnicPro.escapeHtml(params.line_id || '') + '" style="display:none;">' + id + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="addSalesLineItemSellingPrice_' + id + '" style="display:none;">' + params.selling_price + '</td>' +
            '    <td  name ="addSalesLineItemCompanyPrice"  id="addSalesLineItemCompanyPrice_' + id + '" style="display:none;">' + params.company_price + '</td>' +
            '    <td name ="addSalesLineItemBarcodeId" id="addSalesLineItemBarcodeId_' + id + '" style="display:none;">' + params.itemid + '</td>' +
            '    <td name ="addSalesLineItemSupplier" id="addSalesLineItemSupplier_' + id + '" style="display:none;">' + params.supplier + '</td>' +
            '    <td name ="addSalesLineDiscountAmount" id="addSalesLineDiscountAmount_' + id + '" style="display:none;">' + params.discount_amount + '</td>' +
            '    <td name ="addSalesLineDiscountPercentage" id="addSalesLineDiscountPercentage_' + id + '" style="display:none;">' + params.discount_percentage + '</td>' +
            '    <td id="addSalesLineavailableQty_' + id + '" style="display:none;">' + params.available_quantity + '</td>' +
            '    <td id="salesOrderType_' + id + '" style="display:none;">' + ordertype + '</td>' +
            '    <td id="salesType_' + id + '" style="display:none;">' + params.sales_type + '</td>' +
            '    <td id="instantStatus_' + id + '" style="display:none;">' + params.instant_status + '</td>' +
            '    <td id="returndecreSales_' + id + '" style="display:none;">' + returnqty + '</td>' +
            '    <td id="returnSalesIncreaseDecrease_' + id + '" style="display:none;">' + returnqty + '</td>' +
            '    <td id="returnavailable_' + id + '" style="display:none;">' + params.item_available_quantity + '</td>' +
            '    <td id="returnTotal_' + id + '" style="display:none;">0</td>' +
            '    <td id="returnLineTotal_' + id + '" style="display:none;">' + line_total + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td name="addSalesLinediscountval" id="addSalesLinediscountval_' + id + '" style="display:none;">' + addSalesLineDiscount + '</td>' +
            '    <td id="returnitemQuantity_' + id + '" style="display:none;">' + item_quantity + '</td>' +
            '    <td id="saleCategoryId_' + id + '" style="display:none;">' + params.category_id + '</td>' +
            '    <td id="saleCategoryName_' + id + '" style="display:none;">' + params.category_name + '</td>' +
            '    <td id="saleSupplierId_' + id + '" style="display:none;">' + params.supplier_id + '</td>' +
            '    <td id="saleSupplierName_' + id + '" style="display:none;">' + params.supplier_name + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td style="display:none;"></td>' +
            '    <td name ="addSalesLineItemDiscount" id="addSalesLineItemDiscount_' + id + '" style="display:none;">' + addSalesLineDiscount + '<span id="discountSign' + id + '">' + discountSign + '</span></td>' +
            '    <td id="returnItemChangeQuantityValue_' + id + '" style="display:none;">' + PosnicPro.sales.quantity.formatQty(item_quantity) + '</td>' +
            '    <td id="addSalesLineItemSubTotal_' + id + '" style="display:none;">' + mrpPrice + '</td>' +
            '    <td id="addSalesDiscount_' + id + '" style="display:none;">' + Math.abs(discount) + '</td>' +
            '    <td id="returnSalesDiscount_' + id + '" style="display:none;">' + Math.abs(returndiscount) + '</td>' +
            '    <td id="trackInventory_' + id + '" style="display:none;">' + params.track_inventory + '</td>' +
            '    <td id="negativeStock_' + id + '" style="display:none;">' + params.negative_stock + '</td>' +
            '    <td id="saleInlineItemPrice_' + id + '" style="display:none;">' + (params.sale_inline_item_price == null ? params.selling_price : params.sale_inline_item_price) + '</td>' +
            '    <td id="saleInlineDiscount_' + id + '" style="display:none;">' + params.sale_inline_discount_value + '</td>' +
            '    <td id="saleInlineDiscountPer_' + id + '" style="display:none;">' + params.sale_inline_discount_pervalue + '</td>' +
            '    <td id="addSalesLineItemNote_' + id + '" style="display:none;"></td>' +
            '</tr>';
        PosnicPro.sales.SaleTableLineItems[id] = {
            item_id: id,
            product_id: params.product_id || params.item_id || id,
            item_quantity: item_quantity,
            unit_conversion: params.unit_conversion,
            addSalesLineDiscount: addSalesLineDiscount,
            addSalesLineItemCompanyPrice_: params.company_price,
            addSalesLineItemPrice: params.selling_price,
            addSalesLineItemUnit: params.unit,
            Discount: Discount,
            available_quantity: params.available_quantity,
            addSalesLineItemDiscountAmount: params.discount_amount,
            addSalesLineItemDiscountPercentage: params.discount_percentage,
            addSalesLineItemAmount: mrpPrice,
            item_description: item_description,
            // Carried so the quantity buttons know this line is a weight
            // rather than a count. Without it they step by one, which for
            // something priced by the kilo is a whole kilo per press.
            item_weight_machine_based: params.item_weight_machine_based
        };

        /*Prepend & Replace With Table Row */
        /*If same product id add In To table replace With Matched Table Row*/
        var itemRecord = [];
        if ($('table#sales_new_items_table').find('#touch_row_' + id).length > 0) {
            $('#touch_row_' + id).replaceWith(rowHTMLLine);
            $('#touch_row_' + id).remove();
            // The API totals saved lines in their stored order. Reversing them
            // during payment reload changes half-paisa floating-point rounding
            // (Azure Table 6: 5667.37 becomes 5667.38).
            if (PosnicPro.sales.paymentOnlyMode === true) {
                $('#sales_new_items_table tbody').append(rowHTMLLine);
            } else {
                $('#sales_new_items_table tbody').prepend(rowHTMLLine);
            }
            itemRecord.push({ name: item_name, qty: item_quantity, price: mrpPrice, discount: $('#addSalesLineItemDiscountprint_' + id).text(), total: line_total.toFixed(2) });
            db.customerDisplay.put({ id: id, 'clear': 'yes', 'get': 'yes', items: itemRecord });
        } else {
            // The API totals saved lines in their stored order. Reversing them
            // during payment reload changes half-paisa floating-point rounding
            // (Azure Table 6: 5667.37 becomes 5667.38).
            if (PosnicPro.sales.paymentOnlyMode === true) {
                $('#sales_new_items_table tbody').append(rowHTMLLine);
            } else {
                $('#sales_new_items_table tbody').prepend(rowHTMLLine);
            }
            itemRecord.push({ name: item_name, qty: item_quantity, price: mrpPrice, discount: $('#addSalesLineItemDiscountprint_' + id).text(), total: line_total.toFixed(2) });
            db.customerDisplay.add({ id: id, 'clear': 'yes', 'get': 'yes', items: itemRecord });
        }
        var row = "touch_row_" + id;
        $("#" + row + '').addClass('table-highlight-row');
        setTimeout(function () {
            $("#" + row + '').removeClass('table-highlight-row');
        }, 500);

        $('#addSalesLineItemName_' + id).data('itemText', params).data('originalName', params.item_name || params.name || '');
        $('#sales_new_item_name').val('');
        /*Line Total Calculation using Below Function Call*/
        if (PosnicPro.sales.SaleAction !== 'return') {
            PosnicPro.sales.calculation.salesTableRowCart();
        }
        if (PosnicPro.sales.SaleAction === 'add') {
            PosnicPro.sales.customerViewDisplay();
        }

        // Auto-trigger weight reading for weight-based items
        if (!params._quantityConfirmed) PosnicPro.sales.checkAutoWeightTrigger(params);
    },
    customerViewDisplay: function () {
    },
    openItemNoteModal: function (index) {
        var id = $(index).data('id');
        var $nameCell = $('#addSalesLineItemName_' + id);
        if ($nameCell.length === 0) {
            return;
        }

        var $noteCell = $('#addSalesLineItemNote_' + id);
        var existingNote = $noteCell.length ? $noteCell.text() : '';
        var defaultDescription = '';
        var itemData = PosnicPro.sales.SaleTableLineItems[id];
        if (itemData && typeof (itemData.item_description) !== 'undefined' && itemData.item_description !== null) {
            defaultDescription = itemData.item_description;
        }

        var textValue = existingNote !== '' ? existingNote : defaultDescription;
        var $editable = $('#item_note_' + id);
        if ($editable.length === 0) {
            return;
        }

        PosnicPro.sales.currentItemNoteId = id;

        // Initialise X-editable textarea once per row
        if (!$editable.data('item-note-editable')) {
            $editable.editable({
                type: 'textarea',
                tpl: '<textarea maxlength="500"></textarea>',
                pk: 1,
                placement: 'left',
                placeholder: PosnicPro.i18n.t('lang_item_description_here', 'Item description here...'),
                title: PosnicPro.i18n.t('lang_enter_comments', 'Enter comments'),
                inputclass: 'form-control form-control-sm textarea-height',
                emptytext: '',
                onblur: 'ignore',
                validate: function (value) {
                    if (value.length > 500) {
                        return 'Allowed 500 characters only';
                    }
                },
                success: function (k, val) {
                    var noteText = val || '';

                    // Persist note text into hidden cell and cache object
                    $('#addSalesLineItemNote_' + id).text(noteText);
                    if (PosnicPro.sales.SaleTableLineItems[id]) {
                        PosnicPro.sales.SaleTableLineItems[id].item_description = noteText;
                    }

                    // Hide the inline editable anchor and clear its visible text,
                    // so description does NOT show next to the item name
                    $('#item_note_' + id).text('').hide();

                    // Change the pencil icon color similar to payment note behavior
                    var $icon = $('#addSalesLineItemName_' + id + ' .item-note-icon');
                    if (noteText.length > 0) {
                        $icon.css({ color: '#5fd799' });
                    } else {
                        $icon.css({ color: '#506fe4' });
                    }

                    if (PosnicPro.sales.currentItemNoteId === id) {
                        PosnicPro.sales.currentItemNoteId = null;
                    }
                }
            });
            $editable.data('item-note-editable', true);
        }

        // Set the current value for this open and toggle the popup
        $editable.editable('setValue', textValue, true);
        $editable.text('');
        $editable.show();
        $editable.editable('toggle');

        // Opening a note editor must never fetch catalogue copy or mutate the
        // order. Only the explicit save callback above writes an instruction.

    },

    /*add new trash remove if unwanted addline items in touch sale order*/
    removeAddsalesLineRowItems: function (id) {
        /*
         * No confirmation (owner: "its not destructive. he can add back").
         * Taking a line off an unsaved cart is undone by scanning the item
         * again, and a modal between the cashier and that is pure friction
         * at the counter. Voiding a SAVED sale is the destructive one, and
         * that keeps its manager gate.
         */
        PosnicPro.sales.deleteConfirmation = true;
        if (PosnicPro.sales.deleteConfirmation) {
            if ($('#instantStatus_' + id).text() === 'ok') {
                var params = {
                    url: 'items/deleteInstant',
                    data: JSON.stringify({
                        id: id
                    })
                };
                PosnicPro.delete(params, function () {

                });
            }
            $('#touch_row_' + id).remove();
            db.customerDisplay.where('id').equals(id).delete();
            delete PosnicPro.sales.SaleTableLineItems[id];
            PosnicPro.sales.calculation.salesTableRowCart();
            PosnicPro.sales.customerViewDisplay();
            var lineItemLength = PosnicPro.sales.addLineTable.length;
            if (lineItemLength === 0) {
                $("#save_submit,#check_button").attr("disabled", true);
                PosnicPro.sales.setDefaults();
            }
            PosnicPro.sales.deleteConfirmation = false;
        } else {
            PosnicPro.sales.callbackRegistry = {
                name: 'removeAddsalesLineRowItems',
                arguments: id
            };
            $('#delete_lineitem_modal').modal('show');
            $('#sale_line_item_remove').show();
            $('#receiving_line_item_remove').hide();
        }
    },
    /*delete confirmation*/
    deleteConfirmed: function () {
        $('#delete_lineitem_modal').modal('hide');
        $('#sale_line_item_remove').hide();
        PosnicPro.sales.deleteConfirmation = true;
        window['PosnicPro']['sales']['' + PosnicPro.sales.callbackRegistry.name](PosnicPro.sales.callbackRegistry.arguments);
    },
    customerBalanceCheck: function () {
        if (PosnicPro.sales.addLineTable.length > 0) {
            var total = '';
            if (PosnicPro.sales.SaleAction === 'return') {
                total = $('#refund_grand_total').text().replace(/,/g, '');

            } else {
                total = $('#sales_new_grand_total').text().replace(/,/g, '');
            }
            var amount = $('#sales_new_given_amount').val();
            var balance = PosnicPro.sales.sub(amount, total);
            balance = (balance).toFixed(2);
            $('#sales_new_balance_amount').html(balance);
        } else {
            $('#sales_new_given_amount').val('0.00');
            $('#refund_grand_total,#sales_new_grand_total').text('0.00');
            return false;
        }
        PosnicPro.sales.customerViewDisplay();
    },
    /*
     * The payment screen records one thing: how much the customer paid.
     * There is no tender type, no split payment and no wallet. The difference
     * between that amount and the bill is the customer's debt.
     */
    openTenderModel: function (methodsReady, focusTender) {
        if (!PosnicPro.sales.paymentOnlyMode && PosnicPro.saleExtensions?.dispatch('checkout')) return;

        PosnicPro.sales.submissionInProgress = false;
        $("#save_btn").prop('disabled', false);
        $("#save_submit").removeClass('disabled');

        // Taking payment must not silently reprice a bill already issued.
        const savedPayable = Number(PosnicPro.sales.EditRecentSaleParams.sales_total);
        const currentPayable = Number(PosnicPro.sales.extraDiscount.sale_new_tot);
        if (PosnicPro.sales.paymentOnlyMode === true &&
            (!Number.isFinite(savedPayable) || !Number.isFinite(currentPayable) ||
             Math.round(savedPayable * 100) !== Math.round(currentPayable * 100))) {
            $('#save_btn').prop('disabled', true);
            PosnicPro.alert('error', 'The payment total differs from the saved bill. Reload the bill and review its discounts and charges before taking payment.');
            return;
        }

        const saleNewTot = Number(PosnicPro.sales.extraDiscount.sale_new_tot) || 0;
        if (PosnicPro.sales.ensureCustomer) { PosnicPro.sales.ensureCustomer(); }
        PosnicPro.sales.refreshCustomerAccount();
        var customer_name = $("#sales_new_customer_name").val();

        if (!PosnicPro.sales.paymentOnlyMode && (!$('#sales_new_items_table tbody tr[id^="touch_row_"]').length || customer_name === '')) {
            if (customer_name === '') {
                $('.toggle-customer-user').css({ display: 'block' });
                PosnicPro.sales.setCustomerPopup(true);
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_customer_name', 'Enter a customer name.'));
                return false;
            }
            $('#collapseOne').removeClass("show");
            $('#collapseTwo').addClass("show");
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_add_at_least_one_item', 'Add at least one item.'));
            $('#sales_new_item_name').focus();
            return false;
        }

        if (!PosnicPro.sales.paymentOnlyMode && saleNewTot < 0) {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_payment_amount_greater_than_zero', 'Enter a payment amount greater than zero.'));
            return false;
        }

        if (PosnicPro.sales.paymentOnlyMode === true) {
            $('.changeSalesBtnText').text(PosnicPro.i18n.t('lang_pay_2', 'Pay'));
        }
        $(".infobar-settings-sidebar-overlay").css({ "background": "rgba(0,0,0,0.4)", "position": "fixed" });
        $("#infobar-settings-sidebar-tender-details").addClass("sidebarview");
        $('#tenderpage').show();
        if (PosnicPro.sales.SaleAction === 'return') {
            $('.cancel-save-hide-show').hide();
        } else {
            $('.cancel-save-hide-show').show();
        }
        $('#newsalespage').hide();
        PosnicPro.sales.saleDoneTimer.stop();
        $('#tendered_subtotal').text($('#sales_new_subtotal').text());
        $('#tendered_discount').text($('#discount_sale_amount').text());
        $('.tendered_total,#tendered_payment').text(saleNewTot.toFixed(2));

        // This field is the total paid on the bill, not the fresh tender. A
        // bill opened for settlement must start at its full payable amount:
        // opening on what was already paid turned Pay into a no-op that wrote
        // the same partial figure back. The cashier can still lower it.
        var openingAmount = saleNewTot;
        $('.showhidewalletamount,.showhidewallet').hide();
        $('.showhidDue').show();
        $('.partial_amount').prop('disabled', false).val(openingAmount.toFixed(2));

        var refreshDue = function () {
            var paid = parseFloat($('#Partial_amount').val());
            paid = isFinite(paid) && paid > 0 ? paid : 0;
            var due = Math.max(0, saleNewTot - paid);
            $('.balanceDue').text(due.toFixed(2));
            $('#sales_new_customer_partial_balance').val(due > 0.005 ? 'true' : 'false');
        };
        $('#Partial_amount').off('input.tenderDue').on('input.tenderDue', refreshDue);
        refreshDue();

        $('#save_btn').prop('disabled', false);
        $('#infobar-settings-sidebar-tender-details').show();
        PosnicPro.sales.renderTenderReceiptPreview();
        if (focusTender) $('#Partial_amount').focus();
    },
    editItemPricingSale: function (index) {
        /*
         * On-demand price power (owner ask - fish priced daily): editing a
         * cart price is the price_override permission. A cashier without it
         * gets the manager PIN prompt, same rail as refunds.
         */
        if (PosnicPro.posCan && !PosnicPro.posCan('price_override')) {
            PosnicPro.requireManagerApproval('price_override',
                { prompt: "Changing a price needs a manager's approval." },
                function () { PosnicPro.sales._editItemPricingSaleNow(index); });
            return;
        }
        PosnicPro.sales._editItemPricingSaleNow(index);
    },
    _editItemPricingSaleNow: function (index) {
        var id = $(index).data('id');
        let priceText = $('#addSalesLineItemPrice_' + id).text().trim();

        // Clean only front zeros (0005.5 -> 5.5)
        let priceValue = priceText.replace(/^0+(?=\d)/, '');
        if (priceValue === '0' || priceValue === '0.00') priceValue = '';

        $('#addSalesLineItemPrice_' + id).editable({
            type: 'text',
            pk: 1,
            title: PosnicPro.i18n.t('lang_edit_price_value', 'Edit price value'),
            inputclass: 'form-control form-control-sm',
            tpl:
                '<input size="4" min="0" max="100000" ' +
                'oninput="this.value=this.value.replace(/^0+(?=\\d)/, \'\')" ' + // âœ… allow removing front 0 manually
                'onkeypress="return PosnicPro.validate(event)">',
            value: priceValue,
            validate: function (value) {
                value = $.trim(value);
                if (value === '') {
                    return 'Enter a valid amount!';
                }
                let regex = /^\d+(\.\d+)?$/;
                if (!regex.test(value)) {
                    return 'Enter a valid amount!';
                }
            },
            success: function (k, val) {
                let newValue = parseFloat(val) || 0;

                // Update all related price fields
                $('#saleInlineItemPrice_' + id).text(newValue.toFixed(2));
                $('#addSalesLineItemPrice_' + id).text(newValue.toFixed(2));
                $('#addSalesLineItemSellingPrice_' + id).text(newValue.toFixed(2));

                let mrpPrice = newValue;

                $('#addSalesLineItemSubTotal_' + id).text(mrpPrice.toFixed(2));

                if (PosnicPro.local.get('inline_sale') === 'enable') {
                    $('#addSalesLineItemPrice_' + id).replaceWith(
                        '<td name="addSalesLineItemPrice" id="addSalesLineItemPrice_' + id + '" class="font_size14">' +
                        mrpPrice.toFixed(2) +
                        '&nbsp;&nbsp;<span class="sales-inline-hide">' +
                        '<i class="feather icon-edit-1 text-primary" ' +
                        'onclick="return PosnicPro.sales.editItemPricingSale(this);" ' +
                        'data-id="' + id + '" data-toggle="tooltip" title="Price change" data-t-title="lang_price_change" style="cursor:pointer;"></i>' +
                        '</span></td>'
                    );
                }

                PosnicPro.sales.commonInlineCalculation(id);
            }
        });
    },
    editItemDiscountSale: function (index, discountValue, discountType) {
        var id = $(index).data('id');
        let oldDiscountValue = discountValue || parseFloat(
            $('#addSalesLineItemDiscountprint_' + id)
                .text()
                .replaceAll('%', '')
                .replace(PosnicPro.local.get('currencySign'), '')
                .trim()
        ) || 0;

        let isPercentage = discountType === 'percentage';

        // âœ… Clean only front zeros (e.g., 0005 â†’ 5)
        let cleanDiscountValue = String(oldDiscountValue).replace(/^0+(?=\d)/, '');
        if (cleanDiscountValue === '0' || cleanDiscountValue === '0.00') cleanDiscountValue = '';

        $('#addSalesLineItemDiscountprint_' + id).editable({
            type: 'text',
            pk: 1,
            title: PosnicPro.i18n.t('lang_edit_discount_value', 'Edit discount value'),
            inputclass: 'form-control form-control-sm',
            tpl:
                '<input size="4" min="0" max="100000" ' +
                // âœ… allow manual removal of front 0
                'oninput="this.value=this.value.replace(/^0+(?=\\d)/, \'\')" ' +
                'onkeypress="return PosnicPro.validate(event)">',
            value: cleanDiscountValue,
            validate: function (value) {
                value = $.trim(value);
                if (value === '') {
                    return 'Enter a valid discount value!';
                }

                if (isPercentage) {
                    let regex = /^\d+$/; // whole numbers only
                    if (!regex.test(value)) {
                        return 'Enter a valid whole number!';
                    }
                    let intValue = parseInt(value, 10);
                    if (intValue < 1 || intValue > 100) {
                        return 'Percentage must be between 1 and 100!';
                    }
                } else {
                    let regex = /^\s*?((\d+(\.\d+)?)|(\.\d+))\s*$/;
                    if (!regex.test(value)) {
                        return 'Enter a valid discount amount!';
                    }
                }
            },
            success: function (key, val) {
                let newDiscountValue = parseFloat(val) || 0;
                let currencySign = PosnicPro.local.get('currencySign');
                let newEditDiscountValue = (isPercentage
                    ? newDiscountValue + '%'
                    : currencySign + newDiscountValue.toFixed(2));

                // Inline edit enabled
                if (PosnicPro.local.get('inline_sale') === 'enable') {
                    $('#addSalesLineItemDiscountprint_' + id).replaceWith(
                        '<td name="addSalesLineItemDiscountprint" id="addSalesLineItemDiscountprint_' + id + '" class="font_size14">' +
                        newEditDiscountValue +
                        '&nbsp;&nbsp;<span class="sales-inline-hide">' +
                        '<i class="feather icon-edit-1 text-primary" ' +
                        'onclick="return PosnicPro.sales.editItemDiscountSale(this, ' + newDiscountValue + ', \'' + (isPercentage ? 'percentage' : 'amount') + '\');" ' +
                        'data-id="' + id + '" data-toggle="tooltip" title="Discount change" data-t-title="lang_discount_change" style="cursor:pointer;"></i>' +
                        '</span></td>'
                    );

                    $('#addSalesLineItemDiscount_' + id).replaceWith(
                        '<td name="addSalesLineItemDiscount" id="addSalesLineItemDiscount_' + id + '" style="display:none;">' +
                        (isPercentage ? newDiscountValue : newDiscountValue.toFixed(2)) +
                        '<span id="discountSign' + id + '">' +
                        (isPercentage ? '%' : currencySign) +
                        '</span></td>'
                    );

                    // Update inline display
                    if (isPercentage) {
                        $('#saleInlineDiscountPer_' + id).text(newDiscountValue.toFixed(2));
                    } else {
                        $('#saleInlineDiscount_' + id).text(newDiscountValue);
                    }
                }

                // Recalculate totals
                PosnicPro.sales.commonInlineCalculation(id);
            }
        });
    },
    commonInlineCalculation: function (id) {
        var ItemQty = $('#touchsale_item_qty' + id).val();
        var lineMath = PosnicPro.sales.readLineTotals(id);
        var updateSalesLineTotal = lineMath.total.toFixed(2);
        $('#addSalesLineTotal_' + id).text(updateSalesLineTotal);
        $('#addSalesDiscount_' + id).text(lineMath.discount.toFixed(2));
        var itemRecord = [];
        itemRecord.push({ name: $('#addSalesLineItemName_' + id).text(), qty: ItemQty, price: $('#addSalesLineItemPrice_' + id).text(), discount: $('#addSalesLineItemDiscount_' + id).text(), total: updateSalesLineTotal });
        db.customerDisplay.put({ id: id, clear: 'yes', get: 'yes', items: itemRecord });
        PosnicPro.sales.calculation.salesTableRowCart();
        PosnicPro.sales.customerBalanceCheck();
        PosnicPro.sales.customerViewDisplay();
    },

    savedSellingPrice: function (line) {
        // App orders store item_price as net; the saved pricing snapshot keeps
        // the selling basis that the cart's line arithmetic expects.
        if (line.pricing && line.pricing.version === 1) return line.pricing.selling_price;
        if (line.sale_inline_item_price != null && Number.isFinite(Number(line.sale_inline_item_price)) && String(line.sale_inline_item_price).trim() !== '') return Number(line.sale_inline_item_price);
        return line.selling_price != null ? line.selling_price : line.item_price;
    },
    /* The API stores the cost of the whole line. The cart edits one unit, so
       divide the total back by the line quantity. Older rows without the unit
       snapshot are handled the same way: their stored value is a line total. */
    savedCompanyUnitPrice: function (line) {
        var explicit = Number(line && line.unit_company_price);
        if (line && line.unit_company_price !== undefined && line.unit_company_price !== null &&
            line.unit_company_price !== '' && Number.isFinite(explicit)) {
            return explicit;
        }
        var total = Number(line && line.company_price_total);
        if (!Number.isFinite(total)) return 0;
        var quantity = Number(line && line.item_quantity);
        return Number.isFinite(quantity) && quantity > 0 ? total / quantity : total;
    },
    /* Cost of a cart row: the hidden cost cell holds one unit. */
    lineCompanyCostTotal: function (line) {
        var quantity = Number(line && line.item_quantity);
        var unit = Number(line && line.company_price_total);
        if (!Number.isFinite(quantity) || quantity < 0) quantity = 0;
        if (!Number.isFinite(unit)) unit = 0;
        return Math.round(quantity * unit * 100) / 100;
    },
};

PosnicPro.sales._num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
PosnicPro.sales._manualDiscountOn = function (data) {
    var num = PosnicPro.sales._num;
    var items = data.items || [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (num(it.sale_inline_discount_value) > 0 || num(it.item_discount) > 0 ||
            num(it.discount_amount) > 0 || num(it.sale_inline_discount_pervalue) > 0 ||
            num(it.item_discount_percentage) > 0 || num(it.discount_percentage) > 0) {
            return true;
        }
    }
    return num(data.extra_discount) > 0;
};
// Best-effort percent estimate for the role's discount cap: the larger of
// (total discount amount / subtotal) and any raw percent entered.
PosnicPro.sales._manualDiscountPct = function (data) {
    var num = PosnicPro.sales._num;
    var subtotal = num(data.sales_sub_total) || num(data.sales_total);
    var amount = 0, maxPct = 0;
    (data.items || []).forEach(function (raw) {
        var it = raw || {};
        amount += num(it.sale_inline_discount_value) || num(it.item_discount) || num(it.discount_amount);
        var p = num(it.sale_inline_discount_pervalue) || num(it.item_discount_percentage) || num(it.discount_percentage);
        if (p > maxPct) maxPct = p;
    });
    var extra = num(data.extra_discount);
    if (extra > 0) {
        if (data.extra_discount_type === 'percent') { if (extra > maxPct) maxPct = extra; }
        else { amount += extra; }
    }
    if (subtotal > 0) {
        var pctOfBill = (amount / subtotal) * 100;
        if (pctOfBill > maxPct) maxPct = pctOfBill;
    }
    return maxPct;
};
// Wraps a sale submit. proceed() runs immediately when there is no manual
// discount, or this user may apply it within their cap; otherwise the
// manager PIN/card modal runs first and the token is attached to the
// payload for the server-side check.
PosnicPro.sales.guardDiscountApproval = function (params, proceed, checkedPending) {
    if (!checkedPending && PosnicPro.businessApproval && PosnicPro.businessApproval.hasPending()) {
        PosnicPro.businessApproval.offer(params, proceed, function () {
            PosnicPro.sales.guardDiscountApproval(params, proceed, true);
        }, true);
        return;
    }
    var data;
    try { data = JSON.parse(params.data); } catch (e) { proceed(); return; }
    if (data && PosnicPro.sales.lineEdit._priceApprovalToken) {
        data.price_override_approval_token = PosnicPro.sales.lineEdit._priceApprovalToken;
        params.data = JSON.stringify(data);
    }
    if (!data || !PosnicPro.sales._manualDiscountOn(data)) { proceed(); return; }
    if (PosnicPro.posCan('discount_apply')) {
        var pos = PosnicPro.userACL && PosnicPro.userACL.pos;
        var cap = pos ? PosnicPro.sales._num(pos.discount_max_percent) : 0;
        if (cap <= 0 || PosnicPro.sales._manualDiscountPct(data) <= cap) {
            proceed();
            return;
        }
    }
    var localApproval = function () { PosnicPro.requireManagerApproval('discount_apply',
        { prompt: "This discount needs a manager's approval.", force: true },
        function (approval) {
            if (approval && approval.approval_token) {
                data.approval_token = approval.approval_token;
                params.data = JSON.stringify(data);
            }
            proceed();
        }, function () {
            PosnicPro.sales.submissionInProgress = false;
            $('#save_btn').prop('disabled', false);
            $('#save_submit').removeClass('disabled');
        }); };
    if (PosnicPro.businessApproval) PosnicPro.businessApproval.offer(params, proceed, localApproval);
    else localApproval();
};

/*********** START - ADD NEW SALES ***********/
/***********  THIS FUNCTION HANDLE THE ADD NEW SALES ORDER ***********/
PosnicPro.sales.addSale = {
    /*Save Sales Order*/
    cartOrderSubmit: function (payment) {
        // // ✅ Prevent duplicate submissions
        // if (PosnicPro.sales.submissionInProgress || $("#save_btn").prop('disabled') || $("#save_submit").hasClass('disabled')) {
        //     console.log('⚠️ Submission already in progress');
        //     return false;
        // }

        // ✅ Mark submission as in progress
        PosnicPro.sales.submissionInProgress = true;
        $("#save_btn").prop('disabled', true);
        $("#save_submit").addClass('disabled');

        // Skip partial-amount validation entirely in payment-only mode
        if (!PosnicPro.sales.paymentOnlyMode && PosnicPro.sales.SaleAction !== 'return' && $('#Partial_amount').val() === '') {
            if ($('#Partial_amount').val() === '') {
                $("#Partial_amount").focus();
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_partial_amount', 'Enter a partial amount.'));
                return false;
            }
        }
        // In payment-only mode or non-add flows, always delegate to editSale
        if (PosnicPro.sales.paymentOnlyMode || PosnicPro.sales.SaleAction !== 'add') {
            /*This Function Call For Edit and Return ,Exchange sales Action*/
            PosnicPro.sales.editSale.cartOrderSubmit(payment);
            return false;
        }


        // walk-in sales must not be refused: fill from the cached default
        // customer when nothing was chosen (see ensureCustomer)
        if (PosnicPro.sales.ensureCustomer) { PosnicPro.sales.ensureCustomer(); }
        var customer_name = $("#sales_new_customer_name").val();
        // Skip customer / item validation in payment-only mode (items already from DB)
        if (!PosnicPro.sales.paymentOnlyMode && (!$('#sales_new_items_table tbody tr[id^="touch_row_"]').length || customer_name === '')) {

            if (customer_name === '') {
                $('.toggle-customer-user').css({ display: 'block' });
                PosnicPro.sales.setCustomerPopup(true);
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_customer_name', 'Enter a customer name.'));
                return false;
            }
            $('#collapseOne').removeClass("show");
            $('#collapseTwo').addClass("show");
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_add_at_least_one_item', 'Add at least one item.'));
            $('#sales_new_item_name').focus();
            return false;
        } else {
            var loader = $(".loader-sales-balance");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.sales.addSalesLineTable = $('#sales_new_items_table tbody tr').map(function () {
                let itemid = $(this).find(':nth-child(9)').text();
                var status = ($('#salesType_' + itemid).text() === 'instant') ? 'instant' : 'Add';

                // Use the saved order note; never borrow catalogue copy.
                var noteText = $('#addSalesLineItemNote_' + itemid).text() || '';
                var descriptionFromCache = '';
                var cachedItem = PosnicPro.sales.SaleTableLineItems[itemid];
                if (cachedItem && typeof (cachedItem.item_description) !== 'undefined' && cachedItem.item_description !== null) {
                    descriptionFromCache = cachedItem.item_description;
                }
                var finalItemDescription = $.trim(noteText) !== '' ? noteText : descriptionFromCache;

                return {
                    item_status: status,
                    sale_inline_item_price: $('#saleInlineItemPrice_' + itemid).text(),
                    sale_inline_discount_value: $('#saleInlineDiscount_' + itemid).text(),
                    sale_inline_discount_pervalue: $('#saleInlineDiscountPer_' + itemid).text(),
                    item_name: $('#addSalesLineItemName_' + itemid).data('originalName') || $('#addSalesLineItemName_' + itemid).text(),
                    ...(window.PosnicItemText ? window.PosnicItemText.snapshot($('#addSalesLineItemName_' + itemid).data('itemText')) : {}),
                    item_price: $('#addSalesLineItemPrice_' + itemid).text(),
                    item_unit: $('#addSalesLineItemUnit_' + itemid).text(),
                    item_discount: $('#addSalesLineDiscountAmount_' + itemid).text(),
                    item_discount_percentage: $('#addSalesLineDiscountPercentage_' + itemid).text(),
                    item_quantity: $('#touchsale_item_qty' + itemid).val(),
                    item_available_quantity: $('#addSalesLineavailableQty_' + itemid).text(),
                    item_id: $('#addSalesLineItemId_' + itemid).attr('data-product-id') || $('#addSalesLineItemId_' + itemid).text(),
                    line_id: $('#addSalesLineItemId_' + itemid).attr('data-line-id') || undefined,
                    total_amount: $('#addSalesLineTotal_' + itemid).text(),
                    barcode_id: $('#addSalesLineItemBarcodeId_' + itemid).text(),
                    company_price_total: $('#addSalesLineItemCompanyPrice_' + itemid).text(),
                    category_id: $('#saleCategoryId_' + itemid).text(),
                    category_name: $('#saleCategoryName_' + itemid).text(),
                    supplier_id: $('#saleSupplierId_' + itemid).text(),
                    supplier_name: $('#saleSupplierName_' + itemid).text(),
                    track_inventory: $('#trackInventory_' + itemid).text(),
                    negative_stock: $('#negativeStock_' + itemid).text(),
                    item_price_total: $('#addSalesLineItemSellingPrice_' + itemid).text(),
                    item_description: finalItemDescription
                };
            }).get();

            var TotalCompanyPrice = 0;
            for (var i = 0; i < PosnicPro.sales.addSalesLineTable.length; i++) {
                TotalCompanyPrice += PosnicPro.sales.lineCompanyCostTotal(PosnicPro.sales.addSalesLineTable[i]);
            }
            let register_id = PosnicPro.sales.saleRegisterId();
            /* Payment methods and split tenders are gone. The amount entered is
               the whole record; the server derives Paid, Partly Paid or Unpaid
               from it and carries the remainder as customer debt. */
            let amountReceived = parseFloat($('#Partial_amount').val());
            amountReceived = isFinite(amountReceived) && amountReceived > 0 ? amountReceived : 0;
            let saleTotal = parseFloat($('#grand_total').val());
            saleTotal = isFinite(saleTotal) ? saleTotal : 0;
            let amountIsPartial = amountReceived < saleTotal - 0.005;

            var params = {
                url: 'sales',
                data: JSON.stringify({
                    idempotencyKey: PosnicPro.sales.idempotencyKey(),
                    items: PosnicPro.sales.addSalesLineTable,
                    sales_total: $("#grand_total").val(),
                    sales_sub_total: String($('#sales_new_subtotal').text() || '').replace(/,/g, ''),
                    customer_id: $('#sales_new_customer_id').val(),
                    customer_name: $('#sales_new_customer_name').val(),
                    create_customer_on_save: !$('#sales_new_customer_id').val() && !!$.trim($('#sales_new_customer_name').val()),
                    customer_address: $('#sales_new_customer_address').val(),
                    customer_phone: $('#sales_new_customer_phone').val(),
                    customer_email: $('#sales_new_customer_email').val(),
                    customer_state: $('#sales_new_customer_state').val(),
                    customer_country: $('#sales_new_customer_country').val(),
                    sales_total_company_price: TotalCompanyPrice,
                    date: $('#time-format').val(),
                    payment_descriptiondiscount: String($("#discount_sale_amount").text() || '').replace(/,/g, ''),
                    payment_description: $('#payment_description').val(),
                    sales_description: $('#sales_description').val(),
                    discount_description: $('#discount_description').val(),
                    sales_id: '',
                    register_id: register_id,
                    partial_balance: amountReceived.toFixed(2),
                    customer_current_balance: 0,
                    partial_check: amountIsPartial ? 'true' : 'false',
                    wallet_check: 'false',
                    extra_discount: parseFloat($('#extraDisc').text()),
                    extra_discount_type: !$('#percentIcon').hasClass('d-none') ? "percent" : "price",
                    charges: PosnicPro.sales.charges || []
                })
            };
            PosnicPro.sales.guardDiscountApproval(params, function () {
            var savedSubmission;
            try {
                savedSubmission = PosnicPro.sales.submissionJournal().save(JSON.parse(params.data));
                if (PosnicPro.orderRecovery) PosnicPro.orderRecovery.refresh();
                if (savedSubmission.state === 'confirmed') {
                    throw new Error(PosnicPro.i18n.t('lang_submission_already_saved', 'This order was already saved. Refresh the sales list.'));
                }
            } catch (error) {
                PosnicPro.sales.submissionInProgress = false;
                $("#save_btn").prop('disabled', false);
                $("#save_submit").removeClass('disabled');
                loader.find(".loadingSpinner").remove();
                PosnicPro.alert('error', error.message);
                return;
            }
            PosnicPro.post(params, function (response) {
                // ✅ Clear submission flag
    PosnicPro.sales.submissionInProgress = false;
                if (response.type === 'success') {
                    try {
                        PosnicPro.sales.submissionJournal().confirm(savedSubmission, response);
                        if (PosnicPro.orderRecovery) PosnicPro.orderRecovery.refresh();
                    } catch (error) {
                        console.warn('Order journal confirmation remains pending:', error.message);
                    }
                    PosnicPro.sales.resetIdempotencyKey();
                    if (PosnicPro.businessApproval) PosnicPro.businessApproval.saved();
                    // Stock just changed on the server; cached items are stale.
                    PosnicPro.sales.itemCache.clear();
                    $('#extraDisc').text(0);
                    $('#extraDisc').editable('setValue', 0);
                    $("#save_submit").addClass("disabled");
                    if (response.data.waring === 'warning') {
                        swal({
                            title: "Low Stock!",
                            text: "Your sales count for this month is very low!",
                            icon: "warning",
                            button: "Ok",
                        });
                    }
                                $('#ask_checkout_payment').remove();
                    if (PosnicPro.sales.parkedMenu.printEnabled(response.data.print)) {
                        PosnicPro.sales.printAfterSave(response.data.sales_id);
                    }
                    if (response.data.mail === true && $('#sales_new_customer_email').val() !== "") {
                        PosnicPro.sales.addSale.sendSalesReceipt(response.data.sales_id);
                    }
                    var path = '#/sales/' + response.data.sales_id;
                    $('.printSalesReceipt')
                        .attr('href', path + '/print')
                        .data('sale-id', response.data.sales_id);
                    $('#qr_view').modal('hide');
                    $('#Partial_amount').val('');
                    loader.find(".loadingSpinner:first").remove();

                        PosnicPro.sales.setDefaults();
                    PosnicPro.sales.customerViewDisplay();
                    PosnicPro.stocklogs.viewLowStockDashboard();
                    PosnicPro.sales.recentMenu.recentSalesTabDetails();
                    $('#customer_current_balance').val(response.data.customer_balance);
                    PosnicPro.alert(response.type, response.message);
                } else {
                    loader.find(".loadingSpinner").remove();
                    if (PosnicPro.businessApproval && PosnicPro.businessApproval.failed({ responseJSON: response })) return;
                    // ✅ Re-enable on error response
                    $("#save_btn").prop('disabled', false);
                    $("#save_submit").removeClass('disabled');
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                loader.find(".loadingSpinner").remove();
                if (PosnicPro.businessApproval && PosnicPro.businessApproval.failed(xhr)) return;
                // ✅ Clear submission flag and re-enable button on error
                PosnicPro.sales.submissionInProgress = false;
                $("#save_btn").prop('disabled', false);
                $("#save_submit").removeClass('disabled');
                var response = xhr && xhr.responseJSON;
                if (!response && xhr && xhr.responseText) {
                    try { response = JSON.parse(xhr.responseText); } catch (error) { response = null; }
                }
                try {
                    if (PosnicPro.sales.submissionJournal().reject(savedSubmission, response)) {
                        PosnicPro.sales.resetIdempotencyKey();
                        if (PosnicPro.orderRecovery) PosnicPro.orderRecovery.refresh();
                    }
                } catch (error) { console.warn('Order rejection remains pending:', error.message); }
                // A dropped connection has no stock correction payload. Keep
                // the cart and retry identity intact instead of throwing here.
                var corrections = response && Array.isArray(response.data) ? response.data : [];
                $.each(corrections, function (key, val) {
                    if (!val || !val.item_id || val.item_quantity == null ||
                        !Number.isFinite(Number(val.item_quantity)) || Number(val.item_quantity) < 0) return;
                    let row = "touch_row_" + val.item_id;
                    $("#" + row + '').removeAttr("style");
                    $("#" + row + '').addClass('table-highlight-row');
                    let rowInput = "touchsale_item_qty" + val.item_id;
                    $("#" + rowInput + '').val(val.item_quantity);
                    setTimeout(function () {
                        $("#" + row + '').removeClass('table-highlight-row');
                    }, 500);
                });
            });
            });
        }
    },

    sendSalesReceipt: function (sales_id) {

        var params = {
            url: 'sales/salesReceipt',
            data: JSON.stringify({
                email: $("#sales_new_customer_email").val(),
                name: $("#sales_new_customer_name").val(),
                id: sales_id
            })
        };
        PosnicPro.post(params, function (response) {
            if (response.type === 'error') {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    }
};
/*********** END - ADD NEW SALES ***********/
/*********** START - EDIT ,RETURN AND EXCHANGE ***********/
/*********** THIS FUNCTION HANDLE THE EDIT ,RETURN AND EXCHANGE SALES ORDER ***********/
PosnicPro.sales.editSale = {
    cartOrderSubmit: function (payment) {
        var salesAction = (PosnicPro.sales.refundSaleAction === true) ? 'return' : 'edit';
        var completingParkedSale = PosnicPro.sales.EditRecentSaleParams.sale_process === 'Hold';


        //salesAction = (PosnicPro.sales.salesExchange === true) ? 'exchange' : salesAction;
        // walk-in sales must not be refused: fill from the cached default
        // customer when nothing was chosen (see ensureCustomer)
        if (PosnicPro.sales.ensureCustomer) { PosnicPro.sales.ensureCustomer(); }
        var customer_name = $("#sales_new_customer_name").val();
        // Skip customer/item validation entirely in payment-only mode (items already loaded from DB)
        if (!PosnicPro.sales.paymentOnlyMode && (!$('#sales_new_items_table tbody tr[id^="touch_row_"]').length || customer_name === '')) {
            if (customer_name === '') {
                PosnicPro.sales.setCustomerPopup(true);
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_customer_name', 'Enter a customer name.'));
                return false;
            }
        }

        if (salesAction === 'return') {
            PosnicPro.sales.returnSalesLineTable = $('#sales_new_items_table tbody tr').map(function () {
                let itemid = $(this).find(':nth-child(9)').text();
                var available_qty = parseInt($('#returndecreSales_' + itemid).text()) + parseInt($('#returnavailable_' + itemid).text());
                var total_item_quantity = $('#touchsale_item_return_qty' + itemid).val();



                return {
                    item_status: $('#salesOrderType_' + itemid).text(),
                    item_name: $('#addSalesLineItemName_' + itemid).data('originalName') || $('#addSalesLineItemName_' + itemid).text(),
                    ...(window.PosnicItemText ? window.PosnicItemText.snapshot($('#addSalesLineItemName_' + itemid).data('itemText')) : {}),
                    item_unit: $('#addSalesLineItemUnit_' + itemid).text(),
                    item_price: $('#addSalesLineItemSellingPrice_' + itemid).text(),
                    item_discount: $('#addSalesLineDiscountAmount_' + itemid).text(),
                    item_discount_percentage: $('#addSalesLineDiscountPercentage_' + itemid).text(),
                    item_quantity: total_item_quantity,
                    item_available_quantity: available_qty,
                    item_id: $('#addSalesLineItemId_' + itemid).attr('data-product-id') || $('#addSalesLineItemId_' + itemid).text(),
                    line_id: $('#addSalesLineItemId_' + itemid).attr('data-line-id') || undefined,
                    total_amount: $('#addSalesLineTotal_' + itemid).text(),
                    barcode_id: $('#addSalesLineItemBarcodeId_' + itemid).text(),
                    company_price_total: $('#addSalesLineItemCompanyPrice_' + itemid).text(),
                    category_id: $('#saleCategoryId_' + itemid).text(),
                    category_name: $('#saleCategoryName_' + itemid).text(),
                    supplier_id: $('#saleSupplierId_' + itemid).text(),
                    supplier_name: $('#saleSupplierName_' + itemid).text(),
                    item_value: $('#touchsale_item_return_qty' + itemid).val(),
                    payment_description: $('#payment_description').val(),
                    sales_description: $('#sales_description').val(),
                    discount_description: $('#discount_description').val()
                };
            }).get();
            PosnicPro.sales.returnitemSalesLineTable = $('#sales_return_items_table tbody tr').map(function () {
                let itemid = $(this).find(':nth-child(11)').text();
                return {
                    item_status: $('#returnsalesOrderType_' + itemid).text(),
                    item_name: $('#returnSalesLineItemName_' + itemid).text(),
                    item_unit: $('#returnSalesLineItemUnit_' + itemid).text(),
                    item_price: $('#addSalesLineItemSellingPrice_' + itemid).text(),
                    item_discount: $('#returnSalesLineDiscountAmount_' + itemid).text(),
                    item_discount_percentage: $('#returnSalesLineItemDiscount_' + itemid).text(),
                    item_quantity: $('#returnSalesLineItemQty_' + itemid).text(),
                    item_id: $('#returnSalesLineItemId_' + itemid).attr('data-product-id') || $('#returnSalesLineItemId_' + itemid).text(),
                    line_id: $('#returnSalesLineItemId_' + itemid).attr('data-line-id') || undefined,
                    total_amount: $('#returnSalesLineTotal_' + itemid).text(),
                    barcode_id: $('#returnSalesLineItemBarcodeId_' + itemid).text(),
                    company_price_total: $('#returnSalesLineItemCompanyPrice_' + itemid).text(),
                    category_id: $('#saleCategoryId_' + itemid).text(),
                    category_name: $('#saleCategoryName_' + itemid).text(),
                    supplier_id: $('#saleSupplierId_' + itemid).text(),
                    supplier_name: $('#saleSupplierName_' + itemid).text(),
                    payment_description: $('#payment_description').val(),
                    sales_description: $('#sales_description').val()
                };
            }).get();
            var editSalesCompanyPrice = 0;
            var process_return = PosnicPro.sales.returnSalesLineTable.length;
            for (var i = 0; i < process_return; i++) {
                editSalesCompanyPrice += PosnicPro.sales.lineCompanyCostTotal(PosnicPro.sales.returnSalesLineTable[i]);
            }
            var process_status = process_return > 0 ? 'PartialReturn' : 'FullReturn';
            var SalesDocumentId = 0;
            SalesDocumentId = PosnicPro.sales.editSaleId;
            SalesDocumentId = (salesAction === 'return') ? PosnicPro.sales.refundSaleId : SalesDocumentId;
            SalesDocumentId = (PosnicPro.sales.salesExchange === true) ? PosnicPro.sales.refundSaleId : SalesDocumentId;
            var data = {
                sale_process: process_status,
                return_register_id: PosnicPro.sales.saleRegisterId(),
                date: $('#time-format').val(),
                sales_id: SalesDocumentId,
                alternative_id: PosnicPro.sales.salesId,
                addInventory: false,
                items: PosnicPro.sales.returnSalesLineTable,
                items_return: PosnicPro.sales.returnitemSalesLineTable,
                discount: String($("#discount_sale_amount").text() || '').replace(/,/g, ''),
                payment_pending: PosnicPro.sales.EditRecentSaleParams.payment_pending,
                partial_check: PosnicPro.sales.EditRecentSaleParams.partial_check,
                extra_discount: parseFloat($('#extraDisc').text()),
                extra_discount_type: !$('#percentIcon').hasClass('d-none') ? "percent" : "price",
                round_off_check: PosnicPro.sales.extraDiscount.sales_round_off !== 0 ? true : false,
            };
            $('#return_amount_check').modal('hide');
            // Carry the manager-approval token (if a refund needed one) so the
            // server can verify it. Single-use: cleared once sent.
            data.approval_token = PosnicPro._refundApprovalToken || undefined;
            PosnicPro._refundApprovalToken = null;
            var paramsReturn = {
                method: 'POST',
                url: 'sales/returnSales',
                data: JSON.stringify(data)
            };
            PosnicPro.request(paramsReturn, function (response) {
                if (response.type === 'success') {
                    // A return puts stock back; cached items are stale.
                    PosnicPro.sales.itemCache.clear();
                    PosnicPro.alert(response.type, response.message);
                    history.back();
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
        } else {
            var loader = $(".loader-sales-balance");
            $("<div class='loadingSpinner'></div>").appendTo(loader);

            PosnicPro.sales.addSalesLineTable = $('#sales_new_items_table tbody tr').map(function () {
                let itemid = $(this).find(':nth-child(9)').text();

                // Use the saved order note; never borrow catalogue copy.
                var noteText = $('#addSalesLineItemNote_' + itemid).text() || '';
                var descriptionFromCache = '';
                var cachedItem = PosnicPro.sales.SaleTableLineItems[itemid];
                if (cachedItem && typeof (cachedItem.item_description) !== 'undefined' && cachedItem.item_description !== null) {
                    descriptionFromCache = cachedItem.item_description;
                }
                var finalItemDescription = $.trim(noteText) !== '' ? noteText : descriptionFromCache;

                return {
                    sale_inline_item_price: $('#saleInlineItemPrice_' + itemid).text(),
                    sale_inline_discount_pervalue: $("#saleInlineDiscountPer_" + itemid).text(),
                    sale_inline_discount_value: $("#saleInlineDiscount_" + itemid).text(),
                    item_status: $('#salesOrderType_' + itemid).text(),
                    item_name: $('#addSalesLineItemName_' + itemid).data('originalName') || $('#addSalesLineItemName_' + itemid).text(),
                    ...(window.PosnicItemText ? window.PosnicItemText.snapshot($('#addSalesLineItemName_' + itemid).data('itemText')) : {}),
                    item_unit: $('#addSalesLineItemUnit_' + itemid).text(),
                    item_price: $('#addSalesLineItemPrice_' + itemid).text(),
                    item_discount: $('#addSalesLineDiscountAmount_' + itemid).text(),
                    item_discount_percentage: $('#addSalesLineDiscountPercentage_' + itemid).text(),
                    item_quantity: $('#touchsale_item_qty' + itemid).val(),
                    item_id: $('#addSalesLineItemId_' + itemid).attr('data-product-id') || $('#addSalesLineItemId_' + itemid).text(),
                    line_id: $('#addSalesLineItemId_' + itemid).attr('data-line-id') || undefined,
                    total_amount: $('#addSalesLineTotal_' + itemid).text(),
                    barcode_id: $('#addSalesLineItemBarcodeId_' + itemid).text(),
                    company_price_total: $('#addSalesLineItemCompanyPrice_' + itemid).text(),
                    category_id: $('#saleCategoryId_' + itemid).text(),
                    category_name: $('#saleCategoryName_' + itemid).text(),
                    supplier_id: $('#saleSupplierId_' + itemid).text(),
                    supplier_name: $('#saleSupplierName_' + itemid).text(),
                    old_item_quantity: parseFloat($('#returnItemChangeQuantityValue_' + itemid).text()) || 0,
                    track_inventory: $('#trackInventory_' + itemid).text(),
                    negative_stock: $('#negativeStock_' + itemid).text(),
                    item_price_total: $('#addSalesLineItemSellingPrice_' + itemid).text(),
                    item_description: finalItemDescription
                };
            }).get();

            var editSalesCompanyPrice = 0;
            var editSalesSubTotal = 0;
            for (var i = 0; i < PosnicPro.sales.addSalesLineTable.length; i++) {
                editSalesCompanyPrice += PosnicPro.sales.lineCompanyCostTotal(PosnicPro.sales.addSalesLineTable[i]);
                editSalesSubTotal += parseFloat(PosnicPro.sales.addSalesLineTable[i].total_amount) || 0;
            }

            var SalesDocumentId = 0;
            SalesDocumentId = PosnicPro.sales.editSaleId;
            SalesDocumentId = (salesAction === 'return') ? PosnicPro.sales.refundSaleId : SalesDocumentId;
            SalesDocumentId = (PosnicPro.sales.salesExchange === true) ? PosnicPro.sales.refundSaleId : SalesDocumentId;

            // Default behaviour: convert Hold -> Add, otherwise keep as Edit
            // Protocol values must not depend on the cashier's display language.
            var sale_process = (PosnicPro.sales.EditRecentSaleParams.sale_process === 'Hold') ? 'Add' : 'Edit';


            var register_id = PosnicPro.sales.saleRegisterId();

            let amountReceived = parseFloat($('#Partial_amount').val());
            amountReceived = isFinite(amountReceived) && amountReceived > 0 ? amountReceived : 0;
            let saleTotal = parseFloat($('#grand_total').val());
            saleTotal = isFinite(saleTotal) ? saleTotal : 0;
            let amountIsPartial = amountReceived < saleTotal - 0.005;

            var dataEdit = {
                sale_process: sale_process,
                date: $('#time-format').val(),
                sales_sub_total: editSalesSubTotal,
                sales_total: $("#grand_total").val(),
                customer_id: $('#sales_new_customer_id').val(),
                customer_name: ($('#sales_new_customer_name').val() === '') ? 'Anonymous' : $('#sales_new_customer_name').val(),
                create_customer_on_save: !$('#sales_new_customer_id').val() && !!$.trim($('#sales_new_customer_name').val()),
                customer_address: $('#sales_new_customer_address').val(),
                sales_id: SalesDocumentId,
                customer_phone: $('#sales_new_customer_phone').val(),
                customer_email: $('#sales_new_customer_email').val(),
                customer_state: $('#sales_new_customer_state').val(),
                customer_country: $('#sales_new_customer_country').val(),
                payment_description: $('#payment_description').val(),
                discount: String($("#discount_sale_amount").text() || '').replace(/,/g, ''),
                addInventory: false,
                items: PosnicPro.sales.addSalesLineTable,
                sales_total_company_price: editSalesCompanyPrice,
                sales_description: $('#sales_description').val(),
                discount_description: $('#discount_description').val(),
                alternative_id: PosnicPro.sales.salesId,
                register_id: register_id,
                partial_balance: amountReceived.toFixed(2),
                customer_current_balance: 0,
                partial_check: amountIsPartial ? 'true' : 'false',
                wallet_check: 'false',
                extra_discount: parseFloat($('#extraDisc').text()),
                extra_discount_type: !$('#percentIcon').hasClass('d-none') ? "percent" : "price",
                charges: PosnicPro.sales.charges || []
            };

            var paramsEdit = {
                method: 'PUT',
                url: 'sales/' + SalesDocumentId,
                data: JSON.stringify(dataEdit)
            };

            PosnicPro.sales._editDiscountRetried = false;
            var submitEditSale = function () {
            PosnicPro.request(paramsEdit, function (response) {
                if (response.type === 'success') {
                    // An edit moves stock; cached items are stale.
                    PosnicPro.sales.itemCache.clear();
                    // Normalise sale id for both legacy (string) and new (object) responses
                    var saleId = null;
                    if (response && typeof response.data !== 'undefined' && response.data !== null) {
                        if (typeof response.data === 'object') {
                            saleId = response.data.sales_id || response.data.sale_id || response.data.id || null;
                        } else {
                            saleId = String(response.data);
                        }
                    }
                    if (!saleId) {
                        saleId = String(SalesDocumentId || '');
                    }

                    $('#extraDisc').text(0);
                    $('#extraDisc').editable('setValue', 0);
                    /*
                     * ONE announcement per sale. The done card is the
                     * confirmation when it shows; a toast on top of it said
                     * the same thing twice and, on a phone, sat exactly over
                     * the card's close button (owner: "sometime it might
                     * block some action like close from mobile"). Errors
                     * still toast - the card never shows for those.
                     */
                    if (!(response.type === 'success' && PosnicPro.local.get('balance_view') === 'true')) {
                        PosnicPro.alert(response.type, response.message);
                    }
                    PosnicPro.sales.recentMenu.recentSalesTabDetails();
                    PosnicPro.sales.salesId = '';
                    $('.changeSalesBtnText').text(PosnicPro.i18n.t('lang_updatebtn_title', 'Update'));



                    /* For updating dashboard Today sales report details*/
                    if (salesAction !== 'edit') {
                    }

                    //                if (PosnicPro.local.get('balance_view') === 'true') {
                    //                    $('.salesBalanceAmount,#newsalespage').show();
                    //                    $('#sales_save_button,#tenderpage').hide();
                    //                } else {
                    //                    hasher.setHash('sales');
                    //                    $('.salesBalanceAmount').hide();
                    //                    $('#sales_save_button').show();
                    //                }
                    $('.printSalesReceipt')
                        .attr('href', saleId + '/print')
                        .data('sale-id', saleId);

                    // A completed parked bill follows Auto Print like a new
                    // sale. printAfterSave warns once and keeps the saved sale
                    // when no printer is connected, instead of blocking here.
                    if (completingParkedSale && response && typeof response.data === 'object' &&
                        PosnicPro.sales.parkedMenu.printEnabled(response.data.print) && saleId) {
                        PosnicPro.sales.printAfterSave(saleId);
                    }

                    if (PosnicPro.sales.recentSaleAction === true) {
                        hasher.setHash('sales/new');
                    }


                    $('#qr_view').modal('hide');
                    db.customerDisplay.where('clear').equals('yes').delete();
                    loader.find(".loadingSpinner:first").remove();
                } else {
                    PosnicPro.alert(response.type, response.message);
                    loader.find(".loadingSpinner:first").remove();
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);

                // A discount added while editing needs a manager: prompt for the
                // PIN/card, attach the token, and resubmit once.
                if (xhr.status === 403 && response
                        && /discount needs manager approval/i.test(response.message || '')
                        && !PosnicPro.sales._editDiscountRetried) {
                    PosnicPro.sales._editDiscountRetried = true;
                    loader.find(".loadingSpinner:first").remove();
                    PosnicPro.requireManagerApproval('discount_apply',
                        { prompt: "This discount needs a manager's approval." },
                        function (approval) {
                            try {
                                var d = JSON.parse(paramsEdit.data);
                                d.approval_token = approval && approval.approval_token;
                                paramsEdit.data = JSON.stringify(d);
                            } catch (e) { /* resubmit unchanged; server decides */ }
                            submitEditSale();
                        });
                    return;
                }
                PosnicPro.alert(response.type, response.message);

                // Reset payment-only flags and close tender appropriately on error
                if (PosnicPro.sales.paymentOnlyMode === true) {
                    $('.infobar-settings-sidebar-overlay').css({ 'background': 'transparent', 'position': 'initial' });
                    $('#infobar-settings-sidebar-tender-details').removeClass('sidebarview');
                    PosnicPro.sales.paymentOnlyMode = false;
                    PosnicPro.sales.originalSaleData = null;
                } else {
                    $(".infobar-settings-sidebar-overlay").css({ "background": "rgba(0,0,0,0.4)", "position": "fixed" });
                    $("#infobar-settings-sidebar-tender-details").removeClass("sidebarview");
                }
                loader.find(".loadingSpinner:first").remove();
            });
            };
            submitEditSale();
            return false;
        }
    }
};
/*********** END - EDIT ,RETURN AND EXCHANGE ***********/


PosnicPro.sales.holdSale = {
    /*Hold Sales Order*/

    holdOrderSubmit: function () {
        // walk-in sales must not be refused: fill from the cached default
        // customer when nothing was chosen (see ensureCustomer)
        if (PosnicPro.sales.ensureCustomer) { PosnicPro.sales.ensureCustomer(); }
        var customer_name = $("#sales_new_customer_name").val();
        if (!$('#sales_new_items_table tbody tr[id^="touch_row_"]').length || customer_name === '') {

            if (customer_name === '') {
                $('.toggle-customer-user').css({ display: 'block' });
                PosnicPro.sales.setCustomerPopup(true);
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_customer_name', 'Enter a customer name.'));
                return false;
            }
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_add_at_least_one_item', 'Add at least one item.'));
            $('#sales_new_item_name').focus();
            return false;
        } else {
            PosnicPro.sales.addSalesLineTable = $('#sales_new_items_table tbody tr').map(function () {
                let itemid = $(this).find(':nth-child(9)').text();
                return {
                    return: false,
                    item_status: 'Hold',
                    item_name: $('#addSalesLineItemName_' + itemid).data('originalName') || $('#addSalesLineItemName_' + itemid).text(),
                    ...(window.PosnicItemText ? window.PosnicItemText.snapshot($('#addSalesLineItemName_' + itemid).data('itemText')) : {}),
                    item_price: $('#addSalesLineItemPrice_' + itemid).text(),
                    item_discount: $('#addSalesLineDiscountAmount_' + itemid).text(),
                    item_discount_percentage: $('#addSalesLineDiscountPercentage_' + itemid).text(),
                    item_quantity: $('#touchsale_item_qty' + itemid).val(),
                    item_available_quantity: $('#addSalesLineavailableQty_' + itemid).text(),
                    item_id: $('#addSalesLineItemId_' + itemid).attr('data-product-id') || $('#addSalesLineItemId_' + itemid).text(),
                    line_id: $('#addSalesLineItemId_' + itemid).attr('data-line-id') || undefined,
                    total_amount: $('#addSalesLineTotal_' + itemid).text(),
                    barcode_id: $('#addSalesLineItemBarcodeId_' + itemid).text(),
                    company_price_total: $('#addSalesLineItemCompanyPrice_' + itemid).text(),
                    category_id: $('#saleCategoryId_' + itemid).text(),
                    category_name: $('#saleCategoryName_' + itemid).text(),
                    supplier_id: $('#saleSupplierId_' + itemid).text(),
                    supplier_name: $('#saleSupplierName_' + itemid).text(),
                    track_inventory: $('#trackInventory_' + itemid).text(),
                    negative_stock: $('#negativeStock_' + itemid).text(),
                    item_price_total: $('#addSalesLineItemSellingPrice_' + itemid).text()
                };
            }).get();
            var TotalCompanyPrice = 0;
            for (var i = 0; i < PosnicPro.sales.addSalesLineTable.length; i++) {
                TotalCompanyPrice += PosnicPro.sales.lineCompanyCostTotal(PosnicPro.sales.addSalesLineTable[i]);
            }
            var SalesDocumentId = PosnicPro.sales.editSaleId;
            let register_id = PosnicPro.sales.saleRegisterId();
            var data = {
                items: PosnicPro.sales.addSalesLineTable,
                sales_total: $("#grand_total").val(),
                sales_sub_total: String($('#sales_new_subtotal').text() || '').replace(/,/g, ''),
                customer_id: $('#sales_new_customer_id').val(),
                customer_name: $('#sales_new_customer_name').val(),
                    create_customer_on_save: !$('#sales_new_customer_id').val() && !!$.trim($('#sales_new_customer_name').val()),
                customer_address: $('#sales_new_customer_address').val(),
                customer_phone: $('#sales_new_customer_phone').val(),
                customer_email: $('#sales_new_customer_email').val(),
                customer_state: $('#sales_new_customer_state').val(),
                customer_country: $('#sales_new_customer_country').val(),
                sales_total_company_price: TotalCompanyPrice,
                date: $('#time-format').val(),
                discount: String($("#discount_sale_amount").text() || '').replace(/,/g, ''),
                payment_description: $('#payment_description').val(),
                partial_check: $('#sales_new_customer_partial_balance').val() === 'true' ? 'true' : 'false',
                partial_balance: $('#Partial_amount').val(),
                customer_current_balance: 0,
                wallet_check: 'false',
                sales_description: $('#sales_description').val(),
                discount_description: $('#discount_description').val(),
                sales_id: SalesDocumentId,
                alternative_id: PosnicPro.sales.salesId,
                register_id: register_id,
                extra_discount_type: !$('#percentIcon').hasClass('d-none') ? "percent" : "price",
                charges: PosnicPro.sales.charges || []
            };
            var method = "POST";
            if (SalesDocumentId !== '') {
                method = 'PUT';
            }
            var params = {
                method: method,
                url: 'sales/hold',
                data: JSON.stringify(data)
            };
            PosnicPro.request(params, function (response) {
                if (response.type === 'success') {
                    PosnicPro.sales.setDefaults();
                    // The visible tab reflects the park IMMEDIATELY (owner ask) -
                    // the dispatcher refreshes whichever pane is showing.
                    PosnicPro.sales.recentMenu.recentSalesTabDetails();
                }
                PosnicPro.alert(response.type, response.message);
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
            return false;
        }
    }
};
/*********** START ADD SALES LINE ITEMS QUANTITY INCREASE & QUANTITY FUNCTION ***********/
PosnicPro.sales.quantity = {
    /*
     * How much one press of + or - is worth, and how finely to keep it.
     *
     * A counted item steps by one, which is what a button beside a quantity
     * means. An item sold by weight steps by 100g and keeps three decimals,
     * because the scale reports grams and rounding to two would lose them: a
     * reading of 0.305kg became 0.31 and the shop gave away 5g every press.
     */
    /*
     * How many decimals a quantity keeps.
     *
     * A scale reports grams, so a weight needs three: 0.375kg is 375g, and at
     * two decimals it becomes 0.38 - ten grams the shop gives away on a sale
     * and ten it never gets back on a return. Counted goods keep two, which is
     * what every other total on the receipt uses.
     *
     * A weight keeps all three even when they are zeros. Dropping them left the
     * quantity column ragged - 0.25 beside 0.1 beside 1 - because each row was
     * a different width, and a column of weights that does not line up is one
     * nobody can total by eye. 0.250, 0.100 and 1.000 all occupy the same
     * space, and the trailing zeros say "this was weighed" rather than looking
     * like a number somebody rounded.
     *
     * Counted goods still drop them, so a plain 2 does not read as 2.00 beside
     * a genuine weight.
     */
    formatQty: function (value, weighed) {
      var n = parseFloat(value);
      if (isNaN(n)) return '0';
      if (weighed === undefined || weighed) return n.toFixed(3);

      var text = n.toFixed(2);
      return text.indexOf('.') === -1 ? text : text.replace(/\.?0+$/, '');
    },

    /*
     * Put a quantity back in the box the way the column expects to see it.
     *
     * Used everywhere a value is written to a quantity input, so a weight
     * arrives at three decimals whether it came from the scale, the plus and
     * minus buttons, or somebody typing.
     */
    /*
     * Square up the quantity box for a weighed line.
     *
     * Deliberately not wired to keyup or blur. textOnChange rebuilds this input
     * on every keystroke, so a reformat triggered by typing would land in the
     * middle of the number somebody is still entering - "0.25" becomes "0.250"
     * and the next digit makes it 0.2505. Half-typed text is refused here too,
     * so ".", "0." and "" survive long enough to become a number.
     *
     * Called from the paths that set a quantity outright.
     */
    normalizeInput: function (id) {
        var box = $('#touchsale_item_qty' + id);
        if (!box.length) return;

        var raw = String(box.val());
        if (raw === '' || /\.$/.test(raw) || isNaN(parseFloat(raw))) return;

        var unit = PosnicPro.sales.quantity.stepFor(id, raw);
        if (!unit.pad) return;   // counted goods are left exactly as entered

        box.val(PosnicPro.sales.quantity.applyPrecision(raw, unit));
    },

    applyPrecision: function (value, unit) {
        if (!unit || !unit.pad) {
            return (Number.isInteger(parseFloat(value)))
                ? value
                : parseFloat(value).toFixed(unit ? unit.decimals : 2);
        }
        return PosnicPro.sales.quantity.formatQty(value, true);
    },

    stepFor: function (id, currentValue) {
        var line = PosnicPro.sales.SaleTableLineItems[id];
        if (PosnicPro.sales.isWeighedItem(line)) {
            return { step: 0.1, decimals: 3, floor: 0.001, pad: true };
        }
        // Unchanged for counted items: a whole number steps by one, and a
        // quantity someone has typed a fraction into steps finely so the
        // button does not throw the fraction away.
        var fractional = Number.isInteger(parseFloat(currentValue)) === false;
        return { step: fractional ? 0.01 : 1, decimals: 2, floor: 1 };
    },

    qtyIncreaseDecrease: function (id, action, track_inventory, negative_stock) {
        $("#save_submit").removeClass("disabled");
        var oldValue = $('#touchsale_item_qty' + id).val();
        var unit = PosnicPro.sales.quantity.stepFor(id, oldValue);
        let value;
        if (action === 1) {
            value = parseFloat(oldValue) + unit.step;
            value = PosnicPro.sales.quantity.applyPrecision(value, unit);
            var available_quantity = PosnicPro.sales.SaleTableLineItems[id].available_quantity;
            if (track_inventory === 'true' && negative_stock === 'false' && $('#instantStatus_' + id).text() !== 'ok') {
                if (PosnicPro.sales.SaleAction === 'edit') {
                    PosnicPro.get('items/' + id, function (response) {
                        if (response.type === 'success') {
                            let available = response.data.available_quantity;
                            let change = parseInt($('#returnItemChangeQuantityValue_' + id).text());
                            if ((available + change) < value) {
                                PosnicPro.alert('error', PosnicPro.i18n.t('lang_items_not_available_in_the_stock', 'Items Not Available In The Stock!.'));
                                $('#touchsale_item_qty' + id).val(change);
                                return false;
                            }
                        } else {
                            PosnicPro.alert(response.type, response.message);
                        }
                    }, function (xhr) {
                        let change = parseInt($('#returnItemChangeQuantityValue_' + id).text());
                        PosnicPro.alert('error', PosnicPro.i18n.t('lang_items_not_available_in_the_stock', 'Items Not Available In The Stock!.'));
                        $('#touchsale_item_qty' + id).val(change);
                        return false;
                    });
                } else {
                    if (available_quantity < value) {
                        PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                        $('#touchsale_item_qty' + id).val(PosnicPro.sales.SaleTableLineItems[id].available_quantity);
                        return false;
                    }
                }
            }
        } else {
            $("#save_submit").removeClass("disabled");
            /*
             * Down to the floor, and no further - but the floor is not always
             * one.
             *
             * This read "if (oldValue > 1) ... else value = 1", so pressing
             * minus on a line of 0.300kg did not decline to go lower: it set
             * the quantity to 1. Three hundred grams became a kilo, and the
             * customer was charged for it. For anything sold by weight the
             * floor has to be a gram, not a kilo.
             */
            var current = parseFloat(oldValue);
            if (isNaN(current)) current = unit.floor;

            if (current - unit.step >= unit.floor) {
                value = current - unit.step;
                value = PosnicPro.sales.quantity.applyPrecision(value, unit);
            } else if (current > unit.floor) {
                // Closer to the floor than a whole step: land on it exactly
                // rather than refusing to move.
                value = PosnicPro.sales.quantity.applyPrecision(unit.floor, unit);
            } else {
                value = PosnicPro.sales.quantity.applyPrecision(current, unit);
            }
        }
        $('#touchsale_item_qty' + id).val(value);
        var ItemQty = $('#touchsale_item_qty' + id).val();
        var lineMath = PosnicPro.sales.readLineTotals(id);
        var updateSalesLineTotal = lineMath.total.toFixed(2);
        $('#addSalesLineTotal_' + id).text(updateSalesLineTotal);
        $('#addSalesDiscount_' + id).text(lineMath.discount.toFixed(2));
        var addLineItemQty = '<input type="text" minlength="1" maxlength="7" size="4" min="0" max="10000" class="form-control cart-qty font_size14" inputmode="decimal" name="addSalesLineItemQty" id="touchsale_item_qty' + id + '" value=' + ItemQty + ' oninput="this.value = PosnicPro.minmax(this.value, 0, 100000); PosnicPro.sales.quantity.textOnChange(\'' + id + '\',\'' + track_inventory + '\',\'' + negative_stock + '\');" onfocusout="PosnicPro.sales.quantity.normalizeInput(\'' + id + '\');" onkeypress="PosnicPro.validate(event)" style="width: 140px;text-align: center; max-width:120px !important;">';
        $('#touchsale_item_qty' + id).replaceWith(addLineItemQty);
        var itemRecord = [];
        itemRecord.push({ name: $('#addSalesLineItemName_' + id).text(), qty: ItemQty, price: $('#addSalesLineItemPrice_' + id).text(), discount: $('#addSalesLineItemDiscount_' + id).text(), total: updateSalesLineTotal });
        db.customerDisplay.put({ id: id, 'clear': 'yes', 'get': 'yes', items: itemRecord });
        PosnicPro.sales.calculation.salesTableRowCart();
        PosnicPro.sales.customerBalanceCheck();
        PosnicPro.sales.customerViewDisplay();
    },
    /*
     * SALES LINE ITEMS QUANTITY INCREASE & QUANTITY BASED ON KEYDOWN OF THE TEXTBOX VALUE
     */
    textOnChange: function (id, track_inventory, negative_stock) {
        var ItemQty = $('#touchsale_item_qty' + id).val();
        var available_quantity = PosnicPro.sales.SaleTableLineItems[id].available_quantity;
        if (track_inventory === 'true' && negative_stock === 'false') {

            if (PosnicPro.sales.SaleAction === 'edit') {
                PosnicPro.get('items/' + id, function (response) {
                    if (response.type === 'success') {
                        let available = response.data.available_quantity;
                        let change = parseInt($('#returnItemChangeQuantityValue_' + id).text());
                        if ((available + change) < ItemQty) {
                            PosnicPro.alert('error', PosnicPro.i18n.t('lang_items_not_available_in_the_stock', 'Items Not Available In The Stock!.'));
                            $('#touchsale_item_qty' + id).val(change);
                            let lineMath = PosnicPro.sales.readLineTotals(id);
                            $('#addSalesLineTotal_' + id).text(lineMath.total.toFixed(2));
                            $('#addSalesDiscount_' + id).text(lineMath.discount.toFixed(2));
                                                var itemRecord = [];
                            itemRecord.push({ name: $('#addSalesLineItemName_' + id).text(), qty: change, price: $('#addSalesLineItemPrice_' + id).text(), discount: $('#addSalesLineItemDiscount_' + id).text(), total: lineMath.total });
                            db.customerDisplay.put({ id: id, 'clear': 'yes', 'get': 'yes', items: itemRecord });
                            PosnicPro.sales.calculation.salesTableRowCart();
                            return false;
                        }
                    } else {
                        PosnicPro.alert(response.type, response.message);
                    }
                }, function (xhr) {
                    let change = parseInt($('#returnItemChangeQuantityValue_' + id).text());
                    PosnicPro.alert('error', PosnicPro.i18n.t('lang_items_not_available_in_the_stock', 'Items Not Available In The Stock!.'));
                    $('#touchsale_item_qty' + id).val(change);
                    return false;
                });
            } else {
                if (available_quantity < ItemQty) {
                    $('#touchsale_item_qty' + id).val(available_quantity);
                    let lineMath = PosnicPro.sales.readLineTotals(id);
                    $('#addSalesLineTotal_' + id).text(lineMath.total.toFixed(2));
                    $('#addSalesDiscount_' + id).text(lineMath.discount.toFixed(2));
                                var itemRecord = [];
                    itemRecord.push({ name: $('#addSalesLineItemName_' + id).text(), qty: available_quantity, price: $('#addSalesLineItemPrice_' + id).text(), discount: $('#addSalesLineItemDiscount_' + id).text(), total: lineMath.total });
                    db.customerDisplay.put({ id: id, 'clear': 'yes', 'get': 'yes', items: itemRecord });
                    PosnicPro.sales.calculation.salesTableRowCart();
                    PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                    return false;
                }
            }


        }

        $('#touchsale_item_qty' + id).val(ItemQty);
        var lineMath = PosnicPro.sales.readLineTotals(id);
        var updateSalesLineTotal = lineMath.total.toFixed(2);
        $('#addSalesLineTotal_' + id).text(updateSalesLineTotal);
        $('#addSalesDiscount_' + id).text(lineMath.discount.toFixed(2));
        var itemRecord = [];
        itemRecord.push({ name: $('#addSalesLineItemName_' + id).text(), qty: ItemQty, price: $('#addSalesLineItemPrice_' + id).text(), discount: $('#addSalesLineItemDiscount_' + id).text(), total: updateSalesLineTotal });
        db.customerDisplay.put({ id: id, 'clear': 'yes', 'get': 'yes', items: itemRecord });
        PosnicPro.sales.calculation.salesTableRowCart();
        PosnicPro.sales.customerBalanceCheck();
        PosnicPro.sales.customerViewDisplay();
    },

    //Sales return - quantity button wise return
    removeReturnRowLineItems: function (id) {
        $('#RoundOff').html('');
        if (PosnicPro.sales.return_remove === 'increment') {
            var quantityValue = $('#touchsale_item_return_qty' + id).val();
            var item_quantity = (parseFloat($('#returnSalesLineItemQty_' + id).text()) || 0) + (parseFloat(quantityValue) || 0);
        } else {
            var item_quantity = $('#touchsale_item_return_qty' + id).val();
        }
        var item_name = $('#addSalesLineItemName_' + id).text();
        var item_Unit = $('#addSalesLineItemUnit_' + id).text();
        var item_price = $('#addSalesLineItemSellingPrice_' + id).text();
        var discount = $('#addSalesLinediscountval_' + id).text();
        var discount_percentage = $('#addSalesLineDiscountPercentage_' + id).text();
        var ordertype = $('#salesOrderType_' + id).text();
        var discount_amount = $('#addSalesLineDiscountAmount_' + id).text();
        var item_id = $('#addSalesLineItemId_' + id).text();
        var barcode_id = $('#addSalesLineItemBarcodeId_' + id).text();
        var company_price = $('#addSalesLineItemCompanyPrice_' + id).text();
        var supplier = $('#addSalesLineItemSupplier_' + id).text();
        var category_id = $('#saleCategoryId_' + id).text();
        var category_name = $('#saleCategoryName_' + id).text();
        var supplier_id = $('#saleSupplierId_' + id).text();
        var supplier_name = $('#saleSupplierName_' + id).text();
        var removeTotal = $('#returnLineTotal_' + id).text();
        var discount_sign = $('#discountSign' + id).text();

        if ((discount_amount > 0)) {
            var discount_returnpercentages = '' + discount_sign + '' + discount + '';
        } else {
            var discount_returnpercentages = '' + discount + '' + discount_sign + '';

        }

        var returnSalesDiscount = (discount_amount > 0) ? discount_amount : ((parseFloat($('#addSalesLineItemPrice_' + id).text())) * (discount_percentage / 100));
        var returnMath = PosnicPro.sales.lineTotals(item_price, item_quantity, discount, discount_sign === '%');
        var updateSalesLineTotal = Number(returnMath.total).toFixed(2);
        $('#addSalesLineTotal_' + id).text(updateSalesLineTotal);
        var items_total = $('#addSalesLineTotal_' + id).text();
        var currentLineItemTotal = $('#returnSalesIncreaseDecrease_' + id).text();
        var itemLineMath = PosnicPro.sales.lineTotals(item_price, currentLineItemTotal, discount, discount_sign === '%');
        var itemLineTotal = itemLineMath.total;
        var price = parseFloat(item_price);
        item_Unit = (typeof (item_Unit) != "undefined" && item_Unit !== null) ? item_Unit : "qty";
        var rowHTMLLine = '<tr id="touch_row_return_' + id + '" class="touch-sales-hover-effect border-top pt-3"> ' +
            '    <td id="returnSalesLineItemName_' + id + '" data-id="' + PosnicPro.escapeHtml(item_name) + '" class="font_size14" width="30%">' + PosnicPro.escapeHtml(item_name) + '</td>' +
            '    <td id="returnSalesLineItemQty_' + id + '" class="text-center font_size14">' + item_quantity + '</td>' +
            '    <td name ="returnSalesLineItemUnit" id="returnSalesLineItemUnit_' + id + '">' + item_Unit + '</td>' +
            '    <td id="returnSalesLineItemPrice_' + id + '" class="text-center font_size14">' + price.toFixed(2) + '</td>' +
            '    <td id="returnLineItemDiscount_' + id + '" class="text-center font_size14">' + discount_returnpercentages + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="returnSalesLineTotal_' + id + '" class="text-center font_size14">' + items_total + '</td>' +
            '    <td class="text-center"></td>' +
            '    <td id="returnsalesOrderType_' + id + '" style="display:none;">' + ordertype + '</td>' +
            '    <td id="returnSalesLineDiscountAmount_' + id + '" style="display:none;">' + discount_amount + '</td>' +
            '    <td id="returnSalesLineItemId_' + id + '" data-product-id="' + PosnicPro.escapeHtml($('#addSalesLineItemId_' + id).attr('data-product-id') || item_id) + '" data-line-id="' + PosnicPro.escapeHtml($('#addSalesLineItemId_' + id).attr('data-line-id') || '') + '" style="display:none;">' + item_id + '</td>' +
            '    <td id="returnSalesLineItemBarcodeId_' + id + '" style="display:none;">' + barcode_id + '</td>' +
            '    <td id="returnSalesLineItemCompanyPrice_' + id + '" style="display:none;">' + company_price + '</td>' +
            '    <td id="addSalesLineItemSupplier_' + id + '" style="display:none;">' + supplier + '</td>' +
            '    <td id="returnRemoveInLineTotal_' + id + '" style="display:none;">' + removeTotal + '</td>' +
            '    <td id="currentLineItemTotal_' + id + '" style="display:none;">' + itemLineTotal + '</td>' +
            '    <td class="text-center"><button type="button" class="btn-success-rgba mb-1" onclick="PosnicPro.sales.quantity.removeReturnLineRowItems(\'' + id + '\');" aria-label="Move back to sale" data-t-aria-label="lang_move_back_to_sale"><i class="feather icon-arrow-left-circle"></i></button></td>' +
            '    <td id="discountSign' + id + '" style="display:none;">' + discount_sign + '</td>' +
            '    <td name="reSalesLinediscountval" id="reSalesLinediscountval' + id + '" style="display:none;">' + discount + '</td>' +
            '    <td id="rediscountSign' + id + '" style="display:none;">' + discount_sign + '</td>' +
            '    <td name ="reSalesLineDiscountPercentage" id="reSalesLineDiscountPercentage_' + id + '" style="display:none;">' + discount_percentage + '</td>' +
            '    <td id="value_item' + id + '" style="display:none;">' + item_quantity + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="addSalesLineItemSellingPrice_' + id + '" style="display:none;">' + item_price + '</td>' +
            '    <td id="returnSalesLineItemDiscount_' + id + '" style="display:none;">' + discount + '<span id="discountSign' + id + '">' + discount_sign + '</td>' +
            '    <td id="saleCategoryId_' + id + '" style="display:none;">' + category_id + '</td>' +
            '    <td id="saleCategoryName_' + id + '" style="display:none;">' + category_name + '</td>' +
            '    <td id="saleSupplierId_' + id + '" style="display:none;">' + supplier_id + '</td>' +
            '    <td id="saleSupplierName_' + id + '" style="display:none;">' + supplier_name + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="returnSalesDiscount_' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
            '    <td id="returnSalesDiscount' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
            '</tr>';
        if ($('table#sales_return_items_table').find('#touch_row_return_' + id).length > 0) {
            $('#touch_row_return_' + id).replaceWith(rowHTMLLine);
            $('#touch_row_return_' + id).remove();
            $('#sales_return_items_table tbody').prepend(rowHTMLLine);
        } else {
            $('#sales_return_items_table tbody').prepend(rowHTMLLine);
        }
        PosnicPro.sales.addLineTable = $('#sales_return_items_table tbody tr').map(function () {
            let itemid = $(this).find(':nth-child(11)').text();
            return {
                return_total: $('#returnSalesLineTotal_' + itemid).text(),
                subtotalamount: $('#returnSalesLineItemPrice_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text(),
                discountamount: $('#returnSalesDiscount' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text(),
                id: itemid
            };
        }).get();
        var addSalesSubTotal = 0;
        var addSalesGrandTotal = 0;
        var addSaleLineDiscountTotal = 0;
        for (var i = 0; i < PosnicPro.sales.addLineTable.length; i++) {
            addSalesSubTotal += parseFloat(PosnicPro.sales.addLineTable[i].subtotalamount);
            addSalesGrandTotal += parseFloat(PosnicPro.sales.addLineTable[i].return_total);
            addSaleLineDiscountTotal += parseFloat(PosnicPro.sales.addLineTable[i].discountamount);
        }
        $('#refund_subtotal').number(addSalesSubTotal, 2);
        PosnicPro.sales.calculation.returnDiscoundCalculation(addSalesGrandTotal);
        $('.sales_discount_return_value').number(addSaleLineDiscountTotal, 2);


        $('#touch_row_' + id).remove();
        $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
        var removeCount = PosnicPro.sales.addLineTable = $('#sales_new_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(9)').text();
            return itemid;
        }).length;
        if (removeCount === 0) {
            $('#sales_new_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="8"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_sale_empty">Sale Order Empty</lang> </p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
            var imgHeight = $(window).height() - 500;
            $('.sales-cart-image').height(imgHeight);
            $("#save_submit").removeClass("disabled");
            $("#return_button").attr("disabled", true);
            $('#check_button').removeAttr("disabled");
        }
    },

    removeReturnsalesLineRowItems: function (id) {
        ($('#returnSalesLineItemQty_' + id).text() !== '') ? PosnicPro.sales.return_remove = 'increment' : PosnicPro.sales.return_remove = 'remove';
        $("#save_submit,#check_button,#return_button").removeAttr("disabled");
        $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
        PosnicPro.sales.quantity.removeReturnRowLineItems(id);
        if (PosnicPro.sales.EditRecentSaleParams.payment_pending > 0) {
            $('#check_button').attr('disabled', true);
        } else {
            $('#check_button').attr('disabled', false);
        }
    },

    removeReturnLineRowItems: function (id) {
        $('#RoundOff').html('');
        $('table#sales_new_items_table tbody tr#sales_new_tablerow_content_area').remove();
        var item_name = $('#returnSalesLineItemName_' + id).text();
        var item_Unit = $('#returnSalesLineItemUnit_' + id).text();
        var return_table = $('#value_item' + id).text();
        var quan = ($('#returndecreSales_' + id).text() > 0) ? $('#returndecreSales_' + id).text() : 0;
        var total_quant = parseFloat(return_table) + parseFloat(quan);
        var itemLineprice = $('#returnSalesLineItemPrice_' + id).text();
        var item_price = $('#addSalesLineItemSellingPrice_' + id).text();
        var discount = $('#reSalesLinediscountval' + id).text();
        var discount_amount = $('#returnSalesLineDiscountAmount_' + id).text();
        var discount_percentage = $('#reSalesLineDiscountPercentage_' + id).text();
        var company_price = $('#returnSalesLineItemCompanyPrice_' + id).text();
        var barcode_id = $('#returnSalesLineItemBarcodeId_' + id).text();
        var supplier = $('#addSalesLineItemSupplier_' + id).text();
        var category_id = $('#saleCategoryId_' + id).text();
        var category_name = $('#saleCategoryName_' + id).text();
        var supplier_id = $('#saleSupplierId_' + id).text();
        var supplier_name = $('#saleSupplierName_' + id).text();
        var returnqty = 0;
        var addiscount_sign = $('#rediscountSign' + id).text();
        var updateSalesLineTotal;

        if ((discount_amount > 0)) {
            var discount_returnpercentages = '' + addiscount_sign + '' + discount + '';
        } else {
            var discount_returnpercentages = '' + discount + '' + addiscount_sign + '';

        }

        var returnSalesDiscount = (discount_amount > 0) ? discount_amount : ((parseFloat($('#returnSalesLineItemPrice_' + id).text())) * (discount_percentage / 100));
        var returnMath = PosnicPro.sales.lineTotals(item_price, total_quant, discount, addiscount_sign === '%');
        updateSalesLineTotal = returnMath.total;
        item_Unit = (typeof (item_Unit) != "undefined" && item_Unit !== null) ? item_Unit : "qty";
        updateSalesLineTotal = Number(updateSalesLineTotal).toFixed(2);
        var addLineItemQty = '<div class="input-group">' +
            '<div class="input-group-prepend" id = ' + id + '  onclick="PosnicPro.sales.quantity.qtyreturnDecrease(this.id,0);">' +
            '<span class="button_qty_check btn btn-secondary-rgba"><i class="feather icon-minus"></i></span>' +
            '</div>' +
            '<input type="text" class="form-control cart-qty font_size14" style="text-align:center;background-color:#fff;" minlength="1" maxlength="7" size="4" min="0" max="10000" inputmode="decimal" name="addSalesLineItemQty" id="touchsale_item_return_qty' + id + '" value=' + total_quant + ' onfocusout="PosnicPro.sales.quantity.returntextOnChange(\'' + id + '\');" oninput="this.value = PosnicPro.minmax(this.value, 0, 100000)" onkeypress="PosnicPro.validate(event)">' +
            '<div class="input-group-append" id = ' + id + '  onclick="PosnicPro.sales.quantity.qtyreturnDecrease(this.id,1);">' +
            '<span class="btn btn-success-rgba button_qty_check"><i class="feather icon-plus"></i></span>' +
            '</div>' +
            '</div>';
        var removeLineItem = '<button type="button" class="btn-danger-rgba mb-1" onclick="PosnicPro.sales.quantity.removeReturnsalesLineRowItems(\'' + id + '\');" aria-label="Move to returns" data-t-aria-label="lang_move_to_returns"><i class="feather icon-arrow-right-circle"></i></button>';
        var rowHTMLLine = '<tr id="touch_row_' + id + '" class="touch-sales-hover-effect border-top pt-3"> ' +
            '    <td id="addSalesLineItemName_' + id + '" class="font_size14" data-id="' + PosnicPro.escapeHtml(item_name) + '" width="30%">' + PosnicPro.escapeHtml(item_name) + '</td>' +
            '    <td id="addSalesLineItemQty_' + id + '" class="text-center add_circle font_size14">' + addLineItemQty + '</td>' +
            '    <td name ="addSalesLineItemUnit" id="addSalesLineItemUnit_' + id + '">' + item_Unit + '</td>' +
            '    <td name ="addSalesLineItemPrice" id="addSalesLineItemPrice_' + id + '" class="text-center font_size14">' + itemLineprice + '</td>' +
            '    <td name ="addSalesLineItemDiscount" id="addreturnLineItemDiscount_' + id + '" class="text-center font_size14">' + discount_returnpercentages + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td name ="addSalesLineTotal" id="addSalesLineTotal_' + id + '" class="text-center font_size14">' + updateSalesLineTotal + '</td>' +
            '    <td id="addSalesRemoveLineItem_' + id + '" class="text-center font_size14">' + removeLineItem +
            '    </td>' +
            '    <td name="addSalesLineItemId" id="addSalesLineItemId_' + id + '" data-product-id="' + PosnicPro.escapeHtml($('#returnSalesLineItemId_' + id).attr('data-product-id') || id) + '" data-line-id="' + PosnicPro.escapeHtml($('#returnSalesLineItemId_' + id).attr('data-line-id') || '') + '" style="display:none;">' + id + '</td>' +
            '    <td name="addSalesLineItemCompanyPrice"  id="addSalesLineItemCompanyPrice_' + id + '" style="display:none;">' + company_price + '</td>' +
            '    <td name="addSalesLineItemBarcodeId" id="addSalesLineItemBarcodeId_' + id + '" style="display:none;">' + barcode_id + '</td>' +
            '    <td name="addSalesLineItemSupplier" id="addSalesLineItemSupplier_' + id + '" style="display:none;">' + supplier + '</td>' +
            '    <td name="addSalesLineDiscountPercentage" id="addSalesLineDiscountPercentage_' + id + '" style="display:none;">' + discount_percentage + '</td>' +
            '    <td name="addSalesLineDiscountAmount" id="addSalesLineDiscountAmount_' + id + '" style="display:none;">' + discount_amount + '</td>' +
            '    <td id="returndecreSales_' + id + '" style="display:none;">' + returnqty + '</td>' +
            '    <td id="returnSalesIncreaseDecrease_' + id + '" style="display:none;">' + returnqty + '</td>' +
            '    <td id="adddiscountSign' + id + '" style="display:none;">' + addiscount_sign + '</td>' +
            '    <td name="addSalesLinediscountval" id="addSalesLinediscountval_' + id + '" style="display:none;">' + discount + '</td>' +
            '    <td id="returnitemQuantity_' + id + '" style="display:none;">' + total_quant + '</td>' +
            '    <td id="returnTotal_' + id + '" style="display:none;">0</td>' +
            '    <td name ="addSalesLineItemDiscount" id="addSalesLineItemDiscount_' + id + '" style="display:none;">' + discount + '<span id="discountSign' + id + '">' + addiscount_sign + '</span></td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="addSalesLineItemSellingPrice_' + id + '" style="display:none;">' + $('#addSalesLineItemSellingPrice_' + id).text() + '</td>' +
            '    <td id="saleCategoryId_' + id + '" style="display:none;">' + category_id + '</td>' +
            '    <td id="saleCategoryName_' + id + '" style="display:none;">' + category_name + '</td>' +
            '    <td id="saleSupplierId_' + id + '" style="display:none;">' + supplier_id + '</td>' +
            '    <td id="saleSupplierName_' + id + '" style="display:none;">' + supplier_name + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="returnItemChangeQuantityValue_' + id + '" style="display:none;">' + total_quant.toFixed(2) + '</td>' +
            '    <td id="returnSalesDiscount_' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
            '    <td id="returnSalesDiscount' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
            '</tr>';
        if ($('table#sales_new_items_table').find('#touch_row_' + id).length > 0) {
            $('#touch_row_' + id).replaceWith(rowHTMLLine);
            $('#touch_row_' + id).remove();
            $('#sales_new_items_table tbody').prepend(rowHTMLLine);
        } else {
            $('#sales_new_items_table tbody').prepend(rowHTMLLine);
        }
        $('#touch_row_return_' + id).remove();
        PosnicPro.sales.addLineTable = $('#sales_return_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(11)').text();
            return {
                return_total: $('#returnSalesLineTotal_' + itemid).text(),
                subtotalamount: $('#returnSalesLineItemPrice_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text(),
                discountamount: $('#returnSalesDiscount_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text()
            };
        }).get();
        var addSalesSubTotal = 0;
        var addSalesGrandTotal = 0;
        var addSaleLineDiscountTotal = 0;
        for (var i = 0; i < PosnicPro.sales.addLineTable.length; i++) {
            addSalesSubTotal += parseFloat(PosnicPro.sales.addLineTable[i].subtotalamount);
            addSalesGrandTotal += parseFloat(PosnicPro.sales.addLineTable[i].return_total);
            addSaleLineDiscountTotal += parseFloat(PosnicPro.sales.addLineTable[i].discountamount);
        }
        $('#return_button').removeAttr("disabled");


        addSalesSubTotal = Number(addSalesSubTotal).toFixed(2);
        $('#refund_subtotal').number(addSalesSubTotal, 2);
        $('.sales_discount_return_value').number(addSaleLineDiscountTotal, 2);
        PosnicPro.sales.calculation.returnDiscoundCalculation(addSalesGrandTotal);
        var removeCount = PosnicPro.sales.addLineReturnTable = $('#sales_return_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(11)').text();
            return itemid;
        }).length;
        if (removeCount === 0) {
            $('#extraDisc').text(0);
            $('#extraDisc').editable('setValue', 0);
            $("#save_submit,#check_button").attr("disabled", true);
            $('#sales_return_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="9"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_empty_return">Return Items Order Empty</lang></p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
            var imgHeight = $(window).height() - 500;
            $('.sales-cart-image').height(imgHeight);
        }
    },
    removeReturnAllLineRowItems: function () {
        $('#RoundOff').html('');
        $("#save_submit").removeClass("disabled");
        $("#return_button").attr("disabled", true);
        $('#check_button').removeAttr("disabled");
        PosnicPro.sales.addLineTable = $('#sales_new_items_table tbody tr').map(function () {
            var id = $(this).find(':nth-child(9)').text();
            var value_product = $('#returnItemChangeQuantityValue_' + id).text();
            var item_name = $('#addSalesLineItemName_' + id).text();
            var item_Unit = $('#addSalesLineItemUnit_' + id).text();
            var item_quantity = $('#touchsale_item_return_qty' + id).val();
            var item_return_quantity = ($('#returnSalesLineItemQty_' + id).text() !== '') ? $('#returnSalesLineItemQty_' + id).text() : $('#returndecreSales_' + id).text();
            var item_return_all_quantity = parseFloat(item_quantity) + parseFloat(item_return_quantity);
            var itemLineprice = $('#addSalesLineItemPrice_' + id).text();
            var item_price = $('#addSalesLineItemSellingPrice_' + id).text();
            var discount = $('#addSalesLinediscountval_' + id).text();
            var discount_sign = $('#discountSign' + id).text();
            var discount_percentage = $('#addSalesLineDiscountPercentage_' + id).text();
            var ordertype = $('#salesOrderType_' + id).text();
            var discount_amount = $('#addSalesLineDiscountAmount_' + id).text();
            var item_id = $('#addSalesLineItemId_' + id).text();
            var barcode_id = $('#addSalesLineItemBarcodeId_' + id).text();
            var company_price = $('#addSalesLineItemCompanyPrice_' + id).text();
            var supplier = $('#addSalesLineItemSupplier_' + id).text();
            var category_id = $('#saleCategoryId_' + id).text();
            var category_name = $('#saleCategoryName_' + id).text();
            var supplier_id = $('#saleSupplierId_' + id).text();
            var supplier_name = $('#saleSupplierName_' + id).text();
            var removeTotal = $('#returnLineTotal_' + id).text();
            if ((discount_amount > 0)) {
                var discount_returnpercentages = '' + discount_sign + '' + discount + '';
            } else {
                var discount_returnpercentages = '' + discount + '' + discount_sign + '';

            }

            var returnSalesDiscount = (discount_amount > 0) ? discount_amount : itemLineprice * (discount_percentage / 100);
            var returnMath = PosnicPro.sales.lineTotals(item_price, item_return_all_quantity, discount, discount_sign === '%');
            var updateSalesLineTotal = Number(returnMath.total).toFixed(2);
            item_Unit = (typeof (item_Unit) != "undefined" && item_Unit !== null) ? item_Unit : "qty";
            $('#addSalesLineTotal_' + id).text(updateSalesLineTotal);
            var rowHTMLLine = '<tr id="touch_row_return_' + id + '" class="touch-sales-hover-effect border-top pt-3"> ' +
                '    <td id="returnSalesLineItemName_' + id + '" class="font_size14" width="30%">' + PosnicPro.escapeHtml(item_name) + '</td>' +
                '    <td id="returnSalesLineItemQty_' + id + '" class="text-center font_size14">' + item_return_all_quantity + '</td>' +
                '    <td name ="returnSalesLineItemUnit" id="returnSalesLineItemUnit_' + id + '">' + item_Unit + '</td>' +
                '    <td id="returnSalesLineItemPrice_' + id + '" class="text-center font_size14">' + itemLineprice + '</td>' +
                '    <td id="returnLineItemDiscount_' + id + '" class="text-center font_size14">' + discount_returnpercentages + '</td>' +
                '    <td style="display:none;"></td>' +
                '    <td id="returnSalesLineTotal_' + id + '" class="text-center font_size14">' + updateSalesLineTotal + '</td>' +
                '    <td class="text-center"></td>' +
                '    <td id="returnsalesOrderType_' + id + '" style="display:none;">' + ordertype + '</td>' +
                '    <td id="returnSalesLineDiscountAmount_' + id + '" style="display:none;">' + discount_amount + '</td>' +
                '    <td id="returnSalesLineItemId_' + id + '" data-product-id="' + PosnicPro.escapeHtml($('#addSalesLineItemId_' + id).attr('data-product-id') || item_id) + '" data-line-id="' + PosnicPro.escapeHtml($('#addSalesLineItemId_' + id).attr('data-line-id') || '') + '" style="display:none;">' + item_id + '</td>' +
                '    <td id="returnSalesLineItemBarcodeId_' + id + '" style="display:none;">' + barcode_id + '</td>' +
                '    <td id="returnSalesLineItemCompanyPrice_' + id + '" style="display:none;">' + company_price + '</td>' +
                '    <td id="addSalesLineItemSupplier_' + id + '" style="display:none;">' + supplier + '</td>' +
                '    <td id="returnRemoveInLineTotal_' + id + '" style="display:none;">' + removeTotal + '</td>' +
                '    <td id="rediscountSign' + id + '" style="display:none;">' + discount_sign + '</td>' +
                '    <td name="reSalesLinediscountval" id="reSalesLinediscountval' + id + '" style="display:none;">' + discount + '</td>' +
                '    <td name="reSalesLineDiscountPercentage" id="reSalesLineDiscountPercentage_' + id + '" style="display:none;">' + discount_percentage + '</td>' +
                '    <td class="text-center"><button type="button" class="btn-success-rgba mb-1" onclick="PosnicPro.sales.quantity.removeReturnLineRowItems(\'' + id + '\');" aria-label="Move back to sale" data-t-aria-label="lang_move_back_to_sale"><i class="feather icon-arrow-left-circle"></i></button></td>' +
                '    <td id="value_item' + id + '" style="display:none;">' + value_product + '</td>' +
                '    <td style="display:none;"></td>' +
                '    <td id="addSalesLineItemSellingPrice_' + id + '" style="display:none;">' + item_price + '</td>' +
                '    <td id="saleCategoryId_' + id + '" style="display:none;">' + category_id + '</td>' +
                '    <td id="saleCategoryName_' + id + '" style="display:none;">' + category_name + '</td>' +
                '    <td id="saleSupplierId_' + id + '" style="display:none;">' + supplier_id + '</td>' +
                '    <td id="saleSupplierName_' + id + '" style="display:none;">' + supplier_name + '</td>' +
                '    <td id="returnSalesLineItemDiscount_' + id + '" style="display:none;">' + discount + '<span id="discountSign' + id + '">' + discount_sign + '</td>' +
                '    <td style="display:none;"></td>' +
                '    <td id="returnSalesDiscount_' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
                '</tr>';
            if ($('table#sales_return_items_table').find('#touch_row_return_' + id).length > 0) {
                $('#touch_row_return_' + id).replaceWith(rowHTMLLine);
                $('#touch_row_return_' + id).remove();
                $('#sales_return_items_table tbody').prepend(rowHTMLLine);
            } else {
                $('#sales_return_items_table tbody').prepend(rowHTMLLine);
            }
        }).get();
        PosnicPro.sales.addLineTable = $('#sales_new_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(9)').text();
            return {
                return_total: $('#returnSalesLineTotal_' + itemid).text(),
                id: itemid
            };
        }).get();
        for (var i = 0; i < PosnicPro.sales.addLineTable.length; i++) {
            $('#touch_row_' + PosnicPro.sales.addLineTable[i].id).remove();
            $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
            $("#sales_new_items_table tbody tr").remove();
            $('#sales_new_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="8"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_sale_empty">Sale Order Empty</lang></p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
            var imgHeight = $(window).height() - 500;
            $('.sales-cart-image').height(imgHeight);
        }

        PosnicPro.sales.addLineReturnTable = $('#sales_return_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(11)').text();
            return {
                return_total: $('#returnSalesLineTotal_' + itemid).text(),
                subtotalamount: $('#returnSalesLineItemPrice_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text(),
                discountamount: $('#returnSalesDiscount_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text()
            };
        }).get();
        var addSalesSubTotal = 0;
        var addSalesGrandTotal = 0;
        var addSaleLineDiscountTotal = 0;
        for (var i = 0; i < PosnicPro.sales.addLineReturnTable.length; i++) {
            addSalesSubTotal += parseFloat(PosnicPro.sales.addLineReturnTable[i].subtotalamount);
            addSalesGrandTotal += parseFloat(PosnicPro.sales.addLineReturnTable[i].return_total);
            addSaleLineDiscountTotal += parseFloat(PosnicPro.sales.addLineReturnTable[i].discountamount);
        }

        addSalesSubTotal = Number(addSalesSubTotal).toFixed(2);
        $('#refund_subtotal').number(addSalesSubTotal, 2);
        $('.sales_discount_return_value').number(addSaleLineDiscountTotal, 2);
        PosnicPro.sales.calculation.returnDiscoundCalculation(addSalesGrandTotal);
        if (PosnicPro.sales.EditRecentSaleParams.payment_pending > 0) {
            $('#check_button').attr('disabled', true);
        } else {
            $('#check_button').attr('disabled', false);
        }
    },
    //    return sale add new line of return table
    returnSaleLineItem: function (id) {
        var item_name = $('#addSalesLineItemName_' + id).text();
        var item_quantity = $('#returndecreSales_' + id).text();
        var item_price = $('#addSalesLineItemPrice_' + id).text();
        var item_unit = $('#addSalesLineItemUnit_' + id).text();
        var itemLineprice = $('#addSalesLineItemSellingPrice_' + id).text();
        var discount = $('#addSalesLinediscountval_' + id).text();
        var discount_sign = $('#discountSign' + id).text();

        var ordertype = $('#salesOrderType_' + id).text();
        var discount_amount = $('#addSalesLineDiscountAmount_' + id).text();
        var item_id = $('#addSalesLineItemId_' + id).text();
        var barcode_id = $('#addSalesLineItemBarcodeId_' + id).text();
        var company_price = $('#addSalesLineItemCompanyPrice_' + id).text();
        var supplier = $('#addSalesLineItemSupplier_' + id).text();
        var category_id = $('#saleCategoryId_' + id).text();
        var category_name = $('#saleCategoryName_' + id).text();
        var supplier_id = $('#saleSupplierId_' + id).text();
        var supplier_name = $('#saleSupplierName_' + id).text();
        var removeTotal = $('#returnLineTotal_' + id).text();
        var lineTotal = $('#returnTotal_' + id).text();
        var returnSalesDiscount = parseFloat($('#returnSalesDiscount_' + id).text());
        var value_product = $('#touchsale_item_return_qty' + id).val();
        if ((discount_amount > 0)) {
            var discount_percentages = '' + discount_sign + '' + discount + '';
        } else {
            var discount_percentages = '' + discount + '' + discount_sign + '';

        }
        item_unit = (typeof (item_unit) != "undefined" && item_unit !== null) ? item_unit : "qty";
        var rowHTMLLine = '<tr id="touch_row_return_' + id + '" class="touch-sales-hover-effect border-top pt-3"> ' +
            '    <td id="returnSalesLineItemName_' + id + '" class="font_size14" width="30%">' + PosnicPro.escapeHtml(item_name) + '</td>' +
            '    <td id="returnSalesLineItemQty_' + id + '" class="text-center font_size14">' + item_quantity + '</td>' +
            '    <td id="returnSalesLineItemUnit_' + id + '" class="text-center font_size14">' + item_unit + '</td>' +
            '    <td id="returnSalesLineItemPrice_' + id + '" class="text-center font_size14">' + item_price + '</td>' +
            '    <td id="returnLineItemDiscount_' + id + '" class="text-center font_size14">' + discount_percentages + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="returnSalesLineTotal_' + id + '" class="text-center font_size14">' + lineTotal + '</td>' +
            '    <td class="text-center"></td>' +
            '    <td id="returnsalesOrderType_' + id + '" style="display:none;">' + ordertype + '</td>' +
            '    <td id="returnSalesLineDiscountAmount_' + id + '" style="display:none;">' + discount_amount + '</td>' +
            '    <td id="returnSalesLineItemId_' + id + '" data-product-id="' + PosnicPro.escapeHtml($('#addSalesLineItemId_' + id).attr('data-product-id') || item_id) + '" data-line-id="' + PosnicPro.escapeHtml($('#addSalesLineItemId_' + id).attr('data-line-id') || '') + '" style="display:none;">' + item_id + '</td>' +
            '    <td id="returnSalesLineItemBarcodeId_' + id + '" style="display:none;">' + barcode_id + '</td>' +
            '    <td id="returnSalesLineItemCompanyPrice_' + id + '" style="display:none;">' + company_price + '</td>' +
            '    <td id="addSalesLineItemSupplier_' + id + '" style="display:none;">' + supplier + '</td>' +
            '    <td id="returnRemoveInLineTotal_' + id + '" style="display:none;">' + removeTotal + '</td>' +
            '    <td id="currentLineItemTotal_' + id + '" style="display:none;">' + lineTotal + '</td>' +
            '    <td id="rediscountSign' + id + '" style="display:none;">' + discount_sign + '</td>' +
            '    <td name="reSalesLinediscountval" id="reSalesLinediscountval' + id + '" style="display:none;">' + discount + '</td>' +
            '    <td class="text-center"><button type="button" class="btn-success-rgba mb-1" onclick="PosnicPro.sales.quantity.removeReturnLineRowItems(\'' + id + '\');" aria-label="Move back to sale" data-t-aria-label="lang_move_back_to_sale"><i class="feather icon-arrow-left-circle"></i></button></td>' +
            '    <td id="value_item' + id + '" style="display:none;">' + value_product + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="addSalesLineItemSellingPrice_' + id + '" style="display:none;">' + itemLineprice + '</td>' +
            '    <td id="saleCategoryId_' + id + '" style="display:none;">' + category_id + '</td>' +
            '    <td id="saleCategoryName_' + id + '" style="display:none;">' + category_name + '</td>' +
            '    <td id="saleSupplierId_' + id + '" style="display:none;">' + supplier_id + '</td>' +
            '    <td id="returnSalesLineItemDiscount_' + id + '" style="display:none;">' + discount + '<span id="discountSign' + id + '">' + discount_sign + '</td>' +
            '    <td id="saleSupplierName_' + id + '" style="display:none;">' + supplier_name + '</td>' +
            '    <td style="display:none;"></td>' +
            '    <td id="returnSalesDiscount_' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
            '    <td id="returnSalesDiscount' + id + '" style="display:none;">' + Math.abs(returnSalesDiscount) + '</td>' +
            '    <td id="reSalesLineDiscountPercentage_' + id + '" name="reSalesLineDiscountPercentage" style="display:none;">' + discount + '</td>' +
            '</tr>';
        if ($('table#sales_return_items_table').find('#touch_row_return_' + id).length > 0) {
            $('#touch_row_return_' + id).replaceWith(rowHTMLLine);
            $('#touch_row_return_' + id).remove();
            $('#sales_return_items_table tbody').prepend(rowHTMLLine);
        } else {
            $('#sales_return_items_table tbody').prepend(rowHTMLLine);
        }
    },
    returntextOnChange: function (id) {
        var available_quantity = $('#returnItemChangeQuantityValue_' + id).text();
        var ItemQty = $('#touchsale_item_return_qty' + id).val();

        if (PosnicPro.sales.SaleAction === 'return') {
            if (parseFloat(available_quantity) < parseFloat(ItemQty)) {
                var qtyupdate = $('#returnItemChangeQuantityValue_' + id).text();
                $('#touchsale_item_return_qty' + id).val(qtyupdate);
                PosnicPro.sales.quantity.retrunlineItemCalculation(id, qtyupdate);
                $('#touch_row_return_' + id).remove();
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                return false;
            } else {
                var total_qty = available_quantity - ItemQty;
                $('#touchsale_item_return_qty' + id).val(total_qty);
                $('#returndecreSales_' + id).text(ItemQty);

            }
            PosnicPro.sales.returnitemSalesLineTable = $('#sales_return_items_table tbody tr').map(function () {
                var itemid = $(this).find(':nth-child(11)').text();
                return {
                    totalPrice: $('#returnSalesLineTotal_' + itemid).text()
                };
            }).get();
            var returnLineTotalSum = 0;
            for (var i = 0; i < PosnicPro.sales.returnitemSalesLineTable.length; i++) {
                returnLineTotalSum += parseFloat(PosnicPro.sales.returnitemSalesLineTable[i].totalPrice);
            }

            if (returnLineTotalSum === 0) {
                $("#save_submit,#check_button").attr("disabled", true);
                $('#sales_return_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="9"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_empty_return">Return Items Order Empty</lang></p></div></td></tr>');
            } else {
                $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
                $("#save_submit,#check_button").removeAttr("disabled");
            }

            PosnicPro.sales.quantity.retrunlineItemCalculation(id, ItemQty);

        }
    },
    retrunlineItemCalculation: function (id, total_qty) {
        $('#RoundOff').html('');
        var item_quantity = $('#touchsale_item_return_qty' + id).val();
        var updatePrice = parseFloat($('#addSalesLineItemSellingPrice_' + id).text()) * item_quantity;
        var PriceDiscount = parseFloat($('#addSalesLineItemDiscount_' + id).text()) * item_quantity;
        var updateReturnPrice = parseFloat($('#addSalesLineItemSellingPrice_' + id).text()) * total_qty;
        var discount = $('#addSalesLinediscountval_' + id).text();
        var discountSign = $('#discountSign' + id).text();
        var sellingPrice = parseFloat($('#addSalesLineItemSellingPrice_' + id).text());
        var updateSalesLineTotal;
        var updateReturnSalesLineTotal;
        if (item_quantity > 0) {
            updateSalesLineTotal = PosnicPro.sales.lineTotals(sellingPrice, item_quantity, discount, discountSign === '%').total;
            updateReturnSalesLineTotal = PosnicPro.sales.lineTotals(sellingPrice, total_qty, discount, discountSign === '%').total;
        } else {
            var salesQuantityValue = $('#returnItemChangeQuantityValue_' + id).text();
            var returnLineMath;
            if (parseFloat(salesQuantityValue) === parseFloat(total_qty)) {
                $('#touch_row_' + id).hide();
                returnLineMath = PosnicPro.sales.lineTotals(
                    $('#addSalesLineItemPrice_' + id).text(),
                    total_qty,
                    $('#addSalesLineItemDiscount_' + id).text(),
                    discountSign === '%'
                );
            } else {
                returnLineMath = PosnicPro.sales.lineTotals(
                    $('#returnSalesLineItemPrice_' + id).text(),
                    total_qty,
                    $('#returnSalesLineItemDiscount_' + id).text(),
                    discountSign === '%'
                );
            }
            updateReturnSalesLineTotal = returnLineMath.total;
        }

        updateSalesLineTotal = Number(updateSalesLineTotal).toFixed(2);
        $('#addSalesLineTotal_' + id).text(updateSalesLineTotal);
        updateReturnSalesLineTotal = Number(updateReturnSalesLineTotal).toFixed(2);
        $('#returnTotal_' + id).text(updateReturnSalesLineTotal);
        PosnicPro.sales.quantity.returnSaleLineItem(id);
        PosnicPro.sales.addLineTable = $('#sales_return_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(11)').text();
            return {
                return_total: $('#returnSalesLineTotal_' + itemid).text(),
                subtotalamount: $('#returnSalesLineItemPrice_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text(),
                discountamount: $('#returnSalesDiscount_' + itemid).text() * $('#returnSalesLineItemQty_' + itemid).text()
            };
        }).get();
        var addSalesSubTotal = 0;
        var addSalesGrandTotal = 0;
        var addSaleLineDiscountTotal = 0;
        for (var i = 0; i < PosnicPro.sales.addLineTable.length; i++) {
            addSalesSubTotal += parseFloat(PosnicPro.sales.addLineTable[i].subtotalamount);
            addSalesGrandTotal += parseFloat(PosnicPro.sales.addLineTable[i].return_total);
            addSaleLineDiscountTotal += parseFloat(PosnicPro.sales.addLineTable[i].discountamount);
        }
        addSalesSubTotal = Number(addSalesSubTotal).toFixed(2);
        $('#refund_subtotal').number(addSalesSubTotal, 2);
        PosnicPro.sales.calculation.returnDiscoundCalculation(addSalesGrandTotal);
        $('.sales_discount_return_value').number(addSaleLineDiscountTotal, 2);

        PosnicPro.sales.return_remove = 'increment';

        if (total_qty === 0) {
            $('#touch_row_return_' + id).hide();
        }

        var rightTableCount = PosnicPro.sales.addLineTable = $('#sales_return_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(11)').text();
            return {
                count: $('#returnSalesLineItemQty_' + itemid).text()
            };
        }).get();
        var removeRightcount = 0;
        for (var i = 0; i < rightTableCount.length; i++) {
            removeRightcount += parseFloat(rightTableCount[i].count);
        }
        if (removeRightcount === 0) {
            $('#sales_return_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="9"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_empty_return">Return Items Order Empty</lang></p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
            var imgHeight = $(window).height() - 500;
            $('.sales-cart-image').height(imgHeight);
        }

        var leftTableCount = PosnicPro.sales.addLineTable = $('#sales_new_items_table tbody tr').map(function () {
            var itemid = $(this).find(':nth-child(9)').text();
            return {
                count: $('#touchsale_item_return_qty' + itemid).val()
            };
        }).get();
        var removecount = 0;
        for (var i = 0; i < leftTableCount.length; i++) {
            removecount += parseFloat(leftTableCount[i].count);
        }
        if (removecount === 0) {
            $('#sales_new_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="8"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_sale_empty">Sale Order Empty</lang> </p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
            var imgHeight = $(window).height() - 500;
            $('.sales-cart-image').height(imgHeight);
            $("#save_submit").removeClass("disabled");
            $("#return_button").attr("disabled", true);
            $('#check_button').removeAttr("disabled");
        }

    },

    // return +/- quantity calculations
    qtyreturnDecrease: function (id, action) {
        var oldValue = $('#touchsale_item_return_qty' + id).val();
        var addSalesLineItemUnit = $('#addSalesLineItemUnit_' + id).text();
        $('#returnSalesLineItemUnit_' + id).text(addSalesLineItemUnit);
        var value;
        var sale_qty;
        if (action === 0) {
            PosnicPro.sales.return_remove = 'increment';
            $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
            $("#save_submit,#check_button").removeAttr("disabled");

            var checkValue = (parseFloat(oldValue));
            sale_qty = (Number.isInteger(checkValue) === false) ? parseFloat(oldValue) - 0.01 : parseFloat(oldValue) - 1;
            sale_qty = (Number.isInteger(value) === false) ? sale_qty.toFixed(2) : sale_qty;

            var return_mode = ($('#returnItemChangeQuantityValue_' + id).text() !== '') ? $('#returnItemChangeQuantityValue_' + id).text() : 0;
            var total_qty = return_mode - sale_qty;
            total_qty = (Number.isInteger(total_qty) === false) ? total_qty.toFixed(2) : total_qty.toFixed(2);
            $('#returndecreSales_' + id).text(total_qty);

            $('#touchsale_item_return_qty' + id).val(sale_qty);
            $('#returnitemQuantity_' + id).text(sale_qty);
            var decrementValue = $('#returnSalesIncreaseDecrease_' + id).text();
            var totalDecrementQuantity = parseFloat(decrementValue) + parseFloat(sale_qty);
            $('#returnSalesIncreaseDecrease_' + id).text(totalDecrementQuantity);
        } else {
            $("#save_submit,#check_button").removeAttr("disabled");
            var checkValue = (parseFloat(oldValue));
            value = (Number.isInteger(checkValue) === false) ? parseFloat(oldValue) + 0.01 : parseFloat(oldValue) + 1;
            value = (Number.isInteger(value) === false) ? value.toFixed(2) : value.toFixed(2);
            var return_mode = ($('#returnItemChangeQuantityValue_' + id).text() !== '') ? $('#returnItemChangeQuantityValue_' + id).text() : 0;
            var total_qty = return_mode - value;
            total_qty = (Number.isInteger(total_qty) === false) ? total_qty.toFixed(2) : total_qty;
            if (parseFloat(return_mode) < parseFloat(value)) {
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_no_items_are_in_stock', 'No items are in stock.'));
                $('#touchsale_item_qty' + id).val(return_mode);
                return false;
            }
            $('#returndecreSales_' + id).text(total_qty);
            var incrementValue = $('#returnSalesIncreaseDecrease_' + id).text();
            var sale_plus_qty = 1;
            var totalIncrementQuantity = parseInt(incrementValue) - parseInt(sale_plus_qty);
            $('#returnSalesIncreaseDecrease_' + id).text(totalIncrementQuantity);
            $('#touchsale_item_return_qty' + id).val(value);
            $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
            if ($('#returnSalesLineItemQty_' + id).text() === "1") {
                $('#returnTotal_' + id).text('0');
            }
        }
        PosnicPro.sales.quantity.retrunlineItemCalculation(id, total_qty);
        if (PosnicPro.sales.EditRecentSaleParams.payment_pending > 0) {
            $('#check_button').attr('disabled', true);
        } else {
            $('#check_button').attr('disabled', false);
        }
    }
};
/**********  END SALES QUANTITY FUNCTION *********/

/**********  START - SALES CALCULATION FUNCTION *********/

/*
 * Document-level charges on a sale (owner spec): parcel / service /
 * delivery fees, named, after the item math. Toggle-gated for NEW sales;
 * a sale that already carries charges (or one born from a quote) is
 * always manageable - features never lock existing data.
 */
/*
 * Inline cell editing on the cart (owner spec): double-click Price or Disc;
 * Enter or focus-out asks ONE clear question - only this sale, or update the
 * item record too. Price rides the price_override rail, discounts ride
 * discount_apply, and "update item" needs item write on the server as well.
 */
/*
 * Whole-line editor (owner ask): the pencil on each cart row opens ONE
 * popup with price, qty and discount together - one approval, one
 * save, instead of three double-click edits when a queue is waiting.
 * Same rails the per-cell editor used: the sale_quick_edit toggle, the ACL perms with
 * a manager-PIN fallback, and items/quickPatch when the item record
 * should learn the change. JS-built and body-appended, the only modal
 * pattern that has never broken here.
 */
PosnicPro.sales.lineEdit = {
    _id: null,
    open: function (itemId) {
        if (PosnicPro.local.get('sale_quick_edit') === 'disable') { return; }
        var go = function (approval) {
            PosnicPro.sales.lineEdit._priceApprovalToken = approval && approval.approval_token;
            PosnicPro.sales.lineEdit._show(itemId);
        };
        if (PosnicPro.posCan && !(PosnicPro.posCan('price_override') && PosnicPro.posCan('discount_apply'))) {
            PosnicPro.requireManagerApproval('price_override',
                { prompt: 'Editing a line needs a manager\'s approval.' }, go);
            return;
        }
        go();
    },
    _show: function (id) {
        PosnicPro.sales.lineEdit._id = id;
        if (!$('#sale_line_edit').length) {
            $('body').append(
                '<div class="modal fade" id="sale_line_edit" tabindex="-1" role="dialog" aria-hidden="true">'
                + '<div class="modal-dialog modal-dialog-centered" role="document"><div class="modal-content">'
                /*
                 * No inline colours here. The theme paints .modal-header with
                 * the primary colour and sets a CONTRASTING title and close to
                 * match - but an inline style carrying !important beats even
                 * that, which is exactly how this dialog ended up with black
                 * text on a blue bar. Let the theme do its job.
                 */
                + '<div class="modal-header"><h5 class="modal-title" id="sale_line_edit_name"><lang class="lang_edit_line">Edit line</lang></h5>'
                + '<button type="button" class="close" data-dismiss="modal" aria-label="Close" data-t-aria-label="lang_close_title"><span aria-hidden="true">&times;</span></button></div>'
                + '<div class="modal-body pb-2">'
                + '<div class="form-row">'
                + '<div class="form-group col-6"><label class="le-label" id="le_price_label"><lang class="lang_price_title">Price</lang></label><input type="number" min="0" step="any" class="form-control text-right" id="le_price"></div>'
                + '<div class="form-group col-6"><label class="le-label"><lang class="lang_quantity">Quantity</lang></label><input type="number" min="0" step="any" class="form-control text-right" id="le_qty"></div>'
                + '<div class="form-group col-6"><label class="le-label"><lang class="lang_discount_title">Discount</lang></label>'
                + '<div class="input-group"><div class="input-group-prepend"><button type="button" class="btn btn-outline-secondary" id="le_disc_mode" title="Tap to switch amount / percent" data-t-title="lang_tap_to_switch_amount_percent">%</button></div>'
                + '<input type="number" min="0" step="any" class="form-control text-right" id="le_disc"></div></div>'
                + '</div>'
                + '<small class="text-muted">"Sale + update item" also writes the change back to the item record for every future sale.</small>'
                + '</div>'
                + '<div class="modal-footer py-2 d-flex" style="gap:6px;">'
                + '<button type="button" class="btn btn-primary flex-fill" id="le_save_sale"><lang class="lang_only_this_sale">Only this sale</lang></button>'
                + '<button type="button" class="btn btn-outline-primary flex-fill" id="le_save_both">Sale + update item</button>'
                + '</div></div></div></div>');
            $(document).on('click', '#le_disc_mode', function () {
                var pct = $(this).data('pct') !== true;
                $(this).data('pct', pct).text(pct ? '%' : (PosnicPro.local.get('currencySign') || '$'));
            });
            $(document).on('click', '#le_save_sale', function () { PosnicPro.sales.lineEdit._save(false); });
            $(document).on('click', '#le_save_both', function () { PosnicPro.sales.lineEdit._save(true); });
            $(document).on('keydown', '#sale_line_edit input', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); PosnicPro.sales.lineEdit._save(false); }
            });
        }
        $('#le_save_both').toggle(PosnicPro.sales.lineEdit.canUpdateItem(id));
        $('#sale_line_edit_name').text($('#addSalesLineItemName_' + id).data('id') || 'Edit line');
        $('#le_price_label').text(PosnicPro.i18n.t('lang_price_title', 'Price'));
        var entryPrice = parseFloat($('#addSalesLineItemSellingPrice_' + id).text()) || 0;
        $('#le_price').val(Number(entryPrice.toFixed(2)));
        $('#le_qty').val(parseFloat($('#touchsale_item_qty' + id).val()) || 1);
        var isPct = $('#discountSign' + id).text() === '%';
        $('#le_disc').val(parseFloat($('#addSalesLineItemDiscount_' + id).text()) || 0);
        $('#le_disc_mode').data('pct', isPct).text(isPct ? '%' : (PosnicPro.local.get('currencySign') || '$'));
        $('#sale_line_edit').modal('show');
        setTimeout(function () { $('#le_price').focus().select(); }, 350);
    },
    canUpdateItem: function (id) {
        var line = PosnicPro.sales.SaleTableLineItems[id];
        var conversion = line && line.unit_conversion;
        return !conversion || conversion.unit === conversion.base_unit;
    },
    _save: function (updateItem) {
        var id = PosnicPro.sales.lineEdit._id;
        if (!id || !$('#touch_row_' + id).length) { $('#sale_line_edit').modal('hide'); return; }
        updateItem = updateItem && PosnicPro.sales.lineEdit.canUpdateItem(id);
        $('#sale_line_edit').modal('hide');
        var patch = { id: $('#addSalesLineItemId_' + id).attr('data-product-id') || $('#addSalesLineItemId_' + id).text() || id };
        var np = parseFloat($('#le_price').val());
        var nq = parseFloat($('#le_qty').val());
        var nd = parseFloat($('#le_disc').val());
        var pct = $('#le_disc_mode').data('pct') === true;
        var curPrice = parseFloat($('#addSalesLineItemSellingPrice_' + id).text()) || 0;
        var curDisc = parseFloat($('#addSalesLineItemDiscount_' + id).text()) || 0;
        var curPct = $('#discountSign' + id).text() === '%';
        if (isFinite(np) && np >= 0 && np !== curPrice) {
            $('#saleInlineItemPrice_' + id).text(String(np));
            $('#addSalesLineItemPrice_' + id).text(String(np));
            $('#addSalesLineItemSellingPrice_' + id).text(String(np));
            patch.selling_price = np;
        }
        var priceNow = parseFloat($('#addSalesLineItemSellingPrice_' + id).text()) || 0;
        $('#addSalesLineItemPrice_' + id).text(priceNow.toFixed(2));
        $('#addSalesLineItemSubTotal_' + id).text(priceNow.toFixed(2));
        if (isFinite(nd) && nd >= 0 && (nd !== curDisc || pct !== curPct)) {
            if (pct) {
                $('#addSalesLineItemDiscount_' + id).html(nd + '<span id="discountSign' + id + '">%</span>');
                $('#addSalesLineDiscountPercentage_' + id).text(nd);
                $('#addSalesLineDiscountAmount_' + id).text(0);
                $('#addSalesLineItemDiscountprint_' + id).text(nd + '%');
                patch.discount_percentage = nd;
            } else {
                $('#addSalesLineItemDiscount_' + id).html(nd.toFixed(2) + '<span id="discountSign' + id + '">' + (PosnicPro.local.get('currencySign') || '') + '</span>');
                $('#addSalesLineDiscountAmount_' + id).text(nd.toFixed(2));
                $('#addSalesLineDiscountPercentage_' + id).text(0);
                $('#addSalesLineItemDiscountprint_' + id).text(nd.toFixed(2));
                patch.discount_amount = nd;
            }
        }
        // quantity flows through its own input so every listener runs
        if (isFinite(nq) && nq > 0 && nq !== (parseFloat($('#touchsale_item_qty' + id).val()) || 0)) {
            $('#touchsale_item_qty' + id).val(nq).trigger('change');
        }
        PosnicPro.sales.commonInlineCalculation(id);
        if (updateItem && Object.keys(patch).length > 1) {
            PosnicPro.post({ url: 'items/quickPatch', data: JSON.stringify(patch) }, function (r) {
                PosnicPro.alert(r.type, r.type === 'success' ? 'Item record updated too' : r.message);
                if (PosnicPro.sales.itemCache) { PosnicPro.sales.itemCache.clear(); }
            }, function () { PosnicPro.alert('warning', PosnicPro.i18n.t('lang_sale_updated_the_item_record_could_not_be', 'Sale updated; the item record could not be')); });
        }
    }
};
$(document).on('click', '.sale-line-edit', function () {
    PosnicPro.sales.lineEdit.open(String($(this).data('id')));
});
// The row opens the same editor as the pencil; embedded controls keep their own action.
$(document).on('click keydown', 'tr[data-sale-edit]', function (event) {
    if ($(event.target).closest('a,button,input,select,textarea,label,[onclick],[contenteditable="true"],[role="button"]').length) return;
    if (event.type === 'keydown' && (event.target !== this || (event.key !== 'Enter' && event.key !== ' '))) return;
    if (PosnicPro.local.get('sale_quick_edit') === 'disable') return;
    event.preventDefault();
    PosnicPro.sales.lineEdit.open(String($(this).attr('data-sale-edit')));
});
/*
 * How long a sale has been parked, in the words a cashier would use.
 *
 * A bill held two minutes ago is a customer still at the counter; one held
 * yesterday is probably abandoned and worth clearing. Marking anything over
 * a day stale is what turns this column from a timestamp into a prompt.
 */
PosnicPro.sales.parkedAgo = function (value) {
    if (!value) { return { text: '-', exact: '', stale: false }; }
    var then = new Date(value);
    if (isNaN(then.getTime())) { return { text: '-', exact: '', stale: false }; }
    var mins = Math.floor((Date.now() - then.getTime()) / 60000);
    if (mins < 0) { mins = 0; }
    var text;
    if (mins < 1) { text = 'just now'; }
    else if (mins < 60) { text = mins + ' min ago'; }
    else if (mins < 60 * 24) {
        var hrs = Math.floor(mins / 60);
        text = hrs + ' ' + (hrs === 1 ? PosnicPro.i18n.t('lang_hour_ago', 'hour ago') : PosnicPro.i18n.t('lang_hours_ago', 'hours ago'));
    } else {
        var days = Math.floor(mins / (60 * 24));
        text = days + ' ' + (days === 1 ? PosnicPro.i18n.t('lang_day_ago', 'day ago') : PosnicPro.i18n.t('lang_days_ago', 'days ago'));
    }
    return { text: text, exact: then.toLocaleString(), stale: mins >= 60 * 24 };
};
PosnicPro.sales.charges = [];
PosnicPro.sales.chargesTotal = function () {
    var t = 0;
    (PosnicPro.sales.charges || []).forEach(function (c) { t += Number(c.amount) || 0; });
    return Math.round(t * 100) / 100;
};
PosnicPro.sales.chargesEnabled = function () {
    try {
        var gs = JSON.parse(PosnicPro.local.get('general_settings') || '{}');
        return gs.custom_charges_enable === true;
    } catch (e) { return false; }
};
PosnicPro.sales.renderCharges = function () {
    /*
     * NOTHING in here may throw. This runs at the top of clear.cartItems,
     * before setDefaults - and an exception here aborts that chain, so the
     * walk-in customer is never filled and the sale dies on "Enter a
     * customer name".
     */
    var list = PosnicPro.sales.charges || [];
    var html = '';
    list.forEach(function (c, i) {
        html += '<div class="sale-charge-row"><span>' + $('<i>').text(c.name).html() + '</span>'
            + '<b>' + Number(c.amount).toFixed(2) + '</b>'
            + '<a href="javascript:void(0)" class="sale-charge-del text-danger" data-i="' + i + '">&times;</a></div>';
    });
    $('#sale_charges_list').html(html);
    $('#sale_add_charge').toggle(PosnicPro.sales.chargesEnabled() || list.length > 0);
    try {
        PosnicPro.sales.calculation.extraDiscoundCalculation();
    } catch (e) {
        /* first page load: totals state not built yet - the regular flow
           recalculates right after; breaking the clear chain here is what
           cost the walk-in default */
    }
};
$(document).on('click', '#sale_add_discount', function () {
    // one action: the user already said "add discount" - the editor opens
    // with the cursor in it. editable('show') skips the click gate, so the
    // same discount_apply rail runs here explicitly.
    var open = function () {
        $('.addDisc-hide-show').show();
        setTimeout(function () {
            try { $('#extraDisc').editable('show'); } catch (e) { $('#extraDisc').trigger('click'); }
            setTimeout(function () { $('.editable-input input').focus().select(); }, 120);
        }, 60);
    };
    if (PosnicPro.posCan && !PosnicPro.posCan('discount_apply')) {
        var local = function () { PosnicPro.requireManagerApproval('discount_apply',
            { prompt: "Applying a discount needs a manager's approval." }, open); };
        if (PosnicPro.businessApproval) PosnicPro.businessApproval.editOrLocal(open, local);
        else local();
        return;
    }
    open();
});
/*
 * Inline add-charge row (queue #7): the prompt() pair is gone. The entry
 * row is a SIBLING of the list - renderCharges rewrites the list's html
 * and must never eat a half-typed entry. One line, till-readable sizes.
 */
$(document).on('click', '#sale_add_charge', function () {
    var $entry = $('#sale_charge_entry');
    if (!$entry.length) {
        $entry = $(
            '<div id="sale_charge_entry" class="customer-display-hide">' +
            '<input type="text" class="form-control form-control-sm sc-name" maxlength="60" placeholder="Charge name (e.g. Parcel)" data-t-placeholder="lang_charge_name_e_g_parcel">' +
            '<input type="number" class="form-control form-control-sm sc-amt" min="0" step="any" placeholder="0.00">' +
            '<a href="javascript:void(0)" class="sc-ok text-success" title="Add" data-t-title="lang_nav_add"><i class="feather icon-check"></i></a>' +
            '<a href="javascript:void(0)" class="sc-cancel text-danger" title="Cancel" data-t-title="lang_cancel_title">&times;</a>' +
            '</div>');
        $('#sale_charges_list').before($entry);
    }
    $entry.show().find('.sc-name').focus();
});
PosnicPro.sales.commitChargeEntry = function () {
    var name = $.trim($('#sale_charge_entry .sc-name').val() || '');
    var amt = parseFloat($('#sale_charge_entry .sc-amt').val());
    if (!name) { $('#sale_charge_entry .sc-name').focus(); return; }
    if (!isFinite(amt) || amt <= 0) { $('#sale_charge_entry .sc-amt').focus(); return; }
    PosnicPro.sales.charges.push({ name: name.slice(0, 60), amount: Math.round(amt * 100) / 100, source: 'manual' });
    $('#sale_charge_entry').hide().find('input').val('');
    PosnicPro.sales.renderCharges();
};
$(document).on('click', '#sale_charge_entry .sc-ok', function () {
    PosnicPro.sales.commitChargeEntry();
});
$(document).on('click', '#sale_charge_entry .sc-cancel', function () {
    $('#sale_charge_entry').hide().find('input').val('');
});
$(document).on('keydown', '#sale_charge_entry input', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); PosnicPro.sales.commitChargeEntry(); }
    if (e.key === 'Escape') { $('#sale_charge_entry').hide().find('input').val(''); }
});
$(document).on('click', '.sale-charge-del', function () {
    PosnicPro.sales.charges.splice($(this).data('i'), 1);
    PosnicPro.sales.renderCharges();
});
PosnicPro.sales.calculation = {
    /*
     * ADD SALES LINE ITEMS TABLE ROW CALCULATION
     */
    salesTableRowCart: function () {
        $('#RoundOff').html('');
        PosnicPro.sales.addLineTable = $('#sales_new_items_table tbody tr').map(function () {
            let itemid = $(this).find(':nth-child(9)').text();
            $('#sales_new_total_amount').val($('#addSalesLineTotal_' + itemid).text());
            var lineMath = PosnicPro.sales.readLineTotals(itemid);
            if (PosnicPro.sales.paymentOnlyMode !== true) {
                $('#addSalesLineTotal_' + itemid).text((Math.round(lineMath.total * 100) / 100).toFixed(2));
                $('#addSalesDiscount_' + itemid).text(lineMath.discount);
            }
            return {
                item_id: $('#addSalesLineItemId_' + itemid).attr('data-product-id') || $('#addSalesLineItemId_' + itemid).text(),
                    line_id: $('#addSalesLineItemId_' + itemid).attr('data-line-id') || undefined,
                item_price: $('#addSalesLineItemPrice_' + itemid).text(),
                item_unit: $('#addSalesLineItemUnit_' + itemid).text(),
                item_quantity: $('#touchsale_item_qty' + itemid).val(),
                CompanyPrice: $('#addSalesLineItemCompanyPrice_' + itemid).text(),
                Discount: $('#addSalesLineItemDiscount_' + itemid).text(),
                // Payment reloads must sum full-precision line values, as the API does.
                // Visible cells are rounded for display and can lose a paisa per line.
                Totalamount: PosnicPro.sales.paymentOnlyMode === true
                    ? $('#returnLineTotal_' + itemid).text()
                    : lineMath.total,
                subtotalamount: lineMath.subtotal,
                discountamount: lineMath.discount
            };
        }).get();
        var addSalesCompanyPrice = 0;
        var cartQuantity = PosnicPro.sales.addLineTable.reduce(function (sum, row) {
            var quantity = Number(row.item_quantity);
            return sum + (Number.isFinite(quantity) ? quantity : 0);
        }, 0);
        $('.sale-cart-quantity').text(Number(cartQuantity.toFixed(6)).toLocaleString(undefined, { maximumFractionDigits: 6 }));
        $('.sale-cart-lines').text(PosnicPro.sales.addLineTable.filter(function (row) { return !!row.item_id; }).length);
        var addSalesSubTotal = 0;
        var addSalesLineSubTotal = 0;
        var addReceivingLineDiscountTotal = 0;
        for (var i = 0; i < PosnicPro.sales.addLineTable.length; i++) {
            addSalesCompanyPrice += PosnicPro.sales.lineCompanyCostTotal(PosnicPro.sales.addLineTable[i]);
            addSalesSubTotal += parseFloat(PosnicPro.sales.addLineTable[i].Totalamount) || 0;
            addSalesLineSubTotal += parseFloat(PosnicPro.sales.addLineTable[i].subtotalamount) || 0;
            addReceivingLineDiscountTotal += parseFloat(PosnicPro.sales.addLineTable[i].discountamount) || 0;
        }
        //addSalesSubTotal = Number(addSalesSubTotal).toFixed(2);
        $('#sales_new_subtotal').number(addSalesLineSubTotal, 2);
        $("#sales_total_company_price").val(addSalesCompanyPrice.toFixed(2));
        $("#discount_sale_amount").number(addReceivingLineDiscountTotal, 2);
        $('#sales_new_total_amount').val(addSalesSubTotal);
        $('#grand_total').val(addSalesSubTotal);
        var extraDiscInput = parseFloat($('#extraDisc').text()) || 0;
        var isPercent = !$('#percentIcon').hasClass('d-none');
        var extraDiscAmount = (extraDiscInput > 0) ? (isPercent ? addSalesSubTotal * (extraDiscInput / 100) : extraDiscInput) : 0;
        var grandTotal = addSalesSubTotal - extraDiscAmount;
        if (PosnicPro.roundoff === true && extraDiscAmount > 0) { grandTotal = Math.round(grandTotal); }
        var tenderRecord = [];
        var tenderData = { subtotal: addSalesLineSubTotal.toFixed(2), discount: addReceivingLineDiscountTotal.toFixed(2), total: addSalesSubTotal.toFixed(2) };
        if (extraDiscAmount > 0) {
            tenderData.extra_discount = extraDiscAmount.toFixed(2);
            tenderData.grand_total = grandTotal.toFixed(2);
        }
        tenderRecord.push(tenderData);
        db.customerDisplay.put({ id: '3', 'clear': 'yes', 'get': 'no', tender: tenderRecord });
        PosnicPro.sales.customerBalanceCheck();
        PosnicPro.sales.calculation.extraDiscoundCalculation();
    },
    extraDiscoundCalculation: function () {
        // Settings may arrive after the first cart render. Refresh the charge
        // action during recalculation instead of requiring a payment-panel visit.
        if (typeof PosnicPro.sales.chargesEnabled === 'function') {
            $('#sale_add_charge').toggle(PosnicPro.sales.chargesEnabled() || (PosnicPro.sales.charges || []).length > 0);
        }
        if (!$('#sales_new_items_table tbody tr[id^="touch_row_"]').length) {
            $('#grand_total').val('0');
        }
        let inputValue = parseFloat($('#extraDisc').text());
        inputValue = !isNaN(inputValue) ? parseFloat($('#extraDisc').text()) : 0;
        let grand_total = parseFloat($('#grand_total').val());
        let outputVal = grand_total - inputValue;
        if (!$('#percentIcon').hasClass('d-none')) {
            let discAmt = grand_total * (inputValue / 100);
            outputVal = grand_total - discAmt;
        }
        // after the extra discount, before round-off
        $('#return_discount').addClass('disc-solo');
        // named charges join the payable after discounts, before round-off
        var chargesSum = PosnicPro.sales.chargesTotal();
        if (chargesSum > 0) { outputVal = outputVal + chargesSum; }
        let roundOffValue = (PosnicPro.roundoff === true) ? Math.round(outputVal) - outputVal : 0.00;
        let sign = roundOffValue >= 0 ? '+' : '-';
        let roundOff = '';
        if (roundOffValue !== 0 && !isNaN(roundOffValue)) {
            $('.RoundOff-hide-show').show();
            roundOff = '<span>' + sign + '</span>' +
                '<span class="number">' + Math.abs(roundOffValue).toFixed(2) + '</span>';
        } else {
            $('.RoundOff-hide-show').hide();
        }
        $('#RoundOff').html(roundOff);
        outputVal = (PosnicPro.roundoff === true) ? Math.round(outputVal) : parseFloat(outputVal);
        outputVal = Math.round(outputVal * 100) / 100;
        $('#sales_new_grand_total').number(outputVal, 2);
        PosnicPro.sales.extraDiscount.sale_new_tot = outputVal;
        // Update customer display with extra discount
        var isPercent = !$('#percentIcon').hasClass('d-none');
        var extraDiscAmount = (inputValue > 0) ? (isPercent ? grand_total * (inputValue / 100) : inputValue) : 0;
        db.customerDisplay.get('3').then(function (data) {
            if (data && data.tender && data.tender.length > 0) {
                var tender = data.tender[0];
                if (extraDiscAmount > 0) {
                    tender.extra_discount = extraDiscAmount.toFixed(2);
                    tender.grand_total = outputVal.toFixed(2);
                } else {
                    delete tender.extra_discount;
                    delete tender.grand_total;
                }
                db.customerDisplay.put({ id: '3', 'clear': 'yes', 'get': 'no', tender: [tender] });
            }
        }).catch(function () {});
    },
    returnDiscoundCalculation: function (addSalesGrandTotal) {
        let sales_total = PosnicPro.sales.extraDiscount.sales_total;
        let sales_round_off = PosnicPro.sales.extraDiscount.sales_round_off;
        let sale_extra_discount = PosnicPro.sales.extraDiscount.sale_extra_discount;
        let extra_discount_type = PosnicPro.sales.extraDiscount.extra_discount_type;
        let extraDiscount = addSalesGrandTotal / sales_total * sale_extra_discount;
        let returnsalesgrandTotal = addSalesGrandTotal - extraDiscount;
        if (extra_discount_type === 'percent') {
            let discAmt = addSalesGrandTotal * (sale_extra_discount / 100);
            returnsalesgrandTotal = addSalesGrandTotal - discAmt;
            extraDiscount = sale_extra_discount;
        }
        extraDiscount = Number(extraDiscount).toFixed(2);
        let roundOffValue = (sales_round_off !== 0) ? Math.round(returnsalesgrandTotal) - returnsalesgrandTotal : 0.00;
        returnsalesgrandTotal = (sales_round_off !== 0) ? Math.round(returnsalesgrandTotal).toFixed(2) : Number(returnsalesgrandTotal).toFixed(2);
        $('#extraDisc').text(extraDiscount);
        $('#extraDisc').editable('setValue', extraDiscount);
        let sign = roundOffValue >= 0 ? '+' : '-';
        let roundOff = '';
        if (roundOffValue !== 0) {
            $('.RoundOff-hide-show').show();
            roundOff = '<span>' + sign + '</span>' +
                '<span class="number">' + Math.abs(roundOffValue).toFixed(2) + '</span>';
            $('#RoundOff').html(roundOff);
        } else {
            $('.RoundOff-hide-show').hide();
        }
        $('#refund_grand_total').number(returnsalesgrandTotal, 2);
    }
};

// Initialize fields for a brand new sale (/sales/new)
PosnicPro.sales.setSaleDefaults = function () {
    // A fresh sale carries no customer pricing.
    PosnicPro.sales._customerCategoryId = '';
    PosnicPro.sales._loadPriceLists();

    // Check if register is required and open before allowing sales.
    // ONLY when the module is on: a shop that disabled cash registers in
    // Settings > Modules sells the plain way, and nothing here may block it.
    var registerModuleOn = !!(PosnicPro.shiftWidget
        && PosnicPro.shiftWidget._setting('cash_register_enable', true));
    var branchHasNoRegisters = PosnicPro.local.get('branch_has_no_registers');
    // Local 'Open' state can outlive a restart or a resume on another till.
    // Verify ownership before checkout; never silently take over a device lock.
    if (registerModuleOn && branchHasNoRegisters !== 'true') {
        var branchId = PosnicPro.local.get('branch_id_set');
        var params = {
            url: 'branches/userRegisterBranchSelect',
            data: {id: branchId}
        };

        PosnicPro.get(params, function (response) {
            if (PosnicPro.local.get('branch_id_set') !== branchId) { return; }
            if (response.type === 'success') {
                if (PosnicPro.users.restoreRegisterSession(response.data)) {
                    // This device already holds the open session.
                } else if (response.data.register_data && response.data.register_data.length > 0) {
                    PosnicPro.users.fillRegisterSelect($('.choose_register_model'), response.data.register_data);
                    $('#salesRegisterModal').modal('show');

                    PosnicPro.alert('warning', PosnicPro.i18n.t('lang_select_a_register_before_creating_a_sale', 'Select a register before creating a sale.'));
                } else {
                    // No registers for this branch
                    PosnicPro.local.set('branch_has_no_registers', 'true');
                }
            }
        });
    }

    $('#sales_new_item_name').focus();
    /*
     * A sale is always billed to SOMEONE. With the default-customer setting
     * off this used to blank every field and stop there - so the chip said
     * "Walk-in" while no customer existed at all, and Pay answered "Enter a
     * customer name" on a shop that had chosen not to prefill one. The
     * fields are still cleared of the previous customer, but the branch's
     * own Walk-in is then resolved (the server finds or creates it), which
     * is exactly what the chip has been claiming all along.
     */
    if (PosnicPro.sales.updateCustomerChip) PosnicPro.sales.updateCustomerChip();

    PosnicPro.sales.sale_offlineadditems = [];
    PosnicPro.sales.editSaleAction = false;
    PosnicPro.sales.editSaleId = '';
    PosnicPro.sales.salesId = '';
    PosnicPro.sales.refundSaleAction = false;
    PosnicPro.sales.refundSaleId = '';
    PosnicPro.sales.EditRecentSaleParams = [];
    PosnicPro.sales.SaleAction = 'add';
    PosnicPro.sales.salesExchange = false;

    PosnicPro.sales.paymentOnlyMode = false;

    if (!$('#sales_new_items_table tbody tr[id^="touch_row_"]').length) {
        $('#sales_new_items_table tbody tr').remove();
        $('#sales_new_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="8"><div class="text-center text-dark"> <p class="table_cart_content"> <lang class="lang_sale_empty">Sale Order Empty</lang></p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
        var imgHeight = $(window).height() - 500;
        $('.sales-cart-image').height(imgHeight);
    }
};

PosnicPro.sales.setDefaults = function () {

    // Successful checkout calls this directly, without clear.cartItems.
    // A new customer's bill must not inherit the previous sale's charges.
    PosnicPro.sales.charges = [];
    $('#sale_charges_list').empty();
    $('#sale_charge_entry').remove();

    $('#discount_sale_amount').text('0.00');
    $('.sale-cart-quantity,.sale-cart-lines').text('0');
    $('.sale-customer-account').empty().hide();
    PosnicPro.sales._accountRequest = (PosnicPro.sales._accountRequest || 0) + 1;
    $('.sales_price_fields').text('0.00').val('0.00');

    // Reset extra discount value and icon state when starting from a clean
    // sale so that "Clear Sale" behaves like a brand new sale screen.
    $('#extraDisc').text(0);
    $('#extraDisc').editable('setValue', 0);
    $('#percentIcon').addClass('d-none');
    $('#rupeeIcon').removeClass('d-none');
    if (PosnicPro.sales && PosnicPro.sales.extraDiscount) {
        PosnicPro.sales.extraDiscount.sale_new_tot = 0;
    }
    $("#sales_return_items_table tbody tr").remove();
    $('#sales_return_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="9"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_empty_return">Return Items Order Empty</lang></p></div></td></tr>');
    $('#sales_description,#payment_description,#discount_description').text('').val('').hide();
    $('#sales_description,#payment_description,#discount_description').editable('setValue', null);
    $('#sales_new_radio_discountamount,#sales_new_radio_discountpercent').text('').val('');
    $('#sales_new_radio_discountamount').editable('setValue', '0');
    $('#sales_new_radio_discountpercent').editable('setValue', '0');
    if (PosnicPro.updateSaleNoteFlag) {
        PosnicPro.updateSaleNoteFlag('click_payment_description', 'feather icon-edit-1', '');
        PosnicPro.updateSaleNoteFlag('click_sales_description', 'feather icon-edit-1', '');
        // the discount note carries the same flag now, so it resets the same
        // way - a tint alone left last sale's note text sitting on screen
        PosnicPro.updateSaleNoteFlag('click_discount_description', 'feather icon-edit-1', '');
    }
    // the chips are rebuilt above, so the lock badges go back on after them
    if (PosnicPro.sales.markLockedActions) { PosnicPro.sales.markLockedActions(); }
    if (PosnicPro.sales.syncActionTooltips) { PosnicPro.sales.syncActionTooltips(); }
    if (PosnicPro.sales.defaultCustomer === true) {
        // second copy of the reset above - same rule: clear the previous
        // customer, then resolve the branch Walk-in so the sale is billable
        $('#sales_new_customer_id,#sales_new_customer_name,#sales_new_customer_address,#sales_new_customer_phone,#sales_new_customer_email,#sales_new_customer_state').val('');
        PosnicPro.defaultcustomerSet();
    }
    PosnicPro.sales.SaleTableLineItems = [];
    PosnicPro.sales.sale_offlineadditems = [];
    PosnicPro.sales.editSaleAction = false;
    PosnicPro.sales.editSaleId = '';
    PosnicPro.sales.salesId = '';
    PosnicPro.sales.refundSaleAction = false;
    PosnicPro.sales.refundSaleId = '';
    PosnicPro.sales.EditRecentSaleParams = [];
    PosnicPro.sales.SaleAction = 'add';
    PosnicPro.sales.salesExchange = false;
    $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
    $("#sales_new_items_table tbody tr").remove();
    $('#sales_new_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="8"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_sale_empty">Sale Order Empty</lang></p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
    var imgHeight = $(window).height() - 500;
    $('.sales-cart-image').height(imgHeight);
    db.customerDisplay.where("clear").equals("yes").delete();
    if (PosnicPro.local.get('balance_view') === 'true') {
        $('.salesBalanceAmount,#newsalespage').show();
        $('#sales_save_button,#tenderpage,.cancel-save-hide-show').hide();
        PosnicPro.sales.saleDoneTimer.start();
    } else {
        $('.salesBalanceAmount').hide();
        $('#sales_save_button').show();
    }
};

// Wrapper used by routes/settings to fully clear the current sale,
// reusing the shared setDefaults logic and optionally showing the
// "Sales cancelled" notification when isFalse is not explicitly false.
PosnicPro.sales.clear = PosnicPro.sales.clear || {};
PosnicPro.sales.clear.cartItems = function (isFalse) {
    PosnicPro.sales.resetIdempotencyKey();
    /*
     * setDefaults fills the walk-in customer, so NOTHING before it may
     * abort this function - a throw up here is exactly how the sale page
     * ended up demanding a customer name with walk-in already chosen.
     * The cosmetic resets are best-effort; the default is not.
     */
    try {
        PosnicPro.sales.charges = [];
        PosnicPro.sales.renderCharges();
        $('#sales_new_item_name').val('');
    } catch (e) {
        if (window.console) { console.error('[sale] cart reset partially failed:', e); }
    }
    PosnicPro.sales.setDefaults();
    PosnicPro.sales.SaleTableLineItems = [];
    PosnicPro.sales.customerViewDisplay();
    $('#sales_new_item_name').focus();
    $('#reset_modal').modal('hide');
    if (isFalse !== false) {
        PosnicPro.alert('success', PosnicPro.i18n.t('lang_sale_cancelled', 'Sale cancelled.'));
    }
};
/**** END CLEAR SALES FUNCTION ****/

/******** START ~ ADD SALES PAGE MENU ********/
/**** START SALES PRODUCT MENU *****/

/*
 * Item cache for the billing hot path (S1 feel-fast).
 *
 * Every tap on a product tile did a full GET items/:id before the line
 * appeared in the cart - the slowest moment of the fastest-repeated action
 * in the product. A rush hour is the same few items tapped over and over,
 * so a short cache turns everything after the first tap instant.
 *
 * 60 seconds, then re-fetched; cleared outright when a sale is saved,
 * edited or returned, because those change stock. Staleness within the
 * window is no worse than what already existed: stock moves between
 * add-to-cart and save regardless, and the server enforces stock at save.
 *
 * Serves a deep copy - addSalesLineItems and friends mutate what they are
 * given, and a second tap must not inherit the first tap's mutations.
 * Edit-mode stock checks deliberately bypass this and stay live.
 */
PosnicPro.sales.itemCache = {
    TTL_MS: 60 * 1000,
    _map: {},
    get: function (id, onData) {
        if ((PosnicPro.sales.hiddenProducts || []).includes(String(id))) { PosnicPro.alert('error', 'This product is hidden from sales. Refresh the catalogue or ask an authorised user to restore it.'); return; }
        var hit = PosnicPro.sales.itemCache._map[id];
        if (hit && (Date.now() - hit.at) < PosnicPro.sales.itemCache.TTL_MS) {
            onData(JSON.parse(hit.json));
            return;
        }
        PosnicPro.get('items/' + id, function (response) {
            if (response.type === 'success') {
                if (response.data.available_for_sale === false) { PosnicPro.alert('error', PosnicPro.i18n.t('lang_this_product_is_hidden_from_sales_your_bas', 'This product is hidden from sales. Your basket has not been changed.')); return; }
                PosnicPro.sales.itemCache._map[id] = { at: Date.now(), json: JSON.stringify(response.data) };
                onData(JSON.parse(JSON.stringify(response.data)));
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    clear: function () {
        PosnicPro.sales.itemCache._map = {};
        PosnicPro.sales._billingCatalogue = null;
        PosnicPro.sales._catalogueRefreshing = false;
        PosnicPro.sales._catalogueGeneration = (PosnicPro.sales._catalogueGeneration || 0) + 1;
    },
};

// Fetch only the requested shelf page. Search uses its own full-catalogue API.
PosnicPro.sales.loadSalesTilePage = function (offset, categoryId, done) {
    var generation = (PosnicPro.sales._catalogueGeneration || 0) + 1;
    PosnicPro.sales._catalogueGeneration = generation;
    PosnicPro.get({ url: 'items/onlineSalesItemsAjaxLists', data: {
        paginate: 'true', tile_page: 'true', limit: 48, offset: offset, category_id: categoryId || ''
    } }, function (response) {
        if (generation !== PosnicPro.sales._catalogueGeneration) return;
        if (!response || response.type !== 'success') { done(response || { type: 'error' }); return; }
        var data = response.data || {};
        done({ type: 'success', data: Array.isArray(data) ? data : data.items || [],
            nextOffset: Number.isInteger(data.next_offset) && data.next_offset > offset ? data.next_offset : null });
    }, function () {
        if (generation === PosnicPro.sales._catalogueGeneration) done({ type: 'error' });
    });
};

// Bound the live grid while retaining the complete catalogue for barcode/name search.
PosnicPro.sales.renderTilePages = function (container, tiles, remote) {
    var page = 0, size = 48;
    var grid = $('<div class="row sale-tile-grid"></div>').appendTo(container);
    var pager = $('<nav class="sale-tile-pages d-flex align-items-center justify-content-between py-3" aria-label="Product pages" data-t-aria-label="lang_product_pages"></nav>').appendTo(container);
    var previous = $('<button type="button" class="btn btn-outline-primary" style="min-height:48px"><lang class="lang_previous">Previous</lang></button>').appendTo(pager);
    var status = $('<span role="status" class="px-2 text-center"></span>').appendTo(pager);
    var next = $('<button type="button" class="btn btn-outline-primary" style="min-height:48px"><lang class="lang_next">Next</lang></button>').appendTo(pager);
    function draw() {
        PosnicPro.sales.itemsMenu.variantPop.close();
        grid.html(tiles.slice(page * size, (page + 1) * size).join(''));
        var hasPrevious = remote ? remote.offset > 0 : page > 0;
        var hasNext = remote ? remote.nextOffset !== null : (page + 1) * size < tiles.length;
        previous.prop('disabled', !hasPrevious).prop('hidden', !hasPrevious);
        next.prop('disabled', !hasNext).prop('hidden', !hasNext);
        status.text(remote ? (tiles.length ? (remote.offset + 1) + '–' + (remote.offset + tiles.length) : '0') : tiles.length ? (page * size + 1) + '–' + Math.min((page + 1) * size, tiles.length) + ' / ' + tiles.length : 'No items');
        pager.toggleClass('d-none', remote ? remote.offset === 0 && remote.nextOffset === null : tiles.length <= size);
        container.closest('#sales_new_productList,#sales_new_categoryList').scrollTop(0);
        PosnicPro.sales.itemsMenu.clickEffect();
    }
    previous.on('click', function () { if (remote) { previous.add(next).each(function () { $(this).data('was-disabled', this.disabled).prop('disabled', true); }); remote.load(Math.max(0, remote.offset - size)); return; } if (page > 0) { page--; draw(); } });
    next.on('click', function () { if (remote) { previous.add(next).each(function () { $(this).data('was-disabled', this.disabled).prop('disabled', true); }); remote.load(remote.nextOffset); return; } if ((page + 1) * size < tiles.length) { page++; draw(); } });
    draw();
};

PosnicPro.sales.categoryPicture = function (name, image) {
    if (image && !/(^|\/)category\.svg(?:[?#]|$)/i.test(image)) return image;
    var categoryIcons = {
        "a: miscellaneous": "shop",
        "a: pennies products": "coins",
        "a: £1 plus": "pound",
        "baby": "baby",
        "barbecue": "barbecue",
        "battery": "battery",
        "bedding": "bed",
        "bicycle": "bicycle",
        "birthday & party": "balloons",
        "body care": "care",
        "body lotion": "lotion",
        "body wear": "clothing",
        "candles": "candle",
        "car accessories": "car",
        "car stuff": "steering",
        "cigarettes": "cigarette",
        "confectionary": "sweet",
        "cosmetic": "cosmetics",
        "calor gas": "gas",
        "decoration": "decoration",
        "disposable cigarettes": "vape",
        "diy": "tools",
        "dog food": "dogfood",
        "door and furniture": "door",
        "drinks": "drink",
        "dylon": "dye",
        "e-liquid": "eliquid",
        "electricals": "plug",
        "facial wipes": "wipes",
        "first aid": "firstaid",
        "food": "groceries",
        "gardening": "garden",
        "glassware": "glass",
        "groceries": "food",
        "halloween": "halloween",
        "home fragrance": "fragrance",
        "household": "household",
        "insect killer": "insect",
        "home accessories": "cleaning",
        "household accessories": "cleaning",
        "medicine": "medicine",
        "pad locks": "padlock",
        "paint": "paint",
        "party": "party",
        "pest control": "pest",
        "pet food": "petfood",
        "pets": "paw",
        "phone accessories": "phone",
        "plastic boxes": "boxes",
        "plastic products": "plastic",
        "plumbing": "pipe",
        "rat & mouse killer": "mouse",
        "rizla": "papers",
        "rustins": "varnish",
        "smoking": "smoking",
        "stationery": "stationery",
        "sweets": "sweets",
        "taps": "tap",
        "tissue paper": "tissue",
        "toilet accessories": "toilet",
        "toiletries": "toiletries",
        "tooth brushes": "toothbrush",
        "toys": "toys",
        "travel supplies": "travel",
        "valuepack": "valuepack",
        "winter supplies": "winter",
        "xmas": "xmas"
};
    var categoryName = (name || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (categoryIcons[categoryName]) return "static/images/categories/" + categoryIcons[categoryName] + ".svg";
    var groups = [
        [/baby/i, 'baby'], [/barbecue|cook|disposable(?! cigarette)|household/i, 'household'],
        [/batter|electri|bulb/i, 'battery'], [/bed|linen/i, 'bed'], [/bicycle|bike/i, 'bicycle'],
        [/birthday|party|decora|christmas/i, 'party'], [/body(?! wear)|cosmetic|beauty|hair|lotion|toiletr/i, 'care'],
        [/wear|cloth|dylon|shoe/i, 'clothing'], [/candle/i, 'candle'], [/car|motor|auto/i, 'car'],
        [/cigarette|e-liquid|vape|tobacco/i, 'shop'], [/food|pet|dog|cat/i, 'food'],
        [/confection|sweet|chocol/i, 'sweet'], [/gas/i, 'gas'], [/diy|tool|door|furniture|hardware/i, 'tools'],
        [/drink|beverage/i, 'drink'], [/garden/i, 'garden'], [/clean|laundry/i, 'cleaning'],
        [/station|paper|office/i, 'stationery'], [/pennies|pound|£|products/i, 'tag']
    ];
    for (var i = 0; i < groups.length; i++) if (groups[i][0].test(name || '')) return 'static/images/categories/' + groups[i][1] + '.svg';
    return 'static/images/categories/shop.svg';
};

PosnicPro.sales.itemsMenu = {
    /*sales Product Display*/
    onlineProductList: function (categoryId, offset) {
        categoryId = typeof categoryId === "string" ? categoryId : "";
        offset = offset || 0;
        /* crash-hunt probe gate: skippable render */
        if (window.__posnicSkip === 'menu' || window.__posnicSkip === 'all') { return; }
        var loader = $(".loader-product");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        $('#sales_new_productList').show();
        $('#sales_new_categoryList').hide();
        PosnicPro.sales.loadSalesTilePage(offset, categoryId, function (response) {
            loader.find(".loadingSpinner:first").remove();
            if (response.type === 'success') {
                var getItemdata = response.data;
                /* The panel lives on <body>, so removing the grid does not take
                   it with it - a category change would otherwise leave a list
                   of sizes floating over a shelf that no longer contains them. */
                PosnicPro.sales.itemsMenu.variantPop.close();
                $('#item-lists').remove();
                $('#sales_new_productList').append(' <div class="col-md-12" id="item-lists">');
                if (categoryId) $('<button type="button" class="btn btn-outline-primary mb-3"><lang class="lang_categories">Categories</lang></button>').appendTo('#item-lists').on('click', PosnicPro.sales.categoryMenu.listCategories);
                var currency = PosnicPro.local.get('currencySign');
                /*
                 * Variant families (V1): members of a family collapse into
                 * ONE tile - "Shirt", not five unrelated "Shirt / ..."
                 * tiles - and the tile opens a picker. Only groups with 2+
                 * members present collapse; a lone member stands alone.
                 */
                var families = {};
                (getItemdata || []).forEach(function (it) {
                    var gid = it.variant_group_id;
                    if (gid) { (families[gid] = families[gid] || []).push(it); }
                });
                PosnicPro.sales.itemsMenu._families = families;
                var renderedGroups = {};
                if (getItemdata && getItemdata.length > 0) {
                    /*
                     * One wrapper, carrying the grid class. It used to open a div
                     * and then - on the first pass, the only time i % length is 0 -
                     * close it again and open a plain .row, leaving an EMPTY div
                     * behind and putting every tile in a container the grid rules
                     * did not match. That is why the tiles kept their old layout
                     * however often the CSS was corrected.
                     *
                     * The class must be here: Parked and Recent Sales render into
                     * #item-lists too, so the grid must not claim every child.
                     */
                    var tiles = [], app;
                    for (var i = 0; i < getItemdata.length; i++) {
                        var familyGid = getItemdata[i]['variant_group_id'];
                        var familyRows = familyGid && families[familyGid];
                        if (familyRows && familyRows.length > 1) {
                            if (renderedGroups[familyGid]) { continue; }
                            renderedGroups[familyGid] = true;
                            tiles.push(PosnicPro.sales.itemsMenu._familyTile(familyRows, currency));
                            continue;
                        }
                        var list_item_name = PosnicPro.itemName ? PosnicPro.itemName(getItemdata[i]) : (getItemdata[i].item_name || getItemdata[i].name);
                        // the name reaches two attributes and a text node; escape
                        // once. It used to be truncated at 30 chars in JS, which is
                        // why the two-line CSS clamp had nothing to wrap.
                        var _escName = $('<i>').text(list_item_name == null ? '' : list_item_name).html();
                        var pricing = PosnicBillingSearch.price(getItemdata[i]);
                        var price = pricing.price;
                        var image_path = (getItemdata[i]['image'] && getItemdata[i]['image'] !== "item.svg") ? getItemdata[i]['image'] : 'static/images/default/item.svg';
                        let items_expiry_date = getItemdata[i]['items_expiry_date'];
                        if (!PosnicBillingSearch.expired(items_expiry_date)) {
                            // Subtle, light-grey stock count on the card - only when the item
                            // tracks inventory. Fails safe (shows nothing) if the field is absent.
                            var _trackInv = getItemdata[i]['track_inventory'];
                            var _stockHtml = '';
                            if (_trackInv === true || _trackInv === 'true') {
                                var _aq = getItemdata[i]['available_quantity'];
                                _aq = (_aq === undefined || _aq === null || _aq === '') ? 0 : _aq;
                                _stockHtml = '<div class="text-center wsk-cp-stock">' + (Number(_aq) <= 0
                                    ? PosnicPro.i18n.t('lang_out_of_stock_2', 'Out of stock')
                                    : Number(_aq) + ' in stock') + '</div>';
                            }
                            /* Tile colour (Loyverse study L2): an item without a real
                               image but with a chosen colour renders a coloured tile
                               with its initial - an image always wins. */
                            /*
                             * The shipped placeholder is marked as one.
                             *
                             * It is a drawing of a gift box on transparency, not a
                             * photograph, and the photo plate exists to stop a
                             * white product shot glaring against a dark card. Framing
                             * the placeholder puts a big pale panel on a tile that has
                             * nothing to show - which is exactly the "background looks
                             * light or gray" report, four times over on one screen.
                             */
                            var _isPlaceholder = getItemdata[i]['image'] === 'item.svg';
                            var _tileHtml = '<div class="wsk-cp-img' + (_isPlaceholder ? ' wsk-cp-img-placeholder' : '') + '">'
                                + '<img loading="lazy" decoding="async" src="' + image_path + '" alt="Product" class="img-responsive" /></div>';
                            var _rt = PosnicPro.resolveTile(getItemdata[i]);
                            var _tileColor = _rt.color;
                            if (getItemdata[i]['image'] === 'item.svg' && _tileColor) {
                                var _initial = getItemdata[i]['plu_code']
                                    ? String(getItemdata[i]['plu_code'])
                                    : String(list_item_name || '?').trim().charAt(0).toUpperCase();
                                var _shapeCss = PosnicPro.tileShapeCss(_rt.shape || '', '8px');
                                // Same square slot the product image fills, but the shape
                                // sits centered at ~62% with breathing room - the default
                                // illustration has built-in whitespace, and the tile should
                                // read the same visual size (owner report).
                                _tileHtml = '<div class="wsk-cp-img"><div style="width:100%;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;">' +
                                    '<div style="width:62%;aspect-ratio:1/1;' + _shapeCss + 'background:' + _tileColor + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:34px;font-weight:700;">' + _initial + '</div>' +
                                    '</div></div>';
                            }
                            var product = '<div class="wsk-cp cbutton--effect-novak" id="' + getItemdata[i]['id'] + '" onclick="PosnicPro.sales.itemsMenu.addToLineItemsList(this.id)">' +
                                '<div class="wsk-cp-product">' +
                                '<div class="description-prod">' +
                                '<p data-searchval="' + _escName + '" data-toggle="tooltip" title="' + _escName + '">' + _escName + '</p>' +
                                '</div>' +
                                _tileHtml +
                                '<div class="wsk-cp-text mt-3">' +
                                '<div class="price-text-color">' +
                                '<div class="text-center"><span class="price">' + currency + '&nbsp;' + price.toFixed(2) + '</span></div>' +
                                '</div>' + _stockHtml +
                                '</div>' +
                                '</div>' +
                                '</div>';
                            tiles.push(product);
                            //app = app + '<a style="padding-right:5px;" href="javascript:void(0)" data-searchval="' + list_item_name + '" class="search-product" data-toggle="tooltip" title="' + list_item_name + " ( Available Stock : " + item_stock + ' )" id="' + getItemdata[i]['id'] + '" onclick="PosnicPro.sales.itemsMenu.addToLineItemsList(this.id)"><div class="product color01 flat-box waves-effect waves-block"><h3 id="proname">' + list_item_name.slice(0, 6) + '</h3><img loading="lazy" decoding="async" src=' + image_path + ' alt="no image found"><div class="product_two"><div class="mask"><p> </p><h4>' + currency + '<span class="number">' + getItemdata[i]['selling_price'] + ' </span></h4></div></div></div></a>&nbsp;';
                        }
                    }
                    PosnicPro.sales.renderTilePages($('#item-lists'), tiles, { offset: offset, nextOffset: response.nextOffset,
                        load: function (next) { PosnicPro.sales.itemsMenu.onlineProductList(categoryId, next); } });
                } else {
                    app = "<div class='row'></div><div class='row'></div><div class='text-center text-dark'><p><lang class='lang_there_are_no_items_available'>There are no items available ...!!!</lang></p><a href='#/items/new'>Add New Item</a></div>";
                    $('#item-lists').append(app);
                }
                $('span.number').number(true, 2);
                PosnicPro.sales.itemsMenu.clickEffect();
            } else {
                $('#item-lists .sale-tile-pages button').each(function () {
                    $(this).prop('disabled', $(this).data('was-disabled') === true);
                });
                PosnicPro.alert(response.type, response.message || PosnicPro.i18n.t('lang_could_not_load_items_try_again', 'Could not load items - try again.'));
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    /* One tile for the whole family: parent name, "from" price when the
       members differ, combined stock, a variant-count badge. */
    _familyTile: function (rows, currency) {
        var esc = function (s) {
            return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
            });
        };
        var parent = rows[0]['variant_parent_name']
            || String(rows[0]['name'] || '').split(' / ')[0];
        var prices = rows.map(function (r) { return Number(r.selling_price) || 0; });
        var minPrice = Math.min.apply(null, prices);
        var differ = Math.max.apply(null, prices) !== minPrice;
        var stock = 0;
        var tracked = false;
        rows.forEach(function (r) {
            if (r.track_inventory === true || r.track_inventory === 'true') {
                tracked = true;
                stock += Number(r.available_quantity) || 0;
            }
        });
        var image = (rows[0]['image'] !== 'item.svg')
            ? rows[0]['image'] : 'static/images/default/' + rows[0]['image'];
        /* Same as a single item: the shipped placeholder is a drawing, not a
           product shot, and it must not be framed like one. */
        var placeholderClass = rows[0]['image'] === 'item.svg' ? ' wsk-cp-img-placeholder' : '';
        var stockHtml = tracked
            ? '<div class="text-center wsk-cp-stock">' + stock + ' in stock</div>' : '';
        /*
         * The group id is on the tile as DATA, not only inside the onclick.
         * The hover path finds the tile first and has to ask it what family it
         * is - reading that back out of an onclick string would work until the
         * first name with an apostrophe in it.
         */
        return '<div class="wsk-cp wsk-variant cbutton--effect-novak" tabindex="0" ' +
            'data-variant-group="' + esc(rows[0]['variant_group_id']) + '" ' +
            'onclick="PosnicPro.sales.itemsMenu.openVariantPicker(\'' + esc(rows[0]['variant_group_id']) + '\', this)">' +
            '<div class="wsk-cp-product">' +
            '<div class="description-prod">' +
            '<p data-searchval="' + esc(parent) + '" data-toggle="tooltip" title="' + esc(parent) + '">' +
            esc(parent) +
            ' <span class="badge badge-light">' + rows.length + '</span></p>' +
            '</div>' +
            '<div class="wsk-cp-img' + placeholderClass + '"><img loading="lazy" decoding="async" src="' + esc(image) + '" alt="Product" class="img-responsive" /></div>' +
            '<div class="wsk-cp-text mt-3">' +
            '<div class="price-text-color">' +
            '<div class="text-center"><span class="price">' + (differ ? 'from ' : '') +
            currency + '&nbsp;' + minPrice.toFixed(2) + '</span></div>' +
            '</div>' + stockHtml +
            '</div>' +
            '</div>' +
            '</div>';
    },
    /*
     * ============================================================
     * THE VARIANT CHOOSER
     *
     * Owner: "when sales item choose variant choose it opens in center of the
     * page, move movement is bit taking time, better show near to item or
     * attached to item on hover might better. we can reduce the click. make
     * sure we handled for touch screen users too."
     *
     * It was a Bootstrap modal: a backdrop, a fade, and a panel in the middle
     * of the screen. Three costs, and the third is the one that matters.
     *
     *   - The eye loses the tile. You tap "Shirt" in the top-left corner and
     *     the answer appears 400px away, with no line back to what you tapped.
     *   - The hand travels there and back for every single sale. Over a day at
     *     a counter that is the difference people describe as "slow".
     *   - It costs TWO actions where one would do: open, then choose. A mouse
     *     is already over the tile - it has said which family it wants just by
     *     being there.
     *
     * So the list now opens against the tile, and for a mouse it opens on
     * hover, which makes the whole interaction a single click on the size you
     * want. Nothing is added by hovering; hover only ever SHOWS.
     *
     * TOUCH IS NOT A MOUSE WITH A SLOW CURSOR
     *
     * A touch screen has no hover to read intent from, and browsers fake one:
     * a tap emits pointerover, mouseover and click at the same spot. Bound
     * naively, a till with a touch screen would open the list under the
     * finger and let the follow-up click land on whatever row happened to be
     * there - adding a random size to the sale. That is a bug a cashier can
     * only find at the counter, in front of a customer.
     *
     * Hence: hover opens ONLY for pointerType 'mouse'; touch opens on tap and
     * ignores row taps for a moment afterwards, so a synthesised click cannot
     * choose for somebody. Rows are 44px, which is a thumb, not a cursor.
     * ============================================================
     */
    variantPop: {
        /* Long enough that sweeping the mouse across a shelf of tiles does not
           strobe panels open; short enough that stopping on one feels instant. */
        OPEN_DELAY: 110,
        /* The grace to cross the gap from tile to panel. Without it the panel
           closes in the space between them and the list can never be reached. */
        CLOSE_DELAY: 220,
        /* A tap synthesises a click ~0-300ms later at the same coordinates.
           Rows refuse it for this long so the panel cannot choose for anybody. */
        TOUCH_GUARD: 350,

        _gid: null,
        _tile: null,
        _openTimer: null,
        _closeTimer: null,
        _openedAt: 0,
        _byTouch: false,
        _bound: false,

        isOpen: function () { return !!document.getElementById('variant_pop'); },

        /*
         * Is this family a MATRIX, and if so, what are its two axes?
         *
         * Owner: "hope you take care of if product had matrix variant. so we
         * might think like sub menu."
         *
         * A one-axis family is six sizes. A two-axis family is six sizes TIMES
         * five colours, and a flat list of thirty rows in a panel is not a
         * chooser - it is a wall. Worse, it is sorted by a compound string, so
         * "Red / L" sits between "Red / M" and "Red / S" and the sizes of one
         * colour are not even together.
         *
         * HOW A MATRIX IS RECOGNISED. The item form writes both axes into one
         * string - variant_axis is "Colour / Size" and variant_value is
         * "Red / L" - because the server treats variant_value as an opaque
         * unique key and a compound value needed nothing added to the model.
         * So the axes are recovered by splitting on the same separator.
         *
         * AND THE SEPARATOR IS LEGAL INSIDE A VALUE. A colour genuinely called
         * "Black / White" splits into three parts and the whole reading is
         * wrong - a shop would see sizes filed under colours that do not exist.
         * So this refuses unless EVERY value splits into exactly as many parts
         * as there are axes. When it refuses, the flat list is used, which is
         * what shipped before and is never wrong, only long. Degrading to
         * "correct but less clever" is the only safe direction here.
         */
        analyse: function (rows) {
            var flat = { matrix: false };
            if (!rows || rows.length < 2) { return flat; }

            var axisLabel = String(rows[0].variant_axis || '');
            var axes = axisLabel.split(' / ').map(function (a) { return a.trim(); });
            /* Two, exactly. One axis is already a plain list, and the form
               cannot produce three - so a three-part label is a value that ate
               its separator, not a third axis. */
            if (axes.length !== 2 || !axes[0] || !axes[1]) { return flat; }

            var groups = [];
            var index = {};
            for (var i = 0; i < rows.length; i++) {
                var value = String(rows[i].variant_value || '');
                var parts = value.split(' / ');
                if (parts.length !== 2) { return flat; }
                var first = parts[0].trim();
                var second = parts[1].trim();
                if (!first || !second) { return flat; }
                if (!index[first]) {
                    index[first] = { value: first, members: [] };
                    groups.push(index[first]);
                }
                index[first].members.push({ label: second, row: rows[i] });
            }
            /* A "matrix" with one column is a one-axis family that happens to
               carry a two-part label. Two columns of one thing each is more
               clicks than the flat list, not fewer. */
            if (groups.length < 2) { return flat; }
            return { matrix: true, axes: axes, groups: groups };
        },


        esc: function (s) {
            return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
            });
        },

        cancelTimers: function () {
            clearTimeout(PosnicPro.sales.itemsMenu.variantPop._openTimer);
            clearTimeout(PosnicPro.sales.itemsMenu.variantPop._closeTimer);
        },

        close: function () {
            var self = PosnicPro.sales.itemsMenu.variantPop;
            self.cancelTimers();
            var el = document.getElementById('variant_pop');
            if (el && el.parentNode) { el.parentNode.removeChild(el); }
            if (self._tile) { self._tile.classList.remove('wsk-variant-open'); }
            self._gid = null;
            self._tile = null;
            self._byTouch = false;
        },

        /*
         * Positioned against the tile in VIEWPORT coordinates, so it is immune
         * to whatever the grid's own scrolling and overflow rules are doing.
         * An absolutely-positioned panel inside the grid would be clipped by
         * the same overflow that makes the grid scroll.
         */
        place: function () {
            var self = PosnicPro.sales.itemsMenu.variantPop;
            var pop = document.getElementById('variant_pop');
            var tile = self._tile;
            if (!pop || !tile) { return; }

            var r = tile.getBoundingClientRect();
            var vw = window.innerWidth;
            var vh = window.innerHeight;
            var gap = 4;
            var edge = 8;

            /* Measured with no cap first: the cap depends on which side it
               ends up on, and that depends on how tall it wants to be. */
            pop.style.maxHeight = 'none';
            pop.style.minWidth = Math.max(190, Math.round(r.width)) + 'px';
            var want = pop.offsetHeight;

            var below = vh - r.bottom - gap - edge;
            var above = r.top - gap - edge;
            var useBelow = want <= below || below >= above;
            var room = Math.max(140, useBelow ? below : above);
            pop.style.maxHeight = room + 'px';

            var h = Math.min(want, room);
            pop.style.top = Math.round(useBelow ? r.bottom + gap : r.top - gap - h) + 'px';

            /* Left-aligned to the tile so the panel reads as belonging to it,
               then pulled back inside the window - a tile in the last column
               would otherwise hang the list off the right-hand edge. */
            var w = pop.offsetWidth;
            var left = r.left;
            if (left + w > vw - edge) { left = vw - edge - w; }
            if (left < edge) { left = edge; }
            pop.style.left = Math.round(left) + 'px';
        },

        /*
         * The leaf rows: the things that actually go on the sale.
         *
         * One axis or two, the bottom of the tree is always a real item with a
         * price, a stock figure and an id - so it is rendered in one place and
         * both paths use it. Two renderers would drift, and the way they would
         * drift is that one of them stops showing stock.
         */
        leafRows: function (leaves, currency) {
            var esc = PosnicPro.sales.itemsMenu.variantPop.esc;
            return leaves.map(function (leaf) {
                var r = leaf.row;
                var tracked = r.track_inventory === true || r.track_inventory === 'true';
                var qty = Number(r.available_quantity) || 0;
                /* Out of stock is shown, not hidden: a shop that sells the last
                   one still wants the row there, and a missing row reads as a
                   product that was never set up. */
                var stock = tracked
                    ? '<span class="vp-stock' + (qty <= 0 ? ' vp-stock-out' : '') + '">'
                      + (qty <= 0 ? 'none left' : qty + ' left') + '</span>'
                    : '';
                return '<button type="button" class="vp-row" data-item-id="' + esc(r.id) + '">'
                    + '<span class="vp-label">' + esc(leaf.label) + stock + '</span>'
                    + '<span class="vp-price">' + esc(currency) + '&nbsp;'
                    + (Number(r.selling_price) || 0).toFixed(2) + '</span>'
                    + '</button>';
            }).join('');
        },

        /*
         * The two-level chooser, DOCKED rather than flown out.
         *
         * The ask was for a sub-menu, and this is one - it is just attached to
         * its parent instead of hovering beside it, for three reasons that all
         * bite at a counter.
         *
         *   A flown-out submenu has to be positioned, flipped at the screen
         *   edge, and kept open while the pointer crosses the gap to it. That
         *   is the diagonal-travel problem every desktop menu has, and it is
         *   worse here because the panel is already anchored to a tile that may
         *   itself be in the last column.
         *
         *   On a touch screen there is no hover to fly out ON, so the whole
         *   mechanism would need a second, different interaction anyway - and
         *   this till is sold for touch screens.
         *
         *   Docked, both levels are visible at once. A mouse can go straight to
         *   the size it wants in one movement, because the sizes are already on
         *   screen; nothing has to be summoned first.
         *
         * The columns are DERIVED FROM THE ROWS, so a sparse matrix is handled
         * without knowing it is sparse: if Red was only ever stocked in S and M,
         * Red shows S and M. Listing every theoretical combination would offer
         * sizes that do not exist as items, and choosing one could only fail.
         */
        matrixHtml: function (shape, currency) {
            var self = PosnicPro.sales.itemsMenu.variantPop;
            var esc = self.esc;
            var first = shape.groups.map(function (g, i) {
                return '<button type="button" class="vp-axis' + (i === 0 ? ' is-active' : '') + '"'
                    + ' data-axis-value="' + esc(g.value) + '">'
                    + '<span>' + esc(g.value) + '</span>'
                    + '<span class="vp-axis-count">' + g.members.length + '</span>'
                    + '</button>';
            }).join('');

            return '<div class="vp-matrix">'
                + '<div class="vp-col vp-col-axis">'
                + '<div class="vp-col-head">' + esc(shape.axes[0]) + '</div>'
                + '<div class="vp-col-body">' + first + '</div>'
                + '</div>'
                + '<div class="vp-col vp-col-leaf">'
                + '<div class="vp-col-head">' + esc(shape.axes[1]) + '</div>'
                + '<div class="vp-col-body vp-list" id="vp_leaves">'
                + self.leafRows(shape.groups[0].members, currency)
                + '</div>'
                + '</div>'
                + '</div>';
        },

        /*
         * Move to another first-axis value.
         *
         * Deliberately NOT behind the touch guard that protects the leaf rows.
         * That guard exists because a tap on the tile synthesises a click a
         * moment later, and honouring it on a LEAF would add a random size to a
         * real sale. Choosing a colour adds nothing and can be undone by
         * choosing another, so guarding it would only mean the first tap after
         * opening does nothing - which reads as a dead panel.
         */
        selectAxis: function (value) {
            var self = PosnicPro.sales.itemsMenu.variantPop;
            var shape = self._shape;
            if (!shape || !shape.matrix) { return; }
            var group = null;
            shape.groups.forEach(function (g) { if (g.value === value) { group = g; } });
            if (!group) { return; }

            var body = document.getElementById('vp_leaves');
            if (body) {
                body.innerHTML = self.leafRows(group.members, PosnicPro.local.get('currencySign'));
            }
            var buttons = document.querySelectorAll('#variant_pop .vp-axis');
            for (var i = 0; i < buttons.length; i++) {
                buttons[i].classList.toggle('is-active',
                    buttons[i].getAttribute('data-axis-value') === value);
            }
            /* The panel changes height when one colour has more sizes than
               another, and it is positioned against a tile it must stay
               attached to. */
            self.place();
        },

        open: function (groupId, tile, byTouch) {
            var self = PosnicPro.sales.itemsMenu.variantPop;
            var rows = (PosnicPro.sales.itemsMenu._families || {})[groupId] || [];
            if (!rows.length || !tile) { return; }

            self.cancelTimers();
            if (self._gid === groupId && self.isOpen()) {
                /* Already showing this family. Re-tapping the tile must not
                   toggle it shut - somebody reaching for a size and clipping
                   the tile on the way would lose the list they were aiming at. */
                self.place();
                return;
            }
            self.close();
            self.bind();

            var esc = self.esc;
            var currency = PosnicPro.local.get('currencySign');
            var parent = rows[0]['variant_parent_name']
                || String(rows[0]['name'] || '').split(' / ')[0];

            var shape = PosnicPro.sales.itemsMenu.variantPop.analyse(rows);
            self._shape = shape;

            var el = document.createElement('div');
            el.id = 'variant_pop';
            el.className = 'variant-pop' + (shape.matrix ? ' variant-pop-matrix' : '');
            el.setAttribute('role', 'menu');
            el.setAttribute('aria-label', parent);
            el.innerHTML =
                '<div class="vp-head">' + esc(parent) +
                '<button type="button" class="vp-close" aria-label="Close" data-t-aria-label="lang_close_title">&times;</button></div>' +
                (shape.matrix
                    ? PosnicPro.sales.itemsMenu.variantPop.matrixHtml(shape, currency)
                    : '<div class="vp-list">'
                        + PosnicPro.sales.itemsMenu.variantPop.leafRows(
                            rows.map(function (r) {
                                return {
                                    label: r.variant_value
                                        || String(r.name || '').split(' / ').slice(1).join(' / ')
                                        || r.name,
                                    row: r
                                };
                            }), currency)
                        + '</div>');
            document.body.appendChild(el);

            self._gid = groupId;
            self._tile = tile;
            self._byTouch = byTouch === true;
            self._openedAt = Date.now();
            tile.classList.add('wsk-variant-open');
            self.place();
        },

        /*
         * One set of listeners for the life of the page, on document.
         *
         * Delegated rather than bound per tile because the grid is rebuilt
         * wholesale on every category change and search keystroke - per-tile
         * handlers would be re-attached hundreds of times a shift, and the old
         * tiles they were attached to are already gone.
         */
        bind: function () {
            var self = PosnicPro.sales.itemsMenu.variantPop;
            if (self._bound) { return; }
            self._bound = true;

            var tileOf = function (t) {
                return t && t.closest ? t.closest('.wsk-variant') : null;
            };
            var inPop = function (t) {
                return !!(t && t.closest && t.closest('#variant_pop'));
            };

            /*
             * pointerover, not mouseenter: mouseenter carries no pointerType,
             * and pointerType is the whole difference between a mouse saying
             * "show me this" and a touch screen faking one.
             */
            document.addEventListener('pointerover', function (e) {
                if (e.pointerType !== 'mouse') { return; }
                if (inPop(e.target)) {
                    self.cancelTimers();
                    /* Pointing at a colour shows its sizes, the way a menu
                       works - no click needed to look. Nothing is added by
                       pointing, here or anywhere else in this panel. */
                    var axis = e.target.closest ? e.target.closest('#variant_pop .vp-axis') : null;
                    if (axis) { self.selectAxis(axis.getAttribute('data-axis-value')); }
                    return;
                }

                var tile = tileOf(e.target);
                if (tile) {
                    var gid = tile.getAttribute('data-variant-group');
                    self.cancelTimers();
                    if (gid && gid === self._gid && self.isOpen()) { return; }
                    self._openTimer = setTimeout(function () {
                        self.open(gid, tile, false);
                    }, self.OPEN_DELAY);
                    return;
                }

                /* Off both. Scheduled rather than immediate, so the pointer can
                   cross the few pixels between tile and panel. */
                if (self.isOpen() || self._openTimer) {
                    clearTimeout(self._openTimer);
                    clearTimeout(self._closeTimer);
                    self._closeTimer = setTimeout(function () { self.close(); }, self.CLOSE_DELAY);
                }
            });

            document.addEventListener('click', function (e) {
                if (inPop(e.target)) { return; }
                if (tileOf(e.target)) { return; }   // the tile's own onclick opens it
                self.close();
            });

            /* The panel is placed in viewport coordinates, so anything that
               moves the tile relative to the viewport has to move it too.
               Capture, because scroll does not bubble. */
            var replace = function () { if (self.isOpen()) { self.place(); } };
            document.addEventListener('scroll', replace, true);
            window.addEventListener('resize', replace);

            document.addEventListener('keydown', function (e) {
                /* A focused tile is a div, and a div does not turn Enter into
                   a click the way a button does - without this the tiles are
                   reachable by Tab and do nothing when you get there. */
                if (e.key === 'Enter' || e.keyCode === 13) {
                    var tile = tileOf(e.target);
                    if (tile) {
                        e.preventDefault();
                        self.open(tile.getAttribute('data-variant-group'), tile, false);
                        var first = document.querySelector('#variant_pop .vp-row');
                        if (first) { first.focus(); }
                        return;
                    }
                }
                if (!self.isOpen()) { return; }
                if (e.key === 'Escape' || e.keyCode === 27) {
                    /* Held BEFORE closing: close() clears _tile, and reading it
                       afterwards focuses nothing at all. */
                    var from = self._tile;
                    self.close();
                    /* Focus goes back where it came from, or it lands on body
                       and the next Tab restarts from the top of the page. */
                    if (from && from.focus) { from.focus(); }
                }
            });

            /* Row selection, delegated for the same reason as the rest. */
            document.addEventListener('click', function (e) {
                var axis = e.target && e.target.closest
                    ? e.target.closest('#variant_pop .vp-axis') : null;
                if (axis) {
                    /* The only route on a touch screen, which has no hover to
                       read intent from. */
                    self.selectAxis(axis.getAttribute('data-axis-value'));
                    return;
                }
                var row = e.target && e.target.closest ? e.target.closest('#variant_pop .vp-row') : null;
                if (row) {
                    /* A tap on the tile synthesises a click here a moment
                       later. Honouring it would add whichever size the panel
                       happened to open under the finger. */
                    if (self._byTouch && Date.now() - self._openedAt < self.TOUCH_GUARD) { return; }
                    PosnicPro.sales.itemsMenu.pickVariant(row.getAttribute('data-item-id'));
                    return;
                }
                if (e.target && e.target.closest && e.target.closest('#variant_pop .vp-close')) {
                    self.close();
                }
            });
        }
    },

    /*
     * The tile's own handler. Reached by a tap, by a click, and by Enter on a
     * focused tile - every route that is not hover.
     */
    openVariantPicker: function (groupId, tile) {
        var self = PosnicPro.sales.itemsMenu.variantPop;
        self.bind();
        /* Only a real pointer event tells us which kind it was; window.event
           is gone by the time a keyboard Enter arrives, and treating that as
           touch would only make the guard slightly more cautious. */
        var ev = window.event;
        var byTouch = !!(ev && ev.pointerType && ev.pointerType !== 'mouse');
        if (!tile && ev && ev.target && ev.target.closest) {
            tile = ev.target.closest('.wsk-variant');
        }
        self.open(groupId, tile, byTouch);
    },

    pickVariant: function (item_id) {
        PosnicPro.sales.itemsMenu.variantPop.close();
        PosnicPro.sales.itemsMenu.addToLineItemsList(item_id);
    },
    addToLineItemsList: function (item_id) {
        PosnicPro.sales.itemCache.get(item_id, function (item) {
            // Browsing includes sold-out products; it must not authorize a sale.
            var tracked = item.track_inventory === true || item.track_inventory === 'true';
            var negative = item.negative_stock === true || item.negative_stock === 'true';
            if (PosnicPro.sales.SaleAction !== 'return' && item.item_kind !== 'service'
                && tracked && !negative && Number(item.available_quantity || 0) <= 0) {
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                return;
            }
            $("#save_submit").removeClass("disabled");
            let hash = window.location.hash.slice(1);
            if (hash === '/sales/new') {
                db.saleAutoFocus.get('1').then(function (data) {
                    if (data && data.addSale === true) {
                        $('#sales_new_item_name').focus();
                    } else {
                        $('#sales_new_item_name').blur();
                    }
                });
            }
            PosnicPro.sales.itemsMenu.clickEffect();
            PosnicPro.sales.addSalesLineItems(item);
        });
    },
    clickEffect: function () {

        var support = { animations: Modernizr.cssanimations },
            animEndEventNames = { 'WebkitAnimation': 'webkitAnimationEnd', 'OAnimation': 'oAnimationEnd', 'msAnimation': 'MSAnimationEnd', 'animation': 'animationend' },
            animEndEventName = animEndEventNames[Modernizr.prefixed('animation')],
            onEndAnimation = function (el, callback) {
                var onEndCallbackFn = function (ev) {
                    if (support.animations) {
                        if (ev.target != this)
                            return;
                        this.removeEventListener(animEndEventName, onEndCallbackFn);
                    }
                    if (callback && typeof callback === 'function') {
                        callback.call();
                    }
                };
                if (support.animations) {
                    el.addEventListener(animEndEventName, onEndCallbackFn);
                } else {
                    onEndCallbackFn();
                }
            },
            eventtype = PosnicPro.sales.itemsMenu.mobilecheck() ? 'touchstart' : 'click';

        [].slice.call(document.querySelectorAll('.wsk-cp')).forEach(function (el) {
            el.addEventListener(eventtype, function (ev) {
                classie.add(el, 'cbutton--click');
                onEndAnimation(classie.has(el, 'cbutton--complex') ? el.querySelector('.cbutton__helper') : el, function () {
                    classie.remove(el, 'cbutton--click');
                });
            });
        });
    },
    mobilecheck: function () {
        var check = false;
        (function (a) {
            if (/(android|ipad|playbook|silk|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i.test(a) || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0, 4)))
                check = true
        })(navigator.userAgent || navigator.vendor || window.opera);
        return check;
    }
};
/******** END SALES PRODUCT MENU ********/

/******** START SALES CATEGORY MENU vs CATEGORY'S ITEMS SUB MENU ********/
PosnicPro.sales.categoryMenu = {
    /* --------------------------
     * GET SALES CATEGORY TAGS (OLD FORMAT)
     * -------------------------- */
    listCategories: function () {
        PosnicPro.sales._catalogueGeneration = (PosnicPro.sales._catalogueGeneration || 0) + 1;
        var loader = $(".loader-category");
        $("<div class='loadingSpinner'></div>").appendTo(loader);

        $('#sales_new_productList').hide();
        $('#sales_new_categoryList').show();

        PosnicPro.get('categories/getCategoriesWithValidItems', function (response) {
            if (response.type === 'success') {
                loader.find(".loadingSpinner:first").remove();
                var categorydata = response.data;

                $('#item-lists').remove();
                $('#category-lists').remove();
                $('#sales_new_categoryList').append('<div class="col col-xs-12" id="category-lists">');

                if (categorydata.length > 0) {
                    /*
                     * ONE grid, no manual row breaks. sale-tile-grid is a CSS
                     * grid that wraps by itself; the old every-fourth-tile
                     * "</div><div class='row'>" split was a Bootstrap relic
                     * that dropped every tile after the fourth OUT of the
                     * grid into plain full-size columns - the owner's "why is
                     * the first row a different size" screenshot, exactly.
                     * The Items tab render above is the pattern.
                     */
                    var app = "<div class='row sale-tile-grid'>";
                    for (var i = 0; i < categorydata.length; i++) {

                        var list_category_name = categorydata[i]['category_name'];
                        var image_path = PosnicPro.sales.categoryPicture(list_category_name, categorydata[i]['category_img']);
                        list_category_name = $('<i>').text(list_category_name || '').html();
                        var _cat = PosnicPro.sales._catTiles[String(categorydata[i]['id'] || '')];

                        app += '<div class="wsk-cp cbutton--effect-novak col-lg-3 col-md-4 col-sm-6 col-12 mb-3" ' +
                            'id="' + categorydata[i]['id'] + '" ' +
                            'onclick="PosnicPro.sales.categoryMenu.listItems(this.id)">' +
                            '<div class="wsk-cp-product">' +
                            '<div class="description-prod">' +
                            '<p data-searchval="' + list_category_name + '">' + list_category_name + '</p>' +
                            '</div>' +
                            '<div class="wsk-cp-img">' +
                            '<img loading="lazy" decoding="async" src="' + image_path + '" alt="Category" class="img-responsive" />' +
                            '</div></div></div>';
                    }
                    app += "</div>";
                    $('#category-lists').append(app);
                } else {
                    $('#category-lists').append("<div class='text-center text-dark'><p><lang class='lang_no_categories_found_with_available_or_nega'>No categories found with available or negative-stock items.</lang></p></div>");
                }

                PosnicPro.sales.itemsMenu.clickEffect();

            } else {
                PosnicPro.alert(response.type, response.message);
            }

        }, 'json');
    },

    /* --------------------------
     * GET SALES CATEGORY PRODUCTS (OLD FORMAT)
     * -------------------------- */
    listItems: function (categoryId) {
        PosnicPro.sales.itemsMenu.onlineProductList(categoryId, 0);
    }
};
PosnicPro.sales.recentMenu = {
    /*Touchsale recent Sales details*/
    salesList: function () {
        PosnicPro.sales._catalogueGeneration = (PosnicPro.sales._catalogueGeneration || 0) + 1;
        var loader = $(".loader-product");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        $('#sales_new_productList').show();
        $('#sales_new_categoryList').hide();
        $('#item-lists').remove();
        $('#sales_new_productList').append(' <div id="item-lists" style="margin-left: 7px;"/>');
        $('#item-lists').append("<div id='recent_sales_list' class='m-b-30'></div>");
        PosnicPro.get('sales/getLatestSales', function (response) {
            if (response.type === 'success') {
                PosnicPro.sales.recentSaleAction = true;
                loader.find(".loadingSpinner:first").remove();
                var item_data = jQuery.parseJSON(response.data);
                var currency = PosnicPro.local.get('currencySign');
                var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
                var ago = function (d) {
                    if (!d) { return ''; }
                    var mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
                    if (mins < 1) { return 'just now'; }
                    if (mins < 60) { return mins + 'm ago'; }
                    if (mins < 1440) { return Math.round(mins / 60) + 'h ago'; }
                    return Math.round(mins / 1440) + 'd ago';
                };
                $('#recent_sales_list').html('');
                if (item_data.length > 0) {
                    var listHtml = '';
                    $(item_data).each(function (index, params) {
                        var id = params.sales_document_id;
                        var paymentStatus = params.payment_status || '';
                        var isPaid = (String(paymentStatus).toLowerCase() === 'paid');
                        var editIcon = isPaid
                            ? ''
                            : '<a data-module="sales" data-access="write" href="#/sales/' + id + '/edit" class="rs-act btn-success-rgba" data-toggle="tooltip" title="Edit" data-t-title="lang_edit_title"><i class="feather icon-edit-2"></i></a>';
                        var returnIcon = '<a data-module="sales" data-access="write" href="#/sales/' + id + '/return" class="rs-act btn-secondary-rgba" data-toggle="tooltip" title="Return" data-t-title="lang_return_title"><i class="feather icon-corner-up-left"></i></a>';
                        var deleteIcon = PosnicPro.local.get('usertype') !== 'super_admin' || PosnicPro.local.get('allow_sale_hard_delete') !== 'true'
                            ? ''
                            : '<a data-module="sales" data-access="delete" href="#/sales/' + id + '/delete" class="rs-act btn-danger-rgba" data-toggle="tooltip" title="Delete" data-t-title="lang_delete"><i class="feather icon-trash"></i></a>';
                        var isParked = (String(params.sale_process) === 'Hold');
                        var retrieveIcon = isParked
                            ? '<a data-module="sales" data-access="write" href="#/sales/' + id + '/hold" class="rs-act btn-success-rgba" data-toggle="tooltip" title="Retrieve parked sale" data-t-title="lang_retrieve_parked_sale"><i class="feather icon-play-circle"></i></a>'
                            : '';
                        if (isParked) { editIcon = ''; returnIcon = ''; }
                        var pill = isParked
                            ? '<span class="rs-pill hold"><lang class="lang_parked_title">Parked</lang></span>'
                            : isPaid
                                ? '<span class="rs-pill paid"><lang class="lang_paid">Paid</lang></span>'
                                : '<span class="rs-pill unpaid">' + esc(paymentStatus || 'Unpaid') + '</span>';
                        var when = '';
                        try { when = ago(PosnicPro.mongoIdToDate(id)); } catch (e) { /* no time, no label */ }
                        var meta = [esc(params.sales_id), params.number_of_items + ' item' + (params.number_of_items === 1 ? '' : 's')];
                        if (when) { meta.push(when); }
                        listHtml += '<div class="rs-row highlight-select" id="recent_sales_table_row_' + id + '">' +
                            '<div class="rs-main">' +
                            '<div class="rs-cust">' + esc(params.customer_name || 'Walk-in') + '</div>' +
                            '<div class="rs-meta">' + meta.join(' &middot; ') + '</div>' +
                            '</div>' +
                            '<div class="rs-side">' +
                            '<div class="rs-amt">' + currency + '&nbsp;' + Number(params.total_amount || 0).toFixed(2) + '</div>' + pill +
                            '</div>' +
                            '<div class="rs-actions">' +
                            '<a data-module="sales" data-access="read" href="javascript:void(0)" onclick="PosnicPro.sales.peekSale(\'' + id + '\'); return false;" class="rs-act btn-primary-rgba" data-toggle="tooltip" title="View" data-t-title="lang_view"><i class="feather icon-eye"></i></a>' +
                            retrieveIcon + editIcon + returnIcon + deleteIcon +
                            '</div></div>';
                    });
                    $('#recent_sales_list').html(listHtml);
                    PosnicPro.ACLForModule('sales');
                } else {
                    $('#recent_sales_list').html('<div class="text-center text-muted p-t-30 p-b-30"><lang class="lang_no_sales_yet_today_they_will_appear_here_a">No sales yet today - they will appear here as you bill.</lang></div>');
                }
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    editItems: function (id, data, sale) {
        PosnicPro.sales.defaultCustomer = false;
        PosnicPro.sales.setDefaults();

        // When opening a Sales Return from history (sale === 'return'),
        // always show the return item selection screen first and NEVER
        // reuse any previous payment-only tender mode. This prevents
        // flows like payment-only from causing the first Return
        // click in Sales History to jump directly to the tender page.
        if (sale === 'return') {
            PosnicPro.sales.paymentOnlyMode = false;
            PosnicPro.sales.originalSaleData = null;
        }

        var result = data;
        if (sale === 'edit') {
            var extra_discount = (typeof result.extra_discount !== 'undefined' && result.extra_discount !== null) ? result.extra_discount : 0;
            var extra_discount_type = result.extra_discount_type || 'price';
            $('#extraDisc').text(extra_discount);
            $('#extraDisc').editable('setValue', extra_discount);
            PosnicPro.sales.view.changeExtraDiscType(extra_discount_type);
            if (extra_discount !== 0) {
                $('.addDisc-hide-show').show();
                if (PosnicPro.sales.syncNotesCellSpan) { PosnicPro.sales.syncNotesCellSpan(); }
            } else {
                $('.addDisc-hide-show').hide();
                if (PosnicPro.sales.syncNotesCellSpan) { PosnicPro.sales.syncNotesCellSpan(); }
        if (PosnicPro.sales.syncNotesCellSpan) { PosnicPro.sales.syncNotesCellSpan(); }
            }
            $('#extraDisc').prop('disabled', false);
            $('#extraDisc').removeClass('extraDisc');
        }
        $("#sales_new_customer_state").val(result.customer_state);
        $("#sales_new_customer_country").val(result.customer_country);
        // Load once with the order, never when opening/reopening payment.
        PosnicPro.sales.charges = (result.charges || []).map(function (charge) {
            return Object.assign({}, charge);
        });
        if (PosnicPro.sales.renderCharges) PosnicPro.sales.renderCharges();
        PosnicPro.sales.EditRecentSaleParams = {
            recorded_bill: Object.freeze({ sales_total: result.sales_total, updated_date: result.order_revision }),
            paid_bill_corrected: !!(result.paid_bill_corrections && result.paid_bill_corrections.length),
            updated_date: result.updated_date,
            "sale_inline_item_price": result.item_price,
            "sale_inline_discount_value": result.sale_inline_discount_value,
            "sale_inline_discount_pervalue": result.sale_inline_discount_pervalue,
            "sale_process": result.sale_process,
            "customer_id": result.customer_id,
            "customer_name": result.customer_name,
            "customer_address": result.customer_address,
            "customer_phone": result.customer_phone,
            "customer_email": result.customer_email,
            "customer_state": result.customer_state,
            "customer_country": result.customer_country,
            "customer_partial": (typeof result.customer_partial !== 'undefined' && result.customer_partial !== null)
                ? (result.customer_partial === true || String(result.customer_partial).toLowerCase() === 'true')
                : false,
            "sales_new_customer_partial_balance": result.partial_check,
            "customer_balance": result.customer_balance,
            "partial_amounts": result.partial_balance,
            "wallet_amount": result.wallet_amount,
            "payment_description": result.payment_description,
            "sales_description": result.sales_description,
            "discount_description": result.discount_description,
            "discount": result.discount,
            "user_id": result.user_id,
            "user_name": result.user_name,
            "payment_pending": result.payment_pending,
            "payment_status": result.payment_status,
            "partial_check": result.partial_check,
            "sales_total": result.sales_total
        };

        // Ensure edit/payment flows have customer fields
        // populated in the DOM so customer_id is never empty in requests.
        $('#sales_new_customer_id').val(result.customer_id || '');
        $('#sales_new_customer_name').val(result.customer_name || '');
        $('#sales_new_customer_address').val(result.customer_address || '');
        $('#sales_new_customer_phone').val(result.customer_phone || '');
        $('#sales_new_customer_email').val(result.customer_email || '');
        $('#sales_new_customer_state').val(result.customer_state || '');
        if (PosnicPro.sales.updateCustomerChip) PosnicPro.sales.updateCustomerChip();
        $('#sales_new_customer_country').val(result.customer_country || '');
        // Set customer partial_balance field for payment modal to show wallet/due sections
        // Payment modal checks for 'true' string at line 1422, so set 'true' if partial customer
        var rawCustomerPartial;
        if (PosnicPro.sales.paymentOnlyMode === true &&
            (result.customer_partial === true || String(result.customer_partial).toLowerCase() === 'true')) {
            rawCustomerPartial = true;
        } else {
            rawCustomerPartial = result.partial_check;
        }
        var customerPartialStatus = (rawCustomerPartial === true || String(rawCustomerPartial).toLowerCase() === 'true') ? 'true' : 'false';
        $('#sales_new_customer_partial_balance').val(customerPartialStatus);
        $('#customer_current_balance').val(result.customer_balance || 0);

        var EditRecentSaleItems = result.items;
        var lineItem = [];
        PosnicPro.sales.SaleAction = sale;
        if (sale === 'return') {
            PosnicPro.commonDate();
            /*For checking Recent Sale action in addline items*/
            PosnicPro.sales.refundSaleAction = true;
            /* recent Sale Document Id store in array recentSaleId*/
            PosnicPro.sales.refundSaleId = id;
            PosnicPro.sales.salesId = result.sales_id;
            $.each(EditRecentSaleItems, function (key, val) {
                lineItem = {
                    "sale_inline_item_price": PosnicPro.sales.savedSellingPrice(val),
                    "return": val.return,
                    "item_id": val.item_id,
                "id": val.line_id || val.item_id,
                "product_id": val.item_id,
                "line_id": val.line_id,
                "unit_conversion": val.unit_conversion,
                    "item_name": val.item_name,
                    "selling_price": PosnicPro.sales.savedSellingPrice(val),
                    "itemid": val.barcode_id,
                    "item_quantity": val.item_quantity,
                    "item_available_quantity": val.item_available_quantity,
                    "company_price": PosnicPro.sales.savedCompanyUnitPrice(val),
                    "sale_inline_discount_value": val.sale_inline_discount_value,
                    "sale_inline_discount_pervalue": val.sale_inline_discount_pervalue,
                    "discount_amount": val.item_discount,
                    "discount_percentage": val.item_discount_percentage,
                    "category_id": val.category_id,
                    "category_name": val.category_name,
                    "supplier_id": val.supplier_id,
                    "supplier_name": val.supplier_name,
                    "sales_type": val.item_status,
                    "unit": val.item_unit
                };
                PosnicPro.sales.addSalesLineItems(lineItem);
            });
        } else {
            PosnicPro.commonEditDate(result.date);
            /*For checking Edit Sale action in addline items*/
            PosnicPro.sales.editSaleAction = true;
            /* Edit Sale Document Id store in array editSaleId*/
            PosnicPro.sales.editSaleId = id;
            $('.highlight-select').removeClass('table-highlight-row');
            /*Table Blinking*/
            var row = "recent_sales_table_row_" + id;
            $("#" + row + '').addClass('table-highlight-row');
        }
        PosnicPro.sales.salesId = result.sales_id;
        $.each(EditRecentSaleItems, function (key, val) {
            lineItem = {
                "sale_inline_item_price": PosnicPro.sales.savedSellingPrice(val),
                "item_id": val.item_id,
                "id": val.line_id || val.item_id,
                "product_id": val.item_id,
                "line_id": val.line_id,
                "unit_conversion": val.unit_conversion,
                "item_name": val.item_name,
                "selling_price": PosnicPro.sales.savedSellingPrice(val),
                "itemid": val.barcode_id,
                "item_quantity": val.item_quantity,
                "available_quantity": Number(val.item_available_quantity) / Number(val.unit_conversion && val.unit_conversion.factor || 1),
                "company_price": PosnicPro.sales.savedCompanyUnitPrice(val),
                "sale_inline_discount_value": val.sale_inline_discount_value,
                "sale_inline_discount_pervalue": val.sale_inline_discount_pervalue,
                "discount_amount": val.item_discount,
                "discount_percentage": val.item_discount_percentage,
                "category_id": val.category_id,
                "category_name": val.category_name,
                "supplier_id": val.supplier_id,
                "supplier_name": val.supplier_name,
                "sales_type": val.item_status,
                "track_inventory": val.track_inventory,
                "negative_stock": (typeof (val.negative_stock) === "undefined" || val.negative_stock === null) ? false : val.negative_stock,
                "unit": val.item_unit,
                "item_description": (typeof (val.item_description) !== "undefined" && val.item_description !== null) ? val.item_description : ''
            };
            PosnicPro.sales.addSalesLineItems(lineItem);
        });
        $('#sales_description').val(PosnicPro.sales.EditRecentSaleParams.sales_description).hide();

        // If we arrived here via payment-only mode (Unpaid payment icon), directly
        // open the tender/payment popup once the edit view has been fully
        // initialized. This reuses the standard openTenderModel flow.
        if (PosnicPro.sales.paymentOnlyMode === true) {
            PosnicPro.sales.openTenderModel();
        }
    },
    setEditSalesDetails: function () {
        if (PosnicPro.sales.EditRecentSaleParams.payment_description === '') {
            $('#payment_description').text('').val('').hide();
            PosnicPro.updateSaleNoteFlag('click_payment_description', 'feather icon-edit-1', '');
        } else {
            $('#payment_description').val(PosnicPro.sales.EditRecentSaleParams.payment_description).hide();
            $('#payment_description').editable('setValue', PosnicPro.sales.EditRecentSaleParams.payment_description);
            PosnicPro.updateSaleNoteFlag('click_payment_description', 'feather icon-edit-1', PosnicPro.sales.EditRecentSaleParams.payment_description);
        }

        if (PosnicPro.sales.EditRecentSaleParams.sales_description === '') {
            $('#sales_description').text('').val('').hide();
            PosnicPro.updateSaleNoteFlag('click_sales_description', 'feather icon-edit-1', '');
        } else {
            $('#sales_description').val(PosnicPro.sales.EditRecentSaleParams.sales_description).hide();
            $('#sales_description').editable('setValue', PosnicPro.sales.EditRecentSaleParams.sales_description);
            PosnicPro.updateSaleNoteFlag('click_sales_description', 'feather icon-edit-1', PosnicPro.sales.EditRecentSaleParams.sales_description);
        }

        if (PosnicPro.sales.EditRecentSaleParams.discount_description === '') {
            $('#discount_description').text('').val('').hide();
            $('#click_discount_description').css({ color: '#506fe4' });
        } else {
            $('#discount_description').val(PosnicPro.sales.EditRecentSaleParams.discount_description).hide();
            $('#discount_description').editable('setValue', PosnicPro.sales.EditRecentSaleParams.discount_description);
            $('#click_discount_description').css({ color: '#5fd799' });
        }
        if (PosnicPro.sales.EditRecentSaleParams.sale_process !== 'Hold') {
            db.saleAutoFocus.get('1').then(function (data) {
                if (data && data.editSale === true) {
                    $('#sales_new_item_name').focus();
                } else {
                    $('#sales_new_item_name').blur();
                }
            });

            $(".changeSalesBtnText").text(PosnicPro.i18n.t('lang_updatebtn_title', 'Update'));
        } else {
            db.saleAutoFocus.get('1').then(function (data) {
                if (data && data.holdSale === true) {
                    $('#sales_new_item_name').focus();
                } else {
                    $('#sales_new_item_name').blur();
                }
            });

                $(".changeSalesBtnText").text(PosnicPro.i18n.t('lang_save_title', 'Save'));

            $('#closeSaleButton').hide();
            PosnicPro.collapseMenuForWorkspace();
            $('#time-format').addClass('commonDate');
            $('#time-format').removeClass('commonEditDate');
            PosnicPro.commonDate();
        }

    },
    recentSalesTabDetails: function () {
        if ($('a#parked-tab-justified').hasClass('active')) {
            PosnicPro.sales.parkedMenu.list();
        } else if ($('a#contact-tab-justified').hasClass('active')) {
            PosnicPro.sales.recentSaleAction = true;
            PosnicPro.sales.recentMenu.salesList();
        } else if ($('a#profile-tab-justified').hasClass('active')) {
            PosnicPro.sales.recentSaleAction = false;
            PosnicPro.sales.categoryMenu.listCategories();
        } else {
            PosnicPro.sales.recentSaleAction = false;
            PosnicPro.sales.itemsMenu.onlineProductList();
        }
    }

};
/*
 * Parked sales (owner ask): held sales live one tab away from the items,
 * so a busy till parks and resumes without leaving the billing screen.
 * List = the recent-sales endpoint with type=hold (holds only, up to 20);
 * resume = the existing hold route.
 */
/*
 * Printing follows a completed sale, never gates it. If the machine has no
 * printer, say that once and keep the saved sale exactly where it is; the
 * cashier can reprint from Sales after connecting paper or a printer.
 */
PosnicPro.sales.printAfterSave = function (saleId) {
    var api = window.electronAPI && window.electronAPI.printer;
    var printNow = function () {
        if (PosnicPro.sales.view && typeof PosnicPro.sales.view.printSale === 'function') {
            PosnicPro.sales.view.printSale(saleId, 'sale');
        }
    };
    var noPrinter = function () {
        PosnicPro.alert('warning', PosnicPro.i18n.t(
            'lang_sale_saved_no_printer_connected',
            'Sale saved. No printer is connected, so the receipt was not printed. Connect a printer and print it from Sales.'
        ));
    };
    if (!api || typeof api.list !== 'function') {
        // A browser till prints through the browser dialog; there is no local
        // queue list to inspect before handing it the document.
        printNow();
        return;
    }
    Promise.resolve()
        .then(function () { return api.list(); })
        .then(function (printers) {
            if (!Array.isArray(printers) || printers.length === 0) { noPrinter(); return; }
            printNow();
        })
        .catch(noPrinter);
};
PosnicPro.sales.parkedMenu = {
    printEnabled: function (value) { return value === true || value === 'true'; },
    clearing: false,
    clearAll: function () {
        var menu = PosnicPro.sales.parkedMenu;
        if (menu.clearing || !window.confirm('Clear all parked sales in this branch? This includes parked sales beyond the rows shown. They will be removed from the parked and recent lists. Sale records, payments and stock will not be deleted.')) return;
        menu.clearing = true;
        $('#clear_all_parked_sales').prop('disabled', true);
        var failed = function (message) {
            menu.clearing = false;
            $('#clear_all_parked_sales').prop('disabled', false);
            PosnicPro.alert('error', message || 'Could not clear parked sales. Please try again.');
        };
        PosnicPro.post({ url: 'sales/parked/clear', data: JSON.stringify({ confirmed: true }) }, function (response) {
            if (response.type !== 'success') { failed(response.message); return; }
            menu.clearing = false;
            PosnicPro.alert('success', Number(response.data && response.data.cleared || 0) + ' parked sales cleared.');
            menu.list();
        }, function () { failed(); });
    },
    paidOnResume: function (sale, previousToggle) {
        // Ordinary drafts resume ready to collect. Completed bills retain
        // their existing payment state.
        return sale.sale_process === 'Hold' ? true : previousToggle;
    },
    list: function () {
        PosnicPro.sales._catalogueGeneration = (PosnicPro.sales._catalogueGeneration || 0) + 1;
        var loader = $(".loader-product");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        $('#sales_new_productList').show();
        $('#sales_new_categoryList').hide();
        $('#item-lists').remove();
        $('#sales_new_productList').append(' <div id="item-lists" style="margin-left: 7px;"/>');
        $('#item-lists').append(
            "<div class='m-b-30'><div class='d-flex justify-content-end mb-2'><button type='button' id='clear_all_parked_sales' class='btn btn-outline-danger btn-sm' data-module='sales' data-access='write' disabled>Clear all parked sales</button></div><div class='wishlist-box'><div class='table-responsive'><table id='parked_sales_table' class='table table-borderless' cellpadding='1'>" +
            "<thead><tr><th scope='col'>Customer</th><th scope='col' class='text-center'>Items</th><th scope='col' class='text-center'>Total</th><th scope='col' class='text-center'>Parked</th><th scope='col' class='text-center'>Resume</th></tr></thead>" +
            "<tbody></tbody></table></div></div></div>");
        $('#clear_all_parked_sales').on('click', PosnicPro.sales.parkedMenu.clearAll);
        PosnicPro.get('sales/getLatestSales?type=hold', function (response) {
            loader.find(".loadingSpinner:first").remove();
            var rows = [];
            try { rows = jQuery.parseJSON(response.data) || []; } catch (e) { rows = []; }
            var currency = PosnicPro.local.get('currencySign');
            var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
            if (!rows.length) {
                $('#parked_sales_table tbody').html(
                    "<tr><td colspan='5' class='text-center text-muted p-t-20'>Nothing parked - press Hold on a sale and it waits here.</td></tr>");
                return;
            }
            $('#clear_all_parked_sales').prop('disabled', PosnicPro.sales.parkedMenu.clearing);
            /* Newest first. The server already sorts that way, but a parked
               sale that has been waiting since yesterday matters more than
               where it happens to sit in a list, so the order is made
               explicit rather than inherited. */
            rows.sort(function (a, b) {
                return new Date(b.parked_at || 0) - new Date(a.parked_at || 0);
            });
            var html = '';
            $(rows).each(function (i, r) {
                var waited = PosnicPro.sales.parkedAgo(r.parked_at);
                html += '<tr>' +
                    '<td>' + esc(r.customer_name || 'Walk-in') + '<br><small class="text-muted">' + esc(r.sales_id || '') + '</small></td>' +
                    '<td class="text-center">' + esc(r.number_of_items) + '</td>' +
                    '<td class="text-center">' + currency + '&nbsp;' + Number(r.total_amount || 0).toFixed(2) + '</td>' +
                    '<td class="text-center"><span class="parked-ago' + (waited.stale ? ' stale' : '') + '" title="' + esc(waited.exact) + '">' + esc(waited.text) + '</span></td>' +
                    '<td class="text-center"><div class="d-inline-flex align-items-center" style="gap:6px"><a href="#/sales/' + esc(r.sales_document_id) + '/hold" class="btn btn-success-rgba btn-sm" title="Resume this sale" data-t-title="lang_resume_this_sale"><i class="feather icon-play"></i> Resume</a>' +
                    '</div></td>' +
                    '</tr>';
            });
            $('#parked_sales_table tbody').html(html);
        }, function () {
            loader.find(".loadingSpinner:first").remove();
            $('#parked_sales_table tbody').html(
                "<tr><td colspan='5' class='text-center text-muted p-t-20'>Could not load parked sales - try again.</td></tr>");
        });
    }
};
/******** END SALES RECENT ADD EDIT SALES MENU & RECENT ADDED ITEMS MENU ********/

/******** START SALES RECENT ADD EDIT SALES MENU & RECENT ADDED ITEMS MENU ********/
/******** END ~ ADD SALES PAGE MENU ********/

// A typed name is a sale snapshot, never a rename of the linked customer.
$('#sales_new_customer_name').on('input', function () {
    if ($('#sales_new_customer_id').val()) {
        $('#sales_new_customer_id,#sales_new_customer_phone,#sales_new_customer_email,#sales_new_customer_address,#sales_new_customer_state,#sales_new_customer_country,#sales_new_customer_partial_balance,#customer_current_balance').val('');
        PosnicPro.sales._customerCategoryId = '';
        if (PosnicPro.sales.refreshCustomerAccount) PosnicPro.sales.refreshCustomerAccount();
        if (PosnicPro.sales.calculation && PosnicPro.sales.calculation.salesTableRowCart) PosnicPro.sales.calculation.salesTableRowCart();
    }
    PosnicPro.local.set('customerName', this.value);
    PosnicPro.local.set('customerPhone', $('#sales_new_customer_phone').val() || '');
    PosnicPro.local.set('customerEmail', $('#sales_new_customer_email').val() || '');
    PosnicPro.local.set('customerAddress', $('#sales_new_customer_address').val() || '');
    if (PosnicPro.sales.updateCustomerChip) PosnicPro.sales.updateCustomerChip();
});
$('#sales_new_customer_name').click(function () {
    PosnicPro.selectAllText(jQuery(this));
});
var $table = $('table.scroll'),
    $bodyCells = $table.find('tbody tr:first').children(),
    colWidth;
$(window).resize(function () {
    colWidth = $bodyCells.map(function () {
        return $(this).width();
    }).get();
    $table.find('thead tr').children().each(function (i, v) {
        $(v).width(colWidth[i]);
    });
}).resize();
/* ONE resolution path for every way a barcode arrives - hardware scanner
   wedge or the camera (L3). Looks the code up, stock-checks, adds the line. */
PosnicPro.sales.addScannedItem = function (itemData) {
    // Barcode results are live. Do not replace the selected record's price
    // with an older detail-cache entry when adding it to the basket.
    var selectedId = itemData.item_id || itemData.id || (itemData._id && itemData._id.$oid);
    if (selectedId && PosnicPro.sales.itemCache) {
        delete PosnicPro.sales.itemCache._map[selectedId];
    }
    var mustCheckStock =
        (itemData.track_inventory === true || itemData.track_inventory === 'true' || itemData.track_inventory === 1 || itemData.track_inventory === '1');

    var isNegativeStock =
        (itemData.negative_stock === true || itemData.negative_stock === 'true' || itemData.negative_stock === 1 || itemData.negative_stock === '1');

    if (mustCheckStock && !isNegativeStock) {
        var availableQty = parseFloat(itemData.available_quantity) || 0;
        if (availableQty <= 0) {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_check_the_product_quantity', 'Check the product quantity.'));
            return;
        }
    }

    (PosnicPro.sales.SaleAction === 'return') ? PosnicPro.sales.salesExchange = true : PosnicPro.sales.salesExchange = false;
    $('#sales_new_item_name').focus();

    if (itemData.item_id) {
        PosnicPro.sales.itemsMenu.addToLineItemsList(itemData.item_id);
    } else if (itemData.id) {
        PosnicPro.sales.itemsMenu.addToLineItemsList(itemData.id);
    } else if (itemData._id && itemData._id.$oid) {
        PosnicPro.sales.itemsMenu.addToLineItemsList(itemData._id.$oid);
    } else {
        PosnicPro.sales.addSalesLineItems(itemData);
    }
};
PosnicPro.sales.chooseBarcodeItem = function (items) {
    if ($('#sharedBarcodePicker').length) { return; }
    var autocomplete = $('#sales_new_item_name').data('autocomplete');
    if (autocomplete && typeof autocomplete.disable === 'function') { autocomplete.disable(); }
    if (autocomplete && typeof autocomplete.hide === 'function') { autocomplete.hide(); }
    if (!$('#sharedBarcodeStyle').length) {
        $('<style id="sharedBarcodeStyle">body.shared-barcode-open .autocomplete-suggestions{display:none!important}</style>').appendTo(document.head);
    }
    $(document.body).addClass('shared-barcode-open');
    var modal = $('<div class="modal fade" id="sharedBarcodePicker" tabindex="-1" role="dialog" aria-labelledby="sharedBarcodeTitle"></div>');
    var content = $('<div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content"></div></div>').appendTo(modal).find('.modal-content');
    var header = $('<div class="modal-header"></div>').appendTo(content);
    $('<h5 class="modal-title" id="sharedBarcodeTitle"></h5>').text(PosnicPro.i18n.t('lang_choose_product_for_this_barcode', 'Choose product for this barcode')).appendTo(header);
    $('<button type="button" class="close" data-dismiss="modal" aria-label="Close" data-t-aria-label="lang_close_title"><span aria-hidden="true">&times;</span></button>').appendTo(header);
    var body = $('<div class="modal-body"></div>').appendTo(content);
    $('<p></p>').text(PosnicPro.i18n.t('lang_several_products_share_this_barcode_select', 'Several products share this barcode. Select the product you are selling.')).appendTo(body);
    var list = $('<div class="list-group"></div>').appendTo(body);
    items.forEach(function (item) {
        var button = $('<button type="button" class="list-group-item list-group-item-action text-left py-3"></button>');
        $('<strong class="d-block"></strong>').text(item.item_name || 'Unnamed item').appendTo(button);
        var price = Number(item.selling_price) || 0;
        if (Array.isArray(item.sales_search_display_fields)) {
            button.empty().append(PosnicPro.sugRow(item,
                $('<i>').text(item.item_name || 'Unnamed item').html(), {
                    sales: true, price: price, currency: PosnicPro.local.get('currencySign') || ''
                }));
        } else {
        $('<span class="d-block text-muted"></span>').text('Barcode: ' + (item.barcode_id || 'Not set') + ' | Item code: ' + (item.itemid || item.item_id) + ' | ' +
            (item.supplier_name || '') + ' | ' + (PosnicPro.local.get('currencySign') || '') + price.toFixed(2) +
            ' | Stock: ' + (Number(item.available_quantity) || 0)).appendTo(button);
        }
        button.on('click', function () { modal.modal('hide'); PosnicPro.sales.addScannedItem(item); });
        list.append(button);
    });
    var footer = $('<div class="modal-footer"></div>').appendTo(content);
    $('<button type="button" class="btn btn-outline-primary" data-dismiss="modal"><lang class="lang_cancel_title">Cancel</lang></button>').appendTo(footer);
    modal.on('hidden.bs.modal', function () {
        modal.remove();
        $(document.body).removeClass('shared-barcode-open');
        if (autocomplete && typeof autocomplete.enable === 'function') { autocomplete.enable(); }
        $('#sales_new_item_name').val('').focus();
    });
    modal.appendTo(document.body).modal('show');
};
PosnicPro.sales.addByBarcode = function (barcode) {
    var code = String(barcode || '').trim();
    if (!code) { return; }
    PosnicPro.get({ url: 'items/getOnlineItemsAjaxList', data: 'query=' + encodeURIComponent(code) + '&type=barcode' }, function (response) {
        var items = response && response.suggestions || [];
        if (items.length > 1) { PosnicPro.sales.chooseBarcodeItem(items); }
        else if (items.length === 1) { PosnicPro.sales.addScannedItem(items[0]); }
        else {
            $('#sales_new_item_name').focus();
            swal({ title: PosnicPro.i18n.t('lang_not_found', 'Not found!'), text: 'Barcode item not found. Please check item page.', icon: 'warning', button: 'Ok' });
        }
    }, function () { PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_look_up_the_barcode_please_try_a', 'Could not look up the barcode. Please try again.')); });
};
// Enter on a typed/pasted retail barcode uses the same explicit resolution path.
// Capture before autocomplete can select its first matching suggestion.
if (!PosnicPro.sales._sharedBarcodeEnterBound) {
    PosnicPro.sales._sharedBarcodeEnterBound = true;
    document.addEventListener('keydown', function (event) {
        var input = event.target;
        // A separate Enter in Tender confirms the displayed payment through the
        // same Save button (and validation) as a mouse click. Held keys cannot save.
        if (input && input.id === 'Partial_amount' && event.key === 'Enter') {
            if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { return; }
            event.preventDefault();
            event.stopImmediatePropagation();
            var save = document.getElementById('save_btn');
            if (event.repeat ||
                PosnicPro.sales.submissionInProgress || !save || save.disabled ||
                !$('#infobar-settings-sidebar-tender-details').hasClass('sidebarview') ||
                !$('#Partial_amount').is(':visible') || !$(save).is(':visible') ||
                $('.modal.show:visible, .swal2-modal:visible').length) { return; }
            save.click();
            return;
        }
        if (!input || input.id !== 'sales_new_item_name') { return; }
        // Scanner detection buffers characters before putting them in the input.
        // Its terminating Enter must never open payment for an apparently empty box.
        if (event.key && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
            PosnicPro.sales._searchScanPending = true;
        }
        if (event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { return; }
        var code = String(input.value || '').trim();
        if (!code && !PosnicPro.sales._searchScanPending) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.repeat ||
                PosnicPro.sales.submissionInProgress ||
                !$('#sales_new_item_name').is(':visible') ||
                $('#infobar-settings-sidebar-tender-details').hasClass('sidebarview') ||
                !$('.salesBalanceAmount .custom_balance').is(':visible') ||
                !$('#sales_new_items_tbody tr[id^="touch_row_"]').length ||
                $('.modal.show:visible, .swal2-modal:visible').length) { return; }
            PosnicPro.sales.openTenderModel(false, true);
            return;
        }
        if (!/^\d{7,}$/.test(code)) { return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        input.value = '';
        PosnicPro.sales.addByBarcode(code);
    }, true);
}
$('#sales_new_item_name').scannerDetection({
    timeBeforeScanTest: 200, // wait for the next character for upto 200ms
    avgTimeByChar: 40, // it's not a barcode if a character takes longer than 100ms
    preventDefault: true,
    endChar: [13],
    onComplete: function (barcode, qty) {
        PosnicPro.sales._searchScanPending = false;
        validScan = true;
        PosnicPro.sales.addByBarcode(barcode);
    },
    onError: function (string, qty) {
        PosnicPro.sales._searchScanPending = false;
        $('#sales_new_item_name').val($('#sales_new_item_name').val() + string).trigger('input');
    }
});

/*
 * Camera scan (Loyverse study L3): the browser's BarcodeDetector where it
 * exists (Chromium on Android/desktop - exactly the cheap devices busy
 * shops carry). The button only shows when the capability is real; codes
 * land in the SAME addByBarcode path as the hardware wedge.
 */
PosnicPro.sales.cameraScan = {
    _stream: null,
    _timer: null,
    open: function () {
        if (!('BarcodeDetector' in window)) {
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_camera_scanning_needs_chrome_or_edge_on_th', 'Camera scanning needs Chrome or Edge on this device'));
            return;
        }
        if (!$('#camera_scan_modal').length) {
            $('body').append(
                '<div class="modal fade" id="camera_scan_modal" tabindex="-1" role="dialog" aria-hidden="true">' +
                '<div class="modal-dialog modal-dialog-centered" role="document"><div class="modal-content">' +
                '<div class="modal-header"><h5 class="modal-title"><i class="feather icon-camera mr-2"></i>Scan an item</h5>' +
                '<button type="button" class="close" data-dismiss="modal" aria-label="Close" data-t-aria-label="lang_close_title"><span aria-hidden="true">&times;</span></button></div>' +
                '<div class="modal-body p-2 text-center">' +
                '<video id="camera_scan_video" autoplay playsinline muted style="width:100%;border-radius:6px;background:#000;min-height:240px;"></video>' +
                '<small class="text-muted d-block mt-1"><lang class="lang_point_the_camera_at_a_barcode">Point the camera at a barcode</lang></small>' +
                '</div></div></div></div>');
            $('#camera_scan_modal').on('hidden.bs.modal', PosnicPro.sales.cameraScan.stop);
        }
        var self = PosnicPro.sales.cameraScan;
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
            self._stream = stream;
            var video = document.getElementById('camera_scan_video');
            $('#camera_scan_modal').modal('show');
            video.srcObject = stream;
            var detector = new window.BarcodeDetector();
            self._timer = setInterval(function () {
                if (!video.videoWidth) { return; }
                detector.detect(video).then(function (codes) {
                    if (codes && codes.length && codes[0].rawValue) {
                        var code = codes[0].rawValue;
                        $('#camera_scan_modal').modal('hide');
                        PosnicPro.sales.addByBarcode(code);
                    }
                }).catch(function () { /* keep looking */ });
            }, 350);
        }).catch(function () {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_open_the_camera_check_permission', 'Could not open the camera - check permission'));
        });
    },
    stop: function () {
        var self = PosnicPro.sales.cameraScan;
        if (self._timer) { clearInterval(self._timer); self._timer = null; }
        if (self._stream) {
            self._stream.getTracks().forEach(function (t) { t.stop(); });
            self._stream = null;
        }
    }
};
$(document).ready(function () {
    if ('BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        $('#camera_scan_btn').show();
    }
    // Quick Sale follows its switch and the cashier's grant live: re-checked
    // on every navigation and cross-tab storage write, so no refresh is needed.
    PosnicPro.sales.applyQuickSaleGate();
    $(window).on('hashchange storage', PosnicPro.sales.applyQuickSaleGate);
    PosnicPro.sales.loadCatTiles();
});
/* LS2 (Lightspeed study): cash counting offers the till's real notes and
   coins by currency. Shop-defined denominations in Settings always win;
   this only replaces the one-size-fits-all fallback. */

    /*
     * The notes and coins actually in circulation, by currency.
     *
     * A shop's own list in Settings > Cash Denominations always wins; this is
     * only the starting point, so that a till in Lagos or Jakarta does not
     * open showing Indian rupee buttons.
     *
     * KEYED BY SYMBOL, BECAUSE THAT IS ALL WE HAVE. The shop stores
     * currency_type, which is the symbol - the ISO code sits in
     * api/src/json/currency.json and never reaches the browser. Symbols
     * collide, so where one serves several countries the entry is the most
     * widely used of them and is marked below. Getting that wrong costs a
     * shopkeeper one visit to Settings; leaving every till on rupees costs
     * every one of them that visit.
     *
     * Coins that no longer buy anything are left out on purpose. India has a
     * 1 rupee coin and Nigeria has a 50 kobo, but a button nobody presses is
     * a button in the way of the ones they do.
     */
/* A sale carries a register session only while the Cash Register feature
   is ON - with it off, a register id left in localStorage from before the
   switch must not lock anyone out of tendering. */
PosnicPro.sales.saleRegisterId = function () {
    try {
        var gs = JSON.parse(PosnicPro.local.get('general_settings') || '{}');
        if (gs.cash_register_enable === false) { return ''; }
    } catch (e) { /* feature defaults on */ }
    return PosnicPro.local.get('cash_register_id') || '';
};
/*
 * Quick Sale is opt-in: the button exists only when the shop has switched the
 * feature on AND this cashier has not been denied the till action. Both reads
 * default to off/denied-on-explicit-false so an old permission blob without
 * the key follows the shop switch rather than bypassing it.
 */
PosnicPro.sales.applyQuickSaleGate = function () {
    var on = false;
    try {
        var gs = JSON.parse(PosnicPro.local.get('general_settings') || '{}');
        on = gs.quick_sale_enable === true;
    } catch (e) { /* default off */ }
    var pos = PosnicPro.userACL && PosnicPro.userACL.pos;
    if (pos && typeof pos === 'object' && pos.quick_sale === false) { on = false; }
    $('#quick_sale_btn').toggle(on);
    return on;
};
/*
 * Quick Sale (Square study Q1): the busy-counter mode - type an amount,
 * it becomes a sale line, tender as normal. Rides the instant-item rail end
 * to end (items/instanceItemInsert -> addSalesLineItems), so stock, reports,
 * receipts and sync see an ordinary sale.
 */
PosnicPro.sales.quickSale = {
    _count: 0,
    open: function () {
        if (!PosnicPro.sales.applyQuickSaleGate()) { return; }
        if (!$('#quick_sale_modal').length) {
            $('body').append(
                '<div class="modal fade" id="quick_sale_modal" tabindex="-1" role="dialog" aria-hidden="true">' +
                '<div class="modal-dialog modal-sm modal-dialog-centered" role="document"><div class="modal-content">' +
                '<div class="modal-header py-2"><h5 class="modal-title"><i class="feather icon-zap mr-2"></i><lang class="lang_quick_sale">Quick sale</lang></h5>' +
                '<button type="button" class="close" data-dismiss="modal" aria-label="Close" data-t-aria-label="lang_close_title"><span aria-hidden="true">&times;</span></button></div>' +
                '<div class="modal-body">' +
                '<input type="number" min="0" step="any" class="form-control form-control-lg text-right mb-2" id="quick_sale_amount" placeholder="0.00" autocomplete="off" style="font-size:1.6rem;">' +
                '<input type="text" class="form-control mb-2" id="quick_sale_note" maxlength="100" placeholder="Item name (optional)" data-t-placeholder="lang_item_name_optional" autocomplete="off">' +
                '<small class="text-muted d-block" id="quick_sale_hint"><lang class="lang_quick_sale_hint">The amount becomes one sale line. Tender as usual.</lang></small>' +
                '<small class="text-muted d-block" id="quick_sale_added"></small>' +
                '</div>' +
                '<div class="modal-footer py-2">' +
                '<button type="button" class="btn btn-outline-secondary btn-sm" data-dismiss="modal"><lang class="lang_cancel_title">Cancel</lang></button>' +
                '<button type="button" class="btn btn-warning-rgba" id="quick_sale_add" onclick="PosnicPro.sales.quickSale.add();"><lang class="lang_add_to_sale">Add to sale</lang></button>' +
                '</div></div></div></div>');
            $('#quick_sale_amount').on('keydown', function (e) {
                if (e.key === 'Enter') { PosnicPro.sales.quickSale.add(); }
            });
            /* Enter from the note field too: amount typed, name typed,
               Enter - the line is in the cart. No amount yet means Enter
               walks back to the amount box instead of nagging. */
            $('#quick_sale_note').on('keydown', function (e) {
                if (e.key !== 'Enter') { return; }
                if (parseFloat($('#quick_sale_amount').val()) > 0) {
                    PosnicPro.sales.quickSale.add();
                } else {
                    $('#quick_sale_amount').focus();
                }
            });
        }
        PosnicPro.sales.quickSale._count = 0;
        $('#quick_sale_added').text('');
        $('#quick_sale_amount,#quick_sale_note').val('');
        $('#quick_sale_modal').modal('show');
        setTimeout(function () { $('#quick_sale_amount').focus(); }, 400);
    },
    add: function () {
        var amount = parseFloat($('#quick_sale_amount').val());
        if (!Number.isFinite(amount) || amount <= 0) {
            $('#quick_sale_amount').focus();
            return;
        }
        var note = ($('#quick_sale_note').val() || '').trim();
        $('#quick_sale_add').prop('disabled', true);
        PosnicPro.post({
            url: 'items/instanceItemInsert',
            data: JSON.stringify({
                items_name: note || PosnicPro.i18n.t('lang_quick_sale', 'Quick sale'),
                items_quantity: 1,
                items_mrp_price: amount,
                items_selling_price: amount,
                items_company_price: 0,
                items_discount_amount: 0,
                items_discount_percentage: 0,
                items_tax_id: '',
                items_tax_name: '',
                items_tax: 0,
                items_tax_type: 'inclusive',
                items_sku: '',
                items_category_id: '',
                items_category_name: '',
                items_unit: 'qty'
            })
        }, function (response) {
            $('#quick_sale_add').prop('disabled', false);
            if (response.type !== 'success') {
                PosnicPro.alert(response.type, response.message);
                return;
            }
            var data = response.data;
            PosnicPro.sales.addSalesLineItems({
                item_id: data.id || data._id,
                item_name: data.name,
                selling_price: data.selling_price,
                barcode_id: data.barcode_id,
                item_quantity: data.available_quantity,
                discount_amount: data.discount_amount,
                discount_percentage: data.discount_percentage,
                tax: 0,
                company_price: data.company_price,
                category_id: data.category_id,
                category_name: data.category_name,
                tax_type: 'inclusive',
                sales_type: 'instant',
                instant_status: 'ok',
                unit: data.unit || 'qty'
            });
            PosnicPro.sales.quickSale._count += 1;
            $('#quick_sale_added').text(PosnicPro.sales.quickSale._count + ' ' +
                PosnicPro.i18n.t('lang_quick_sale_lines_added', 'line(s) added to this sale'));
            $('#quick_sale_amount,#quick_sale_note').val('');
            $('#quick_sale_amount').focus();
        }, function (xhr) {
            $('#quick_sale_add').prop('disabled', false);
            var resp = {}; try { resp = JSON.parse(xhr.responseText); } catch (e) { /* plain */ }
            PosnicPro.alert('error', resp.message ||
                PosnicPro.i18n.t('lang_quick_sale_failed', 'Could not add the quick sale line'));
        });
    }
};
/* Recent items under the sale search: rendered from the same LRU, picked
   straight into the cart. */
PosnicPro.sales.renderRecentItems = function () {
    var list = PosnicPro.sales._recentGet('recent_items');
    if (!list.length && PosnicPro.sales._itemSeed) { list = PosnicPro.sales._itemSeed; }
    if (!list.length) {
        PosnicPro.sales.seedRecentItems(function (seed) {
            if (seed.length) { PosnicPro.sales.renderRecentItems(); }
        });
    }
    var box = $('#sales_recent_items');
    if (!list.length) { box.hide(); return; }
    if (!box.length) {
        box = $('<div id="sales_recent_items" class="autocomplete-suggestions" style="position:absolute; z-index:1050; display:none; max-height:280px; overflow-y:auto;"></div>').appendTo('body');
        $(document).on('mousedown', '.recent-item-row', function (e) {
            e.preventDefault();
            var l = PosnicPro.sales._recentGet('recent_items');
            var it = l[$(this).data('i')];
            $('#sales_recent_items').hide();
            if (it) { PosnicPro.sales.itemsMenu.addToLineItemsList(it.id); }
        });
    }
    var input = $('#sales_new_item_name');
    var off = input.offset();
    var currency = PosnicPro.local.get('currencySign');
    box.html(list.map(function (it, i) {
        var img = (it.image && it.image !== 'item.svg') ? it.image : 'static/images/default/item.svg';
        return '<div class="autocomplete-suggestion recent-item-row" data-i="' + i + '" style="cursor:pointer;">' +
            '<img loading="lazy" decoding="async" src="' + img + '" height="40" width="40" style="border-radius: 25%;" /> ' +
            '<div class="suggestion-name">' + $('<span>').text(it.name).html() + '</div>' +
            '<span><span class="suggestion-price pull-right">' + currency + '&nbsp;' + (Number(it.price) || 0).toFixed(2) + '</span></span></div>';
    }).join(''))
        .css({ top: off.top + input.outerHeight(), left: off.left, width: input.outerWidth() })
        .show();
};
$(document).on('click', '#sales_new_item_name', function () {
    if (($(this).val() || '').trim() === '') { PosnicPro.sales.renderRecentItems(); }
});
/* A fresh till has no pick history - seed the recents once from the
   ordinary item list (one small indexed fetch, cached for the session). */
PosnicPro.sales._itemSeed = null;
PosnicPro.sales.seedRecentItems = function (done) {
    if (PosnicPro.sales._itemSeed) { done(PosnicPro.sales._itemSeed); return; }
    PosnicPro.get({ url: 'items/getOnlineItemsAjaxList', data: 'query=&type=normal' }, function (r) {
        var rows = (r && r.suggestions) || [];
        PosnicPro.sales._itemSeed = rows.map(function (d) {
            return { id: d.item_id, name: d.item_name, price: d.selling_price, image: d.image };
        }).filter(function (x) { return x.id && x.name; });
        done(PosnicPro.sales._itemSeed);
    }, function () { done([]); });
};
$(document).on('input blur', '#sales_new_item_name', function () {
    var self = this;
    setTimeout(function () {
        if (($(self).val() || '').trim() !== '' || !$(self).is(':focus')) { $('#sales_recent_items').hide(); }
    }, 200);
});

/*
 * Discounts are a POS power (owner ask): the discount_apply permission
 * gates the sale-screen discount editor; a cashier without it gets the
 * manager PIN prompt, the same rail as price edits and refunds. The
 * capture-phase listener beats the x-editable's own direct binding.
 */
document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('#extraDisc, #percentIcon, #rupeeIcon, #click_discount_description');
    if (!t) { return; }
    if (PosnicPro._discountApproved) { PosnicPro._discountApproved = false; return; }
    if (PosnicPro.posCan && !PosnicPro.posCan('discount_apply')) {
        e.preventDefault();
        e.stopPropagation();
        var open = function () { PosnicPro._discountApproved = true; t.click(); };
        var local = function () { PosnicPro.requireManagerApproval('discount_apply',
            { prompt: "Applying a discount needs a manager's approval." }, open); };
        if (PosnicPro.businessApproval) PosnicPro.businessApproval.editOrLocal(open, local);
        else local();
    }
}, true);

/* One shape vocabulary for every tile renderer. */
PosnicPro.tileShapeCss = function (shape, baseRadius) {
    var CLIPS = {
        triangle: 'polygon(50% 0,100% 100%,0 100%)',
        pentagon: 'polygon(50% 0,100% 38%,82% 100%,18% 100%,0 38%)',
        hexagon: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)',
        star: 'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)',
        octagon: 'polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%)',
        diamond: 'polygon(50% 0,100% 50%,50% 100%,0 50%)'
    };
    if (shape === 'circle') { return 'border-radius:50%;'; }
    if (shape === 'rounded') { return 'border-radius:22%;'; }
    if (CLIPS[shape]) { return 'clip-path:' + CLIPS[shape] + ';'; }
    return 'border-radius:' + (baseRadius || '6px') + ';';
};
/* New imageless items dress themselves: a stable colour and shape from
   the name, changeable any time (owner ask - never a bare placeholder). */
PosnicPro.autoTile = function (name) {
    var h = 0;
    var str = String(name || '');
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    var COLORS = ['#e74c3c', '#e91e63', '#f39c12', '#a4c400', '#27ae60', '#2d9cdb', '#8e44ad', '#16a085', '#d35400'];
    // Auto-dress keeps to the calm four; the renderers still draw
    // every shape ever saved.
    var SHAPES = ['square', 'rounded', 'circle', 'diamond'];
    return { color: COLORS[h % COLORS.length], shape: SHAPES[(h >> 4) % SHAPES.length] };
};
/* Category tile inheritance (CATEGORY_TILE_INHERITANCE_DESIGN.md):
   one render-time rule everywhere - photo beats the item's own tile,
   which beats the category's, which beats the name-hash dressing. */
PosnicPro.sales._catTiles = {};
PosnicPro.sales.loadCatTiles = function () {
    PosnicPro.get({
        url: 'categories',
        data: { page: 1, limit: 200, branch_id: PosnicPro.local.get('branch_id_set') }
    }, function (r) {
        var rows = (r && r.data && (r.data.list || r.data)) || [];
        if (!rows.forEach) { rows = []; }
        var map = {};
        rows.forEach(function (c) {
            var id = String(c._id || c.id || '');
            if (id && (c.tile_color || c.tile_shape)) {
                map[id] = { color: c.tile_color || '', shape: c.tile_shape || '' };
            }
        });
        PosnicPro.sales._catTiles = map;
    }, function () { /* no map, no inheritance - never an error */ });
};
PosnicPro.resolveTile = function (d) {
    var color = d.tile_color || '';
    var shape = d.tile_shape || '';
    if (!color) {
        var cat = PosnicPro.sales._catTiles[String(d.category_id || '')];
        if (cat) { color = cat.color || ''; shape = shape || cat.shape || ''; }
    }
    if (!color && PosnicPro.autoTile) {
        var auto = PosnicPro.autoTile(d.item_name || d.name || '');
        color = auto.color; shape = shape || auto.shape;
    }
    return { color: color, shape: shape };
};
/* One suggestion row for every item typeahead (sale + purchase): thumb,
   name + meta (SKU / category), price + live stock badge. */
PosnicPro.sugRow = function (d, nameHtml, o) {
    o = o || {};
    var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
    var thumb;
    if (d.image && d.image !== 'item.svg') {
        thumb = '<img class="sug-thumb" src="' + esc(d.image) + '" loading="lazy" alt="">';
    } else {
        var rt = PosnicPro.resolveTile(d);
        var shapeCss = rt.shape ? PosnicPro.tileShapeCss(rt.shape, '10px') : '';
        thumb = '<span class="sug-tile" style="' + shapeCss + 'background:' + esc(rt.color || '#8a94a6') + '">'
            + esc(d.plu_code || (d.item_name || '?').charAt(0).toUpperCase()) + '</span>';
    }
    var fields = o.sales && Array.isArray(d.sales_search_display_fields) ? d.sales_search_display_fields : null;
    var show = function (field) { return !fields || fields.indexOf(field) >= 0; };
    var meta = [];
    if (fields) {
        [['sku', 'Item code', d.itemid || d.item_code], ['barcode', 'Barcode', d.barcode_id],
         ['supplier', 'Supplier', d.supplier_name], ['category', 'Category', d.category_name]].forEach(function (entry) {
            if (show(entry[0]) && entry[2]) meta.push(esc(entry[1] + ': ' + entry[2]));
        });
    }
    if (!fields && (d.itemid || d.item_code)) { meta.push(esc(d.itemid || d.item_code)); }
    if (!fields && d.plu_code) { meta.push('#' + esc(d.plu_code)); }
    if (!fields && d.short_code) { meta.push(esc(d.short_code)); }
    if (!fields && d.barcode_id && d.barcode_id !== d.itemid) { meta.push(esc(d.barcode_id)); }
    if (!fields && d.unit) { meta.push(esc(d.unit)); }
    if (!fields && d.category_name) { meta.push(esc(d.category_name)); }
    var locationHtml = '';
    if (o.sales && fields && show('location') && Array.isArray(d.stock_locations) && d.stock_locations.length) {
        locationHtml = '<div class="sug-meta sug-location" style="white-space:normal;overflow-wrap:anywhere">'
            + '<lang class="lang_stock_locations">Stock locations</lang>: '
            + esc(d.stock_locations.join(' · ')) + '</div>';
    }
    var stock;
    if (d.item_kind === 'service') {
        stock = '<span class="sug-stock na"><lang class="lang_service">Service</lang></span>';
    } else if (d.track_inventory === false) {
        stock = '<span class="sug-stock na"><lang class="lang_not_tracked">Not tracked</lang></span>';
    } else {
        var q = Number(d.available_quantity) || 0;
        var low = parseFloat(PosnicPro.local.get('notificationrange'));
        if (!isFinite(low) || low <= 0) { low = 5; }
        if (q <= 0) { stock = '<span class="sug-stock out"><lang class="lang_out_of_stock_2">Out of stock</lang></span>'; }
        else if (q <= low) { stock = '<span class="sug-stock low">' + q + ' left</span>'; }
        else { stock = '<span class="sug-stock in">In stock ' + q + '</span>'; }
    }
    var priceHtml = o.price != null
        ? '<div class="sug-price">' + o.currency + '&nbsp;' + Number(o.price).toFixed(2)
            + (o.was != null ? '<del>' + o.currency + '&nbsp;' + Number(o.was).toFixed(2) + '</del>' : '')
            + '</div>'
        : '';
    if (!show('image')) thumb = '';
    if (!show('price')) priceHtml = '';
    if (!show('stock')) stock = '';
    return '<div class="sug-row">' + thumb
        + '<div class="sug-main"><div class="sug-name">' + nameHtml + '</div>'
        + (meta.length ? '<div class="sug-meta">' + meta.join(' &middot; ') + '</div>' : '')
        + locationHtml + '</div><div class="sug-side">' + priceHtml + stock + '</div></div>';
};
PosnicPro.sugActionRow = function (icon, cls, title, meta) {
    return '<div class="sug-row sug-action ' + cls + '">'
        + '<span class="sug-tile"><i class="feather ' + icon + '"></i></span>'
        + '<div class="sug-main"><div class="sug-name">' + title + '</div>'
        + '<div class="sug-meta">' + meta + '</div></div></div>';
};
PosnicPro.sales.chooseSellingUnit = function (item, done) {
    var id = item.id || item.item_id;
    var rows = [{ unit: item.unit || 'qty', factor: 1, price: Number(item.selling_price) }].concat(item.selling_units || []);
    var selectedUnit = null;
    var escapeUnit = function (value) { return String(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var buttons = [];
    rows.forEach(function (row, index) {
        var price = row.price == null ? Number(item.selling_price) * Number(row.factor) : Number(row.price);
        buttons.push('<button type="button" class="btn btn-outline-primary" data-selling-unit="' + index + '" style="min-height:64px;min-width:110px;flex:1 1 110px;white-space:normal"><strong>' + escapeUnit(row.unit) + '</strong><br><span>' + price.toFixed(2) + '</span></button>');
    });
    swal({ title: PosnicPro.i18n.t('lang_sell_by_which_unit', 'Sell by which unit?'),
        html: '<p>' + escapeUnit(item.item_name || item.name || '') + '</p><div id="selling-unit-buttons" style="display:flex;gap:12px;flex-wrap:wrap">' + buttons.join('') + '</div>',
        showCancelButton: true, showConfirmButton: false,
        onOpen: function () {
            var group = document.getElementById('selling-unit-buttons');
            if (!group) return;
            group.querySelectorAll('[data-selling-unit]').forEach(function (button) {
                button.addEventListener('click', function () {
                    if (selectedUnit !== null) return;
                    selectedUnit = button.getAttribute('data-selling-unit');
                    swal.clickConfirm();
                });
            });
            var first = group.querySelector('button');
            if (first) first.focus();
        },
        preConfirm: function () { return Promise.resolve(selectedUnit === null ? false : selectedUnit); }
    }).then(function (result) {
        if (!result || result.dismiss) return;
        var choice = rows[Number(typeof result === 'string' ? result : result.value)];
        if (!choice) return;
        var productId = item.product_id || item.item_id || item.id;
        var cart = PosnicPro.sales.SaleTableLineItems || {};
        var rowId = Object.keys(cart).find(function (key) {
            var row = cart[key];
            return String(row.product_id || row.item_id) === String(productId) && row.addSalesLineItemUnit === choice.unit;
        });
        if (!rowId) rowId = 'unit_' + crypto.randomUUID().replace(/-/g, '');
        var price = choice.price == null ? Number(item.selling_price) * Number(choice.factor) : Number(choice.price);
        done(Object.assign({}, item, { id: rowId, product_id: productId, line_id: rowId, unit: choice.unit, selling_price: Number(price.toFixed(2)), sale_inline_item_price: Number(price.toFixed(2)), discount_amount: Number((Number(item.discount_amount || 0) * Number(choice.factor)).toFixed(2)), available_quantity: Number(item.available_quantity || 0) / Number(choice.factor), unit_conversion: { unit: choice.unit, base_unit: item.unit || 'qty', factor: Number(choice.factor), whole_units: choice.whole_units === true }, _sellingUnitChosen: true, _wholeUnits: choice.whole_units === true }));
    });
};
// The same compact quantity popup serves tile and search selection.
PosnicPro.sales.weighEntry = async function (item, options) {
    options = options || {};
    var unit = String(item.unit || 'kg').trim().toLowerCase();
    var factor = ({ kg:1, kgs:1, kilogram:1, kilograms:1, g:1000, gm:1000, gram:1000, grams:1000, tonne:.001, tonnes:.001 })[unit];
    if (!factor) { PosnicPro.alert('warning', PosnicPro.i18n.t('lang_set_a_weight_unit_kg_g_or_tonnes_for_this', 'Set a weight unit (kg, g or tonnes) for this product.')); return null; }
    var price = Number(item.selling_price) || 0;
    var discount = Number(item.discount_amount) > 0 ? Number(item.discount_amount) : price * Math.max(0, Number(item.discount_percentage) || 0) / 100;
    var rate = Math.max(0, price - discount);
    if (Number.isFinite(options.lineRate)) rate = options.lineRate;
    var currency = PosnicPro.local.get('currencySign') || '';
    var mode = options.mode === 'amount' ? 'amount' : 'weight', source = 'scale', active = true, busy = false, timer, reading = null, stamp = 0;
    var branch = PosnicPro.local.get('branch_id_set'), epoch = 0;
    var esc = function (v) { return $('<span>').text(v).html(); };
    function update() {
        $('#weigh_amount_wrap').prop('hidden', mode !== 'amount');
        $('[data-weigh-mode]').each(function () { $(this).toggleClass('btn-primary', this.dataset.weighMode === mode).toggleClass('btn-outline-primary', this.dataset.weighMode !== mode); });
        $('[data-weigh-source]').each(function () { $(this).toggleClass('btn-primary', this.dataset.weighSource === source).toggleClass('btn-outline-primary', this.dataset.weighSource !== source); });
        $('#weigh_quantity').prop('readOnly', source === 'scale');
        var amount = Number($('#weigh_amount').val()), weight = Number($('#weigh_quantity').val());
        $('#weigh_target').text(amount > 0 && rate > 0 ? 'Target ' + (amount / (rate * factor)).toFixed(3) + ' kg · ' + Math.round(amount / (rate * factor) * 1000) + ' g' : 'Enter a positive amount.');
        $('#weigh_total').text(weight > 0 && Number.isFinite(weight) ? currency + (weight * factor * rate).toFixed(2) : '—');
    }
    async function read() {
        if (!active || source !== 'scale' || busy) return;
        var token = epoch; busy = true;
        try {
            if (!window.WeightBridge || !window.WeightBridge.isAvailable()) throw new Error('Scale unavailable. Connect a scale or select Manual.');
            var value = await window.WeightBridge.getCurrentWeight({ stableOnly: true });
            if (!active || source !== 'scale' || token !== epoch) return;
            if (!Number.isFinite(value) || value <= 0 || value > 100000) throw new Error('Waiting for a stable positive weight.');
            reading = Number(value.toFixed(3)); stamp = Date.now();
            $('#weigh_quantity').val(reading.toFixed(3)); $('#weigh_status').text(PosnicPro.i18n.t('lang_stable_scale_weight', 'Stable scale weight')); update();
        } catch (e) {
            if (active && token === epoch && source === 'scale') { reading = null; stamp = 0; $('#weigh_quantity').val(''); $('#weigh_status').text(e.message || 'Waiting for scale. Select Manual to enter weight.'); update(); }
        } finally { busy = false; }
    }
    try {
        var result = await swal({ title: PosnicPro.i18n.t('lang_quantity', 'Quantity'), width: 480,
            html: '<div style="text-align:left"><div class="d-flex justify-content-between mb-3"><strong>' + esc(item.item_name || item.name || '') + '</strong><span>' + esc(currency) + rate.toFixed(2) + ' / ' + esc(unit) + '</span></div>' +
            '<div class="d-flex justify-content-between flex-wrap mb-3" style="gap:8px"><div><button type="button" class="btn btn-sm btn-primary" data-weigh-mode="weight"><lang class="lang_weight">Weight</lang></button> <button type="button" class="btn btn-sm btn-outline-primary" data-weigh-mode="amount"><lang class="lang_amount_title">Amount</lang></button></div><div><button type="button" class="btn btn-sm btn-primary" data-weigh-source="scale"><i class="feather icon-anchor"></i> Scale</button> <button type="button" class="btn btn-sm btn-outline-primary" data-weigh-source="manual"><lang class="lang_manual">Manual</lang></button></div></div>' +
            '<div id="weigh_amount_wrap" hidden><label for="weigh_amount">Requested amount (' + esc(currency) + ')</label><input class="form-control" id="weigh_amount" type="number" min="0.01" step="0.01"><p id="weigh_target" class="my-2"></p></div>' +
            '<label for="weigh_quantity"><lang class="lang_measured_weight_kg">Measured weight (kg)</lang></label><input class="form-control" style="font-size:24px" id="weigh_quantity" type="number" step="0.001" min="0.001" readonly><small id="weigh_status" role="status">Waiting for scale…</small>' +
            '<div class="d-flex justify-content-between mt-3"><span><lang class="lang_line_total">Line total</lang></span><strong id="weigh_total" style="font-size:22px">—</strong></div></div>',
            showCancelButton: true, confirmButtonText: options.confirmButtonText || 'Add to sale',
            onOpen: function () {
                $('[data-weigh-mode]').on('click', function () { mode = this.dataset.weighMode; update(); if (mode === 'amount') $('#weigh_amount').focus(); });
                $('[data-weigh-source]').on('click', function () { source = this.dataset.weighSource; epoch++; reading = null; stamp = 0; $('#weigh_quantity').val(''); $('#weigh_status').text(source === 'manual' ? 'Manually entered weight' : 'Waiting for scale…'); update(); if (source === 'manual') $('#weigh_quantity').focus(); else read(); });
                $('#weigh_quantity,#weigh_amount').on('input', update).on('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.originalEvent || !e.originalEvent.repeat) swal.clickConfirm(); } });
                update(); read(); timer = setInterval(read, 800);
            },
            preConfirm: function () {
                var text = String($('#weigh_quantity').val()), weight = Number(text), amountText = String($('#weigh_amount').val()), amount = Number(amountText);
                if (!/^\d+(\.\d{1,3})?$/.test(text) || !Number.isFinite(weight) || weight <= 0 || weight > 100000) return Promise.reject('Enter a positive weight with up to three decimal places.');
                if (source === 'scale' && (!reading || Date.now() - stamp > 2500)) return Promise.reject('Wait for a fresh stable scale reading.');
                if (mode === 'amount' && (!/^\d+(\.\d{1,2})?$/.test(amountText) || amount <= 0 || amount > 1000000000 || !Number.isFinite(rate) || rate <= 0)) return Promise.reject('Enter a valid amount and use a product with a positive selling price.');
                var quantity = Number((weight * factor).toFixed(3));
                if (quantity <= 0 || quantity > 100000 || Math.abs(quantity - weight * factor) > 1e-7) return Promise.reject('Use kg or g so this weight can be billed accurately to three decimals.');
                return Promise.resolve({ quantity: quantity, total: Number((quantity * rate).toFixed(2)), amount: amount, mode: mode, weight: weight });
            },
            onClose: function () { active = false; clearInterval(timer); }
        });
        active = false; clearInterval(timer);
        if (!result || result.dismiss || branch !== PosnicPro.local.get('branch_id_set')) return null;
        result = result.value || result;
        if (result.mode === 'amount' && Math.round(result.total * 100) !== Math.round(result.amount * 100)) {
            var accepted = await swal({ title: PosnicPro.i18n.t('lang_confirm_actual_amount', 'Confirm actual amount'), text: result.weight.toFixed(3) + ' kg costs ' + currency + result.total.toFixed(2) + '. Requested ' + currency + result.amount.toFixed(2) + '.', showCancelButton: true, confirmButtonText: 'Add at ' + currency + result.total.toFixed(2) });
            if (!accepted || accepted.dismiss) return null;
        }
        return branch === PosnicPro.local.get('branch_id_set') ? result.quantity : null;
    } catch (_) { return null; }
    finally { active = false; clearInterval(timer); }
};

PosnicPro.sales.askSearchQuantity = function (item, id) {
    if (id && !item._searchDetailsLoaded) {
        PosnicPro.sales.itemCache.get(id, function (details) {
            PosnicPro.sales.askSearchQuantity(Object.assign({}, details, { _searchDetailsLoaded: true }), id);
        });
        return;
    }
    if (item.selling_units && item.selling_units.length && !item._sellingUnitChosen) {
        PosnicPro.sales.chooseSellingUnit(item, function (chosen) { PosnicPro.sales.askSearchQuantity(chosen, id); }); return;
    }
    var weighed = PosnicPro.sales.isWeighedItem && PosnicPro.sales.isWeighedItem(item);
    if (weighed && PosnicPro.sales.SaleAction !== 'return') {
        item = PosnicPro.sales._applyPriceList(item);
        PosnicPro.sales.weighEntry(item).then(function (qty) {
            if (qty == null) return;
            var current = Number($('#touchsale_item_qty' + id).val()) || 0;
            if ([true, 'true'].includes(item.track_inventory) && ![true, 'true'].includes(item.negative_stock) && qty + current > Number(item.available_quantity || 0)) {
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_measured_weight_exceeds_available_stock', 'Measured weight exceeds available stock.')); return;
            }
            PosnicPro.sales.addSalesLineItems(Object.assign({}, item, { item_quantity: qty, _quantityConfirmed: true }));
            $('#sales_new_item_name').focus();
        });
        return;
    }

    var settings = {};
    try { settings = JSON.parse(PosnicPro.local.get('general_settings') || '{}'); } catch (_) { /* manual entry */ }
    var scaleOn = settings.hardware_weight_machine_enable === true || settings.hardware_weight_machine_enable === 'true';
    var readScale = weighed && scaleOn && window.WeightBridge && window.WeightBridge.isAvailable();
    var request = PosnicPro.sales._searchQuantityRequest = (PosnicPro.sales._searchQuantityRequest || 0) + 1;
    swal({
        title: PosnicPro.i18n.t('lang_quantity', 'Quantity'),
        text: item.item_name || item.name || '', input: 'text', inputValue: readScale ? '' : '1', animation: false,
        inputAttributes: { min: '0.001', max: '100000', step: 'any', inputmode: 'decimal' },
        showCancelButton: true,
        onOpen: function () {
            var input = document.querySelector('.swal2-input');
            if (!input) return;
            var edited = false;
            input.addEventListener('input', function () { edited = true; });
            $(input).off('keydown.salesQuantity').on('keydown.salesQuantity', function (event) {
                if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!event.originalEvent || !event.originalEvent.repeat) swal.clickConfirm();
            });
            setTimeout(function () { if (input.isConnected) { input.focus(); input.select(); } }, 0);
            if (readScale) {
                window.WeightBridge.getCurrentWeight({ stableOnly: true }).then(function (weight) {
                    // A cancelled/replaced dialog or a manual edit owns its quantity.
                    if (request !== PosnicPro.sales._searchQuantityRequest || edited || !input.isConnected || document.querySelector('.swal2-input') !== input) return;
                    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100000) return;
                    input.value = weight.toFixed(3);
                    swal.clickConfirm();
                }).catch(function () { /* Leave manual quantity entry available. */ });
            }
        },
        confirmButtonText: PosnicPro.i18n.t('lang_add_to_sale', 'Add to sale'),
        inputValidator: function (value) {
            return new Promise(function (resolve, reject) {
                if (Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100000 && (!item._wholeUnits || Number.isInteger(Number(value)))) resolve();
                else reject(PosnicPro.i18n.t('lang_enter_a_valid_quantity', 'Enter a valid quantity.'));
            });
        }
    }).then(function (result) {
        if (request !== PosnicPro.sales._searchQuantityRequest) return;
        PosnicPro.sales._searchQuantityRequest++;
        if (!result || result.dismiss) { $('#sales_new_item_name').focus(); return; }
        var qty = Number(typeof result === 'string' || typeof result === 'number' ? result : result.value);
        if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return;
        if (item._sellingUnitChosen) id = item.id;
        function add(details) {
            var current = Number($('#touchsale_item_qty' + id).val()) || 0;
            if (PosnicPro.sales.SaleAction !== 'return' && (details.track_inventory === true || details.track_inventory === 'true') && details.negative_stock !== true && details.negative_stock !== 'true' && qty + current > Number(details.available_quantity || 0)) {
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                $('#sales_new_item_name').focus(); return;
            }
            PosnicPro.sales.addSalesLineItems(Object.assign({}, details, { item_quantity: qty, _quantityConfirmed: true }));
            if (!$('.modal.show:visible, .swal2-modal:visible').length) $('#sales_new_item_name').focus();
        }
        add(item);
    }).catch(function () { $('#sales_new_item_name').focus(); });
};

/* Owner: typing here must NEVER wait. One-time widget init (the old code
   re-created the whole autocomplete on every keydown AND keyup), requests
   use the loaded catalogue immediately, and late responses for stale queries are
   dropped. The lookup itself is async - the input never blocks on it. */
$(function () {
    var itemLookupSeq = 0;
    $('#sales_new_item_name').autocomplete({
        deferRequestBy: 0,
        lookup: function (query, done) {
            var seq = ++itemLookupSeq;
            var result = {};
            var suggestions = [];
            var params = {
                url: 'items/getOnlineItemsAjaxList',
                data: { query: query, type: 'normal', limit: 20 }
            };
            function receive(response) {
                response = response || { suggestions: [] };
                response.suggestions = response.suggestions || [];
                if (seq !== itemLookupSeq) { return; }
                if (response.suggestions.length > 0) {
                    $.map(response.suggestions, function (dataItem) {
                        let items_expiry_date = dataItem.items_expiry_date;
                        if (!PosnicBillingSearch.expired(items_expiry_date)) {
                            suggestions.push({ "value": PosnicPro.itemName ? PosnicPro.itemName(dataItem) : dataItem.item_name, "data": dataItem });
                        }
                    });
                } else if (PosnicPro.sales.applyQuickSaleGate()) {
                    suggestions.push({ value: query + ' ', data: { __action: 'quick' } });
                }
                // A repeated code needs an explicit choice, never a silent first-item match.
                $('#sales_new_item_name').autocomplete('setOptions', { autoSelectFirst: suggestions.length === 1 && !suggestions[0].data.__action });
                result["suggestions"] = suggestions;
                done(result);
            }
            PosnicPro.get(params, receive, function () {
                if (seq === itemLookupSeq) done({ suggestions: [] });
            });
        },
        onSelect: function (suggestion) {
            var act = suggestion.data && suggestion.data.__action;
            if (act) {
                var typed = (suggestion.value || '').trim();
                $('#sales_new_item_name').val('');
                if (act === 'quick') {
                    PosnicPro.sales.quickSale.open();
                    $('#quick_sale_note').val(typed);
                }
                return;
            }
            if (suggestion.data !== -1) {
                $('#sales_new_item_name').val('');
                $('#sales_new_item_name').focus();
                (PosnicPro.sales.SaleAction === 'return') ? PosnicPro.sales.salesExchange = true : PosnicPro.sales.salesExchange = false;

                var itemData = suggestion.data || {};

                var selectedId = itemData.item_id || itemData.id || (itemData._id && itemData._id.$oid);
                PosnicPro.sales.askSearchQuantity(itemData, selectedId);

            }
        },
        autoSelectFirst: false,
        tabDisabled: false,
        triggerSelectOnValidInput: false,
        formatResult: function (suggestion, currentValue) {
            var act = suggestion.data && suggestion.data.__action;
            if (act) {
                var typedName = $('<i>').text((suggestion.value || '').trim()).html();
                return PosnicPro.sugActionRow('icon-zap', 'quick',
                    PosnicPro.i18n.t('lang_quick_sale_autocomplete', 'Sell "%s" as a quick sale')
                        .replace('%s', typedName),
                    PosnicPro.i18n.t('lang_quick_sale_autocomplete_hint', 'Nothing saved - just enter the amount'));
            }
            {
                var currency = PosnicPro.local.get('currencySign');
                var pricing = PosnicBillingSearch.price(suggestion.data);
                return PosnicPro.sugRow(suggestion.data,
                    $.Autocomplete.formatResult(suggestion, currentValue), {
                        sales: true, currency: currency, price: pricing.price, was: pricing.was
                    });
            }
        }
    });
});

$(document).ready(function () {
    $('#sales_new_item_name').focus();
    $('#sales_new_balance_amount').addClass('bg-white');
    PosnicPro.commonDate();
    // Add active class to the current button (highlight it)
    $('.button-list-categories').click(function () {
        $('.button-list-categories').removeClass('selectedTab');
        $(this).addClass('selectedTab');
    });
});

var substringMatcher = function (strs) {
    return function findMatches(q, cb) {
        var matches = [];

        // Escape special characters for regex
        var escapeRegex = function(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        };

        // Split query into words and filter out empty strings
        var tokens = q.trim().split(/\s+/).filter(function(token) {
            return token.length > 0;
        });

        if (tokens.length === 0) {
            cb([]);
            return;
        }

        // Create regex for each token
        var tokenRegexes = tokens.map(function(token) {
            return new RegExp(escapeRegex(token), 'i');
        });

        // Iterate through the pool of strings
        $.each(strs, function (i, str) {
            // Check if ALL tokens match the string
            var allMatch = tokenRegexes.every(function(regex) {
                return regex.test(str);
            });

            if (allMatch) {
                matches.push(str);
            }
        });

        cb(matches);
    };
};
/*
 * Recency lists (owner feedback): the pickers open with the last 10 picks
 * of THIS till, kept as a tiny localStorage LRU written at pick time - the
 * international "recents" pattern, zero server queries, zero aggregation.
 */
PosnicPro.sales._recentGet = function (key) {
    try { return JSON.parse(PosnicPro.local.get(key) || '[]'); } catch (e) { return []; }
};
PosnicPro.sales._recentPush = function (key, entry, idField) {
    if (!entry || !entry[idField]) { return; }
    var list = PosnicPro.sales._recentGet(key).filter(function (r) {
        return String(r[idField]) !== String(entry[idField]);
    });
    list.unshift(entry);
    PosnicPro.local.set(key, JSON.stringify(list.slice(0, 10)));
};
/* ONE customer-pick path: search results and recent rows both land here. */
// Read the same ledger totals used by Customer Details. Preserve their sign;
// never add this account balance to the current invoice or tender amount.
PosnicPro.sales.refreshCustomerAccount = function () {
    var id = String($('#sales_new_customer_id').val() || '');
    var request = PosnicPro.sales._accountRequest = (PosnicPro.sales._accountRequest || 0) + 1;
    var target = $('.sale-customer-account').empty().hide();
    var branch = PosnicPro.local.get('branch_id_set');
    if (!/^[a-f0-9]{24}$/i.test(id)) return;
    var t = function (key, fallback) { return PosnicPro.i18n.t(key, fallback); };
    target.text(t('lang_loading', 'Loading…')).show();
    var current = function () { return branch === PosnicPro.local.get('branch_id_set') && request === PosnicPro.sales._accountRequest && String($('#sales_new_customer_id').val()) === id; };
    var failed = function () {
        if (current()) target.text(t('lang_account_balance_unavailable', 'Previous account balance unavailable. Check customer details.')).show();
    };
    PosnicPro.get({ url: 'customers/transactionDetails', data: {
        customer_id: id, branch: [PosnicPro.local.get('branch_id_set')], page: 1, limit: 1
    } }, function (response) {
        if (!current()) return;
        if (!response || response.type !== 'success' || !response.data) { failed(); return; }
        var pending = Number(response.data.pending), wallet = Number(response.data.wallet);
        if (!Number.isFinite(pending) || !Number.isFinite(wallet)) { failed(); return; }
        var balance = wallet < 0 && pending >= 0 ? pending + Math.abs(wallet) : pending;
        target.empty().show().append($('<span>').text(
            t('lang_previous_account_balance', 'Previous account balance') + ': ' +
            (PosnicPro.local.get('currencySign') || '') + ' ' + balance.toFixed(2) + ' '
        ));
        target.append($('<a>').attr('href', '#/customers/' + id).text(t('lang_view_details', 'View details')));
    }, failed);
};
PosnicPro.sales.applyCustomerPick = function (data) {
    var customerRecord = [];
    PosnicPro.local.set('customerName', data.name);
    PosnicPro.local.set('customerPhone', data.phone);
    PosnicPro.local.set('customerEmail', data.email);
    PosnicPro.local.set('customerAddress', data.address);
    $('#sales_new_customer_id').val(data.id);
    $('#sales_new_customer_name').val(data.name);
    $('#sales_new_customer_address').val(data.address);
    $('#sales_new_customer_phone').val(data.phone);
    $('#sales_new_customer_email').val(data.email);
    $('#sales_new_customer_state').val(data.state);
    $('#sales_new_customer_country').val(data.country);
    $('#sales_new_customer_partial_balance').val(data.partial_balance);
    $('#customer_current_balance').val(data.balance);
    PosnicPro.sales.refreshCustomerAccount();
    // Price lists (V4): remember this customer's category so newly added
    // lines price from their list; fetch when the payload lacks it.
    PosnicPro.sales._customerCategoryId = String(data.category_id || '');
    if (!PosnicPro.sales._customerCategoryId && data.id) {
        PosnicPro.get('customers/' + data.id, function (r) {
            if (r && r.data && String($('#sales_new_customer_id').val()) === String(data.id)) {
                PosnicPro.sales._customerCategoryId = String(r.data.category_id || '');
            }
        }, function () { /* no category, no list */ });
    }
    customerRecord.push({ name: data.name, phone: data.phone, email: data.email, address: data.address });
    db.customerDisplay.put({ id: '1', clear: 'no', 'get': 'no', customer: customerRecord });
    PosnicPro.sales.calculation.salesTableRowCart();
    if (PosnicPro.sales.updateCustomerChip) PosnicPro.sales.updateCustomerChip();
    PosnicPro.sales.setCustomerPopup(false);
    $('#sales_customer_search').prop('hidden', true);
    PosnicPro.sales._recentPush('recent_customers', {
        id: data.id, name: data.name, phone: data.phone, email: data.email,
        address: data.address, state: data.state, country: data.country,
        partial_balance: data.partial_balance, balance: data.balance,
        category_id: data.category_id
    }, 'id');
};
PosnicPro.sales._customerSeed = null;
PosnicPro.sales.renderRecentCustomers = function () {
    var recents = PosnicPro.sales._recentGet('recent_customers');
    var wrap = $('#sales_recent_customers');
    var paint = function (rows) {
        if (!rows.length) { wrap.html('').hide(); return; }
        PosnicPro.sales._recentRendered = rows;
        wrap.html(rows.map(function (c, i) {
            var icon = c._seed ? 'icon-user' : 'icon-clock';
            return '<a href="javascript:void(0)" class="sales-customer-pop-action recent-customer-row" data-i="' + i + '">' +
                '<i class="feather ' + icon + ' mr-2"></i>' + $('<span>').text(c.name).html() +
                (c.phone ? ' <small class="text-muted">' + $('<span>').text(c.phone).html() + '</small>' : '') +
                '</a>';
        }).join('')).show();
    };
    /* Recents lead; the plain paged customer list (an indexed find, no
       aggregation) fills the card to 10 so it is never empty on a fresh
       till - the seed is cached per session. */
    var fill = function (seed) {
        var have = {};
        recents.forEach(function (c) { have[String(c.id)] = 1; });
        var rows = recents.slice();
        (seed || []).forEach(function (c) {
            if (rows.length >= 10 || have[String(c.id)]) { return; }
            rows.push(c);
        });
        paint(rows);
    };
    if (recents.length >= 10) { paint(recents); return; }
    if (PosnicPro.sales._customerSeed) { fill(PosnicPro.sales._customerSeed); return; }
    fill([]); // paint what we have instantly; the seed follows
    PosnicPro.get({ url: 'customers', data: { page: 1, limit: 10 } }, function (response) {
        var list = (response && response.data && response.data.list) || [];
        PosnicPro.sales._customerSeed = list.map(function (c) {
            return {
                id: c._id || c.id, name: c.name, phone: c.phone, email: c.email,
                address: c.address, state: c.state, country: c.country,
                partial_balance: c.partial_balance, balance: c.balance,
                category_id: c.category_id, _seed: true
            };
        }).filter(function (c) {
            return c.id && c.name && !PosnicPro.isWalkInName(c.name);
        });
        fill(PosnicPro.sales._customerSeed);
    }, function () { /* recents alone, or empty - never an error popup */ });
};
$(document).on('click', '#sales_export_filtered', function () {
    var selection = Object.assign({}, PosnicPro.sales._lastHistoryQuery);
    delete selection.include_summary;
    PosnicPro.listExport.all({
        url:'sales', filename:'sales-history.csv',
        params:function (page,limit) { return Object.assign({},selection,{page:page,limit:limit}); },
        head:['Sale ID','Customer','Sold by','Sale date','Items','Total','Payment status'],
        map:function (sale) { return [sale.sales_id,sale.customer_name,sale.sold_by || '',sale.date,
            sale.number_of_items,sale.sales_total,sale.payment_status]; }
    });
});
$(document).on('click', '#sales_filter_btn', function () {
    PosnicPro.sales.mountHistoryFilters();
    PosnicPro.listFilter.openOptions(document.getElementById('sales_filter_dialog'), $(this));
    $('#sales_filter_dialog').triggerHandler('salesOpen');
    $('#sales_filter_dialog').off('close.suggestions').on('close.suggestions',function(){
        $(this).find('input').each(function(){ var ac=$(this).data('autocomplete'); if(ac) ac.hide(); });
    });
    $('#sales_filter_search .lf-q').trigger('focus');
});
$(document).on('click', '[data-close-sales-filter]', function () {
    this.closest('dialog').close();
});

$(document).on('click', '.recent-customer-row', function () {
    var list = PosnicPro.sales._recentRendered || [];
    var c = list[$(this).data('i')];
    if (c) { PosnicPro.sales.applyCustomerPick(c); }
});

/******** START SALES SEARCH CUSTOMER FUNCTION ONLINE ********/
/* Same never-block treatment as the item box: init once, debounce,
   drop stale responses. */
$(function () {
    var customerLookupSeq = 0;
    $('#sales_new_customer_name').autocomplete({
        appendTo: '#sales_customer_results',
        deferRequestBy: 120,
        lookup: function (query, done) {
            var seq = ++customerLookupSeq;
            var result = {};
            var suggestions = [];
            var params = {
                url: 'customers/getCustomersAjaxList',
                data: 'query=' + encodeURIComponent(query)
            };
            PosnicPro.get(params, function (response) {
                if (seq !== customerLookupSeq) { return; }
                if (response.suggestions.length > 0) {
                    $.map(response.suggestions, function (dataItem) {
                        suggestions.push({ "value": dataItem.name, "data": dataItem });
                    });
                } else {
                    suggestions.push({ value: query + ' ', data: -1 });
                }
                result["suggestions"] = suggestions;
                done(result);
            });
        },
        onSelect: function (suggestion) {
            if (suggestion.data !== -1) {
                PosnicPro.sales.applyCustomerPick(suggestion.data);
            } else {
                $('#sales_new_customer_name').val(suggestion.value.trim()).trigger('input');
                PosnicPro.sales.setCustomerPopup(true);
            }
        },
        autoSelectFirst: false,
        triggerSelectOnValidInput: false,
        formatResult: function (suggestion) {
            let phone = suggestion.data.phone;
            if (suggestion.data === -1 || typeof suggestion.phone === undefined) {
                phone = 'New customer · saved with sale';
            }
            let partial_balance_span = "";
            if (suggestion.data.partial_balance === true) {
                let currency = PosnicPro.local.get('currencySign');
                let balance = suggestion.data.balance;
                partial_balance_span = '<span class="pull-left font-weight-bold">' + currency + '&nbsp;' + balance.toFixed(2) + '</span>';
            }
            return '<div>' +
                $.Autocomplete.formatResult(suggestion) +
                '</div>' + partial_balance_span + '<span class="pull-right">' + phone + '</span>';
        }
    });
});
/******** END SALES SEARCH CUSTOMER FUNCTION ONLINE ********/

$("#sales_new").click(function (e) {
    if ($(e.target).hasClass('osk-trigger')) {
        return false;
    }
    $('#osk-container').hide();
});
$(document).ready(function () {
    $("#sales_new_items_table tbody tr").remove();
    $('#sales_new_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="8"><div class="text-center text-dark"> <p class="table_cart_content"> <lang class="lang_sale_empty">Sale Order Empty</lang></p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
    $("#sales_return_items_table tbody tr").remove();
    $('#sales_return_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="9"><div class="text-center text-dark"> <p class="table_cart_content"><lang class="lang_empty_return">Return Items Order Empty</lang></p></div></td></tr>');
    var imgHeight = $(window).height() - 500;
    $('.sales-cart-image').height(imgHeight);
    $(".changeSales").click(function () {
        $('#tender_amount').val(-Math.abs($('#refund_grand_total').html().replace(/,/g, '')));
    });
    $('.discount_amount_display').hide();
    $('.discount_percentage_display').show();
    db.customerDisplay.where("clear").equals("yes").delete();
});
var $table = $('.tableFixHead').find('thead th')
$('.tableFixHead').on('scroll', function () {
    $table.css('transform', 'translateY(' + this.scrollTop + 'px)');
});
// Customer chip on the sales screen: reflect who the sale is for. "Walk-in"
// (muted user icon) when no customer is set; the customer's name (accent,
// checked icon, name + phone on hover) once one is chosen. Kept in sync from
// the autocomplete select, the new-sale reset and the edit-sale load.
/*
 * Notes edit in place (owner: the popup "can be better. UX Feel").
 * Clicking the pencil opens an input right where the note lives, with the
 * cursor already in it - Enter saves, Escape cancels, clicking away saves.
 * The popup it replaces was a dialog for one short line of text, and it
 * needed a polling loop just to land focus inside its own textarea.
 *
 * The hidden <a> keeps being the value carrier, so every save payload
 * still reads $('#payment_description').val() exactly as it did before.
 */
/*
 * Actions that a manager PIN can unlock wear a small lock (owner ask): a
 * cashier who cannot discount on their own should SEE that the button still
 * works and why it will ask for a PIN, rather than pressing it and being
 * surprised. Hovering says so in words. Actions the user can simply perform
 * carry no lock, so the badge means exactly one thing.
 */
/*
 * The notes cell spans the Sub Total / Discount / Additional Discount rows so
 * the chips can use that whole block. The Additional Discount row is shown and
 * hidden on demand, though, and a cell spanning a row that is not there makes
 * the table render short - so the span follows the row.
 */
PosnicPro.sales.syncNotesCellSpan = function () {
    var $cell = $('#payment_note');
    if (!$cell.length) { return; }
    var extraVisible = $('.add-disc-row').is(':visible');
    $cell.attr('rowspan', extraVisible ? 3 : 2);
    PosnicPro.sales.syncDiscountNoteChip(extraVisible);
};

/*
 * "Discount note" only exists once there is a discount to explain.
 *
 * The chip sat beside Payment note and Sale note from the moment the screen
 * loaded, so a cashier could write a note about a discount nobody had given.
 * The note then described nothing, and on a busy counter an action that does
 * not apply yet is read as one that is broken.
 *
 * It follows the discount row, which is the same signal the rowspan above
 * already uses - so the chip appears the instant a discount is added and goes
 * again if it is removed. The wording changes with the note itself: a blank
 * one invites a note, an existing one offers to change it, which is the
 * difference between "what happens if I press this" and knowing.
 *
 * Hidden by inline display rather than a class, because syncActionTooltips
 * below reads btn.style.display to decide whether the tooltip wrapper should
 * follow - a class would leave a tooltip floating over nothing.
 */
PosnicPro.sales.syncDiscountNoteChip = function (hasDiscount) {
    var $chip = $('#click_discount_description');
    if (!$chip.length) { return; }

    if (hasDiscount === undefined) {
        hasDiscount = $('.add-disc-row').is(':visible');
    }

    $chip.get(0).style.display = hasDiscount ? '' : 'none';

    if (hasDiscount) {
        var note = $.trim($('#discount_description').val() || $('#discount_description').text() || '');
        var $label = $chip.find('lang');
        var text = note ? PosnicPro.i18n.t('lang_edit_note', 'Edit note') : PosnicPro.i18n.t('lang_add_note', 'Add note');
        /* The translated span is left in place and only its text replaced, so
           the language layer still finds the element it expects. */
        if ($label.length) { $label.text(text); } else { $chip.text(text); }
        $chip.attr('data-label', note ? PosnicPro.i18n.t('lang_edit_discount_note', 'Edit discount note') : PosnicPro.i18n.t('lang_add_discount_note', 'Add discount note'));
    }

    if (PosnicPro.sales.syncActionTooltips) { PosnicPro.sales.syncActionTooltips(); }
};
$(document).on('click', '#sale_add_discount', function () {
    setTimeout(function () { PosnicPro.sales.syncNotesCellSpan(); }, 80);
});
/* Removing a discount hides the row again, and typing a note changes the
   chip from "Add" to "Edit", so both are followed rather than only the add. */
$(document).on('click', '.add-disc-row .remove-discount, #sale_remove_discount', function () {
    setTimeout(function () { PosnicPro.sales.syncNotesCellSpan(); }, 80);
});
$(document).on('change blur', '#discount_description', function () {
    PosnicPro.sales.syncDiscountNoteChip();
});
/*
 * Keep each action's tooltip wrapper in step with its button.
 *
 * Every button in the sale action row sits inside a
 * <span data-toggle="tooltip">, and the code hides the BUTTON. The span
 * keeps its width and its tooltip, so resuming a parked sale left an
 * invisible Clear Sale that still said "Clear Sale" on hover - a tooltip
 * for a control that is not there.
 *
 * The button's inline display is the thing to read, not :visible: once the
 * wrapper is hidden every child reports invisible, and the button could
 * never be shown again.
 */
PosnicPro.sales.syncActionTooltips = function () {
    $('#edit_style_button > span[data-toggle="tooltip"]').each(function () {
        var btn = $(this).children('button, a').get(0);
        if (!btn) { return; }
        var hidden = btn.style.display === 'none';
        $(this).css('display', hidden ? 'none' : '');
        if (hidden) {
            // a tooltip already on screen when its button goes must go too
            try { $(this).tooltip('hide'); } catch (e) { /* not initialised yet */ }
        }
    });
};
PosnicPro.sales.markLockedActions = function () {
    var mark = function (sel, perm, what) {
        var $el = $(sel);
        if (!$el.length) { return; }
        var locked = PosnicPro.posCan && !PosnicPro.posCan(perm);
        $el.toggleClass('needs-approval', !!locked);
        if (locked) {
            $el.attr('title', what + ' needs a manager\'s approval - you can still do it, a manager just enters their PIN.');
        } else if (($el.attr('title') || '').indexOf('manager') !== -1) {
            $el.removeAttr('title');
        }
    };
    mark('#sale_add_discount', 'discount_apply', 'Applying a discount');
    mark('#sale_add_charge', 'discount_apply', 'Adding a charge');
};
PosnicPro.sales.noteEdit = {
    open: function (linkId, fieldId, placeholder, maxLen) {
        var $link = $('#' + linkId);
        var $field = $('#' + fieldId);
        if (!$link.length || !$field.length) { return; }
        var $open = $link.next('.note-inline');
        if ($open.length) { $open.find('input').focus(); return; }

        var before = String($field.val() || '');
        var $wrap = $('<span class="note-inline"></span>');
        var $in = $('<input type="text" class="form-control form-control-sm note-inline-input">')
            .attr({ maxlength: maxLen || 500, placeholder: placeholder || 'Add a note' })
            .val(before);
        var $ok = $('<a href="javascript:void(0)" class="note-inline-ok" title="Save note" data-t-title="lang_save_note"><i class="feather icon-check"></i></a>');
        $wrap.append($in).append($ok);
        $link.hide().after($wrap);

        var done = false;
        var close = function (save) {
            if (done) { return; }
            done = true;
            var text = save ? $.trim($in.val()) : before;
            $field.val(text);
            $wrap.remove();
            $link.show();
            if (PosnicPro.updateSaleNoteFlag) {
                PosnicPro.updateSaleNoteFlag(linkId, 'feather icon-edit-1', text);
            }
        };
        // mousedown, not click: blur would fire first and close the editor
        $ok.on('mousedown', function (e) { e.preventDefault(); close(true); });
        $in.on('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); close(true); }
            if (e.key === 'Escape') { e.preventDefault(); close(false); }
        });
        $in.on('blur', function () { setTimeout(function () { close(true); }, 120); });
        setTimeout(function () {
            $in.focus();
            var el = $in.get(0);
            if (el && el.setSelectionRange) { el.setSelectionRange(el.value.length, el.value.length); }
        }, 0);
    }
};
$(document).on('click', '#click_payment_description', function (e) {
    e.preventDefault(); e.stopPropagation();
    PosnicPro.sales.noteEdit.open('click_payment_description', 'payment_description', 'Payment note', 500);
});
$(document).on('click', '#click_sales_description', function (e) {
    e.preventDefault(); e.stopPropagation();
    PosnicPro.sales.noteEdit.open('click_sales_description', 'sales_description', 'Sale note', 500);
});
$(document).on('click', '#click_discount_description', function (e) {
    e.preventDefault(); e.stopPropagation();
    PosnicPro.sales.noteEdit.open('click_discount_description', 'discount_description', 'Why this discount?', 2500);
});
/*
 * Last line of defence before a save: a sale is always billed to someone,
 * so if no customer is set, fall back to the branch's cached Walk-in.
 * defaultcustomerSet() fills the fields from the server and caches the
 * record, but it is ASYNC - a cashier who scans and hits Pay immediately
 * can beat it. This is the synchronous half, reading that cache, so the
 * save path never has to refuse a walk-in sale.
 */
PosnicPro.sales.ensureCustomer = function () {
    if ($.trim($('#sales_new_customer_name').val() || '') !== '') { return; }
    var def = null;
    try { def = JSON.parse(PosnicPro.local.get('defaultcustomer') || 'null'); } catch (e) { return; }
    if (!def || !def.customer_name) { return; }
    $('#sales_new_customer_id').val(def.customer_id || '');
    $('#sales_new_customer_name').val(def.customer_name);
    $('#sales_new_customer_address').val(def.customer_address || '');
    $('#sales_new_customer_phone').val(def.customer_phone || '');
    $('#sales_new_customer_email').val(def.customer_email || '');
    $('#sales_new_customer_state').val(def.customer_state || '');
    if (PosnicPro.sales.updateCustomerChip) { PosnicPro.sales.updateCustomerChip(); }
};
PosnicPro.sales.updateCustomerChip = function () {
    var $btn = $('#sales_customer_btn');
    if (!$btn.length) { return; }
    var id = ($('#sales_new_customer_id').val() || '').trim();
    var name = ($('#sales_new_customer_name').val() || '').trim();
    var phone = ($('#sales_new_customer_phone').val() || '').trim();
    var $icon = $btn.children('i.feather');
    // The branch's own Walk-in record is a real customer with a real id, so
    // reading the chip off the id alone showed its record name where the
    // cashier expects "Walk-in". Treat "customer is the default" as walk-in.
    var isDefaultCustomer = false;
    if (id) {
        try {
            var def = JSON.parse(PosnicPro.local.get('defaultcustomer') || '{}');
            isDefaultCustomer = !!(def && def.customer_id && String(def.customer_id) === String(id));
        } catch (e) { isDefaultCustomer = false; }
    }
    if (id && !isDefaultCustomer) {

        $btn.addClass('has-customer');
        $icon.removeClass('icon-user icon-user-check').addClass('icon-sliders');
        var tip = (name || 'Customer') + (phone ? ' · ' + phone : '');
        $btn.attr('data-original-title', tip).attr('title', tip).attr('aria-label', 'Customer: ' + tip);
    } else {

        $btn.removeClass('has-customer');
        $icon.removeClass('icon-user icon-user-check').addClass('icon-sliders');
        var t = name || PosnicPro.i18n.t('lang_customer_details', 'Customer details');
        $btn.attr('data-original-title', t).attr('title', t).attr('aria-label', 'Customer: ' + t);
    }
};
// Super-admin "lock sale date": when the setting is off, the New Sale date is
// pinned to the current date/time and the picker is disabled, so cashiers can't
// backdate a sale. The value is set explicitly so it is never blank on submit;
// this fails open (stays editable) on any error or if the setting is unset.
PosnicPro.sales.applySaleDateLock = function () {
    if (PosnicPro.local.get('allow_sale_date_edit') !== 'false') { return; }
    try {
        var tz = PosnicPro.timeZone();
        var now = moment(new Date()).tz(tz).format('YYYY/MM/DD hh:mm A');
        var $d = $('#time-format');
        if ($d.data('datepicker') && typeof $d.data('datepicker').destroy === 'function') {
            $d.data('datepicker').destroy();
        }
        $d.removeClass('commonDate').off('click').val(now)
            .attr('readonly', true).css({ 'pointer-events': 'none' });
    } catch (e) { /* fail open: leave the date editable */ }
};
PosnicPro.sales.setCustomerPopup = function (open, returnFocus) {
    $('.toggle-customer-user').toggle(open);
    $('#sales_customer_btn').attr('aria-expanded', String(open));
    if (open) {
        $('#sales_customer_search').prop('hidden', true);
        $('#sales_customer_detail_name').text($('#sales_new_customer_name').val() || 'Walk-in customer');
        $('#sales_customer_status').text($('#sales_new_customer_id').val() ? '' : 'New customer will be saved with the sale.');
        $('#sales_new_customer_phone').trigger('focus');
    } else {
        $('#sales_customer_results .autocomplete-suggestions').hide();
        if (returnFocus) $('#sales_customer_btn').trigger('focus');
    }
};
$('.toggle-user-input').click(function () {
    PosnicPro.sales.setCustomerPopup($('#sales_customer_btn').attr('aria-expanded') !== 'true');
});
$(document).on('click', '#sales_customer_done', function () {
    PosnicPro.sales.updateCustomerChip();
    PosnicPro.sales.setCustomerPopup(false, true);
});
$(document).on('keydown', '#sales_customer_popup', function (e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        PosnicPro.sales.setCustomerPopup(false, true);
    }
});
$(document).on('click', '#sales_customer_add_new', function () {
    PosnicPro.sales.setCustomerPopup(true);
});
$('#sales_new_customer_name').on('focus input', function () {
    $('.toggle-customer-user').hide();
    $('#sales_customer_btn').attr('aria-expanded', 'false');
    $('#sales_customer_search').prop('hidden', false);
    PosnicPro.sales.renderRecentCustomers();
    $('#sales_recent_customers').toggle(!this.value.trim());
    $('#sales_customer_add_new').text(this.value.trim() ? 'Create ' + this.value.trim() + ' · add details' : 'Add customer details');
});
$('#sales_new_customer_name').on('keydown', function (e) {
    if (e.key === 'Escape') $('#sales_customer_search').prop('hidden', true);
});
$(document).on('mousedown', function (e) {
    if (!$(e.target).closest('.sales-customer-entry, .autocomplete-suggestions').length)
        $('#sales_customer_search').prop('hidden', true);
});
// Customer popover: close on the × or an outside click; "Walk-in" clears the
// customer back to none. Selecting a search result (autocomplete onSelect) also
// closes it. The popover reuses #sales_new_customer_name so search/submit are
// unchanged - only the presentation moved into a floating card.
$(document).on('click', '#sales_customer_pop_close', function () {
    PosnicPro.sales.setCustomerPopup(false);
});
$(document).on('click', '#sales_customer_walkin', function (e) {
    e.preventDefault();
    /*
     * Walk-in means the branch's OWN Walk-in customer record - the same one
     * a fresh sale starts with - not "no customer at all". Blanking every
     * field left the sale unsaveable: the picker offered Walk-in and then
     * Save answered "Enter a customer name". Shops that deliberately run
     * without a default customer keep the blank fields.
     */
    try { PosnicPro.defaultcustomerSet(); } catch (err) { /* chip still updates below */ }
    if (PosnicPro.sales.updateCustomerChip) { PosnicPro.sales.updateCustomerChip(); }
    if (PosnicPro.sales.calculation && PosnicPro.sales.calculation.salesTableRowCart) {
        PosnicPro.sales.calculation.salesTableRowCart();
    }
    PosnicPro.sales.setCustomerPopup(false);
});
$(document).on('mousedown', function (e) {
    var $pop = $('.toggle-customer-user');
    if (!$pop.length || !$pop.is(':visible')) { return; }
    if ($(e.target).closest('.toggle-customer-user, .sales-customer-entry, #sales_customer_btn, .autocomplete-suggestions').length === 0) {
        PosnicPro.sales.setCustomerPopup(false);
    }
});
$(document).ready(function () {
    if (PosnicPro.sales.updateCustomerChip) { PosnicPro.sales.updateCustomerChip(); }
});
$(document).ready(function () {
    $(document).click(function (e) {
        var container = $(".autocomplete-suggestions");
        if (!container.is(e.target) && container.has(e.target).length === 0) {
            container.hide();
        }
    });
});

$("#payment_description").hover(function () {
    $(this).css('cursor', 'pointer').attr('data-toggle', 'tooltip');
    $(this).css('cursor', 'pointer').attr('title', PosnicPro.i18n.t('lang_paymentdescription_title', 'Payment Note'));
}, function () {
    $(this).css('cursor', 'auto');
});

$("#sales_description").hover(function () {
    $(this).css('cursor', 'pointer').attr('data-toggle', 'tooltip');
    $(this).css('cursor', 'pointer').attr('title', PosnicPro.i18n.t('lang_sale_description', 'Sale Description'));
}, function () {
    $(this).css('cursor', 'auto');
});

$("#discount_description").hover(function () {
    $(this).css('cursor', 'pointer').attr('data-toggle', 'tooltip');
    $(this).css('cursor', 'pointer').attr('title', PosnicPro.i18n.t('lang_discount_note', 'Discount Note'));
}, function () {
    $(this).css('cursor', 'auto');
});

$(document).ready(function () {
    $('.save_enable').click(function () {
        $('#save_btn').attr("disabled", false).css({ cursor: 'pointer', color: '#43d187' });
    });
    $('#save_btn').mouseenter(function () {
        $(this).css('color', '#fff');
    });
    $('#save_btn').mouseleave(function () {
        $(this).css('color', '#43d187');
    });
});

$('#Partial_amount').on('input', function () {
    var saleNewTot = Number(PosnicPro.sales.extraDiscount.sale_new_tot) || 0;
    var paid = parseFloat($(this).val());
    paid = isFinite(paid) && paid > 0 ? paid : 0;
    var due = Math.max(0, saleNewTot - paid);
    $('.balanceDue').text(due.toFixed(2));
    $('#sales_new_customer_partial_balance').val(due > 0.005 ? 'true' : 'false');
});

$(document).ready(function () {

    $(window).resize(function () {
        var height = $(window).height() - 270;
        $('#sales_new_productList,#sales_new_categoryList').height(height);
        $('#sales_new_productList,#sales_new_categoryList').css({ 'max-height': height, overflow: 'auto' });
        var imgHeight = $(window).height() - 500;
        $('.sales-cart-image').height(imgHeight);
    });
    $(window).trigger('resize');


    let $inputs = $(".def-txt-input");
    let intRegex = /^\d+$/;

    // Prevents user from manually entering non-digits.
    $inputs.on("input.fromManual", function () {
        if (!intRegex.test($(this).val())) {
            $(this).val("");
        }
    });
});

$('#extraDisc').on('change', function () {
    PosnicPro.sales.calculation.extraDiscoundCalculation();
});
$('#percentIcon').on('click', function () {
    $('#percentIcon').addClass('d-none');
    $('#rupeeIcon').removeClass('d-none');
    PosnicPro.sales.calculation.extraDiscoundCalculation();
});
$('#rupeeIcon').on('click', function () {
    $('#rupeeIcon').addClass('d-none');
    $('#percentIcon').removeClass('d-none');
    PosnicPro.sales.calculation.extraDiscoundCalculation();
});
/**
 * Weight Machine Integration
 * Handles manual and automatic weight reading from Electron hardware
 */
PosnicPro.sales.readWeightFromMachine = async function () {
    // Check if weight machine is enabled in settings
    const settingsStr = PosnicPro.local.get('general_settings');
    const settings = settingsStr ? JSON.parse(settingsStr) : null;

    if (!settings || !settings.hardware_weight_machine_enable) {
        PosnicPro.alert('warning', PosnicPro.i18n.t('lang_weight_machine_is_not_enabled_in_settings', 'Weight machine is not enabled in settings.'));
        return;
    }

    // Check if WeightBridge is available
    if (!window.WeightBridge || !window.WeightBridge.isAvailable()) {
        PosnicPro.alert('warning', PosnicPro.i18n.t('lang_weight_machine_not_available_please_use_th', 'Weight machine not available. Please use the desktop app.'));
        window.WeightBridge && window.WeightBridge.showBrowserWarning();
        return;
    }

    const activeElement = document.activeElement;
    const targetInput = $(activeElement).is('#sales_new_items_tbody input[name="addSalesLineItemQty"]')
        ? activeElement
        : $('#sales_new_items_tbody tr[id^="touch_row_"]').first().find('input[name="addSalesLineItemQty"]')[0];
    if (!targetInput) {
        PosnicPro.alert('warning', PosnicPro.i18n.t('lang_no_items_in_cart_please_add_an_item_first', 'No items in cart. Please add an item first.'));
        return;
    }
    try {
        // Prefer a settled reading from the scale. The live display shows every
        // frame including mid-swing values, so reading it directly can bill the
        // customer for a weight the load never actually rested at.
        let weight = null;
        try {
            weight = await window.WeightBridge.getCurrentWeight({ stableOnly: true });
        } catch (e) {
            console.warn('[weight] live read failed:', e);
        }

        if (!weight || weight <= 0 || isNaN(weight)) {
            // Amber rather than red, and it says what the till did. The scale
            // being empty is the ordinary case of the customer not having put
            // the bag down yet, not a failure - and the sale is not blocked.
            PosnicPro.alert('warning',
                'No weight reading yet. Put the item on the platter and press the weight button, ' +
                'or type the quantity in. Nothing is blocked.');
            return;
        }

        // A reading belongs to the row selected when the request started.
        // Never apply a delayed reading to a replacement row or a new sale.
        if (!targetInput.isConnected || !$(targetInput).closest('#sales_new_items_tbody').length) return;
        const itemId = $(targetInput).closest('tr[id^="touch_row_"]').attr('id').replace('touch_row_', '');
        $(targetInput).val(weight.toFixed(3));
        PosnicPro.sales.quantity.textOnChange(itemId, $('#trackInventory_' + itemId).text(), $('#negativeStock_' + itemId).text());
        PosnicPro.alert('success', 'Weight ' + weight.toFixed(3) + ' kg filled');

    } catch (error) {
        console.error('Weight reading error:', error);
        PosnicPro.alert('error', 'Error reading weight: ' + error.message);
    }
};

/*
 * Whether this item is sold by weight.
 *
 * The flag arrives as a string from one path and a boolean from another, so
 * every caller has to accept both rather than pick one and be wrong half the
 * time.
 */
PosnicPro.sales.isWeighedItem = function (itemData) {
    if (!itemData) return false;
    var v = itemData.item_weight_machine_based;
    return v === '1' || v === 1 || v === true || v === 'true';
};

$(document).on('click', '.sale-weight-amount', async function (event) {
    event.preventDefault(); event.stopImmediatePropagation();
    var id = $(this).attr('data-id'), row = document.getElementById('touch_row_' + id);
    var input = document.getElementById('touchsale_item_qty' + id);
    if (!row || !input || PosnicPro.sales.SaleAction !== 'add') return;
    var price = Number($('#addSalesLineItemSellingPrice_' + id).text());
    var discount = parseFloat($('#addSalesLineItemDiscount_' + id).text()) || 0;
    var unit = $('#addSalesLineItemUnit_' + id).text().trim().toLowerCase() || 'kg';
    var factor = ({ kg: 1, kgs: 1, kilogram: 1, kilograms: 1, g: 1000, gm: 1000, grams: 1000, gram: 1000, tonne: 0.001, tonnes: 0.001 })[unit];
    if (!factor) return PosnicPro.alert('warning', 'Set this product’s weight unit to kg, g or tonnes before using By amount.');
    // Use the actual line rate, including the line discount. Bill-level
    // discounts and rounding are still calculated by the checkout engine.
    var rate = price - ($('#discountSign' + id).text() === '%' ? price * discount / 100 : discount);
    if (!Number.isFinite(rate) || rate <= 0) return PosnicPro.alert('warning', PosnicPro.i18n.t('lang_set_a_positive_selling_price_before_weighi', 'Set a positive selling price before weighing by amount.'));
    function alive() { return row.isConnected && input.isConnected && document.getElementById('touch_row_' + id) === row; }
    try {
        var quantity = await PosnicPro.sales.weighEntry({ item_name: $('#addSalesLineItemName_' + id).text(), unit: unit, selling_price: price }, { mode: 'amount', lineRate: rate, confirmButtonText: 'Update weight' });
        if (quantity == null || !alive()) return;
        if (Number($('#addSalesLineItemSellingPrice_' + id).text()) !== price) return PosnicPro.alert('warning', PosnicPro.i18n.t('lang_price_changed_weigh_by_amount_again', 'Price changed. Weigh by amount again.'));
        if ($('#trackInventory_' + id).text() === 'true' && $('#negativeStock_' + id).text() === 'false' && quantity > Number(PosnicPro.sales.SaleTableLineItems[id].available_quantity)) return PosnicPro.alert('warning', PosnicPro.i18n.t('lang_measured_weight_exceeds_available_stock_th', 'Measured weight exceeds available stock. The quantity has not been changed.'));
        $(input).val(quantity.toFixed(3));
        PosnicPro.sales.quantity.textOnChange(id, $('#trackInventory_' + id).text(), $('#negativeStock_' + id).text());
    } catch (error) {
        if (error instanceof Error) PosnicPro.alert('error', error.message);
    }
});

/*
 * Say the scale could not be read, and carry on.
 *
 * The item is already in the cart at quantity one by the time this runs. That
 * is the right thing to keep: a queue does not stop because a cable is loose,
 * and a cashier can type the weight in. What was missing is being told - the
 * failure only ever reached the console, so the till silently billed 1kg of
 * something priced by the kilo and nobody noticed until the count was short.
 */
PosnicPro.sales.warnWeighedItemFallback = function (itemData, reason) {
    var name = (itemData && itemData.item_name) ? itemData.item_name : 'This item';
    console.warn('[weight] ' + reason + ' - ' + name + ' left at quantity 1');
    if (PosnicPro.alert) {
        PosnicPro.alert('warning',
            name + ' is sold by weight. ' + reason +
            ' Quantity is set to 1. Type the weight in, or press the weight button once the scale is ready.');
    }
};

PosnicPro.sales.checkAutoWeightTrigger = function (itemData) {
    if (!PosnicPro.sales.isWeighedItem(itemData)) return;

    var settingsStr = PosnicPro.local.get('general_settings');
    var settings = settingsStr ? JSON.parse(settingsStr) : null;

    // Weighed item, but the shop has the scale turned off. Worth saying once,
    // because it is almost always someone who has just plugged one in and not
    // enabled it yet.
    if (!settings || !settings.hardware_weight_machine_enable) {
        PosnicPro.sales.warnWeighedItemFallback(itemData, 'The weight machine is switched off in Settings.');
        return;
    }

    if (!window.WeightBridge || !window.WeightBridge.isAvailable()) {
        PosnicPro.sales.warnWeighedItemFallback(itemData, 'The weight machine is not connected.');
        return;
    }

    // Short delay only so the cart row exists in the DOM; the weight read
    // itself then waits for the scale to settle rather than grabbing whatever
    // number happens to be showing.
    setTimeout(function () {
        try {
            var result = PosnicPro.sales.readWeightFromMachine();
            // It is async, so a rejection has to be caught here or it becomes
            // an unhandled rejection and the cashier still sees nothing.
            if (result && typeof result.catch === 'function') {
                result.catch(function (e) {
                    PosnicPro.sales.warnWeighedItemFallback(itemData,
                        'The scale did not respond' + (e && e.message ? ' (' + e.message + ').' : '.'));
                });
            }
        } catch (e) {
            PosnicPro.sales.warnWeighedItemFallback(itemData,
                'The scale could not be read' + (e && e.message ? ' (' + e.message + ').' : '.'));
        }
    }, 250);
};

PosnicPro.sales.initWeightMachine = function () {
    // Check if weight machine is enabled in settings
    const settingsStr = PosnicPro.local.get('general_settings');
    const settings = settingsStr ? JSON.parse(settingsStr) : null;

    console.log('=== Weight Machine Initialization Debug ===');
    console.log('1. Settings from localStorage:');
    console.log('   - settingsStr:', settingsStr);
    console.log('   - parsed settings:', settings);
    console.log('   - hardware_weight_machine_enable:', settings ? settings.hardware_weight_machine_enable : 'N/A');

    console.log('2. WeightBridge availability:');
    console.log('   - window.WeightBridge exists:', !!window.WeightBridge);
    console.log('   - window.electronAPI exists:', !!window.electronAPI);
    if (window.WeightBridge) {
        console.log('   - WeightBridge.isAvailable():', window.WeightBridge.isAvailable());
    }
    console.log('===========================================');

    if (settings && settings.hardware_weight_machine_enable) {
        // Show weight button in search area
        $('#sales_read_weight_btn').show();

        // Check if running in Electron
        if (window.WeightBridge && window.WeightBridge.isAvailable()) {
            console.log('Weight machine integration active (Electron)');

            // Show weight machine container with live display
            $('#weight_machine_container').show();

            // Start live weight monitoring
            if (window.WeightBridge.startMonitoring) {
                window.WeightBridge.startMonitoring(function (weight) {
                    if (weight === null || weight === undefined || !Number.isFinite(weight)) {
                        $('#live_weight_value').text('---');
                        $('#live_weight_display').css({ background: '#f0f0f0', color: '#333' });
                        return;
                    }
                    if (weight !== null && weight !== undefined && !isNaN(weight)) {
                        $('#live_weight_value').text(weight.toFixed(3));
                        // Change color based on weight
                        if (weight > 0) {
                            $('#live_weight_display').css('background', '#d4edda');
                            $('#live_weight_display').css('color', '#155724');
                        } else {
                            $('#live_weight_display').css('background', '#f0f0f0');
                            $('#live_weight_display').css('color', '#333');
                        }
                    }
                });
                console.log('Live weight monitoring started');
            }
        } else {
            console.log('Weight machine enabled but WeightBridge not available');
            console.log('window.WeightBridge:', window.WeightBridge);
            console.log('window.electronAPI:', window.electronAPI);
        }
    } else {
        // Hide the weight buttons and container
        $('#sales_read_weight_btn').hide();
        $('#weight_machine_container').hide();
    }
};

// Initialize on page load
$(document).ready(function () {
    if ($('#sales_new').length) {
        PosnicPro.sales.initWeightMachine();
    }

    // Intercept Print Receipt clicks on the new sale success panel so that
    // we invoke the existing print logic directly instead of navigating to
    // the #/sales/{id}/print route (which would otherwise send the user to
    // the Sales History page after printing).
    $(document).on('click', '.printSalesReceipt', function (e) {
        var $btn = $(this);
        var saleId = $btn.data('sale-id');

        // If we have a valid sale id and the view.printSale function is
        // available, handle printing in-place and prevent hash navigation.
        if (saleId &&
            window.PosnicPro &&
            PosnicPro.sales &&
            PosnicPro.sales.view &&
            typeof PosnicPro.sales.view.printSale === 'function') {
            e.preventDefault();
            PosnicPro.sales.view.printSale(saleId, 'sale');
        }
        // If anything above is missing, we intentionally fall through and
        // let the browser follow the href (#/sales/{id}/print) so that
        // existing deep links and non-JS environments still behave.
    });
});

console.log('Weight machine integration loaded in sales.js');

// Function to open register from sales page modal
PosnicPro.sales.openRegisterFromSales = function () {
    let registerName = $('#sales_choose_register_model').find(":selected").text();
    let registerId = $('#sales_choose_register_model option:selected').val();

    if (!registerId) {
        PosnicPro.alert('warning', PosnicPro.i18n.t('lang_select_a_register', 'Select a register.'));
        return false;
    }

    let registerNameType = {
        register_name: registerName,
        register_Id: registerId,
        opening_float: $('#sales_opening_float').val()
    };

    let params = {
        method: 'POST',
        url: 'registers/registerAdd',
        data: JSON.stringify(Object.assign(registerNameType))
    };

    PosnicPro.request(params, function (response) {
        if (response.type === 'success') {
            db.currentregister.put({id: '1', register_id: registerId, register_name: registerName, register_status: 'open'});
            PosnicPro.local.set('cash_register_id', response.data);
            PosnicPro.local.set('register_id', registerId);
            PosnicPro.local.set('register_name', registerName);
            PosnicPro.local.set('userRegisterStatus', 'Open');

            $('#salesRegisterModal').modal('hide');
            PosnicPro.alert('success', 'Register opened: ' + registerName);
        } else {
            PosnicPro.alert(response.type, response.message);
        }
    });
    return false;
};

/*
 * Paper choice at print time (owner: "Print recept i would like to have
 * thermal as well a4 option based user preference"). The main button follows
 * the shop's Print Type setting; these two override it for one print without
 * changing the setting, because the choice is usually per customer - a walk-in
 * wants the roll, a business customer wants the A4 invoice for their books.
 */
$(document).on('click', '#print_receipt_a4, #print_receipt_thermal', function () {
    var id = $('.printSalesReceipt').data('sale-id');
    if (!id) { return; }
    var layout = (this.id === 'print_receipt_a4') ? 'a4' : 'standard';
    var view = PosnicPro.sales.view;
    if (!view || !view.printSale) { return; }
    // the chosen paper decides which template must be present, so set it
    // before asking for the templates, then print once they are there
    view._layoutOverride = layout;
    view._ensurePrintTemplates(function () {
        view.printSale(id, 'sale', layout);
    });
});

/* The completed sale returns after the configured delay. Interaction pauses
 * a countdown; successful printing starts it again. Zero returns immediately. */
/* Preview the configured print document with the current cart. */
PosnicPro.sales.renderTenderReceiptPreview = function () {
    PosnicPro.tenderReceipt.show();
};

PosnicPro.sales.saleDoneTimer = {
    _timer: null,
    _card: function () { return $('#newsalespage .sale-done-card'); },

    start: function () {
        var self = PosnicPro.sales.saleDoneTimer;
        self.stop();

        var $card = self._card();
        if (!$card.length) { return; }
        var seconds = PosnicPro.saleRedirectSeconds();

        /*
         * Somebody who asked for reduced motion gets no ring, and the ring is
         * the only warning this card gives. Closing anyway would make it
         * vanish with no notice at all - the exact surprise the ring exists to
         * prevent - so for them the card simply waits to be dismissed.
         */
        if (seconds > 0 && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }

        /* One sale, one countdown. Without this a second sale completing
           while the first card was open would leave two timers running and
           the card would close early, which looks exactly like a bug. */
        /*
         * The countdown is ONE line along the top now. The old version ran a
         * ring around the whole card - "whole box animation going. instead
         * top side itself enough" - and it is right: four animated edges
         * read as the card doing something, one shrinking line reads as
         * time. Pure CSS (the is-closing class starts the keyframe, the
         * variable sets its pace), so removing the class is the whole stop.
         */
        $card.get(0).style.setProperty('--sale-done-secs', seconds + 's');
        $card.removeClass('is-held is-closing');
        /* next frame, so a back-to-back sale restarts the animation */
        void $card.get(0).offsetWidth;
        $card.addClass('is-closing');

        self._timer = window.setTimeout(function () {
            self._timer = null;
            /* Only if the card is still the thing on screen. Navigating away
               during the countdown must not drag the shop back here. */
            if (!$('#newsalespage').is(':visible')) { return; }
            $card.removeClass('is-closing');
            /* The same path the button takes, rather than a second way to
               start a sale that could drift away from the first. */
            $('#newsalespage .sale-done-primary').get(0).click();
        }, seconds * 1000);
    },

    /* Called by every interaction. Idempotent on purpose - mouseenter and
       focusin both fire for a keyboard user reaching the same button. */
    hold: function () {
        var self = PosnicPro.sales.saleDoneTimer;
        if (!self._timer) { return; }
        self.stop();
        self._card().addClass('is-held');
    },

    stop: function () {
        var self = PosnicPro.sales.saleDoneTimer;
        if (self._timer) { window.clearTimeout(self._timer); self._timer = null; }
        self._card().removeClass('is-closing');
    }
};

/*
 * What counts as the cashier using this card: A CLICK, and nothing less.
 *
 * This is the third definition, and each predecessor died the same death.
 * Hover-anywhere cancelled on the frame the panel appeared (it opens under
 * the cursor that just pressed Complete). Movement-over-12px then failed on
 * EVERY SALE AFTER THE FIRST - the owner: "sales auto close stuff also only
 * first time only" - because on the first sale the hand is still, watching,
 * and on the next it is already travelling back from the button; the first
 * post-open twitch crossed the threshold and silently held the card forever.
 *
 * Presence is not intent. Movement is not intent either. A CLICK is - the
 * owner's own rule: "if click anywhere then cancel that close otherwise just
 * close it." Typing and tabbing keep counting too (a keyboard user's click).
 * The two buttons that ARE actions stay out of it: the primary starts the
 * new sale itself, and the close X must CLOSE, never hold - see below.
 *
 * Delegated, because the sale page rebuilds this markup.
 */
$(document).on('mousedown touchstart', '#newsalespage', function (e) {
    if ($(e.target).closest('.sale-done-primary, .infobar-tender-close').length) { return; }
    PosnicPro.sales.saleDoneTimer.hold();
});
$(document).on('focusin keydown', '#newsalespage', function (e) {
    if ($(e.target).closest('.sale-done-primary, .infobar-tender-close').length) { return; }
    PosnicPro.sales.saleDoneTimer.hold();
});
/*
 * The close X is a DECISION, not a pause. Owner: "dont ignore close button
 * close. if user click close button then it needs to close and new sale."
 * The X lives in the sidebar head above the card; its own handler only slid
 * the sidebar away, leaving the finished sale's state behind it. When the
 * done card is what the X is closing, closing means the same thing the
 * countdown means: this sale is over, bring the next one. The primary's own
 * click is left alone - it IS that path.
 */
$(document).on('click', '.infobar-tender-close', function () {
    if (!$('#newsalespage').is(':visible')) { return; }
    if ($(this).hasClass('sale-done-primary')) { return; }
    PosnicPro.sales.saleDoneTimer.stop();
    var primary = $('#newsalespage .sale-done-primary').get(0);
    if (primary) { primary.click(); }
});

// The next transaction starts at product search, including when the route
// is already /sales/new and the router therefore does not run again.
$(document).on('click', '#newsalespage .sale-done-primary', function () {
    PosnicPro.sales.saleDoneTimer.stop();
    PosnicPro.sales._focusAfterCompletedSale = true;
    window.setTimeout(function () {
        var input = document.getElementById('sales_new_item_name');
        if (!input || !$(input).is(':visible') || input.disabled ||
            $('.modal.show:visible, .swal2-modal:visible').length ||
            $('#infobar-settings-sidebar-tender-details').hasClass('sidebarview')) return;
        if (document.activeElement && document.activeElement !== document.body &&
            /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) &&
            document.activeElement !== input) return;
        input.focus();
    }, 0);
});

$(document).on('click', '#sales_list_rows tr.sales-row', function () {
    PosnicPro.sales.openDoc($(this).data('id'));
});

// Select checkout numbers for immediate replacement by touch or keyboard.
$(document).on('focusin click', '#sales_new input[name="addSalesLineItemQty"], #sale_line_edit input[type="number"]', function () {
    var input = this;
    setTimeout(function () {
        if (document.activeElement === input && !input.disabled && !input.readOnly) input.select();
    }, 0);
});


// Read-only invalidation; never remove or alter existing basket lines.
(function () {
    var pending = false, revision = null;
    function checkAvailability() {
        if (pending || document.hidden || !PosnicPro.sales || !PosnicPro.sales.itemCache || !$('#sales:visible').length) return;
        pending = true;
        PosnicPro.get('mobile/v1/availability-status', function (r) {
            pending = false;
            if (!Array.isArray(r.hidden) || typeof r.revision !== 'string') return;
            PosnicPro.sales.hiddenProducts = r.hidden;
            if (revision !== r.revision) {
                revision = r.revision;
                PosnicPro.sales.itemCache.clear();
                if (PosnicPro.sales.itemsMenu) PosnicPro.sales.itemsMenu.onlineProductList('');
            }
        }, function () { pending = false; });
    }
    setInterval(checkAvailability, 15000);
    window.addEventListener('focus', checkAvailability);
})();
