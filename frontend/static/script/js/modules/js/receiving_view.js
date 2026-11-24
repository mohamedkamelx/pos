
PosnicPro.receivings.view = {

    /*To display the added receiving data details in view page*/
    viewReceiving: function (id) {
        var loader = $(".loader-view-receiving");
        var spinner = $("<div class='loadingSpinner'></div>").appendTo(loader);
        PosnicPro.get('receivings/' + id, function (response) {
            spinner.remove();
            if (response.type === 'success') {
                PosnicPro.record_id = id;
                var data = response.data;
                if (data.payment_description !== '') {
                    $('.note_hide').show();
                } else {
                    $('.note_hide').hide();
                }
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
                $('#receivingtitelText').text(PosnicPro.i18n.t('lang_action_receiving_details', 'Receiving Details') + ' (' + data.receiving_status + ')');
                PosnicPro.receivings.view.viewReceivingData(response, id);

            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function () {
            spinner.remove();
            PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_load_receiving_details_please_tr', 'Could not load receiving details. Please try again.'));
        });
    },
    viewReceivingData: function (response, id) {
        $('#receiving_print_view tbody').children("tr").remove();
        $('#receiving_print_view').find("tr:not(:first)").remove();
        $('#viewreceiving_return_print_view').html('');
        $('#receivings_view').modal('show');
        var data = response.data;
        $.each(data, function (key, val) {
            if (val === '') {
                $('#receiving_view_' + key).html('');
            } else {
                $('#receiving_view_' + key).html(val);
            }
        });
        $('.receiving_id_print').val(id);
        var updateDate = PosnicPro.convertDate(data.date);
        $('#date_view_receiving').html(updateDate);
        var length = data.items.length;
        $('#receiving_id').val(PosnicPro.record_id);
        var currency = PosnicPro.local.get('currencySign');
        for (var i = 0; i < length; i++) {
            var price = Number(data.items[i].item_price);
            let item_unit = (typeof (data.items[i].item_unit) != "undefined" && data.items[i].item_unit !== null) ? data.items[i].item_unit : 'qty';
            var rowHTMLLine = ' <tr id="receiving_row_' + data.items[i].item_id + '"> ' +
                    '    <td>' + (i + 1) + '</td>' +
                    '    <td data-toggle="tooltip" title="' + data.items[i].item_name + '">' + data.items[i].item_name + '</td>' +
                    '    <td>' + currency + '&nbsp;<span class="number">' + price + '</span> </td>' +
                    '    <td>' + PosnicPro.formatQuantity(data.items[i].item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                    '    <td class="text-right">' + currency + '&nbsp;<span class="number">' + data.items[i].total_amount + '</span> </td>' +
                    '</tr>';

            $('#receiving_print_view tbody').append(rowHTMLLine);
        }

        $('#receiving_view_totals').number((data.items_total), 2);
        PosnicPro.receivings.view._renderPurchaseDebt(data);

        //Return Receiving details
        var length_return = (data.items_return || []).length;
        $('#viewreceiving_return_print_list').remove();
        $('#viewreceiving_return_print_view').append('<div id="viewreceiving_return_print_list">');
        var app = "<div><div class='table-responsive'><table class='table table-borderless'>";
        for (var j = 0; j < length_return; j++) {

            var date = data.items_return[j].returnArray['returnDate'];
            var timeStamp_value = parseInt(date.$date.$numberLong);
            var timeZone = PosnicPro.timeZone();
            var DateFormat = moment(timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
            var updateDate = PosnicPro.convertDate(DateFormat);

            var head = '<thead><tr><td>' + (j + 1) + '</td><td><span class="text-danger">' + data.items_return[j].returnArray['returnId'] + '</span></td><td colspan="4"><span class="text-danger">' + updateDate + '</span></td><td colspan="3">' +
                    '<a href="#/receivings/' + data.items_return[j].returnArray['returnObjId'].$oid + '/returnprint" data-module="receivings" data-access = "read" data-id="receivings/' + data.items_return[j].returnArray['returnObjId'].$oid + '/returnprint" data-toggle="tooltip" title="print" class="point-cursor btn btn-success-rgba"><i class="feather icon-printer"></i></a></td></tr><tr class="row100 head">' +
                    '<th></th>' +
                    '<th width="30%"><lang class="lang_name_title">Name </lang></th>' +
                    '<th width="15%"><lang class="lang_price_title">Price </lang></th>' +
                    '<th width="15%"><lang class="lang_qty_title">Quantity</lang></th>' +
                    '<th width="20%" class="text-center"><lang class="lang_total_title">Total </lang></th>' +
                    '</thead>';
            app = app + '' + head + '';

            $.each(data.items_return[j].returnArray['returnValue'], function (key, val) {
                var price = Number(val.item_price);
                let item_unit = (typeof (val.item_unit) != "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                var body = '<tbody><tr> ' +
                        '<td></td>' +
                        '<td width="30%">' + val.item_name + '</td>' +
                        '<td width="15%">' + currency + '&nbsp;<span class="number">' + price + '</span> </td>' +
                        '<td width="15%">' + PosnicPro.formatQuantity(val.item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                        '<td width="20%" class="text-right">' + currency + '&nbsp;<span class="number">' + val.total_amount + '</span> </td>' +
                        '</tr></tbody>';

                app = app + '' + body + '';
            });
        }
        app = app + '</table></div></div>';
        $('#viewreceiving_return_print_view').append(app);

        $('#receiving_return_view_totals').number(data.items_return_total, 2);
        $('span.number').number(true, 2);

        //receving total
        $('#receiving_subtotal_amount_view').number(data.items_subtotal, 2);
        $('#receiving_return_subtotal_amount_view').number(data.items_return_subtotal, 2);
        $('.percentage-print-hideshow,.amount-print-hideshow').hide();

        // Receiving attachment images / PDFs
        $("#receiving_view_image").html('');

        var images = data.image || [];
        if (!$.isArray(images)) {
            images = images ? [images] : [];
        }

        if (!images.length) {
            $('#show_receiving_image').hide();
        } else {
            $('#show_receiving_image').show();
            $.each(images, function (key, val) {
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

                // Use data: URLs for rendering to bypass CSP blocking http://localhost:5000
                var convertFunction = PosnicPro.convertFileToDataURLviaFileReader;
                convertFunction(image_path, function (base64Img) {
                    if (!base64Img) {
                        return;
                    }

                    if (extension === 'pdf') {
                        var pdfCard = '<div class="col-sm-4">' +
                                '<div class="card" style="border: 1px solid #f0eeee;padding-left: 13px; padding-top: 5px; margin-top: 10px;">' +
                                '<iframe class="card-img-top" src="' + base64Img + '" data-toggle="tooltip" title="' + title + '" style="width: 150px;"></iframe>' +
                                '<div class="card-body">' +
                                // Keep download link pointing to original URL
                                '<a class="btn btn-primary-rgba" id="download_image" href="' + image_path + '" target="_blank" download>Download</a>' +
                                '<div>' +
                                '<div>' +
                                '<div>';
                        $('#receiving_view_image').append(pdfCard);
                    } else {
                        var imgCard = '<div class="col-sm-4">' +
                                '<div class="card" style="border: 1px solid #f0eeee;padding-left: 13px; padding-top: 5px; margin-top: 10px;">' +
                                '<img loading="lazy" decoding="async" class="card-img-top" src="' + base64Img + '" data-toggle="tooltip" title="' + title + '" style="width: 150px;">' +
                                '<div class="card-body">' +
                                '<button class="btn btn-primary-rgba" onclick="downloadImage(\'' + image_path + '\')">Download</button>' +
                                '<div>' +
                                '<div>' +
                                '<div>';
                        $('#receiving_view_image').append(imgCard);
                    }
                });
            });
        }

    },
    /*
     * Paid, every later payment allocated to this purchase, what remains, and
     * the supplier's running account - under the purchase total, mirroring the
     * sale bill. The server joined the statement; this method only paints it.
     */
    _renderPurchaseDebt: function (data) {
        var $body = $('#receiving_view_debt').empty();
        var debt = data && data.debt_account;
        if (!debt) return;
        var cur = PosnicPro.local.get('currencySign') || '$';
        var i18n = function (key, fallback) { return PosnicPro.i18n.t(key, fallback); };
        var money = function (value) { return cur + ' ' + (Number(value) || 0).toFixed(2); };
        var when = function (value) {
            if (!value) return '';
            if (PosnicPro.debts && PosnicPro.debts.formatDateTime) {
                return PosnicPro.debts.formatDateTime(value);
            }
            return String(value).replace('T', ' ').slice(0, 16);
        };
        var total = debt.invoice_total != null
            ? Number(debt.invoice_total) || 0
            : Number(data.invoice_total_declared || data.total_amount || data.items_total) || 0;
        var remaining = debt.invoice_remaining != null
            ? Number(debt.invoice_remaining) || 0
            : Math.max(0, total - (Number(debt.paid_at_sale) || 0) - (Number(debt.paid_later) || 0));
        var paid = Math.min(total, Math.max(0, total - remaining));
        $body.append(
            $('<tr class="q-paid receiving-paid-row">')
                .append($('<td>').text(i18n('lang_paid', 'Paid')))
                .append($('<td class="text-right">').text(money(paid)))
        );
        var payments = [];
        if (Number(debt.paid_at_sale) > 0) {
            payments.push({
                date: data.date || data.created_date,
                label: data.payment_mode || i18n('lang_paid_at_purchase', 'Paid at purchase'),
                amount: Number(debt.paid_at_sale) || 0,
                display: data.date || ''
            });
        }
        (Array.isArray(debt.payments) ? debt.payments : []).forEach(function (payment) {
            if (!(Number(payment.amount) > 0)) return;
            payments.push({
                date: payment.date,
                label: payment.note || payment.reference || i18n('lang_paid_later', 'Paid later'),
                amount: Number(payment.amount) || 0
            });
        });
        if (payments.length) {
            var $cell = $('<td colspan="2">');
            var $list = $('<div class="q-payment-history-list">').appendTo($cell);
            payments.forEach(function (payment) {
                $list.append(
                    $('<div class="q-payment-line">')
                        .append($('<span class="q-payment-date">').text(payment.display || when(payment.date)))
                        .append($('<span class="q-payment-label">').text(payment.label || ''))
                        .append($('<span class="q-payment-amount">').text(money(payment.amount)))
                );
            });
            $body.append($('<tr class="q-payment-history">').append($cell));
        }
        $body.append(
            $('<tr class="q-due receiving-remaining-row">')
                .append($('<th>').text(i18n('lang_remaining', 'Remaining')))
                .append($('<th class="text-right">').text(money(remaining)))
        );
        if (debt.party_id) {
            var $link = $('<a href="javascript:void(0)" class="q-account-link">')
                .text(money(debt.outstanding))
                .on('click', function () {
                    if (PosnicPro.debts && PosnicPro.debts.openStatement) {
                        PosnicPro.debts.openStatement('supplier', String(debt.party_id));
                    }
                });
            $body.append(
                $('<tr class="q-account receiving-account-row">')
                    .append($('<td>').text(i18n('lang_supplier_statement', 'Supplier statement')))
                    .append($('<td class="text-right">').append($link))
            );
        }
    },
    returnPage: function (page, id) {
        $('#show_last_created_receiving').hide();
        $('#v-pills-purchase').addClass('show active');
        $('.purchase-tittle-change').text(PosnicPro.i18n.t('lang_action_return_sale', 'Return'));
        $('table#receiving_print tr#cart_content_area').remove();
        $('.page_loader,#osk-container,#clearReceiving,.chat-search,.receving-return-hide').hide();
        $('.page-title-box,#closeReceiving').show();
        $('#receivings_new').show();
        $('#receiving_add_item_name').focus();
        PosnicPro.receivings.receivingReturnAction = 'return';
//        $('.changeReceivingText').text(PosnicPro.i18n.t('lang_return_title', 'Return'));
        $('.changeReceivingText').text(PosnicPro.i18n.t('lang_action_return_purchase', 'Return'));

        $('#receving_returned_table tbody').html('');
        PosnicPro.receivings.loadEditReceivings(id);
    },
    showReceivingsEditPage: function (id) {
        $('table#receiving_print tr#cart_content_area').remove();
        $('.page_loader,#osk-container,#clearReceiving').hide();
        $('.page-title-box,#closeReceiving,.chat-search,.receving-return-hide').show();
        $('#receivings_new').show();
        db.recevingAutoFocus.get('1').then(function (data) {
            if (data.editReceiving === true) {
                $('#receiving_add_item_name').focus();
            } else {
                $('#receiving_add_item_name').blur();
            }
        });
        PosnicPro.receivings.receivingReturnAction = 'edit';
//        $(".changeReceivingText").text(PosnicPro.i18n.t('lang_refresh_title', 'Update'));
        $('.changeReceivingText').text(PosnicPro.i18n.t('lang_updatebtn_title', 'Update'));

        $('#receiving_submit').removeAttr('disabled');
        $('#receving_returned_table tbody').html('');
        PosnicPro.receivings.loadEditReceivings(id);
    },
    // Purchase printing must work before Settings has populated the hidden templates.
    _preparePurchasePrint: function (render) {
        var view = PosnicPro.receivings.view;
        var a4 = PosnicPro.resolvePrintType() === 'a4';
        view._purchasePrintEvent('purchase-layout-load');
        var fail = function () {
            view._purchasePrintEvent('purchase-layout-failed');
            PosnicPro.alert('error', 'Could not load the purchase print layout. Nothing was sent to the printer. Please try again.');
        };
        PosnicPro.get({ url: 'branches/getOneStore', data: 'id=' + PosnicPro.local.get('branch_id_set') }, function (response) {
            try {
                if (!response || response.type !== 'success' || !response.data) { fail(); return; }
                var data = response.data;
                var template = a4 ? (data.regular_body_print || data.print_a4html) : (data.thermal_body_print || data.print_standard_html);
                var target = $(a4 ? '.import-print' : '.import-standard-print');
                var check = $('<div>').html(template || '');
                var rows = a4 ? '.print-invoice-a4-table-content' : '.print-invoice-table-content';
                if (!target.length || !check.find(rows).length) { fail(); return; }
                target.html(template);
                var fields = { print_store_name: 'branch_name', print_store_city: 'city', print_store_email: 'store_email',
                    print_store_telephone: 'store_telephone', print_store_alternativephone: 'store_alternativephone',
                    print_store_country: 'country', print_store_state: 'state', print_store_pincode: 'pincode' };
                Object.keys(fields).forEach(function (field) { target.find('.' + field).text(data[fields[field]] || ''); });
                render();
            } catch (error) { view._purchasePrintFailed(); }
        }, fail);
    },
    _purchasePrintEvent: function (stage) {
        // Stage-only evidence: no purchase, supplier or item contents leave the renderer.
        try { window.electronAPI?.diagnostics?.event('renderer', { stage: stage }).catch(function () {}); } catch (error) { /* Diagnostics must not block printing. */ }
    },
    _purchasePrintFailed: function () {
        PosnicPro.receivings.view._purchasePrintEvent('purchase-print-failed');
        PosnicPro.alert('error', 'Could not prepare the purchase for printing. Please check the purchase details and try again.');
    },
    printReceivings: function (id, name) {
        PosnicPro.receivings.view._preparePurchasePrint(function () {
            PosnicPro.receivings.view._printReceivings(id, name);
        });
    },
    returnPrintReceivings: function (id) {
        PosnicPro.receivings.view._preparePurchasePrint(function () {
            PosnicPro.receivings.view._returnPrintReceivings(id);
        });
    },
    /*printing the receiving data held by this function*/
    _printReceivings: function (id, name) {
        $('.Hide-Disc,.print-payment-status-hide,.print-sale-notes-hide').hide();
        PosnicPro.get('receivings/' + id, function (response) {
            try {
            if (response.type === 'success') {
                var data = response.data;
                $('#receipt_wrapper').removeClass('receipt_small receipt_medium receipt_large receipt_extra_large');
                let print_size = PosnicPro.local.get('printing_size');
                $('#receipt_wrapper').addClass(print_size);
                $('.print_store_address').html(data.printing_address);
                PosnicPro.record_id = id;
                var currency = PosnicPro.local.get('currencySign');
                $('.percentage-print-hideshow,.amount-print-hideshow').hide();

                if (name === 'receiving') {
                    var subtotal = data.items_subtotal;
                    var receivingLineTotal = (PosnicPro.roundoff === true) ? Math.round(data.items_total).toFixed(2) : Number(data.items_total).toFixed(2);
                    $('.print-total').html('<strong>' + currency + '&nbsp;<span class="number">' + receivingLineTotal + '</span></strong>');
                } else {
                    var subtotal = data.items_return_subtotal;
                    var receivingReturnLineTotal = (PosnicPro.roundoff === true) ? Math.round(data.items_return_total).toFixed(2) : Number(data.items_return_total).toFixed(2);
                    $('.print-total').html('<strong>' + currency + '&nbsp;<span class="number">' + receivingReturnLineTotal + '</span></strong>');
                }
                $('.print-subtotal').html(currency + '&nbsp;<span class="number">' + subtotal.toFixed(2) + '</span>');

                $('.print_view_id').html('#' + data.receiving_id);
                var paidAmount = Number(data.paid_amount);
                if (!(Number.isFinite(paidAmount) && paidAmount > 0) && /^paid$/i.test(String(data.payment_status || ''))) {
                    paidAmount = Number(data.total || data.items_total) || 0;
                }
                $('.print-invoice-payment-mode').text(paidAmount > 0 ? currency + ' ' + paidAmount.toFixed(2) : '');
                $('#barcodeValue').val(data.receiving_id);
                $('.hide_customer_details').show();
                $('.print-custom-title').html(PosnicPro.i18n.t('lang_supplydetails_title', 'Supplier Details'));
                $('.print-name').html(data.supplier_name);
                $('.print-phone').html(data.supplier_phone);
                $('.print-email').html(data.supplier_email);
                $('.print-address').html(data.supplier_address);
                if (data.print_logoimg === true) {
                    $(".branch_image").css("display", "block");
                    let image_path = (PosnicPro.local.get('branchimage') !== "store.png") ? PosnicPro.local.get('branchimage') : 'static/images/default/store.png';
                    $('#printlogoimage img').attr('src', image_path);
                } else {
                    $(".branch_image").css("display", "none");
                }
                if (data.receipt_barcode === true) { PosnicPro.printBarcode(); }
                var length = data.items.length;
                var length_return = data.items_return.length;
                var itemTotalQty = 0;
                $('.print-invoice-a4-table-content tbody').children("tr").remove();
                $('.print-invoice-table-content').html('');
                $('.hide-receiving-print').hide();
                if (name === 'receiving') {
                    $('.print-title').html(PosnicPro.local.get('receiving_title'));
                    $('.print_date').text(data.created_date);
                    if (PosnicPro.resolvePrintType() === 'a4') {
                        for (var i = 0; i < length; i++) {
                            var price = Number(data.items[i].item_price);
                            let item_unit = (typeof (data.items[i].item_unit) !== "undefined" && data.items[i].item_unit !== null) ? data.items[i].item_unit : 'qty';
                            itemTotalQty += data.items[i].item_quantity;
                            let rowHTMLLine = '<tr><td height="1" colspan="5" style="border-top:1px solid #e4e4e4"></td></tr><tr>\n\
                                <td style="font-weight: 600;" class="article print-deatils-size-family print-details-align">' + PosnicPro.textOverflowPrintEllipsis(data.items[i].item_name, PosnicPro.local.get('printing_max_char'), true) + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_price" style="color: #646a6e;" align="center">' + price.toFixed(2) + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_qty" style="color: #646a6e;" align="center">' + PosnicPro.formatQuantity(data.items[i].item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_disc" style="color: #646a6e;" align="center"></td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_total" style="color: #1e2b33;" align="right">' + currency + '&nbsp;<span class="number">' + data.items[i].total_amount + '</span></td>' +
                                '</tr><tr><td height="1" colspan="5" style="border-bottom:1px solid #e4e4e4"></td></tr>';

                            $('table.print-invoice-a4-table-content tbody').append(rowHTMLLine);
                        }
                    } else {
                        for (var i = 0; i < length; i++) {
                            var price = Number(data.items[i].item_price);
                            let item_unit = (typeof (data.items[i].item_unit) !== "undefined" && data.items[i].item_unit !== null) ? data.items[i].item_unit : 'qty';
                            itemTotalQty += data.items[i].item_quantity;
                            let rowHTMLLine = '<div class="row receipt-row-item-holder" style="margin-top:8px;"><div class="col-md-5 col-sm-5 col-xs-5"><div class="invoice-content invoice-con"><div class="invoice-content-heading">' + PosnicPro.textOverflowPrintEllipsis(data.items[i].item_name, PosnicPro.local.get('printing_max_char'), true) + '</div></div></div>' +
                                '<div class="col-md-3 col-sm-3 col-xs-3 gift_receipt_element"><div class="invoice-content item-qty text-left">' + PosnicPro.formatQuantity(data.items[i].item_quantity, item_unit) + ' ' + item_unit + '</div></div>' +
                                '<div class="col-md-4 col-sm-4 col-xs-4 gift_receipt_element"><div class="invoice-content item-total pull-right ">' + currency + '&nbsp;<span class="number">' + price * data.items[i].item_quantity + '</span></div></div></div>';

                            $('.print-invoice-table-content').append(rowHTMLLine);
                        }
                    }
                } else {
                    $('.print-title').html(PosnicPro.local.get('receiving_return_title'));
                    $('.print_date').text(data.updated_date);
                    if (PosnicPro.resolvePrintType() === 'a4') {
                        for (var i = 0; i < length_return; i++) {
                            $.each(data.items_return[i].returnArray['returnValue'], function (key, val) {
                                var price = Number(val.item_price);
                                let item_unit = (typeof (val.item_unit) !== "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                                itemTotalQty += val.item_quantity;
                                let rowHTMLLine = '<tr><td height="1" colspan="5" style="border-top:1px solid #e4e4e4"></td></tr><tr>\n\
                                <td style="color: #506fe4;" class="article print-deatils-size-family print-details-align">' + PosnicPro.textOverflowPrintEllipsis(val.item_name, PosnicPro.local.get('printing_max_char'), true) + '</td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_price" style="color: #646a6e;" align="center">' + price.toFixed(2) + '</td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_qty" style="color: #646a6e;" align="center">' + PosnicPro.formatQuantity(val.item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_disc" style="color: #646a6e;" align="center"></td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_total" style="color: #1e2b33;" align="right">' + currency + '&nbsp;<span class="number">' + val.total_amount + '</span></td>' +
                                    '</tr><tr><td height="1" colspan="5" style="border-bottom:1px solid #e4e4e4"></td></tr>';

                                $('table.print-invoice-a4-table-content tbody').append(rowHTMLLine);
                            });
                        }
                    } else {
                        for (var i = 0; i < length_return; i++) {
                            $.each(data.items_return[i].returnArray['returnValue'], function (key, val) {
                                var price = Number(val.item_price);
                                let item_unit = (typeof (val.item_unit) !== "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                                itemTotalQty += val.item_quantity;
                                let rowHTMLLine = '<div class="row receipt-row-item-holder" style="margin-top:8px;"><div class="col-md-5 col-sm-5 col-xs-5"><div class="invoice-content invoice-con"><div class="invoice-content-heading">' + PosnicPro.textOverflowPrintEllipsis(val.item_name, PosnicPro.local.get('printing_max_char'), true) + '</div></div></div>' +
                                    '<div class="col-md-3 col-sm-3 col-xs-3 gift_receipt_element"><div class="invoice-content item-qty text-left">' + PosnicPro.formatQuantity(val.item_quantity, item_unit) + ' ' + item_unit + '</div></div>' +
                                    '<div class="col-md-4 col-sm-4 col-xs-4 gift_receipt_element"><div class="invoice-content item-total pull-right ">' + currency + '&nbsp;<span class="number">' + price * val.item_quantity + '</span></div></div></div>';

                                $('.print-invoice-table-content').append(rowHTMLLine);
                            });
                        }
                    }
                }
                PosnicPro.toggleVisibility('lineitem_price', '.lineitem_price');
                PosnicPro.toggleVisibility('lineitem_qty', '.lineitem_qty');
                PosnicPro.toggleVisibility('lineitem_disc', '.lineitem_disc');
                PosnicPro.toggleVisibility('lineitem_total', '.lineitem_total');
                PosnicPro.toggleVisibility('print_qty', '.print_qty');
                PosnicPro.toggleVisibility('print_roundoff', '.print_roundoff');

                $('.total-noof-item').html(String(Number(itemTotalQty.toFixed(3))));
                $('span.number').number(true, 2);

                var contents = $(".print-modal-body").html();
                var contentone = $(".print-modal-a4-body").html();
                var canvas = document.getElementById("canvasTarget");
                var img = data.receipt_barcode === true ? canvas.toDataURL("image/png") : '';
                PosnicPro.receivings.view._purchasePrintEvent('purchase-print-dispatch');
                PosnicPro.printView(PosnicPro.resolvePrintType() === 'a4' ? contentone : contents, img);
                $('.invoice-table-content div').empty();
            } else {
                PosnicPro.alert(response.type, response.message);
            }
            } catch (error) { PosnicPro.receivings.view._purchasePrintFailed(); }
        }, function () { PosnicPro.receivings.view._purchasePrintFailed(); });
    },
    /*Perticular Returned printing the receiving data held by this function*/
    _returnPrintReceivings: function (id) {
        $('.print-sale-notes-hide').hide();
        var data = {
            id: id
        };
        var params = {
            url: 'receivings/returnPrintDetails',
            data: data
        };
        PosnicPro.get(params, function (response) {
            try {
                if (response.type === 'success') {
                var data = response.data.custom_data;
                $('#receipt_wrapper').removeClass('receipt_small receipt_medium receipt_large receipt_extra_large');
                let print_size = PosnicPro.local.get('printing_size');
                $('#receipt_wrapper').addClass(print_size);
                PosnicPro.record_id = id;
                var currency = PosnicPro.local.get('currencySign');
                $('.percentage-print-hideshow,.amount-print-hideshow').hide();
                $('.print_date').text(data.date);
                $('.print_view_id').html('#' + data.return_id);
                $('.print-title').html(PosnicPro.local.get('receiving_return_title'));
                $('.print_date').text(data.date);
                $('.print_view_id').html('#' + data.receiving_id);
                $('.print-invoice-payment-mode').text('');
                $('#barcodeValue').val(data.receiving_id);
                $('.hide_customer_details').show();
                $('.print-custom-title').html(PosnicPro.i18n.t('lang_supplydetails_title', 'Supplier Details'));
                $('.print-name').html(data.supplier_name);
                $('.print-phone').html(data.supplier_phone);
                $('.print-email').html(data.supplier_email);
                $('.print-address').html(data.supplier_address);
                if (data.receipt_barcode === true) { PosnicPro.printBarcode(); }
                $('.print-invoice-a4-table-content tbody').children("tr").remove();
                $('.print-invoice-table-content').html('');
                $('.hide-receiving-print').hide();
                var itemTotalQty = 0;
                var subTotal = 0;
                var grandTotal = 0;
                var length = response.data.return_data.length;
                if (PosnicPro.resolvePrintType() === 'a4') {
                    for (var i = 0; i < length; i++) {
                        var price = Number(response.data.return_data[i].item_price);
                        subTotal += (price * response.data.return_data[i].item_quantity);
                        grandTotal += response.data.return_data[i].item_total_amount;
                        let item_unit = (typeof (response.data.return_data[i].item_unit) !== "undefined" && response.data.return_data[i].item_unit !== null) ? response.data.return_data[i].item_unit : 'qty';
                        itemTotalQty += response.data.return_data[i].item_quantity;
                        let rowHTMLLine = '<tr><td height="1" colspan="5" style="border-top:1px solid #e4e4e4"></td></tr><tr>\n\
                                <td style="color: #506fe4;" class="article print-deatils-size-family print-details-align">' + PosnicPro.textOverflowPrintEllipsis(response.data.return_data[i].item_name, PosnicPro.local.get('printing_max_char'), true) + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_price" style="color: #646a6e;" align="center">' + price.toFixed(2) + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_qty" style="color: #646a6e;" align="center">' + PosnicPro.formatQuantity(response.data.return_data[i].item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_disc" style="color: #646a6e;" align="center"></td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_total" style="color: #1e2b33;" align="right">' + currency + '&nbsp;<span class="number">' + response.data.return_data[i].item_total_amount + '</span></td>' +
                                '</tr><tr><td height="1" colspan="5" style="border-bottom:1px solid #e4e4e4"></td></tr>';

                        $('table.print-invoice-a4-table-content tbody').append(rowHTMLLine);
                    }
                } else {
                    for (var i = 0; i < length; i++) {
                        var price = Number(response.data.return_data[i].item_price);
                        subTotal += (price * response.data.return_data[i].item_quantity);
                        grandTotal += response.data.return_data[i].item_total_amount;
                        let item_unit = (typeof (response.data.return_data[i].item_unit) !== "undefined" && response.data.return_data[i].item_unit !== null) ? response.data.return_data[i].item_unit : 'qty';
                        itemTotalQty += response.data.return_data[i].item_quantity;
                        let rowHTMLLine = '<div class="row receipt-row-item-holder" style="margin-top:8px;"><div class="col-md-5 col-sm-5 col-xs-5"><div class="invoice-content invoice-con"><div class="invoice-content-heading">' + PosnicPro.textOverflowPrintEllipsis(response.data.return_data[i].item_name, PosnicPro.local.get('printing_max_char'), true) + '</div></div></div>' +
                            '<div class="col-md-3 col-sm-3 col-xs-3 gift_receipt_element"><div class="invoice-content item-qty text-left">' + PosnicPro.formatQuantity(response.data.return_data[i].item_quantity, item_unit) + ' ' + item_unit + '</div></div>' +
                            '<div class="col-md-4 col-sm-4 col-xs-4 gift_receipt_element"><div class="invoice-content item-total pull-right ">' + currency + '&nbsp;<span class="number">' + price * response.data.return_data[i].item_quantity + '</span></div></div></div>';

                        $('.print-invoice-table-content').append(rowHTMLLine);
                    }
                }
                PosnicPro.toggleVisibility('lineitem_price', '.lineitem_price');
                PosnicPro.toggleVisibility('lineitem_qty', '.lineitem_qty');
                PosnicPro.toggleVisibility('lineitem_disc', '.lineitem_disc');
                PosnicPro.toggleVisibility('lineitem_total', '.lineitem_total');
                PosnicPro.toggleVisibility('print_qty', '.print_qty');
                PosnicPro.toggleVisibility('print_roundoff', '.print_roundoff');

                if (parseFloat(data.discount) > 0) {
                    $('.amount-print-hideshow').show();
                    $('.view_sales_discount').html(currency + '&nbsp;<span class="number">' + data.discount + '</span>');
                }

                $('.total-noof-item').html(String(Number(itemTotalQty.toFixed(3))));
                $('.print-subtotal').html(currency + '&nbsp;<span class="number">' + subTotal + '</span>');
                $('.print-total').html('<strong>' + currency + '&nbsp;<span class="number">' + grandTotal + '</span></strong>');

                $('span.number').number(true, 2);
                var contents = $(".print-modal-body").html();
                var contentone = $(".print-modal-a4-body").html();
                var canvas = document.getElementById("canvasTarget");
                var img = data.receipt_barcode === true ? canvas.toDataURL("image/png") : '';
                PosnicPro.receivings.view._purchasePrintEvent('purchase-print-dispatch');
                PosnicPro.printView(PosnicPro.resolvePrintType() === 'a4' ? contentone : contents, img);
                $('.invoice-table-content div').empty();

            } else {
                PosnicPro.alert(response.type, response.message);
            }
            } catch (error) { PosnicPro.receivings.view._purchasePrintFailed(); }
        }, function () { PosnicPro.receivings.view._purchasePrintFailed(); });
    },
    receivingPdf: function (id) {
        window.open(API_URL + 'receivings/receivingsPdf?id=' + id, "_blank");
    },
    /* Loyverse study L2: the same PDF, mailed to the supplier. Leave the
       address empty to use the supplier's saved email - the server owns
       that lookup and answers honestly when there is none. */
    emailToSupplier: function (id) {
        swal({
            title: PosnicPro.i18n.t('lang_email_purchase_order', 'Email purchase order'),
            text: 'Leave empty to use the supplier\'s saved email address',
            input: 'text',
            inputPlaceholder: 'supplier@example.com (optional)',
            showCancelButton: true,
            confirmButtonText: 'Send'
        }).then(function (result) {
            /*
             * The typed address was being thrown away.
             *
             * This page bundles SweetAlert2 v6, which resolves with the input
             * STRING; the {value, dismiss} object arrived in v7. So
             * `result.value` was always undefined, `to` went up as undefined,
             * the server fell back to the supplier's saved address and
             * answered "the supplier has no email address" - to somebody who
             * had just typed one. The message was true about the supplier and
             * useless about what had happened.
             *
             * Both shapes are read, so upgrading the library later cannot
             * quietly break it back.
             */
            if (result && result.dismiss) { return; }
            var typed = (result && typeof result === 'object') ? result.value : result;
            /* v6 resolves a confirm with `true` when there is nothing typed. */
            typed = String(typed == null || typed === true ? '' : typed).trim();

            PosnicPro.post({
                url: 'receivings/emailToSupplier',
                data: JSON.stringify({ id: id, to: typed || undefined })
            }, function (response) {
                PosnicPro.alert(response.type, response.message);
            }, function (xhr) {
                var resp = {};
                try { resp = JSON.parse(xhr.responseText); } catch (e) { /* plain */ }
                PosnicPro.alert('error', resp.message || 'Could not send the email');
            });
        /* v6 REJECTS with 'cancel' when the dialog is dismissed. Without this
           every cancelled dialog raised an unhandled rejection. */
        }).catch(function () { /* dismissed */ });
    },
    receivedProcess: function (id) {
        PosnicPro.get('receivings/' + id, function (response) {
            if (response.type === 'success') {
                data = response.data;
                var itemDetails = [];
                var itemValue = data.items;
                $(itemValue).each(function (key, val) {

                    let item_unit = val.item_unit;
                    let item_name = val.item_name;
                    let item_price = val.item_price;
                    let item_quantity = val.item_quantity;
                    let item_id = val.item_id;
                    let total_amount = val.total_amount;
                    let barcode_id = val.barcode_id;
                    itemDetails.push({item_unit: item_unit, item_name: item_name, item_price: item_price, item_quantity: item_quantity, item_id: item_id, total_amount: total_amount, barcode_id: barcode_id});
                });
                var params = {
                    url: 'receivings/receivedReceiving',
                    data: JSON.stringify({
                        date: data.date,
                        receiving_total: data.total_amount,
                        supplier_id: data.supplier_id,
                        supplier_name: data.supplier_name,
                        supplier_address: data.supplier_address,
                        supplier_phone: data.supplier_phone,
                        supplier_email: data.supplier_email,
                        supplier_state: data.supplier_state,
                        status: 'Received',
                        discount: data.discount,
                        //discount_percentage: data.discount_percentage,
                        payment_description: data.payment_description,
                        print: ($('.autoprint').is(':checked', true)) ? 'on' : 'off',
                        items: itemDetails,
                        id: id,
                        alternative_id: data.receiving_id,
                        image: data.image
                    })
                };
                PosnicPro.post(params, function (response) {
                    if (response.type === 'success') {

                        PosnicPro.stocklogs.viewLowStockDashboard();
                        if (response.data.print === true) {
                            PosnicPro.receivings.view.printReceivings(response.data.receiving_id, 'receiving');
                        }
                        PosnicPro.receivings.receivingsTable('receivings');
                        PosnicPro.alert(response.type, response.message);
                    } else {
                        PosnicPro.alert(response.type, response.message);
                    }
                }, function (xhr) {
                    var response = jQuery.parseJSON(xhr.responseText);
                    PosnicPro.alert(response.type, response.message);
                });
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        });
    }
};
$('.receiving_id_print').click(function () {
    let name = $(this).data('id');
    PosnicPro.receivings.view.printReceivings(this.value, name);
    var parts = currentHash.split('/');
    hasher.setHash(parts[0] + '/' + this.value);
});
function downloadImage(url) {
    var filename = url.substring(url.lastIndexOf("/") + 1).split("?")[0];
    var xhr = new XMLHttpRequest();
    xhr.responseType = 'blob';
    xhr.onload = function () {
        var a = document.createElement('a');
        a.href = window.URL.createObjectURL(xhr.response); // xhr.response is a blob
        a.download = filename; // Set the file name.
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        delete a;
    };
    xhr.open('GET', url);
    xhr.send();
}