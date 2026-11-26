PosnicPro.suppliers = {
    supplierAction: 'add',
    supplier_phone: null,
    showAdd: function () {
        PosnicPro.HideSideBarModal();
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $(".vertical-layout").removeClass("toggle-menu");
        $(".vertical-menu li a").removeClass("active");
        $('#v-pills-purchase-tab,.supplier_new_shortcut').addClass('active');
        $('#v-pills-purchase').addClass('show active');
        $('.vertical-menu li a#view_suppliers_page').addClass('active');
        PosnicPro.showAddModal('supplier');
        $('#supplier_reset').show();
        $('.supplier_edit_reset').hide();
        $('#supplier_country').val(PosnicPro.local.get("country_setting")).trigger('change.select2');
        PosnicPro.local.set('edit_supplier_state', PosnicPro.local.get("state_setting"));
        $('#supplier_city').val(PosnicPro.local.get("city_setting") || "");
        PosnicPro.suppliers.loadSelectSupplierState(PosnicPro.local.get('countryid'), 'add');
        PosnicPro.suppliers.addSupplierButton();
        $('.add_new_tooltip').tooltip("hide");
        if (PosnicPro.suppliers.supplierAction === 'edit') {
            PosnicPro.suppliers.supplierClearForm();
        }
        PosnicPro.suppliers.supplierAction = 'add';
    },
    showEdit: function (id) {
        var loader = $(".loader-supplier");
        loader.find(".loadingSpinner:first").remove();
        PosnicPro.showEditModal('suppliers');
        PosnicPro.suppliers.editSupplier(id);
        $('#supplier_reset').hide();
        $('.supplier_edit_reset').show();
        $('.supplier_edit_reset').attr("id", id);
        PosnicPro.suppliers.supplierAction = 'edit';
    },
    showDelete: function (id) {
        PosnicPro.deleteTableRowData(id, 'suppliers');
    },
    /* #/suppliers/<id>: the profile opens in the right pane - never a
       popup (LIST_PAGE_UX_STANDARD). Recognises the echo of its own
       setHash and does nothing. */
    showDetails: function (id) {
        var self = PosnicPro.suppliers;
        if (self._openDocId === String(id) && $('#suppliers_detail_card').is(':visible')) { return; }
        self._chrome();
        self.loadList(1);
        self.openDoc(id);
    },

    _page: 1,
    PAGE_SIZE: 25,
    _lastRows: [],
    _openDocId: null,
    /* Page chrome shared by list entry and deep links - the left menu
       highlight must survive a refresh (standard rule). */
    _chrome: function () {
        PosnicPro.HideSideBarModal();
        $('.page_loader,#osk-container').hide();
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $('.vertical-menu li a').removeClass('active');
        $('#v-pills-purchase-tab').addClass('active');
        $('#v-pills-purchase').addClass('show active');
        $('.vertical-menu li a#view_suppliers_page').addClass('active');
        $('.page-title-box,#suppliers').show();
        $('.dashboard_img_menu').hide();
        $('#image_sidebar_supply').show();
    },
    showDataTablePage: function () {
        PosnicPro.suppliers._chrome();
        PosnicPro.suppliers.closeDoc();
        PosnicPro.suppliers.loadList(1);
    },
    mountFilters: function (force) {
        if (!$('#suppliers_filter_panel').length) { return; }
        if (!force && $('#suppliers_filter_panel').data('mounted')) { return; }
        $('#suppliers_filter_panel').data('mounted', true);
        PosnicPro.listFilter.mount({
            key: 'suppliers',
            typeahead: 'supplier',
            rows: '#suppliers_list_rows',
            onRefresh: function () { return PosnicPro.suppliers.loadList(); },
            container: '#suppliers_filter_panel',
            showTotal: true,
            button: '#suppliers_filter_btn',
            searchPlaceholder: PosnicPro.i18n.t('lang_search_supplier_records', 'Search suppliers by name, email, phone or address'),
            dateField: PosnicPro.i18n.t('lang_created_date', 'Created date'),
            searchFields: [
                { value: 'all', label: PosnicPro.i18n.t('lang_all_fields', 'All fields') },
                { value: 'name', label: PosnicPro.i18n.t('lang_name_title', 'Name') },
                { value: 'phone', label: PosnicPro.i18n.t('lang_phone_title', 'Phone') },
                { value: 'email', label: PosnicPro.i18n.t('lang_email_title', 'Email') },
                { value: 'address', label: PosnicPro.i18n.t('lang_address_title', 'Address') }
            ],
            onChange: function () { PosnicPro.suppliers.loadList(1); }
        });
    },
    loadList: function (page) {
        PosnicPro.suppliers.mountFilters();
        var self = PosnicPro.suppliers;
        if (page) { self._page = page; }
        var filters = PosnicPro.listFilter.legacyFilters('suppliers', { dateKey: 'created_date' });
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        PosnicPro.listFilter.request('suppliers', {
            url: 'suppliers',
            data: { page: self._page, limit: self.PAGE_SIZE, filters: JSON.stringify(filters) }
        }, function (response) {
            var data = (response && response.data) || {};
            var list = data.list || [];
            self._lastRows = list;
            $('#suppliers_filter_panel .lf-result-total strong').text(Number(data.total) || list.length);
            if (!list.length) {
                var filtered = PosnicPro.listFilter.activeCount('suppliers') > 0;
                $('#suppliers_list_rows').html('<div class="text-center text-muted p-t-20 p-b-20">'
                    + (filtered ? PosnicPro.i18n.t('lang_no_suppliers_match_this_filter', 'No suppliers match this filter.') : PosnicPro.i18n.t('lang_no_suppliers_yet_press_new_to_add_the_firs', 'No suppliers yet - press New to add the first.')) + '</div>');
                $('#suppliers_list_paging').html('');
                return;
            }
            var html = '<div class="table-responsive"><table class="table table-borderless">'
                + '<thead><tr><th><lang class="lang_name_title">Name</lang></th><th class="s-col-phone"><lang class="lang_phone_title">Phone</lang></th>'
                + '<th class="s-col-email"><lang class="lang_email_title">Email</lang></th><th class="s-col-address"><lang class="lang_address_title">Address</lang></th></tr></thead><tbody>';
            list.forEach(function (r) {
                html += '<tr class="md-row suppliers-row highlight-select' + (self._openDocId === String(r._id) ? ' is-active' : '') + '"'
                    + ' data-id="' + esc(r._id) + '" style="cursor:pointer;">'
                    + '<td>' + esc(r.name) + '</td>'
                    + '<td class="s-col-phone">' + esc(r.phone || '-') + '</td>'
                    + '<td class="s-col-email">' + esc(r.email || '-') + '</td>'
                    + '<td class="s-col-address">' + esc(r.address || '-') + '</td>'
                    + '</tr>';
            });
            html += '</tbody></table></div>';
            $('#suppliers_list_rows').html(html);
            self.renderPager(Number(data.total) || list.length);
        }, function () {
            $('#suppliers_filter_panel .lf-result-total strong').empty();
            $('#suppliers_list_rows').html('<div class="text-center text-muted p-t-20 p-b-20"><lang class="lang_could_not_load_suppliers_try_again">Could not load suppliers - try again.</lang></div>');
        });
    },
    renderPager: function (total) {
        var self = PosnicPro.suppliers;
        var p = self._page, size = self.PAGE_SIZE;
        var pages = Math.ceil(total / size) || 1;
        var btn = function (to, text, off, cls) {
            return '<button type="button" class="btn btn-sm ' + (cls || 'btn-secondary-rgba') + ' q-pg-btn"' + (off ? ' disabled' : '')
                + ' onclick="PosnicPro.suppliers.goPage(' + to + ');">' + text + '</button>';
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
        if (pages > 1) html += '<span class="q-pg-count">Page ' + p + ' of ' + pages + '</span>';
        if (pages > 1) { html += btn(p + 1, '&raquo;', p >= pages); }
        $('#suppliers_list_paging').html(html);
    },
    goPage: function (n) {
        if (!n || n < 1) { return; }
        PosnicPro.suppliers._page = n;
        PosnicPro.suppliers.loadList();
    },
    _csvSpec: function () {
        return {
            head: ['Name', 'Phone', 'Email', 'Address'],
            map: function (r) {
                return [r.name, r.phone || '', r.email || '', r.address || ''];
            }
        };
    },
    exportCsv: function () {
        var spec = PosnicPro.suppliers._csvSpec();
        PosnicPro.listExport.save(
            [spec.head].concat((PosnicPro.suppliers._lastRows || []).map(spec.map)), 'suppliers.csv');
    },
    /* Everything matching the CURRENT filter, paged through the same
       endpoint the list reads - never a shapeless full dump. */
    exportAllCsv: function () {
        var spec = PosnicPro.suppliers._csvSpec();
        PosnicPro.listExport.all({
            url: 'suppliers',
            params: function (page, limit) {
                return { page: page, limit: limit, filters: JSON.stringify(PosnicPro.listFilter.legacyFilters('suppliers', { dateKey: 'created_date' })) };
            },
            head: spec.head,
            map: spec.map,
            filename: 'suppliers.csv'
        });
    },
    /* ---- the profile pane ---- */
    openDoc: function (id) {
        var self = PosnicPro.suppliers;
        if (!PosnicPro.masterDetail.inSplit('#suppliers_split', 'suppliers-split')) {
            PosnicPro.masterDetail.enter('#suppliers_split', 'suppliers-split');
            $('#suppliers_detail_card').show();
        }
        self._openDocId = String(id);
        $('#suppliers_list_rows tr.suppliers-row').removeClass('is-active');
        $('#suppliers_list_rows tr.suppliers-row[data-id="' + id + '"]').addClass('is-active');
        if (window.location.hash.slice(2) !== 'suppliers/' + id) {
            hasher.setHash('suppliers/' + id);
        }
        $('#suppliers_doc').html('<div class="text-center text-muted" style="padding:60px;"><lang class="lang_loading_4">Loading ...</lang></div>');
        PosnicPro.get('suppliers/' + id, function (response) {
            if (response.type !== 'success') {
                $('#suppliers_doc').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_supplier">Could not open this supplier.</lang></div>');
                return;
            }
            PosnicPro.suppliers.renderSupplierDoc(response.data);
            PosnicPro.ACLForModule('supplier');
        }, function () {
            $('#suppliers_doc').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_supplier">Could not open this supplier.</lang></div>');
        });
    },
    closeDoc: function () {
        PosnicPro.suppliers._openDocId = null;
        $('#suppliers_detail_card').hide();
        $('#suppliers_list_rows tr.suppliers-row').removeClass('is-active');
        PosnicPro.masterDetail.leave('#suppliers_split', 'suppliers-split');
        if (window.location.hash.slice(2).indexOf('suppliers/') === 0) {
            hasher.setHash('suppliers');
        }
    },
    renderSupplierDoc: function (d) {
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        var real = function (v) { return v && v !== 'null' && v !== 'undefined' ? v : ''; };
        var id = String(d._id || PosnicPro.suppliers._openDocId);
        var toolbar = '<div class="p-doc-toolbar">'
            + '<button type="button" class="btn btn-sm btn-light" title="Show or hide the list" data-t-title="lang_show_or_hide_the_list" aria-label="Show or hide the list" data-t-aria-label="lang_show_or_hide_the_list" onclick="PosnicPro.masterDetail.toggleRail(\'#suppliers_split\');"><i class="feather icon-sidebar"></i></button>'
            + '<span class="p-doc-title">' + esc(d.name) + '</span>'
            + '<span class="ml-auto"></span>'
            + '<button type="button" class="btn btn-sm btn-light" data-module="supplier" data-access="read" onclick="PosnicPro.debts.openStatement(\'supplier\', \'' + esc(id) + '\');"><i class="feather icon-file-text mr-1"></i>' + esc(PosnicPro.i18n.t('lang_statement', 'Statement')) + '</button>'
            + '<button type="button" class="btn btn-sm btn-primary" data-module="supplier" data-access="write" onclick="PosnicPro.debts.payParty(\'supplier\', \'' + esc(id) + '\');"><i class="feather icon-credit-card mr-1"></i>' + esc(PosnicPro.i18n.t('lang_pay_supplier', 'Pay supplier')) + '</button>'
            + '<button type="button" class="btn btn-sm btn-light" data-module="supplier" data-access="write" onclick="hasher.setHash(\'suppliers/' + esc(id) + '/edit\');"><i class="feather icon-edit-2 mr-1"></i>Edit</button>'
            + '<div class="btn-group">'
            + '<button type="button" class="btn btn-sm btn-light dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><lang class="lang_tab_more">More</lang></button>'
            + '<div class="dropdown-menu dropdown-menu-right">'
            + '<a class="dropdown-item text-danger" data-module="supplier" data-access="delete" href="javascript:void(0)" onclick="PosnicPro.suppliers.deleteAsk();"><i class="feather icon-trash mr-2"></i>Delete</a>'
            + '</div></div>'
            + '<button type="button" class="btn btn-sm btn-light" title="Close and show the full list" data-t-title="lang_close_and_show_the_full_list" aria-label="Close" data-t-aria-label="lang_close_title" onclick="PosnicPro.suppliers.closeDoc();"><i class="feather icon-x"></i></button>'
            + '</div>';
        var strip = '<div class="p-void-strip" id="s_delete_strip" style="display:none;">'
            + '<span>Delete <b>' + esc(d.name) + '</b>? Their purchases stay on record; only the supplier card goes.</span>'
            + '<button type="button" class="btn btn-sm btn-danger" onclick="PosnicPro.suppliers.deleteConfirm(\'' + esc(id) + '\');">Delete supplier</button>'
            + '<button type="button" class="btn btn-sm btn-light" onclick="$(\'#s_delete_strip\').slideUp(120);">Cancel</button>'
            + '</div>';
        var contact = '<div class="q-block"><div class="q-label"><lang class="lang_contact">Contact</lang></div>'
            + (real(d.phone) ? '<div><a href="tel:' + esc(d.phone) + '">' + esc(d.phone) + '</a></div>' : '')
            + (real(d.email) ? '<div><a href="mailto:' + esc(d.email) + '">' + esc(d.email) + '</a></div>' : '')
            + (real(d.address) ? '<div class="q-muted">' + esc(d.address) + '</div>' : '')
            + (real(d.state) ? '<div class="q-muted">' + esc(d.state) + (real(d.country) ? ', ' + esc(d.country) : '') + '</div>' : '')
            + '</div>';
        var record = '<div class="q-block"><div class="q-label"><lang class="lang_on_record">On record</lang></div>'
            + (d.created_date ? '<div class="q-muted">Added ' + esc(PosnicPro.convertDate(d.created_date)) + '</div>' : '')
            + (d.updated_date ? '<div class="q-muted">Updated ' + esc(PosnicPro.convertDate(d.updated_date)) + '</div>' : '')
            + '</div>';
        var body = '<div class="s-doc-body"><div class="q-sheet s-sheet">'
            + '<div class="s-doc-stats" id="s_doc_stats"></div>'
            + '<div class="s-doc-grid">' + contact + record + '</div>'
            + '<div class="q-label d-flex justify-content-between align-items-center" style="margin-top:18px;">'
            + '<span><lang class="lang_recent_purchases">Recent purchases</lang></span>'
            + '<a href="javascript:void(0)" class="small" onclick="PosnicPro.debts.openStatement(\'supplier\', \'' + esc(id) + '\');">'
            + '<lang class="lang_statement">Statement</lang> <i class="feather icon-arrow-right"></i></a>'
            + '</div>'
            + '<div id="s_doc_purchases" class="text-muted" style="font-size:13px;"><lang class="lang_loading_4">Loading ...</lang></div>'
            + '</div></div>';
        $('#suppliers_doc').html(toolbar + strip + body);
        PosnicPro.suppliers.loadRecentPurchases(id);
    },
    /* The supplier's latest purchases, cross-linked to their documents on
       the purchases surface (#/purchaseorders/<id>). */
    /*
     * One fetch feeds both the overview and the detail (Shneiderman:
     * overview first, details on demand): the stats strip totals what this
     * supplier has cost, the table names its columns, and every row
     * PREVIEWS its A4 sheet in place - no leaving the page, no back button.
     */
    loadRecentPurchases: function (id) {
        PosnicPro.get({
            url: 'receivings/supplierReceivingDetails',
            data: { page: 1, limit: 100, supplier_id: id, branch: [PosnicPro.local.get('branch_id_set')] }
        }, function (response) {
            var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
            /*
             * Purchases happen at a time, not just on a day - two deliveries
             * on the same morning must be distinguishable. Use the statement's
             * shop-timezone formatter, with a local fallback for routes where
             * the debts module has not loaded yet.
             */
            var formatWhen = function (value) {
                if (!value) return '';
                if (PosnicPro.debts && PosnicPro.debts.formatDateTime) {
                    return PosnicPro.debts.formatDateTime(value);
                }
                if (typeof moment !== 'undefined') {
                    var m = moment(value);
                    if (m.isValid()) {
                        try {
                            if (PosnicPro.timeZone) m = m.tz(PosnicPro.timeZone());
                        } catch (e) { /* browser timezone */ }
                        return m.format('YYYY-MM-DD HH:mm');
                    }
                }
                return String(value).replace('T', ' ').slice(0, 16);
            };
            var t = response && response.data && response.data.table && response.data.table.data;
            var list = (t && (t.list || t.rows)) || [];
            var total = (t && Number(t.total)) || list.length;
            var live = list.filter(function (r) { return r.receiving_status !== 'Cancelled'; });
            var spend = live.reduce(function (sum, r) {
                var amount = r.invoice_total_declared != null ? r.invoice_total_declared : r.items_total;
                return sum + (Number(amount) || 0);
            }, 0);
            var last = list.length ? (list[0].date || list[0].created_date || '') : '';
            var cur = PosnicPro.local.get('currencySign');
            $('#s_doc_stats').html(
                '<div class="s-stat"><div class="s-stat-value">' + cur + '&nbsp;' + spend.toFixed(2) + '</div>'
                + '<div class="s-stat-label">Purchased' + (total > list.length ? ' (last ' + list.length + ')' : '') + '</div></div>'
                + '<div class="s-stat"><div class="s-stat-value" id="s_doc_debt">\u2014</div>'
                + '<div class="s-stat-label"><lang class="lang_outstanding_amount">Outstanding Amount</lang></div></div>'
                + '<div class="s-stat"><div class="s-stat-value">' + total + '</div>'
                + '<div class="s-stat-label">' + (total === 1 ? PosnicPro.i18n.t('lang_newpurchase_title', 'Purchase') : PosnicPro.i18n.t('lang_po_title', 'Purchases')) + '</div></div>'
                + '<div class="s-stat"><div class="s-stat-value">' + (last ? esc(String(last).slice(0, 10)) : '\u2014') + '</div>'
                + '<div class="s-stat-label"><lang class="lang_last_purchase">Last purchase</lang></div></div>'
            );
            PosnicPro.suppliers.loadSupplierDebt(id);
            if (!list.length) {
                $('#s_doc_purchases').html('<div class="text-muted"><lang class="lang_no_purchases_from_this_supplier_yet">No purchases from this supplier yet.</lang></div>');
                return;
            }
            var html = '<table class="q-items s-doc-purchases-table"><thead><tr>'
                + '<th><lang class="lang_purchase_2">Purchase #</lang></th><th class="text-right"><lang class="lang_date_title">Date</lang></th><th class="text-right"><lang class="lang_total_title">Total</lang></th>'
                + '</tr></thead><tbody>';
            list.slice(0, 5).forEach(function (r) {
                var docId = r._id || r.id || '';
                var no = r.receiving_id || r.po_id || '';
                var purchaseDate = r.date || r.created_date || '';
                var rowTotal = r.invoice_total_declared != null ? r.invoice_total_declared : (r.items_total != null ? r.items_total : r.total_amount);
                html += '<tr class="s-doc-purchase-row"'
                    + (docId ? ' data-doc="' + esc(docId) + '" style="cursor:pointer;" title="Preview this purchase" data-t-title="lang_preview_this_purchase"' : '')
                    + '>'
                    + '<td>' + esc(no) + '</td>'
                    + '<td class="text-right q-muted">' + esc(formatWhen(purchaseDate)) + '</td>'
                    + '<td class="text-right">' + cur + '&nbsp;' + (Number(rowTotal) || 0).toFixed(2) + '</td>'
                    + '</tr>';
            });
            html += '</tbody></table>';
            if (total > 5) {
                html += '<div class="q-muted" style="font-size:12.5px; padding: 8px 4px 0;">'
                    + (total - 5) + ' more in <a href="javascript:void(0)" onclick="hasher.setHash(\'purchaseorders\');">Purchases</a></div>';
            }
            $('#s_doc_purchases').html(html);
        }, function () {
            $('#s_doc_purchases').html('<div class="text-muted"><lang class="lang_purchase_history_unavailable">Purchase history unavailable.</lang></div>');
        });
    },
    /*
     * The debt ledger is the authority for what this supplier is still owed:
     * the printed invoice total on each received purchase, minus the amount
     * paid at the counter and every later collection. The purchases endpoint
     * is only a document list, so it cannot answer this on its own.
     */
    loadSupplierDebt: function (id) {
        var branch = PosnicPro.local.get('branch_id_set');
        PosnicPro.get({
            url: 'debts/suppliers/' + encodeURIComponent(id) + '/statement',
            data: { branch: branch ? [branch] : [] }
        }, function (response) {
            var summary = response && response.data && response.data.summary;
            if (!summary) { $('#s_doc_debt').text('\u2014'); return; }
            var cur = PosnicPro.local.get('currencySign');
            $('#s_doc_debt').text(cur + ' ' + (Number(summary.outstanding) || 0).toFixed(2));
        }, function () {
            $('#s_doc_debt').text('\u2014');
        });
    },
    /*
     * Inline preview: the purchase's A4 sheet unfolds under its row (owner:
     * bouncing to Purchases and back is "bit weird"). One open at a time;
     * the full document with its actions is one deliberate click further.
     */
    togglePurchasePreview: function ($row, docId) {
        var open = $row.next('.s-doc-preview-tr');
        if (open.length) { open.remove(); return; }
        $('#suppliers_doc .s-doc-preview-tr').remove();
        var $tr = $('<tr class="s-doc-preview-tr"><td colspan="3"><div class="s-doc-preview"><div class="text-muted" style="padding:16px;"><lang class="lang_loading_4">Loading ...</lang></div></div></td></tr>');
        $row.after($tr);
        var $box = $tr.find('.s-doc-preview');
        PosnicPro.get('receivings/' + docId, function (response) {
            if (response.type !== 'success' || !response.data) {
                $box.html('<div class="text-muted" style="padding:16px;"><lang class="lang_could_not_load_this_purchase">Could not load this purchase.</lang></div>');
                return;
            }
            $box.html(
                '<div class="s-doc-preview-bar">'
                + '<span class="q-muted"><lang class="lang_preview">Preview</lang></span>'
                + '<span class="s-doc-preview-actions">'
                + '<a href="javascript:void(0)" onclick="hasher.setHash(\'purchaseorders/' + String(docId) + '\');">Open in Purchases <i class="feather icon-arrow-right"></i></a>'
                + '<a href="javascript:void(0)" class="s-preview-close" onclick="$(this).closest(\'.s-doc-preview-tr\').remove();" aria-label="Close preview" data-t-aria-label="lang_close_preview"><i class="feather icon-x"></i></a>'
                + '</span>'
                + '</div>'
                + PosnicPro.purchaseorders.buildPurchaseSheet(response.data)
            );
        }, function () {
            $box.html('<div class="text-muted" style="padding:16px;"><lang class="lang_could_not_load_this_purchase">Could not load this purchase.</lang></div>');
        });
    },
    deleteAsk: function () {
        $('#s_delete_strip').slideDown(120);
    },
    deleteConfirm: function (id) {
        PosnicPro.request({
            method: 'DELETE',
            url: 'suppliers',
            data: JSON.stringify({ data: [id] })
        }, function (r) {
            PosnicPro.alert(r.type || 'success', r.message || 'Supplier deleted');
            PosnicPro.suppliers.closeDoc();
            PosnicPro.suppliers.loadList(1);
        }, function (xhr) {
            var resp = {}; try { resp = jQuery.parseJSON(xhr.responseText) || {}; } catch (e) { }
            PosnicPro.alert('error', resp.message || 'Could not delete this supplier');
        });
    },
    triggerModules: function () {
        PosnicPro.showAddModal('supplier');
        PosnicPro.suppliers.addSupplierButton();
        var hash = window.location.hash.slice(1);
        if (hash === '/receivings/suppliers/new' || hash === '/items/suppliers/new') {
            $('#supplier_name').val('');
        } else if (hash === '/receivings/new') {
            $('#supplier_name').val($('#receiving_add_supplier_name').val());
        } else {
            $('#supplier_name').val($('#items_supplier').val());
        }
        $('#supplier_reset').show();
        $('.supplier_edit_reset').hide();
    },
    /*This suppliers Function Used To Add & Edit function*/
    supplier: function () {
        if ($('#supplier_name').val() !== '' && PosnicPro.validateEmail($('#supplier_email').val())) {
            var loader = $(".loader-supplier");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.action = 'add';
            var method = 'POST';
            var url = 'suppliers';
            if ($('#supplierid').val() !== '') {
                PosnicPro.action = 'edit';
                method = 'PUT';
                url += '/' + $('#supplierid').val();
            }
            var params = {
                method: method,
                url: url,
                data: JSON.stringify(PosnicPro.getFormData($('#supplier_add')))
            };
            PosnicPro.request(params, function (response) {
                if (response.type === 'success') {
                    /*This function while add new item from another page after complete add items go to previous page*/
                    /*START*/
                    loader.find(".loadingSpinner:first").remove();
                    var data = response.data;
                    var supplierId = data.supplier_id || data.id || data._id;
                    var supplierName = data.supplier_name || data.name;
                    var supplierAddress = data.supplier_address || data.address;
                    var supplierPhone = data.supplier_phone || data.phone;
                    var supplierEmail = data.supplier_email || data.email;
                    var hash = window.location.hash.slice(1);
                    if (hash === '/receivings/suppliers/new') {
                        hasher.changed.active = false; //disable changed signal
                        hasher.replaceHash('receivings/new');
                        $('#receiving_add_supplier_id').val(supplierId);
                        $('#receiving_add_supplier_name').val(supplierName);
                        $('#receiving_add_supplier_address').val(supplierAddress);
                        $('#receiving_add_supplier_phone').val(supplierPhone);
                        $('#receiving_add_supplier_email').val(supplierEmail);
                        $(".infobar-settings-sidebar-overlay").css({"background": "transparent", "position": "initial"});
                        $("#infobar-settings-sidebar-supplier").removeClass("sidebarshow");
                        hasher.changed.active = true; //enable changed signal
                    }
                    if (hash === '/items/suppliers/new') {
                        hasher.changed.active = false; //disable changed signal
                        $('#items_supplier_id').val(supplierId);
                        $(".infobar-settings-sidebar-overlay").css({"background": "transparent", "position": "initial"});
                        $("#infobar-settings-sidebar-supplier").removeClass("sidebarshow");
                        $("#infobar-settings-sidebar-item").addClass("sidebarshow");
                        $('#items_supplier').val(supplierName);
                        $('#supplier_check').val('yes');
                        hasher.changed.active = true; //enable changed signal
                        hasher.replaceHash('items/new');
                        $('.error_item').css('display', 'none');
                    }
                    if (PosnicPro.action === 'add') {
                        PosnicPro.suppliers.loadList(1);
                        $('#show_last_created_supplier').show();
                        var path = '#/suppliers/' + supplierId;
                        $('#last_created_supplier').attr('href', path);
                    }
                    if (PosnicPro.action === 'edit') {
                        $(".infobar-settings-sidebar-overlay").css({"background": "transparent", "position": "initial"});
                        $("#infobar-settings-sidebar-supplier").removeClass("sidebarshow");
                        hasher.setHash('suppliers');
                    }
                    $(".supplier-trigger").val('');
                    PosnicPro.alert(response.type, response.message);
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
            return false;
        }
    },
    /*To display the supplier details form*/
    /*Edit supplier details*/
    editSupplier: function (id) {
        var loader = $(".loader-supplier");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        $(".infobar-settings-sidebar-overlay").css({"background": "rgba(0,0,0,0.4)", "position": "fixed"});
        $("#infobar-settings-sidebar-supplier").addClass("sidebarshow");
        var params = {
            url: 'suppliers/getSupplierDetails',
            data: {
                id: id
            }
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                $('#suppliers_new').modal('show');
                data = response.data;
                PosnicPro.record_id = id;
                $('#supplierid').val(PosnicPro.record_id);
                $('#supplier_name').val(data.name);
                $('#supplier_phone').val(data.phone);
                $('#supplier_email').val(data.email);
                $('#supplier_address').val(data.address);
                    $('#supplier_title').text(PosnicPro.i18n.t('lang_action_edit', 'Edit'));
                    $('#supplier_button_title').text(PosnicPro.i18n.t('lang_updatebtn_title', 'Update'));
                $('.update-button').attr('disabled', 'disabled').removeClass('btn-outline-success');
                $('#supplier_country').val(data.country).trigger('change.select2');
                PosnicPro.local.set('edit_supplier_state', data.state);
                var countryDetail = $('#supplier_country').select2("data");
                PosnicPro.suppliers.loadSelectSupplierState(countryDetail[0].element.attributes['data-setting-id'].value, 'edit');
                $('#supplier_city').val(data.city);
                loader.find(".loadingSpinner:first").remove();
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    resetEditButton: function (id) {
        PosnicPro.suppliers.editSupplier(id);
    },
    addSupplierButton: function () {
        var loader = $(".loader-supplier");
        loader.find(".loadingSpinner:first").remove();
            $('#supplier_title').text(PosnicPro.i18n.t('lang_new_title', 'Add'));
            $('#supplier_button_title').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
        $('.update-button').attr('disabled', 'disabled').removeClass('btn-outline-success');
        $('#supplierid').val('');
        $('#suppliers_new .alert').remove();
        $('#show_last_created_supplier').hide();
    },
    supplierClearForm: function () {
        $('#supplier_add')[0].reset();
        $('#supplier_country').val(PosnicPro.local.get("country_setting")).trigger('change.select2');
        PosnicPro.local.set('edit_supplier_state', PosnicPro.local.get("state_setting"));
        $('#supplier_city').val(PosnicPro.local.get("city_setting") || "");
        PosnicPro.suppliers.loadSelectSupplierState(PosnicPro.local.get('countryid'), 'clear');
        $('.error_supplier').css('display', 'none');
    },
    loadSelectSupplierState: function (id, action) {
        var stateSelect = $('#supplier_state');
        var request = (PosnicPro.suppliers.stateRequest || 0) + 1;
        PosnicPro.suppliers.stateRequest = request;
        var selectedState = action === 'edit' ? PosnicPro.local.get('edit_supplier_state') :
            (action === 'add' || action === 'clear') ? PosnicPro.local.get('state_setting') : '';
        var params = {
            url: 'setting/getJSONState',
            data: {id: id}
        };
        PosnicPro.get(params, function (response) {
            if (PosnicPro.suppliers.stateRequest !== request) return;
            stateSelect.empty();
            stateSelect.append(new Option('', ''));
            (response.data.stateJsonArray || []).forEach(function (state) {
                stateSelect.append(new Option(state, state));
            });
            var match = Array.from(stateSelect[0].options).find(function (option) { return option.value.trim().toLowerCase() === String(selectedState || '').trim().toLowerCase(); });
            if (!match && selectedState) stateSelect.append(new Option(selectedState, selectedState));
            stateSelect.val(match ? match.value : (selectedState || '')).trigger('change.select2');
            (PosnicPro.suppliers.supplier_phone || { setCountry: function () {} }).setCountry(response.data.countrySortName);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    validForm: function () {

        $("#supplier_add").validate({
            errorClass: 'error error_supplier',
            highlight: function (element, errorClass) {
                $(element).css("border-color", "#f9616d");
            },
            unhighlight: function (element, errorClass) {
                $(element).css("border-color", "#eae8e8");
            },
            rules: {
                name: {
                    required: true,
                    minlength: 3,
                    maxlength: 250,
                    cname: true
                },
                address: {
                    minlength: 3,
                    maxlength: 500
                },
                email: {
                    email: true,
                    emailExt: true,
                    maxlength: 250
                },
                phone: {
                    minlength: 3,
                    maxlength: 20,
                    supplier_phone_number: true
                },
                city: {
                    city: true,
                    maxlength: 20
                }
            },
            messages: {
                name: {
                    required: "Enter the supplier name",
                    minlength: "Supplier Name Must be Atleast 3 Characters",
                    maxlength: "Supplier name should not be more than 250 characters"
                },
                address: {
                    minlength: "Supplier Address must be Atleast 3 Characters long",
                    maxlength: "Address is too Long !"
                },
                email: {
                    maxlength: "Email should not be more than 250 Characters"
                },
                phone: {
                    supplier_phone_number: "Enter a valid phone number",
                    minlength: "Use at least 3 characters",
                    maxlength: "Use no more than 20 characters"
                },
                city: {
                    maxlength: "Supplier city should not be more than 20 Characters"
                }
            }
        });
        jQuery.validator.addMethod("supplier_phone_number", function (phone_number, element) {
            // If the field is empty, allow it to be valid
            if (!phone_number) {
                return true;  // Allow blank phone number
            }
            let valid = PosnicPro.suppliers.supplier_phone.isValidNumber();
            let num = PosnicPro.suppliers.supplier_phone.getNumber();
            if (valid === true) {
                $('#supplier_phone').val(num);
                return true;
            } else {
                return false;
            }

        }, "Enter a valid phone number");
        $("#supplier_add").submit(function (event) {
            event.preventDefault();
            if ($('#supplier_add').valid()) {            // checks form for validity
                PosnicPro.suppliers.supplier();
            }
        });
    }

};
PosnicPro.supplierdetails = {

    supplierdetailsTable: function (type) {
        PosnicPro.appendReportTableBody('supplierdetails');
        var loader = $(".loader-supplieractivity");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        var table = $('#view_supplierdetails');
        if ($('a#view_suppliers_page').hasClass('active')) {
            var branch = [];
            branch.push(PosnicPro.local.get("branch_id_set"));
        } else {
            var branch = $("#supplier_branch_value").val()
        }
        if (type === 'supplierreportexport') {
            var per_page = table.data('total');
        } else {
            var current_page = table.data('current_page');
            var per_page = $('#view_supplierdetails_per_page').val();
        }
        let supplier_id = currentHash.split('/');
        var data = {
            page: current_page,
            limit: per_page,
            supplier_id: supplier_id[1],
            branch: branch
        };
        var params = {
            url: 'receivings/supplierReceivingDetails',
            data: data
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                if (type !== 'supplierreportexport') {
                    table.data('total', response.data.table.data.total);
                    table.data('total_pages', response.data.table.data.total_pages);
                    table.data('current_page', response.data.table.data.current_page);
                    table.data('per_page', response.data.table.data.per_page);
                    PosnicPro.paging(response.data.table.data.total_pages, response.data.table.data.current_page);
                    table.children('tbody').text('');
                    $('#view_supplierdetails_total,.supplier_details_noofsale').text(response.data.table.data.total);
                    var row_total = (table.data('current_page') - 1) * table.data('per_page') + 1;
                    $('#view_supplierdetails_page_total').text(row_total);
                    var page_totals = (table.data('current_page') - 1) * table.data('per_page');
                    $('#view_supplierdetails_page_perpage_total').text(page_totals + response.data.table.data.list.length);
                    var currency = PosnicPro.local.get('currencySign');
                    var rowTotal = response.data.table.data.total;
                    if (rowTotal === 0) {
                        $('.supplieractivity_content').hide();
                        $('#supplieractivity_img_hide').show();

                    } else {
                        $('#supplieractivity_img_hide').hide();
                        $('.supplieractivity_content').show();
                    }
                    var process_class = "badge badge-success-inverse";
                    var purchaseTotalValue = 0;
                    var returnTotalValue = 0;
                    var purchaseTotalQty = 0;
                    var returnTotalQty = 0;
                    for (var i = 0; i < response.data.table.data.list.length; i++) {
                        var row = response.data.table.data.list[i];
                        purchaseTotalValue += Number(row.items_total) || 0;
                        returnTotalValue += Number(row.items_return_total) || 0;
                        if (row.receiving_status == 'Received') {
                            process_class = "badge badge-success-inverse";
                        } else if (row.receiving_status == 'PartialReturn') {
                            process_class = "badge badge-secondary-inverse";
                        } else {
                            process_class = "badge badge-danger-inverse";
                        }
                        let purchaseQty = 0;
                        $(row.items).each(function (key, val) {
                            purchaseQty += val.item_quantity;
                            purchaseTotalQty += val.item_quantity;
                        });
                        let returnQty = 0;
                        $(row.items_return).each(function (key, val) {
                            $(val.returnArray.returnValue).each(function (key, val) {
                                returnQty += val.item_quantity;
                                returnTotalQty += val.item_quantity;
                            });
                        });
                        let row_no = (table.data('current_page') - 1) * table.data('per_page') + i + 1;
                        let updateDate = PosnicPro.convertDate(row.string_date);
                        let trow = '<tr> <td scope="row">' + row_no + '</td> <td>' + row.receiving_id + '</td> <td class="export-date">' + updateDate + '</td> <td class="text-center"><span class="' + process_class + '">' + row.receiving_status + '</span></td> <td class="text-center text-danger">' + returnQty + '</td> <td class="text-right text-danger">' + currency + '&nbsp;' + (Number(row.items_return_total) || 0).toFixed(2) + '</td><td class="text-center text-success">' + purchaseQty + '</td><td class="text-right">' + currency + '&nbsp;<span class="number">' + (Number(row.items_total) || 0).toFixed(2) + '</span></td></tr>';
                        $('#view_supplierdetails').children('tbody').append(trow);
                        $('span.number').number(true, 2);
                    }
                    $('.supplier_details_totalpurchase').html(purchaseTotalQty);
                    $('.supplier_details_totalreturn').html(returnTotalQty);
                    // Prefer the server's COMPLETE purchase/return totals for
                    // this supplier, not a sum over just the loaded page.
                    var supPurchaseTotal =
                        response.data.purchase_amount !== undefined && response.data.purchase_amount !== null
                            ? Number(response.data.purchase_amount)
                            : purchaseTotalValue;
                    var supReturnTotal =
                        response.data.return_amount !== undefined && response.data.return_amount !== null
                            ? Number(response.data.return_amount)
                            : returnTotalValue;
                    $('.supplier_details_purchasetotalvalue').html(supPurchaseTotal.toFixed(2));
                    $('.supplier_details_returntotalvalue').html(supReturnTotal.toFixed(2));
                } else {
                    var supplierreceivingreport = [];
                    data = response.data.table.data.list;
                    $(data).each(function (key, val) {
                        let purchaseQty = 0;
                        $(val.items).each(function (key, val) {
                            purchaseQty += val.item_quantity;
                        });
                        let returnQty = 0;
                        $(val.items_return).each(function (key, val) {
                            $(val.returnArray.returnValue).each(function (key, val) {
                                returnQty += val.item_quantity;
                            });
                        });
                        let Date = PosnicPro.convertDate(val.string_date);
                        let Recivingid = val.receiving_id;
                        let process = val.receiving_status;
                        let returnTotal = val.items_return_total;
                        let purchaseTotal = val.items_total;
                        supplierreceivingreport.push({RecivingId: Recivingid, Date: Date, Process: process, NoOfReturn: returnQty, ReturnAmount: returnTotal, NoOfSale: purchaseQty, PurchaseAmount: purchaseTotal});
                    });
                    PosnicPro.JSONToCSVConvertor(supplierreceivingreport, 'supplier-receiving-reports', true);
                    PosnicPro.supplierdetails.supplierdetailsTable();
                }
            }
            loader.find(".loadingSpinner:first").remove();
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    supplierdetailsreportexport: function (index) {
        var type = $(index).data('id');
        PosnicPro.supplierdetails.supplierdetailsTable(type);
    }
};

$("#suppliers_new").on('shown.bs.modal', function () {
    $('#supplier_name').focus();
});
$("#supplierSubmitForm").one('click', function () {
    PosnicPro.suppliers.validForm();
});
$('#supplier_country').one('change', function () {
    var countrySelect = $('#supplier_country');
    countrySelect.on('select2:select', function (e) {
        var data = e.params.data;
        PosnicPro.suppliers.loadSelectSupplierState(data.element.attributes['data-setting-id'].value, 'onChange');
    });
});

$(function () {
    PosnicPro.lazyPhoneInput('#supplier_phone', PosnicPro.suppliers, 'supplier_phone', {
        separateDialCode: true,
        initialCountry: 'eg',
        preferredCountries: ['eg'],
        hiddenInput: "full",
        utilsScript: "../static/script/js/utils.js"
    });
});
/*end*/

/* The filter toggle, delegated - the same contract every standard page
   uses: mount (or remount) then flip the strip. */


$(document).on('click', '#suppliers_filter_btn', function () {
    PosnicPro.suppliers.mountFilters(true);
    PosnicPro.listFilter.toggle('suppliers');
});

$(document).on('click', '#s_doc_purchases .s-doc-purchase-row[data-doc]', function () {
    PosnicPro.suppliers.togglePurchasePreview($(this), $(this).data('doc'));
});
