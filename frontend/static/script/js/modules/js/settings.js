PosnicPro.settings = {
    /* which reference lists have been fetched this session */
    _refLoaded: {},
    _refPending: {},

    store_telephone: null,
    /*
     * #/settings/<x> serves two callers: a 24-hex Mongo id is a recycle-bin
     * row (the original meaning), anything else is a SECTION deep link
     * (#/settings/modules, #/settings/features ...) so a refresh keeps the page
     * you were on - Config sections finally have routes.
     */
    showDetails: function (id) {
        if (!/^[0-9a-f]{24}$/i.test(String(id))) {
            PosnicPro.settings.openSection(String(id));
            return;
        }
        var loader = $(".loader-view-recyclebin");
        loader.find(".loadingSpinner:first").remove();
        PosnicPro.settings.viewRecycleBinDetails(id);
    },
    openSection: function (key) {
        var openWording = key === 'wording';
        if (openWording) key = 'general';
        var openReceiptDesign = key === 'print';
        if (openReceiptDesign) key = 'general';
        if (!$('#settings').is(':visible')) {
            PosnicPro.settings.showDataTablePage();
        }
        // Pill ids are v-pills-<key>-tab, with a few legacy ones missing the
        // suffix (v-pills-unit). Clicking (not tab('show')) runs the pill's
        // own loader onclick; an already-active pill is a no-op, so the
        // hash-sync round trip cannot loop.
        /*
         * Sections that MOVED keep their old addresses working. The desktop
         * app and old bookmarks still say #/settings/branches; walking that
         * into a pill that no longer exists left whatever panes were last
         * active stacked on screen - the owner's "broken page". A legacy key
         * routes to the page that owns it now; a key nobody knows lands on
         * Core Settings rather than on rubble.
         */
        var LEGACY_SECTIONS = {
            branches: 'branches',
            outlet: 'branches',
        };
        if (LEGACY_SECTIONS[key]) {
            hasher.setHash(LEGACY_SECTIONS[key]);
            return;
        }
        var $pill = $('#v-pills-' + key + '-tab');
        if (!$pill.length) { $pill = $('#v-pills-' + key); }
        if (!$pill.length) { key = 'general'; $pill = $('#v-pills-general-tab'); }
        // NOT :visible - the whole pills rail is display:none now (the
        // Manage sidebar replaced it), which made every pill "invisible"
        // and silently refused every section switch. Module gating sets
        // INLINE display:none on individual pills; that is the real gate.
        if ($pill.length && $pill.css('display') !== 'none') { $pill[0].click(); }
        /*
         * The click ASKS Bootstrap to switch panes; this ENFORCES it.
         *
         * The general pane ships 'show active' in the markup, and this page
         * already carries one duplicated-id landmine (#v-pills-tab exists
         * twice - the sidebar rail got there first). When the tab plugin
         * resolves the wrong "previously active" element, it activates the
         * new pane WITHOUT deactivating general - and the owner's Features
         * page grew the whole day-to-day settings form underneath its
         * cards. One pane per section, whatever Bootstrap thought.
         */
        var $pane = $('#v-pills-' + key);
        if ($pane.hasClass('tab-pane')) {
            $pane.siblings('.tab-pane').removeClass('show active');
            $pane.addClass('show active');
        }
        /* The Manage-sidebar highlight mirrors from shown.bs.tab - which
           Bootstrap never fires for a pill that is ALREADY active. Core
           Settings ships active in the markup, so the FIRST entry never
           highlighted its menu row (owner report). Mirror directly; the
           event handler doing it again is harmless. */
        $('.manage-settings-entry').removeClass('active');
        $('#manage_sec_' + key).addClass('active');
        if (key === 'general') { PosnicPro.settings.restoreCoreTab(); }
        if (openWording) {
            $('#core-wording-tab').tab('show');
        }
        if (openReceiptDesign) {
            $('#core_settings_tabs a[href="#core-tab-print"]').tab('show');
            $('#print-design-tab').tab('show');
        }
        if (PosnicPro.desktopSettings) { PosnicPro.desktopSettings.load(key); }
    },
    restoreCoreTab: function () {
        var stored = PosnicPro.local.get('posnic_core_tab');
        if (stored && $('#core_settings_tabs a[href="' + stored + '"]').length) {
            $('#core_settings_tabs a[href="' + stored + '"]').tab('show');
        }
    },
    showShortcut: function () {
        $('#shortcutkey').modal('show');
        $(document).ready(function () {
            $("#shortcutkey").on("keypress", function (e) {
                if ((e.keyCode <= '122')) {
                    $('#shortcutkey').modal('hide');
                }
            });
        });
    },
    restoreDetails: function (id) {
        PosnicPro.settings.restoreTableData(id);
    },
    /*** restore Document Backup ***/
    restoreTableData: function (id) {
        var arr = [];
        var obj = {};
        obj = id;
        arr.push(obj);
        var params = {
            url: 'setting/restoreBackup',
            data: JSON.stringify({ data: arr })
        };
        PosnicPro.post(params, function (response) {
            if (response.type === 'success') {
                PosnicPro.settings.settingsTable();
                PosnicPro.items.loadSelectCategory();
                PosnicPro.stocklogs.viewLowStockDashboard();
                hasher.setHash('settings');
            }
            PosnicPro.alert(response.type, response.message);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    triggerDefault: function (name) {
        $('.customer_edit_reset').hide();
        $('default' + name).val('');
        $('#' + name + '_title').text(PosnicPro.i18n.t('lang_nav_add', 'Add'));
        $('#' + name + '_button_title').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
        $('.' + name + '-trigger').val('');
        $(".infobar-settings-sidebar-overlay").css({ "background": "rgba(0,0,0,0.4)", "position": "fixed" });
        $("#infobar-settings-sidebar-" + name).addClass("sidebarshow");
        let default_name = $('.default-' + name + '-name').val();
        $('#' + name + '_name').val(default_name);
    },
    viewRecycleBinDetails: function (id) {
        var module_name = $('#backuptablelist :selected').val();
        $(".setting-heading").text(module_name);
        var loader = $(".loader-view-recyclebin");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        var params = {
            url: 'setting/getRecycleBin',
            data: { id: id }
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                var data = response.data;
                var module = $('#backuptablelist').val();
                if (module === 'customers') {
                    PosnicPro.customers.viewCustomerData(response);
                } else if (module === 'suppliers') {
                    PosnicPro.suppliers.viewSupplierData(response);
                } else if (module === 'categories') {
                    PosnicPro.categories.viewCategoryData(response);
                } else if (module === 'branches') {
                    PosnicPro.branches.viewBranchData(response);
                } else if (module === 'users') {
                    PosnicPro.users.viewUserData(response);
                } else if (module === 'sales') {
                    $('#sales-total-hide,#viewsale_edit_print_view,#salesitemtitleText,#sale_print_view,#return_print_view').show();
                    $('#hide_sales_print,#hide_return_print').show();
                    var data = response.data;
                    if (data.payment_description === '') {
                        $('.paynote_hide').hide();
                    } else {
                        $('.paynote_hide').show();
                    }
                    if (data.sales_description === '') {
                        $('.salenote_hide').hide();
                    } else {
                        $('.salenote_hide').show();
                    }
                    if (data.sale_process === 'Add' || data.sale_process === 'Edit' || data.sale_process === 'Hold') {
                        $('.sale-view-heading').html(PosnicPro.i18n.t('lang_newsale_title', 'Sale'));
                        $('.hide-sale-return,#salesreturntitleText,#return_print_view,#hide_return_print,#show_sales_print').hide();
                    } else if (data.sale_process === 'FullReturn') {
                        $('.sale-view-heading').html(PosnicPro.i18n.t('lang_return_title', 'Return'));
                        $('.hide-sale-return,#salesreturntitleText,#return_print_view,#hide_return_print').show();
                        $('#viewsale_edit_print_view,#salesitemtitleText,#sales-total-hide,#sale_print_view,#hide_sales_print,#show_sales_print').hide();
                    } else {
                        $('.sale-view-heading').html(PosnicPro.i18n.t('lang_newsale_title', 'Sale'));
                        $('#sales-total-hide,.hide-sale-return,#salesreturntitleText,#return_print_view,#hide_return_print,#show_sales_print').show();
                        $('#hide_sales_print,#hide_return_print').hide();
                    }
                    var saleId = data._id || data.id || id;
                    PosnicPro.record_id = saleId;
                    PosnicPro.sales.view.viewSaleData(response, saleId);
                } else if (module === 'stocklogs') {
                    PosnicPro.stocklogs.viewStockData(response);
                } else {
                    $('#receiving_button_print_view,#receiving_return_print_view').show();
                    $('#hide_receiving_print,#hide_receiving_return_print').show();
                    if (data.receiving_status === 'FullReturn') {
                        $('.hide-receiving-return,#receiving_return_print_view,#hide_receiving_return_print').show();
                        $('.hide-receiving-table,#receiving_button_print_view,#show_receiving_print,#hide_receiving_print').hide();
                    } else if (data.receiving_status === 'Open' || data.receiving_status === 'Received') {
                        $('.hide-receiving-table,#receiving_button_print_view,#hide_receiving_print').show();
                        $('.hide-receiving-return,#receiving_return_print_view,#show_receiving_print,#hide_receiving_return_print').hide();
                    } else {
                        $('.hide-receiving-table,.hide-receiving-return,#receiving_button_print_view,#receiving_return_print_view,#show_receiving_print').show();
                        $('#hide_receiving_print,#hide_receiving_return_print').hide();
                    }

                    $('#receivingtitelText').html('Receiving Details (' + data.receiving_status + ')');
                    PosnicPro.receivings.view.viewReceivingData(response);
                }
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    settingsTable: function () {
        PosnicPro.HideSideBarModal();
        let branchId = $("#Select_backup_Branch").val().toString();
        if (branchId !== '') {
            $("#backup_report_selecter").hide();
            $("#backup_report_table_div").show();
            let tableName = $('#backuptablelist').val();
            (tableName === 'branches') ? $('#hide_branch_recyclebin,#Select_backup_Branch').hide() : $('#hide_branch_recyclebin,#Select_backup_Branch').show();
            let loader = $(".loader-table-recyclebin,.loader-table-setting");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.appendRecyclebinDataTableBody(tableName);
            $("#view_settings").show();
            let daterange = $("#view_backup_daterange").val();
            let fields = daterange.split('-');
            let first_date = fields[0];
            let last_date = fields[1];
            let field_select = $("#view_recycle_bin_fields option:selected").val();
            let field_input = $("#view_recycle_bin_input").val();
            let table = $('#view_settings');
            $('#card_recycle').css({ "background-color": "transparent", "margin-bottom": "0px" });
            let data = {
                page: table.data('current_page'),
                limit: parseInt($('#view_settings_per_page  option:selected').text()),
                table: tableName,
                starting_date: first_date,
                ending_date: last_date,
                branch: $("#Select_backup_Branch").val(),
                field_select: field_select,
                field_input: field_input
            };
            let params = {
                url: 'setting/backupTable',
                data: data
            };
            PosnicPro.get(params, function (response) {
                if (response.type === 'success') {
                    table.data('total', response.data.total);
                    table.data('total_pages', response.data.total_pages);
                    table.data('current_page', response.data.current_page);
                    table.data('per_page', response.data.per_page);
                    PosnicPro.paging(response.data.total_pages, response.data.current_page);
                    table.children('tbody').text('');
                    $('#view_settings_total').text(response.data.total);
                    var row_total = (table.data('current_page') - 1) * table.data('per_page') + 1;
                    $('#view_settings_page_total').text(row_total);
                    var page_totals = (table.data('current_page') - 1) * table.data('per_page');
                    $('#view_settings_page_perpage_total').text(page_totals + response.data.list.length);
                    var currency = PosnicPro.local.get('currencySign');
                    for (var i = 0; i < response.data.list.length; i++) {
                        var row = response.data.list[i];
                        var row_no = (table.data('current_page') - 1) * table.data('per_page') + i + 1;
                        var action = '<div id="onclick-toolbar-options_' + i + '" class="hidden">' +
                            '<a data-module = "branch" data-access = "read"  href="#/settings/' + row._id + '" data-id="settings/' + row._id + '"  data-toggle="tooltip" title="View" data-t-title="lang_view" class="point-cursor mobile_tooltip"><i class="feather icon-eye"></i></a>' +
                            '<a data-module = "branch" data-access = "write" data-toggle="tooltip" title="Restore" data-t-title="lang_restore_title" href="#/settings/' + row._id + '/restore" data-id="settings/' + row._id + '/restore" class="point-cursor mobile_tooltip"><i class="feather icon-repeat"></i></a>' +
                            '</div>' +
                            '<div data-toolbar="user-options" class="btn btn-round btn-primary-rgba round-pad" id="onclick-toolbar_' + i + '"><i class="feather icon-more-vertical-"></i></div>';
                        var updateDate = PosnicPro.convertDate(row.document_backup_date || row.string_date || row.date || row.created_date);
                        if (tableName === 'sales') {
                            var trow = '<tr> <td><input type="checkbox" class="sales-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'sales\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.sales_id + '</td> <td>' + updateDate + '</td> <td>' + row.customer_name + '</td> <td class="text-center"><span class="badge badge-success-inverse">' + row.sale_process + '</span></td> <td class="text-right">' + currency + '&nbsp;<span class="number">' + row.sales_total + '</span></td> <td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'receivings') {
                            var receiving_status = '';
                            if (row.receiving_status === 'open') {
                                receiving_status = row.receiving_status;
                            } else {
                                if (row.items.length === 0 && row.items_return.length > 0) {
                                    receiving_status = 'FullReturn';
                                } else if (row.items_return.length === 0 && row.items.length > 0) {
                                    receiving_status = row.receiving_status;
                                } else {
                                    receiving_status = 'PartialReturn';
                                }
                            }

                            var trow = '<tr> <td><input type="checkbox" class="receivings-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'receivings\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.receiving_id + '</td> <td>' + updateDate + '</td> <td>' + row.supplier_name + '</td> <td class="text-center"><span class="badge badge-success-inverse">' + receiving_status + '</span></td> <td class="text-right">' + currency + '&nbsp;<span class="number">' + row.total_amount + '</span></td>  <td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'branches') {
                            var trow = '<tr> <td><input type="checkbox" class="branches-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'branches\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.branch_name + '</td> <td><a class="sale_color" href="tel:' + row.store_telephone + '">' + row.store_telephone + '</a></td> <td><a class="sale_color" href="mailto:' + row.store_email + '">' + row.store_email + '</a></td> <td>' + row.store_address + '</td>' + '<td>' + row.state + '</td>' + '<td>' + row.country + '</td>' + '<td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'categories') {
                            var discountSign = (row.discount_amount > 0) ? '$' : '%';
                            if (row.discount_amount > 0) {
                                var discount = row.discount_amount;
                            } else {
                                discount = row.discount_percentage;
                            }
                            var image_path = (row.image !== "category.svg") ? row.image : 'static/images/default/' + row.image;
                            var trow = '<tr> <td><input type="checkbox" class="categories-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'categories\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.name + '</td> <td><img loading="lazy" decoding="async" src=' + image_path + ' width=30 height=20 class="imagezoom" id="' + row.image + '" onclick="PosnicPro.viewImage(this.id,\'category\');"></td> <td>' + discount + '' + discountSign + '</td> <td>' + (row.description || '') + '</td> <td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'customers') {
                            var trow = '<tr> <td><input type="checkbox" class="customers-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'customers\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.name + '</td> <td><a class="sale_color" href="tel:' + (row.phone || '') + '">' + (row.phone || '') + '</a></td> <td><a class="sale_color" href="mailto:' + (row.email || '') + '">' + (row.email || '') + '</a></td> <td>' + (row.address || '') + '</td><td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'items') {
                            var image_path = (row.image !== "item.svg") ? row.image : 'static/images/default/' + row.image;
                            var trow = '<tr> <td><input type="checkbox" class="items-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'items\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.name + '</td> <td><img loading="lazy" decoding="async" src=' + image_path + ' width=30 height=20 class="imagezoom" id="' + row.image + '" onclick="PosnicPro.viewImage(this.id,\'image\');"></td> <td>' + row.itemid + '</td> <td>' + currency + '&nbsp;<span class="number">' + row.selling_price + '</span></td> <td>' + row.available_quantity + '</td> <td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'suppliers') {
                            var trow = '<tr> <td><input type="checkbox" class="suppliers-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'suppliers\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.name + '</td> <td><a class="sale_color" href="tel:' + (row.phone || '') + '">' + (row.phone || '') + '</a></td> <td><a class="sale_color" href="mailto:' + (row.email || '') + '">' + (row.email || '') + '</a></td> <td>' + (row.address || '') + '</td> <td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'registers') {
                            var trow = '<tr> <td data-module="user" data-access="delete"><input type="checkbox" class="registers-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'registers\');"></td> <td scope="row">' + row_no + '</td> <td>' + row.register_name + '</td><td>' + updateDate + '</td><td>' + row.sales_id + '</td><td>' + row.created_by + '</td><td>' + row.branch_name + '</td><td class="text-right">' + currency + '&nbsp;<span class="number">' + row.register_amount + '</span></td> <td><span>' + action + ' </span></td> </tr>';
                        } else if (tableName === 'stocklogs') {
                            var trow = '<tr> <td data-module="user" data-access="write"><input type="checkbox" class="stocklogs-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'stocklogs\');"></td> <td scope="row">' + row_no + '</td>  <td class="text-center">' + row.item_barcode_id + '</td> <td>' + row.item_name + '</td><td>' + updateDate + '</td> <td class="text-center"><span class="badge badge-success-inverse">' + row.process + '</span></td><td class="text-right">' + currency + '&nbsp;<span class="number">' + row.opening_balance + '</span></td><td class="text-right">' + currency + '&nbsp;<span class="number">' + row.closing_balance + '</span></td> <td><span>' + action + ' </span></td> </tr>';
                        } else {
                            var image_path = (row.image !== "user.svg") ? row.image : 'static/images/default/' + row.image;
                            var trow = '<tr> <td><input type="checkbox" class="users-row-id" id="' + row._id + '" name="id[]" value="' + row._id + '" onclick="PosnicPro.checkboxSelectOne(this,\'users\');"></td> <td scope="row">' + row_no + '</td>  <td>' + row.username + '</td> <td><img loading="lazy" decoding="async" src=' + image_path + ' width=30 height=20 class="imagezoom" id="' + row.image + '" onclick="PosnicPro.viewImage(this.id,\'user\');"></td> <td><a class="sale_color" href="mailto:' + (row.email || '') + '">' + (row.email || '') + '</a></td> <td>' + row.usertype + '</td><td><span>' + action + ' </span></td> </tr>';
                        }
                        $('#view_settings').children('tbody').append(trow);
                    }
                    $('span.number').number(true, 2);
                    $(document).ready(function () {
                        for (var i = 0; i < response.data.list.length; i++) {
                            $('#onclick-toolbar_' + i).toolbar({
                                content: '#onclick-toolbar-options_' + i,
                                event: 'click',
                                style: 'primary',
                                hideOnClick: true
                            });
                            $('#onclick-toolbar_' + i).on('toolbarItemClick', function (event, element) {
                                hasher.setHash($(element).data('id'));
                                $(this).trigger('click');
                                $('.mobile_tooltip').tooltip('hide');
                            });
                        }
                    });
                    PosnicPro.setSelectedCheckbox(PosnicPro[tableName + "_checkbox"], tableName);
                    loader.find(".loadingSpinner:first").remove();
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
        } else {
            $('#card_recycle').css({ "display": "block", "background-color": "#fff", "margin-bottom": "30px" });
            $("#Select_backup_Branch").select2('focus');
            var branch_id = PosnicPro.local.get('branch_id_set');
            $('.display-current-branch').select2('val', [branch_id]);
        }
    },
    showDataTablePage: function () {
        $('.print_url').hide();
        if (PosnicPro.local.get('userplan') !== 'free') {
            $('.print_url').show();
        }
        PosnicPro.HideSideBarModal();
        PosnicPro.dashboard.datePicker();
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $(".vertical-layout").removeClass("toggle-menu");
        $(".vertical-menu li a").removeClass("active");
        $('.dropdown-item').removeClass('active');
        $('.page_loader,#osk-container,#danger_zone').hide();
        $('.page-title-box,#settings,#dangerZone,#dangetzoneUserverify').show();
        $('#v-pills-manage-tab,#view_config_page').addClass('active');
        $('#v-pills-manage').addClass('show active');
        $('.dashboard_img_menu').hide();
        $('#image_sidebar_config').show();
        if ($('a#v-pills-recyclebin-tab').hasClass('active')) {
            PosnicPro.settings.settingsTable();
        }
        PosnicPro.settings.coreTabsOverflow();
        PosnicPro.settings.restoreCoreTab();
        if (PosnicPro.itemsettings) PosnicPro.itemsettings.load();
        // Every Config open re-reads server truth. The controls used to be
        // populated only at login (the DOM carried them between visits), so
        // a change saved on another till showed stale here until re-login -
        // and "does Module On/Off preserve the selections?" deserves a
        // guaranteed yes, not a usually.
        PosnicPro.settings.initPrintEditors();
        PosnicPro.settings.viewSettings(PosnicPro.local.get('branch_id_set'));
        /* Core Settings is the tab that is already active, so a click handler
           alone never fires on the way in - the switches would sit at their
           markup default and disagree with what is stored. */
        PosnicPro.settings.loadSharing();
        /* Which tills may print this shop's bills. Guarded because the module
           is only on the pages that carry the card, and a settings page that
           throws here would stop drawing everything after it. */
        if (PosnicPro.printTills) PosnicPro.printTills.render();
    },
    settingImageFormSubmit: function () {
        if ($('#setting_image_value').val() !== '') {
            var data = new FormData(document.getElementById("setting_image_add"));
            PosnicPro.requestImage('POST', "setting/updateBranchLogo", data, false, function (response) {
                if (response.type === 'success') {
                    var imgdata = response.data.replace(/\s/g, '');
                    $('#setting_logo_value').val(imgdata);
                    var image_path = (imgdata !== "store.png") ? imgdata : 'static/images/default/' + imgdata;
                    $('#previewing,#store_image').attr('src', image_path);
                    PosnicPro.settings.updatedImage();
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            });
        } else {
            PosnicPro.alert('success', PosnicPro.i18n.t('lang_image_updated', 'Image updated'));
        }
        return false;
    },
    updatedImage: function () {
        var params = {
            url: 'setting/storedImageData',
            data: JSON.stringify(PosnicPro.getFormData($('#setting_image_add')))
        };
        PosnicPro.put(params, function (response) {
            if (response.type === 'success') {
                PosnicPro.local.set('branchimage', response.data);
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    /*store details Add/Update function*/
    generalSetting: function (value) {
        if ($('#setting_add').valid()) {
            var loader = $(".loader-view-generalsetting");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            var currency = $('#currency_type').val();
            var timeZone = $("#time_zone").select2("data");
            var currencyText = $('#currencyText').val();
            var currencyTextname = $('#currencyTextname').val();
            var timezoneValue = {
                time_zone: timeZone[0].element.attributes['data-timezone-name'].value
            };
            let countryValue = $("#setting_country").select2("data");
            let countryId = {
                country_id: countryValue[0].element.attributes['data-setting-id'].value
            };
            var formData = PosnicPro.getFormData($('#setting_add'));
            delete formData.full;
            formData.store_telephone = PosnicPro.settings.store_telephone.getNumber();
            /* The form lives on the Branch edit page now and always names its
               target branch; registers ride along (class-collected - the
               dynamic rows are not form-serialized). Local state refresh only
               applies when the branch being edited IS the session branch. */
            var target = $('#edit_branch_target').val() || '';
            var editingCurrent = !target || target === PosnicPro.local.get('branch_id_set');
            var registers = {
                register: $('.be-register').map(function () { return $(this).val(); }).get()
                    .filter(function (v) { return v && v.trim().length >= 3; })
            };
            var params = {
                url: 'setting/updateGeneralSetting',
                data: JSON.stringify(Object.assign(formData, timezoneValue, countryId, registers))
            };
            PosnicPro.put(params, function (response) {
                loader.find(".loadingSpinner:first").remove();
                if (response.type === 'success' && !editingCurrent) {
                    loader.find(".loadingSpinner:first").remove();
                    PosnicPro.alert(response.type, response.message);
                    hasher.setHash('branches');
                    PosnicPro.branches.branchesTable('branches');
                    return;
                }
                if (response.type === 'success') {
                    $('.print_store_address').text(response.data['printing_address']);
                    $('.print_store_telephone').text(response.data['store_telephone']);
                    $('.print_store_alternativephone').text(response.data['store_alternativephone']);
                    $('.print_store_email').text(response.data['store_email']);
                    $('.print_store_name').text(response.data['branch_name']);
                    $('.display-currency').text(currency);
                    $('#setting_status').val("Yes");
                    PosnicPro.local.set("country_setting", response.data.country);
                    $(document).trigger('posnic:country-changed');
                    PosnicPro.local.set("state_setting", response.data.state || "");
                    PosnicPro.local.set("city_setting", response.data.city || "");
                    PosnicPro.local.set('countryid', response.data['country_id']);
                    PosnicPro.local.set('countryname', '');
                    PosnicPro.local.set('statename', '');
                    PosnicPro.local.set('countryname', response.data['country']);
                    PosnicPro.local.set('statename', response.data['state']);
                    PosnicPro.local.set('dateformatset', response.data['clientdate']);
                    PosnicPro.local.set('setdateformat', response.data['serverdate']);
                    PosnicPro.local.set('timezone', response.data['time_zone']);
                    PosnicPro.local.set('timeformat', response.data['time_format']);
                    PosnicPro.local.set('currencySign', currency);
                    $(".branch-name").text(response.data['branch_name']);
                    PosnicPro.local.set('branchname', response.data['branch_name']);
                    PosnicPro.local.set('allow_sale_hard_delete', (response.data.allow_sale_hard_delete === true || response.data.allow_sale_hard_delete === 'true') ? 'true' : 'false');
                    PosnicPro.local.set('branchemail', response.data['store_email']);
                    PosnicPro.local.setVolatile('branchphone', response.data['store_telephone']);
                    PosnicPro.local.set('branchaddress', response.data['store_address']);

                    // Store general settings including hardware_weight_machine_enable
                    var generalSettings = {
                        sale_redirect_seconds: PosnicPro.saleRedirectSeconds(),
                        stock_management: response.data['stock_management'] !== false,
                            hardware_weight_machine_enable: response.data['hardware_weight_machine_enable'] || false,
                        till_lock_enable: response.data['till_lock_enable'] || false,
                        till_lock_idle_minutes: response.data['till_lock_idle_minutes'] || 0,
                        staff_shifts_enable: response.data['staff_shifts_enable'] !== false,
                        staff_tips_enable: response.data['staff_tips_enable'] === true,
                        staff_roster_enable: response.data['staff_roster_enable'] !== false,
                        cash_register_enable: response.data['cash_register_enable'] !== false,
                        module_recyclebin_enable: response.data['module_recyclebin_enable'] !== false,
                        module_themes_enable: response.data['module_themes_enable'] !== false,
                        quick_sale_enable: response.data['quick_sale_enable'] === true,
                        custom_charges_enable: response.data['custom_charges_enable'] === true,
                        first_run_done: PosnicPro.features.keepFirstRunFlag(response.data),
                        first_run_decided: PosnicPro.features.keepFirstRunFlag(response.data, 'first_run_decided')
                    };
                    PosnicPro.local.set('general_settings', JSON.stringify(generalSettings));
                    PosnicPro.shiftWidget.applyEnabled();

                    let branchRecord = [];
                    branchRecord.push({ name: response.data['branch_name'], phone: response.data['store_telephone'], email: response.data['store_email'], address: response.data['store_address'], image: response.data['branch_image'] });
                    db.customerDisplay.put({ id: '2', 'clear': 'no', 'get': 'no', branch: branchRecord });
                    PosnicPro.commonDate();
                    loader.find(".loadingSpinner:first").remove();
                    // Saved from the Branch edit page: back to the list.
                    if (target) {
                        hasher.setHash('branches');
                        PosnicPro.branches.branchesTable('branches');
                    }
                }
                PosnicPro.alert(response.type, response.message);
            }, function (xhr) {
                loader.find(".loadingSpinner:first").remove();
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
            return false;
        }
    },
    emailPhpStoreSettings: function () {
        if (PosnicPro.validateEmail($('#smtp_php_mail').val())) {
            var loader = $(".loader-view-mail");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            var params = {
                url: 'setting/updatePhpEmailSetting',
                data: JSON.stringify(PosnicPro.getFormData($('#php_setting_add')))
            };
            PosnicPro.put(params, function (response) {
                if (response.type === 'success') {
                    PosnicPro.alert(response.type, response.message);
                    $('#setting_status').val("Yes");
                    loader.find(".loadingSpinner:first").remove();
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
    getDefaultCustomerDetails: function (customer) {
        var params = {
            url: 'setting/getDefaultCustomer',
            data: { data: { customer: customer } }
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                $('#default_customer').append('<option value="' + response.data['customer_id'] + '">' + response.data['customer_name'] + '</option>');
                PosnicPro.local.set('defaultcustomer', JSON.stringify(response.data['customer']));
                $('.default-customer-id').val(response.data['customer_id']);
                $('.default-customer-name').val(response.data['customer_name']);
            } else {
                PosnicPro.alert(response.type, response.message);
            }

        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    getDefaultSupplierDetails: function (supplier) {
        var params = {
            url: 'setting/getDefaultSupplier',
            data: { data: { supplier: supplier } }
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                $('#default_supplier').append('<option value="' + response.data['supplier_id'] + '">' + response.data['supplier_name'] + '</option>');
                PosnicPro.local.set('defaultsupplier', JSON.stringify(response.data['supplier']));
                $('.default-supplier-id').val(response.data['supplier_id']);
                $('.default-supplier-name').val(response.data['supplier_name']);
            } else {
                PosnicPro.alert(response.type, response.message);
            }

        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    /*To display the setting details*/
    /*
     * Module On/Off for another branch (M4): the selector edits any branch
     * of this shop without switching sessions. Remote editing deliberately
     * rides a SEPARATE save path: the full updateCommonSetting collects the
     * whole settings surface plus a dozen session side effects (localStorage,
     * KOT visibility, blob rebuilds), all of which belong to the branch you
     * are logged into, not the one you are editing.
     */
    _featuresDirty: false,
    _moduleToggleIds: [
        'hardware_weight_machine_enable',
        'staff_shifts_enable', 'staff_tips_enable', 'staff_roster_enable',
        'cash_register_enable', 'till_lock_enable',
        'module_recyclebin_enable', 'module_themes_enable',
        'quick_sale_enable',
        'custom_charges_enable',
    ],
    initModulesBranchSelect: function () {
        var $sel = $('#modules_branch_select');
        if (!$sel.length) { return; }
        var sessionBranch = PosnicPro.local.get('branch_id_set');
        var options = $('#branch_name option').filter(function () {
            return $(this).val() && $(this).val() !== 'addbranch';
        });
        if (options.length < 2) { $('#modules_branch_wrap').hide(); return; }
        $sel.empty();
        options.each(function () {
            var v = $(this).val();
            var label = $(this).text();
            var isSession = String(v) === String(sessionBranch);
            $sel.append(new Option(label + (isSession ? ' (this till)' : ''), v, false, isSession));
        });
        $('#modules_branch_wrap').show();
    },
    _modulesRemoteBranch: function () {
        var v = $('#modules_branch_select').val();
        var sessionBranch = PosnicPro.local.get('branch_id_set');
        return v && String(v) !== String(sessionBranch) ? v : null;
    },
    modulesBranchChanged: function () {
        var remote = PosnicPro.settings._modulesRemoteBranch();
        if (!remote) {
            $('#modules_remote_note').hide();
            // Back home: the server is the truth for this till's switches.
            PosnicPro.settings.viewSettings();
            return;
        }
        PosnicPro.get('setting/branchModules?branch_id=' + encodeURIComponent(remote), function (response) {
            var d = response && response.data;
            if (!d || !d.modules) { PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_load_that_branch', 'Could not load that branch')); return; }
            PosnicPro.settings._moduleToggleIds.forEach(function (key) {
                if (d.modules[key] !== undefined) {
                    $('#' + key).prop('checked', d.modules[key] === true);
                }
            });
            PosnicPro.settings.refreshModuleCards();
            $('#modules_remote_note span').text(
                'Editing ' + (d.branch_name || 'another branch') + ' - saving here changes THAT branch only; this till is untouched.'
            );
            $('#modules_remote_note').show();
        }, function () {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_load_that_branch', 'Could not load that branch'));
        });
    },
    saveModulesTab: function () {
        var remote = PosnicPro.settings._modulesRemoteBranch();
        // Features never submits hidden Core Settings fields or receipt data.
        var payload = { modules_only: true };
        if (remote) payload.target_branch_id = remote;
        PosnicPro.settings._moduleToggleIds.forEach(function (key) {
            payload[key] = $('#' + key).is(':checked') ? 'true' : 'false';
        });
        var branchLabel = $('#modules_branch_select option:selected').text();
        PosnicPro.put({
            url: 'setting/updateCommonSettings',
            data: JSON.stringify(payload)
        }, function (response) {
            if (response.type === 'success') {
                PosnicPro.settings._featuresDirty = false;
                if (!remote) {
                    var general = {};
                    try { general = JSON.parse(PosnicPro.local.get('general_settings') || '{}'); } catch (e) { /* empty cache */ }
                    PosnicPro.settings._moduleToggleIds.forEach(function (key) {
                        general[key] = payload[key] === 'true';
                    });
                    general.first_run_done = PosnicPro.features.keepFirstRunFlag();
                    general.first_run_decided = PosnicPro.features.keepFirstRunFlag(null, 'first_run_decided');
                    PosnicPro.local.set('general_settings', JSON.stringify(general));
                    PosnicPro.shiftWidget.applyEnabled();
                    PosnicPro.settings.applyModuleNav();
                    $('.cashRegisterModule').toggle(general.cash_register_enable);
                    if (general.cash_register_enable) PosnicPro.local.set('branch_has_no_registers', '');
                }
                PosnicPro.alert('success', remote ? 'Features saved for ' + branchLabel : 'Feature switches saved');
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function () {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_save_that_branch', 'Could not save that branch'));
        });
    },
    applyReceiptFooter: function (data) {
        if (!data || data.footer_image === undefined) { return; }
        PosnicPro.local.set('footer_image', data.footer_image || '');
        PosnicPro.local.set('footer_image_caption', data.footer_image_caption || '');
        PosnicPro.settings._footerImagePicked = false;
        $('#footer_qr_url').val(data.footer_qr_url || '');
        $('#footer_image_caption').val(data.footer_image_caption || '');
        $('#footer_image_value').val(data.footer_image || '');
        $('#footer_image_thumb').attr('src', data.footer_image || '').toggle(!!data.footer_image);
        $('#footer_image_clear').toggle(!!data.footer_image);
    },
    /*
     * The one Core Settings save. Features have their own partial save
     * (saveModulesTab) so a Core save never carries another tab's switches,
     * and remote branches are never written by this till's session.
     */
    updateCommonSetting: function (successLabel, done) {
        var loader = $(".loader-view-mystore");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        /* The editors are optional; the documents are not. */
        var footerDoc = PosnicPro.settings._editorsReady
            ? $('#footer_print').summernote('code') : PosnicPro.settings._printDocs.footer;
        var headerDoc = PosnicPro.settings._editorsReady
            ? $('#header_print').summernote('code') : PosnicPro.settings._printDocs.header;
        var params = {
            url: 'setting/updateCommonSettings',
            data: JSON.stringify({
                default_customer: $('#customers_default_value').val(),
                default_supplier: $('#suppliers_default_value').val(),
                notification_value: $('#notification_value').val(),
                discount_percentage: $('#discount_percentage').val(),
                discount_amount: $('#discount_amount').val(),
                sales_prefix: $('#sales_prefix').val(),
                sales_exact_numeric_codes: $('#sales_exact_numeric_codes').is(':checked'),
                sales_search_fields: $('#sales_search_custom_fields').is(':checked')
                    ? $('[name="sales_search_fields"]:checked').map(function () { return this.value; }).get() : null,
                sales_search_display_fields: $('#sales_search_custom_display').is(':checked')
                    ? $('[name="sales_search_display_fields"]:checked').map(function () { return this.value; }).get() : null,
                bill_number_reset: $('#bill_number_reset').val() || '',
                bill_number_fy_start_month: $('#bill_number_fy_start_month').val() || '4',
                receiving_prefix: $('#receiving_prefix').val(),
                allow_sale_date_edit: $('#allow_sale_date_edit').is(':checked') ? 'true' : 'false',
                allow_sale_hard_delete: PosnicPro.local.get('usertype') === 'super_admin' ? $('#allow_sale_hard_delete').is(':checked') : undefined,
                print_type: $('#print_type').val(),
                print_size: $('#print_size').val(),
                print_character: $('#print_character').val(),
                header_print: headerDoc,
                footer_print: footerDoc,
                /* The address and the line above it go every time; they are
                   short. An uploaded picture goes ONLY when somebody just
                   picked a file - it is a data URL, and posting a few
                   hundred KB on a form that is saved constantly is waste.
                   The server keeps the stored one when this is absent. */
                footer_qr_url: $('#footer_qr_url').val() || '',
                footer_image_caption: $('#footer_image_caption').val() || '',
                ...(PosnicPro.settings._footerImagePicked
                    ? { footer_image: $('#footer_image_value').val() || '' }
                    : {}),
                stock_log_management: $('#stock_log_management').is(':checked') ? 'true' : 'false',
                stock_management: $('#stock_management').is(':checked') ? 'true' : 'false',
                printall: $('#printall').is(':checked') ? 'true' : 'false',
                roundOff: $('#decimal_Round').is(':checked') ? 'true' : 'false',
                receipt_barcode: $('#receipt_barcode').is(':checked') ? 'true' : 'false',
                sales_mail: $('#sales_mail').is(':checked') ? 'true' : 'false',
                customer_print: $('#customer_print').is(':checked') ? 'true' : 'false',
                print_url: $('#print_url').is(':checked') ? 'true' : 'false',
                print_logoimg: $('#print_logoimg').is(':checked') ? 'true' : 'false',
                print_sale_notes: $('#print_sale_notes').is(':checked') ? 'true' : 'false',
                keyboard_view: $('#keyboard_view').is(':checked') ? 'true' : 'false',
                balance_view: true,
                sale_redirect_seconds: Number($('#sale_redirect_seconds').val()),
                customer_checkbox: $('#default_customer_enable_disable').is(':checked') ? 'true' : 'false',
                supplier_checkbox: $('#default_supplier_enable_disable').is(':checked') ? 'true' : 'false',
                sale_quick_edit_enable: $('#sale_quick_edit').is(':checked') ? 'true' : 'false',
                enable_notification_reminders: $('#enable_notification_reminders').is(':checked') ? 'true' : 'false',
                enable_email_reminders: $('#enable_email_reminders').is(':checked') ? 'true' : 'false',
                /* A module switch, but the model writes it on every common
                   save, so the current value must ride along or a Core save
                   would switch the scale off. */
                hardware_weight_machine_enable: $('#hardware_weight_machine_enable').is(':checked'),
                till_lock_idle_minutes: $('#till_lock_idle_minutes').val() || '0'
            })
        };
        PosnicPro.put(params, function (response) {
            if (response.type === 'success') {
                /*
                 * SAVES PATCH; they do not repaint the world. Each block runs
                 * only when the value it exists FOR actually changed.
                 */
                var data = response.data || {};
                var was = {
                    general: PosnicPro.local.get('general_settings') || '',
                    keyboard: PosnicPro.local.get('keyboard_view') || '',
                    notification: localStorage.getItem('notificationrange') || ''
                };
                PosnicPro.settings.applyReceiptFooter(data);
                let htmlView = $('#footer_print').text();
                $('.footer-content').text(htmlView);
                let htmlHeaderView = $('#header_print').text();
                $('.header-content').text(htmlHeaderView);
                PosnicPro.local.set('allow_sale_hard_delete', $('#allow_sale_hard_delete').is(':checked') ? 'true' : 'false');
                PosnicPro.local.set('allow_sale_date_edit', $('#allow_sale_date_edit').is(':checked') ? 'true' : 'false');
                PosnicPro.roundoff = $('#decimal_Round').is(':checked');
                PosnicPro.local.set('print_type', $('#print_type').val());
                PosnicPro.local.set('printing_size', $('#print_size').val());
                PosnicPro.local.set('printing_max_char', $('#print_character').val());
                PosnicPro.local.set('print_url', data.url);
                PosnicPro.settings.getDefaultCustomerDetails(data.customer);
                PosnicPro.settings.getDefaultSupplierDetails(data.supplier);
                var discount_percentage = $('#discount_percentage').val();
                var discount_amount = $('#discount_amount').val();
                PosnicPro.local.set('setting-discount-amount', discount_amount);
                PosnicPro.local.set('setting-discount-percentage', discount_percentage);
                PosnicPro.local.set('sale_quick_edit', $('#sale_quick_edit').is(':checked') ? 'enable' : 'disable');
                PosnicPro.local.set('balance_view', 'true');
                PosnicPro.local.set('default_customer_enable_disable', $('#default_customer_enable_disable').is(':checked') ? 'true' : 'false');
                PosnicPro.local.set('default_supplier_enable_disable', $('#default_supplier_enable_disable').is(':checked') ? 'true' : 'false');
                /* The low-stock refresh is a network FETCH - the one thing a
                   save must never do for a value that did not move. */
                var notificationNow = String($('#notification_value').val() || '');
                if (notificationNow !== was.notification) {
                    localStorage.setItem('notificationrange', notificationNow);
                    if (PosnicPro.bellFeed) PosnicPro.bellFeed.setLowStock(notificationNow);
                    if (PosnicPro.stocklogs) PosnicPro.stocklogs.viewLowStockDashboard();
                }
                /* Rebuilding the on-screen keyboard is visible work; a save
                   that did not touch the switch does not pay for it. */
                var keyboardNow = $('#keyboard_view').is(':checked') ? 'true' : 'false';
                if (keyboardNow !== was.keyboard) {
                    PosnicPro.local.set('keyboard_view', keyboardNow);
                    if (typeof keyboard_view === 'function') keyboard_view();
                }
                /* Carry the current general cache forward. Feature switches
                   live in their own save path; Core must not re-decide them
                   from a checkbox that may be showing another branch. */
                var general = {};
                try { general = JSON.parse(PosnicPro.local.get('general_settings') || '{}'); } catch (e) { general = {}; }
                general.stock_management = $('#stock_management').is(':checked');
                general.sale_redirect_seconds = Number($('#sale_redirect_seconds').val());
                general.first_run_done = PosnicPro.features.keepFirstRunFlag();
                general.first_run_decided = PosnicPro.features.keepFirstRunFlag(null, 'first_run_decided');
                var generalNow = JSON.stringify(general);
                PosnicPro.local.set('general_settings', generalNow);
                if (generalNow !== was.general && PosnicPro.settings.applyModuleNav) {
                    PosnicPro.settings.applyModuleNav();
                }
            }
            if (response.type !== 'success' || !done) PosnicPro.alert(response.type,
                (response.type === 'success' && successLabel) ? successLabel : response.message);
            loader.find(".loadingSpinner:first").remove();
            if (response.type === 'success' && done) done();
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    viewSettings: function (id) {
        var params = {
            url: 'branches/getOneStore',
            data: 'id=' + id
        };
        $('#footer_print,#header_print').html('').text('');
        PosnicPro.settings._printDocs = { header: '', footer: '' };
        if (PosnicPro.settings._editorsReady) { $('#footer_print,#header_print').summernote('code', ''); }
        let loader = $(".loader-table-setting");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                loader.find(".loadingSpinner:first").remove();
                var data = response.data;
                let country_id = data.country_id;
                PosnicPro.local.set('countryid', country_id);
                PosnicPro.settings.loadSelectSettingState(country_id);
                PosnicPro.record_id = id;
                PosnicPro.roundoff = data.roundOff;
                // Hidden when the module is off OR nothing is configured.
                (data.cash_register_enable === false || data.register.length === 0)
                    ? $('.cashRegisterModule').css('display', 'none')
                    : $('.cashRegisterModule').css('display', 'block');
                $('#id').val(PosnicPro.record_id);
                $('#razor_key').text(data.razorKey);
                $('#razor_url').text(data.razorUrl);
                PosnicPro.settings.applyCountryFields(data.country, '#settings');
                $('#store_name').val(data.branch_name);
                $('#store_address').val(data.store_address);
                $('#address').val(data.address);
                $('#store_email').val(data.store_email);
                PosnicPro.settings.store_telephone.setNumber(data.store_telephone || '');
                $('#store_alternativephone').val(data.store_alternativephone);
                $('#place').val(data.place);
                $('#city').val(data.city);
                $('#pincode').val(data.pincode);
                $('#website').val(data.website);
                $('#languge').val(data.languge);
                $('#printing_address').val(data.printing_address);
                $('#notification_value').val(data.notification_range);
                localStorage.setItem("notificationrange", data.notification_range);
                $('#serverdate').val(data.server_dateformat);
                $('#dateText').val(data.dateformat_text);
                $('#sales_prefix').val(data.sales_prefix || 'S');
                $('#sale_redirect_seconds').val(PosnicPro.saleRedirectSeconds(data));
                $('#sales_search_custom_fields').prop('checked', Array.isArray(data.sales_search_fields))
                    .off('change.salesSearch').on('change.salesSearch', function () {
                        $('[name="sales_search_fields"]').prop('disabled', !this.checked);
                    }).triggerHandler('change.salesSearch');
                $('#sales_exact_numeric_codes').prop('checked', data.sales_exact_numeric_codes === true);
                var searchFields = data.sales_search_fields || ['name', 'sku', 'barcode', 'plu'];
                var displayFields = data.sales_search_display_fields || ['sku', 'category', 'price', 'stock', 'image'];
                $('[name="sales_search_fields"]').each(function () { this.checked = searchFields.indexOf(this.value) >= 0; });
                $('[name="sales_search_display_fields"]').each(function () { this.checked = displayFields.indexOf(this.value) >= 0; });
                $('#sales_search_custom_display').prop('checked', Array.isArray(data.sales_search_display_fields))
                    .off('change.salesSearch').on('change.salesSearch', function () {
                        $('[name="sales_search_display_fields"]').prop('disabled', !this.checked);
                    }).triggerHandler('change.salesSearch');
                /* WHEN THE BILL NUMBER STARTS AGAIN. Empty is off, which is
                   what a branch that has never been asked reads as, and what
                   every shop did before this existed. The month only means
                   anything for a financial year, so it is hidden otherwise. */
                $('#bill_number_reset').val(
                    ['financial', 'calendar'].indexOf(String(data.bill_number_reset || '')) > -1
                        ? String(data.bill_number_reset)
                        : ''
                );
                PosnicPro.settings.fillFinancialYearMonths();
                $('#bill_number_fy_start_month').val(String(Number(data.bill_number_fy_start_month) || 4));
                PosnicPro.settings.showFinancialYearMonth();
                $('#receiving_prefix').val(data.receiving_prefix || 'P');
                $('#allow_sale_date_edit').prop('checked', data.allow_sale_date_edit !== 'false' && data.allow_sale_date_edit !== false);

                var saleHardDelete = data.allow_sale_hard_delete === true || data.allow_sale_hard_delete === 'true';
                $('#allow_sale_hard_delete').prop('checked', saleHardDelete);
                $('#sale_hard_delete_setting').toggle(PosnicPro.local.get('usertype') === 'super_admin');
                PosnicPro.local.set('allow_sale_hard_delete', saleHardDelete ? 'true' : 'false');
                PosnicPro.local.set('allow_sale_date_edit', (data.allow_sale_date_edit === 'false' || data.allow_sale_date_edit === false) ? 'false' : 'true');
                $("#print_type option[value='" + data.print_type + "']").prop("selected", true);
                let print_size = (typeof (data.print_size) !== "undefined" && data.print_size !== null) ? data.print_size : 'receipt_medium';
                $("#print_size option[value='" + print_size + "']").prop("selected", true);
                PosnicPro.local.set('printing_size', print_size);
                let print_character = (typeof (data.print_character) !== "undefined" && data.print_character !== null) ? data.print_character : 'default';
                $("#print_character option[value='" + print_character + "']").prop("selected", true);
                PosnicPro.local.set('printing_max_char', print_character);

                // Module On/Off switches (checkboxes since the toggles-only
                // rebuild). ON unless explicitly false, except tips (opt-in)
                // and the hardware/PIN switches which shipped off.
                $('#hardware_weight_machine_enable').prop('checked', data.hardware_weight_machine_enable === true);
                $('#till_lock_enable').prop('checked', data.till_lock_enable === true);
                $('#till_lock_idle_minutes').val(String(data.till_lock_idle_minutes || 0));
                $('#staff_shifts_enable').prop('checked', data.staff_shifts_enable !== false);
                $('#staff_tips_enable').prop('checked', data.staff_tips_enable === true);
                $('#staff_roster_enable').prop('checked', data.staff_roster_enable !== false);
                $('#cash_register_enable').prop('checked', data.cash_register_enable !== false);
                $('#module_recyclebin_enable').prop('checked', data.module_recyclebin_enable !== false);
                /* What it was BEFORE anybody touched it. Turning demo data
                   back on is the only case that needs the server, and off->on
                   cannot be told from on->on without this. */
                $('#module_themes_enable').prop('checked', data.module_themes_enable !== false);
                $('#quick_sale_enable').prop('checked', data.quick_sale_enable === true);
                $('#custom_charges_enable').prop('checked', data.custom_charges_enable === true);

                // Store general settings including hardware_weight_machine_enable
                var generalSettings = {
                    sale_redirect_seconds: data.sale_redirect_seconds,
                    stock_management: data.stock_management !== false,
                    hardware_weight_machine_enable: data.hardware_weight_machine_enable || false,
                    till_lock_enable: data.till_lock_enable || false,
                    till_lock_idle_minutes: data.till_lock_idle_minutes || 0,
                    staff_shifts_enable: data.staff_shifts_enable !== false,
                    staff_tips_enable: data.staff_tips_enable === true,
                    staff_roster_enable: data.staff_roster_enable !== false,
                    cash_register_enable: data.cash_register_enable !== false,
                    module_recyclebin_enable: data.module_recyclebin_enable !== false,
                    module_themes_enable: data.module_themes_enable !== false,
                    quick_sale_enable: data.quick_sale_enable === true,
                    custom_charges_enable: data.custom_charges_enable === true,
                    first_run_done: PosnicPro.features.keepFirstRunFlag(data),
                    first_run_decided: PosnicPro.features.keepFirstRunFlag(data, 'first_run_decided')
                };
                PosnicPro.local.set('general_settings', JSON.stringify(generalSettings));
                PosnicPro.shiftWidget.applyEnabled();
                PosnicPro.settings.applyModuleNav();

                $('.display-branch-name').html(data.branch_name);
                $('.display-discount-amount-text').html(data.discount_amount);
                $('.display-discount-amount-value').val(data.discount_amount);
                $('.display-discount-percentage-text').html(data.discount_percentage);
                $('.display-discount-percentage-value').val(data.discount_percentage);
                PosnicPro.local.set('setting-discount-amount', data.discount_amount);
                PosnicPro.local.set('currencySign', data.currency_type);
                PosnicPro.local.set('setting-discount-percentage', data.discount_percentage);
                (data.discount_amount === '0') ? data.discount_percentage : data.discount_amount;
                var image_path = (data.logo !== "store.png") ? data.logo : 'static/images/default/' + data.logo;
                $('#previewing,#store_image').attr('src', image_path);
                $('#setting_logo_value').val(data.logo);

                (data.roundOff === true) ? $('#decimal_Round').prop("checked", true).attr('checked', 'checked') : $('#decimal_Round').prop("checked", false).attr('unchecked', 'unchecked');
                (data.printall === true) ? $('#printall').prop("checked", true).attr('checked', 'checked') : $('#printall').prop("checked", false).attr('unchecked', 'unchecked');
                //                (data.print_logo === true) ? $('#printall').attr('checked', 'checked') : $('#printall').attr('unchecked', 'unchecked');

                if (data.keyboard_view === true) {
                    $('#keyboard_view').prop("checked", true).attr('checked', 'checked');
                    PosnicPro.local.set('keyboard_view', 'true');
                    keyboard_view();
                } else {
                    $('#keyboard_view').prop("checked", false).attr('unchecked', 'unchecked');
                    PosnicPro.local.set('keyboard_view', 'false');
                    keyboard_view();
                }
                PosnicPro.local.set('balance_view', 'true');
                if (data.customer_checkbox === true) {
                    $("#default_customer_enable_disable").prop("checked", true);
                    PosnicPro.local.set('default_customer_enable_disable', "true");
                    $('#default_customer').removeAttr('disabled');
                    $(".customer-text-disable").css("color", '#20a83b');
                    $(".customer-text-enable").css("color", '#141d46');
                } else {
                    $("#default_customer_enable_disable").prop("checked", false);
                    PosnicPro.local.set('default_customer_enable_disable', "false");
                    $('#default_customer').attr('disabled', 'disabled');
                    $(".customer-text-disable").css("color", '#141d46');
                    $(".customer-text-enable").css("color", '#20a83b');
                }

                if (data.supplier_checkbox === true) {
                    $("#default_supplier_enable_disable").prop("checked", true);
                    PosnicPro.local.set('default_supplier_enable_disable', "true");
                    $('#default_supplier').removeAttr('disabled');
                    $(".supplier-text-disable").css("color", '#20a83b');
                    $(".supplier-text-enable").css("color", '#141d46');
                } else {
                    $("#default_supplier_enable_disable").prop("checked", false);
                    PosnicPro.local.set('default_supplier_enable_disable', "false");
                    $('#default_supplier').attr('disabled', 'disabled');
                    $(".supplier-text-disable").css("color", '#141d46');
                    $(".supplier-text-enable").css("color", '#20a83b');
                }

                let print_url = (typeof (data.print_url) !== "undefined" && data.print_url !== null) ? data.print_url : false;
                (print_url === true) ? $('#print_url').prop("checked", true).attr('checked', 'checked') : $('#print_url').prop("checked", false).attr('unchecked', 'unchecked');
                PosnicPro.local.set('print_url', print_url);
                // the old pencil editor is gone; its stale local key with it
                PosnicPro.local.set('inline_sale', 'disable');
                if (data.sale_quick_edit_enable !== false) {
                    $('#sale_quick_edit').prop("checked", true).attr('checked', 'checked');
                    PosnicPro.local.set('sale_quick_edit', 'enable');
                } else {
                    $('#sale_quick_edit').prop("checked", false).attr('unchecked', 'unchecked');
                    PosnicPro.local.set('sale_quick_edit', 'disable');
                }
                (data.stock_management === true) ? $('#stock_management').prop("checked", true).attr('checked', 'checked') : $('#stock_management').removeAttr('checked');
                (data.stock_management_log === true) ? $('#stock_log_management').prop("checked", true).attr('checked', 'checked') : $('#stock_log_management').removeAttr('checked');
                (data.sales_mail === true) ? $('#sales_mail').prop("checked", true).attr('checked', 'checked') : $('#sales_mail').prop("checked", false).attr('unchecked', 'unchecked');
                (data.customer_print === true) ? $('#customer_print').prop("checked", true).attr('checked', 'checked') : $('#customer_print').prop("checked", false).attr('unchecked', 'unchecked');
                (data.print_logoimg === true) ? $('#print_logoimg').prop("checked", true).attr('checked', 'checked') : $('#print_logoimg').prop("checked", false).attr('unchecked', 'unchecked');
                (data.print_sale_notes === true) ? $('#print_sale_notes').prop("checked", true).attr('checked', 'checked') : $('#print_sale_notes').prop("checked", false).attr('unchecked', 'unchecked');

                $('#setting_country,#customer_country,#supplier_country,#branch_country').val(data.country);
                $('#client_dateformat').val(data.client_dateformat);
                $('#dateformat_text').val(data.dateformat_text);
                $('#server_dateformat').val(data.server_dateformat);
                PosnicPro.local.set("dateformatset", data.client_dateformat);
                var settingStateOPtion = '<option id="' + data.state + '" value="' + data.state + '" selected>' + data.state + '</option>';
                $('#setting_state,#customer_state,#supplier_state,#branch_state').html(settingStateOPtion);
                $('#storedate').val(data.client_dateformat).trigger('change.select2');
                $('#storetime').val(data.time_format).trigger('change.select2');
                PosnicPro.local.set('timeformat', data.time_format);
                $('#currency').val(data.currency_text);
                PosnicPro.local.set('timezone', data.time_zone);
                $("#time_zone").val(data.time_zone).trigger("change");
                var viewcurrencyOPtion = "";
                $.each(data.currency_value, function (key, value) {
                    $('#currencyText').val(value.currency_sign);
                    $('#currencyTextname').val(value.currency_text);
                    $("#currency_type option:selected").remove();
                    $('#currency_type').find('option').remove();
                    if (data.currency_type === value.currency_text) {
                        viewcurrencyOPtion += "<option id=" + data.currency_type + '" value="' + data.currency_type + '">Text( ' + data.currency_type + ' )</option>' +
                            " <option id=" + value.currency_sign + '" value="' + value.currency_sign + '">Symbol( ' + value.currency_sign + ' )</option>';
                    } else {
                        viewcurrencyOPtion += "<option id=" + value.currency_text + '" value="' + value.currency_text + '">Text( ' + value.currency_text + ' )</option>' +
                            " <option id=" + data.currency_type + '" value="' + data.currency_type + '">Symbol( ' + data.currency_type + ' )</option>';
                    }

                });
                $('#currency_type').append(viewcurrencyOPtion);
                $('#currency_type').val(data.currency_type).trigger('change.select2');
                $('.display-currency').html(data.currency_type);
                $('#setting_status').val("Yes");
                var discountamountradionbutton = $('#discount_amount').val();
                if (discountamountradionbutton > 0) {
                    $("#radio_discount_amount").prop('checked', 'checked');
                    $('#discount_percentage').attr('disabled', 'disabled').addClass('bg-white').hide();
                    $('#discount_amount').removeAttr('disabled', 'disabled').show();
                } else {
                    $("#radio_discount_percentage").prop('checked', 'checked');
                    $('#discount_amount').attr('disabled', 'disabled').addClass('bg-white').hide();
                    $('#discount_percentage').removeAttr('disabled', 'disabled').show();
                }
                /*Call For get Default Customer SupplierDtails*/
                PosnicPro.settings.getDefaultCustomerDetails(data.default_customer);
                PosnicPro.settings.getDefaultSupplierDetails(data.default_supplier);
                $('#setting_image_value').val('');

                $('.import-print').html('');
                if (data.regular_body_print != null) {
                    $('.import-print').html(data.regular_body_print);
                } else {
                    $('.import-print').append(data.print_a4html);
                }

                if (data.thermal_body_print != null) {
                    $('.import-standard-print').html(data.thermal_body_print);
                } else {
                    $('.import-standard-print').append(data.print_standard_html);
                }

                var controls = [
                    'lineitem_price',
                    'lineitem_qty',
                    'lineitem_total',
                    'print_qty',
                    'print_roundoff'
                ];
                var defaultControlValue = 'on';
                if (data.print_controls != null) {
                    $(controls).each(function (key, controlKey) {
                        PosnicPro.local.set(controlKey, data.print_controls.a4[controlKey]);
                    });
                    PosnicPro.local.set('receiving_title', data.print_controls['receiving_title']);
                    PosnicPro.local.set('receiving_return_title', data.print_controls['receiving_return_title']);
                    PosnicPro.local.set('sale_title', data.print_controls['sale_title']);
                    PosnicPro.local.set('sale_return_title', data.print_controls['sale_return_title']);
                } else {
                    $(controls).each(function (key, controlKey) {
                        PosnicPro.local.set(controlKey, defaultControlValue);
                    });
                    PosnicPro.local.set('receiving_title', "<span style=\"font-size: 14px !important; font-weight: 900;\"><lang class='lang_purchase_invoice'>Purchase Invoice</lang></span>");
                    PosnicPro.local.set('receiving_return_title', "<span style=\"font-size: 14px !important; font-weight: 900;\"><lang class='lang_purchase_return_invoice'>Purchase Return Invoice</lang></span>");
                    PosnicPro.local.set('sale_title', "<span style=\"font-size: 14px !important; font-weight: 900;\"><lang class='lang_sales_receipt_2'>Sales Receipt</lang></span>");
                    PosnicPro.local.set('sale_return_title', "<span style=\"font-size: 14px !important; font-weight: 900;\"><lang class='lang_sales_return_receipt'>Sales Return Receipt</lang></span>");
                }

                // SET, never append: the old append-at-response after a
                // clear-at-request duplicated the content once per
                // overlapping load - eight Config opens read
                // "Thank you for shopping...!" eight times over.
                let headerContent = (data.header_print !== '') ? data.header_print : '';
                $('#header_print').html('').append(headerContent);
                var htmlHeaderView = $('#header_print').text();
                PosnicPro.settings._printDocs.header = htmlHeaderView;
                if (PosnicPro.settings._editorsReady) { $('#header_print').summernote('code', htmlHeaderView); }
                $('.header-content').text(htmlHeaderView);

                let footerContent = (data.footer_print !== '') ? data.footer_print : 'Thank you for shopping...!';
                $('#footer_print').html('').append(footerContent);
                var htmlView = $('#footer_print').text();
                PosnicPro.settings._printDocs.footer = htmlView;
                if (PosnicPro.settings._editorsReady) { $('#footer_print').summernote('code', htmlView); }
                $('.footer-content').text(htmlView);

                /* Kept locally because the print path reads them at print
                   time, on a page that may never have opened Settings. */
                PosnicPro.settings.applyReceiptFooter({
                    footer_image: data.footer_image || '',
                    footer_qr_url: data.footer_qr_url,
                    footer_image_caption: data.footer_image_caption
                });
                if (PosnicPro.receiptDesignerEditor) PosnicPro.receiptDesignerEditor.load(data);
                if (PosnicPro.printSettings) PosnicPro.printSettings.mount(data);

                $('.print_store_name').text(data.branch_name);
                $('.print_store_address').text(data.printing_address);
                $('.print_store_city').text(data.city);
                $('.print_store_email').text(data.store_email);
                $('.print_store_telephone').text(data.store_telephone);
                $('.print_store_alternativephone').text('');
                if (data.store_alternativephone !== null && data.store_alternativephone !== undefined && data.store_alternativephone.trim() !== "") {
                    $('.print_store_alternativephone').text(data.store_alternativephone);
                }
                $('.print_store_country').text(data.country);
                $('.print_store_state').text(data.state);
                $('.print_store_pincode').text(data.pincode);
                PosnicPro.local.set("country_value", data.country);
                PosnicPro.local.set("country_setting", data.country);
                $(document).trigger('posnic:country-changed');
                PosnicPro.local.set("state_setting", data.state);
                PosnicPro.local.set("city_setting", data.city || "");
                $('#setting_country').val(data.country).trigger('change.select2');
                let stateId = $("#setting_country option[value='" + data.country + "']").data("setting-id");
                PosnicPro.local.set("currency_setting", data.currency);
                $('#currency_setting').val(data.currency_text).trigger('change.select2');
                PosnicPro.stocklogs.viewLowStockDashboard();
                PosnicPro.getBranchDropdownOption();
                PosnicPro.denom.denomTable();

                //var countryDetail = $('#setting_country').select2("data");
                //PosnicPro.settings.loadSelectSettingState(countryDetail[0].element.attributes['data-setting-id'].value);
            } else {
                $('#setting_status').val("No");
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    resetEditButton: function (id) {
        var target = $('#edit_branch_target').val();
        if (target) { PosnicPro.branches.loadFullEdit(target); return; }
        var branch_id = PosnicPro.local.get('branch_id_set');
        PosnicPro.settings.viewSettings(branch_id);
    },
    loadSelectSettingState: function (id, selectedState) {
        var request = (this.stateRequest || 0) + 1; this.stateRequest = request;
        if (selectedState === undefined) selectedState = $('#setting_country').val() === PosnicPro.local.get('country_setting') ? PosnicPro.local.get('state_setting') : '';
        var stateSelect = $('#setting_state');
        // Display the saved state immediately, even while the country list is loading.
        stateSelect.empty().append(new Option('', ''));
        if (selectedState) stateSelect.append(new Option(selectedState, selectedState));
        stateSelect.val(selectedState || '').trigger('change.select2');
        var initialState = stateSelect.val();
        var params = {
            url: 'setting/getJSONState',
            data: { id: id }
        };
        PosnicPro.get(params, function (response) {
            if (PosnicPro.settings.stateRequest !== request) return;
            if (stateSelect.val() !== initialState) selectedState = stateSelect.val();
            stateSelect.empty().append(new Option('', ''));
            (response.data.stateJsonArray || []).forEach(function (state) { stateSelect.append(new Option(state, state)); });
            var match = Array.from(stateSelect[0].options).find(function (option) { return option.value.trim().toLowerCase() === String(selectedState || '').trim().toLowerCase(); });
            if (!match && selectedState) stateSelect.append(new Option(selectedState, selectedState));
            stateSelect.val(match ? match.value : (selectedState || '')).trigger('change.select2');
            (PosnicPro.settings.store_telephone || { setCountry: function () {} }).setCountry(response.data['countrySortName']);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
        /*
     * Reference data loads ONCE. Countries, currencies and timezones do not
     * change during a session, yet these ran on every navigation - refetching
     * and rebuilding ~1,100 <option> nodes for forms the user may never open,
     * and overlapping calls appended duplicates that never went away
     * (measured: +400 timezone, +246 country x4 selects, +193 currency
     * options across four navigation cycles). Pass true to force a reload.
     */
loadSelectSettingCurrency: function (force) {
        if (!force && PosnicPro.settings._refLoaded.currency) { return PosnicPro.settings._refPending.currency.promise(); }
        PosnicPro.settings._refLoaded.currency = true;
        var ready = $.Deferred();
        PosnicPro.settings._refPending.currency = ready;
        var currencySelect = $('#currency_setting');
        var params = {
            url: 'setting/getJSONCurrency'
        };
        PosnicPro.get(params, function (response) {
            currencySelect.empty();
            suggestions: $.map(response.data['currency'], function (dataItem) {
                var option;
                option += '<option value="' + dataItem.value + '" data-currency-id="' + dataItem.id + '" data-currency-text="' + dataItem.text + '" data-currency-symbol="' + dataItem.symbol + '">' + dataItem.value + ' </option>';
                currencySelect.append(option).trigger('change');
            });
            currencySelect.val(PosnicPro.local.get("currency_setting")).trigger('change.select2');
            currencySelect.off('select2:select.settingCurrency').on('select2:select.settingCurrency', function (e) {
                let data = e.params.data;
                $('#currencyText').val(data.element.attributes['data-currency-symbol'].value);
                $('#currencyTextname').val(data.element.attributes['data-currency-text'].value);
                var currencyDataOPtion = "";
                $('#currency_type').empty();
                currencyDataOPtion += "<option id=" + data.element.attributes['data-currency-text'].value + '" value="' + data.element.attributes['data-currency-text'].value + '" selected>Text( ' + data.element.attributes['data-currency-text'].value + ' )</option>' +
                    " <option id=" + data.element.attributes['data-currency-symbol'].value + '" value="' + data.element.attributes['data-currency-symbol'].value + '">Symbol( ' + data.element.attributes['data-currency-symbol'].value + ' )</option>';
                $('#currency_type').append(currencyDataOPtion);
            });
            ready.resolve();
        }, function (xhr) {
            PosnicPro.settings._refLoaded.currency = false;
            ready.reject();
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
        return ready.promise();
    },
    /*
     * Reference data loads ONCE. Countries, currencies and timezones do not
     * change during a session, yet these ran on every navigation - refetching
     * and rebuilding ~1,100 <option> nodes for forms the user may never open,
     * and overlapping calls appended duplicates that never went away
     * (measured: +400 timezone, +246 country x4 selects, +193 currency
     * options across four navigation cycles). Pass true to force a reload.
     */
    timeZone: function (force) {
        if (!force && PosnicPro.settings._refLoaded.timezone) { return PosnicPro.settings._refPending.timezone.promise(); }
        PosnicPro.settings._refLoaded.timezone = true;
        var ready = $.Deferred();
        PosnicPro.settings._refPending.timezone = ready;
        var timezoneSelect = $('#time_zone');
        var params = {
            url: 'setting/getJSONTimeZone'
        };
        PosnicPro.get(params, function (response) {
            timezoneSelect.empty();
            suggestions: $.map(response.data, function (dataItem) {
                var options;
                options += '<option value="' + dataItem.text + '" data-timezone-name="' + dataItem.text + '">' + dataItem.value + ' </option>';
                timezoneSelect.append(options).trigger('change');
            });
            let timezone = PosnicPro.timeZone();
            timezoneSelect.val(timezone).trigger('change.select2');
            ready.resolve();
        }, function (xhr) {
            PosnicPro.settings._refLoaded.timezone = false;
            ready.reject();
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
        return ready.promise();
    },
    triggerModules: function () {
        PosnicPro.showAddModal('denomcash');
        $('#denom_id').val('');
            $('#denom-heading').text(PosnicPro.i18n.t('lang_new_title', 'Add'));
            $('#denom_text_change').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
        var loader = $(".loader-settings-sidebar");
        loader.find(".loadingSpinner:first").remove();
        $('#denom_reset').show();
        $('.denom_edit_reset').hide();
    },
    triggerEdit: function (id) {
        var module = $('#setting_denom_edit_' + id);
        PosnicPro.showAddModal('denomcash');
        $('#denom_id').val(id);
        $('#denom_value').val(module.data('denomvalue'));
        $('#denom-heading').text(PosnicPro.i18n.t('lang_action_edit', 'Edit'));
            $('#denom_text_change').text(PosnicPro.i18n.t('lang_updatebtn_title', 'Update'));
        $('#denom_reset').hide();
        $('.denom_edit_reset').show();
        $('.denom_edit_reset').attr("id", id);
        $('.mobile_tooltip').tooltip('hide');
    },
    triggerDelete: function (id) {
        PosnicPro.denom.deleteDenomField(id);
    },
    denomTable: function () {
        var loader = $(".loader-settings-table");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        PosnicPro.HideSideBarModal();
        var table = $('#view_denom');
        var params = {
            url: 'setting/getDenomAll'
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {
                table.children('tbody').text('');
                var data = response.data;
                let currency = PosnicPro.local.get('currencySign');
                // Reset cached sale denomination list before repopulating
                if (PosnicPro.sales) {
                    PosnicPro.sales.SaleDenomination = [];
                }
                for (var i = 0; i < data.length; i++) {
                    let row = data[i];
                    let edit = '<a href="#/settings/denom/' + row.denom_id + '/edit" id="setting_denom_edit_' + row.denom_id + '" data-toggle="tooltip" title="Edit Denom" data-t-title="lang_edit_denom" class="btn btn-primary-rgba mobile_tooltip mb-1 mr-1" data-module = "branch" data-access = "write" data-denomvalue="' + row.denom_value + '" ><i class="feather icon-edit"></i></a>';
                    let deleted = '<a href="#/settings/denom/' + row.denom_id + '/delete" id="setting_denom_delete_' + row.denom_id + '" data-toggle="tooltip" title="Delete Denom" data-t-title="lang_delete_denom" class="btn btn-danger-rgba mobile_tooltip mb-1 mr-1" data-module = "branch" data-access = "delete" data-denomvalue="' + row.denom_value + '" ><i class="feather icon-trash"></i></a>';
                    let trow = '<tr> <td scope="row" width="10%">' + (i + 1) + '</td><td width="10%" class="text-right">' + currency + '&nbsp;<span class="number">' + row.denom_value + '</span></td><td width="40%" class="text-center">' + edit + ' ' + deleted + '</td> </tr>';
                    $('#view_denom').children('tbody').append(trow);
                    PosnicPro.sales.SaleDenomination[i] = {
                        id: row.denom_id,
                        amount: row.denom_value
                    };

                }
                $('span.number').number(true, 2);
                loader.find(".loadingSpinner:first").remove();
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    addDenomField: function () {
        if ($('#denom_value').val() !== '') {
            var loader = $(".loader-settings-sidebar");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            var params = {
                url: 'setting/addDenomData',
                data: JSON.stringify(PosnicPro.getFormData($('#denom_add_form')))
            };
            PosnicPro.post(params, function (response) {
                if (response.type === 'success') {
                    PosnicPro.denom.denomClearForm();
                    PosnicPro.denom.denomTable();
                    hasher.setHash('settings');
                    loader.find(".loadingSpinner:first").remove();
                }
                PosnicPro.alert(response.type, response.message);
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
        }
    },
    editDenomField: function () {
        var loader = $(".loader-settings-sidebar");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        var params = {
            url: 'setting/editDenomForm',
            data: JSON.stringify(PosnicPro.getFormData($('#denom_add_form')))
        };
        PosnicPro.put(params, function (response) {
            if (response.type === 'success') {
                PosnicPro.denom.denomTable();
                $(".infobar-settings-sidebar-overlay").css({ "background": "transparent", "position": "initial" });
                hasher.setHash('settings');
            }
            loader.find(".loadingSpinner:first").remove();
            PosnicPro.alert(response.type, response.message);
            $('.mobile_tooltip').tooltip('hide');
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    deleteDenomField: function (id) {
        if (PosnicPro.deleteConfirmation) {
            PosnicPro.callbackRegistry = {};
            PosnicPro.delete('setting/deleteDenom?id=' + id, function (response) {
                if (response.type === 'success') {
                    PosnicPro.deleteConfirmation = false;
                    $("#denom_add_form").trigger("reset");
                    PosnicPro.denom.denomTable();
                    $(".infobar-settings-sidebar-overlay").css({ "background": "transparent", "position": "initial" });
                    hasher.setHash('settings');
                }
                PosnicPro.alert(response.type, response.message);
            });
        } else {
            PosnicPro.callbackRegistry = {
                name: 'deleteDenomField',
                arguments: id
            };
            $('#delete_denom_modal').modal('show');
        }
        $('.mobile_tooltip').tooltip('hide');
    },
    deleteDenomConfirmed: function () {
        $('#delete_denom_modal').modal('hide');
        PosnicPro.deleteConfirmation = true;
        window['PosnicPro']['denom']['' + PosnicPro.callbackRegistry.name](PosnicPro.callbackRegistry.arguments);
    },
    denomClearForm: function () {
        $("#denom_add_form").trigger("reset");
    },
    resetEditButton: function (id) {
        PosnicPro.denom.triggerEdit(id);
    },
    applyCountryFields: function (country, scope) {
        var india = ['india', 'in', 'ind'].includes(String(country || '').trim().toLowerCase());
        $(scope).find('.india-only').prop('hidden', !india).toggle(india);
    },
    loadSelectSettingCountry: function (force) {
        /* Flag FIRST and unconditionally: two navigations racing inside the
           in-flight window both used to fetch and append, forever. */
        if (!force && PosnicPro.settings._refLoaded.country) { return PosnicPro.settings._refPending.country.promise(); }
        PosnicPro.settings._refLoaded.country = true;
        var ready = $.Deferred();
        PosnicPro.settings._refPending.country = ready;
        var countrySelect = $('.setCountry');
        var params = {
            url: 'setting/getJSONCountry',
            data: { name: 'countries' }
        };
        PosnicPro.get(params, function (response) {
            countrySelect.empty();
            $.map(response.data['countries'], function (dataItem) {
                var option = '<option value="' + dataItem.value + '" data-setting-id="' + dataItem.id + '">' + dataItem.value + ' </option>';
                countrySelect.append(option).select2();
            });
            countrySelect.val(PosnicPro.local.get('country_setting')).trigger('change.select2');
            ready.resolve();
        }, function (xhr) {
            PosnicPro.settings._refLoaded.country = false;
            ready.reject();
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
        return ready.promise();
    },
    changeBranch: function (branch_no) {
        if (branch_no === 'addbranch') {
            var branch_id_set = PosnicPro.local.get('branch_id_set');
            $("#branch_name option[value='" + branch_id_set + "']").prop('selected', 'selected');
            hasher.setHash('branches/new/addbranch');
            return;
        }
        var params = {
            url: 'users/changeBranch',
            data: JSON.stringify({ branch_no: branch_no })
        };
        PosnicPro.post(params, function (response) {
            if (response.type === 'success') {
                $("#branch_name option[value='" + branch_no + "']").prop('selected', 'selected');
                PosnicPro.local.set('branch_id_set', branch_no);
                $(document).trigger('posnic:branch-changed');
                if (PosnicPro.sales && PosnicPro.sales.itemCache) {
                    PosnicPro.sales.itemCache.clear();
                }
                PosnicPro.settings.viewSettings(branch_no);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    /*
     * The full branch switch, kept for the flows that finish outside Config
     * (register close, branch save). Everything that no longer exists is
     * guarded or gone; the session, the cached documents and the display
     * still move together.
     */
    listBranchName: function (id) {
        var params = {
            url: 'users/changeBranch',
            data: JSON.stringify({ branch_no: id })
        };
        PosnicPro.post(params, function (response) {
            if (response.type === 'success') {
                $('#v-pills-dashboard-tab,#v-pills-sales-tab,#v-pills-inventory-tab,#v-pills-purchase-tab,#v-pills-customer-tab,#v-pills-report-tab,#v-pills-manage-tab,#v-pills-branch-tab').removeClass('active');
                PosnicPro.local.set('branch_id_set', id);
                PosnicPro.getBranchDropdownOption();
                $(document).trigger('posnic:branch-changed');
                if (PosnicPro.sales && PosnicPro.sales.itemCache) {
                    PosnicPro.sales.itemCache.clear();
                }
                var data = response.data || {};
                $('.display-current-branch').select2('val', [[id]]);
                PosnicPro.local.set('branchname', data.branch_name);
                PosnicPro.local.set('branchemail', data.branch_email);
                PosnicPro.local.setVolatile('branchphone', data.branch_phone);
                PosnicPro.local.set('branchaddress', data.branch_address);
                PosnicPro.local.set('branchimage', data.branch_logo);
                db.customerDisplay.put({ id: '2', 'clear': 'no', 'get': 'no', branch: [{ name: data.branch_name, phone: data.branch_phone, email: data.branch_email, address: data.branch_address, image: data.branch_logo }] });
                db.currentbranch.put({ id: '1', branch_id: id, branch_name: data.branch_name, user_id: PosnicPro.local.get('userid') });
                PosnicPro.settings.viewSettings(id);
                if (PosnicPro.items) PosnicPro.items.itemClearForm();
                if (PosnicPro.categories) PosnicPro.categories.categoryClearForm();
                if (PosnicPro.variants) PosnicPro.variants.variantClearForm();
                if (PosnicPro.suppliers) PosnicPro.suppliers.supplierClearForm();
                if (PosnicPro.customers) PosnicPro.customers.customerClearForm();
                if (PosnicPro.users) PosnicPro.users.userClearForm();
                if (PosnicPro.branches) PosnicPro.branches.branchClearform();
                if (PosnicPro.sales && PosnicPro.sales.clear) PosnicPro.sales.clear.cartItems();
                if (PosnicPro.receivings) PosnicPro.receivings.clearReceivingForm();
                setLocalValue();
                var registerParams = { url: 'branches/userRegisterBranchSelect', data: { id: id } };
                PosnicPro.get(registerParams, function (registerResponse) {
                    if (registerResponse.type === 'success' && registerResponse.data.open_register && registerResponse.data.open_register.register_status === 'Opened') {
                        PosnicPro.local.set('cash_register_id', registerResponse.data.open_register.cash_register_id);
                        PosnicPro.local.set('register_id', registerResponse.data.open_register.register_id);
                        PosnicPro.local.set('register_name', registerResponse.data.open_register.register_name);
                        PosnicPro.local.set('userRegisterStatus', 'Open');
                        PosnicPro.local.set('branch_has_no_registers', '');
                        db.currentregister.put({ id: '1', register_id: registerResponse.data.open_register.register_id, register_name: registerResponse.data.open_register.register_name, register_status: 'open' });
                        PosnicPro.alert('success', 'Branch changed - Continuing with open register: ' + registerResponse.data.open_register.register_name);
                    } else {
                        PosnicPro.local.set('userRegisterStatus', 'Closed');
                        PosnicPro.local.set('cash_register_id', '');
                        PosnicPro.local.set('register_id', '');
                        PosnicPro.local.set('register_name', '');
                        PosnicPro.local.set('branch_has_no_registers', '');
                        db.currentregister.put({ id: '1', register_id: '', register_name: '', register_status: 'close' });
                        PosnicPro.alert('success', PosnicPro.i18n.t('lang_branch_changed_please_select_a_register_be', 'Branch changed - Please select a register before creating sales'));
                    }
                });
                if (PosnicPro.stocklogs) PosnicPro.stocklogs.viewLowStockDashboard();
                $('#dashboardModule a').addClass('active');
                $('#view_config_page').removeClass('active');
                $('#v-pills-dashboard-tab').addClass('active show');
                if (hasher.getHash() === 'branches') { PosnicPro.branches.loadList(); } else { hasher.setHash('branches'); }
                PosnicPro.alert('success', PosnicPro.i18n.t('lang_branch_changed', 'Branch changed'));
            }
            return false;
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    applyModuleNav: function () {
        PosnicPro.settings.refreshModuleCards();
        var s = {};
        try { s = JSON.parse(PosnicPro.local.get('general_settings') || '{}'); } catch (e) { /* defaults */ }
        var on = function (k) { return s[k] !== false; };
        $('#v-pills-recyclebin-tab').toggle(on('module_recyclebin_enable'));
        $('#v-pills-theme-tab').toggle(on('module_themes_enable'));
        if (PosnicPro.printSettings) PosnicPro.printSettings.features(s);
        $('#v-pills-tillpin-tab').toggle(s.till_lock_enable === true);
        $('#v-pills-cashregister-tab').toggle(on('cash_register_enable'));
        $('#v-pills-workforce-tab').toggle(on('staff_shifts_enable'));
        PosnicPro.applyModuleSidebar();
        PosnicPro.settings.coreTabsOverflow();
        $('#v-pills-tab .settings-nav-group').each(function () {
            var visible = $(this).nextUntil('.settings-nav-group').filter('a.nav-link').filter(function () {
                return $(this).css('display') !== 'none';
            }).length;
            $(this).toggle(visible > 0);
        });
    },
    refreshModuleCards: function () {
        var on = 0, total = 0;
        $('#v-pills-modules .module-card').each(function () {
            var $main = $(this).find('.module-card-head input.custom-control-input').first();
            var off = !$main.is(':checked');
            $(this).toggleClass('is-off', off);
            total += 1;
            if (!off) { on += 1; }
        });
        $('#fg_on_count').text(on);
        $('#fg_total_count').text(total);
        $('#fg_meter_bar').css('width', total ? Math.round(on * 100 / total) + '%' : '0%');
        $('#v-pills-modules .module-group').each(function () {
            var n = $(this).find('.module-card').length;
            var k = $(this).find('.module-card:not(.is-off)').length;
            $(this).find('[data-fg-count]').html('<b>' + k + '</b> / ' + n).toggleClass('is-none', k === 0);
        });
        PosnicPro.settings.applyModuleVisibility();
    },
    coreTabsOverflow: function () {
        var bar = $('#core_settings_tabs');
        if (!bar.length || !bar.is(':visible')) { return; }
        var more = bar.find('.core-tabs-more');
        var menu = more.find('.core-tabs-more-menu').empty();
        var items = bar.children('.nav-item').not(more);
        items.removeClass('d-none');
        more.addClass('d-none');
        var avail = bar.width() - 90; // room for the More toggle
        var used = 0;
        var overflowed = [];
        items.each(function () {
            used += $(this).outerWidth(true);
            if (used > avail) { overflowed.push(this); }
        });
        if (!overflowed.length) { return; }
        more.removeClass('d-none');
        $.each(overflowed, function (i, li) {
            var $a = $(li).children('a');
            $(li).addClass('d-none');
            $('<a class="dropdown-item" href="javascript:void(0)"></a>')
                .text($a.text().trim())
                .on('click', function () { $a.tab('show'); })
                .appendTo(menu);
        });
    },
    changeInputFieldsValueBackupTable: function (index) {
        var module = $(index).data('id');
        var fieldName = $('#view_' + module + '_fields :selected').text();
        $('.hide-recyclebin').hide();
        $('.' + module + '-recyclebin').show().prop('selected', 'selected').attr('selected', 'selected');
        if (module === 'recycle_bin' && typeof fieldName === 'string') {
            fieldName = fieldName.replace(/\s+/g, ' ').trim();
        }
        $('#view_' + module + '_input').prop('placeholder', 'Enter ' + fieldName);
        ($(index).val() === 'branches') ? $('#hide_branch_recyclebin,#Select_backup_Branch').hide() : $('#hide_branch_recyclebin,#Select_backup_Branch').show();
    },
    settingImageReadURL: function (e) {
        $('#file').css('color', 'green');
        $('#previewing').attr('src', e.target.result).attr('width', '200px').attr('height', '200px');
    },
    defaultCustomerData: function (checked) {
        $('#default_customer_enable_disable').prop('checked', !!checked);
        if (checked) {
            $('#default_customer').removeAttr('disabled');
            $('.customer-text-disable').css('color', '#20a83b');
            $('.customer-text-enable').css('color', '#141d46');
        } else {
            $('#default_customer').attr('disabled', 'disabled');
            $('.customer-text-disable').css('color', '#141d46');
            $('.customer-text-enable').css('color', '#20a83b');
        }
    },
    defaultSupplierData: function (checked) {
        $('#default_supplier_enable_disable').prop('checked', !!checked);
        if (checked) {
            $('#default_supplier').removeAttr('disabled');
            $('.supplier-text-disable').css('color', '#20a83b');
            $('.supplier-text-enable').css('color', '#141d46');
        } else {
            $('#default_supplier').attr('disabled', 'disabled');
            $('.supplier-text-disable').css('color', '#141d46');
            $('.supplier-text-enable').css('color', '#20a83b');
        }
    },
    getRestoreAccess: function () {
        var module = $('#backuptablelist :selected').val();
        var restore = PosnicPro[module + '_checkbox'];
        if (restore && restore.length > 0) {
            $('#restoreModal').modal('show');
            $('.restoreCountValue').html(restore.length);
        } else {
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_select_at_least_one_row', 'Select at least one row.'));
        }
    },
    setRestoreAccess: function () {
        var module = $('#backuptablelist :selected').val();
        var restore = PosnicPro[module + '_checkbox'] || [];
        var arr = [];
        $(restore).each(function (key, id) { arr.push(id); });
        PosnicPro.post({
            url: 'setting/restoreBackup',
            data: JSON.stringify({ data: arr })
        }, function (response) {
            if (response.type === 'success') {
                PosnicPro.settings.settingsTable();
            }
            $('#restoreModal').modal('hide');
            $('.restoreCountValue').html('');
            $('.showing-hide-show-' + module).hide();
            PosnicPro[module + '_checkbox'] = [];
            PosnicPro.alert(response.type, response.message);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    verifyDeleteCollections: function () {
        var password = $('#verify_password').val();
        if (!password) { return; }
        PosnicPro.get({
            url: 'users/userVerify',
            data: { password: password }
        }, function (response) {
            if (response.type === 'success') {
                $('.hideconfirm').show();
                PosnicPro.collectionDeleteConfirmed();
            }
            PosnicPro.alert(response.type, response.message);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    getAllCollection: function () {
        PosnicPro.get({ url: 'setting/getAllCollectionTotal' }, function (response) {
            if (response.type !== 'success' || !response.data) { return; }
            var d = response.data;
            $('.sales-record-counts').text(d.sales_count || 0);
            $('.receivings-record-counts').text(d.receivings_count || 0);
            $('.customers-record-counts').text(d.customers_count || 0);
            $('.suppliers-record-counts').text(d.suppliers_count || 0);
            $('.categories-record-counts').text(d.categories_count || 0);
            $('.stocklogs-record-counts').text(d.stock_activity_log_count || 0);
            $('.recycle-record-counts').text(d.recycle_bin_count || 0);
            $('.items-record-counts').text(d.items_count || 0);
        }, function () { /* counts are advisory; the delete path re-checks */ });
    },
    verifyViewDangerZoneConfirmed: function () {
        var password = $('#verifyPassword').val();
        if (!password) { return; }
        PosnicPro.get({
            url: 'users/userVerify',
            data: { password: password }
        }, function (response) {
            if (response.type === 'success') {
                $('#verifyPassword').val('');
                $('#dangerZone').show();
                PosnicPro.settings.getAllCollection();
            } else {
                $('#danger_zone').hide();
                $('#dangerZone').show();
            }
            PosnicPro.alert(response.type, response.message);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    removePopupBranchImage: function () {
        $('#deleteImagePopup').modal('show');
    },
    removeBranchImage: function () {
        var image_value = $('#setting_logo_value').val();
        PosnicPro.delete({
            url: 'setting/branchImageDelete',
            data: JSON.stringify({ data: image_value })
        }, function (response) {
            if (response.type === 'success') {
                $('#previewing,#store_image').attr('src', 'static/images/default/store.png');
                $('#setting_image_value').val('');
                $('#deleteImagePopup').modal('hide');
            }
            PosnicPro.alert(response.type, response.message);
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    }

};

$(function () {
    $('.hide-recyclebin').hide();
    var $backupSelect = $('#backuptablelist');
    if ($backupSelect.length) {
        PosnicPro.settings.changeInputFieldsValueBackupTable($backupSelect[0]);
    }
    /*
     * Test print, using whatever is selected right now.
     *
     * Delegated, because the settings page is loaded into the shell after this
     * script runs and a direct binding would find nothing to bind to.
     *
     * The width is taken from the form rather than from saved settings, so
     * somebody can try 58 and 80 and keep the one that fits without saving a
     * wrong value in between.
     */

    // The printer and paper controls moved to Hardware Manager, a separate
    // window the desktop app owns. This is the way through to it.
    $(document).on('click', '#open_hardware_manager, [data-open-device-hardware]', function () {
        if (window.electronAPI && window.electronAPI.desktop) {
            window.electronAPI.desktop.open('hardware');
        } else {
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_hardware_manager_is_part_of_the_desktop_ap', 'Hardware Manager is part of the desktop app. Open Posnic on the till to set the printer.'));
        }
    });

    $('.custom_default_value_search').on('keydown.autocomplete', function () {
        var module = $(this).data('id');
        $(this).autocomplete({
            lookup: function (query, done) {
                var result = {};
                var suggestions = [];
                var params = {
                    url: 'base/getDefaultSuggest',
                    data: 'query=' + query + '&module=' + module
                };
                PosnicPro.get(params, function (response) {
                    if (response.suggestions.length > 0) {
                        suggestions: $.map(response.suggestions, function (dataItem) {
                            suggestions.push({ "value": dataItem.name, "data": dataItem });
                        });
                    } else {
                        suggestions.push({ value: query + ' ', data: -1 });
                    }

                    result["suggestions"] = suggestions;
                    done(result);
                }, function (xhr) {
                    var response = jQuery.parseJSON(xhr.responseText);
                    PosnicPro.alert(response.type, response.message);
                });
            },
            onSelect: function (suggestion) {

                if (suggestion.data !== -1) {
                    $('#' + module + '_default_value').val(suggestion.data.id);
                } else {
                    if (module === 'customers') {
                        hasher.setHash('settings/default/customer');
                    } else {
                        hasher.setHash('settings/default/supplier');
                    }

                }
            },
            autoSelectFirst: true,
            triggerSelectOnValidInput: false,
            formatResult: function (suggestion) {
                var phone = suggestion.data.phone;
                if (suggestion.data === -1 || typeof suggestion.phone === undefined) {
                    phone = "( Add new )";
                }
                return '<div>' +
                    $.Autocomplete.formatResult(suggestion) +
                    '</div><span class="pull-right" style="margin-top:-20px;">' + phone + '</span>';
            }
        });
    });
});
$("#setting_add").validate({
    // Include inactive tabs and Select2 source selects in validation.
    ignore: 'input[type="hidden"], :disabled',
    errorPlacement: function (error, element) {
        var select = element.next('.select2');
        var phone = element.closest('.iti');
        error.insertAfter(select.length ? select : (phone.length ? phone : element));
    },
    highlight: function (element, errorClass) {
        $(element).css("border-color", "#f9616d");
    },
    unhighlight: function (element, errorClass) {
        $(element).css("border-color", "#eae8e8");
    },
    rules: {
        setting_country: { required: true },
        setting_state: { required: true },
        currency_setting: { required: true },
        currency_type: { required: true },
        time_zone: { required: true },
        storedate: { required: true },
        store_name: {
            required: true,
            minlength: 3,
            maxlength: 250
        },
        store_telephone: {
            required: true,
            minlength: 3,
            maxlength: 20,
            setting_phone_number: true
        },
        store_email: {
            required: true,
            email: true,
            emailExt: true,
            maxlength: 250
        },
        store_address: {
            required: true,
            minlength: 3,
            maxlength: 500
        },
        printing_address: {
            required: true,
            minlength: 3,
            maxlength: 500
        },
        website: {
            url: true,
            minlength: 3,
            maxlength: 50
        },
        city: {
            maxlength: 50
        },
        pincode: {
            maxlength: 15
        }
    },
    messages: {
        store_name: {
            required: "Enter the shop name",
            maxlength: "Store name should not be more than 250 characters"
        },
        store_telephone: {
            required: "Enter the phone number",
            setting_phone_number: "Enter a valid phone number",
            minlength: "Use at least 3 characters",
            maxlength: "Use no more than 20 characters"
        },
        store_email: {
            required: "Enter a valid email address",
            maxlength: "Email should not be more than 250 digits"
        },
        store_address: {
            required: "Enter the shop address",
            minlength: "Store Address must be Atleast 3 Characters long",
            maxlength: "Address is too Long !"
        },
        printing_address: {
            required: "Enter the address to print on receipts",
            minlength: "Printing Address must be Atleast 3 Characters long",
            maxlength: "Address is too Long !"
        },
        website: {
            required: "Enter a valid web address",
            minlength: "Website must be Atleast 3 Characters long",
            maxlength: "Website should not be more than 50 digits"
        },
        city: {
            maxlength: "Place should not be more than 50 digits"
        },
        pincode: {
            maxlength: "Place should not be more than 15 digits"
        }
    }
});
jQuery.validator.addMethod("setting_phone_number", function (phone_number, element) {
    let valid = PosnicPro.settings.store_telephone.isValidNumber();
    if (valid === true) {
        // Keep the national number visible; serialize the international number on save.
        return true;
    } else {
        return false;
    }

}, "Enter a valid phone number");
$("#setting_add").submit(function (event) {
    event.preventDefault();
    if ($('#setting_add').valid()) {          // checks form for validity
        PosnicPro.settings.generalSetting();
    }
});
$("#setting_image_add").submit(function (event) {
    event.preventDefault();
    PosnicPro.settings.settingImageFormSubmit();
});
$("#denom_add_form").validate({
    highlight: function (element, errorClass) {
        $(element).css("border-color", "#f9616d");
    },
    unhighlight: function (element, errorClass) {
        $(element).css("border-color", "#eae8e8");
    },
    rules: {
        denom_value: {
            required: true,
            minlength: 1
        }
    },
    messages: {
        denom_value: {
            required: "Enter a cash amount",
            minlength: "value must be at least 1 characters"
        }
    }
});
$("#denom_add_form").submit(function (event) {
    event.preventDefault();
    if ($('#denom_add_form').valid()) {            // checks form for validity
        if ($('#denom_id').val() !== '') {
            PosnicPro.denom.editDenomField();
        } else {
            PosnicPro.denom.addDenomField();
        }
    }
});
$("#eraseForm").validate({
    highlight: function (element, errorClass) {
        $(element).css("border-color", "#f9616d");
    },
    unhighlight: function (element, errorClass) {
        $(element).css("border-color", "#eae8e8");
    },
    rules: {
        verifyPassword: {
            required: true,
            minlength: 5,
            strong_password: true,
            maxlength: 20
        }
    },
    messages: {
        verifyPassword: {
            required: "Enter the password",
            minlength: "Password must be at least 5 characters",
            maxlength: "Password should not be more than 20 characters"
        }
    }
});
$("#eraseForm").submit(function (event) {
    event.preventDefault();
    if ($('#eraseForm').valid()) {            // checks form for validity
        PosnicPro.settings.verifyViewDangerZoneConfirmed();
    }
});
$('.custom_recyclebin_search_input').on('keypress keydown.autocomplete', function () {
    var module = $('#backuptablelist').val();
    var field_name = $('#view_recycle_bin_fields').val();
    $(this).autocomplete({
        lookup: function (query, done) {
            var result = {};
            var suggestions = [];
            var params = {
                url: 'setting/autoSuggestionRecycleBinTableField',
                data: 'query=' + query + '&field=' + field_name + '&module=' + module
            };
            PosnicPro.get(params, function (response) {
                suggestions: $.map(response.suggestions, function (dataItem) {
                    suggestions.push({ "value": dataItem, "data": dataItem });
                });
                result["suggestions"] = suggestions;
                done(result);
            });
        },
        autoSelectFirst: true
    });
});
$("#click_filter_btn,#v-pills-recyclebin-tab").click(function () {
    if ($('#show_recycle').css('display') == 'none') {
        $('#card_recycle').css({ "display": "block", "background-color": "#fff", "margin-bottom": "30px" });
    } else if ($('.hide-button-action').css('display') == 'none') {
        $('#card_recycle').css({ "display": "none", "background-color": "transparent", "margin-bottom": "0px" });
    }
});
$('.custom_default_value_search').click(function () {
    PosnicPro.selectAllText(jQuery(this));
});
$(document).ready(function () {
    $('#discount_amount').keyup(function () {
        if ($('#discount_amount').val() === '')
            $('#discount_amount').val('0');
    });
});
$("#decimal_Round").click(function () {
    if ($(this).is(":checked")) {
        $('#decimal_Round').attr('checked', 'checked');
    } else {
        $('#decimal_Round').attr('unchecked', 'unchecked');
    }
});
$("#receipt_barcode").click(function () {
    if ($(this).is(":checked")) {
        $('#receipt_barcode').attr('checked', 'checked');
    } else {
        $('#receipt_barcode').attr('unchecked', 'unchecked');
    }
});
$("#backup_table_data").click(function () {
    $('.storeSetting').removeClass('active');
    $('#backup_table_data').addClass('active');
    $(".backupReportTable").css({ "display": "none" });
    PosnicPro.settings.settingsTable();
});
$('#branch_name').change(function () {
    var branch_no = $('#branch_name').find(":selected").val();
    PosnicPro.settings.changeBranch(branch_no);
});
$(function () {
    $("#radio_discount_amount, #radio_discount_percentage").change(function () {
        if ($("#radio_discount_amount").is(":checked")) {
            $('#discount_percentage').attr('disabled', 'disabled').addClass('bg-white').val('0');
            $('#discount_amount').removeAttr('disabled', 'disabled').focus().select();
        } else if ($("#radio_discount_percentage").is(":checked")) {
            $('#discount_amount').attr('disabled', 'disabled').addClass('bg-white').val('0');
            $('#discount_percentage').removeAttr('disabled', 'disabled').focus().select();
        }
    });
});
function resize() {
    if ($(window).width() < 768) {
        $('#vertical_nav').addClass('tabs-horizantal');
        $('#vertical_nav').removeClass('tabs-vertical');
    } else {
        $('#vertical_nav').addClass('tabs-vertical');
    }
}

$(document).ready(function () {
    $('#v-pills-manage').addClass('show active');
    $(window).resize(resize);
    resize();
});
// Function to preview image after validation
$(function () {
    PosnicPro.settings.loadSelectSettingCountry();
    PosnicPro.settings.loadSelectSettingCurrency();
    PosnicPro.settings.timeZone();
    PosnicPro.commonDate();
    $("#file").change(function () {
        var fileSize = this.files[0].size;
        if (fileSize < 5242880) {
            var validExtensions = ['gif', 'jpg', 'png', 'jpeg', 'bmp'];
            var fileName = this.files[0].name;
            $('#setting_image_value').val(this.files[0].name);
            var fileNameExt = fileName.substr(fileName.lastIndexOf('.') + 1);
            if ($.inArray(fileNameExt, validExtensions) === -1) {
                this.type = ''
                this.type = 'file'
                PosnicPro.alert('error', "Only these file types are accepted : " + validExtensions.join(', '));
            } else {
                var reader = new FileReader();
                reader.onload = PosnicPro.settings.settingImageReadURL;
                reader.readAsDataURL(this.files[0]);
            }
        } else {
            PosnicPro.alert('error', "size should be less than 5MB !");
        }
    });
    /*Date Select Dropdown*/
    $('#storedate').on({
        change: function () {
            var selectedDate = $('#storedate').val();
            $('#storedate option[value="' + selectedDate + '"]').attr("selected", true);
            var serverDate = $('#storedate option[value="' + selectedDate + '"]').data('id');
            var serverText = $('#storedate option[value="' + selectedDate + '"]').text();
            $('#serverdate').val(serverDate);
            $('#dateText').val(serverText);
            $('#storedate').off('click');
        }
    });
    ($('#backuptablelist').val() === 'branches') ? $('#hide_branch_recyclebin,#Select_backup_Branch').hide() : $('#hide_branch_recyclebin,#Select_backup_Branch').show();
});
$("#Select_backup_Branch").change("change", function () {
    $("#select_backup_value_set").val($(this).find("option:selected").attr("value"));
});
// validate submit
$("#core_settings_save").validate({
    highlight: function (element, errorClass) {
        $(element).css("border-color", "#f9616d");
    },
    unhighlight: function (element, errorClass) {
        $(element).css("border-color", "#eae8e8");
    },
    rules: {
        sale_redirect_seconds: { required: true, digits: true, min: 0, max: 300 },
        default_customer: {
            required: true,
            minlength: 3,
            maxlength: 100
        },
        default_supplier: {
            required: true,
            minlength: 3,
            maxlength: 100
        },
        sales_prefix: {
            maxlength: 6
        },
        receiving_prefix: {
            maxlength: 6
        },
        notification_value: {
            required: true
        },
        header_print: {
            minlength: 3,
            maxlength: 1000
        },
        footer_print: {
            minlength: 3,
            maxlength: 1000
        }
    },
    messages: {
        default_customer: {
            required: "Choose a customer",
            minlength: "Customer name must be at least 3 characters",
            maxlength: "Customer name should not be more than 100 characters"
        },
        default_supplier: {
            required: "Choose a supplier",
            minlength: "Supplier name must be at least 3 characters",
            maxlength: "Supplier name should not be more than 100 characters"
        },
        sales_prefix: {
            required: "Enter a prefix for sale numbers",
            minlength: "Must be at least 3 characters",
            maxlength: "Should not be more than 3 characters"
        },
        receiving_prefix: {
            required: "Enter a prefix for stock entries",
            minlength: "Must be at least 3 characters",
            maxlength: "Should not be more than 3 characters"
        },
        notification_value: {
            required: "Enter a notification value"
        },
        header_print: {
            minlength: "Header content must be at least 3 characters",
            maxlength: "Header content should not be more than 1000 characters"
        },
        footer_print: {
            minlength: "Footer content must be at least 3 characters",
            maxlength: "Footer content should not be more than 1000 characters"
        }
    }
});
jQuery.validator.addMethod("lettersonly", function (value, element) {
    return this.optional(element) || /^[a-z\s]+$/i.test(value);
}, "Use letters only");
$("#core_settings_save").submit(function (event) {
    event.preventDefault();
    // Only this form owns the selected Core Settings tab. Other pages share
    // updateCommonSetting, and the hidden Receipt Print tab stays active.
    if ($('#core-tab-print').hasClass('active') && PosnicPro.receiptDesignerEditor) {
        PosnicPro.receiptDesignerEditor.save();
        return;
    }
    if ($('#core_settings_save').valid()) {            // checks form for validity
        PosnicPro.settings.updateCommonSetting('Core Settings saved', function () {
            if (PosnicPro.settings._sharingLoaded && PosnicPro.settings._sharingDirty) {
                PosnicPro.settings.saveSharing();
            } else PosnicPro.alert('success', PosnicPro.i18n.t('lang_successfully_completed', 'Successfully Completed'));
        });
    }
});
//start cash denom
$('.cashregisters-wrapper').each(function () {
    var $wrapper = $('.cashregisters-fields', this);
    var i = 0;
    $(".add-field", $(this)).click(function (e) {
        i++;
        if ($(this).parent('.cashregisters-input').find('input').val() !== '')
            $('.cashregisters-input:first-child', $wrapper).clone(true).appendTo($wrapper).find('input').attr('id', 'denom[' + i + ']').attr('name', 'cashdenom[' + i + ']').val('').focus();
    });
    $('.cashregisters-input .remove-field', $wrapper).click(function () {
        if ($('.cashregisters-input', $wrapper).length > 1)
            $(this).parent('.cashregisters-input').remove();
    });
});
$("#v-pills-general-tab").click(function () {
    PosnicPro.HideSideBarModal();
});
$("#setting_image_add").click(function () {
    PosnicPro.HideSideBarModal();
});
$(document).ready(function () {
    if (window.matchMedia("(pointer: coarse)").matches) {
        $('#shortcut').hide();
    } else {
        $('#shortcut').show();
    }
});
$('#setting_country').one('change', function () {
    var countrySelect = $('#setting_country');
    countrySelect.on('select2:select', function (e) {
        var data = e.params.data;
        PosnicPro.settings.loadSelectSettingState(data.element.attributes['data-setting-id'].value);
        PosnicPro.local.set("country_value", data.id);
    });
});

// Initialize form validation

/*
 * The print-designer editors load ON DEMAND (bundle-split slice 1).
 * summernote is 325KB that every boot parsed and initialised for a pane
 * most sessions never open; the editors now build when Settings opens.
 * _printDocs holds the truth meanwhile, so loads and saves that happen
 * before (or without) the editors still carry the right documents.
 */
PosnicPro.settings._printDocs = { header: '', footer: '' };
PosnicPro.settings._editorsReady = false;
PosnicPro.settings.initPrintEditors = function () {
    if (PosnicPro.settings._editorsReady) { return Promise.resolve(); }
    return PosnicPro.lazy.load('summernote').then(function () {
        if (PosnicPro.settings._editorsReady) { return; }
        $('#footer_print,#header_print').summernote({
    height: 120,
    toolbar: [
        ['style', ['style']],
        ['font', ['bold', 'underline', 'clear']],
        ['color', ['color']],
        ['para', ['ul', 'ol', 'paragraph']],
        ['table', ['table']],
        ['view', ['fullscreen', 'help']],
        ['height', ['height']],
        ['fontsize', ['fontsize']],
        ['fontname', ['fontname']]
    ],
    placeholder: PosnicPro.i18n.t('lang_enter_a_content', 'Enter a content ...'),
    focus: true,
    callbacks: {
        onKeydown: function (e) {
            var t = e.currentTarget.innerText;
            if (t.trim().length === 0) {
                $('#footer_print,#header_print').summernote('code', '');
            }
            if (t.trim().length >= 1000) {
                //delete keys, arrow keys, copy, cut, select all
                if (e.keyCode != 8 && !(e.keyCode >= 37 && e.keyCode <= 40) && e.keyCode != 46 && !(e.keyCode == 88 && e.ctrlKey) && !(e.keyCode == 67 && e.ctrlKey) && !(e.keyCode == 65 && e.ctrlKey))
                    e.preventDefault();
            }
        },
        onKeyup: function (e) {
            var t = e.currentTarget.innerText;
            if (t.trim().length === 0) {
                $('#footer_print,#header_print').summernote('code', '');
            }
            $('#footer_print,#header_print').text(1000 - t.trim().length);
        },
        onPaste: function (e) {
            var t = e.currentTarget.innerText;
            var bufferText = ((e.originalEvent || e).clipboardData || window.clipboardData).getData('Text');
            e.preventDefault();
            var maxPaste = bufferText.length;
            if (t.length + bufferText.length > 1000) {
                maxPaste = 1000 - t.length;
            }
            if (maxPaste > 0) {
                document.execCommand('insertText', false, bufferText.substring(0, maxPaste));
            }
            $('#footer_print,#header_print').text(1000 - t.length);
        }
    }
});
        PosnicPro.settings._editorsReady = true;
        $('#header_print').summernote('code', PosnicPro.settings._printDocs.header);
        $('#footer_print').summernote('code', PosnicPro.settings._printDocs.footer);
    });
};


$(function () {
    PosnicPro.lazyPhoneInput('#store_telephone', PosnicPro.settings, 'store_telephone', {
        separateDialCode: true,
        initialCountry: 'eg',
        preferredCountries: ['eg'],
        hiddenInput: "full",
        utilsScript: "../static/script/js/utils.js"
    });

});

// Module cards mirror their switch instantly (saving still goes through the
// Save button - the card state is feedback, not a write).
$(document).on('change', '#v-pills-modules .module-card-head input.custom-control-input', function () {
    PosnicPro.settings._featuresDirty = true;
    PosnicPro.settings.refreshModuleCards();
});
// Unsaved feature changes get a real decision (owner upgrade from the
// toast): Stay pulls you back with every selection intact; Leave
// discards knowingly.
$(window).on('hashchange', function () {
    if (PosnicPro.settings._featuresDirty && !/settings/i.test(window.location.hash || '')) {
        if (!window.confirm('You have unsaved feature changes. Leave without saving?')) {
            hasher.replaceHash('settings/modules');
            return;
        }
        PosnicPro.settings._featuresDirty = false;
    }
});

// Core Settings tabs refold on resize (debounced - resize storms are real).
(function () {
    var t = null;
    $(window).on('resize', function () {
        clearTimeout(t);
        t = setTimeout(function () { PosnicPro.settings.coreTabsOverflow(); }, 150);
    });
})();

// Config sections carry their route: every pill switch writes
// #/settings/<section>, so a refresh reopens exactly where you were.
// The Core Settings inner tab is remembered per device the same way.
$(function () {
    // Delegated from #settings, NOT from '#v-pills-tab': that id exists
    // TWICE (the main sidebar rail uses it too, first in the DOM), so the
    // original binding caught RAIL clicks - pressing Purchase wrote
    // #/settings/purchase and Config swallowed the page.
    $('#settings').on('shown.bs.tab', 'a[data-toggle="pill"][id^="v-pills-"]', function () {
        var m = /^v-pills-(.+?)(?:-tab)?$/.exec(this.id || '');
        if (!m) { return; }
        var target = 'settings/' + m[1];
        if (window.location.hash.slice(2) !== target) {
            hasher.setHash(target);
        }
        // The Manage sidebar carries the sections now: mirror the active one.
        $('.manage-settings-entry').removeClass('active');
        $('#manage_sec_' + m[1]).addClass('active');
    });
    $('#core_settings_tabs').on('shown.bs.tab', 'a[data-toggle="tab"]', function () {
        PosnicPro.local.set('posnic_core_tab', $(this).attr('href'));
        if ($(this).attr('href') === '#core-tab-wording' && PosnicPro.wordingEditor) PosnicPro.wordingEditor.open();
    });
});


/*
 * First-run Feature picker (user request, from the Loyverse pattern): the
 * first sign-in shows what the till can do, one honest line per feature,
 * pre-set from this branch's real state. Saving writes through the M4
 * modules-only path (toggle map and nothing else - the full settings
 * surface is never touched). Any dismissal marks it seen; it never nags.
 */
PosnicPro.features = {
    /* key, label, consequence - the same wording as the Features cards. */
    INTRO: [
        ['cash_register_enable', 'Cash register', 'Openings, closings and cash counts per till.'],
        ['staff_shifts_enable', 'Shifts & clock-in', 'Track when staff work; powers the labour report.'],
        ['staff_tips_enable', 'Tips', 'Record tips at tender and in payouts.'],
        ['staff_roster_enable', 'Roster', 'Plan the week; staff see their shifts.'],
        ['till_lock_enable', 'Till PIN lock', 'Lock the screen between sales; PIN to resume.'],
        ['quick_sale_enable', 'Quick sale', 'Type an amount, take payment - the busy-counter pad on the sale screen.'],
        ['module_recyclebin_enable', 'Recycle bin', 'Deleted records are kept and restorable.'],
        ['module_themes_enable', 'Themes', 'Change how the till looks.']
    ],
    _blob: function () {
        try { return JSON.parse(PosnicPro.local.get('general_settings') || '{}'); } catch (e) { return {}; }
    },
    /*
     * The general_settings blob is rebuilt from scratch in three places, and a
     * key missing from those literals is not merged - it is LOST. That is fine
     * for a switch, which the next settings read restores; it is not fine for
     * "this shop has been welcomed", because losing it shows the welcome again
     * to somebody who already dismissed it.
     *
     * An explicit value from the server always wins. `undefined` means the API
     * did not send the field - an older build, or a response that predates it -
     * and the honest answer there is what we already knew, not false.
     */
    keepFirstRunFlag: function (data, key) {
        var k = key || 'first_run_done';
        var d = data || {};
        if (d[k] === true || d[k] === 'true') { return true; }
        if (d[k] === false || d[k] === 'false') { return false; }
        return PosnicPro.features._blob()[k] === true;
    },
    /*
     * "Already seen" is PER SHOP, never per browser.
     *
     * The first version used one bare localStorage key, and that is why the
     * owner never saw the welcome on a single new shop he created: dismiss it
     * once on any shop and every shop opened from that browser afterwards is
     * silently skipped. The person it failed for hardest is exactly the
     * person who opens many shops - the owner testing signups, a partner
     * setting up customers. Keyed by branch id, a NEW shop has a NEW key and
     * is asked; the same shop still never asks the same browser twice.
     *
     * The legacy unscoped key is deliberately NOT read. Honouring it keeps
     * the bug alive for every browser that has it; ignoring it costs at most
     * one extra welcome on an old shop, and dismissing now writes the
     * per-shop server flag, so it is once, ever.
     */

    maybeShowIntro: function () {
        /*
         * Two gates, and they answer different questions.
         *
         * `features_intro_seen` is localStorage, so it is per BROWSER: it stops
         * the same person being asked twice on the machine they are sitting at,
         * and it is what shops running today already carry.
         *
         * `first_run_done` is saved on the shop, so it survives a new browser,
         * a second till and a reinstall. Without it the welcome returns every
         * time somebody signs in from a device that has not seen it, which for
         * a shop with four tills is four welcomes.
         *
         * It defaults to FALSE rather than absent-means-seen. Getting that
         * backwards would mean nobody ever sees this and nothing would look
         * wrong - the failure of a thing that only ever shows once is silence.
         */
        /*
         * THE DATABASE FIELD IS THE ONLY GATE. Owner, after three rounds of
         * this screen not appearing for him: "keep on db field and make sure
         * user know about it. mainly super admin."
         *
         * Every browser-side memory this gate ever had has burned it: the
         * bare localStorage key suppressed every new shop on his browser,
         * and its per-shop successor still meant a decision on one till was
         * invisible on the next. first_run_decided lives on the SHOP, is
         * written only by Save and the explicit "Not now", and can be read,
         * checked and reset with a one-line database query when someone asks
         * why a welcome did or did not show. One truth, inspectable.
         */
        var blob = PosnicPro.features._blob();
        /*
         * first_run_DECIDED, never first_run_done.
         *
         * A build shipped on the morning of 24 Aug counted ANY close as an
         * answer and wrote first_run_done to the server - so for every shop
         * touched in that window, including the owner's own test shops, the
         * flag says "asked" about a person who never was, and the welcome he
         * had demanded a thousand times silently never returned. The value
         * cannot be trusted and cannot be un-written shop by shop, so the
         * gate reads a key that only the two DECISION paths have ever
         * written. The cost is one extra welcome for anybody who genuinely
         * decided during those few hours; the alternative was every burned
         * shop never being asked at all.
         */
        /* Every exit says why, once. Three builds of this gate failed
           SILENTLY - the only witness each time was the owner, testing again.
           A branch that cannot say its own name in the console is a branch
           that gets debugged by shouting. */
        var say = function (why) {
            if (!PosnicPro.features._saidWhy) {
                PosnicPro.features._saidWhy = true;
                console.log('[welcome] not shown: ' + why);
            }
        };
        if (blob.first_run_decided === true || blob.first_run_decided === 'true') {
            say('already decided on this shop (first_run_decided is set)');
            return;
        }
        /* An empty blob is "settings have not loaded", not "never been asked",
           and guessing wrong there puts this in front of a shop that has been
           trading for a year. The caller keeps retrying while this is the
           case - see the poll below - because on a brand-new shop's FIRST
           login the blob is still being written when the first check fires,
           and a one-shot check loses that race on exactly the login this
           screen exists for. */
        if (!Object.keys(blob).length) {
            /*
             * FETCH THE TRUTH, do not wait for it to be left behind.
             *
             * The blob is written by the LOGIN flow - and shadow sessions
             * (the My Account "open in browser" door, the owner's own door)
             * never run it: they drop a token and land on the dashboard. So
             * "retry until the blob appears" retried forever on exactly his
             * sessions, silently, and the welcome that gates on a DB field
             * never actually asked the DB. It asks now: one read of the
             * features group, merged into the blob so the rest of the app
             * gains the same truth, then the gate decides for real.
             */
            if (!PosnicPro.features._fetchingGate) {
                PosnicPro.features._fetchingGate = true;
                /*
                 * getOneStore, NOT the features-group resolver.
                 *
                 * The resolver answers with READ-TIME defaults - absent means
                 * on - which is the right answer for gating a menu and a
                 * catastrophic one to persist. The first version merged those
                 * resolved values into the blob; the welcome rendered every
                 * switch ON from them; the owner pressed Save; and his own
                 * Save wrote all-on to a shop the installer had carefully
                 * created all-off. "again all features toggled on" - the
                 * poison travelled through the one button that should be
                 * safest. The branch document carries the installer's
                 * EXPLICIT values, so it is the only safe source to merge.
                 */
                PosnicPro.get({ url: 'branches/getOneStore', data: 'id=null' }, function (response) {
                    /* crash-hunt probe gate: skippable render */
                    if (window.__posnicSkip === 'store' || window.__posnicSkip === 'all') { return; }
                    var d = (response && response.data) || {};
                    var b = PosnicPro.features._blob();
                    PosnicPro.features.INTRO.forEach(function (f) {
                        var k = f[0];
                        if (b[k] === undefined && d[k] !== undefined) { b[k] = d[k] !== false && d[k] !== 'false'; }
                    });
                    ['first_run_done', 'first_run_decided'].forEach(function (k) {
                        if (b[k] === undefined && d[k] !== undefined) { b[k] = d[k] === true || d[k] === 'true'; }
                    });
                    PosnicPro.local.set('general_settings', JSON.stringify(b));
                    PosnicPro.features._fetchingGate = false;
                    PosnicPro.features.maybeShowIntro();
                }, function () {
                    /* the poll keeps retrying; a failed read must not end it */
                    PosnicPro.features._fetchingGate = false;
                });
            }
            return false;
        }
        /*
         * NO identity gate at all. Owner, fourth round: "keep on db field and
         * make sure user know about it."
         *
         * Every identity check this gate has carried refused HIM: the ACL
         * shape test refused owner-class users whose full access is an empty
         * map; the usertype bypass then read localStorage that shadow
         * sessions - the My Account "open in browser" door, HIS door - never
         * wrote. Two different silent refusals of the one person the screen
         * exists for.
         *
         * So the rule is now exactly his sentence: the DB field decides,
         * nothing else. Anyone signed in sees the welcome until somebody
         * saves or deliberately skips. A user without feature rights who
         * presses Save is refused by the SERVER - which was always the real
         * guard - and told they can set these later.
         */
        if (!$('#feature_intro_modal').length) { return; }
        /*
         * The Features page first, the welcome on top of it.
         *
         * Owner, more than once: "until skip you keep showing the features as
         * first page." The dialog opens OVER the features grid, so whichever
         * way it closes, the person is standing in front of the switches it
         * was talking about - not on a dashboard with no idea where those
         * switches went.
         */
        if (window.location.hash.slice(2) !== 'settings/modules') {
            hasher.setHash('settings/modules');
        }
        PosnicPro.features.renderIntro();
        /* One line, on purpose, forever: "did the welcome show for this
           shop?" is a support question, and a console line a headless session
           can grep is the difference between an answer and an argument. */
        console.log('[welcome] shown over the features page');
        $('#feature_intro_modal').modal('show');
        /*
         * Only a DECISION ends the welcome - Save, or the explicit "Not now".
         *
         * The first design treated any close as "asked" so it would never
         * nag. The owner overruled it, and he is right about who this is for:
         * a brand-new user who Escapes a dialog they did not read has not
         * learned that features are switchable, which is the entire point. So
         * a casual dismissal - Esc, a stray click - writes NOTHING, and the
         * welcome returns on the next login, over the Features page, until
         * the person either saves or says "Not now" on purpose.
         */
        /* No browser-side memory on close. The DB flag the decision paths
           write is the whole record; an undecided close leaves nothing, and
           the welcome returns next login - on this till and every other. */
    },
    /*
     * Where is this till actually running?
     *
     * Owner, twice: "i feel user is not clear about this system software
     * desktop application plus web based... we know but when first visit he
     * dont know." The website says it now; the first sign-in did not, and the
     * first sign-in is the one screen a new shop is certain to read.
     *
     * Three answers, decided from evidence the page already has:
     *
     *   desktop  the Electron app - the userAgent says so.
     *   web      a browser on a PUBLIC address, in which case the shop's web
     *            address IS the address bar. No lookup, no way to be stale.
     *   lan      a browser on localhost or a private address - somebody on the
     *            shop's own network looking at the local server. Claiming that
     *            address "opens on any phone" would be false the moment they
     *            left the building, so it gets its own sentence.
     */
    runningContext: function () {
        if (navigator.userAgent.indexOf('Electron') !== -1) { return 'desktop'; }
        var host = String(window.location.hostname || '').toLowerCase();
        var isPrivate = host === 'localhost' || host === '' ||
            /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /\.local$/.test(host);
        return isPrivate ? 'lan' : 'web';
    },

    /*
     * The desktop-and-web sentence, in the version that is true HERE.
     *
     * Never the generic "we have both an app and a website": that tells
     * somebody nothing about the one they are looking at, and the whole
     * point is orientation. Each variant says what THIS one is, what the
     * other one offers, and where to find it.
     *
     * The desktop line does not print a web address, deliberately. The app
     * does not reliably know its shop's cloud address, and a guessed URL that
     * 404s teaches a brand-new user that the product lies. The welcome email
     * and this app carry it, so that is where they are sent.
     */
    accessNote: function () {
        var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
        var ctx = PosnicPro.features.runningContext();
        if (ctx === 'desktop') {
            return '<b><lang class="lang_you_are_in_the_desktop_app">You are in the desktop app.</lang></b> Your data lives on this computer, so ' +
                'selling works with no internet at all. The same shop also opens in any web ' +
                'browser - the address is in your welcome email and in this app.';
        }
        if (ctx === 'web') {
            return '<b><lang class="lang_you_are_in_the_web_version">You are in the web version.</lang></b> The address of this shop is ' +
                '<b>' + esc(window.location.hostname) + '</b> - it opens on any computer or ' +
                'phone, so share it with your staff. The desktop app keeps selling when the internet is down.';
        }
        return '<b><lang class="lang_you_are_on_the_shop_network">You are on the shop network.</lang></b> This till runs from the shop computer ' +
            'and works with no internet. The same shop also opens in any browser - the ' +
            'address is under <b><lang class="lang_my_account">My Account</lang></b> there.';
    },

    setupSummary: function () {
        var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
        var value = function () {
            for (var i = 0; i < arguments.length; i += 1) {
                var text = $.trim(String(arguments[i] == null ? '' : arguments[i]));
                if (text && text !== 'null' && text !== 'undefined') { return text; }
            }
            return '';
        };
        var rows = [
            ['Country', value(PosnicPro.local.get('country_setting'), PosnicPro.local.get('countryname'), PosnicPro.local.get('country_value'), 'Detected')],
            ['Currency', value(PosnicPro.local.get('currencySign'), 'Shop currency')],
            ['Timezone', value(PosnicPro.timeZone(), 'Shop timezone')],
            ['Date format', value(PosnicPro.local.get('dateformatset'), 'Shop default')]
        ];
        return rows.map(function (row) {
            return '<span><small>' + esc(row[0]) + '</small><b>' + esc(row[1]) + '</b></span>';
        }).join('');
    },

    _esc: function (v) {
        return $('<i>').text(v == null ? '' : v).html();
    },

    _value: function () {
        for (var i = 0; i < arguments.length; i += 1) {
            var text = $.trim(String(arguments[i] == null ? '' : arguments[i]));
            if (text && text !== 'null' && text !== 'undefined') { return text; }
        }
        return '';
    },

    enhanceIntroSelect: function (selector) {
        var el = $(selector);
        if (!el.length || !$.fn.select2) { return; }
        if (el.data('select2')) {
            el.trigger('change.select2');
            return;
        }
        el.select2({
            dropdownParent: $('#feature_intro_modal'),
            width: '100%'
        });
    },

    chooseIntroSelectValue: function (selector, wanted) {
        var el = $(selector);
        if (!el.length) { return; }
        var hasWanted = false;
        if (wanted) {
            el.find('option').each(function () {
                if (String($(this).val()) === String(wanted)) { hasWanted = true; }
            });
        }
        if (hasWanted) {
            el.val(wanted);
        }
        if (!el.val() && el.find('option').length) {
            el.prop('selectedIndex', 0);
        }
        PosnicPro.features.enhanceIntroSelect(selector);
        el.trigger('change.select2');
    },

    copyIntroOptions: function (from, to, selected) {
        var src = $(from);
        var dest = $(to);
        if (!src.length || !dest.length || !src.find('option').length) { return false; }
        dest.html(src.html());
        PosnicPro.features.chooseIntroSelectValue(to, selected);
        return true;
    },

    loadIntroCountries: function () {
        var selected = PosnicPro.features._value(
            PosnicPro.local.get('country_setting'),
            PosnicPro.local.get('countryname'),
            PosnicPro.local.get('country_value')
        );
        if (PosnicPro.features.copyIntroOptions('#setting_country', '#feature_intro_country', selected)) {
            PosnicPro.features.loadIntroStates();
            return;
        }
        PosnicPro.get({
            url: 'setting/getJSONCountry',
            data: { name: 'countries' }
        }, function (response) {
            var options = '';
            $.each((response.data && response.data.countries) || [], function (key, dataItem) {
                options += '<option value="' + PosnicPro.features._esc(dataItem.value) +
                    '" data-setting-id="' + PosnicPro.features._esc(dataItem.id) + '">' +
                    PosnicPro.features._esc(dataItem.value) + '</option>';
            });
            $('#feature_intro_country').html(options);
            PosnicPro.features.chooseIntroSelectValue('#feature_intro_country', selected);
            PosnicPro.features.loadIntroStates();
        });
    },

    loadIntroStates: function (countryId, selected) {
        var picked = PosnicPro.features._value(selected, PosnicPro.local.get('state_setting'), PosnicPro.local.get('statename'));
        var id = PosnicPro.features._value(countryId, $('#feature_intro_country option:selected').data('setting-id'), PosnicPro.local.get('countryid'));
        if (!id) {
            $('#feature_intro_state').html('<option value="' + PosnicPro.features._esc(picked) + '">' + PosnicPro.features._esc(picked || 'State / region') + '</option>');
            PosnicPro.features.chooseIntroSelectValue('#feature_intro_state', picked);
            return;
        }
        PosnicPro.get({
            url: 'setting/getJSONState',
            data: { id: id }
        }, function (response) {
            var options = '';
            $.each((response.data && response.data.stateJsonArray) || [], function (key, name) {
                options += '<option value="' + PosnicPro.features._esc(name) + '">' + PosnicPro.features._esc(name) + '</option>';
            });
            if (!options && picked) {
                options = '<option value="' + PosnicPro.features._esc(picked) + '">' + PosnicPro.features._esc(picked) + '</option>';
            }
            $('#feature_intro_state').html(options);
            PosnicPro.features.chooseIntroSelectValue('#feature_intro_state', picked);
        });
    },

    loadIntroCurrencies: function () {
        var selected = PosnicPro.features._value($('#currency_setting').val(), PosnicPro.local.get('currency_setting'));
        if (PosnicPro.features.copyIntroOptions('#currency_setting', '#feature_intro_currency', selected)) {
            return;
        }
        PosnicPro.get({
            url: 'setting/getJSONCurrency'
        }, function (response) {
            var options = '';
            $.each((response.data && response.data.currency) || [], function (key, dataItem) {
                options += '<option value="' + PosnicPro.features._esc(dataItem.value) +
                    '" data-currency-id="' + PosnicPro.features._esc(dataItem.id) +
                    '" data-currency-text="' + PosnicPro.features._esc(dataItem.text) +
                    '" data-currency-symbol="' + PosnicPro.features._esc(dataItem.symbol) + '">' +
                    PosnicPro.features._esc(dataItem.value) + '</option>';
            });
            $('#feature_intro_currency').html(options);
            PosnicPro.features.chooseIntroSelectValue('#feature_intro_currency', selected);
        });
    },

    loadIntroTimezones: function () {
        var selected = PosnicPro.features._value(PosnicPro.timeZone());
        if (PosnicPro.features.copyIntroOptions('#time_zone', '#feature_intro_timezone', selected)) {
            return;
        }
        PosnicPro.get({
            url: 'setting/getJSONTimeZone'
        }, function (response) {
            var options = '';
            $.each(response.data || [], function (key, dataItem) {
                options += '<option value="' + PosnicPro.features._esc(dataItem.text) +
                    '" data-timezone-name="' + PosnicPro.features._esc(dataItem.text) + '">' +
                    PosnicPro.features._esc(dataItem.value) + '</option>';
            });
            $('#feature_intro_timezone').html(options);
            PosnicPro.features.chooseIntroSelectValue('#feature_intro_timezone', selected);
        });
    },

    loadIntroDates: function () {
        var selected = PosnicPro.features._value(PosnicPro.local.get('dateformatset'), $('#storedate').val(), 'dd/mm/yyyy');
        PosnicPro.features.copyIntroOptions('#storedate', '#feature_intro_date', selected);
    },

    initIntroLocaleEditor: function () {
        PosnicPro.itemStockPreference.load('#feature_intro_stock');
        PosnicPro.features.loadIntroCountries();
        PosnicPro.features.loadIntroCurrencies();
        PosnicPro.features.loadIntroTimezones();
        PosnicPro.features.loadIntroDates();
        window.setTimeout(function () {
            PosnicPro.features._introLocaleSnapshot = JSON.stringify(PosnicPro.features.readIntroLocale());
        }, 0);
    },

    readIntroLocale: function () {
        var countryOption = $('#feature_intro_country option:selected');
        var currencyOption = $('#feature_intro_currency option:selected');
        var dateOption = $('#feature_intro_date option:selected');
        var currencySymbol = PosnicPro.features._value(
            currencyOption.attr('data-currency-symbol'),
            $('#currencyText').val(),
            PosnicPro.local.get('currencySign')
        );
        return {
            setting_country: PosnicPro.features._value($('#feature_intro_country').val(), PosnicPro.local.get('country_setting')),
            country_id: PosnicPro.features._value(countryOption.attr('data-setting-id'), PosnicPro.local.get('countryid')),
            setting_state: PosnicPro.features._value($('#feature_intro_state').val(), PosnicPro.local.get('state_setting')),
            currency_setting: PosnicPro.features._value($('#feature_intro_currency').val(), $('#currency_setting').val()),
            currencyText: currencySymbol,
            currencyTextname: PosnicPro.features._value(currencyOption.attr('data-currency-text'), $('#currencyTextname').val(), currencySymbol),
            currency_type: currencySymbol,
            time_zone: PosnicPro.features._value($('#feature_intro_timezone').val(), PosnicPro.timeZone()),
            storedate: PosnicPro.features._value($('#feature_intro_date').val(), PosnicPro.local.get('dateformatset'), 'dd/mm/yyyy'),
            serverdate: PosnicPro.features._value(dateOption.attr('data-id'), $('#serverdate').val(), 'd/m/Y'),
            dateText: PosnicPro.features._value(dateOption.text(), $('#dateText').val(), '01/01/2018 - dd/mm/yyyy')
        };
    },

    applyIntroLocale: function (data, sent) {
        var d = data || {};
        var fallback = sent || {};
        var country = PosnicPro.features._value(d.country, fallback.setting_country);
        var state = PosnicPro.features._value(d.state, fallback.setting_state);
        var countryId = PosnicPro.features._value(d.country_id, fallback.country_id);
        var currencyText = PosnicPro.features._value(d.currency_text, fallback.currency_setting);
        var currencySymbol = PosnicPro.features._value(d.currency_type, fallback.currency_type, fallback.currencyText);
        var timezone = PosnicPro.features._value(d.time_zone, fallback.time_zone);
        var clientDate = PosnicPro.features._value(d.clientdate, d.client_dateformat, fallback.storedate);
        var serverDate = PosnicPro.features._value(d.serverdate, d.server_dateformat, fallback.serverdate);
        var dateText = PosnicPro.features._value(d.dateformat_text, fallback.dateText);

        PosnicPro.local.set('country_setting', country);
        PosnicPro.local.set('countryname', country);
        PosnicPro.local.set('countryid', countryId);
        PosnicPro.local.set('state_setting', state);
        PosnicPro.local.set('statename', state);
        PosnicPro.local.set('currency_setting', currencyText);
        PosnicPro.local.set('currencySign', currencySymbol);
        PosnicPro.local.set('timezone', timezone);
        PosnicPro.local.set('dateformatset', clientDate);
        PosnicPro.local.set('setdateformat', serverDate);

        $('#setting_country').val(country).trigger('change.select2');
        if (state) {
            $('#setting_state').html('<option value="' + PosnicPro.features._esc(state) + '" selected>' + PosnicPro.features._esc(state) + '</option>');
        }
        $('#currency_setting').val(currencyText).trigger('change.select2');
        $('#currencyText').val(PosnicPro.features._value(fallback.currencyText, currencySymbol));
        $('#currencyTextname').val(PosnicPro.features._value(fallback.currencyTextname, currencyText));
        $('#currency_type').html('<option value="' + PosnicPro.features._esc(currencySymbol) + '" selected>Symbol( ' + PosnicPro.features._esc(currencySymbol) + ' )</option>');
        $('#time_zone').val(timezone).trigger('change.select2');
        $('#storedate').val(clientDate).trigger('change.select2');
        $('#serverdate').val(serverDate);
        $('#dateText').val(dateText);
        $('.display-currency').html(currencySymbol);
    },

    saveIntroLocaleIfNeeded: function (done, fail) {
        var preference = $('#feature_intro_stock').val();
        if (preference) {
            PosnicPro.itemStockPreference.save(preference, function () {
                PosnicPro.features.saveIntroLocaleFields(done, fail);
            }, fail);
            return;
        }
        PosnicPro.features.saveIntroLocaleFields(done, fail);
    },
    saveIntroLocaleFields: function (done, fail) {
        var locale = PosnicPro.features.readIntroLocale();
        var snapshot = JSON.stringify(locale);
        if (snapshot === PosnicPro.features._introLocaleSnapshot) {
            done();
            return;
        }
        PosnicPro.put({
            url: 'setting/starterLocale',
            data: JSON.stringify(locale)
        }, function (response) {
            if (response.type === 'success') {
                PosnicPro.features.applyIntroLocale(response.data, locale);
                PosnicPro.features._introLocaleSnapshot = snapshot;
                done();
            } else {
                fail(response.message || 'Could not save starter settings');
            }
        }, function () {
            fail('Could not save starter settings. Please try again.');
        });
    },

    featureOn: function (blob, key) {
        var onByDefault = !(key === 'staff_tips_enable' || key === 'till_lock_enable');
        return blob[key] === undefined ? onByDefault : blob[key] === true;
    },

    showIntroStep: function (step) {
        var steps = ['sample', 'features', 'settings'];
        var index = Math.max(0, Math.min(steps.length - 1, Number(step) || 0));
        PosnicPro.features._introStep = index;
        $('[data-intro-step]').each(function () {
            $(this).toggleClass('is-active', $(this).data('introStep') === steps[index]);
        });
        $('[data-intro-dot]').each(function () {
            var dot = Number($(this).attr('data-intro-dot'));
            $(this).toggleClass('is-active', dot === index);
            $(this).toggleClass('is-done', dot < index);
        });
        $('#feature_intro_step_label').text('Step ' + (index + 1) + ' of ' + steps.length);
        $('#feature_intro_back').prop('hidden', index === 0).attr('hidden', index === 0 ? 'hidden' : null);
        $('#feature_intro_next').prop('hidden', index === steps.length - 1).attr('hidden', index === steps.length - 1 ? 'hidden' : null);
        $('#feature_intro_save, #feature_intro_tour')
            .prop('hidden', index !== steps.length - 1)
            .attr('hidden', index !== steps.length - 1 ? 'hidden' : null);
    },

    nextIntroStep: function () {
        var index = PosnicPro.features._introStep || 0;
        PosnicPro.features.showIntroStep(index + 1);
    },

    previousIntroStep: function () {
        PosnicPro.features.showIntroStep((PosnicPro.features._introStep || 0) - 1);
    },

    filterIntro: function () {
        var q = String($('#feature_intro_filter').val() || '').trim().toLowerCase();
        $('[data-feature-row]').each(function () {
            var hay = String($(this).data('featureSearch') || '').toLowerCase();
            $(this).toggleClass('is-hidden', !!q && hay.indexOf(q) === -1);
        });
    },

    renderIntro: function () {
        var blob = PosnicPro.features._blob();

        /*
         * The welcome, in the shop's own name. `local.get` hands back the
         * STRING "null" for a key written as null, which is how a header once
         * read "null null" - so anything that is not a real name falls back to
         * the generic sentence rather than greeting a shop called null.
         */
        var shop = PosnicPro.local.get('branchname');
        shop = (shop == null || shop === 'null' || shop === 'undefined') ? '' : $.trim(shop);
        $('#feature_intro_sub').text(shop
            ? shop + ' is set up and ready to take its first sale.'
            : 'Your till is set up and ready to take its first sale.');

        /*
         * Two different true sentences, because this screen reaches two
         * different shops. A NEW shop starts with a few features on and the
         * rest off, and needs to be told that the short menus are deliberate.
         * A shop created before those defaults existed has everything on, and
         * telling it "everything else is off" would be plainly false while it
         * looks at a full menu. Decided from the switches themselves rather
         * than from a signup date, which this page does not have.
         */
        var anyOff = PosnicPro.features.INTRO.some(function (f) {
            return blob[f[0]] === false || blob[f[0]] === 'false';
        });
        $('#feature_intro_lead').text(anyOff
            ? 'We have switched on the few things almost every shop needs, and left the rest off so your menus stay short. Turn on whatever you want - now, or any time later.'
            : 'Here is everything this till can do. Switch off what you do not need and those menus disappear; switch them back on whenever you want.');

        /* Built by accessNote, which escapes the one dynamic value (the
           hostname); everything else in it is our own copy. */
        $('#feature_intro_access').html(PosnicPro.features.accessNote());
        PosnicPro.features.initIntroLocaleEditor();

        $('#feature_intro_filter').val('');
        PosnicPro.features._introStep = 0;
        PosnicPro.features.showIntroStep(0);

        var rows = PosnicPro.features.INTRO.map(function (f) {
            var key = f[0];
            var on = PosnicPro.features.featureOn(blob, key);
            var search = (f[1] + ' ' + f[2] + ' ' + key).replace(/"/g, '&quot;');
            /* The whole row is the label, so a thumb anywhere on it flips the
               switch - the switch itself is a 40px target on a touch screen. */
            return {
                on: on,
                html: '<label class="first-run-row' + (on ? ' is-recommended' : '') + '" for="fi_' + key + '" data-feature-row data-feature-search="' + search + '">' +
                '<span class="first-run-row-text">' +
                '<b>' + f[1] + '</b>' +
                '<span>' + f[2] + '</span>' +
                '</span>' +
                '<span class="custom-control custom-switch first-run-switch">' +
                '<input type="checkbox" class="custom-control-input feature-intro-toggle" id="fi_' + key + '" data-key="' + key + '"' + (on ? ' checked' : '') + '>' +
                '<span class="custom-control-label"></span>' +
                '</span>' +
                '</label>'
            };
        }).sort(function (a, b) {
            return (a.on === b.on) ? 0 : (a.on ? -1 : 1);
        }).map(function (row) { return row.html; }).join('');
        $('#feature_intro_list').html(rows);
    },
    /*
     * "Save and start selling" has to arrive at the sale screen.
     *
     * The welcome puts the shop on the features page first, so it is standing
     * in front of the switches it is being told about - maybeShowIntro sets
     * that hash deliberately. The cost is that dismissing the dialog leaves a
     * shop that signed up ninety seconds ago looking at a settings screen,
     * which is the one place a new shop has no reason to be. The button names
     * where it goes; it should go there.
     *
     * Not for "Save & show me around", which is a walk around where these
     * switches live and would be cut short by a page change, and not for
     * "Not now", which decided nothing and asked to be left alone.
     */
    startSelling: function () {
        /*
         * Once, however this is reached. Every path below is a race that can
         * be won twice - a transition that fires and a timeout that also
         * fires - and setting the hash twice would push two history entries,
         * so Back would appear not to work.
         */
        var went = false;
        var go = function () {
            if (went) { return; }
            went = true;
            hasher.setHash('sales/new');
        };
        /*
         * The welcome fades out asynchronously. Changing the page under a
         * modal that has not finished closing is how a backdrop gets left
         * behind over the sale screen, so wait for this one visible dialog.
         */
        var showing = function (sel) {
            var m = $(sel);
            return m.length && (m.is(':visible') || m.hasClass('show') || m.hasClass('in'));
        };
        var after = function (sel, next) {
            if (!showing(sel)) { next(); return; }
            $(sel).one('hidden.bs.modal', next);
        };
        after('#feature_intro_modal', go);
        /*
         * And a floor under all of it. A transition that never fires - a
         * detached element, a browser honouring reduced motion, a stylesheet
         * that did not load - would leave the shop sitting on the settings
         * page having pressed a button that names somewhere else. Arriving
         * late is a blemish; not arriving is the bug being fixed.
         */
        setTimeout(go, 1200);
    },
    saveIntro: function () {
        /* Toggles only. This used to send sales_prefix:'SAL' and
           receiving_prefix:'REC' - invented values, purely to satisfy a
           validator for two fields this screen does not own. They were
           described as ignored, but nothing guaranteed that: the day the
           modules-only path stopped skipping them, every shop saving a
           feature toggle would have had its receipt numbering overwritten
           with "SAL" and "REC". The features endpoint knows only its own
           keys, so it cannot ask for them and would refuse them by name. */
        var payload = {};
        /* BOOLEANS, never the strings 'true'/'false'. The group endpoint
           once stored this payload verbatim, and every `!== false` reader
           then took the string "false" for ENABLED - saving all-off lit
           every feature up. The server coerces now, but the honest payload
           means even a not-yet-updated server stores values that read
           correctly. */
        $('.feature-intro-toggle').each(function () {
            payload[$(this).data('key')] = $(this).is(':checked');
        });
        /* Recorded in the same write as the choice it belongs to. A separate
           call could succeed while the toggles failed, and the shop would then
           never be offered the switches it did not manage to save. */
        payload.first_run_done = true;
        payload.first_run_decided = true;
        var saveButtons = $('#feature_intro_save, #feature_intro_tour, #feature_intro_skip, #feature_intro_close');
        saveButtons.prop('disabled', true);
        PosnicPro.features.saveIntroLocaleIfNeeded(function () {
            PosnicPro.put({
                url: 'settings/group/features',
                data: JSON.stringify(payload)
            }, function (response) {
                saveButtons.prop('disabled', false);
            if (response.type === 'success') {
                // The session blob must agree with what was just written, and
                // the menus react now, not at next login.
                var blob = PosnicPro.features._blob();
                $('.feature-intro-toggle').each(function () {
                    blob[$(this).data('key')] = $(this).is(':checked');
                });
                blob.first_run_done = true;
                blob.first_run_decided = true;
                PosnicPro.features._savedIntro = true;
                PosnicPro.features._decided = true;
                PosnicPro.local.set('general_settings', JSON.stringify(blob));
                if (PosnicPro.settings && PosnicPro.settings.applyModuleNav) { PosnicPro.settings.applyModuleNav(); }
                else if (PosnicPro.applyModuleSidebar) { PosnicPro.applyModuleSidebar(); }
                /* Read before the branch below clears it, because where this
                   shop goes next depends on which of the two buttons was
                   pressed and the flag does not survive to the end. */
                var wantedTour = PosnicPro.features._tourAfterSave;
                $('#feature_intro_modal').modal('hide');
                PosnicPro.alert('success', PosnicPro.i18n.t('lang_feature_switches_saved', 'Feature switches saved'));
                /* Only on a SAVED shop, and only when asked: a failed save
                   must never start a tour, and Save-alone must never grow
                   an uninvited one. */
                if (PosnicPro.features._tourAfterSave) {
                    PosnicPro.features._tourAfterSave = false;
                    setTimeout(function () { PosnicPro.tour.firstRun(); }, 400);
                }
                /* And then the sale screen, because that is what the button
                   says. The tour goes the other way - see startSelling. */
                if (!wantedTour) { PosnicPro.features.startSelling(); }
            } else {
                PosnicPro.alert(response.type, response.message);
            }
            }, function () {
                saveButtons.prop('disabled', false);
                PosnicPro.features._tourAfterSave = false;
                PosnicPro.alert('error', 'Could not save - you can set these later under Manage > Features');
            });
        }, function (message) {
            saveButtons.prop('disabled', false);
            PosnicPro.features._tourAfterSave = false;
            PosnicPro.alert('error', message);
        });
    }
};
/*
 * "Use defaults" is a decision, not a close button. It saves the current
 * recommended switches through the same path as Save and start selling, so the
 * welcome cannot disappear without recording the chosen setup.
 */
$(document).on('click', '#feature_intro_skip', function () {
    PosnicPro.features._decided = true;
    PosnicPro.features._tourAfterSave = false;
    PosnicPro.features.saveIntro();
});
$(document).on('click', '#feature_intro_close', function () {
    PosnicPro.features._decided = true;
    PosnicPro.features._tourAfterSave = false;
    PosnicPro.features.saveIntro();
});
$(document).on('input', '#feature_intro_filter', function () { PosnicPro.features.filterIntro(); });
$(document).on('click', '#feature_intro_next', function () { PosnicPro.features.nextIntroStep(); });
$(document).on('click', '#feature_intro_back', function () { PosnicPro.features.previousIntroStep(); });
$(document).on('click', '#feature_intro_save', function () { PosnicPro.features.saveIntro(); });
$(document).on('click', '#feature_intro_tour', function () {
    PosnicPro.features._tourAfterSave = true;
    PosnicPro.features.saveIntro();
});
$(document).on('change', '#feature_intro_country', function () {
    PosnicPro.features.loadIntroStates($(this).find('option:selected').attr('data-setting-id'), '');
});
$(document).ready(function () {
    /*
     * A POLL, not a one-shot.
     *
     * Login writes the general_settings blob and the ACL while the dashboard
     * is coming up, and on a brand-new shop's first login that write can land
     * after any fixed delay - a one-shot check fires into an empty blob,
     * returns, and the welcome never shows on the one login it exists for.
     * Nothing looks wrong: the shop simply appears to have no welcome, which
     * is how it went unreported until the owner opened a fresh shop himself.
     *
     * maybeShowIntro returns false ONLY for "not loaded yet". Every decided
     * outcome - shown, already seen, cashier, no modal - ends the poll.
     */
    var tries = 0;
    var poll = function () {
        tries += 1;
        if (PosnicPro.features.maybeShowIntro() === false) {
            if (tries < 30) { setTimeout(poll, 2000); return; }
            console.log('[welcome] not shown: settings or permissions never loaded in 60s');
        }
    };
    setTimeout(poll, 2500);
});

/* The customer-display address card was removed from Core Settings, and the
   customer-display page itself has since been removed. */

/*
 * The month a financial year starts in only means something to a financial
 * year.
 *
 * A shop on the calendar year that is shown "Financial year starts in April"
 * has been asked a question that does not apply to it, and the honest answers
 * to that are to hide it - not to grey it out, which is a control saying "you
 * may not touch me" about something that is simply not part of this choice.
 */
/*
 * The twelve months, in the language the page is in.
 *
 * Every browser ships every month name in every language it supports, so
 * writing them into seventeen translation packs would be a hundred and
 * ninety-nine hand-typed strings duplicating something already correct - and
 * one more list to keep true when a language is added. The year is arbitrary;
 * only the month names are read.
 */
PosnicPro.settings.fillFinancialYearMonths = function () {
    var select = document.getElementById('bill_number_fy_start_month');
    if (!select || select.options.length) { return; }
    var code = (PosnicPro.i18n && PosnicPro.i18n.code && PosnicPro.i18n.code()) || undefined;
    for (var month = 1; month <= 12; month += 1) {
        var name;
        try {
            name = new Date(2001, month - 1, 1).toLocaleString(code, { month: 'long' });
        } catch (e) {
            /* A language code the browser will not take. Its own default
               still names the months, which beats an empty list. */
            name = new Date(2001, month - 1, 1).toLocaleString(undefined, { month: 'long' });
        }
        select.add(new Option(name, String(month)));
    }
};

PosnicPro.settings.showFinancialYearMonth = function () {
    var row = $('#bill_number_fy_start_month_row');
    if (!row.length) { return; }
    row.toggle($('#bill_number_reset').val() === 'financial');
};

$(document).on('change', '#bill_number_reset', function () {
    PosnicPro.settings.showFinancialYearMonth();
});


/* Feature search (owner feedback): filter the cards by anything visible on
   them - title, description, sub-toggle labels. */
PosnicPro.settings.filterModuleCards = function (query) {
    var q = String(query || '').trim().toLowerCase();
    $('.module-grid .module-card').each(function () {
        var hit = !q || $(this).text().toLowerCase().indexOf(q) !== -1;
        $(this).toggleClass('search-miss', !hit);
    });
    PosnicPro.settings.applyModuleVisibility();
};

/*
 * What is shown is the search AND the chip, worked out in one place.
 *
 * Search marks a card search-miss; the All / On / Off chip marks it
 * filter-miss. Neither knows about the other, so a group whose every card is
 * hidden by one or the other would keep its heading on an empty grid - which
 * reads as "this group has nothing in it" rather than "nothing here matched".
 * This runs after either changes and hides the heading with its cards.
 */
PosnicPro.settings._moduleFilter = 'all';
PosnicPro.settings.applyModuleVisibility = function () {
    var f = PosnicPro.settings._moduleFilter || 'all';
    $('#v-pills-modules .module-card').each(function () {
        var off = $(this).hasClass('is-off');
        $(this).toggleClass('filter-miss', (f === 'on' && off) || (f === 'off' && !off));
    });
    $('#v-pills-modules .module-group').each(function () {
        var visible = $(this).find('.module-card').not('.search-miss, .filter-miss').length;
        $(this).toggleClass('group-empty', visible === 0);
    });
    var any = $('#v-pills-modules .module-card').not('.search-miss, .filter-miss').length;
    $('#fg_empty').toggle(any === 0);
};

$(document).on('click', '#v-pills-modules .fg-chip', function () {
    PosnicPro.settings._moduleFilter = $(this).attr('data-fg-filter') || 'all';
    $('#v-pills-modules .fg-chip').removeClass('is-active');
    $(this).addClass('is-active');
    PosnicPro.settings.applyModuleVisibility();
});

/* The settings header names whichever page the pill opened. */
$(document).on('shown.bs.tab', '#v-pills-tab a[data-toggle="pill"]', function () {
    var t = $.trim($(this).text());
    if (t) { $('#settings_page_title').text(t); }
});

/* Authorised signature for quotations: a small image stored with the shop
   settings as a data URL. No image = no signatory line on the quote. */
/*
 * A picture the shop chose, read here rather than uploaded.
 *
 * Same shape as the quotation signature above: a data URL in a hidden
 * field, saved with the rest of the form. No upload endpoint, no bucket,
 * and - the part that matters for printing - no other origin, so the
 * canvas that rasterises it for a thermal printer can actually read it.
 */
$(document).on('change', '#footer_image_file', function () {
    var f = this.files && this.files[0];
    if (!f) { return; }
    if (f.size > 300 * 1024) {
        PosnicPro.alert('warning', PosnicPro.i18n.t('lang_keep_the_picture_under_300_kb_a_small_png_w', 'Keep the picture under 300 KB - a small PNG works best.'));
        $(this).val('');
        return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
        $('#footer_image_value').val(e.target.result);
        $('#footer_image_thumb').attr('src', e.target.result).show();
        $('#footer_image_clear').show();
        /* An uploaded picture and a QR address cannot both print, so
           picking a file clears the address rather than leaving the shop
           to wonder which one won. */
        $('#footer_qr_url').val('');
        PosnicPro.settings._footerImagePicked = true;
    };
    reader.readAsDataURL(f);
});
$(document).on('click', '#footer_image_clear', function () {
    $('#footer_image_value').val('');
    $('#footer_image_file').val('');
    $('#footer_qr_url').val('');
    $('#footer_image_thumb').hide().attr('src', '');
    $(this).hide();
    PosnicPro.settings._footerImagePicked = true;
});
/* Typing an address is the other way to get a picture, and it replaces an
   uploaded one - the server makes the code and stores it. */
$(document).on('input', '#footer_qr_url', function () {
    if (!$(this).val()) { return; }
    $('#footer_image_file').val('');
    PosnicPro.settings._footerImagePicked = false;
});

/*
 * The generic feature-settings popup (owner rule): EVERY feature's
 * configuration opens here - a big scrollable dialog that can hold even
 * list pages. It ADOPTS an existing pane's children on open and returns
 * them on close, so pages keep working when reached the normal way too.
 */
PosnicPro.settings.openFeatureModal = function (title, paneSelector) {
    if (!$('#feature_settings_modal').length) {
        $('body').append(
            '<div class="modal fade" id="feature_settings_modal" tabindex="-1" role="dialog" aria-hidden="true">'
            + '<div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable" role="document">'
            + '<div class="modal-content">'
            + '<div class="modal-header py-2"><h5 class="modal-title" id="feature_settings_title"></h5>'
            + '<button type="button" class="close" data-dismiss="modal">&times;</button></div>'
            + '<div class="modal-body" id="feature_settings_body"></div>'
            + '</div></div></div>');
        $('#feature_settings_modal').on('hidden.bs.modal', function () {
            var home = $('#feature_settings_body').data('home');
            if (home) { $(home).append($('#feature_settings_body').children()); }
            $('#feature_settings_body').empty().removeData('home');
        });
    }
    var $pane = $(paneSelector);
    if (!$pane.length) { return; }
    $('#feature_settings_title').text(title);
    $('#feature_settings_body').data('home', paneSelector).append($pane.children());
    $('#feature_settings_modal').modal('show');
};
$(document).on('click', '.feature-pane-open', function () {
    PosnicPro.settings.openFeatureModal($(this).data('title') || 'Settings', $(this).data('pane'));
});
/*
 * Sharing between shops (owner ask #85).
 *
 * Its own load and its own save, because it writes at ACCOUNT level while
 * everything around it on this screen writes to the branch. Riding the general
 * form save would let a screen opened on one shop push that shop's view onto
 * all of them - which is the exact failure S5 inheritance was built to avoid.
 *
 * `?level=account` on the read, for the same reason: resolveGroup would answer
 * "what is in force at THIS branch", and saving that back would turn one
 * branch's override into everybody's rule.
 */
PosnicPro.settings = PosnicPro.settings || {};
/* The denomination editor has always lived on the settings namespace. Older
   bundles still call it through `PosnicPro.denom`; keep that spelling as an
   alias instead of letting the settings page die on an undefined namespace. */
PosnicPro.denom = PosnicPro.settings;

/* Stock is deliberately absent: a count sits on one shelf, in one building, so
   it is copied once when a shop is created rather than shared as a rule. See
   api/src/services/catalogue-copy.js. */
PosnicPro.settings.SHARING_KEYS = ['share_customers', 'share_suppliers'];

PosnicPro.settings.loadSharing = function () {
    if (!$('#sharing_fieldset').length) { return; }
    PosnicPro.settings._sharingLoaded = false;
    PosnicPro.settings._sharingDirty = false;
    PosnicPro.get({ url: 'settings/group/sharing', data: { level: 'account' } }, function (r) {
        var values = (r && r.data && r.data.values) || {};
        $.each(PosnicPro.settings.SHARING_KEYS, function (i, key) {
            /* An absent key means nothing account-wide has been decided, which
               the server reads as off. The switch must show the same thing, or
               the screen and the query disagree. */
            $('#set_' + key).prop('checked', PosnicPro.settings._sharingOn(values[key]));
        });
        $('#sharing_status').text('');
        PosnicPro.settings._sharingLoaded = r && r.type === 'success';
    }, function () {
        $('#sharing_status').text(PosnicPro.i18n.t('lang_could_not_read_the_current_setting', 'Could not read the current setting.'));
    });
};

/* Settings arrive as a boolean or as the string a form wrote. `!!"false"` is
   true, and for a switch that decides who sees whose customers that is the
   wrong direction to be wrong in - the server reads it the same way. */
PosnicPro.settings._sharingOn = function (v) {
    if (v === true) { return true; }
    if (v === false || v === null || v === undefined) { return false; }
    var t = String(v).trim().toLowerCase();
    return t === 'true' || t === '1' || t === 'yes' || t === 'on' || t === 'enable' || t === 'enabled';
};

PosnicPro.settings.saveSharing = function () {
    var payload = { level: 'account' };
    $.each(PosnicPro.settings.SHARING_KEYS, function (i, key) {
        /* Stated, never implied. A switch left alone must still travel, or the
           server keeps whatever it had and the screen says otherwise. */
        payload[key] = $('#set_' + key).is(':checked');
    });
    $('#sharing_save_btn').prop('disabled', true);
    $('#sharing_status').text(PosnicPro.i18n.t('lang_saving', 'Saving ...'));
    PosnicPro.put({ url: 'settings/group/sharing', data: JSON.stringify(payload) }, function (r) {
        $('#sharing_save_btn').prop('disabled', false);
        $('#sharing_status').text(r.type === 'success' ? 'Saved. Applies to every shop.' : '');
        if (r.type === 'success') PosnicPro.settings._sharingDirty = false;
        PosnicPro.alert(r.type, r.type === 'success' ? 'Sharing saved' : r.message);
    }, function (xhr) {
        $('#sharing_save_btn').prop('disabled', false);
        $('#sharing_status').text('');
        var resp = {}; try { resp = JSON.parse(xhr.responseText); } catch (e) { /* plain */ }
        /* 403 has a specific meaning here and a generic "could not save" hides
           it: this is deliberately owner-class, because it decides what other
           people can read. */
        PosnicPro.alert('error', xhr.status === 403
            ? 'Only an owner can change what is shared between shops'
            : (resp.message || 'Could not save sharing'));
    });
};

$(document).on('click', '#v-pills-general-tab', function () {
    PosnicPro.settings.loadSharing();
});

/*
 * Feature detail dialogs (FEATURE_PAGES_DESIGN): every Core feature opens
 * like a product listing - readable while OFF, toggle in the hero,
 * screenshots and benefits when provided, and ALL of its settings adopted
 * into one place. JS-built and body-appended: the only modal pattern that
 * has never broken in this codebase.
 */
PosnicPro.settings.featureInfo = {
    /*
     * Copy written 2026-08-21 for the nine features whose dialog opened with
     * nothing but the one-line card description.
     *
     * Every claim below was checked against the code that implements it rather
     * than written from the feature's name. A listing that promises something
     * the software does not do is worse than a listing with no detail at all -
     * it is the shop owner who finds out, in front of a customer.
     *
     * NO `section` KEY on most of these, deliberately. It names the markup
     * block whose controls the dialog ADOPTS, and only three exist: fc_quotes,
     * fc_tillpin and fc_workforce. The first draft invented
     * seven more from the feature names. The renderer guards with
     * $(info.section).length so nothing would have broken - which is exactly
     * what makes it worth catching: it would have sat there reading as wired.
     */
    staff_tips_enable: {
        tagline: 'Record tips at clock-out and pay them out with wages.',
        about: 'Cash tips are declared by the person who earned them when they clock out, stored against that shift, and carried into the labour and payroll figures - so they are paid rather than remembered.',
        benefits: [
            'Declared at clock-out, by the person who took them',
            'Held against the shift, so who earned what is never in doubt',
            'Flows into payroll rather than living on a piece of paper'
        ],
        how: [
            'Turn it on - a tips box appears at clock-out',
            'Staff enter what they took in cash; blank is fine',
            'Review it per shift, and pay it with that period of wages'
        ]
    },
    staff_roster_enable: {
        tagline: 'Plan the week ahead; staff see the shifts they are on.',
        about: 'A roster is next week decided this week. Plan a stretch for a person on a day, and the people you rostered can see their own shifts without asking.',
        benefits: [
            'Plan a week in one screen instead of a group message',
            'Staff see their own shifts; managers see everyone',
            'Viewing and planning are separate permissions'
        ],
        how: [
            'Turn it on - Roster appears beside Shifts',
            'Pick a person and a day, and set their stretch',
            'They see it on their own account from then on'
        ]
    },
    module_recyclebin_enable: {
        tagline: 'A deletion you can undo - records are kept, not destroyed.',
        about: 'Deleting marks a record as deleted and hides it; it does not remove it. Anything deleted can be found and restored, which is what makes a delete button safe to hand to a cashier.',
        benefits: [
            'A wrong delete is a mistake, not a loss',
            'Restore puts the record back where it was',
            'Turning the feature off does not destroy what is already kept'
        ],
        how: [
            'Turn it on - Recycle bin appears under settings',
            'Delete as normal; the record moves there instead',
            'Find it and restore it if it should not have gone'
        ]
    },
    module_themes_enable: {
        tagline: 'Change how the till looks, without changing how it works.',
        about: 'A theme sets the colours and surfaces of the whole app from one place. Colour still carries meaning - red destroys, green succeeded, the accent is the main action - so a theme changes the palette, never what a colour means.',
        benefits: [
            'One place for the look of every screen',
            'Light and dark, chosen per person',
            'Meaning is preserved: a theme cannot make red mean "saved"'
        ],
        how: [
            'Turn it on - Themes appears under settings',
            'Pick one; it applies immediately, everywhere',
            'Anyone can change it back without help'
        ]
    },
    staff_shifts_enable: {
        tagline: 'Staff clock in and out from the header clock; labour report and payroll exports.',
        about: 'Workforce turns the till into the timesheet: clock in/out, shift history, labour costing and payroll exports - with tips and rosters as optional pieces below.',
        benefits: [
            'One tap clock in/out right on the till header',
            'Labour report shows who worked when, and what it cost',
            'Payroll exports ready for your accountant',
            'Tips at clock-out and rosters when you want them'
        ],
        how: [
            'Turn it on and the clock appears in the header',
            'Staff tap to clock in and out through their day',
            'Review hours in the Labour report under Reports'
        ]
    },
    custom_charges_enable: {
        tagline: 'Parcel, service or delivery charges added on a sale.',
        about: 'Named amounts that join the bill after the item math - never fake line items. Sales that already carry charges stay editable even when this is off.',
        benefits: [
            'Any name: parcel, service, delivery, installation',
            'Joins the payable after discounts - honest totals',
            'Existing charges stay on their sale'
        ],
        how: [
            'Turn it on; “+ Add charge” appears beside the Payment Note',
            'Name it, amount it - it lists right there, removable',
            'The Pay Total carries it; the sale stores it'
        ]
    },
    quick_sale_enable: {
        tagline: 'Type an amount, take payment - the busy-counter pad on the sale screen.',
        about: 'Quick Sale is a fast lane for the counter: enter the amount and an optional name, add it to the current sale, then tender normally. It creates an instant item on the sale, so stock, receipts, reports and sync all see an ordinary sale line.',
        benefits: [
            'One amount and an optional name - no catalogue search',
            'The amount becomes the line price - no catalogue item needed',
            'Off by default; switch it on only where the counter needs it'
        ],
        how: [
            'Turn it on - the lightning button appears beside the sale search',
            'Type the amount, optionally name the line, add it to the sale',
            'Tender the sale as usual; the instant line follows normal reports'
        ],
        offNote: 'Switching off hides the Quick Sale button; sales already made with it are kept.'
    },
    cash_register_enable: {
        tagline: 'Till sessions, floats and register reports.',
        about: 'Registers add the open-count-close ceremony: a float to start, a session per till, and a register report to reconcile. Off: sales work without any register ceremony.',
        benefits: [
            'Every rupee in the drawer accounted per session',
            'Register report reconciles float, sales and payouts',
            'Resume your own session across devices'
        ],
        how: [
            'Turn it on; login asks which register to open',
            'Count the float, trade the day',
            'Close with a count - the report shows the difference'
        ]
    },
    till_lock_enable: {
        tagline: 'Staff unlock with a 4-digit PIN instead of a password.',
        about: 'The till locks to a PIN pad - fast for staff, safe for the counter. Choose an idle timeout below.',
        benefits: [
            'One tap lock, 4-digit unlock',
            'Idle auto-lock keeps an unattended till safe'
        ],
        how: [
            'Turn it on; staff set their PINs',
            'Pick when the till should lock by itself'
        ]
    }
};

PosnicPro.settings._fpCard = null;
PosnicPro.settings._fpSection = null;
/*
 * The feature PAGE (owner's final shape): each feature opens its OWN
 * dedicated page - hero with the toggle, the help documentation, and only
 * THAT feature's settings, adopted from the hidden store and returned on
 * leave. No popup, no aggregate page, no extra menu entry.
 */
/*
 * A screenshot that is not there yet removes itself, and takes the empty strip
 * with it. Without the second half, a feature with no images keeps a 14px gap
 * and a scroll container holding nothing.
 */
PosnicPro.settings._shotMissing = function (img) {
    var $strip = $(img).closest('.fd-shots');
    $(img).remove();
    if (!$strip.find('img').length) { $strip.remove(); }
};

/*
 * One loaded screenshot asks for the next. This is what keeps the cost at one
 * failed request for a feature with no images instead of one per slot guessed.
 *
 * Capped, because the chain is driven by the server answering 200: a directory
 * that somehow served every name would ask forever. Ten is far more than any
 * feature page should show.
 */
PosnicPro.settings.MAX_SHOTS = 10;
PosnicPro.settings._shotNext = function (img) {
    var $img = $(img);
    var $strip = $img.closest('.fd-shots');
    var key = $strip.attr('data-shot-key');
    var n = Number($img.attr('data-shot-n') || 0);
    if (!/^[a-z0-9_-]+$/i.test(key || '') || !n || n >= PosnicPro.settings.MAX_SHOTS) { return; }
    if ($strip.find('[data-shot-n="' + (n + 1) + '"]').length) { return; }
    $('<img>')
        .attr('src', 'static/images/features/' + key + '-' + (n + 1) + '.png')
        .attr('alt', '')
        .attr('data-shot-n', n + 1)
        .attr('onload', 'PosnicPro.settings._shotNext(this);')
        .attr('onerror', 'PosnicPro.settings._shotMissing(this);')
        .appendTo($strip);
};

PosnicPro.settings.openFeaturePage = function ($card) {
    var $main = $card.find('.module-card-head input.custom-control-input').first();
    var key = $main.attr('id') || '';
    var info = PosnicPro.settings.featureInfo[key] || {};
    var title = $.trim($card.find('.module-title').text());
    var desc = $.trim($card.find('.module-desc').text());

    PosnicPro.settings._fpCard = $card;
    $('#fp_icon').html($card.find('.module-ico').html() || '');
    $('#fp_title').text(title);
    $('#fp_tagline').text(info.tagline || desc);
    var on = $main.is(':checked');
    $('#fp_master').prop('checked', on);
    $('#fp_state').text(on ? PosnicPro.i18n.t('lang_on', 'On') : PosnicPro.i18n.t('lang_off', 'Off'))
        .toggleClass('badge-success', on)
        .toggleClass('badge-light', !on);

    var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
    var infoHtml = '';
    /*
     * Screenshots by CONVENTION, so adding one is dropping a file.
     *
     * The owner has to take these - they are pictures of his running shop and
     * nobody else can. Everything AROUND that is built here so his one action
     * is the only thing left: drop
     *
     *     static/images/features/<feature_key>-1.png   (-2, -3 ... for more)
     *
     * and it appears. No JS edit, no list to maintain, no deploy for a picture.
     * An explicit `shots` array still wins, for anything that does not fit.
     *
     * PROBED ONE AT A TIME, not three at once. Rendering -1, -2 and -3
     * speculatively costs three 404s every time a dialog opens for a feature
     * with no images - which is every feature today, seventeen of them. Asking
     * for the next only after the current one LOADS means a feature with no
     * screenshot costs exactly one failed request, and a feature with five
     * costs five successes and one failure. The chain extends itself.
     *
     * A missing file removes its own tag, and the strip removes itself once
     * empty, so nothing shows a row of broken-image icons.
     *
     * The CSS fixes the frame at aspect-ratio 8/5, which is why the ask is for
     * 8:5 images - anything else is cropped to fit, not letterboxed.
     */
    var shots = info.shots || [];
    if (shots.length) {
        infoHtml += '<div class="fd-shots">' + shots.map(function (src) {
            return '<img src="' + src + '" alt="" loading="lazy"'
                + ' onerror="PosnicPro.settings._shotMissing(this);">';
        }).join('') + '</div>';
    } else if (key) {
        infoHtml += '<div class="fd-shots" data-shot-key="' + esc(key) + '">'
            + '<img loading="lazy" decoding="async" src="static/images/features/' + esc(key) + '-1.png" alt="" data-shot-n="1"'
            + ' onload="PosnicPro.settings._shotNext(this);"'
            + ' onerror="PosnicPro.settings._shotMissing(this);">'
            + '</div>';
    }
    infoHtml += '<div class="q-label"><lang class="lang_about">About</lang></div><p class="fd-text">' + esc(info.about || desc) + '</p>';
    if ((info.benefits || []).length) {
        infoHtml += '<div class="q-label"><lang class="lang_why_use_it">Why use it</lang></div><ul class="fd-list">'
            + info.benefits.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>';
    }
    if ((info.how || []).length) {
        infoHtml += '<div class="q-label"><lang class="lang_how_it_works">How it works</lang></div><ol class="fd-list">'
            + info.how.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ol>';
    }
    /*
     * ONE SYSTEM, the owner's rule: "if user clicks on the feature box then
     * show only details or guide for the features... every feature should
     * have its own left side." So this page is TEXT - what the feature is,
     * why, how - plus one link to the feature's own entry in the Manage
     * sidebar. The old version adopted each feature's config form INTO this
     * page, which made Demo Data configure one way and a module another; with
     * hundreds of features coming, two doors is one too many.
     */
    var home = PosnicPro.settings.FEATURE_HOME[key];
    if (home) {
        infoHtml += '<div class="q-label"><lang class="lang_fp_configure">Configure</lang></div>'
            + '<p class="fd-text"><a class="fp-configure-link" href="#/' + (home[2] === 'page' ? '' : 'settings/') + esc(home[0]) + '">'
            + 'Manage &rarr; ' + esc(home[1]) + '</a></p>';
    }
    /* The generic line is TRUE for every feature except Demo Data, whose off
       is now a consented deletion - a footer promising "never deletes" under
       a switch that deletes is exactly the kind of lie a new user remembers. */
    infoHtml += '<p class="text-muted mt-3 mb-0" style="font-size:13px;">'
        + esc(info.offNote || 'Switching off never deletes anything - switch back on and everything returns.')
        + '</p>';
    $('#fp_info').html(infoHtml);

    // show the page pane, keep the Features nav highlighted
    $('#v-pills-modules').removeClass('show active');
    $('#v-pills-featureconf').addClass('show active');
};
/*
 * Where each feature's configuration LIVES - its Manage sidebar entry.
 * [route key, label]. A feature added here gets its Configure link on the
 * guide page; a feature with no entry simply shows no link.
 */
PosnicPro.settings.FEATURE_HOME = {
    cash_register_enable: ['cashregister', 'Cash Register'],
    staff_shifts_enable: ['workforce', 'Workforce'],
    staff_tips_enable: ['workforce', 'Workforce'],
    staff_roster_enable: ['workforce', 'Workforce'],
    module_themes_enable: ['theme', 'Themes'],
    module_recyclebin_enable: ['recyclebin', 'Recycle Bin'],
    till_lock_enable: ['tillpin', 'Till PIN Lock'],
};
/* The Configure link leaves the guide the same way Back does; the hash
   route opens the feature's own section. */
$(document).on('click', '.fp-configure-link', function () {
    PosnicPro.settings.closeFeaturePage();
});
PosnicPro.settings.closeFeaturePage = function () {
    PosnicPro.settings._fpCard = null;
    $('#v-pills-featureconf').removeClass('show active');
    $('#v-pills-modules').addClass('show active');
};
$(document).on('click', '#fp_back', function () {
    PosnicPro.settings.closeFeaturePage();
});
$(document).on('change', '#fp_master', function () {
    var $c = PosnicPro.settings._fpCard;
    if (!$c) { return; }
    var on = $(this).is(':checked');
    $c.find('.module-card-head input.custom-control-input').first()
        .prop('checked', on).trigger('change');
    $('#fp_state').text(on ? PosnicPro.i18n.t('lang_on', 'On') : PosnicPro.i18n.t('lang_off', 'Off'))
        .toggleClass('badge-success', on)
        .toggleClass('badge-light', !on);
});
// the whole card is the door to the feature's page
$(document).on('click', '#v-pills-modules .module-card', function (e) {
    if ($(e.target).closest('input, select, textarea, label, a, button, .custom-control').length) { return; }
    PosnicPro.settings.openFeaturePage($(this));
});

$(document).on("change", "#sharing_fieldset input", function () { PosnicPro.settings._sharingDirty = true; });

/* Optional branch packaging presets, through the scoped shared settings API. */
(function(){
 var busy=false,loaded=false;
 function status(text){$('#parcel_carton_status').text(text);}
 function lock(value){busy=value;$('#parcel_carton_add,#parcel_carton_save,#parcel_carton_rows input,#parcel_carton_rows button').prop('disabled',value);}
 function row(value){var tr=$('<tr>').attr('data-carton-id',value.id||crypto.randomUUID());['name','lengthCm','widthCm','heightCm','emptyWeightKg'].forEach(function(key){var input=$('<input>').addClass('form-control').attr({'data-field':key,'aria-label':key,type:key==='name'?'text':'number'}).val(value[key]==null?'':value[key]);if(key==='name')input.attr('maxlength','80');else input.attr({min:key==='emptyWeightKg'?0:0.001,step:'any'});tr.append($('<td>').append(input));});var remove=$('<button type="button" class="btn btn-light"><lang class="lang_remove">Remove</lang></button>').on('click',function(){tr.remove();status('Unsaved changes');});tr.append($('<td>').append(remove));$('#parcel_carton_rows').append(tr);}
 $(document).on('click','#inv-sub-packaging-tab',function(){if(busy)return;loaded=false;lock(true);status('Loading saved cartons…');PosnicPro.get({url:'settings/group/preferences',data:{}},function(response){lock(false);if(!response||response.type!=='success'){status('Could not load carton settings. Reopen Packaging to retry.');return;}$('#parcel_carton_rows').empty();((response.data&&response.data.values&&response.data.values.parcel_cartons)||[]).forEach(row);loaded=true;status('Loaded. Cartons are optional.');},function(){lock(false);status('Could not load carton settings. Reopen Packaging to retry.');});});
 $(document).on('click','#parcel_carton_add',function(){if(busy||!loaded)return;row({});status('Unsaved changes');});
 $(document).on('click','#parcel_carton_save',function(){if(busy||!loaded)return;var values=[];$('#parcel_carton_rows tr').each(function(){var tr=$(this),value={id:tr.attr('data-carton-id')};tr.find('input').each(function(){value[$(this).attr('data-field')]=$(this).val();});values.push(value);});lock(true);status('Saving cartons…');PosnicPro.put({url:'settings/group/preferences',data:JSON.stringify({parcel_cartons:values})},function(response){lock(false);status(response&&response.type==='success'?'Cartons saved.':response&&response.message||'Could not save cartons.');},function(){lock(false);status('Could not save cartons. Your entries are preserved; try Save again.');});});
})();
