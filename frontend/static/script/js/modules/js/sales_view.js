PosnicPro.sales.view = {
    viewSale: function (id) {
        var loader = $(".loader-view-sale");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        PosnicPro.get('sales/' + id, function (response) {
            if (response.type === 'success') {
                PosnicPro.record_id = id;
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
                } else if (data.sale_process === 'cancelled' || data.sale_process === 'Cancelled') {
                    // Cancelled: act like Sale but hide Return Line Item card
                    $('.sale-view-heading').html(PosnicPro.i18n.t('lang_newsale_title', 'Sale'));
                    $('.hide-sale-return,#salesreturntitleText,#return_print_view,#hide_return_print').hide();
                    // keep normal sale totals visible
                    $('#sales-total-hide,#show_sales_print').show();
                    $('#hide_sales_print,#hide_return_print').hide();
                } else {
                    $('.sale-view-heading').html(PosnicPro.i18n.t('lang_newsale_title', 'Sale'));
                    $('#sales-total-hide,.hide-sale-return,#salesreturntitleText,#return_print_view,#hide_return_print,#show_sales_print').show();
                    $('#hide_sales_print,#hide_return_print').hide();
                }

                PosnicPro.sales.view.viewSaleData(response, id);
                loader.find(".loadingSpinner:first").remove();
            } else {
                PosnicPro.alert(response.type, response.message);
            }
        });
    },
    viewSaleData: function (response, id) {
        $('#viewsale_edit_print_view tbody,#viewsale_return_print_view tbody').children("tr").remove();
        $('#viewsale_edit_print_view,#viewsale_return_print_view tbody').find("tr:not(:first)").remove();
        $('#viewsale_return_print_view, #round_off_view, #return_round_off_view, #extra_discount_view, #return_extra_discount_view').html('');
        $('#sale_view_payment_status').removeClass('badge badge-success-inverse badge badge-warning-inverse');
        $('#payment_status').removeClass('badge badge-success-inverse badge badge-warning-inverse');
        $('#sales_view').modal('show');
        $('.sale_view_hide').hide();
        var data = response.data;
        (data.partial_check === 'true' && data.sale_process !== 'PartialReturn' && data.sale_process !== 'FullReturn') ? $('#sale_view_Transaction_show').show() : $('#sale_view_Transaction_show').hide();
        $.each(data, function (key, val) {
            if (val === '' || val === null) {
                $('#sale_view_' + key).text('');
                $('.sale_view_' + key).hide();
            } else {
                $('#sale_view_' + key).text(val);
                $('.sale_view_' + key).show();
            }
        });

        // A sale records one amount. Legacy tender allocations are summed only
        // to recover that amount; their method labels are not shown.
        var amountPaid = PosnicSalePayments.amount(data);
        var paymentCurrency = PosnicPro.local.get('currencySign') || '';
        $('#sale_view_payment_mode').text(amountPaid > 0
            ? paymentCurrency + ' ' + amountPaid.toFixed(2)
            : '');

        (typeof (data.payment_status) === "undefined" || data.payment_status === null || data.payment_status === 'Paid') ? $('#sale_view_payment_status').addClass('badge badge-success-inverse') : $('#sale_view_payment_status').addClass('badge badge-warning-inverse');
        $('#payment_status').text(data.payment_status);
        (typeof (data.payment_status) === "undefined" || data.payment_status === null || data.payment_status === 'Paid') ? $('#payment_status').addClass('badge badge-success-inverse') : $('#payment_status').addClass('badge badge-warning-inverse');

        $('#salestitleText').html(data.sale_process + ' Details');
        $('.sales_id_print').val(id);

        var updateDate = PosnicPro.convertDate(data.date);
        $('#date_view').html(updateDate);
        var length = data.items.length;
        $('.sales-total-count').html(length);
        $('#sales_view').show();
        var currency = PosnicPro.local.get('currencySign');

        //item line calculation
        for (var i = 0; i < length; i++) {
            var price = Number(data.items[i].item_price);
            var discount = (data.items[i].item_discount > 0) ? data.items[i].item_discount : data.items[i].item_discount_percentage;
            var discountSign = (data.items[i].item_discount > 0) ? currency : '%';

            var discount_percentage = '--';
            if (discount !== 0) {
                if (discountSign === '%') {
                    discount_percentage = '' + discount + ' ' + discountSign + '';
                } else {
                    discount_percentage = '' + discountSign + ' ' + discount + '';
                }
            }
            let item_unit = (typeof (data.items[i].item_unit) !== "undefined" && data.items[i].item_unit !== null) ? data.items[i].item_unit : 'qty';
            var rowHTMLLine = ' <tr> ' +
                '<td>' + (i + 1) + '</td>' +
                '<td width="30%">' + data.items[i].item_name + '</td>' +
                '<td>' + currency + '&nbsp;<span class="number">' + price + '</span> </td>' +
                '<td>' + PosnicPro.formatQuantity(data.items[i].item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                '<td>' + discount_percentage + '</td>' +
                '<td class="text-right">' + currency + '&nbsp;<span class="number">' + data.items[i].total_amount + '</span> </td>' +
                '</tr>';

            $('#viewsale_edit_print_view tbody').append(rowHTMLLine);
        }

        $('.percentage-print-hideshow').hide();
        if (data.discount > 0) {
            $('.percentage-print-hideshow').show();
            $('.sales-discount-text').number(data.discount, 2);
        }

        let roundOffValue = data.round_off;
        let sign = roundOffValue >= 0 ? '+' : '-';
        if (roundOffValue !== 0) {
            let roundOff = '<td><lang class="lang_round_off_2">Round Off :</lang></td>' +
                '<td class="pull-right">' + currency + '&nbsp;(' + sign + ')<span class="number">' + Math.abs(roundOffValue).toFixed(2) + '</span></td>';
            $('#round_off_view').append(roundOff);
        }
        let extraDiscount = '';
        if (data.sale_extra_discount !== 0 && data.sale_extra_discount !== null) {
            extraDiscount = '<td><lang class="lang_extra_discount_2">Extra Discount :</lang></td>' +
                '<td class="pull-right">' + currency + "&nbsp;" + '-' + '<span class="number">' + data.sale_extra_discount + '</span></td>';
        }
        $('#extra_discount_view').html(extraDiscount);
        // Charges itemized on the view page too, mirroring the receipt rows
        $('.charge-view-row').remove();
        if (Array.isArray(data.charges) && data.charges.length) {
            var chargeViewRows = '';
            data.charges.forEach(function (c) {
                chargeViewRows += '<tr class="charge-view-row"><td>' + $('<i>').text((c.name || 'Charge') + (c.source === 'room' && Number(c.percent) > 0 ? ' (' + Number(c.percent) + '%)' : '')).html()
                    + ' :</td>'
                    + '<td class="pull-right">' + currency + '&nbsp;<span class="number">' + (Number(c.amount) || 0).toFixed(2) + '</span></td></tr>';
            });
            $('#extra_discount_view').after(chargeViewRows);
        }
        $('#total_amount_view').number(data.items_total, 2);
        $('#subtotal_amount_view').number(data.items_subtotal, 2);

        //return item line calculation
        var length_return = data.items_return.length;
        $('.sales-return-total-count').html(length_return);
        $('#viewsale_return_print_list').remove();
        $('#viewsale_return_print_view').append('<div id="viewsale_return_print_list">');
        var app = "<div><div class='table-responsive'><table class='table table-borderless'>";
        for (var j = 0; j < length_return; j++) {
            var date = data.items_return[j].returnArray['returnDate'];
            var timeStamp_value = parseInt(date.$date.$numberLong);
            var timeZone = PosnicPro.timeZone();
            var DateFormat = moment(timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
            var updateDate = PosnicPro.convertDate(DateFormat);

            var head = '<thead><tr><td>' + (j + 1) + '</td><td><span class="text-danger">' + data.items_return[j].returnArray['returnId'] + '</span></td><td colspan="4"><span class="text-danger">' + updateDate + '</span></td><td colspan="3">' +
                '<a href="#/sales/' + data.items_return[j].returnArray['returnObjId'].$oid + '/returnprint" data-module="sales" data-access = "read" data-id="sales/' + data.items_return[j].returnArray['returnObjId'].$oid + '/returnprint" data-toggle="tooltip" title="print" class="point-cursor btn btn-success-rgba"><i class="feather icon-printer"></i></a></td></tr><tr class="row100 head">' +
                '<th></th>' +
                '<th><lang class="lang_name_title">Name </lang></th>' +
                '<th><lang class="lang_price_title">Price </lang></th>' +
                '<th><lang class="lang_qty_title">Quantity</lang></th>' +
                '<th> <lang class="lang_discount_title">Discount </lang></th>' +
                '<th class="text-right"><lang class="lang_total_title">Total </lang></th>' +
                '</tr></thead>';
            app = app + '' + head + '';

            $.each(data.items_return[j].returnArray['returnValue'], function (key, val) {
                var price = Number(val.item_price);
                var discount = (val.item_discount > 0) ? val.item_discount : val.item_discount_percentage;
                var discountSign = (val.item_discount > 0) ? currency : '%';

                var returndiscount_percentage = '--';
                if (discount !== 0) {
                    if (discountSign === '%') {
                        returndiscount_percentage = '' + discount + ' ' + discountSign + '';
                    } else {
                        returndiscount_percentage = '' + discountSign + ' ' + discount + '';
                    }
                }
                let item_unit = (typeof (val.item_unit) != "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                var body = '<tbody><tr id="return_col"> ' +
                    '<td></td>' +
                    '<td width="30%">' + val.item_name + '</td>' +
                    '<td>' + currency + '&nbsp;<span class="number">' + price + '</span> </td>' +
                    '<td>' + PosnicPro.formatQuantity(val.item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                    '<td>' + returndiscount_percentage + '</td>' +
                    '<td class="text-right">' + currency + '&nbsp;<span class="number">' + val.total_amount + '</span> </td>' +
                    '</tr></tbody>';

                app = app + '' + body + '';
            });
        }
        app = app + '</table></div></div>';
        $('#viewsale_return_print_view').append(app);

        $('span.number').number(true, 2);

        if (data.return_discount > 0) {
            $('.return-percentage-print-hideshow').show();
            $('.sales-return-discount-value').number(data.return_discount, 2);
        }

        roundOffValue = data.return_round_off;
        sign = roundOffValue >= 0 ? '+' : '-';
        let roundOff = '';
        if (roundOffValue !== 0) {
            roundOff = '<td><lang class="lang_round_off_2">Round Off :</lang></td>' +
                '<td class="pull-right">' + currency + '&nbsp;(' + sign + ')<span class="number">' + Math.abs(roundOffValue).toFixed(2) + '</span></td>';
        }
        let returnExtraDiscount = '';
        if (data.return_extra_discount !== 0 && data.return_extra_discount !== null) {
            returnExtraDiscount = '<td><lang class="lang_extra_discount_2">Extra Discount :</lang></td>' +
                '<td class="pull-right">' + currency + '<span class="number">' + "&nbsp;" + '-' + data.return_extra_discount + '</span></td>';
        }
        $('#return_extra_discount_view').append(returnExtraDiscount);
        $('#return_round_off_view').append(roundOff);
        $('#return_total_amount_view').number(data.items_return_total, 2);
        $('#return_subtotal_amount_view').number(data.items_return_subtotal, 2);
    },
    showSalesEditPage: function (id) {
        var loader = $(".loader-edit-sale");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        PosnicPro.get('sales/' + id, function (response) {
            if (response.type === 'success') {
                data = response.data;
                PosnicPro.sales.editSaleId = data._id || data.id || data.sales_document_id || id;

                let extra_discount_type = data.extra_discount_type;
                let extra_discount = data.extra_discount;
                $('#extraDisc').text(extra_discount);
                $('#extraDisc').editable('setValue', extra_discount);
                PosnicPro.sales.view.changeExtraDiscType(extra_discount_type);
                if (PosnicPro.local.get('inline_sale') === 'enable' || extra_discount !== 0) {
                    $('.addDisc-hide-show').show();
                } else {
                    $('.addDisc-hide-show').hide();
                    $('#extraDisc').text(0);
                    $('#extraDisc').editable('setValue', 0);
                }
                $('#extraDisc').prop('disabled', false);
                $('#extraDisc').removeClass('extraDisc');
                if (data.sale_process === 'Add' || data.sale_process === 'Edit' || data.sale_process === 'Hold' || data.sale_process === 'PartialReturn') {
                    $('#receiving_add_item_name,#sales_new_item_name').val('');
                    $('.page_loader,#osk-container,#clearSaleButton,.return_discount_show').hide();
                    if (PosnicPro.sales && PosnicPro.sales.syncActionTooltips) { PosnicPro.sales.syncActionTooltips(); }
                    $('.page-title-box,#sales_new_item_name,#sales_new,#closeSaleButton,.return_discount_hide').show();
                    $('.changeSalesBtnText').text(PosnicPro.i18n.t('lang_updatebtn_title', 'Update'));
                    //                    $(".changeSalesBtnText").text(PosnicPro.i18n.t('lang_refresh_title', 'Update'));
                    $('#holdSaleButton').hide();

                    /*New Sales*/
                    PosnicPro.sales.recentMenu.editItems(id, response.data, 'edit');
                    loader.find(".loadingSpinner:first").remove();
                } else {
                    $('#edit_sales_' + id).css('pointer-events', 'none');
                    $('#edit_icon_' + id).addClass('sales_icons');
                    hasher.setHash('sales');
                }
            }

        });
    },
    /*For Sales Return action*/
    returnPage: function (page, id) {
        PosnicPro.sales.defaultCustomer = false;
        $('#extraDisc').text(0);
        $('#extraDisc').editable('setValue', 0);
        $('#extraDisc').prop('disabled', true);
        $('#extraDisc').addClass('extraDisc');
        $('#percentIcon, #rupeeIcon').css('pointer-events', 'none').css('opacity', '0.8');
        $("#paymentreturnhistory").hide();
        $("#sales_new_items_table tbody tr").remove();
        $('.salesBalanceAmount,#payment_id').show();
        $("#save_submit,#check_button").attr("disabled", true);
        $("#sales_new_items_table,#paymentdisplay,#return_disc,#return_discount").addClass("customer-display-hide");
        $("#sales_new_items_table,#paymentdisplay").removeClass("display-block");
        $("#refund_pay_hide,#refund_pay_total,#refund_sub_hide,#refund_sub_total").show();
        $(".save_return_submit,#sub_hide,#sub_total_hide,#pay_hide,#pay_total_hide,#show_last_created_sale").hide();
        $("#check_button,#return_button,.return_discount_show").show();
        $("#return_button").removeAttr("disabled");
        $("#items_view_hide,#holdSaleButton,.return_discount_hide").css("display", "none");
        $("#return_view_hide,#button_return").css("display", "block");
        $('.sales_discount_return_value').text("0.00");

        $('.return_sale_only_show').show();
        $("#sales-text-change").text(PosnicPro.i18n.t('lang_action_return_sale', 'Return'));
        $(".return_table_head_hide").text(PosnicPro.i18n.t('lang_returning', 'Returning'));
        $(".sale_table_head_hide").text(PosnicPro.i18n.t('lang_sold', 'Sold'));
        $(".return_table_head_text").text(PosnicPro.i18n.t('lang_cancel_return', 'Cancel Return'));
        $(".sale_table_head_text").text(PosnicPro.i18n.t('lang_move_to_return', 'Move to Return'));
        //sold item table
        var myobj = document.getElementById("table_return_page");
        myobj.remove();
        var newDiv = document.createElement("div");
        newDiv.id = "table_return_page";
        var element = document.getElementById("table_return_page_parent");
        element.appendChild(newDiv);
        $('#sales_table').find('table').attr('id', 'sales_new_items_table');
        var sales_table = $("#sales_table").html();
        $("#table_return_page").html(sales_table);
        $("#viewtest").hide();

        //return item table
        var myobj = document.getElementById("table_sale_page");
        myobj.remove();
        var newDiv = document.createElement("div");
        newDiv.id = "table_sale_page";
        var element = document.getElementById("table_sale_page_parent");
        element.appendChild(newDiv);
        $('#return_table').find('table').attr('id', 'sales_return_items_table');
        var return_table = $("#return_table").html();
        $("#table_sale_page").html(return_table);
        $("#return_view_hide").hide();
        //call edit value load function
        PosnicPro.sales.view.showReturnSalesProcess(id);
        //remove table id
        $('#sales_table').find('table').removeAttr('id');
        $('#return_table').find('table').removeAttr('id');
        $('#time-format').addClass('commonDate');
        $('#time-format').removeClass('commonEditDate');
    },
    showReturnSalesProcess: function (id) {
        var loader = $(".loader-return-sale");
        $("<div class='loadingSpinner'></div>").appendTo(loader);
        PosnicPro.get('sales/' + id, function (response) {
            if (response.type === 'success') {
                data = response.data;

                // For returns we always work with the resolved currency
                // extra discount amount stored in sale_extra_discount.
                // This is already the final rupee value regardless of
                // whether the original discount was a percentage or a
                // fixed amount.
                var rawSalesTotal = (parseFloat(data.sales_total || 0) || 0);
                var rawRoundOff = (parseFloat(data.sales_round_off || 0) || 0);
                var extraDiscountType = (data.extra_discount_type || '').toString().toLowerCase();
                var extraDiscountInput = (data.extra_discount !== null && data.extra_discount !== undefined)
                    ? parseFloat(data.extra_discount)
                    : 0;
                var saleExtraDiscountAmount = (data.sale_extra_discount !== null && data.sale_extra_discount !== undefined)
                    ? parseFloat(data.sale_extra_discount)
                    : 0;

                var absoluteSaleExtraDiscount = !isNaN(saleExtraDiscountAmount) ? saleExtraDiscountAmount : 0;
                if (absoluteSaleExtraDiscount === 0 && !isNaN(extraDiscountInput) && extraDiscountInput !== 0) {
                    if (extraDiscountType === 'percent') {
                        var itemsAfterExtra = rawSalesTotal - rawRoundOff;
                        if (itemsAfterExtra > 0) {
                            var rate = extraDiscountInput / 100;
                            var baseBeforeExtra = itemsAfterExtra / (1 - rate);
                            absoluteSaleExtraDiscount = baseBeforeExtra - itemsAfterExtra;
                        }
                    } else {
                        absoluteSaleExtraDiscount = extraDiscountInput;
                    }
                }
                if (isNaN(absoluteSaleExtraDiscount)) {
                    absoluteSaleExtraDiscount = 0;
                }

                var baseSalesTotal = rawSalesTotal + absoluteSaleExtraDiscount - rawRoundOff;

                var saleExtraValueForReturn;
                if (extraDiscountType === 'percent') {
                    if (!isNaN(extraDiscountInput) && extraDiscountInput !== 0) {
                        saleExtraValueForReturn = extraDiscountInput;
                    } else if (baseSalesTotal > 0 && absoluteSaleExtraDiscount > 0) {
                        saleExtraValueForReturn = (absoluteSaleExtraDiscount / baseSalesTotal) * 100;
                    } else {
                        saleExtraValueForReturn = 0;
                    }
                } else {
                    saleExtraValueForReturn = absoluteSaleExtraDiscount;
                }

                PosnicPro.sales.extraDiscount = {
                    sales_total: baseSalesTotal,
                    sale_extra_discount: saleExtraValueForReturn,
                    extra_discount_type: extraDiscountType,
                    sales_round_off: rawRoundOff
                };

                // Populate the (read-only) Extra Discount field on the
                // return summary with the original sale's extra discount
                // value so that users immediately see it when opening the
                // Return screen. For amount-based discounts we display the
                // resolved rupee amount; for percentage discounts we show
                // the percentage.
                var uiExtraDiscount;
                if (extraDiscountType === 'percent') {
                    uiExtraDiscount = saleExtraValueForReturn;
                } else {
                    uiExtraDiscount = absoluteSaleExtraDiscount;
                }
                if (!isNaN(uiExtraDiscount) && uiExtraDiscount !== 0) {
                    var uiExtraFormatted = Number(uiExtraDiscount).toFixed(2);
                    $('#extraDisc').text(uiExtraFormatted);
                    $('#extraDisc').editable('setValue', uiExtraFormatted);
                }

                if (absoluteSaleExtraDiscount !== 0) {
                    $('.addDisc-hide-show').show();
                } else {
                    $('.addDisc-hide-show').hide();
                    $('#extraDisc').text(0);
                    $('#extraDisc').editable('setValue', 0);
                }
                if (data.discount_amount > 0) {
                    $('#salesReturnSign').html('$');
                    $("#sales_return_discountpercent").html(data.discount_amount);
                } else {
                    $('#salesReturnSign').html('%');
                    $("#sales_return_discountpercent").html(data.discount);
                }

                if (data.partial_check === 'true') {
                    $("#paymentreturnhistory").show();
                    $('.duebalance').number(data.payment_pending, 2);
                    $('.payreturnamount').number(PosnicSalePayments.amount(data), 2);
                }

                if (data.sale_process === 'Add' || data.sale_process === 'PartialReturn' || data.sale_process === 'FullReturn' || data.sale_process === 'Edit') {
                    $('#receiving_add_item_name,#sales_new_item_name').val('');
                    $('.page_loader,#osk-container,#clearSaleButton').hide();
                        if (PosnicPro.sales && PosnicPro.sales.syncActionTooltips) { PosnicPro.sales.syncActionTooltips(); }
                    $('.page-title-box,#sales_new,#closeSaleButton').show();
                    /*New Sales*/
                    $('#sales_new_item_name').focus();
                    PosnicPro.sales.recentMenu.editItems(id, response.data, 'return');
                    $('#sales_returned_table tbody').html('');
                    $('#sale_return_view_table').html('');
                    $('#sale_return_view_list').remove();
                    $('#sale_return_view_table').append('<div id="sale_return_view_list">');
                    var currency = PosnicPro.local.get('currencySign');
                    (response.data.items_return.length !== 0) ? $('#show-sale-already-return-table').show() : $('#show-sale-already-return-table').hide();
                    var app = "<div><h4 class='text-center' style='display:none;' id='show-sale-already-return-table'>Already Returned</h4><div class='table-responsive'><table id='table_return_item_length' class='table style='background:#f3f5fd;'>";
                    for (var i = 0; i < response.data.items_return.length; i++) {
                        var date = response.data.items_return[i].returnArray['returnDate'];
                        var timeStamp_value = parseInt(date.$date.$numberLong);
                        var timeZone = PosnicPro.timeZone();
                        var DateFormat = moment(timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
                        var updateDate = PosnicPro.convertDate(DateFormat);
                        var head = '<thead><tr><td colspan="5"></td></tr><tr style="background:#e1e6f5;">' +
                            '<td>' + (i + 1) + '</td><td colspan="2"><span class="text-danger">' + response.data.items_return[i].returnArray['returnId'] + '</span></td><td colspan="2"><span class="text-danger">' + updateDate + '</span></td></tr>' +
                            '<tr><th class="text-left"><lang class="lang_name_title">Name </lang></th>' +
                            '<th class="text-right"><lang class="lang_price_title">Price </lang></th>' +
                            '<th class="text-center"><lang class="lang_qty_title">Quantity</lang></th>' +
                            '<th class="text-center"> <lang class="lang_discount_title">Discount </lang></th>' +
                            '<th class="text-right"><lang class="lang_total_title">Total </lang></th>' +
                            '</tr></thead>';
                        app = app + '' + head + '';
                        var total = 0, priceValue = 0, discountTotal = 0;
                        returnRoundOff = response.data.items_return[i].returnArray.roundOff;
                        returnExtraDiscount = response.data.items_return[i].returnArray.extraDiscount;
                        returnTotal = response.data.items_return[i].returnArray.itemsTotalAmount;
                        $.each(response.data.items_return[i].returnArray['returnValue'], function (key, val) {
                            total += val.total_amount;

                            var addSalesLineDiscount = (val.item_discount > 0) ? val.item_discount : val.item_discount_percentage;
                            var discountSign = (val.item_discount > 0) ? currency : '%';
                            var price = Number(val.item_price);
                            priceValue += (price * val.item_quantity);

                            var discount_percentage = '--';
                            if (addSalesLineDiscount !== 0) {
                                if (discountSign === '%') {
                                    discount_percentage = '' + addSalesLineDiscount + ' ' + discountSign + '';
                                    discountTotal += (((price.toFixed(2)) * val.item_quantity) * (addSalesLineDiscount / 100));
                                } else {
                                    discount_percentage = '' + discountSign + ' ' + addSalesLineDiscount + '';
                                    discountTotal += (addSalesLineDiscount * val.item_quantity);
                                }
                            }
                            var body = '<tbody><tr>' +
                                '    <td  class="text-left" width="30%">' + val.item_name + '</td>' +
                                '    <td class="text-right">' + currency + '&nbsp;<span class="number">' + price.toFixed(2) + '</span></td>' +
                                '    <td class="text-center">' + val.item_quantity + '</td>' +
                                '    <td class="text-center">' + discount_percentage + '</td>' +
                                '    <td class="text-right">' + currency + '&nbsp;<span class="number">' + val.total_amount.toFixed(2) + '</span></td>' +
                                '</tr></tbody>';

                            app = app + '' + body + '';
                            $('table#sales_return_items_table tr#sales_new_tablerow_content_area').remove();
                        });
                        let returnViewRoundOff = (returnRoundOff !== 0) ? returnRoundOff : 0.00;
                        let returnViewExtraDiscount = (returnExtraDiscount !== 0) ? returnExtraDiscount : 0.00;
                        let sign = returnViewRoundOff >= 0 ? '(+)' : '(-)';
                        let returnViewTotal = (returnTotal !== 0) ? returnTotal : total;
                        var foot = '<tbody>' +
                            '<tr><td colspan="4"><span class="pull-right"><b><lang class="lang_sub_total">Sub Total</lang></b></span></td><td><span class="pull-right"><b>' + currency + '&nbsp;' + priceValue.toFixed(2) + '</b></span></td></tr>' +
                            '<tr><td colspan="4"><span class="pull-right"><b><lang class="lang_discount_amount_2">Discount Amount</lang></b></span></td><td><span class="pull-right">-<b>' + currency + '&nbsp;' + discountTotal.toFixed(2) + '</b></span></td></tr>' +
                            '<tr><td colspan="4"><span class="pull-right"><b><lang class="lang_round_off">Round Off</lang></b></span></td><td><span class="pull-right"><b>' + currency + '&nbsp;' + sign + '&nbsp;' + Math.abs(returnViewRoundOff).toFixed(2) + '</b></span></td></tr>' +
                            '<tr><td colspan="4"><span class="pull-right"><b><lang class="lang_extra_discount">Extra Discount</lang></b></span></td><td><span class="pull-right"><b>' + currency + '&nbsp;' + Math.abs(returnViewExtraDiscount).toFixed(2) + '</b></span></td></tr>' +
                            '<tr><td colspan="4"><span class="pull-right"><b><lang class="lang_grand_total">Grand Total</lang></b></span></td><td><span class="pull-right"><b>' + currency + '&nbsp;' + returnViewTotal.toFixed(2) + '</b></span></td></tr>' +
                            '<tr><td colspan="5"></td></tr></tbody>';
                        app = app + '' + foot + '';
                    }
                    app = app + '</table></div></div>';                    app = app + '</table></div></div>';
                    $('#sale_return_view_list').append(app);
                    $("#sale_return_view_list").insertAfter($("#table_return_page"));
                    ($('table#table_return_item_length tbody tr').length > 0) ? $('#show-sale-already-return-table').show() : $('#show-sale-already-return-table').hide();
                    $('span.number').number(true, 2);

                    $('.sales-inline-hide').hide();
                } else {
                    $('#return_sales_' + id).css('pointer-events', 'none');
                    $('#return_icon_' + id).addClass('sales_icons');
                    hasher.setHash('sales');
                }
                $('span.number').number(true, 2);
                $("#sales_return_items_table tbody tr").remove();
                $('#sales_return_items_table tbody').append('<tr class="sales_new_tablerow_content_area" id="sales_new_tablerow_content_area"><td colspan="9"><div class="text-center text-dark"> <p class="table_cart_content"> Return Items Order Empty</p></div><img loading="lazy" decoding="async" src="static/images/general/wallet.svg" class="img-fluid sales-cart-image" style="opacity: 0.4;width: 100%;" alt="wallet"></td></tr>');
                var imgHeight = $(window).height() - 500;
                $('.sales-cart-image').height(imgHeight);
                let extra_discount_type = data.extra_discount_type;
                PosnicPro.sales.view.changeExtraDiscType(extra_discount_type);
            } else {
                PosnicPro.alert(response.type, response.message);
            }
            loader.find(".loadingSpinner:first").remove();
        });
    },
    /*sold order printing process held by this function for normal sale order*/
    /*
     * Which paper this print uses. Normally the shop's Print Type setting
     * decides, but the post-sale panel can ask for one explicitly (owner:
     * "Print recept i would like to have thermal as well a4 option"), so an
     * override wins for the duration of that one print and is cleared after.
     */
    _layoutOverride: null,
    /*
     * Amount in words - the usual defence against a hand-altered figure.
     * Uses the Western short scale (thousand / million / billion).
     */
    _amountInWords: function (amount) {
        var n = Math.abs(Number(amount) || 0);
        var minor = Math.round(n * 100);
        var whole = Math.floor(minor / 100);
        var frac = minor % 100;
        var ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
            'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
            'Seventeen', 'Eighteen', 'Nineteen'];
        var tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
        function two(x) {
            if (x < 20) { return ones[x]; }
            return tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '');
        }
        function three(x) {
            var h = Math.floor(x / 100), r = x % 100;
            return (h ? ones[h] + ' Hundred' + (r ? ' and ' : '') : '') + (r ? two(r) : '');
        }
        function western(x) {
            if (x === 0) { return 'Zero'; }
            var scales = ['', ' Thousand', ' Million', ' Billion', ' Trillion'];
            var parts = [];
            var index = 0;
            while (x > 0 && index < scales.length) {
                var chunk = x % 1000;
                if (chunk) { parts.unshift(three(chunk) + scales[index]); }
                x = Math.floor(x / 1000);
                index += 1;
            }
            return parts.join(' ');
        }
        var currencyName = PosnicPro.local.get('currency_setting') || PosnicPro.local.get('currencyTextname') || '';
        var out = western(whole) + (currencyName ? ' ' + currencyName : '');
        if (frac > 0) { out += ' and ' + String(frac).padStart(2, '0') + '/100'; }
        return out + ' Only';
    },
    _isA4: function () {
        if (PosnicPro.sales.view._layoutOverride) {
            return PosnicPro.sales.view._layoutOverride === 'a4';
        }
        // read the setting directly here - this IS the base case
        return typeof print_type !== 'undefined' && print_type && String(print_type.value) === 'a4';
    },
    /*
     * The receipt templates (thermal and A4) are injected into their modal
     * bodies by the Settings page. A till that never opened Settings has an
     * EMPTY A4 body, so asking for an A4 invoice printed a blank sheet -
     * a feature depending on a page
     * the user had no reason to visit. Fetch them on demand instead, once.
     */
    _ensurePrintTemplates: function (done) {
        var wantA4 = PosnicPro.sales.view._isA4();
        var $body = wantA4 ? $('.print-modal-a4-body') : $('.print-modal-body');
        if ($.trim($body.html() || '').length > 0) { done(); return; }
        var branchId = PosnicPro.local.get('branch_id_set');
        PosnicPro.get({ url: 'branches/getOneStore', data: 'id=' + branchId }, function (r) {
            var d = (r && r.data) || {};
            if (wantA4) {
                $('.import-print').html(d.regular_body_print || d.print_a4html || '');
            } else {
                $('.import-standard-print').html(d.thermal_body_print || d.print_standard_html || '');
            }
            done();
        }, function () { done(); /* print what we have rather than nothing */ });
    },
    printSale: function (id, name, layoutOverride) {
        PosnicPro.sales.view._layoutOverride =
            (layoutOverride === 'a4' || layoutOverride === 'standard') ? layoutOverride : null;
        /* The PAPER has to follow the same choice. printView resolves the page
           size and stylesheet from the shop setting, so picking A4 content
           without this printed the invoice onto an 80mm thermal page. */
        PosnicPro._printTypeOverride = PosnicPro.sales.view._layoutOverride;

        $('.Hide-Disc').show();

        PosnicPro.get('sales/' + id, function (response) {
            // A failed lookup used to end here in silence, so pressing Print
            // Receipt appeared to do nothing at all. Say what went wrong.
            if (!response || response.type !== 'success') {
                var reason = (response && response.message)
                    ? response.message
                    : PosnicPro.i18n.t('lang_could_not_load_this_sale_to_print_check_th', 'Could not load this sale to print. Check that you are still signed in, then try again.');
                if (PosnicPro.alert) PosnicPro.alert('error', reason);
                console.error('[print] sales/' + id + ' failed:', response);
                // a print that never happened must not leave its paper choice
                // behind - otherwise every later receipt inherits it
                PosnicPro._printTypeOverride = null;
                PosnicPro.sales.view._layoutOverride = null;
                return;
            }
            if (response.type === 'success') {
                var data = response.data;
                PosnicPro.record_id = id;
                // The designer renders directly from sale data. Legacy templates
                // and their barcode canvas may not exist on a fresh offline till.
                if (name === 'sale' && PosnicPro.receiptDesigner && !/Return/.test(data.sale_process || '')) {
                    PosnicPro.receiptDesigner.printSale(data, PosnicPro.sales.view._layoutOverride);
                    PosnicPro._printTypeOverride = null;
                    PosnicPro.sales.view._layoutOverride = null;
                    return;
                }
                PosnicPro.sales.view.renderSaleDocument(data, name);

                var contents = $(".print-modal-body").html();
                var contentone = $(".print-modal-a4-body").html();
                var canvas = document.getElementById("canvasTarget");
                var img = data.receipt_barcode === true ? canvas.toDataURL("image/png") : '';

                PosnicPro.printView(PosnicPro.sales.view._isA4() ? contentone : contents, img);
                // one print only - the next follows the shop setting again
                PosnicPro._printTypeOverride = null;
                PosnicPro.sales.view._layoutOverride = null;

                $('.invoice-table-content div').empty();
            } else {
                PosnicPro.alert(response.type, response.message);
                PosnicPro._printTypeOverride = null;
                PosnicPro.sales.view._layoutOverride = null;
            }
        }, function (xhr) {
            /* There was no error handler here at all, so a dropped request
               left the paper choice set and the NEXT receipt printed on the
               wrong stock with nothing to explain it. */
            PosnicPro._printTypeOverride = null;
            PosnicPro.sales.view._layoutOverride = null;
            if (PosnicPro.alert) {
                PosnicPro.alert('error', PosnicPro.i18n.t('lang_could_not_reach_the_server_to_print_this_r', 'Could not reach the server to print this receipt - try again.'));
            }
            console.error('[print] sales/' + id + ' request failed:', xhr && xhr.status);
        });
    },
    /* Shared by printing and the unsaved sale preview. A detached root keeps
     * preview rendering away from the cart, print modals and payment state. */
    renderSaleDocument: function (data, name, root, layout) {
        var $ = jQuery;
        if (root) {
            $ = function (selector) {
                return typeof selector === 'string' && selector.charAt(0) !== '<'
                    ? root.find(selector) : jQuery(selector);
            };
            jQuery.extend($, jQuery);
        }
        var transferredBill = name === 'sale' ? data.transferred_bill : null;
        var moneyDigits = transferredBill && Number.isInteger(transferredBill.currencyDigits)
            && transferredBill.currencyDigits >= 0 && transferredBill.currencyDigits <= 4
            ? transferredBill.currencyDigits : 2;
        if (transferredBill) {
            // Keep the input immutable: the editor and subsequent reprints share it.
            data = jQuery.extend({}, data, {
                items_total: transferredBill.total,
                items_subtotal: transferredBill.subTotal,
                discount: transferredBill.discount,
                round_off: transferredBill.roundOff
            });
        }
        var isA4Layout = layout ? layout === 'a4' : PosnicPro.sales.view._isA4();
        var $printContainer = isA4Layout ? $('.print-modal-a4-body') : $('.print-modal-body');
        $('.header-content, .footer-content').css('white-space', 'pre-line');
        $('.Hide-Disc').show();
                $('#receipt_wrapper').removeClass('receipt_small receipt_medium receipt_large receipt_extra_large');
                let print_size = data.printing_size || PosnicPro.local.get('printing_size');
                $('#receipt_wrapper').addClass(print_size);
                $('.print_store_address').html(data.printing_address);
                var currency = PosnicPro.local.get('currencySign');
                $('.amount-print-hideshow,.print-payment-status-hide').hide();

                // Determine whether current print is A4 or thermal (standard) layout

                // Reset thermal-only partial payment rows on every print
                $('.thermal-partial-row').hide();

                if (data.partial_check === 'true' && data.sale_process !== 'PartialReturn' && data.sale_process !== 'FullReturn') {
                    // NOTE: This block matches the original behavior for this section.
                    $('.print-payment-status-hide').hide();
                    $('.print-payment-balance').html(currency + '&nbsp;' + data.partial_balance.toFixed(moneyDigits));
                    $('.print-payment-pending').html(currency + '&nbsp;' + data.payment_pending.toFixed(moneyDigits));
                    $('.print-payment-status').html(data.payment_status);

                    // Thermal (non-A4) receipts: show compact payment and balance-due
                    // rows in the footer, mirroring the A4 invoice behaviour.
                    if (!isA4Layout) {
                        $('.thermal-partial-row').show();
                    }
                }
                let extraDisValue = data.sale_extra_discount !== null ? data.sale_extra_discount : 0;
                let extraDiscPrintView = '';
                let extraDiscStandardPrint = '';
                if (extraDisValue !== 0) {
                    extraDiscPrintView =
                        '<td class="print-deatils-size-family print-footer-align"> Extra-Discount:  &nbsp; &nbsp; </td>' +
                        '<td class="print-deatils-size-family print-footer-align">' +
                        currency + '&nbsp; - <span class="number">' + extraDisValue + '</span></td>';
                    extraDiscStandardPrint =
                        '<div class="col-md-8 col-sm-8 col-xs-6">' +
                        '<div class="invoice-footer-value"><lang class="lang_extra_disc_2">Extra discount</lang></div>' +
                        '</div>' +
                        '<div class="col-md-4 col-sm-4 col-xs-6">' +
                        '<div class="invoice-footer-value invoice-payment text-dark">' + currency + " &nbsp;" + '-' + extraDisValue + '</div>' +
                        '</div>';
                }
                $('#extra_disc_print_view').html(extraDiscPrintView);
                $('#extra_disc_standard_print').html(extraDiscStandardPrint);
                // Charge rows on the receipt (queue #6): every named charge
                // prints as its own footer row, after the discount row and
                // before Round-Off.
                // Inserted as SIBLINGS (the containers are single rows) and
                // swept first so a reprint can never stack duplicates.
                $('.charge-print-row, .charge-print-row-std').remove();
                if (name === 'sale' && Array.isArray(data.charges) && data.charges.length) {
                    var chargesA4 = '';
                    var chargesStd = '';
                    data.charges.forEach(function (c) {
                        var cName = $('<i>').text((c.name || 'Charge') + (c.source === 'room' && Number(c.percent) > 0 ? ' (' + Number(c.percent) + '%)' : '')).html();
                        var cAmt = (Number(c.amount) || 0).toFixed(moneyDigits);
                        chargesA4 += '<tr class="charge-print-row">' +
                            '<td class="print-deatils-size-family print-footer-align">' + cName + ': &nbsp; &nbsp; </td>' +
                            '<td class="print-deatils-size-family print-footer-align">' + currency + '&nbsp;<span class="number">' + cAmt + '</span></td></tr>';
                        chargesStd += '<div class="row charge-print-row-std">' +
                            '<div class="col-md-8 col-sm-8 col-xs-6"><div class="invoice-footer-value">' + cName + '</div></div>' +
                            '<div class="col-md-4 col-sm-4 col-xs-6"><div class="invoice-footer-value invoice-payment text-dark">' + currency + '&nbsp;' + cAmt + '</div></div></div>';
                    });
                    $('#extra_disc_print_view').after(chargesA4);
                    $('#extra_disc_standard_print').after(chargesStd);
                }
                if (name === 'sale') {
                    var subtotal = data.items_subtotal;
                    var salesLineTotal = Number(data.items_total).toFixed(moneyDigits);
                    $('.round-off-hideshow').hide();
                    let roundOffValue = data.round_off;
                    let sign = roundOffValue >= 0 ? '+' : '-';
                    let roundOff = '';
                    let roundOffStandardPrint = '';
                    if (roundOffValue !== 0) {
                        $('.round-off-hideshow').show();
                        roundOff =
                            '<td class="print-deatils-size-family print-footer-align"> Round-Off: &nbsp; &nbsp; </td>' +
                            '<td class="print-deatils-size-family print-footer-align">' +
                            currency + '&nbsp;(' + sign + ')&nbsp;<span class="number">' + Math.abs(roundOffValue).toFixed(moneyDigits) + '</span></td>';
                        roundOffStandardPrint =
                            '<div class="col-md-8 col-sm-8 col-xs-6">' +
                            '<div class="invoice-footer-value"><lang class="lang_round_off_3">Round-Off</lang></div>' +
                            '</div>' +
                            '<div class="col-md-4 col-sm-4 col-xs-6">' +
                            '<div class="invoice-footer-value invoice-payment text-dark">' + currency + sign + Math.abs(roundOffValue).toFixed(moneyDigits) +
                            '</div>' +
                            '</div>';
                    }
                    $('#roundoff-value').html(roundOff);
                    $('#roundoff_standard_print').html(roundOffStandardPrint);
                    $('.print-total').html('<strong>' + currency + '&nbsp;<span class="number">' + salesLineTotal + '</span></strong>');

                    if (parseFloat(data.discount) > 0) {
                        $('.amount-print-hideshow').show();
                        var discountValue = (name === 'sale') ? data.discount : data.return_discount;
                        $('.view_sales_discount').html(currency + '&nbsp;<span class="number">' + discountValue.toFixed(moneyDigits) + '</span>');
                    }
                } else {
                    var subtotal = data.items_return_subtotal;
                    var items_return_length = data.items_return.length;
                    let extraDisValue = 0;
                    let roundOffValue = 0;
                    let salesReturnLineTotal = 0;
                    for (var k = 0; k < items_return_length; k++) {
                        roundOffValue += data.items_return[k].returnArray.roundOff;
                        extraDisValue += data.items_return[k].returnArray.extraDiscount;
                        salesReturnLineTotal += data.items_return[k].returnArray.itemsTotalAmount;
                    }
                    let extraDiscPrintView = '';
                    let extraDiscStandardPrint = '';
                    if (extraDisValue !== 0) {
                        extraDiscPrintView =
                            '<td class="print-deatils-size-family print-footer-align"> Extra-Discount:     </td>' +
                            '<td class="print-deatils-size-family print-footer-align">' +
                            currency + '&nbsp; - <span class="number">' + extraDisValue + '</span></td>';
                        extraDiscStandardPrint =
                            '<div class="col-md-8 col-sm-8 col-xs-6">' +
                            '<div class="invoice-footer-value"><lang class="lang_extra_disc_2">Extra discount</lang></div>' +
                            '</div>' +
                            '<div class="col-md-4 col-sm-4 col-xs-6">' +
                            '<div class="invoice-footer-value invoice-payment text-dark">' + currency + " &nbsp;" + '-' + extraDisValue + '</div>' +
                            '</div>';
                    }
                    $('#extra_disc_print_view').html(extraDiscPrintView);
                    $('#extra_disc_standard_print').html(extraDiscStandardPrint);
                    let sign = roundOffValue >= 0 ? '+' : '-';
                    let roundOff = '';
                    let roundOffStandardPrint = '';
                    if (roundOffValue !== 0) {
                        $('.round-off-hideshow').show();
                        roundOff =
                            '<td class="print-deatils-size-family print-footer-align"> Round-Off: &nbsp; &nbsp; </td>' +
                            '<td class="print-deatils-size-family print-footer-align">' +
                            currency + '&nbsp;(' + sign + ')&nbsp;<span class="number">' + Math.abs(roundOffValue).toFixed(moneyDigits) + '</span></td>';
                        roundOffStandardPrint =
                            '<div class="col-md-8 col-sm-8 col-xs-6">' +
                            '<div class="invoice-footer-value"><lang class="lang_round_off_3">Round-Off</lang></div>' +
                            '</div>' +
                            '<div class="col-md-4 col-sm-4 col-xs-6">' +
                            '<div class="invoice-footer-value invoice-payment text-dark">' + currency + sign + Math.abs(roundOffValue).toFixed(moneyDigits) + '</div>' +
                            '</div>';
                    }
                    $('#roundoff-value').html(roundOff);
                    $('#roundoff_standard_print').html(roundOffStandardPrint);
                    $('.print-total').html('<strong>' + currency + '&nbsp;<span class="number">' + salesReturnLineTotal + '</span></strong>');

                    if (parseFloat(data.return_discount) > 0) {
                        $('.amount-print-hideshow').show();
                        var discountValue = (name === 'sale') ? data.discount : data.return_discount;
                        $('.view_sales_discount').html(currency + '&nbsp;<span class="number">' + discountValue.toFixed(moneyDigits) + '</span>');
                    }
                }
                $('.print-subtotal').html(currency + '&nbsp;<span class="number">' + subtotal.toFixed(moneyDigits) + '</span>');


                $('.print_view_id').html('#' + data.sales_id);
                $('.barcodeValue').val(data.sales_id);

                // Printed receipts show the recorded amount, never a tender type.
                var amountPaid = PosnicSalePayments.amount(data);
                $('.print-invoice-payment-mode').html(amountPaid > 0
                    ? '<div class="payment-line" style="display:flex;justify-content:space-between;gap:12px">' +
                        '<span class="payment-method"><lang class="lang_paid">Paid</lang></span>' +
                        '<span class="payment-amount">' + currency + ' ' + amountPaid.toFixed(2) + '</span></div>'
                    : '');

                    // Mark the payment block row so it can be styled (centered with lines)
                    var $printContainer = isA4Layout
                        ? $(".print-modal-a4-body")
                        : $(".print-modal-body");
                    var $paymentRow = $printContainer.find('.print-invoice-payment-mode').closest('.row');
                    if (!$paymentRow.length) {
                        $paymentRow = $printContainer.find('.print-invoice-payment-mode').closest('tr');
                    }
                    $paymentRow.addClass('print-payment-block-wrapper');

                    // For thermal (non-A4) receipts: replace any existing label with a single centred "Payment" heading
                    var isA4Layout = $printContainer.hasClass('print-modal-a4-body');
                    if (!isA4Layout && $paymentRow.length) {
                        // Remove any element in this row whose visible text resolves to just "Payment"
                        // (case-insensitive), allowing for trailing punctuation like ':' or '-' so that
                        // variants such as "Payment:", "Payment -" etc. are also caught. Do not touch
                        // our new heading or the container that holds the payment lines.
                        var $oldPaymentLabels = $paymentRow.find('*').filter(function () {
                            var $el = $(this);
                            if ($el.is('.print-payment-heading') || $el.find('.print-invoice-payment-mode').length) {
                                return false;
                            }
                            var text = $.trim($el.text()).toLowerCase();
                            // Strip common trailing punctuation (colon, hyphen) and whitespace
                            text = text.replace(/[:\-]+$/, '').trim();
                            return text === 'payment';
                        });
                        $oldPaymentLabels.remove();

                        // Insert our own centred heading just above the payment lines (only once)
                        var $paymentContainer = $paymentRow.find('.print-invoice-payment-mode').first();
                        if ($paymentContainer.length && !$paymentContainer.prev('.print-payment-heading').length) {
                            $('<div class="print-payment-heading"><lang class="lang_payment_2">Payment</lang></div>').insertBefore($paymentContainer);
                        }
                    }
                /*
                 * A4 is an invoice, so an A4 document always carries the buyer
                 * when the sale has one.
                 */
                var _isInvoice = isA4Layout;
                var customerName = PosnicPro.isWalkInName(data.customer_name) ? '' : (data.customer_name || '');
                var _hasCustomer = $.trim(customerName) !== '';
                $('.hide_customer_details').hide();
                if (data.customer_print === true || (_isInvoice && _hasCustomer)) {
                    $('.hide_customer_details').show();
                    $('.print-custom-title').html(_isInvoice ? PosnicPro.i18n.t('lang_bill_to_2', 'Bill To') : PosnicPro.i18n.t('lang_pending_customer_detail', 'Customer Details'));
                    $('.print-name').text(customerName);
                    $('.print-phone').text(data.customer_phone || '');
                    $('.print-email').text(data.customer_email || '');
                    $('.print-address').text(data.customer_address || '');
                }


                // Keep the payment status span in sync for every layout.
                var paymentStatus = (typeof (data.payment_status) === 'undefined' || data.payment_status === null)
                    ? 'Paid'
                    : data.payment_status.toString().trim();
                var statusText = paymentStatus || 'Paid';
                $('.print-payment-status').html(statusText);
                $('.print-payment-status-inline, .thermal-payment-status-row').remove();

                let sales_description = data.sales_description;
                if (data.print_sale_notes === true && $.trim(sales_description).length !== 0) {
                    $('.print-sale-notes-hide').show();
                    $('.print-sale-notes').text(sales_description).css('white-space', 'pre-line');
                } else {
                    $('.print-sale-notes-hide').hide();
                }

                // Resolve store logo for the receipt in a CSP-friendly way.
                if (data.print_logoimg === true) {
                    var logoPath = '';

                    // 1) Prefer logo coming from backend sale/branch data
                    if (data.logo && $.trim(data.logo) !== '' && data.logo !== 'store.png') {
                        logoPath = data.logo;
                    } else {
                        // 2) Fallback to logo stored in localStorage
                        var storedLogo = PosnicPro.local.get('branchimage');
                        if (storedLogo && $.trim(storedLogo) !== '' && storedLogo !== 'store.png') {
                            logoPath = storedLogo;
                        }
                    }

                    // 3) If the logo path points to a local API host such as
                    // http://localhost:5000 (which is often blocked by the
                    // dashboard's Content Security Policy when the frontend is
                    // hosted elsewhere), treat it as unsafe for printing and
                    // fall back to the bundled default image instead.
                    if (logoPath && logoPath.indexOf('http://localhost:5000/') === 0) {
                        logoPath = '';
                    }

                    // 4) Final fallback to bundled default image if no valid logo
                    // path is available from backend or local storage.
                    if (!logoPath || logoPath === 'store.png') {
                        logoPath = 'static/images/default/store.png';
                    }

                    $(".branch_image").css("display", "block");
                    $('.printlogoimage img, #printlogoimage img').attr('src', logoPath);
                } else {
                    $(".branch_image").css("display", "none");
                }
                if (!root) { PosnicPro.printBarcode(); }
                var length = data.items.length;
                var length_return = data.items_return.length;
                var itemTotalQty = 0;
                $('.print-invoice-a4-table-content tbody').children("tr").remove();
                $('.print-invoice-table-content').html('');
                $('.hide-receiving-print').show();

                /*
                 * THE PICTURE UNDER THE TOTAL, ADDED HERE.
                 *
                 * Not in the stored templates, for the same reason as the
                 * A4 invoice extras below: every shop already holds its own
                 * copy of that template, so editing the seed file would
                 * reach new shops only and this is for the ones that exist.
                 *
                 * Swept first so a reprint cannot stack two of them.
                 */
                $('.receipt-footer-image').remove();
                var _fimg = data.footer_image !== undefined ? data.footer_image : (PosnicPro.local.get('footer_image') || '');
                var _fcap = data.footer_image_caption !== undefined ? data.footer_image_caption : (PosnicPro.local.get('footer_image_caption') || '');
                if (_fimg && name === 'sale') {
                    var _capHtml = _fcap
                        ? '<div class="footer-image-caption">'
                            + $('<i>').text(_fcap).html() + '</div>'
                        : '';
                    $printContainer.append(
                        '<div class="receipt-footer-image" style="text-align:center; margin-top:10px;">'
                        + _capHtml
                        + '<div class="footer-image"><img alt="" '
                        + 'style="max-width:60%; display:inline-block;" src="'
                        + $('<i>').text(_fimg).html() + '">'
                        + '</div></div>'
                    );
                }
                if (name === 'sale') {
                    var docTitle = PosnicPro.i18n.t('lang_receipt_title', 'RECEIPT');
                    $('.print-title').html(
                        '<span style="font-weight:900; letter-spacing:1px;">'
                        + PosnicPro.escapeHtml(docTitle) + '</span>'
                    );
                    $('.print_date').text(data.receipt_date || data.created_date || data.date);
                    $('.print_date').text(data.receipt_date || data.created_date || data.date);
                    if (isA4Layout) {
                        for (var i = 0; i < length; i++) {
                            var price = Number(data.items[i].item_price);
                            var discount = (data.items[i].item_discount > 0) ? data.items[i].item_discount : data.items[i].item_discount_percentage;
                            var discountSign = (data.items[i].item_discount > 0) ? currency : '%';

                            var discount_percentage = '--';
                            if (discount !== 0) {
                                if (discountSign === '%') {
                                    discount_percentage = '' + discount + ' ' + discountSign + '';
                                } else {
                                    discount_percentage = '' + discountSign + ' ' + discount + '';
                                }
                            }

                            let item_unit = (typeof (data.items[i].item_unit) !== "undefined" && data.items[i].item_unit !== null) ? data.items[i].item_unit : 'qty';
                            itemTotalQty += data.items[i].item_quantity;
                            let rowHTMLLine = '<tr><td height="1" colspan="5" style="border:1px solid #e4e4e4"></td></tr><tr><td style="color: #506fe4;" class="article print-deatils-size-family print-details-align">' + PosnicPro.escapeHtml(PosnicPro.textOverflowPrintEllipsis(PosnicPro.printItemName ? PosnicPro.printItemName(data.items[i], 'receipt') : data.items[i].item_name, PosnicPro.local.get('printing_max_char'), true)) + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_price" style="color: #646a6e;" align="center">' + price.toFixed(moneyDigits) + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_qty" style="color: #646a6e;" align="center">' + PosnicPro.formatQuantity(data.items[i].item_quantity, item_unit) + ' ' + item_unit + ' </td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_disc" style="color: #646a6e;" align="center">' + discount_percentage + '</td>' +
                                '<td class="print-deatils-size-family print-details-align lineitem_total" style="color: #1e2b33;" align="right">' + currency + '&nbsp;<span class="number">' + (transferredBill ? transferredBill.items[i].amount : data.items[i].total_amount) + '</span></td>' +
                                '</tr><tr><td height="1" colspan="5" style="border:1px solid #e4e4e4"></td></tr>';

                            $('table.print-invoice-a4-table-content tbody').append(rowHTMLLine);
                        }
                        let extraDisValue = data.sale_extra_discount !== null ? data.sale_extra_discount : 0;
                        let extraDiscPrintView = '';
                        if (extraDisValue !== 0) {
                            extraDiscPrintView = '<td class="print-deatils-size-family print-footer-align"> Extra-Discount:     </td>' +
                                '<td class="print-deatils-size-family print-footer-align">' +
                                currency + '&nbsp; - <span class="number">' + extraDisValue + '</span></td>';
                        }
                        $('#extra_disc_print_view').html(extraDiscPrintView);
                        let roundOffValue = data.round_off;
                        let sign = roundOffValue >= 0 ? '+' : '-';
                        let roundOff = '';
                        if (roundOffValue !== 0) {
                            roundOff = '<td class="print-deatils-size-family print-footer-align"> Round-Off: &nbsp; &nbsp; </td>' +
                                '<td class="print-deatils-size-family print-footer-align">' +
                                currency + '&nbsp;(' + sign + ')&nbsp;<span class="number">' + Math.abs(roundOffValue).toFixed(moneyDigits) + '</span></td>';
                        }
                        $('#roundoff-value').html(roundOff);
                        if (data.partial_check === 'true' && data.sale_process !== 'PartialReturn' && data.sale_process !== 'FullReturn') {
                            $('.print-payment-status-hide').show();
                            $('.print-payment-balance').html(currency + '&nbsp;' + data.partial_balance.toFixed(moneyDigits));
                            $('.print-payment-pending').html(currency + '&nbsp;' + data.payment_pending.toFixed(moneyDigits));
                            $('.print-payment-status').html(data.payment_status);
                        }
                    } else {
                        for (var i = 0; i < length; i++) {
                            var price = Number(data.items[i].item_price);
                            let item_unit = (typeof (data.items[i].item_unit) !== "undefined" && data.items[i].item_unit !== null) ? data.items[i].item_unit : 'qty';
                            itemTotalQty += data.items[i].item_quantity;
                            let rowHTMLLine = '<div class="row receipt-row-item-holder" style="margin-top:8px;"><div class="col-md-5 col-sm-5 col-xs-5"><div class="invoice-content invoice-con"><div class="invoice-content-heading">' + PosnicPro.escapeHtml(PosnicPro.textOverflowPrintEllipsis(PosnicPro.printItemName ? PosnicPro.printItemName(data.items[i], 'receipt') : data.items[i].item_name, PosnicPro.local.get('printing_max_char'), true)) + '</div></div></div>' +
                                '<div class="col-md-3 col-sm-3 col-xs-3 gift_receipt_element"><div class="invoice-content item-qty text-left">' + PosnicPro.formatQuantity(data.items[i].item_quantity, item_unit) + ' ' + item_unit + '</div></div>' +
                                '<div class="col-md-4 col-sm-4 col-xs-4 gift_receipt_element"><div class="invoice-content item-total pull-right ">' + currency + '&nbsp;<span class="number">' + (transferredBill ? transferredBill.items[i].amount : price * data.items[i].item_quantity) + '</span></div></div></div>';

                            $('.print-invoice-table-content').append(rowHTMLLine);
                        }
                        let extraDisValue = data.sale_extra_discount !== null ? data.sale_extra_discount : 0;
                        let extraDiscStandardPrint = '';
                        if (extraDisValue !== 0) {
                            extraDiscStandardPrint =
                                '<div class="col-md-8 col-sm-8 col-xs-6">' +
                                '<div class="invoice-footer-value"><lang class="lang_extra_disc_2">Extra discount</lang></div>' +
                                '</div>' +
                                '<div class="col-md-4 col-sm-4 col-xs-6">' +
                                '<div class="invoice-footer-value invoice-payment text-dark">' + currency + " &nbsp;" + '-' + extraDisValue + '</div>' +
                                '</div>';
                        }
                        $('#extra_disc_standard_print').html(extraDiscStandardPrint);
                        let roundOffValue = data.round_off;
                        let sign = roundOffValue >= 0 ? '+' : '-';
                        let roundOffHTML = '';
                        if (roundOffValue !== 0) {
                            roundOffHTML =
                                '<div class="col-md-8 col-sm-8 col-xs-6">' +
                                '<div class="invoice-footer-value"><lang class="lang_round_off_3">Round-Off</lang></div>' +
                                '</div>' +
                                '<div class="col-md-4 col-sm-4 col-xs-6">' +
                                '<div class="invoice-footer-value invoice-payment text-dark">' + currency + sign + Math.abs(roundOffValue).toFixed(moneyDigits) +
                                '</div>' +
                                '</div>';
                        }
                        $('#roundoff_standard_print').html(roundOffHTML);
                    }

                } else {
                    $('.print-payment-status-hide').hide();
                    $('.print-title').html(PosnicPro.local.get('sale_return_title'));
                    $('.print_date').text(data.updated_date);
                    if (isA4Layout) {
                        for (var i = 0; i < length_return; i++) {
                            $.each(data.items_return[i].returnArray['returnValue'], function (key, val) {
                                var price = Number(val.item_price);
                                var discount = (val.item_discount > 0) ? val.item_discount : val.item_discount_percentage;
                                var discountSign = (val.item_discount > 0) ? currency : '%';

                                var discount_percentage = '--';
                                if (discount !== 0) {
                                    if (discountSign === '%') {
                                        discount_percentage = '' + discount + ' ' + discountSign + '';
                                    } else {
                                        discount_percentage = '' + discountSign + ' ' + discount + '';
                                    }
                                }

                                let item_unit = (typeof (val.item_unit) != "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                                itemTotalQty += val.item_quantity;
                                let rowHTMLLine = '<tr><td height="1" colspan="5" style="border:1px solid #e4e4e4"></td></tr><tr><td style="color: #506fe4;" class="article print-deatils-size-family print-details-align">' + PosnicPro.textOverflowPrintEllipsis(PosnicPro.printItemName ? PosnicPro.printItemName(val, 'receipt') : val.item_name, PosnicPro.local.get('printing_max_char'), true) + '</td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_price" style="color: #646a6e;" align="center">' + price.toFixed(moneyDigits) + '</td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_qty" style="color: #646a6e;" align="center">' + PosnicPro.formatQuantity(val.item_quantity, item_unit) + ' ' + item_unit + ' </td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_disc" style="color: #646a6e;" align="center">' + discount_percentage + '</td>' +
                                    '<td class="print-deatils-size-family print-details-align lineitem_total" style="color: #1e2b33;" align="right">' + currency + '&nbsp;<span class="number">' + val.total_amount + '</span></td>' +
                                    '</tr><tr><td height="1" colspan="5" style="border:1px solid #e4e4e4"></td></tr>';

                                $('table.print-invoice-a4-table-content tbody').append(rowHTMLLine);
                            });
                        }
                    } else {
                        for (var i = 0; i < length_return; i++) {
                            $.each(data.items_return[i].returnArray['returnValue'], function (key, val) {
                                var price = Number(val.item_price);
                                let item_unit = (typeof (val.item_unit) != "undefined" && val.item_unit !== null) ? val.item_unit : 'qty';
                                itemTotalQty += val.item_quantity;
                                let rowHTMLLine = '<div class="row receipt-row-item-holder" style="margin-top:8px;"><div class="col-md-5 col-sm-5 col-xs-5"><div class="invoice-content invoice-con"><div class="invoice-content-heading">' + PosnicPro.textOverflowPrintEllipsis(PosnicPro.printItemName ? PosnicPro.printItemName(val, 'receipt') : val.item_name, PosnicPro.local.get('printing_max_char'), true) + '</div></div></div>' +
                                    '<div class="col-md-3 col-sm-3 col-xs-3 gift_receipt_element"><div class="invoice-content item-qty text-left">' + PosnicPro.formatQuantity(val.item_quantity, item_unit) + ' ' + item_unit + '</div></div>' +
                                    '<div class="col-md-4 col-sm-4 col-xs-4 gift_receipt_element"><div class="invoice-content item-total pull-right ">' + currency + '&nbsp;<span class="number">' + price * val.item_quantity + '</span></div></div></div>';

                                $('.print-invoice-table-content').append(rowHTMLLine);
                            });
                        }
                    }
                }

                PosnicPro.toggleVisibility('lineitem_price', '.lineitem_price', root);
                PosnicPro.toggleVisibility('lineitem_qty', '.lineitem_qty', root);
                PosnicPro.toggleVisibility('lineitem_disc', '.lineitem_disc', root);
                PosnicPro.toggleVisibility('lineitem_total', '.lineitem_total', root);
                PosnicPro.toggleVisibility('print_qty', '.print_qty', root);
                PosnicPro.toggleVisibility('print_roundoff', '.print_roundoff', root);

                $('.total-noof-item').html(String(Number(itemTotalQty.toFixed(3))));
                $('.print-total').attr('data-currency-digits', moneyDigits);
                $('span.number').number(true, moneyDigits);

                var $printContainer = isA4Layout
                    ? $(".print-modal-a4-body")
                    : $(".print-modal-body");
                var $paymentLabels = $printContainer.find('*').filter(function () {
                    var $el = $(this);
                    if ($el.children().length) {
                        return false;
                    }
                    var text = $.trim($el.text());
                    return text === 'Payment' || text === 'Payment Status';
                });
                $paymentLabels.show();

                /*
                 * The pieces that make an A4 read as an invoice rather than a
                 * long receipt: the total written out, the shop's terms, and
                 * somewhere to sign. Added here rather than in the stored
                 * template because every shop already holds its own copy of
                 * that template - editing the file would reach new shops only.
                 * Swept first so a reprint cannot stack them.
                 */
                $('.a4-invoice-extras').remove();
                if (isA4Layout && name === 'sale') {
                    var _escX = function (v) { return $('<i>').text(v == null ? '' : v).html(); };
                    var _terms = $.trim(data.invoice_terms !== undefined ? data.invoice_terms : (PosnicPro.local.get('invoice_terms') || ''));
                    var _sig = $.trim(data.quote_default_signature !== undefined ? data.quote_default_signature : (PosnicPro.local.get('quotesignature') || ''));
                    var _x = '<div class="a4-invoice-extras" style="margin-top:18px; font-size:12px; color:#5b5b5b;">';
                    if (!transferredBill || moneyDigits === 2) {
                        _x += '<div style="padding:6px 0; border-top:1px solid #d8d8d8;"><b><lang class="lang_amount_in_words">Amount in words:</lang></b> '
                            + _escX(PosnicPro.sales.view._amountInWords(data.items_total)) + '</div>';
                    }
                    if (_terms) {
                        _x += '<div style="padding:6px 0;"><b><lang class="lang_terms_conditions">Terms &amp; conditions</lang></b><br>'
                            + _escX(_terms).split(String.fromCharCode(10)).join('<br>') + '</div>';
                    }
                    _x += '<div style="margin-top:26px; width:220px; margin-left:auto; text-align:center;">'
                        + (_sig ? '<img loading="lazy" decoding="async" src="' + _escX(_sig) + '" alt="" style="max-height:38px; max-width:170px; display:block; margin:0 auto;">' : '')
                        + '<div style="border-top:1px solid #8a94a6; padding-top:5px;"><lang class="lang_authorised_signatory">Authorised signatory</lang></div>'
                        + '</div></div>';
                    $('.print-modal-a4-body').append(_x);
                }

    },
    /*Perticular Returned printing the sales data held by this function*/
    returnPrintSales: function (id) {
        var data = {
            id: id
        };
        var params = {
            url: 'sales/returnPrintDetails',
            data: data
        };
        PosnicPro.get(params, function (response) {
                if (response.type === 'success') {
                var custom = response.data.custom_data || {};
                var returnLines = response.data.return_data || [];
                /*
                 * The same designer prints the return slip, so a shop that
                 * prints Arabic bills does not hand out an English return
                 * receipt. Branch settings supply the saved design, logo and
                 * address; if that read fails, the designer's defaults still
                 * print the return rather than nothing.
                 */
                if (PosnicPro.receiptDesigner && PosnicPro.receiptDesigner.printReturn) {
                    var layoutOverride = PosnicPro.sales.view._layoutOverride;
                    PosnicPro.sales.view._layoutOverride = null;
                    PosnicPro.record_id = id;
                    PosnicPro.get(
                        { url: 'branches/getOneStore', data: 'id=' + PosnicPro.local.get('branch_id_set') },
                        function (branchResponse) {
                            PosnicPro.receiptDesigner.printReturn(
                                (branchResponse && branchResponse.data) || {},
                                custom,
                                returnLines,
                                layoutOverride
                            );
                        },
                        function () {
                            PosnicPro.receiptDesigner.printReturn({}, custom, returnLines, layoutOverride);
                        }
                    );
                    return;
                }
                var data = custom;
                $('#receipt_wrapper').removeClass('receipt_small receipt_medium receipt_large receipt_extra_large');
                let print_size = PosnicPro.local.get('printing_size');
                $('#receipt_wrapper').addClass(print_size);
                PosnicPro.record_id = id;
                var currency = PosnicPro.local.get('currencySign');
                $('.percentage-print-hideshow,.amount-print-hideshow').hide();
                $('.print_date').text(data.date);
                $('.print_view_id').html('#' + data.return_id);
                $('.print-title').html(PosnicPro.local.get('sale_return_title'));
                $('.print_date').text(data.date);
                $('.print_view_id').html('#' + data.sales_id);
                var returnedAmount = PosnicSalePayments.amount(data);
                $('.print-invoice-payment-mode').html(returnedAmount > 0
                    ? '<div class="payment-line" style="display:flex;justify-content:space-between;gap:12px">' +
                        '<span class="payment-method"><lang class="lang_paid">Paid</lang></span>' +
                        '<span class="payment-amount">' + currency + ' ' + returnedAmount.toFixed(2) + '</span></div>'
                    : '');
                $('.barcodeValue').val(data.sales_id);
                $('.hide_customer_details,.print-payment-status-hide').hide();
                var a4CustomerName = PosnicPro.isWalkInName(data.customer_name) ? '' : (data.customer_name || '');
                if (data.customer_print === true && a4CustomerName) {
                    $('.hide_customer_details').show();
                    $('.print-custom-title').html(PosnicPro.i18n.t('lang_pending_customer_detail', 'Customer Details'));
                    $('.print-name').html(a4CustomerName);
                    $('.print-phone').html(data.customer_phone);
                    $('.print-email').html(data.customer_email);
                    $('.print-address').html(data.customer_address);
                }
                PosnicPro.printBarcode();
                $('.print-invoice-a4-table-content tbody').children("tr").remove();
                $('.print-invoice-table-content').html('');
                $('.hide-receiving-print').hide();
                var itemTotalQty = 0;
                var subTotal = 0;
                var grandTotal = 0;
                var lineItemDiscount = 0;
                var roundOffValue = 0;
                var extraDisValue = 0;
                var length = response.data.return_data.length;
                if (PosnicPro.sales.view._isA4()) {
                    for (var i = 0; i < length; i++) {
                        var price = Number(response.data.return_data[i].item_price);
                        var discount = (response.data.return_data[i].item_discount > 0) ? response.data.return_data[i].item_discount : response.data.return_data[i].item_discount_percentage;
                        var discountSign = (response.data.return_data[i].item_discount > 0) ? currency : '%';
                        lineItemDiscount += response.data.return_data[i].item_return_discount;

                        subTotal += (price * response.data.return_data[i].item_quantity);
                        grandTotal += response.data.return_data[i].item_total_amount;
                        var discount_percentage = '--';
                        if (discount !== 0) {
                            if (discountSign === '%') {
                                discount_percentage = '' + discount + ' ' + discountSign + '';
                            } else {
                                discount_percentage = '' + discountSign + ' ' + discount + '';
                            }
                        }

                        let item_unit = (typeof (response.data.return_data[i].item_unit) !== "undefined" && response.data.return_data[i].item_unit !== null) ? response.data.return_data[i].item_unit : 'qty';
                        itemTotalQty += response.data.return_data[i].item_quantity;
                        let rowHTMLLine = '<tr><td height="1" colspan="5" style="border-top:1px solid #e4e4e4"></td></tr><tr>\n\
                                <td style="color: #506fe4;" class="article print-deatils-size-family print-details-align">' + PosnicPro.textOverflowPrintEllipsis(PosnicPro.printItemName ? PosnicPro.printItemName(response.data.return_data[i], 'receipt') : response.data.return_data[i].item_name, PosnicPro.local.get('printing_max_char'), true) + '</td>' +
                            '<td class="print-deatils-size-family print-details-align lineitem_price" style="color: #646a6e;" align="center">' + price.toFixed(2) + '</td>' +
                            '<td class="print-deatils-size-family print-details-align lineitem_qty" style="color: #646a6e;" align="center">' + PosnicPro.formatQuantity(response.data.return_data[i].item_quantity, item_unit) + ' ' + item_unit + '</td>' +
                            '<td class="print-deatils-size-family print-details-align lineitem_disc" style="color: #646a6e;" align="center">' + discount_percentage + '</td>' +
                            '<td class="print-deatils-size-family print-details-align lineitem_total" style="color: #1e2b33;" align="right">' + currency + '&nbsp;<span class="number">' + response.data.return_data[i].item_total_amount + '</span></td>' +
                            '</tr><tr><td height="1" colspan="5" style="border-bottom:1px solid #e4e4e4"></td></tr>';

                        $('table.print-invoice-a4-table-content tbody').append(rowHTMLLine);

                        roundOffValue = response.data.return_data[i].roundOff;
                        extraDisValue = response.data.return_data[i].extraDiscount;
                        grandTotal = response.data.return_data[i].itemsTotalAmount;
                    }
                    let sales_description = data.sales_description;
                    if (data.print_sale_notes === true && $.trim(sales_description).length !== 0) {
                        $('.print-sale-notes-hide').show();
                        $('.print-sale-notes').html(sales_description);
                    } else {
                        $('.print-sale-notes-hide').hide();
                    }
                } else {
                    for (var i = 0; i < length; i++) {
                        var discount = (response.data.return_data[i].item_discount > 0) ? response.data.return_data[i].item_discount : response.data.return_data[i].item_discount_percentage;
                        var discountSign = (response.data.return_data[i].item_discount > 0) ? currency : '%';
                        lineItemDiscount += response.data.return_data[i].item_return_discount;
                        var price = Number(response.data.return_data[i].item_price);

                        subTotal += (price * response.data.return_data[i].item_quantity);
                        grandTotal += response.data.return_data[i].item_total_amount;
                        let item_unit = (typeof (response.data.return_data[i].item_unit) !== "undefined" && response.data.return_data[i].item_unit !== null) ? response.data.return_data[i].item_unit : 'qty';
                        itemTotalQty += response.data.return_data[i].item_quantity;
                        let rowHTMLLine = '<div class="row receipt-row-item-holder" style="margin-top:8px;"><div class="col-md-5 col-sm-5 col-xs-5"><div class="invoice-content invoice-con"><div class="invoice-content-heading">' + PosnicPro.textOverflowPrintEllipsis(PosnicPro.printItemName ? PosnicPro.printItemName(response.data.return_data[i], 'receipt') : response.data.return_data[i].item_name, PosnicPro.local.get('printing_max_char'), true) + '</div></div></div>' +
                            '<div class="col-md-3 col-sm-3 col-xs-3 gift_receipt_element"><div class="invoice-content item-qty text-left">' + PosnicPro.formatQuantity(response.data.return_data[i].item_quantity, item_unit) + ' ' + item_unit + '</div></div>' +
                            '<div class="col-md-4 col-sm-4 col-xs-4 gift_receipt_element"><div class="invoice-content item-total pull-right ">' + currency + '&nbsp;<span class="number">' + price * response.data.return_data[i].item_quantity + '</span></div></div></div>';

                        $('.print-invoice-table-content').append(rowHTMLLine);

                        roundOffValue = response.data.return_data[i].roundOff;
                        extraDisValue = response.data.return_data[i].extraDiscount;
                        grandTotal = response.data.return_data[i].itemsTotalAmount;
                    }
                }
                PosnicPro.toggleVisibility('lineitem_price', '.lineitem_price');
                PosnicPro.toggleVisibility('lineitem_qty', '.lineitem_qty');
                PosnicPro.toggleVisibility('lineitem_disc', '.lineitem_disc');
                PosnicPro.toggleVisibility('lineitem_total', '.lineitem_total');
                PosnicPro.toggleVisibility('print_qty', '.print_qty');
                PosnicPro.toggleVisibility('print_roundoff', '.print_roundoff');

                if (parseFloat(lineItemDiscount) > 0) {
                    $('.amount-print-hideshow').show();
                    $('.view_sales_discount').html(currency + '&nbsp;<span class="number">' + lineItemDiscount + '</span>');
                }

                if (PosnicPro.sales.view._isA4()) {
                    if (data.partial_check === 'true' && data.sale_process !== 'PartialReturn' && data.sale_process !== 'FullReturn') {
                        $('.print-payment-status-hide').hide();
                        $('.print-payment-balance').html(currency + '&nbsp;' + data.partial_balance.toFixed(2));
                        $('.print-payment-pending').html(currency + '&nbsp;' + data.payment_pending.toFixed(2));
                        $('.print-payment-status').html(data.payment_status);
                    }
                }
                let extraDiscPrintView = '';
                let extraDiscStandardPrint = '';
                if (extraDisValue !== 0) {
                    extraDiscPrintView =
                        '<td class="print-deatils-size-family print-footer-align"> Extra-Discount:     </td>' +
                        '<td class="print-deatils-size-family print-footer-align">' +
                        currency + '&nbsp; - <span class="number">' + extraDisValue + '</span></td>';
                    extraDiscStandardPrint =
                        '<div class="col-md-8 col-sm-8 col-xs-6">' +
                        '<div class="invoice-footer-value"><lang class="lang_extra_disc_2">Extra discount</lang></div>' +
                        '</div>' +
                        '<div class="col-md-4 col-sm-4 col-xs-6">' +
                        '<div class="invoice-footer-value invoice-payment text-dark">' + currency + "&nbsp;" + '-' + extraDisValue + '</div>' +
                        '</div>';
                }
                $('#extra_disc_print_view').html(extraDiscPrintView);
                $('#extra_disc_standard_print').html(extraDiscStandardPrint);
                var sign = roundOffValue >= 0 ? '+' : '-';
                let roundOff = '';
                let roundOffStandardPrint = '';
                if (roundOffValue !== 0) {
                    roundOff =
                        '<td class="print-deatils-size-family print-footer-align"> Round-Off: &nbsp; &nbsp; </td>' +
                        '<td class="print-deatils-size-family print-footer-align">' +
                        currency + '&nbsp;(' + sign + ')&nbsp;<span class="number">' + Math.abs(roundOffValue).toFixed(2) + '</span></td>';
                    roundOffStandardPrint =
                        '<div class="col-md-8 col-sm-8 col-xs-6">' +
                        '<div class="invoice-footer-value"><lang class="lang_round_off_3">Round-Off</lang></div>' +
                        '</div>' +
                        '<div class="col-md-4 col-sm-4 col-xs-6">' +
                        '<div class="invoice-footer-value invoice-payment text-dark">' + currency + sign + Math.abs(roundOffValue).toFixed(2) + '</div>' +
                        '</div>';
                }
                $('#roundoff-value').html(roundOff);
                $('#roundoff_standard_print').html(roundOffStandardPrint);
                $('.total-noof-item').html(String(Number(itemTotalQty.toFixed(3))));
                $('.print-subtotal').html(currency + '&nbsp;<span class="number">' + subTotal + '</span>');
                $('.print-total').html('<strong>' + currency + '&nbsp;<span class="number">' + grandTotal + '</span></strong>');

                $('span.number').number(true, 2);
                var contents = $(".print-modal-body").html();
                var contentone = $(".print-modal-a4-body").html();
                var canvas = document.getElementById("canvasTarget");
                var img = data.receipt_barcode === true ? canvas.toDataURL("image/png") : '';
                PosnicPro.printView(PosnicPro.sales.view._isA4() ? contentone : contents, img);
                $('.invoice-table-content div').empty();

            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
    },
    salesPdf: function (id) {
        window.open(API_URL + 'sales/salesPdf?id=' + id, "_blank");
        hasher.setHash('sales');
    },
    exportSales: function () {
        PosnicPro.exportTableData(PosnicPro.sales_checkbox, 'sales');
    },
    deleteSelectedSales: function () {
        PosnicPro.deleteTableData(PosnicPro.sales_checkbox, 'sales');
    },
    changeExtraDiscType: function (extra_discount_type) {
        if (extra_discount_type === 'percent') {
            $('#rupeeIcon').addClass('d-none');
            $('#percentIcon').removeClass('d-none');
        } else {
            $('#percentIcon').addClass('d-none');
            $('#rupeeIcon').removeClass('d-none');
        }
    }
};
$('.sales_id_print').click(function () {
    let name = $(this).data('id');
    PosnicPro.sales.view.printSale(this.value, name);
    hasher.setHash('#' + currentHash);
});

// Store last known sale document id
let lastSalesId = null;
function checkNewSaleAndRefresh() {
    PosnicPro.get('sales/getNewSale', function (response) {

        if (response.type === 'success' && response.data) {
            // latest sale from backend
            var currentId = response.data.sales_document_id;

            // First run: just store and skip refresh
            if (lastSalesId === null) {
                lastSalesId = currentId;
                return;
            }

            // If new sale detected → refresh datatable
            if (currentId !== lastSalesId) {
                lastSalesId = currentId;
                // 🔔 your existing function
                PosnicPro.refreshDatatable('sales');
            }
        }
    });
}

/*
 * Multi-till: a sale completed on another till appears on this one's sales
 * list without anyone pressing refresh. checkNewSaleAndRefresh() above was
 * written for exactly this and then never called from anywhere - the sales
 * page just showed yesterday until someone navigated away and back.
 *
 * Only while the sales list is actually on screen in a visible tab, and only
 * for users who can pass getNewSale's sales.write gate - anyone else would
 * collect an Unauthorized toast every interval.
 */
function refreshSalesScreensIfWatching() {
    if (document.hidden) return;
    var hash = window.location.hash.slice(1);
    if (hash === '/sales') {
        var acl = PosnicPro.userACL;
        if (!acl || !acl.sales || acl.sales.write !== true) return;
        checkNewSaleAndRefresh();
    }
}

// Push-driven (S2): another till wrote a sale - refresh within seconds.
if (PosnicPro.realtime) {
    PosnicPro.realtime.on('sales', refreshSalesScreensIfWatching);
}

// Poll fallback for when the stream is down.
setInterval(function () {
    if (PosnicPro.realtime && PosnicPro.realtime.connected) return;
    if (window.location.hash.slice(1) !== '/sales') return;
    refreshSalesScreensIfWatching();
}, 30000);

/*END*/
