PosnicPro.receivings = {
    addLineReceivingTable: [],
    returnLineReceivingTable: [],
    suggestionParam: [],
    receivingAddAction: false,
    receivingReturnAction: 'add',
    receivingAddId: '',
    receivingId: '',
    receivingStatus: 'Received',
    editPriceAction: 'add',
    receivingsEditParams: [],
    imageParams: [],
    deleteConfirmation: false,
    callbackRegistry: {
        name: '',
        arguments: ''
    },
    form_data: new FormData(),
    showAdd: function () {
        $('.purchase-tittle-change').text(PosnicPro.i18n.t('lang_addvariant_title', 'New'));
//        $('.changeReceivingText').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
        $('.changeReceivingText').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
        PosnicPro.HideSideBarModal();
        $('#receiving_submit').removeAttr('disabled');
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $(".vertical-menu li a").removeClass("active");
        $('#receving_returned_table tbody').html('');
        $('#receiving_return_view_table').html('');
        $('#show-already-return-table').hide();
        if (PosnicPro.receivings.receivingReturnAction === 'return' || PosnicPro.receivings.receivingReturnAction === 'edit') {
            PosnicPro.receivings.clearReceivingForm();
        }
        PosnicPro.receivings.ReceivingFormadd();
        /* Returning from another screen must not hide an unfinished purchase:
           the line map survives navigation, but the table is rebuilt here. */
        if (!PosnicPro.receivings._restockDraft) PosnicPro.receivings.restoreLineItems();
        PosnicPro.receivings.receivingStatus = 'Received';
        PosnicPro.receivings.receivingReturnAction = 'add';
        $('#receiving_expected_wrap').hide();
        $('.page_loader,#osk-container,.hide-add-page').hide();
        $(".popup_closed").css("display", "none");
        $('.page-title-box,#receivings_new,.chat-search,.receving-return-hide').show();
        /*New Receiving*/
        db.recevingAutoFocus.get('1').then(function (data) {
            if (data.addReceiving === true) {
                $('#receiving_add_item_name').focus();
            } else {
                $('#receiving_add_item_name').blur();
            }
        });
        $('#receiving_add_date').addClass('commonDate');
        $('#receiving_add_date').removeClass('commonEditDate');
        PosnicPro.commonDate();
        $('#receiving_image_upload').attr('src', 'static/images/default/receiving.png');
        //$('#receiving_logo').val('receiving.png');
        $('.fileupload-preview').html(PosnicPro.i18n.t('lang_upload_file', 'Upload file'));
        $('.update-button').attr('disabled', 'disabled').removeClass('btn-outline-success');
        PosnicPro.collapseMenuForWorkspace();
        $('#v-pills-purchase-tab,.receiving_new_shortcut').addClass('active');
        $('#v-pills-purchase').addClass('show active');
        $('.vertical-menu li a#view_purchaseorders_page').addClass('active');
        $('.dashboard_img_menu').hide();
        $('#image_sidebar_purchase').show();
        $('#item_upload_receiving_status').val('no');
        $('#show_last_created_receiving').hide();
        var loader = $(".loader-receiving");
        loader.find(".loadingSpinner:first").remove();
        var pickedItem = PosnicPro.palette?.takeItem('receivings/new');
        if (pickedItem) PosnicPro.receivings.addPickedItem(pickedItem.id);
        if (PosnicPro.receivings._restockDraft) PosnicPro.lowstockitems.applyPurchaseDraft();
    },
    /*
     * The purchase form is rebuilt from the DOM. The in-memory line map is
     * what survives navigation (and what the restock "open unfinished
     * purchase" choice relies on), so paint it back when the table is empty.
     */
    restoreLineItems: function () {
        var self = PosnicPro.receivings;
        if ($('#receiving_print tbody tr[id^="receiving_row_"]').length) return;
        var lines = Object.assign({}, PosnicPro.receiving_lineitems || {});
        if (!Object.keys(lines).length) return;
        PosnicPro.receiving_lineitems = [];
        Object.keys(lines).forEach(function (id) {
            var line = lines[id];
            self.addReceivingLineItems({
                item_id: line.item_id,
                item_name: line.item_name,
                company_price: Number(line.item_price) || 0,
                barcode_id: line.barcode_id || '',
                item_quantity: Number(line.item_quantity) || 0,
                item_unit: line.item_unit || 'qty',
                discount_amount: 0,
                discount_percentage: 0,
                supplier: ''
            });
        });
    },
    addPickedItem: function (id) {
        var branch = PosnicPro.local.get('branch_id_set');
        PosnicPro.get({url:'items/getReceivingItemsAjaxList', data:{type:'id', query:id}}, function (response) {
            if (location.hash !== '#/receivings/new' || branch !== PosnicPro.local.get('branch_id_set')) return;
            var item = (response.suggestions || []).find(function (row) { return row.item_id === id; });
            if (item) PosnicPro.receivings.addReceivingLineItems(item);
            else PosnicPro.alert('warning', PosnicPro.i18n.t('lang_item_unavailable_for_purchase', 'Item unavailable for purchase'));
        }, function () { PosnicPro.alert('warning', PosnicPro.i18n.t('lang_item_unavailable_for_purchase', 'Item unavailable for purchase')); });
    },
    showEdit: function (id) {
        $('#receiving_add_date').removeClass('commonDate');
        $('#receiving_add_date').addClass('commonEditDate');
        $('.purchase-tittle-change').text(PosnicPro.i18n.t('lang_action_edit', 'Edit'));
        $('#show-already-return-table').hide();
        $('#v-pills-purchase').addClass('show active');
        $('#item_upload_receiving_status').val('no');
        PosnicPro.receivings.view.showReceivingsEditPage(id);
        var loader = $(".loader-receiving");
        loader.find(".loadingSpinner:first").remove();
    },
    showDelete: function (id) {
        PosnicPro.deleteTableRowData(id, 'receivings');
    },
    showPdf: function (id) {
        PosnicPro.receivings.view.receivingPdf(id);
    },
    showReceived: function (id) {
        PosnicPro.receivings.view.receivedProcess(id);
    },
    showPrint: function (id) {
        PosnicPro.receivings.view.printReceivings(id, 'receiving');
    },
    showReturnPrint: function (id) {
        PosnicPro.receivings.view.returnPrintReceivings(id);
    },
    showDetails: function (id) {
        var loader = $(".loader-view-receiving");
        loader.find(".loadingSpinner:first").remove();
        PosnicPro.showViewModal('receivings');
        PosnicPro.receivings.view.viewReceiving(id);
    },
    showDataTablePage: function () {
        /* Purchase History retired (owner order): purchases has ONE surface.
           Old links, bookmarks and post-action redirects all land there. */
        hasher.setHash('purchaseorders');
    },
    searchItemReceiving: function (id) {
        var matched = false;
        for (var key in PosnicPro.receiving_lineitems) {
            if (PosnicPro.receiving_lineitems.hasOwnProperty(key)) {
                if (PosnicPro.receiving_lineitems[key].item_id === id) {
                    matched = PosnicPro.receiving_lineitems[key];
                }
            }
        }
        return matched;
    },
//ADD LINE ITEM FOR receiving
    /* Loyverse study L2: fill the order from the chosen supplier - every
       item they supply, or only the ones at/below the low-stock range the
       dashboard already uses. Each row rides the normal add-line path, so
       duplicates increment and all the line math stays untouched. */
    autofillFromSupplier: function (lowStockOnly) {
        var supplierId = $('#receiving_add_supplier_id').val();
        if (!supplierId) {
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_choose_a_supplier_first', 'Choose a supplier first'));
            return;
        }
        var range = localStorage.getItem('notificationrange') || 10;
        PosnicPro.get({
            url: 'items/bySupplier',
            data: 'supplier_id=' + encodeURIComponent(supplierId) +
                '&low_stock=' + (lowStockOnly ? 'true' : 'false') +
                '&notificationrange=' + encodeURIComponent(range)
        }, function (response) {
            var rows = (response && response.data) || [];
            if (!rows.length) {
                PosnicPro.alert('info', lowStockOnly
                    ? 'No low-stock items for this supplier'
                    : 'No items linked to this supplier');
                return;
            }
            rows.forEach(function (row) {
                PosnicPro.receivings.addReceivingLineItems(row);
            });
            PosnicPro.alert('success', rows.length + (lowStockOnly ? ' low-stock' : '') + ' item(s) added from the supplier');
        }, function () {
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_load_the_supplier_items', 'Could not load the supplier items'));
        });
    },
    addReceivingLineItems: function (param) {
        $('table#receiving_print tr#cart_content_area').remove();
        $('#receving_tab_list').show();
        $('#receiviing_img_hide').hide();
        let id = param.item_id;
        let item_quantity = (typeof (param.item_quantity) != "undefined" && param.item_quantity !== null) ? param.item_quantity : 1;
        let item = PosnicPro.receivings.searchItemReceiving(id);
        if (item !== false) {
            var prev_item_qunty = $('#addReceivingLineItemQty_' + id).val();
            item_quantity = parseInt(item_quantity) + parseInt(prev_item_qunty);
        }
        let unit_price = Number(param.company_price) || 0;
        let line_total = unit_price * item_quantity;
        /*
         * Unit conversion assist (V3): a "×N box" button when the item
         * declares a purchase unit. The cashier types how many PACKS
         * arrived, taps it once, and the qty becomes base units - the
         * only thing stock has ever counted. Explicit tap, never implicit:
         * a supplier who delivers loose pieces types pieces as always.
         */
        var convFactor = Number(param.conversion_factor) || 0;
        var convUnit = String(param.purchase_unit || '').trim();
        var convBtn = (convFactor > 1 && convUnit)
            ? '<div class="input-group-append">' +
              '<span class="btn btn-warning-rgba" data-toggle="tooltip" title="Convert packs to units: multiplies the quantity by ' + convFactor + '" ' +
              'onclick="PosnicPro.receivings.applyUnitConversion(\'' + id + '\', ' + convFactor + ');">&times;' + convFactor + ' ' + convUnit + '</span>' +
              '</div>'
            : '';
        var addLineItemQty = '<div class="input-group" id="return_input_group_' + id + '">' +
                '<div class="input-group-prepend">' +
                '<span class="btn btn-secondary-rgba receive_qty_check" id = ' + id + '  onclick="PosnicPro.receivings.qtyIncrementDecrease(this.id,0);"><i class="feather icon-minus"></i></span>' +
                '</div>' +
                '<input type="text" minlength="1" maxlength="5" size="3" min="0" max="100000" class="form-control cart-qty font_size14 float rec_sale_inp_val" inputmode="decimal" id="addReceivingLineItemQty_' + id + '" value=' + item_quantity + ' onkeyup="PosnicPro.receivings.addLineReceivingChangeQty(\'' + id + '\');" style="text-align:center;" oninput="this.value = PosnicPro.minmax(this.value, 0, 100000)" onkeypress="PosnicPro.validate(event)" autocomplete="off">' +
                '<div class="input-group-append">' +
                '<span class="btn btn-success-rgba receive_qty_check" id = ' + id + '  onclick="PosnicPro.receivings.qtyIncrementDecrease(this.id,1);"><i class="feather icon-plus"></i></span>' +
                '</div>' +
                convBtn +
                '</div>';
        if (PosnicPro.receivings.receivingReturnAction !== 'return') {
            var remove = '<td id=addReceivingRemoveLineItem_' + id + '>' +
                    '<button type="button" class="btn btn-danger-rgba mb-1" onclick="PosnicPro.receivings.removeLineItemReceiving(\'' + id + '\');"  aria-label="Delete" data-t-aria-label="lang_delete"><i class="feather icon-trash"></i></button>' +
                    '</td>';
            $('#return_hide_text').show();
            $('#return_show_text').hide();
            var checkbox = '';
        } else {
            var remove = '';
            $('#return_show_text').show();
            $('#return_hide_text').hide();
            var checkbox = '<td class="text-center">' +
                    '<input type="checkbox" id=addReceivingCheckedLineItem_' + id + ' onclick="PosnicPro.receivings.checkedItemReceiving(\'' + id + '\');" checked="checked">' +
                    '</td>';
        }

        let item_unit = (typeof (param.item_unit) != "undefined" && param.item_unit !== null) ? param.item_unit : "qty";
        var rowHTMLLine = ' <tr id="receiving_row_' + id + '" class="touch-sales-hover-effect border-top pt-3"> ' +
                '   <span>' + checkbox + ' </span>' +
                '   <td id=addReceivingLineItemName_' + id + ' width="30%" class="font_size14">' + param.item_name + '</td>' +
                '   <td class="text-center add_circle font_size14">' + addLineItemQty + '</td>' +
                '   <td name ="addReceivingLineItemUnit" id="addReceivingLineItemUnit_' + id + '">' + item_unit + '</td>' +
                '   <td id=addReceivingLineItemPrice_' + id + ' class="text-center font_size14">' + unit_price.toFixed(2) + '&nbsp;&nbsp;<span class="receving-return-hide"><i class="feather icon-edit-1 text-success" onclick="return PosnicPro.receivings.editItemCompanyPriceReceiving(this);"  data-id="' + id + '" data-toggle="tooltip" title="Edit item price" data-t-title="lang_edit_item_price" style="cursor:pointer;"></i></span></td>' +
                '   <td id=addReceivingLineItemTotal_' + id + ' class="text-right font_size14">' + line_total.toFixed(2) + '</td>' +
                '   <span>' + remove + ' </span>' +
                '   <td id=addReceivingLineItemId_' + id + ' class="col-md-1" style="display:none;">' + id + '</td>' +
                '   <td id=addReceivingBarcodeId_' + id + ' class="col-md-1"  style="display:none;">' + param.barcode_id + '</td>' +
                '   <td id="addReceivingAvailableQty_' + id + '" style="display:none;">' + param.available_quantity + '</td>' +
                '   <td id=addpurchasePrice_' + id + ' class="text-center" style="display:none;">' + param.company_price + '</td>' +
                '   </tr>';
        if ($('table#receiving_print').find('#receiving_row_' + id).length > 0) {
            $('#receiving_row_' + id).replaceWith(rowHTMLLine);
            $('#receiving_row_' + id).remove();
            $('#receiving_print tbody').prepend(rowHTMLLine);
        } else {
            $('#receiving_print tbody').prepend(rowHTMLLine);
        }
        $('#receiving_row_' + id).addClass('table-highlight-row');
        setTimeout(function () {
            $('#receiving_row_' + id).removeClass('table-highlight-row');
        }, 500);
        (PosnicPro.receivings.receivingReturnAction === 'return') ? $('.receving-return-hide').hide() : $('.receving-return-hide').show();
        $('.update-button').removeAttr('disabled').addClass('btn-outline-success');
        if (PosnicPro.receivings.receivingAddAction === true) {
            PosnicPro.receivings.loadEditReceivingValue();
        }
        PosnicPro.receiving_lineitems[id] = {
            row_id: id,
            item_id: id,
            item_name: param.item_name,
            item_price: unit_price,
            item_quantity: item_quantity,
            item_unit: item_unit,
            available_qnty: param.available_quantity,
            barcode_id: param.itemid
        };
        $('#item_id, #receiving_add_item_name, #barcode_id, #receiving_add_selling_price, #receiving_add_available_stock, #row_id, #receiving_add_line_total').val('');
        PosnicPro.receivings.addReceivingTableRowCalc();
        let hash = window.location.hash.slice(1);
        let receivingAddId = PosnicPro.local.get('receivingAddId');
        if (hash === '/receivings/new') {
            db.recevingAutoFocus.get('1').then(function (data) {
                if (data.addReceiving === true) {
                    $('#receiving_add_item_name').focus();
                } else {
                    $('#receiving_add_item_name').blur();
                }
            });
        }
        if (hash === '/receivings/' + receivingAddId + '/edit') {
            db.recevingAutoFocus.get('1').then(function (data) {
                if (data.editReceiving === true) {
                    $('#receiving_add_item_name').focus();
                } else {
                    $('#receiving_add_item_name').blur();
                }
            });
        }
    },
    // +/- quantity calculations
    qtyIncrementDecrease: function (id, action) {
        var oldValue = parseFloat($('#addReceivingLineItemQty_' + id).val());
        let value;
        var checkValue = (parseFloat(oldValue));


        if (action === 1) {
            if (oldValue != NaN)
            {
                value = (Number.isInteger(checkValue) === false) ? parseFloat(oldValue) + 0.01 : parseFloat(oldValue) + 1;
                value = (Number.isInteger(value) === false) ? value.toFixed(2) : value;
                $('#addReceivingLineItemQty_' + id).val(value);
            }
        } else {
            if (oldValue != NaN)
            {
                if (oldValue > 1) {
                    value = (Number.isInteger(checkValue) === false) ? parseFloat(oldValue) - 0.01 : parseFloat(oldValue) - 1;
                    value = (Number.isInteger(value) === false) ? value.toFixed(2) : value;
                    $('#addReceivingLineItemQty_' + id).val(value);
                }
            }
        }
        PosnicPro.receivings.addLineReceivingChangeQty(id);
    },
    loadEditReceivingValue: function () {
        $("#receiving_add_supplier_id").val(PosnicPro.receivingsEditParams.receiving_supplier_id);
        $("#receiving_add_supplier_name").val(PosnicPro.receivingsEditParams.receiving_supplier_name);
        $("#receiving_add_supplier_phone").val(PosnicPro.receivingsEditParams.receiving_supplier_phone);
        $("#receiving_add_supplier_email").val(PosnicPro.receivingsEditParams.receiving_supplier_email);
        $("#receiving_add_supplier_address").val(PosnicPro.receivingsEditParams.receiving_supplier_address);
        $("#receiving_add_supplier_state").val(PosnicPro.receivingsEditParams.receiving_supplier_state);
        $("#receiving_discount_amount").val(PosnicPro.receivingsEditParams.receiving_discount_amount);
        $("#receiving_add_payment_description").html(PosnicPro.receivingsEditParams.receiving_payment_description);
        $("#receiving_paid_amount").val(PosnicPro.receivingsEditParams.receiving_paid_amount || 0);

        $('#display-preview').html('');
        var image_name = PosnicPro.receivingsEditParams.receiving_image || [];
        if (!$.isArray(image_name)) {
            image_name = image_name ? [image_name] : [];
        }

        image_name.forEach(function (val, key) {
            if (!val) {
                return true; // continue
            }

            var image_path = '';
            if (typeof val === 'string') {
                image_path = val;
            } else if (typeof val === 'object' && val.name) {
                image_path = val.name;
            }

            if (!image_path) {
                return true;
            }

            var extension = image_path.substr((image_path.lastIndexOf('.') + 1)).toLowerCase();
            var title = (typeof val === 'object' && val.name) ? val.name : image_path;

            var parsedUrl;
            try {
                parsedUrl = new URL(image_path, window.location.href);
            } catch (error) {
                return;
            }
            if (!/^(https?:|blob:|file:)$/.test(parsedUrl.protocol)) {
                return;
            }

            var $media;
            if (extension === 'pdf') {
                $media = $('<iframe>')
                    .addClass('img-thumbnail image_style')
                    .attr({ src: parsedUrl.href, frameborder: '0', title: title, 'data-toggle': 'tooltip' })
                    .css('border', 'none');
            } else {
                $media = $('<img>')
                    .addClass('img-thumbnail image_style')
                    .attr({ src: parsedUrl.href, loading: 'lazy', decoding: 'async', title: title, 'data-toggle': 'tooltip' });
            }

            var $wrapper = $('<div>')
                .attr('id', 'selector_' + key)
                .addClass('receiving-image-wrapper image-area')
                .css('position', 'relative');
            var $remove = $('<button type="button">')
                .addClass('remove-image')
                .attr('aria-label', 'Remove image')
                .text('\u00d7')
                .on('click', function () {
                    PosnicPro.receivings.image_edit_remove_selected(key, image_path);
                });
            $wrapper.append($('<span>').append($media), $('<br>'), $remove);
            $('#display-preview').append($wrapper);

            // Keep only the URL for edit submissions; uploads for new images
            // still go through receiving_image_preview -> uploadReceivingImage.
            PosnicPro.receivings.imageParams[key] = {
                name: image_path
            };
        });

        $('.hide-add-page').show();
        /* Restore EVERYTHING the record carries - the old radio block here
           targeted #open/#received, ids that never existed, so editing a
           Received purchase silently saved it back to Open. */
        var ep = PosnicPro.receivingsEditParams;
        /* A partially received document's status belongs to the Receive
           flow, not the edit page: it rides through the save untouched so
           the server keeps what arrived as fact. Every other purchase is
           recorded as Received immediately. */
        PosnicPro.receivings.receivingStatus = ep.receiving_receiving_status === 'Partial' ? 'Partial' : 'Received';
        $('#receiving_expected_wrap').toggle(PosnicPro.receivings.receivingStatus === 'Partial');
        $('#receiving_expected_date').val(ep.receiving_expected_date ? String(ep.receiving_expected_date).slice(0, 10) : '');
        $('#receiving_invoice_total_declared').val(ep.receiving_invoice_total_declared || '');
        $('#receiving_charges_rows').empty();
        (ep.receiving_additional_charges || []).forEach(function (c) {
            PosnicPro.receivings.addChargeRow(c.label, c.amount);
        });
        PosnicPro.receivings.addReceivingTableRowCalc();
    },
    /* ---- Additional charges (freight etc.) - ride on the total ---- */
    addChargeRow: function (label, amount) {
        $('#receiving_charges_rows').append(
            '<div class="form-row charge-row align-items-center mt-2">'
            + '<div class="col-7"><input type="text" class="form-control form-control-sm charge-label" placeholder="Freight" data-t-placeholder="lang_freight" maxlength="40" aria-label="Charge label" data-t-aria-label="lang_charge_label"></div>'
            + '<div class="col-4"><input type="number" step="0.01" min="0" class="form-control form-control-sm text-right charge-amount" placeholder="0.00" aria-label="Charge amount" data-t-aria-label="lang_charge_amount"></div>'
            + '<div class="col-1 text-center"><a href="javascript:void(0)" class="charge-remove text-danger" aria-label="Remove charge" data-t-aria-label="lang_remove_charge"><i class="feather icon-x"></i></a></div>'
            + '</div>');
        var row = $('#receiving_charges_rows .charge-row').last();
        if (label !== undefined) { row.find('.charge-label').val(label); }
        if (amount !== undefined) { row.find('.charge-amount').val(amount); }
        if (label === undefined) { row.find('.charge-label').trigger('focus'); }
    },
    collectCharges: function () {
        return $('#receiving_charges_rows .charge-row').map(function () {
            return {
                label: $.trim($(this).find('.charge-label').val() || ''),
                amount: parseFloat($(this).find('.charge-amount').val()) || 0
            };
        }).get().filter(function (c) { return c.amount > 0 || c.label; });
    },
    chargesTotal: function () {
        return PosnicPro.receivings.collectCharges().reduce(function (sum, c) { return sum + c.amount; }, 0);
    },
    addReceivingTableRowCalc: function () {

        PosnicPro.receivings.addLineReceivingTable = $('#receiving_print tbody tr').map(function () {
            let itemid = $(this).find('[id^="addReceivingLineItemId_"]').text();
            return {
                item_name: $('#addReceivingLineItemName_' + itemid).text(),
                item_price: $('#addReceivingLineItemPrice_' + itemid).text(),
                item_quantity: $('#addReceivingLineItemQty_' + itemid).val(),
                item_unit: $('#addReceivingLineItemUnit_' + itemid).text(),
                item_id: $('#addReceivingLineItemId_' + itemid).text(),
                totalamount: $('#addReceivingLineItemTotal_' + itemid).text()
            };
        }).get();
        var addReceivingLineTotal = 0;
        for (var i = 0; i < PosnicPro.receivings.addLineReceivingTable.length; i++) {
            addReceivingLineTotal += parseFloat(PosnicPro.receivings.addLineReceivingTable[i].totalamount) || 0;
        }
        addReceivingLineTotal = Number(addReceivingLineTotal || 0).toFixed(2);
        if (isNaN('NaN')) {
            $('#receiving_add_subtotal_amount').html('0.00');
            $("#receiving_add_total_amount").text('0.00');
            $("#receiving_total").val('0.00');
        }
        if (addReceivingLineTotal > 0) {
            $('#receiving_add_subtotal_amount').number(addReceivingLineTotal, 2);
            /* Additional charges ride on the grand total - never on item
               cost. The declared-invoice check uses the same base, because
               the supplier's total includes them. */
            var chargesTotal = PosnicPro.receivings.chargesTotal();
            if (chargesTotal > 0) {
                $('#receiving_charges_row').show();
                $('.charges-receiving-value').text(chargesTotal.toFixed(2));
            } else {
                $('#receiving_charges_row').hide();
            }
            var withCharges = parseFloat(addReceivingLineTotal) + chargesTotal;
            var receivegrandTotal = (PosnicPro.roundoff === true) ? Math.round(withCharges).toFixed(2) : Number(withCharges).toFixed(2);
            $("#receiving_add_total_amount").number(receivegrandTotal, 2);
            $("#receiving_total").val(withCharges.toFixed(2));
            $('span.number').number(true, 2);
        }

        PosnicPro.receivings.invoiceTotalCheck();
    },
    /*
     * P2: the declared invoice total against what the lines add up to.
     * A mismatch WARNS - the goods are already in the shop; the badge makes
     * somebody look, the save never refuses (owner's ruling).
     */
    invoiceTotalCheck: function () {
        var declared = parseFloat($('#receiving_invoice_total_declared').val());
        var note = $('#receiving_invoice_total_note');
        if (!declared || isNaN(declared)) { note.text('').attr('class', 'form-text'); return; }
        var computed = parseFloat($('#receiving_total').val()) || 0;
        if (Math.abs(declared - computed) > 0.5) {
            note.text('Does not match the lines (' + computed.toFixed(2) + ') - saved with a warning flag.')
                .attr('class', 'form-text text-warning');
        } else {
            note.text(PosnicPro.i18n.t('lang_matches_the_lines', 'Matches the lines.')).attr('class', 'form-text text-success');
        }
    },
    receivingTextboxQtyChange: function (ItemQty, id) {
        $('#addReceivingLineItemQty_' + id).val(ItemQty);
        var updatePrice = (Number($('#addpurchasePrice_' + id).text()) || 0) * (Number(ItemQty) || 0);
        updatePrice = Number(updatePrice).toFixed(2);
        $('#addReceivingLineItemTotal_' + id).text(updatePrice);
        PosnicPro.receivings.addReceivingTableRowCalc();
    },
    /* One tap: packs typed -> base units counted (V3). Reuses the normal
       qty-change path so the line total recomputes as usual. */
    applyUnitConversion: function (id, factor) {
        var $qty = $('#addReceivingLineItemQty_' + id);
        var current = parseFloat($qty.val());
        if (!current || current <= 0 || !factor || factor <= 1) { return; }
        $qty.val(current * factor);
        PosnicPro.receivings.addLineReceivingChangeQty(id);
    },
    addLineReceivingChangeQty: function (id) {
        var available_quantity = PosnicPro.receiving_lineitems[id].item_quantity;
        var ItemQty = $('#addReceivingLineItemQty_' + id).val();
        if (PosnicPro.receivings.receivingReturnAction === 'return') {
            if (parseInt(available_quantity) < parseInt(ItemQty)) {
                var ItemQty = available_quantity;
                PosnicPro.receivings.receivingTextboxQtyChange(ItemQty, id);
                PosnicPro.receivings.addReceivingTableRowCalc();
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_some_items_are_out_of_stock', 'Some items are out of stock.'));
                return false;
            }
        }
        PosnicPro.receivings.receivingTextboxQtyChange(ItemQty, id);
    },
    /*--------REMOVE LINE ITEMS FOR RECEIVING---------*/
    removeLineItemReceiving: function (id) {
        if (PosnicPro.receivings.deleteConfirmation) {
            $('#receiving_row_' + id).remove();
            $('#receive_out').val('');
            delete PosnicPro.receiving_lineitems[id];
            PosnicPro.receivings.addReceivingTableRowCalc();
            var length = PosnicPro.receivings.addLineReceivingTable.length;
            if (length === 0) {
                PosnicPro.receivings.clearReceivingForm();
                $('.update-button').attr('disabled', 'disabled').removeClass('btn-outline-success');
                $('#clearReceiving').show();
                $('#closeReceiving').show();
            }
            PosnicPro.receivings.deleteConfirmation = false;
        } else {
            PosnicPro.receivings.callbackRegistry = {
                name: 'removeLineItemReceiving',
                arguments: id
            };
            $('#delete_lineitem_modal').modal('show');
            $('#sale_line_item_remove').hide();
            $('#receiving_line_item_remove').show();
        }
    },
    /*delete confirmation*/
    deleteConfirmed: function () {
        $('#delete_lineitem_modal').modal('hide');
        $('#receiving_line_item_remove').hide();
        PosnicPro.receivings.deleteConfirmation = true;
        window['PosnicPro']['receivings']['' + PosnicPro.receivings.callbackRegistry.name](PosnicPro.receivings.callbackRegistry.arguments);
    },
    checkedItemReceiving: function (id) {
        $('#receiving_submit').removeAttr('disabled');
        $('.changeReceivingText').text(PosnicPro.i18n.t('lang_action_return_purchase', 'Return'));
        if ($('#addReceivingCheckedLineItem_' + id).is(":checked")) {
            $('#return_input_group_' + id).css({cursor: 'pointer', 'pointer-events': 'auto'});
            $('#receiving_row_' + id).css({cursor: 'pointer', background: '#ffffff'});
            $('#addReceivingLineItemQty_' + id).prop("disabled", false);
            var available_quantity = PosnicPro.receiving_lineitems[id].item_quantity;
            PosnicPro.receivings.receivingTextboxQtyChange(available_quantity, id);
        } else {
            $('#return_input_group_' + id).css({cursor: 'not-allowed', 'pointer-events': 'none'});
            $('#receiving_row_' + id).css({cursor: 'not-allowed', background: '#eeecec'});
            $('#addReceivingLineItemQty_' + id).prop("disabled", true);
            PosnicPro.receivings.receivingTextboxQtyChange(0, id);
        }
        var $checkboxes = $('#receiving_print tr td input[type="checkbox"]');
        var countCheckedCheckboxes = $checkboxes.filter(':checked').length;
        if (countCheckedCheckboxes === 0) {
            $('#receiving_submit').attr('disabled', 'disabled');
        }
    },
    ReceivingFormadd: function () {

        var length = PosnicPro.receivings.addLineReceivingTable.length;
        if (length === 0) {
            $('#receving_tab_list').hide();
        }
        $('#receive_out').val('');
        $('#receiving_add_item_name').focus();
        $('#clearReceiving').show();
        $('#closeReceiving').hide();
        $('.fileupload-preview').html(PosnicPro.i18n.t('lang_upload_file', 'Upload file'));
        if (!PosnicPro.receivings._restockDraft) (PosnicPro.local.get('default_supplier_enable_disable') === 'false') ? $('#receiving_add_supplier_id,#receiving_add_supplier_name,#receiving_add_supplier_address,#receiving_add_supplier_phone,#receiving_add_supplier_email,#receiving_add_supplier_state').val('') : PosnicPro.defaultSupplierSet();
        PosnicPro.receivings.imageParams = [];
        PosnicPro.receivings.receivingAddAction = false;
        PosnicPro.receivings.receivingId = '';
        PosnicPro.receivings.receivingAddId = '';
    },
    clearReceivingForm: function () {
        PosnicPro.receivings._restockPendingIds = null;
        $('#receiving_print tbody').children("tr").remove();
        $("#receiving_print").find("tr:not(:first)").remove();
        $('#receving_tab_list').hide();
        $('#receive_out').val('');
        $('table#receiving_print tbody').append('<tr class="cart_content_area" id="cart_content_area"><td colspan="7"><div class="text-center text-dark"> <p><lang class="lang_receive_empty">Receiving Order Empty</lang></p></div></td></tr>');
        $('#receiviing_img_hide').show();
        db.recevingAutoFocus.get('1').then(function (data) {
            if (data.addReceiving === true) {
                $('#receiving_add_item_name').focus();
            } else {
                $('#receiving_add_item_name').blur();
            }
        });
        $('#receiving_add_total_amount,#receiving_add_subtotal_amount').text("0");
        $('.discount-receiving-value').text("0.00");
        $('#receiving_add_payment_description').val("");
        $('#clearReceiving').show();
        $('#closeReceiving').hide();
        $('#receiving_discount_amount,#receiving_total').val("0");
        $('#receiving_paid_amount').val("0");
        $('.fileupload-preview').html(PosnicPro.i18n.t('lang_upload_file', 'Upload file'));
        $('#receiving_upload_image').val('');
        PosnicPro.receiving_lineitems = [];
        PosnicPro.receivings.imageParams = [];
        PosnicPro.receivings.receivingAddAction = false;
        PosnicPro.receivings.receivingId = '';
        PosnicPro.receivings.receivingAddId = '';
        $('#display-preview').html('');
    },
    editItemCompanyPriceReceiving: function (index) {
        var id = $(index).data('id');
        $('#addReceivingLineItemPrice_' + id).editable({
            type: 'text',
            pk: 1,
            title: PosnicPro.i18n.t('lang_edit_cost', 'Edit cost'),
            inputclass: 'form-control form-control-sm',
            tpl: '<input size="4"></input>',
            validate: function (value) {
                let regex = /^\s*?((\d+(\.\d+)?)|(\.\d+))\s*$/;
                if (!regex.test(value)) {
                    return 'Enter a valid amount!';
                }
            },
            success: function (k, val) {
                $('#addpurchasePrice_' + id + '').text(val);
                $('#addReceivingLineItemPrice_' + id).replaceWith('<td id=addReceivingLineItemPrice_' + id + ' class="text-center font_size14">' + parseFloat(val).toFixed(2) + '&nbsp;&nbsp;<span class="receving-return-hide"><i class="feather icon-edit-1 text-success" onclick="return PosnicPro.receivings.editItemCompanyPriceReceiving(this);"  data-id="' + id + '" data-toggle="tooltip" title="Edit item price" data-t-title="lang_edit_item_price" style="cursor:pointer;"></i></span></td>');
                PosnicPro.receivings.addLineReceivingChangeQty(id);
                let params = {
                    method: 'PUT',
                    url: 'receivings/companyPriceUpdate',
                    data: JSON.stringify({
                        item_id: id,
                        item_price: val
                    })
                };
                PosnicPro.request(params, function (response) {
                    if (response.type === 'success') {
                        PosnicPro.alert(response.type, response.message);
                    }
                });
            }
        });
    },
    editItemPriceReceiving: function (index) {
        let id = $(index).data('id');
        PosnicPro.get('items/' + id, function (response) {
            var data = response.data;
            $('#items_name').val(data.name);
            $('#items_itemid').val(data.itemid);
            $('#items_barcodeid').val(data.barcode_id);
            $('#items_date').val(response.data.item_date);
            $('#items_supplier').val(data.supplier_name);
            $('#items_category').val(data.category_id).trigger("change");
            $('#items_discount_amount').val(data.discount_amount);
            $('#items_discount_percentage').val(data.discount_percentage);
            $('#items_available_quantity').val(data.available_quantity);
            var url = window.location.hash.slice(1);
            if (url === '/receivings/new') {
                PosnicPro.receivings.editPriceAction = 'add';
            } else {
                PosnicPro.receivings.editPriceAction = 'edit';
            }
            if (data.available_quantity > 0) {
                $('#item_title_data').text(PosnicPro.i18n.t('lang_nav_add', 'Add'));
                $('#item_button_title').text(PosnicPro.i18n.t('lang_save_title', 'Save'));
                $('#items_edit_reset,.items_edit_reset').hide();
                $('#items_reset').show();
                $('#itemid').val('');
                $('#items_company_price').val('0');
                $('#items_mrp_price').val('0');
                $('#items_selling_price').val('0');
                PosnicPro.alert('info', 'This item is already in stock and was added as a new line. Enter its price details.', '10000');
                hasher.changed.active = false; //disable changed signal
                hasher.replaceHash('receivings/items/new');
                hasher.changed.active = true; //enable changed signal
            } else {
                $('#items_mrp_price').val(data.mrp_price);
                $('#items_company_price').val(data.company_price);
                $('#items_selling_price').val(data.selling_price);
                $('#item_title_data').text(PosnicPro.i18n.t('lang_edit_title', 'Edit'));
                $('#item_button_title').text(PosnicPro.i18n.t('lang_refresh_title', 'Update'));
                $('#items_edit_reset,.items_edit_reset').show();
                $('#items_reset').hide();
                $('#itemid').val(id);
                hasher.changed.active = false; //disable changed signal
                hasher.setHash('receivings/' + id + '/price');
                hasher.changed.active = true; //enable changed signal
            }
            $('#item_upload_image_status').val('no');
            $('#item-display-preview').html('');
            $.each(data.multi_image, function (key, val) {
                var image_path = val.name;
                var convertFunction = PosnicPro.convertFileToDataURLviaFileReader;
                convertFunction(image_path, function (base64Img) {
                    var strImage = base64Img.replace(/^data:image\/[a-z]+;base64,/, "");
                    PosnicPro.items.imageParams[key] = {
                        name: val.name,
                        data: strImage,
                        size: base64Img.length,
                        cover: val.cover
                    };
                });
                $('#item-display-preview').append(
                        '<div id="selector_' + key + '" class="receiving-image-wrapper image-area" style="position: relative;"> \
                        <img loading="lazy" decoding="async" class="image_style" class="img-thumbnail" src="' + image_path + '" \
                        title="' + escape(val.name) + '" /><br /> \
                    <span id="coverimage_selector_' + key + '" class="coverImageAdd" style="display: block;border: 1px solid #ddd;border-radius: 5px;margin-top: 2px; background: #506fe4; color: #fff" onclick="PosnicPro.items.coverImageEdit(this.id,\'' + key + '\',\'' + val.name + '\',\'' + val.size + '\')">Choose Cover</span><a class="remove-image" style="cursor:pointer;display: inline;position: absolute; top: -10px; right: -10px; border-radius: 10em; padding: 2px 6px 3px; text-decoration: none; font: 700 21px/20px sans-serif; background: #f48787; border: 3px solid #fff; color: #FFF; box-shadow: 0 2px 6px rgba(0,0,0,0.5), inset 0 2px 4px rgba(0,0,0,0.3); text-shadow: 0 1px 2px rgba(0,0,0,0.5); -webkit-transition: background 0.5s; transition: background 0.5s;" onclick="PosnicPro.items.image_edit_remove_selected(\'' + key + '\',\'' + val.name + '\')">&#215;</a> \
                        </div>');
                if (val.cover === "yes") {
                    $('#item_logo').val(val.name);
                    $('#coverimage_selector_' + key).html('');
                    var styles = {
                        display: 'block',
                        border: '1px solid #ddd',
                        'border-radius': '5px',
                        'margin-top': '2px',
                        background: 'green',
                        color: '#fff'
                    };
                    $('#coverimage_selector_' + key).css(styles).append('Cover');
                }

            });
            var branchOption = [];
            $.each(data.branch_access, function (key, val) {
                branchOption.push(val.branch_id.$oid);
                $('#item_branch').select2('val', [branchOption]);
            });
            var radionbutton = $('#items_discount_amount').val();
            if (radionbutton > 0) {
                $("#item_radio_discount_amount").prop('checked', 'checked');
                $('#items_discount_percentage').attr('disabled', 'disabled').addClass('bg-white').hide();
                $('#items_discount_amount').removeAttr('disabled', 'disabled').show();
            } else {
                $("#item_radio_discount_percentage").prop('checked', 'checked');
                $('#items_discount_amount').attr('disabled', 'disabled').addClass('bg-white').hide();
                $('#items_discount_percentage').removeAttr('disabled', 'disabled').show();
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
        $('.page_loader,#osk-container').hide();
        $('.page-title-box,#items_new,#item_variant_header').show();
        $('#show_variant_fields').hide();
        $('#show_price_fields').show();
        $('#category_check').val("yes");
        $('#supplier_check').val("yes");
    },
    /*adding new item like purchase new items adding held by this function*/
    addReceivings: function () {
        if (PosnicPro.receivings.receivingAddAction === true) {
            PosnicPro.receivings.editReceivings();
            return false;
        }
        var supplier_name = $("#receiving_add_supplier_name").val();
        if ($('#receiving_print tbody tr').find('[id^="addReceivingLineItemId_"]').text() === '' || supplier_name === '') {
            if (supplier_name === '') {
                $("#receiving_add_supplier_name").focus();
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_supplier_name', 'Enter a supplier name.'));
                return false;
            }
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_add_at_least_one_item', 'Add at least one item.'));
            $('#receiving_add_item_name').focus();
            return false;
        } else {
            var loader = $(".loader-receiving");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.receivings.addLineReceivingTable = $('#receiving_print tbody tr').map(function () {
                let itemid = $(this).find('[id^="addReceivingLineItemId_"]').text();
                //Added Item Unit
                return {
                    item_id: $('#addReceivingLineItemId_' + itemid).text(),
                    item_name: $('#addReceivingLineItemName_' + itemid).text(),
                    item_quantity: $('#addReceivingLineItemQty_' + itemid).val(),
                    item_unit: $('#addReceivingLineItemUnit_' + itemid).text(),
                    total_amount: $('#addReceivingLineItemTotal_' + itemid).text()
                };
            }).get();
            var params = {
                url: 'receivings',
                data: JSON.stringify({
                    date: $('#receiving_add_date').val(),
                    supplier_id: $('#receiving_add_supplier_id').val(),
                    supplier_name: $('#receiving_add_supplier_name').val(),
                    supplier_address: $('#receiving_add_supplier_address').val(),
                    supplier_phone: $('#receiving_add_supplier_phone').val(),
                    supplier_email: $('#receiving_add_supplier_email').val(),
                    supplier_state: $('#receiving_add_supplier_state').val(),
                    status: PosnicPro.receivings.receivingStatus || 'Received',
                    discount: $('.discount-receiving-value').text(),
                    payment_description: $('#receiving_add_payment_description').val(),
                    paid_amount: $('#receiving_paid_amount').val(),
                    print: ($('.autoprint').is(':checked', true)) ? 'on' : 'off',
                    items: PosnicPro.receivings.addLineReceivingTable,
                    id: PosnicPro.receivings.receivingAddId,
                    image: PosnicPro.receivings.imageParams,
                    expected_date: $('#receiving_expected_date').val(),
                    invoice_total_declared: $('#receiving_invoice_total_declared').val() || null,
                    additional_charges: PosnicPro.receivings.collectCharges()
                })
            };
            PosnicPro.post(params, function (response) {
                if (response.type === 'success') {
                    /* Only now is the restock basket satisfied. Items the
                       shopkeeper removed from the purchase stay in it. */
                    var savedRestockIds = (PosnicPro.receivings._restockPendingIds || []).filter(function (id) {
                        return (PosnicPro.receivings.addLineReceivingTable || []).some(function (line) {
                            return String(line.item_id) === String(id);
                        });
                    });
                    if (savedRestockIds.length && PosnicPro.lowstockitems && typeof PosnicPro.lowstockitems.completePurchaseRestock === 'function') {
                        PosnicPro.lowstockitems.completePurchaseRestock(savedRestockIds);
                    }
                    PosnicPro.receivings.clearReceivingForm();
                    PosnicPro.commonDate();
                    if (response.data.print === true) {
                        PosnicPro.receivings.view.printReceivings(response.data.receiving_id, 'receiving');
                    }
                    $('#show_last_created_receiving').show();
                    var path = '#/receivings/' + response.data.receiving_id;
                    $('#last_created_receiving').attr('href', path);
                    PosnicPro.alert(response.type, response.message);
                    /*call for updating lowstock report in dashboard navbar dropdown area*/
                    PosnicPro.stocklogs.viewLowStockDashboard();
                    $('#receiving_print tbody').children("tr").remove();
                    $("#receiving_print").find("tr:not(:first)").remove();
//                    $('#receiving_add_item_name').focus();
                    PosnicPro.receiving_lineitems = [];
                    $('#receiving_add_total_amount').text("0");
                    $('#receiving_total').val("0");
                    $('.update-button').attr('disabled', 'disabled').removeClass('btn-outline-success');
                    $('#item_upload_receiving_status').val('no');
                    PosnicPro.receivings.imageParams = [];
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
                $('table#receiving_print tbody').append('<tr class="cart_content_area" id="cart_content_area"><td colspan="7"><div class="text-center text-dark"> <p><lang class="lang_receive_empty">Receiving Order Empty</lang></p></div></td></tr>');
                $('#receiviing_img_hide').show();
                loader.find(".loadingSpinner:first").remove();
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
            return false;
        }
    },
    /*Edit the receving items fetching data from the database to display edit page*/
    loadEditReceivings: function (id) {
        var loader = $(".loader-edit-receiving");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        $('#receiving_print tbody').children("tr").remove();
        $('#receving_tab_list').hide();
        $("#receiving_print").find("tr:not(:first)").remove();
        PosnicPro.receiving_lineitems = [];
        PosnicPro.receivings.receivingAddAction = false;
        PosnicPro.receivings.receivingId = '';
        PosnicPro.receivings.receivingAddId = '';
        PosnicPro.get('receivings/' + id, function (response) {
            loader.find(".loadingSpinner:first").remove();
            var result = response.data;
            var receivingItems = result.items;
            PosnicPro.commonEditDate(result.date);
            var itemDetails = [];
            if (response.type === 'success') {
                PosnicPro.receivings.receivingAddAction = true;
                PosnicPro.receivings.receivingAddId = id;
                PosnicPro.local.set('receivingAddId', id);
                PosnicPro.receivings.receivingId = result.receiving_id;
                PosnicPro.receivingsEditParams = {
                    receiving_supplier_id: result.supplier_id,
                    receiving_supplier_name: result.supplier_name,
                    receiving_supplier_phone: result.supplier_phone,
                    receiving_supplier_email: result.supplier_email,
                    receiving_supplier_address: result.supplier_address,
                    receiving_supplier_state: result.supplier_state,
                    receiving_discount_amount: result.discount,
                    receiving_paid_amount: result.paid_amount || 0,
                    //receiving_discount_percentage: result.discount_percentage,
                    receiving_payment_description: result.payment_description,
                    receiving_receiving_status: result.receiving_status,
                    receiving_expected_date: result.expected_date,
                    receiving_invoice_total_declared: result.invoice_total_declared,
                    receiving_additional_charges: result.additional_charges,
                    receiving_image: result.image
                };
                $.each(receivingItems, function (key, val) {
                    itemDetails = {
                        "item_id": val.item_id,
                        "item_name": val.item_name,
                        "company_price": val.item_price,
                        "barcode_id": val.barcode_id,
                        "item_quantity": val.item_quantity,
                        "item_unit": val.item_unit,
                        "available_quantity": val.item_available_quantity,
                        "discount_amount": val.item_discount,
                        "discount_percentage": val.item_discount_percentage,
                        "supplier": val.item_supplier
                    };
                    PosnicPro.receivings.addReceivingLineItems(itemDetails);
                });
                if (PosnicPro.receivings.receivingReturnAction === 'return') {
                    $('#receiving_return_view_table').html('');
                    $('#receiving_return_view_list').remove();
                    $('#receiving_return_view_table').append('<div id="receiving_return_view_list">');
                    (result.items_return.length !== 0) ? $('#show-already-return-table').show() : $('#show-already-return-table').hide();
                    var app = "<div><div class='table-responsive'><table class='table' style='background:#f3f5fd;'>";
                    var currency = PosnicPro.local.get('currencySign');
                    for (var i = 0; i < result.items_return.length; i++) {
                        var date = result.items_return[i].returnArray['returnDate'];
                        var timeStamp_value = parseInt(date.$date.$numberLong);
                        var timeZone = PosnicPro.timeZone();
                        var DateFormat = moment(timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
                        var updateDate = PosnicPro.convertDate(DateFormat);
                        var head = '<thead><tr><td colspan="7"></td></tr><tr style="background:#e1e6f5;">' +
                                '<td>' + (i + 1) + '</td><td colspan="3"><span class="text-danger">' + result.items_return[i].returnArray['returnId'] + '</span></td><td colspan="3"><span class="text-danger">' + updateDate + '</span></td></tr>' +
                                '<tr><th class="text-left"><lang class="lang_name_title">Name </lang></th>' +
                                '<th class="text-center"><lang class="lang_qty_title">Quantity</lang></th>' +
                                '<th class="text-center"><lang class="lang_unit_title">Unit </lang></th>' +
                                '<th class="text-right"><lang class="lang_cost_title">Cost </lang></th>' +
                                '<th class="text-right"><lang class="lang_total_title">Total </lang></th>' +
                                '</tr></thead>';
                        app = app + '' + head + '';
                        var total = 0;
                        var priceValue = 0;
                        $.each(result.items_return[i].returnArray['returnValue'], function (key, val) {
                            let itemUnit = (typeof (val.item_unit) !== "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                            total += val.total_amount;
                            priceValue += val.item_price * val.item_quantity;
                            var price = val.item_price;
                            if ((price).toFixed(2) > 0.00) {
                                var body = '<tbody><tr>' +
                                        '    <td  class="text-left" width="30%">' + val.item_name + '</td>' +
                                        '    <td class="text-center">' + val.item_quantity + '</td>' +
                                        '    <td class="text-center">' + itemUnit + '</td>' +
                                        '    <td class="text-right">' + currency + '&nbsp;<span class="number">' + price + '</span></td>' +
                                        '    <td class="text-right">' + currency + '&nbsp;<span class="number">' + val.total_amount + '</span></td>' +
                                        '</tr></tbody>';
                            }
                            app = app + '' + body + '';
                        });
                        var foot = '<tbody><tr>' +
                                '<td colspan="4"><span class="pull-right"><b><lang class="lang_sub_total">Sub Total</lang></b></span></td><td colspan="2"><span class="pull-right"><b>' + currency + '&nbsp;' + priceValue.toFixed(2) + '</b></span></td></tr>' +
                                '<tr><td colspan="4"><span class="pull-right"><b><lang class="lang_grand_total">Grand Total</lang></b></span></td><td colspan="2"><span class="pull-right"><b>' + currency + '&nbsp;' + total.toFixed(2) + '</b></span></td>' +
                                '</tr><tr><td colspan="6"></td></tr></tbody>';
                        app = app + '' + foot + '';
                    }
                    app = app + '</table></div></div>';
                    $('#receiving_return_view_list').append(app);
                    $('span.number').number(true, 2);
                }
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    /*---------update the View receiving Details --------*/
    editReceivings: function () {
        var supplier_name = $("#receiving_add_supplier_name").val();
        if ($('#receiving_print tbody tr').find('[id^="addReceivingLineItemId_"]').text() === '' || supplier_name === '') {
            if (supplier_name === '') {
                $("#receiving_add_supplier_name").focus();
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_enter_a_supplier_name', 'Enter a supplier name.'));
                return false;
            }
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_add_at_least_one_item', 'Add at least one item.'));
            $('#receiving_add_item_name').focus();
            return false;
        } else {
            var loader = $(".loader-receiving");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.receivings.addLineReceivingTable = $('#receiving_print tbody tr').map(function () {
                let itemid = $(this).find('[id^="addReceivingLineItemId_"]').text();
                return {
                    item_name: $('#addReceivingLineItemName_' + itemid).text(),
                    item_price: $('#addReceivingLineItemPrice_' + itemid).text(),
                    item_quantity: $('#addReceivingLineItemQty_' + itemid).val(),
                    item_unit: $('#addReceivingLineItemUnit_' + itemid).text(),
                    item_id: $('#addReceivingLineItemId_' + itemid).text(),
                    total_amount: $('#addReceivingLineItemTotal_' + itemid).text()
                };
            }).get();
            //return data table
            if (PosnicPro.receivings.receivingReturnAction === 'return') {
                PosnicPro.receivings.returnLineReceivingTable = $('#receiving_print tbody tr').map(function () {
                    let itemid = $(this).find('[id^="addReceivingLineItemId_"]').text();
                    if ($('#addReceivingCheckedLineItem_' + itemid).is(":checked")) {
                        var available_quantity = PosnicPro.receiving_lineitems[itemid].item_quantity;
                        var qty = $('#addReceivingLineItemQty_' + itemid).val();
                        var available_qty = (parseFloat(available_quantity)) - (parseFloat(qty));
                        var updateLineItemTotal = (Number($('#addpurchasePrice_' + itemid).text()) || 0) * (Number(available_qty) || 0);

                        return {
                            item_name: $('#addReceivingLineItemName_' + itemid).text(),
                            item_price: $('#addReceivingLineItemPrice_' + itemid).text(),
                            item_unit: $('#addReceivingLineItemUnit_' + itemid).text(),
                            item_quantity: available_qty,
                            return_quantity: qty,
                            item_id: $('#addReceivingLineItemId_' + itemid).text(),
                            total_amount: updateLineItemTotal,
                            return_total_amount: $('#addReceivingLineItemTotal_' + itemid).text()
                        };
                    }
                }).get();
            }

            var data = {
                date: $('#receiving_add_date').val(),
                receiving_total: $('#receiving_total').val(),
                supplier_id: $('#receiving_add_supplier_id').val(),
                supplier_name: $('#receiving_add_supplier_name').val(),
                supplier_address: $('#receiving_add_supplier_address').val(),
                supplier_phone: $('#receiving_add_supplier_phone').val(),
                supplier_email: $('#receiving_add_supplier_email').val(),
                supplier_state: $('#receiving_add_supplier_state').val(),
                status: PosnicPro.receivings.receivingStatus || 'Received',
                payment_description: $('#receiving_add_payment_description').val(),
                paid_amount: $('#receiving_paid_amount').val(),
                discount: $('.discount-receiving-value').text(),
                print: $('#receiving_print').val(),
                items: PosnicPro.receivings.addLineReceivingTable,
                items_return: PosnicPro.receivings.returnLineReceivingTable,
                id: PosnicPro.receivings.receivingAddId,
                alternative_id: PosnicPro.receivings.receivingId,
                image: PosnicPro.receivings.imageParams,
                expected_date: $('#receiving_expected_date').val(),
                    invoice_total_declared: $('#receiving_invoice_total_declared').val() || null,
                    additional_charges: PosnicPro.receivings.collectCharges()
            };
            if (PosnicPro.receivings.receivingReturnAction === 'return') {
                var $checkboxes = $('#receiving_print tr td input[type="checkbox"]');
                var countCheckedCheckboxes = $checkboxes.filter(':checked').length;
                if (countCheckedCheckboxes === 0) {
                    var data = {};
                }
            }
            var params = {
                url: PosnicPro.receivings.receivingReturnAction === 'return' ? 'receivings/' + PosnicPro.receivings.receivingReturnAction + 'Receiving' : 'receivings/' + PosnicPro.receivings.receivingAddId,
                data: JSON.stringify(data)
            };
            PosnicPro.put(params, function (response) {
                if (response.type === 'success') {
                    PosnicPro.alert(response.type, response.message);
                    if (PosnicPro.receivings.receivingReturnAction === 'return') {
                        $('#receving_returned_table tbody').html('');
                        $('#receiving_print tbody').html('');
                        if (response.data.print === true) {
                            PosnicPro.receivings.view.returnPrintReceivings(response.data.receiving_id);
                        }
                        loader.find(".loadingSpinner:first").remove();
                        hasher.setHash('purchaseorders');
                        return false;
                    }
                    PosnicPro.stocklogs.viewLowStockDashboard();
                    loader.find(".loadingSpinner:first").remove();
                    hasher.setHash('purchaseorders');
//                    $('#receiving_add_item_name').focus();
                } else {
                    loader.find(".loadingSpinner:first").remove();
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                if (PosnicPro.receivings.receivingReturnAction === 'return') {
                    $.each(response.data, function (key, val) {
                        let row = "receiving_row_" + val.item_id;
                        $("#" + row + '').removeAttr("style");
                        $("#" + row + '').addClass('table-highlight-row');
                        let rowInput = "addReceivingLineItemQty_" + val.item_id;
                        $("#" + rowInput + '').val(val.item_quantity);
                        setTimeout(function () {
                            $("#" + row + '').removeClass('table-highlight-row');
                        }, 500);
                    });
                }
                PosnicPro.alert(response.type, response.message);
                loader.find(".loadingSpinner:first").remove();
            });
            return false;
        }
    },
    resetReceivingsForm: function () {
        $('#receiving_add_item_name').val('');
        $('#receiving_discount_amount').val(PosnicPro.local.get('setting-discount-amount'));
        $("#receiving_add_payment_description").val('');
        PosnicPro.receivings.receivingStatus = 'Received';
        $('#receiving_expected_wrap').hide();
        $('#receiving_charges_rows').empty();
        $('#receiving_charges_row').hide();
        $('#display-preview').html('');
        $('#receiving_discount_amount,#receiving_total').val("0");
        $('#receiving_paid_amount').val("0");
        $('#receiving_add_total_amount,#receiving_add_subtotal_amount,.discount-receiving-value').text("0.00");
        $('#receiving_upload_image').val('');
        $('#receiving_print tbody').children("tr").remove();
        $('#receving_tab_list').hide();
        $("#receiving_print").find("tr:not(:first)").remove();
        $('#row_id,#receiving_add_supplier_address,#receiving_add_supplier_phone,#receiving_add_supplier_email,#receiving_add_payment_description').val('');
        $('table#receiving_print tbody').append('<tr class="cart_content_area" id="cart_content_area"><td colspan="7"><div class="text-center text-dark"> <p><lang class="lang_receive_empty">Receiving Order Empty</lang></p></div></td></tr>');
        $('#receiviing_img_hide').show();
        (PosnicPro.local.get('default_supplier_enable_disable') === 'false') ? $('#receiving_add_supplier_id,#receiving_add_supplier_name,#receiving_add_supplier_address,#receiving_add_supplier_phone,#receiving_add_supplier_email,#receiving_add_supplier_state').val('') : PosnicPro.defaultSupplierSet();
        PosnicPro.receiving_lineitems = [];
        PosnicPro.alert('success', PosnicPro.i18n.t('lang_receiving_cancelled', 'Receiving cancelled.'));
        $('#reset_modal').modal('hide');
    },
    receivingImageFormSubmit: function () {
        if ($('#receiving_print tbody tr').find('[id^="addReceivingLineItemId_"]').text() !== '' && $('#receiving_add_supplier_name').val() !== '') {
            if ($('#item_upload_receiving_status').val() === 'no') {
                PosnicPro.receivings.addReceivings();
            } else {
                var loader = $(".loader-receiving");
                $("<div class='loadingSpinner'></div>").appendTo(loader);
                let uniqueImageParams = PosnicPro.receivings.imageParams.filter((c, index) => {
                    return PosnicPro.receivings.imageParams.indexOf(c) === index;
                });
                var params = {
                    url: 'receivings/uploadReceivingImage',
                    data: JSON.stringify({
                        "receiving_image": uniqueImageParams
                    })
                };
                PosnicPro.post(params, function (response) {
                    PosnicPro.receivings.imageParams = [];
                    $.each(response.data, function (key, val) {
                        PosnicPro.receivings.imageParams[key] = {
                            name: val.name
                        };
                        $('#display-preview').html('');
                    });
                    PosnicPro.receivings.addReceivings();
                    loader.find(".loadingSpinner:first").remove();
                }, function (xhr) {
                    var response = jQuery.parseJSON(xhr.responseText);
                    PosnicPro.alert(response.type, response.message);
                });
            }
        } else {
            $('#receiving_add_item_name').focus();
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_add_product', 'Add product'));
        }
        return false;
    },
    receiving_image_preview: function () {

        var len_files = $("#receiving_upload_image").prop("files").length;
        for (var i = 0; i < len_files; i++) {
            var file_data = $("#receiving_upload_image").prop("files")[i];
            PosnicPro.receivings.form_data.append(file_data.name, file_data);
            reader = new FileReader();
            reader.fileName = file_data.name;
            reader.fileSize = file_data.size;
            reader.onload = function (e) {
                var count = $('#display-preview').find('div').length;
                var validExtensions = ['gif', 'GIF', 'jpg', 'JPG', 'png', 'PNG', 'jpeg', 'JPEG', 'bmp', 'BMP', 'pdf', 'PDF'];
                var fileName = e.target.fileName;
                var fileNameExt = fileName.substr(fileName.lastIndexOf('.') + 1);
                if ($.inArray(fileNameExt, validExtensions) === -1) {
                    this.type = '';
                    this.type = 'file';
                    PosnicPro.alert('error', "Only these file types are accepted : " + validExtensions.join(', '));
                    return false;
                }
                //Checking FileSize greater then 5 mb
                let fileSize = e.target.fileSize;
                let imageSizeArr = 0;
                let imageArr = document.getElementById('receiving_upload_image');
                let fileNameArray = [];
                let imageToBig = false;
                for (let i = 0; i < imageArr.files.length; i++) {
                    let imageSize = imageArr.files[i].size;
                    let imageName = imageArr.files[i].name;
                    if (imageSize > 5242880) {
                        imageSizeArr = 1;
                    }
                    if (imageSizeArr == 1) {
                        fileNameArray.push(imageName);
                        imageToBig = true;
                    }
                }
                if (imageToBig) {
                    //give an alert that at least one image is to big
                    PosnicPro.alert('error', fileNameArray + "Size should be less than 5MB !");
                    return false;
                }

                if ($('#display-preview').find('div').length > 5) {
                    PosnicPro.alert('error', PosnicPro.i18n.t('lang_maximum_6_files_are_allowed', 'Maximum 6 files are allowed'));
                    return false;
                }

                var fileImage = e.target.result.substr(e.target.result.indexOf(',') + 1);
                PosnicPro.receivings.imageParams[count] = {
                    name: fileName,
                    size: fileSize,
                    data: fileImage
                };
                $('#item_upload_receiving_status').val('yes');
                $('#display-preview').append(
                        '<div id="selector_' + count + '" class="receiving-image-wrapper image-area" style="position: relative;"> \
                        <iframe class="image_style" src="' + e.target.result + '" \
                        data-toggle="tooltip" title="' + escape(fileName) + '" /></iframe><br /> \
                            <a class="remove-image" style="cursor:pointer;display: inline;position: absolute; top: -10px; right: -10px; border-radius: 10em; padding: 2px 6px 3px; text-decoration: none; font: 700 21px/20px sans-serif; background: #f48787; border: 3px solid #fff; color: #FFF; box-shadow: 0 2px 6px rgba(0,0,0,0.5), inset 0 2px 4px rgba(0,0,0,0.3); text-shadow: 0 1px 2px rgba(0,0,0,0.5); -webkit-transition: background 0.5s; transition: background 0.5s;" onclick="PosnicPro.receivings.image_remove_selected(\'' + count + '\',\'' + fileName + '\')">&#215;</a> \
                        </div>');
            };
            reader.readAsDataURL(file_data);
        }
    },
    image_remove_selected: function (id, name) {

        var removeIndex = PosnicPro.receivings.imageParams.map(function (item) {
            return item.name;
        }).indexOf(name);
        PosnicPro.receivings.imageParams.splice(removeIndex, 1);
        $('#selector_' + id).remove();
        if (PosnicPro.receivings.imageParams.length === 0) {
            $('#item_upload_receiving_status').val('no');
        }
    },
    image_edit_remove_selected: function (id, name) {

        var removeIndex = PosnicPro.receivings.imageParams.map(function (item) {
            return item.name;
        }).indexOf(name);
        PosnicPro.receivings.imageParams.splice(removeIndex, 1);
        $('#selector_' + id).remove();
        if (PosnicPro.receivings.imageParams.length === 0) {
            $('#item_upload_receiving_status').val('no');
        }
    }

};
$(function () {
    // One-time init like the sale search: never rebuild per keystroke.
    /*
     * OWNER STANDING RULE (2026-08-27): every master picker shows something
     * the moment it is focused - frequently-used first (the recent_* lists
     * the sale screen feeds), the latest 10 as the fallback, and typeahead
     * narrows from there. Never an empty box waiting for typing.
     */
    PosnicPro.receivings.supplierLookup = function (inputSel) {
        return function (query, done) {
            var q = String(query || '').trim();
            if (q) {
                var suggestions = [];
                PosnicPro.get({
                    url: 'suppliers/getSuppliersAjaxList',
                    data: 'query=' + encodeURIComponent(q) + '&branch=' + PosnicPro.local.get("branch_id_set")
                }, function (response) {
                    if (response.suggestions && response.suggestions.length > 0) {
                        $.map(response.suggestions, function (dataItem) {
                            suggestions.push({ value: dataItem.name, data: dataItem });
                        });
                    } else {
                        suggestions.push({ value: $(inputSel).val() + ' ', data: -1 });
                    }
                    done({ suggestions: suggestions });
                });
                return;
            }
            /*
             * Empty query = the on-focus list (owner's picker rule + the
             * star idea): default first (tagged), then starred favourites,
             * then recents, then the latest from the server to fill ten.
             */
            var seen = {};
            var out = [];
            var push = function (row, flags) {
                if (!row || !row.id || seen[row.id] || out.length >= 10) { return; }
                seen[row.id] = true;
                out.push({ value: row.name, data: $.extend({}, row, flags || {}) });
            };
            var readList = function (key) {
                try { return JSON.parse(PosnicPro.local.get(key) || '[]') || []; } catch (e) { return []; }
            };
            /* Favourites were PUSHED BACK (owner, 2026-08-27): recency
               self-maintains, stars rot. Default, then recents, then the
               latest from the server. */
            var def = $(inputSel).data('prefilled-default');
            if (def && def.id) {
                push({ id: def.id, name: def.name, phone: def.phone || '' }, { isDefault: true });
            }
            readList('recent_suppliers').forEach(function (r) { push(r); });
            PosnicPro.get({
                url: 'suppliers/getSuppliersAjaxList',
                data: 'query=&branch=' + PosnicPro.local.get("branch_id_set")
            }, function (response) {
                /* The on-focus list may resolve AFTER focus has moved on -
                   page entry focuses the field for a beat before the item
                   box takes over, and rendering then leaves an orphaned
                   dropdown floating over the form. Only speak while the
                   field is still listening. */
                if (!$(inputSel).is(':focus')) { done({ suggestions: [] }); return; }
                (response.suggestions || []).forEach(function (d) {
                    push({ id: d.id, name: d.name, phone: d.phone, address: d.address, email: d.email,
                        state: d.state });
                });
                done({ suggestions: out });
            }, function () {
                done({ suggestions: $(inputSel).is(':focus') ? out : [] });
            });
        };
    };
    /* Star rendering for the on-focus list; typed searches stay plain. */
    PosnicPro.receivings.supplierFormatResult = function (suggestion, currentValue) {
        var esc = function (t) { return $('<i/>').text(t == null ? '' : t).html(); };
        var d = suggestion.data || {};
        if (d === -1 || !d.id) {
            return '<div>' + $.Autocomplete.formatResult(suggestion, currentValue) +
                '</div><span class="pull-right" style="margin-top:-20px;">( Add new )</span>';
        }
        /* Favourites are made on the supplier LIST page, not here - the
           dropdown stays a picker (standard §7). They still lead the
           on-focus ordering. Phone keeps its long-standing place. */
        var tag = d.isDefault ? ' <span class="text-muted" style="font-size:11px;">(default)</span>' : '';
        var sub = d.phone ? ' <span class="text-muted" style="font-size:11px;">' + esc(d.phone) + '</span>' : '';
        return esc(suggestion.value) + tag + sub;
    };
    $('#receiving_add_supplier_name').autocomplete({
        deferRequestBy: 120,
            minChars: 0,
            formatResult: PosnicPro.receivings.supplierFormatResult,
            lookup: PosnicPro.receivings.supplierLookup('#receiving_add_supplier_name'),
            onSelect: function (suggestion) {
                if (suggestion.data !== -1) {
                    $(".clear-supplier-error").find('.error').text("").removeClass('error');
                    $('#receiving_add_supplier_id').val(suggestion.data.id);
                    $('#receiving_add_supplier_address').val(suggestion.data.address);
                    $('#receiving_add_supplier_phone').val(suggestion.data.phone);
                    $('#receiving_add_supplier_email').val(suggestion.data.email);
                    $('#receiving_add_supplier_state').val(suggestion.data.state);
                    /* Recency, the same way the sale screen records customers
                       and items. The shared filter bar offers a supplier picker
                       (core/list-filter.js, LF.ENTITIES.supplier) that reads
                       this list - without it that picker opens empty on every
                       till and looks broken. Written where the choice is made,
                       so every path that picks a supplier feeds it. */
                    if (PosnicPro.sales && PosnicPro.sales._recentPush) {
                        PosnicPro.sales._recentPush('recent_suppliers', {
                            id: suggestion.data.id,
                            name: suggestion.value || suggestion.data.name,
                            phone: suggestion.data.phone
                        }, 'id');
                    }
//                    let hash = window.location.hash.slice(1);
//                    if (hash === '/receivings/new') {
//                        PosnicPro.receivings.clearReceivingForm();
//                        PosnicPro.receivings.addReceivingTableRowCalc();
//                    }

                } else {
                    hasher.setHash('receivings/suppliers/new');
                }
            },
            autoSelectFirst: true,
            triggerSelectOnValidInput: false
    });
});
$('#receiving_add_supplier_name').click(function () {
    PosnicPro.selectAllText(jQuery(this));
});
$('#receiving_add_item_name').scannerDetection({
    timeBeforeScanTest: 200, // wait for the next character for upto 200ms
    avgTimeByChar: 40, // it's not a barcode if a character takes longer than 100ms
    preventDefault: true,
    endChar: [13],
    onComplete: function (barcode, qty) {
        validScan = true;
        var params = {
            url: 'items/getReceivingItemsAjaxList',
            data: 'query=' + barcode + '&type=barcode'
        };
        PosnicPro.get(params, function (response) {
            if (response.suggestions.length > 0) {
                suggestions: $.map(response.suggestions, function (suggestion) {
                    $('#receiving_add_item_name').focus();
                    PosnicPro.receivings.suggestionParam = [suggestion];
                    $('#receiving_add_selling_price').val(suggestion.selling_price);
                    $('#item_id').val(suggestion.item_id);
                    $('#barcode_id').val(suggestion.itemid);
                    $('#receiving_add_available_stock').val(suggestion.available_quantity);
                    $('#receiving_add_line_total').val(suggestion.company_price);
                    PosnicPro.receivings.addReceivingLineItems(suggestion);
                });
            } else {
                $('#receiving_add_item_name').focus();
                swal({
                    title: "Not found!",
                    text: "Barcode item not found. Please check item page.",
                    icon: "warning",
                    button: "Ok"
                });
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    onError: function (string, qty) {
        $('#receiving_add_item_name').val($('#receiving_add_item_name').val() + string).trigger('input');
    }
});
/* Same never-block treatment as the sale search: init once, debounce,
   drop stale responses. The supplier check moved to focus time. */
$(function () {
    var receivingLookupSeq = 0;
    $('#receiving_add_item_name').on('focus', function () {
        // Guide, don't scold: the page auto-focuses this field on open
        // (racing the default-supplier fill), so an empty supplier just
        // moves the cursor to the supplier box - the submit path still
        // enforces it with words when it actually matters.
        if ($('#receiving_add_supplier_name').val() === '') {
            $('#receiving_add_supplier_name').focus();
        }
    });
    $('#receiving_add_item_name').autocomplete({
        deferRequestBy: 120,
        lookup: function (query, done) {
            var seq = ++receivingLookupSeq;
            var id = $('#receiving_add_supplier_id').val();
            var result = {};
            var suggestions = [];
            var params = {
                url: 'items/getReceivingItemsAjaxList',
                data: 'query=' + query + '&id=' + id + '&type=normal'
            };
            PosnicPro.get(params, function (response) {
                if (seq !== receivingLookupSeq) { return; }
                if (response.suggestions.length > 0) {
                    suggestions: $.map(response.suggestions, function (dataItem) {
                        suggestions.push({"value": dataItem.item_name, "data": dataItem});
                    });
                }
                result["suggestions"] = suggestions;
                done(result);
            });
        },
        onSelect: function (suggestion) {
            if (suggestion.data !== -1) {
                PosnicPro.receivings.suggestionParam = [suggestion.data];
                $('#receiving_add_selling_price').val(suggestion.data.selling_price);
                $('#item_id').val(suggestion.data.item_id);
                $('#barcode_id').val(suggestion.data.itemid);
                $('#receiving_add_available_stock').val(suggestion.data.available_quantity);
                $('#receiving_add_item_unit').val(suggestion.data.item_unit);
                $('#receiving_add_line_total').val(suggestion.data.company_price);
                PosnicPro.receivings.addReceivingLineItems(suggestion.data);
                // Clear the search and refocus so the next item can be typed
                // straight away (rapid entry). Previously the picked item name
                // stayed stuck in the box with no easy way to clear it.
                var $box = $('#receiving_add_item_name');
                $box.val('');
                if ($box.data('autocomplete')) { $box.autocomplete('clear'); }
                setTimeout(function () { $box.focus(); }, 0);
            }
        },
        autoSelectFirst: true,
        triggerSelectOnValidInput: false,
        formatResult: function (suggestion, currentValue) {
            if (suggestion.data && suggestion.data.__action === 'create') {
                var typedName = $('<i>').text((suggestion.value || '').trim()).html();
                return PosnicPro.sugActionRow('icon-plus-circle', 'create',
                    'Create item &quot;' + typedName + '&quot;',
                    'Name and price now - details anytime later');
            }
            var currency = PosnicPro.local.get('currencySign');
            return PosnicPro.sugRow(suggestion.data,
                $.Autocomplete.formatResult(suggestion, currentValue), {
                    currency: currency,
                    price: Number(suggestion.data.company_price) || 0
                });
        }
    });
});
$(document).on('input', '#receiving_charges_rows .charge-amount, #receiving_charges_rows .charge-label', function () {
    PosnicPro.receivings.addReceivingTableRowCalc();
});
$(document).on('click', '#receiving_charges_rows .charge-remove', function () {
    $(this).closest('.charge-row').remove();
    PosnicPro.receivings.addReceivingTableRowCalc();
});
$(document).ready(function () {
    $('#receiving_print tbody').children("tr").remove();
    $("#receiving_print").find("tr:not(:first)").remove();
    $('#receiviing_img_hide').show();
    $('table#receiving_print tbody').append('<tr class="cart_content_area" id="cart_content_area"><td colspan="7"><div class="text-center text-dark"> <p><lang class="lang_receive_empty">Receiving Order Empty</lang></p></div></td></tr>');
    var format = PosnicPro.convertFormatDateTime();
    $("#receiving_add").validate({
        errorPlacement: function (error, element) {
            var placement = element.closest('.input-group');
            if (!placement.get(0)) {
                placement = element;
            }
            placement.after(error);
        },
        highlight: function (element, errorClass) {
            $(element).css("border-color", "#F9616D");
        },
        unhighlight: function (element, errorClass) {
            $(element).css("border-color", "#EAE8E8");
        },
        rules: {
            receiving_add_date: {
                required: true,
                date: true,
                commonDate: true
            },
            receiving_add_supplier_name: {
                required: true,
                minlength: 3,
                maxlength: 250

            },
        },
        messages: {
            receiving_add_date: {
                required: "This field is required",
                date: "Enter a valid date",
                maxlength: "Enter a valid date",
            },
            receiving_add_supplier_name: {
                required: "Enter the supplier name",
                minlength: "Supplier Name Must be Atleast 3 Characters"

            },
        }
    });
    jQuery.validator.addMethod("commonDate", function (value, element) {
        return this.optional(element) || moment(value, 'YYYY/MM/DD LT').isValid();
    }, "Use the date format");
});
$("#receiving_add").submit(function (event) {
    event.preventDefault();
    if ($('#receiving_add').valid()) {            // checks form for validity

        PosnicPro.receivings.receivingImageFormSubmit();
    }
});

/*
 * Purchase orders (PO_LIFECYCLE_DESIGN.md): the plan that never touches
 * stock. List / form / view sections on one page; Receive opens the
 * ordinary receiving screen pre-filled with the outstanding quantities and
 * stamps source_po_id so the bridge can mirror what arrived.
 */
PosnicPro.purchaseorders = {
    _detail: null,
    /* The page chrome, shared by list entry and deep links: pane, title,
       and the LEFT MENU highlight - which must also survive a refresh
       (owner: "when refresh left side correct menu not highlighted"). */
    _chrome: function () {
        PosnicPro.HideSideBarModal();
        $('.page_loader,#osk-container').hide();
        $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
        $('.vertical-menu li a').removeClass('active');
        $('#v-pills-purchase-tab').addClass('active');
        $('#v-pills-purchase').addClass('show active');
        $('#view_purchaseorders_page').addClass('active');
        $('.page-title-box,#purchaseorders_new').show();
        $('#po_view_section').hide();
        $('#po_list_section').show();
    },
    showDataTablePage: function () {
        PosnicPro.purchaseorders._chrome();
        PosnicPro.purchaseorders.closeDoc();
        PosnicPro.purchaseorders.loadList(1);
    },
    /* New purchases are recorded immediately on the receiving form. The old
       order form is kept only for legacy purchase orders; no new order is
       created from here. */
    showAdd: function () { hasher.setHash('receivings/new'); },
    /* Legacy purchase-order ids are history now. Editing a recorded purchase
       belongs to the receiving form, which is the only place that can move
       stock and money. */
    showEdit: function (id) { hasher.setHash('receivings/' + id + '/edit'); },
    /*
     * #/purchaseorders/<id> - the document's own address, like a quote's
     * (owner: "its not changing... as quote url system"). A refresh or a
     * shared link lands on the OPEN document; the hash echo of a row click
     * is recognised and ignored.
     */
    showDetails: function (id) {
        var self = PosnicPro.purchaseorders;
        var key = self._openDocKey || '';
        if (key.slice(key.indexOf(':') + 1) === String(id) && $('#purchases_detail_card').is(':visible')) {
            return;
        }
        self._chrome();
        self.loadList(1);
        /* which kind lives at this id? a receiving answers; a PO does not */
        PosnicPro.get('receivings/' + id, function (r) {
            if (r && r.type === 'success' && r.data) { self.openDoc('purchase', id); }
            else { self.openDoc('po', id); }
        }, function () { self.openDoc('po', id); });
    },
    /*
     * ONE list for the whole purchases area (owner: "keep one"). Orders and
     * received purchases, merged newest-first. Orders open their document;
     * purchases open the receiving view. Paging is a growing window over
     * both sources - simple, honest, and gone entirely when the
     * master-detail surface replaces this page.
     */
    _page: 1,
    PAGE_SIZE: 25,
    _openDocKey: null,
    mountPurchaseFilters: function (force) {
        if (!$('#purchases_filter_panel').length) { return; }
        if (!force && $('#purchases_filter_panel').data('mounted')) { return; }
        $('#purchases_filter_panel').data('mounted', true);
        PosnicPro.listFilter.mount({
            key: 'receivings',
            onRefresh: function () { return PosnicPro.purchaseorders.loadList(); },
            partyFilter: 'suppliers',
            primaryControls: function (row, state) {
                var status = $('<select class="form-control lf-primary" aria-label="Status" data-t-aria-label="lang_userstatus">').appendTo(row);
                status.append($('<option>').val('').text(PosnicPro.i18n.t('lang_report_all', 'All')));
                status.append($('<option>').val('received').text(PosnicPro.i18n.t('lang_po_received', 'Received')));
                status.append($('<option>').val('cancelled').text(PosnicPro.i18n.t('lang_cancelled', 'Cancelled')));
                status.val(state.extra.status || '').on('change', function () {
                    PosnicPro.listFilter.setExtra('receivings', 'status', this.value);
                });
            },
            rows: '#po_list_rows',
            container: '#purchases_filter_panel',
            appliedContainer: '#po_active_filters',
            button: '#purchases_filter_btn',
            searchPlaceholder: PosnicPro.i18n.t('lang_search_purchase_no_supplier_or_phone', 'Search purchase number, supplier or phone'),
            defaultPreset: 'today',
            dateField: PosnicPro.i18n.t('lang_bill_date', 'Bill date'),
            searchFields: [
                { value: 'all', label: PosnicPro.i18n.t('lang_all_fields', 'All fields') },
                { value: 'receiving_id', label: PosnicPro.i18n.t('lang_purchase_no', 'Purchase number') },
                { value: 'supplier_name', label: PosnicPro.i18n.t('lang_newsupplier_title', 'Supplier') },
                { value: 'supplier_phone', label: PosnicPro.i18n.t('lang_phone_title', 'Phone') }
            ],
            typeahead: 'supplier',
            typeaheadField: 'supplier_name',
            onChange: function () { PosnicPro.purchaseorders.loadList(1); }
        });
    },
    exportCsv: function () {
        var criteria = Object.assign({},PosnicPro.purchaseorders._criteria);
        PosnicPro.listExport.all({
            url:'purchaseOrders/history', filename:'purchases.csv',
            params:function (page,limit) { return Object.assign({},criteria,{page:page,limit:limit}); },
            head:['No','Kind','Bill date','Created','Supplier','Status','Expected','Total'],
            map:function (r) { return [r.no,r.kind,r.date,r.created,r.supplier,r.status,r.expected,r.total]; }
        });
    },
    STATUS_PILL: { ordered: 'hold', partial: 'hold', draft: 'hold', received: 'paid', closed: 'paid', cancelled: 'unpaid', open: 'hold' },
    STATUS_LABEL: { ordered: 'Legacy order', partial: 'Partially received', draft: 'Draft', received: 'Received', closed: 'Received', cancelled: 'Cancelled', open: 'Open' },
    /* The list and the document are read in the shop's language, so the
       status text must come from the same catalogue as the rest of the page. */
    statusLabel: function (status) {
        var key = String(status || '').toLowerCase();
        var labels = {
            ordered: ['lang_legacy_order', 'Legacy order'],
            partial: ['lang_partially_received', 'Partially received'],
            draft: ['lang_draft', 'Draft'],
            received: ['lang_po_received', 'Received'],
            closed: ['lang_po_received', 'Received'],
            cancelled: ['lang_cancelled', 'Cancelled'],
            open: ['lang_open', 'Open']
        };
        var pair = labels[key];
        return pair ? PosnicPro.i18n.t(pair[0], pair[1]) : (this.STATUS_LABEL[key] || status || '');
    },
    // The server filters and sorts orders and receipts together before paging.
    loadList: function (page) {
        PosnicPro.purchaseorders.mountPurchaseFilters();
        PosnicPro.listSort.mount('purchases', {
            options: [
                { v: 'date_asc', l: PosnicPro.i18n.t('lang_bill_date_oldest', 'Bill date: oldest'), i: 'rotate-ccw' },
                { v: 'total_desc', l: PosnicPro.i18n.t('lang_highest_amount_first', 'Highest amount first'), i: 'arrow-down' },
                { v: 'total_asc', l: PosnicPro.i18n.t('lang_lowest_amount_first', 'Lowest amount first'), i: 'arrow-up' },
                { v: 'supplier', l: PosnicPro.i18n.t('lang_supplier_a_to_z', 'Supplier A to Z'), i: 'type' }
            ],
            onChange: function () { PosnicPro.purchaseorders.loadList(1); }
        });
        var self = PosnicPro.purchaseorders;
        if (page) { self._page = page; }
        var p = self._page;
        var size = self.PAGE_SIZE;
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        var criteria = PosnicPro.listFilter.params('receivings');
        var chip = criteria.status;
        criteria.status = chip || '';
        criteria.sort = PosnicPro.listSort.value('purchases');
        $('#po_summary').empty();
        self._criteria = criteria;
        PosnicPro.listFilter.request('receivings', {url:'purchaseOrders/history', data:Object.assign({},criteria,{page:p,limit:size})}, function (response) {
            var data = response.data || {}, pageRows = data.list || [];
            var summary = $('#po_summary').empty();
            if (data.purchaseAmount != null) {
                $('<span>').text(PosnicPro.i18n.t('lang_received','Received') + ' ').append($('<strong>').text(data.purchases)).appendTo(summary);
                $('<span>').text(PosnicPro.i18n.t('lang_total','Total') + ' ').append($('<strong>').text((PosnicPro.local.get('currencySign') || '')+' '+Number(data.purchaseAmount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}))).appendTo(summary);
            }
            pageRows.forEach(function (r) { r.progress = r.ordered ? r.received + '/' + r.ordered : ''; });
            if (!pageRows.length && p > 1) { self.loadList(1); return; }
            if (!pageRows.length) {
                var isFiltered = !!chip || PosnicPro.listFilter.activeCount('receivings') > 0;
                $('#po_list_rows').html('<div class="text-center text-muted p-t-20 p-b-20">'
                    + (isFiltered ? PosnicPro.i18n.t('lang_no_purchases_match_this_filter', 'No purchases match this filter.') : PosnicPro.i18n.t('lang_no_purchases_yet_press_new_purchase_to_rec', 'No purchases yet - press New Purchase to record the first.')) + '</div>');
                $('#po_list_paging').html('');
                return;
            }
            var d = function (v) { return v ? new Date(v).toLocaleDateString('en-IN') : '-'; };
            var P = self.STATUS_PILL;
            var html = '<div class="table-responsive"><table class="table table-borderless">'
                + '<thead><tr>'
                + '<th class="p-col-num"><lang class="lang_purchase_2">Purchase #</lang></th><th><lang class="lang_newsupplier_title">Supplier</lang></th><th class="p-col-date"><lang class="lang_date_title">Date</lang></th><th class="p-col-created"><lang class="lang_created">Created</lang></th>'
                + '<th class="text-right"><lang class="lang_total_title">Total</lang></th><th class="text-center"><lang class="lang_userstatus">Status</lang></th>'
                + '</tr></thead><tbody>';
            pageRows.forEach(function (r) {
                var key = r.kind + ':' + r.id;
                var badges = '';
                if (r.mismatch) { badges += ' <i class="feather icon-alert-triangle text-warning" title="Invoice total mismatch" data-t-title="lang_invoice_total_mismatch"></i>'; }
                if (r.hasDoc) { badges += ' <i class="feather icon-paperclip text-muted"></i>'; }
                var pill = '<span class="rs-pill ' + (P[r.status] || 'hold') + '">' + esc(self.statusLabel(r.status)) + '</span>';
                html += '<tr class="md-row purchases-row highlight-select' + (self._openDocKey === key ? ' is-active' : '') + '"'
                    + ' data-kind="' + r.kind + '" data-id="' + esc(r.id) + '" style="cursor:pointer;">'
                    + '<td class="p-col-num">' + esc(r.no) + badges + '</td>'
                    + '<td>' + esc(r.supplier) + (r.progress ? ' <span class="text-muted p-col-progress">' + esc(r.progress) + '</span>' : '') + '</td>'
                    + '<td class="p-col-date">' + d(r.date) + '</td>'
                    + '<td class="p-col-created">' + d(r.created) + '</td>'
                    + '<td class="text-right">' + PosnicPro.local.get('currencySign') + '&nbsp;' + (Number(r.total) || 0).toFixed(2) + '</td>'
                    + '<td class="text-center">' + pill + '</td>'
                    + '</tr>';
            });
            html += '</tbody></table></div>';
            $('#po_list_rows').html(html);
            self.renderPager(data.total,data.total);
        }, function () {
            $('#po_list_rows').text(PosnicPro.i18n.t('lang_could_not_load_purchases_refresh_to_retry', 'Could not load purchases. Refresh to retry.'));
            $('#po_list_paging').empty();
        });
    },
    /*
     * Pager per LIST_PAGE_UX_STANDARD §3: numbered window when the total is
     * known, arrows always, count that never lies. A chip filters
     * client-side so its total is unknown - the pager falls back to the
     * range on screen, exactly like the quotes search path.
     */
    renderPager: function (reach, total) {
        var self = PosnicPro.purchaseorders;
        var p = self._page, size = self.PAGE_SIZE;
        var hasMore = reach > p * size;
        var pages = null;
        var label;
        if (total !== null && total !== undefined) {
            pages = Math.ceil(total / size) || 1;
            label = total + ' ' + (total === 1 ? PosnicPro.i18n.t('lang_purchase_4', 'purchase') : PosnicPro.i18n.t('lang_purchases', 'purchases'));
            if (pages > 1) { label = 'Page ' + p + ' of ' + pages + ' \u00b7 ' + label; }
        } else {
            var first = (p - 1) * size + 1;
            var last = Math.min(reach, p * size);
            label = reach ? 'Showing ' + first + '\u2013' + last : 'No matches';
        }
        var btn = function (to, text, off, cls) {
            return '<button type="button" class="btn btn-sm ' + (cls || 'btn-secondary-rgba') + ' q-pg-btn"' + (off ? ' disabled' : '')
                + ' onclick="PosnicPro.purchaseorders.goPage(' + to + ');">' + text + '</button>';
        };
        var html = '';
        var showArrows = p > 1 || hasMore || (pages && pages > 1);
        if (showArrows) { html += btn(p - 1, '&laquo;', p <= 1); }
        if (pages && pages > 1) {
            var reachablePages = Math.max(1, Math.ceil(Math.min(total, 200) / size));
            var shown = Math.min(pages, reachablePages);
            var pgEnd = Math.min(shown, Math.max(1, p - 2) + 4);
            var pgStart = Math.max(1, pgEnd - 4);
            for (var n = pgStart; n <= pgEnd; n++) {
                html += '<span class="q-pg-num">' + btn(n, n, false, n === p ? 'btn-primary-rgba' : 'btn-secondary-rgba') + '</span>';
            }
        }
        html += '<span class="q-pg-count">' + label + '</span>';
        if (showArrows) { html += btn(p + 1, '&raquo;', !hasMore); }
        $('#po_list_paging').html(html);
    },
    goPage: function (n) {
        if (!n || n < 1) { return; }
        PosnicPro.purchaseorders._page = n;
        PosnicPro.purchaseorders.loadList();
    },
    /* ---- opening a document IS entering the split (standard §4) ---- */
    openDoc: function (kind, id) {
        var self = PosnicPro.purchaseorders;
        if (!PosnicPro.masterDetail.inSplit('#purchases_split', 'purchases-split')) {
            PosnicPro.masterDetail.enter('#purchases_split', 'purchases-split');
            $('#purchases_detail_card').show();
        }
        self._openDocKey = kind + ':' + id;
        $('#po_list_rows tr.purchases-row').removeClass('is-active');
        $('#po_list_rows tr.purchases-row[data-id="' + id + '"]').addClass('is-active');
        /* the document's address, like a quote's - showDetails recognises
           the echo of this setHash and does nothing */
        if (window.location.hash.slice(2) !== 'purchaseorders/' + id) {
            hasher.setHash('purchaseorders/' + id);
        }
        if (kind === 'po') {
            $('#purchases_doc').hide();
            $('#purchases_po_host').show();
            if (!$('#po_view_section').length || !$.contains($('#purchases_po_host')[0], $('#po_view_section')[0])) {
                $('#po_view_section').appendTo('#purchases_po_host');
            }
            PosnicPro.purchaseorders.openView(id);
            $('#po_view_section').show();
            return;
        }
        $('#purchases_po_host').hide();
        $('#purchases_doc').show().html('<div class="text-center text-muted" style="padding:60px;"><lang class="lang_loading_4">Loading ...</lang></div>');
        PosnicPro.get('receivings/' + id, function (response) {
            if (response.type !== 'success') { $('#purchases_doc').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_purchase">Could not open this purchase.</lang></div>'); return; }
            PosnicPro.purchaseorders.renderPurchaseDoc(response.data);
            PosnicPro.ACLForModule('receiving');
        }, function () { $('#purchases_doc').html('<div class="text-danger p-4"><lang class="lang_could_not_open_this_purchase">Could not open this purchase.</lang></div>'); });
    },
    closeDoc: function () {
        PosnicPro.purchaseorders._openDocKey = null;
        $('#purchases_detail_card').hide();
        $('#po_list_rows tr.purchases-row').removeClass('is-active');
        PosnicPro.masterDetail.leave('#purchases_split', 'purchases-split');
        if (window.location.hash.slice(2).indexOf('purchaseorders/') === 0) {
            hasher.setHash('purchaseorders');
        }
    },
    /*
     * The document pane, paper-styled (standard §4): pull first, title and
     * pills, grouped actions right (one primary, Edit, More, close last).
     * Soft hairlines and muted labels - the theme's font does the talking.
     */
    /*
     * The document is the quote's A4 sheet (owner: "show similar as quote.
     * like full box and neatly aligned professional like A4 document") -
     * same q-sheet vocabulary, same CSS, so the two documents age together.
     * Toolbar above the paper; the void strip asks its reason inline.
     */
    /*
     * The A4 sheet alone - shared with every pane that previews a purchase
     * (the supplier profile embeds it, so reading a supplier's history
     * never means leaving the page and hunting for the back button).
     */
    buildPurchaseSheet: function (d) {
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        var money = function (v) { return PosnicPro.local.get('currencySign') + '&nbsp;' + (Number(v) || 0).toFixed(2); };
        var dt = function (v) { return v ? new Date(v).toLocaleDateString('en-IN') : '-'; };
        var real = function (v) { return v && v !== 'null' && v !== 'undefined' ? v : ''; };
        var open = d.receiving_status === 'Open';
        var cancelled = d.receiving_status === 'Cancelled';
        var partial = d.receiving_status === 'Partial';
        var st = cancelled ? 'cancelled' : partial ? 'partial' : open ? 'ordered' : 'received';
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
            + '<div class="q-doc-title"><lang class="lang_purchase_3">PURCHASE</lang></div>'
            + '<div class="q-num">' + esc(d.receiving_id) + '</div>'
            + '<div class="q-muted">Bill date: ' + dt(d.date) + '</div>'
            + (d.expected_date ? '<div class="q-muted">Expected: ' + dt(d.expected_date) + '</div>' : '')
            + '<div class="q-status" data-status="' + st + '">' + esc(PosnicPro.purchaseorders.statusLabel(open ? 'open' : st).toUpperCase()) + '</div>'
            + '</div>';
        var supplier = '<div class="q-billto"><div class="q-label"><lang class="lang_newsupplier_title">Supplier</lang></div>'
            + '<div class="q-cust">' + esc(d.supplier_name || '-') + '</div>'
            + (real(d.supplier_address) ? '<div class="q-muted">' + esc(d.supplier_address) + '</div>' : '')
            + '<div class="q-muted">'
            + (real(d.supplier_phone) ? 'Phone: ' + esc(d.supplier_phone) : '')
            + '</div>'
            + (real(d.supplier_email) ? '<div class="q-muted">Email: ' + esc(d.supplier_email) + '</div>' : '')
            + '</div>';
        var items = '<div class="table-responsive"><table class="q-items"><thead><tr>'
            + '<th>#</th><th><lang class="lang_newitem_title">Item</lang></th><th class="text-right"><lang class="lang_qty_title">Quantity</lang></th>'
            + '<th class="text-right"><lang class="lang_unit_cost">Unit cost</lang></th><th class="text-right"><lang class="lang_amount_title">Amount</lang></th>'
            + '</tr></thead><tbody>';
        (d.items || []).forEach(function (l, i) {
            var got = l.qty_received !== undefined && l.qty_received !== null ? parseFloat(l.qty_received) : null;
            var qtyCell = got !== null && got < (parseFloat(l.item_quantity) || 0)
                ? got + ' / ' + esc(l.item_quantity)
                : esc(l.item_quantity);
            items += '<tr><td>' + (i + 1) + '</td><td>' + esc(l.item_name) + '</td>'
                + '<td class="text-right"' + (got !== null && got < (parseFloat(l.item_quantity) || 0) ? ' title="Received so far / ordered" data-t-title="lang_received_so_far_ordered"' : '') + '>' + qtyCell + ' ' + esc(l.item_unit || '') + '</td>'
                + '<td class="text-right">' + money(l.item_price) + '</td>'
                + '<td class="text-right">' + money(l.total_amount) + '</td></tr>';
        });
        items += '</tbody><tfoot>'
            + '<tr class="q-sub"><td colspan="4" class="text-right"><lang class="lang_subtotal">Subtotal</lang></td>'
            + '<td class="text-right">' + money(d.subtotal_amount) + '</td></tr>'
            + (d.additional_charges || []).map(function (c) {
                return '<tr class="q-sub"><td colspan="4" class="text-right">' + esc(c.label || 'Charge')
                    + '</td><td class="text-right">' + money(c.amount) + '</td></tr>';
            }).join('')
            + (d.invoice_total_declared
                ? '<tr class="q-sub"><td colspan="4" class="text-right">Supplier\u2019s invoice states'
                    + (d.invoice_total_mismatch ? ' <i class="feather icon-alert-triangle text-warning"></i>' : '')
                    + '</td><td class="text-right">' + money(d.invoice_total_declared) + '</td></tr>'
                : '')
            + '<tr class="q-grand"><th colspan="4" class="text-right"><lang class="lang_total">TOTAL</lang></th>'
            + '<th class="text-right">' + money(d.total_amount) + '</th></tr>'
            + (function () {
                /*
                 * Mirror the sale bill: the purchase's payment position lives
                 * under its total. `debt_account` is joined by the server from
                 * the supplier statement - paid at receipt, every later payment
                 * allocated to this document, and what remains - so the reader
                 * can reconcile one purchase without leaving the sheet.
                 */
                var debt = d.debt_account;
                if (!debt) return '';
                var accountTotal = debt.invoice_total != null
                    ? Number(debt.invoice_total) || 0
                    : Number(d.invoice_total_declared || d.total_amount) || 0;
                var remaining = debt.invoice_remaining != null
                    ? Number(debt.invoice_remaining) || 0
                    : Math.max(0, accountTotal - (Number(debt.paid_at_sale) || 0) - (Number(debt.paid_later) || 0));
                var paid = Math.min(accountTotal, Math.max(0, accountTotal - remaining));
                var when = function (value) {
                    if (!value) return '';
                    if (PosnicPro.debts && PosnicPro.debts.formatDateTime) {
                        return PosnicPro.debts.formatDateTime(value);
                    }
                    return String(value).replace('T', ' ').slice(0, 16);
                };
                var paymentRows = [];
                if (Number(debt.paid_at_sale) > 0) {
                    paymentRows.push({
                        date: d.date || d.created_date,
                        label: d.payment_mode || PosnicPro.i18n.t('lang_paid_at_purchase', 'Paid at purchase'),
                        amount: Number(debt.paid_at_sale) || 0,
                        display: d.date || ''
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
                var html = '<tr class="q-paid"><td colspan="4" class="text-right">'
                    + '<lang class="lang_paid">Paid</lang></td>'
                    + '<td class="text-right">' + money(paid) + '</td></tr>';
                if (paymentRows.length) {
                    html += '<tr class="q-payment-history"><td colspan="5"><div class="q-payment-history-list">'
                        + paymentRows.map(function (payment) {
                            return '<div class="q-payment-line">'
                                + '<span class="q-payment-date">' + esc(payment.display || when(payment.date)) + '</span>'
                                + '<span class="q-payment-label">' + esc(payment.label || '') + '</span>'
                                + '<span class="q-payment-amount">' + money(payment.amount) + '</span>'
                                + '</div>';
                        }).join('')
                        + '</div></td></tr>';
                }
                html += '<tr class="q-due"><th colspan="4" class="text-right">'
                    + '<lang class="lang_remaining">Remaining</lang></th>'
                    + '<th class="text-right">' + money(remaining) + '</th></tr>';
                if (debt.party_id) {
                    html += '<tr class="q-account"><td colspan="4" class="text-right">'
                        + '<lang class="lang_supplier_statement">Supplier statement</lang></td>'
                        + '<td class="text-right"><a href="javascript:void(0)" class="q-account-link"'
                        + ' onclick="if(PosnicPro.debts&&PosnicPro.debts.openStatement){PosnicPro.debts.openStatement(\'supplier\',\''
                        + esc(debt.party_id) + '\');}return false;">'
                        + money(debt.outstanding) + '</a></td></tr>';
                }
                return html;
            })()
            + '</tfoot></table></div>';
        var footer = '<div class="q-footer">';
        footer += '<div class="q-block"><div class="q-label"><lang class="lang_payment_details_2">Payment details</lang></div>'
            + (real(d.payment_description) ? '<div class="q-muted">' + esc(d.payment_description) + '</div>' : '')
            + '</div>';
        if (d.image && d.image.length) {
            footer += '<div class="q-block"><div class="q-label"><lang class="lang_po_attachments">Attachments</lang></div>';
            d.image.forEach(function (f) {
                footer += '<div><a href="' + esc(f.name) + '" target="_blank" rel="noopener"><i class="feather icon-paperclip mr-1"></i>' + esc(String(f.name).split('/').pop()) + '</a></div>';
            });
            footer += '</div>';
        }
        if (cancelled && d.void_reason) {
            footer += '<div class="q-block"><div class="q-label"><lang class="lang_voided">Voided</lang></div>'
                + '<div class="q-muted">By ' + esc(d.voided_by || '?')
                + (d.voided_at ? ' on ' + dt(d.voided_at) : '') + '</div>'
                + '<div>' + esc(d.void_reason) + '</div></div>';
        }
        footer += '</div>';
        return '<div class="q-sheet">'
            + '<div class="q-head">' + seller + title + '</div>'
            + supplier + items + footer
            + '</div>';
    },
    renderPurchaseDoc: function (d) {
        PosnicPro.purchaseorders._doc = d;
        var esc = function (t) { return $('<span>').text(t == null ? '' : t).html(); };
        var money = function (v) { return PosnicPro.local.get('currencySign') + '&nbsp;' + (Number(v) || 0).toFixed(2); };
        var dt = function (v) { return v ? new Date(v).toLocaleDateString('en-IN') : '-'; };
        var real = function (v) { return v && v !== 'null' && v !== 'undefined' ? v : ''; };
        var open = d.receiving_status === 'Open';
        var cancelled = d.receiving_status === 'Cancelled';
        var P = PosnicPro.purchaseorders.STATUS_PILL;
        var partial = d.receiving_status === 'Partial';
        var st = cancelled ? 'cancelled' : partial ? 'partial' : open ? 'ordered' : 'received';
        var chip = '<span class="rs-pill ' + P[st] + '">' + esc(PosnicPro.purchaseorders.statusLabel(open ? 'open' : st)) + '</span>';
        var mismatch = d.invoice_total_mismatch
            ? '<span class="rs-pill hold" title="Declared invoice total does not match the lines" data-t-title="lang_declared_invoice_total_does_not_match_the"><i class="feather icon-alert-triangle"></i> Mismatch</span>' : '';
        var more = '<div class="btn-group">'
            + '<button type="button" class="btn btn-sm btn-light dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><lang class="lang_tab_more">More</lang></button>'
            + '<div class="dropdown-menu dropdown-menu-right">'
            + '<a class="dropdown-item" href="javascript:void(0)" onclick="PosnicPro.receivings.showPrint(\'' + esc(d._id) + '\'); return false;"><i class="feather icon-printer mr-2"></i>Print</a>'
            + '<a class="dropdown-item" href="javascript:void(0)" onclick="PosnicPro.receivings.view.receivingPdf(\'' + esc(d._id) + '\');"><i class="feather icon-file mr-2"></i>Download PDF</a>'
            + '<a class="dropdown-item" href="javascript:void(0)" onclick="PosnicPro.receivings.view.emailToSupplier(\'' + esc(d._id) + '\');"><i class="feather icon-mail mr-2"></i>Email supplier</a>'
            + (!open && !cancelled
                ? '<a class="dropdown-item" data-module="receiving" data-access="write" href="javascript:void(0)" onclick="hasher.setHash(\'receivings/' + esc(d._id) + '/return\');"><i class="feather icon-corner-up-left mr-2"></i>Return items</a>'
                : '')
            + (!cancelled
                ? '<div class="dropdown-divider"></div>'
                    + '<a class="dropdown-item text-danger" data-module="receiving" data-access="delete" href="javascript:void(0)" onclick="PosnicPro.purchaseorders.voidPurchase(\'' + esc(d._id) + '\',\'' + esc(d.receiving_id) + '\');"><i class="feather icon-slash mr-2"></i>Void</a>'
                : '')
            + '</div></div>';
        var toolbar = '<div class="p-doc-toolbar">'
            + '<button type="button" class="btn btn-sm btn-light" title="Show or hide the list" data-t-title="lang_show_or_hide_the_list" aria-label="Show or hide the list" data-t-aria-label="lang_show_or_hide_the_list" onclick="PosnicPro.masterDetail.toggleRail(\'#purchases_split\');"><i class="feather icon-sidebar"></i></button>'
            + '<span class="p-doc-title">' + esc(d.receiving_id) + '</span>' + chip + mismatch
            + '<span class="ml-auto"></span>'
            + ((!open && !partial && !cancelled)
                ? '<button type="button" class="btn btn-sm btn-light" data-module="receiving" data-access="write" onclick="hasher.setHash(\'receivings/' + esc(d._id) + '/edit\');"><i class="feather icon-edit-2 mr-1"></i>Edit</button>'
                : '')
            + more
            + '<button type="button" class="btn btn-sm btn-light" title="Close this purchase and show the full list" data-t-title="lang_close_this_purchase_and_show_the_full_list" aria-label="Close" data-t-aria-label="lang_close_title" onclick="PosnicPro.purchaseorders.closeDoc();"><i class="feather icon-x"></i></button>'
            + '</div>';
        var voidStrip = '<div class="p-void-strip" id="p_void_strip" style="display:none;">'
            + '<span>Void <b>' + esc(d.receiving_id) + '</b> \u2014 stock reverses and the record stays.</span>'
            + '<input type="text" class="form-control form-control-sm" id="p_void_reason" maxlength="200" placeholder="Reason (required)" data-t-placeholder="lang_reason_required" aria-label="Void reason" data-t-aria-label="lang_void_reason">'
            + '<button type="button" class="btn btn-sm btn-danger" onclick="PosnicPro.purchaseorders.voidConfirm(\'' + esc(d._id) + '\');">Void purchase</button>'
            + '<button type="button" class="btn btn-sm btn-light" onclick="$(\'#p_void_strip\').slideUp(120);">Cancel</button>'
            + '</div>';
        var sheet = PosnicPro.purchaseorders.buildPurchaseSheet(d);
        $('#purchases_doc').html(toolbar + voidStrip + '<div class="doc-scroll">' + sheet + '</div>');
    },
    /* Void asks its reason inline, in the pane - no native prompt. */
    voidPurchase: function (id, no) {
        $('#p_void_strip').slideDown(120);
        setTimeout(function () { $('#p_void_reason').trigger('focus'); }, 140);
    },
    voidConfirm: function (id) {
        var reason = $.trim($('#p_void_reason').val() || '');
        if (!reason) {
            $('#p_void_reason').addClass('is-invalid').attr('placeholder', PosnicPro.i18n.t('lang_a_reason_is_required', 'A reason is required')).trigger('focus');
            return;
        }
        PosnicPro.post({ url: 'receivings/' + id + '/void', data: JSON.stringify({ reason: reason }) }, function (r) {
            PosnicPro.alert(r.type || 'success', r.message || 'Purchase voided');
            PosnicPro.purchaseorders.loadList();
            PosnicPro.purchaseorders.openDoc('purchase', id);
        }, function (xhr) {
            var resp = {}; try { resp = jQuery.parseJSON(xhr.responseText) || {}; } catch (e) { }
            PosnicPro.alert('error', resp.message || 'Could not void this purchase');
        });
    },
    backToList: function () {
        $('#po_view_section').hide();
        $('#po_list_section').show();
        PosnicPro.purchaseorders.loadList(1);
    },
    /* ---- view ---- */
    openView: function (id) {
        PosnicPro.get({ url: 'purchaseOrders/' + id, data: '' }, function (response) {
            var po = response && response.data;
            if (!po) { return; }
            PosnicPro.purchaseorders._detail = po;
            PosnicPro.purchaseorders.renderAttachments(po.attachments || []);
            var currency = PosnicPro.local.get('currencySign');
            $('#po_view_id').text(po.po_id);
            $('#po_view_status').text(po.status);
            $('#po_view_supplier').text(po.supplier_name);
            $('#po_view_date').text(String(po.order_date).slice(0, 10));
            $('#po_view_expected').text(po.expected_date ? String(po.expected_date).slice(0, 10) : '-');
            var ordered = 0, received = 0, rows = '';
            (po.items || []).forEach(function (line) {
                ordered += Number(line.qty_ordered) || 0;
                received += Number(line.qty_received) || 0;
                rows += '<tr><td>' + $('<span>').text(line.item_name).html() + '</td>' +
                    '<td class="text-right">' + line.qty_ordered + '</td>' +
                    '<td class="text-right">' + line.qty_received + '</td>' +
                    '<td class="text-right">' + (Number(line.unit_cost) || 0).toFixed(2) + '</td>' +
                    '<td class="text-right">' + (Number(line.line_total) || 0).toFixed(2) + '</td></tr>';
            });
            $('#po_view_rows').html(rows);
            var pct = ordered > 0 ? Math.min(100, Math.round(received * 100 / ordered)) : 0;
            $('#po_view_progress').html('<div class="progress" style="height:8px;"><div class="progress-bar" style="width:' + pct + '%;"></div></div><small class="text-muted">Received ' + received + ' of ' + ordered + '</small>');
            var costs = '';
            (po.additional_costs || []).forEach(function (c) {
                costs += '<div><small class="text-muted">' + $('<span>').text(c.label).html() + '</small> ' + currency + '&nbsp;' + (Number(c.amount) || 0).toFixed(2) + '</div>';
            });
            $('#po_view_costs').html(costs);
            $('#po_view_total').text(currency + ' ' + (Number(po.grand_total) || 0).toFixed(2));
            $('#po_view_notes').text(po.notes || '');
            /* Legacy orders are history: they can be read and their labels
               reprinted, but there is no ordered -> received step left. New
               purchases are recorded as received on the receiving form. */
            var actions = '<button type="button" class="btn btn-sm btn-outline-secondary mr-1" onclick="PosnicPro.purchaseorders.backToList();"><lang class="lang_back_title">Back</lang></button>';
            if ((po.items || []).length) {
                actions += '<button type="button" class="btn btn-sm btn-outline-secondary mr-1" data-act="labels"><lang class="lang_print_labels">Print labels</lang></button>';
            }
            $('#po_view_actions').html(actions).data('po-id', String(po._id));
            if ($('#purchases_po_host').length && $.contains($('#purchases_po_host')[0], $('#po_view_section')[0])) {
                /* master-detail: the document lives in the right pane; the
                   rail stays visible beside it. */
                $('#po_list_section,#po_view_section').show();
            } else {
                $('#po_list_section').hide();
                $('#po_view_section').show();
            }
        });
    },
    /*
     * Bulk labels from the open order (Loyverse study L3): one label per
     * ordered unit, name + barcode, rendered with the bundled JsBarcode and
     * printed from a plain window. Lines without any code are skipped and
     * counted honestly; the sheet caps at 500 labels so a typo in a
     * quantity cannot hang the browser.
     */
    printLabels: function () {
        var po = PosnicPro.purchaseorders._detail;
        if (!po) { return; }
        var labels = [];
        var skipped = 0;
        (po.items || []).forEach(function (line) {
            var code = String(line.barcode_id || '').trim();
            if (!code) { skipped += 1; return; }
            var copies = Math.max(1, Math.round(Number(line.qty_ordered) || 1));
            for (var c = 0; c < copies && labels.length < 500; c++) {
                labels.push({ name: line.item_name, code: code });
            }
        });
        if (!labels.length) {
            PosnicPro.alert('warning', PosnicPro.i18n.t('lang_no_lines_with_a_barcode_to_print', 'No lines with a barcode to print'));
            return;
        }
        // Render each unique code once, reuse the SVG per copy.
        var svgByCode = {};
        var $work = $('<div style="position:absolute;left:-9999px;top:0;"></div>').appendTo('body');
        Object.keys(labels.reduce(function (acc, l) { acc[l.code] = 1; return acc; }, {})).forEach(function (code) {
            var $svg = $('<svg></svg>').appendTo($work);
            try {
                $svg.JsBarcode(code, { format: 'CODE128', height: 40, width: 1.6, fontSize: 12, margin: 4, displayValue: true });
                svgByCode[code] = $work.children().last().prop('outerHTML');
            } catch (e) { svgByCode[code] = ''; }
        });
        $work.remove();
        var cells = labels.map(function (l) {
            return '<div class="lbl"><div class="lbl-name">' + $('<span>').text(l.name).html() + '</div>' + (svgByCode[l.code] || '') + '</div>';
        }).join('');
        var w = window.open('', '_blank');
        if (!w) { PosnicPro.alert('error', PosnicPro.i18n.t('lang_allow_pop_ups_to_print_labels', 'Allow pop-ups to print labels')); return; }
        w.document.write('<html><head><title>Labels ' + (po.po_id || '') + '</title><style>' +
            'body{margin:0;font-family:sans-serif;}' +
            '.sheet{display:flex;flex-wrap:wrap;}' +
            '.lbl{width:38mm;padding:2mm;border:1px dotted #ccc;text-align:center;page-break-inside:avoid;}' +
            '.lbl-name{font-size:9px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}' +
            'svg{max-width:100%;}' +
            '@media print{.lbl{border:none;}}' +
            '</style></head><body><div class="sheet">' + cells + '</div></body></html>');
        w.document.close();
        setTimeout(function () { w.print(); }, 400);
        if (skipped > 0) {
            PosnicPro.alert('info', skipped + ' line(s) had no barcode and were skipped');
        }
    },
};
$(document).on('click', '.po-list-row', function () {
    PosnicPro.purchaseorders.openView($(this).data('id'));
});
$(document).on('click', '#po_view_actions [data-act="labels"]', function () {
    PosnicPro.purchaseorders.printLabels();
});
$(document).on('click', '#po_list_rows tr.purchases-row', function () {
    PosnicPro.purchaseorders.openDoc($(this).data('kind'), $(this).data('id'));
});
$(document).on('click', '#suppliers_list_rows tr.suppliers-row', function () {
    PosnicPro.suppliers.openDoc($(this).data('id'));
});
$(document).on('focus', '#receiving_add_supplier_name', function () {
    /* devbridge fires no lookup on plain focus, even at minChars 0 - the
       standing picker rule (frequent-on-focus) needs this nudge. A box
       PREFILLED with the default supplier clears on click and shows the
       list with the default first; leaving without choosing restores it. */
    var $el = $(this);
    var ac = $el.data('autocomplete');
    if (!ac) { return; }
    var def = $el.data('prefilled-default');
    if ($el.val() && def && $el.val() === def.name) {
        $el.data('restore-default', $el.val());
        $el.val('');
    }
    $('.autocomplete-suggestions').data('ac-owner', $el);
    if (!$el.val()) { ac.onValueChange(); }
});
$(document).on('blur', '#receiving_add_supplier_name', function () {
    var $el = $(this);
    var stash = $el.data('restore-default');
    if (stash && !$el.val()) {
        setTimeout(function () { if (!$el.val()) { $el.val(stash); } }, 200);
    }
    $el.removeData('restore-default');
});

/* The joined purchases surface shares the same filter machinery; each page
   mounts on entry, so the key's config always points at the panel on screen. */
$(document).on('click', '#purchases_filter_btn', function () {
    PosnicPro.purchaseorders.mountPurchaseFilters(true);
    PosnicPro.listFilter.toggle('receivings');
});

/*
 * The paperwork that belongs to a purchase (owner: "we cant upload any
 * file. supplier po or some other stuff"). The endpoint accepts a receiving
 * OR a purchase order id, so the one purchases door attaches to either.
 */
PosnicPro.purchaseorders.renderAttachments = function (list) {
    var esc = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
    if (!list.length) {
        $('#po_view_attachments').html('<li class="text-muted" style="font-size:12.5px;"><lang class="lang_nothing_attached_yet">Nothing attached yet.</lang></li>');
        return;
    }
    $('#po_view_attachments').html(list.map(function (a) {
        var kb = a.size ? ' <span class="text-muted">(' + Math.max(1, Math.round(a.size / 1024)) + ' KB)</span>' : '';
        return '<li class="mb-1" style="font-size:13px;">'
            + '<a href="' + esc(a.url) + '" target="_blank" rel="noopener"><i class="feather icon-file mr-1"></i>' + esc(a.name) + '</a>' + kb
            + ' <a href="javascript:void(0)" class="text-danger ml-2 po-attach-remove" data-att="' + esc(a.id) + '" title="Remove" data-t-title="lang_remove">&times;</a>'
            + '</li>';
    }).join(''));
};
$(document).on('change', '#po_attach_file', function () {
    var file = this.files && this.files[0];
    this.value = '';
    var po = PosnicPro.purchaseorders._detail;
    if (!file || !po) { return; }
    if (file.size > 10 * 1024 * 1024) { PosnicPro.alert('error', PosnicPro.i18n.t('lang_that_file_is_over_10mb', 'That file is over 10MB.')); return; }
    var fd = new FormData();
    fd.append('file', file);
    $.ajax({
        url: 'api/receivings/' + po._id + '/attachments',
        method: 'POST',
        data: fd,
        processData: false,
        contentType: false,
        headers: { Authorization: 'Bearer ' + PosnicPro.local.get('posnic_jwt_token') },
        success: function (r) {
            po.attachments = (po.attachments || []).concat([(r && r.data) || {}]);
            PosnicPro.purchaseorders.renderAttachments(po.attachments);
            PosnicPro.alert('success', PosnicPro.i18n.t('lang_attached', 'Attached.'));
        },
        error: function (xhr) {
            var m = {}; try { m = JSON.parse(xhr.responseText); } catch (e) { }
            PosnicPro.alert('error', m.message || 'Could not attach the file.');
        }
    });
});
$(document).on('click', '.po-attach-remove', function () {
    var po = PosnicPro.purchaseorders._detail;
    var attId = $(this).data('att');
    if (!po || !attId) { return; }
    PosnicPro.delete({ url: 'receivings/' + po._id + '/attachments/' + attId, data: JSON.stringify({}) }, function () {
        po.attachments = (po.attachments || []).filter(function (a) { return a.id !== attId; });
        PosnicPro.purchaseorders.renderAttachments(po.attachments);
    }, function () { PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_remove_it', 'Could not remove it.')); });
});
