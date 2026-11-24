PosnicPro.paymentreport = {
    recordedUser: function (row) {
        return [row.user_name, row.created_by, row.origin && row.origin.actor_name].find(function (value) {
            return typeof value === 'string' && value.trim() && !/^(undefined|null|\[object Object\])$/i.test(value.trim());
        }) || '—';
    },
    showDataTablePage: function () {
        var loader = $(".loader-sales-payment-report");
        loader.find(".loadingSpinner:first").remove();
        PosnicPro.dashboard.datePicker();
        PosnicPro.HideSideBarModal();
        $(".vertical-layout").removeClass("toggle-menu");
        $('.page_loader,#osk-container,.report-payment,.hide-saletable-payment,.hide-sale-payment-transaction,.hide-table-payment').hide();
        $('.page-title-box,#paymentreport_new').show();
        $(".vertical-menu li a").removeClass("active");
        $('.dropdown-item').removeClass('active');
        $('#v-pills-report-tab,#viewpaymentsalesreport_page').addClass('active');
        $('#v-pills-report').addClass('show active');
        if ($('a#payment-tab-line').hasClass('active')) {
            PosnicPro.paymentreport.paymentTableTabClick();
        } else if ($('a#payment-status-tab-line').hasClass('active')) {
            PosnicPro.paymentransaction.paymentStatusTabClick();
        } else if ($('a#payment-return-tab-line').hasClass('active')) {
            PosnicPro.paymentreturntransaction.paymentReturnTabClick();
        }
        $('.hide_date_filetr,.hide_value_filetr').hide();
        if (PosnicPro.local.get('userplan') === 'free') {
            $('#payment-line,#payment-status-line,#payment-return-line, #payment-graph-line').css('filter', 'blur(2px)');
            $('#paymentransaction_exportbtn,#paymentreturntransaction_exportbtn').attr('disabled', true).css({
                'pointer-events': 'none',
                'cursor': 'not-allowed',
                'opacity': '0.5'
            });
            $('#payment_upgrade').show();
        } else {
            $('#payment-line,#payment-status-line,#payment-return-line, #payment-graph-line').css('filter', 'none');
            $('#paymentransaction_exportbtn,#paymentreturntransaction_exportbtn').removeAttr('disabled').css({
                'pointer-events': 'auto',
                'cursor': 'pointer',
                'opacity': '1'
            });
            $('#payment_upgrade').hide();
        }
    },
    paymentSaleReportView: function () {
        var branchId = $(".payment_branch_value").val().toString();
        if (branchId !== '') {
            var loader = $(".loader-sales-payment-type");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            var daterange = $(".view_payment_report_daterange").val();
            var fields = daterange.split('-');
            var data = {
                starting_date: fields[0],
                ending_date: fields[1],
                branch: $(".payment_branch_value").val()
            };
            var params = {
                url: 'sales/paymentSaleTypeReport',
                data: data
            };
            PosnicPro.get(params, function (response) {
                loader.find(".loadingSpinner:first").remove();
                if (response.type === 'success') {
                    $("#salePaymentType").children('tbody').text('');
                    var data = response.data;
                    var rowTotal = data.payment.length;
                    if (rowTotal === 0) {
                        $('.reportpayment_header').hide();
                        let dateRange = daterange;
                PosnicPro.renderNoRecords('.reportpayment_norecord', 'No Records on ' + dateRange);
                        $('#reportpayment_img_hide,.reportpayment_norecord').show();

                    } else {
                        $('.reportpayment_norecord').empty();
                        $('#reportpayment_img_hide,.reportpayment_norecord').hide();
                        $('.reportpayment_header').show();
                    }
                    if (Array.isArray(data.payment) && data.payment.length) {
                        var currency = PosnicPro.local.get('currencySign');
                        var totals = { sales_payment: 0, partial_amount: 0, outstanding_amount: 0, refund_payment: 0, sales_count: 0 };
                        $(data.payment).each(function (key, val) {
                            totals.sales_payment += Number(val.sales_payment) || 0;
                            totals.partial_amount += Number(val.partial_amount) || 0;
                            totals.outstanding_amount += Number(val.outstanding_amount) || 0;
                            totals.refund_payment += Number(val.refund_payment) || 0;
                            totals.sales_count += Number(val.sales_count) || 0;
                        });
                        var saleType = '<tr>' +
                                '<td><lang class="lang_payments_received">Payments received</lang></td>' +
                                '<td class="text-right">' + currency + '&nbsp;<span class="number">' + totals.sales_payment + '</span></td>' +
                                '<td class="text-right">' + currency + '&nbsp;<span class="number">' + totals.partial_amount + '</span></td>' +
                                '<td class="text-right">' + currency + '&nbsp;<span class="number">' + totals.outstanding_amount + '</span></td>' +
                                '<td class="text-right">' + currency + '&nbsp;<span class="number">' + totals.refund_payment + '</span></td>' +
                                '<td class="text-center">' + totals.sales_count + '</td>' +
                                '</tr>';
                        $("#salePaymentType tbody").append(saleType);

                        var digits = Number.isInteger(data.currencyDigits) && data.currencyDigits >= 0 && data.currencyDigits <= 4 ? data.currencyDigits : 2;
                        $('#salePaymentType span.number').number(true, digits);
                    } else {
                        $("#salePaymentType tbody").append('<tr><td colspan="4"><div class="text-center text-dark"><p class="table_cart_content text-primary"><lang class="lang_your_cash_details_are_empty">Your cash details are empty</lang></p></div></td></tr>');
                    }

                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
        } else {
            $(".payment_branch_value").focus();
        }
    },
    paymentTableTabClick: function () {
        $('#change_payment_view').data('id', 'tableView');
        PosnicPro.paymentreport.paymentSaleReportView();
    }
};

PosnicPro.paymentransaction = {
    paymentransactionTable: function (type) {
        var branchId = $(".payment_branch_value").val().toString();
        if (branchId !== '') {
            var loader = $(".loader-receiving-payment-report");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.appendReportTableBody('paymenttransaction', '#view_paymentransaction');
            var daterange = $(".view_payment_report_daterange").val();
            var fields = daterange.split('-');
            var table = $('#view_paymentransaction');

            if (type === 'paymentransactionexport') {
                var per_page = table.data('total');
            } else {
                var current_page = table.data('current_page');
                var per_page = parseInt($('#view_paymentransaction_per_page  option:selected').text());
            }

            var data = {
                page: current_page,
                limit: per_page,
                starting_date: fields[0],
                ending_date: fields[1],
                branch: $(".payment_branch_value").val()
            };
            var params = {
                url: 'sales/paymentSalesTranscationReportTable',
                data: data
            };
            PosnicPro.get(params, function (response) {
                loader.find(".loadingSpinner:first").remove();
                if (response.type === 'success') {
                    (response.data.total > 0) ? $('#paymentransaction_exportbtn').removeAttr('disabled') : $('#paymentransaction_exportbtn').attr('disabled', 'disabled');
                    if (type !== 'paymentransactionexport') {
                        table.data('total', response.data.total);
                        table.data('total_pages', response.data.total_pages);
                        table.data('current_page', response.data.current_page);
                        table.data('per_page', response.data.per_page);
                        PosnicPro.paging(response.data.total_pages, response.data.current_page);
                        table.children('tbody').text('');
                        $('#view_paymentransaction_total').text(response.data.total);
                        var rowTotal = response.data.total;
                        if (rowTotal === 0) {
                            $('.reportpaymentstatus_header').hide();
                            let dateRange = daterange;
                PosnicPro.renderNoRecords('.reportpaymenttransc_norecord', 'No Records on ' + dateRange);
                            $('#reportpaymenttransc_img_hide,.reportpaymenttransc_norecord').show();

                        } else {
                            $('.reportpaymenttransc_norecord').empty();
                            $('#reportpaymenttransc_img_hide,.reportpaymenttransc_norecord').hide();
                            $('.reportpaymentstatus_header').show();
                        }
                        var row_total = (table.data('current_page') - 1) * table.data('per_page') + 1;
                        $('#view_paymentransaction_page_total').text(row_total);
                        var page_totals = (table.data('current_page') - 1) * table.data('per_page');
                        $('#view_paymentransaction_page_perpage_total').text(page_totals + response.data.list.length);
                        var currency = PosnicPro.local.get('currencySign');
                        for (var i = 0; i < response.data.list.length; i++) {
                            let row = response.data.list[i];
                            let timeZone = PosnicPro.timeZone();
                            let update_timeStamp_value = parseInt(row.updated_date.$date.$numberLong);
                            let DateFormat = moment(update_timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
                            let updateDate = PosnicPro.convertDate(DateFormat);
                            let row_no = (table.data('current_page') - 1) * table.data('per_page') + i + 1;
                            let trow = '<tr> <td scope="row">' + row_no + '</td>  <td>' + row.sales_id + '</td> <td>' + updateDate + '</td> <td>' + $('<span>').text(PosnicPro.paymentreport.recordedUser(row)).html() + '</td> <td class="text-right">' + currency + '&nbsp;<span class="number">' + (row.report_amount ?? row.items_total) + '</span></td></tr>';
                            $('#view_paymentransaction').children('tbody').append(trow);
                            var digits = Number.isInteger(row.currencyDigits) && row.currencyDigits >= 0 && row.currencyDigits <= 4 ? row.currencyDigits : 2;
                            $('#view_paymentransaction tbody tr:last span.number').number(true, digits);
                        }
                    } else {
                        var paymentsalereportexportdata = [];
                        data = response.data.list;
                        $(data).each(function (key, val) {
                            let timeZone = PosnicPro.timeZone();
                            let update_timeStamp_value = parseInt(val.updated_date.$date.$numberLong);
                            let DateFormat = moment(update_timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
                            let date = PosnicPro.convertDate(DateFormat);
                            let id = val.sales_id;
                            let customer = PosnicPro.paymentreport.recordedUser(val);
                            let total = val.report_amount ?? val.items_total;
                            paymentsalereportexportdata.push({SaleId: id, Date: date, UserName: customer, Amount: total});
                        });
                        PosnicPro.JSONToCSVConvertor(paymentsalereportexportdata, 'payment-sales-reports', true);
                        PosnicPro.paymentransaction.paymentransactionTable();
                    }
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
        } else {
            $("#payment_sale_transaction_value").focus();
        }
    },
    paymentransactionexport: function (index) {
        var type = $(index).data('id');
        PosnicPro.paymentransaction.paymentransactionTable(type);
    },
    paymentStatusTabClick: function () {
        $('#change_payment_view').data('id', 'statusView');
        PosnicPro.paymentransaction.paymentransactionTable();
    }
};

PosnicPro.paymentreturntransaction = {
    paymentreturntransactionTable: function (type) {
        let branchId = $(".payment_branch_value").val().toString();
        if (branchId !== '') {
            let loader = $(".loader-return-sales-payment-report");
            $("<div class='loadingSpinner'></div>").appendTo(loader);
            PosnicPro.appendReportTableBody('paymenttransaction', '#view_paymentreturntransaction');
            let daterange = $(".view_payment_report_daterange").val();
            let fields = daterange.split('-');
            let table = $('#view_paymentreturntransaction');

            if (type === 'paymentreturntransactionexport') {
                var per_page = table.data('total');
            } else {
                var current_page = table.data('current_page');
                var per_page = parseInt($('#view_paymentreturntransaction_per_page  option:selected').text());
            }

            let data = {
                page: current_page,
                limit: per_page,
                starting_date: fields[0],
                ending_date: fields[1],
                branch: $(".payment_branch_value").val()
            };
            let params = {
                url: 'sales/paymentReturnSalesTranscationReportTable',
                data: data
            };
            PosnicPro.get(params, function (response) {
                loader.find(".loadingSpinner:first").remove();
                if (response.type === 'success') {
                    (response.data.total > 0) ? $('#paymentreturntransaction_exportbtn').removeAttr('disabled') : $('#paymentreturntransaction_exportbtn').attr('disabled', 'disabled');
                    if (type !== 'paymentreturntransactionexport') {
                        table.data('total', response.data.total);
                        table.data('total_pages', response.data.total_pages);
                        table.data('current_page', response.data.current_page);
                        table.data('per_page', response.data.per_page);
                        PosnicPro.paging(response.data.total_pages, response.data.current_page);
                        table.children('tbody').text('');
                        $('#view_paymentreturntransaction_total').text(response.data.total);
                        let rowTotal = response.data.total;
                        if (rowTotal === 0) {
                            $('.reportpaymentreturn_header').hide();
                            let dateRange = daterange;
                PosnicPro.renderNoRecords('.reportpaymentreturntransction_norecord', 'No Records on ' + dateRange);
                            $('#reportpaymentreturntransction_img_hide,.reportpaymentreturntransction_norecord').show();

                        } else {
                            $('.reportpaymentreturntransction_norecord').empty();
                            $('#reportpaymentreturntransction_img_hide,.reportpaymentreturntransction_norecord').hide();
                            $('.reportpaymentreturn_header').show();
                        }
                        let row_total = (table.data('current_page') - 1) * table.data('per_page') + 1;
                        $('#view_paymentreturntransaction_page_total').text(row_total);
                        let page_totals = (table.data('current_page') - 1) * table.data('per_page');
                        $('#view_paymentreturntransaction_page_perpage_total').text(page_totals + response.data.list.length);
                        let currency = PosnicPro.local.get('currencySign');
                        for (let i = 0; i < response.data.list.length; i++) {
                            let row = response.data.list[i];
                            let timeZone = PosnicPro.timeZone();
                            let update_timeStamp_value = parseInt(row.updated_date.$date.$numberLong);
                            let DateFormat = moment(update_timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
                            let updateDate = PosnicPro.convertDate(DateFormat);
                            let row_no = (table.data('current_page') - 1) * table.data('per_page') + i + 1;
                            let trow = '<tr> <td scope="row">' + row_no + '</td>  <td>' + row.sales_id + '</td> <td>' + updateDate + '</td> <td>' + $('<span>').text(PosnicPro.paymentreport.recordedUser(row)).html() + '</td> <td class="text-right">' + currency + '&nbsp;<span class="number">' + row.items_return_total + '</span></td></tr>';
                            $('#view_paymentreturntransaction').children('tbody').append(trow);
                            $('span.number').number(true, 2);
                        }
                    } else {
                        var paymentsalereportexportdata = [];
                        data = response.data.list;
                        $(data).each(function (key, val) {
                            let timeZone = PosnicPro.timeZone();
                            let update_timeStamp_value = parseInt(val.updated_date.$date.$numberLong);
                            let DateFormat = moment(update_timeStamp_value).tz(timeZone).format('YYYY/MM/DD LT');
                            let date = PosnicPro.convertDate(DateFormat);
                            let id = val.sales_id;
                            let customer = PosnicPro.paymentreport.recordedUser(val);
                            let total = val.items_return_total;
                            paymentsalereportexportdata.push({SaleId: id, Date: date, UserName: customer, Amount: total});
                        });
                        PosnicPro.JSONToCSVConvertor(paymentsalereportexportdata, 'payment-return-sale-reports', true);
                        PosnicPro.paymentreturntransaction.paymentreturntransactionTable();
                    }
                } else {
                    PosnicPro.alert(response.type, response.message);
                }
            }, function (xhr) {
                var response = jQuery.parseJSON(xhr.responseText);
                PosnicPro.alert(response.type, response.message);
            });
        } else {
            $("#payment_sale_transaction_value").focus();
        }
    },
    paymentreturntransactionexport: function (index) {
        let type = $(index).data('id');
        PosnicPro.paymentreturntransaction.paymentreturntransactionTable(type);
    },
    paymentReturnTabClick: function () {
        $('#change_payment_view').data('id', 'statusReturnView');
        PosnicPro.paymentreturntransaction.paymentreturntransactionTable();
    }
};


PosnicPro.paymentroot = {
    viewPage: function (index) {
        var type = $(index).data('id');
        if (type === 'tableView') {
            PosnicPro.paymentreport.paymentSaleReportView();
        } else if (type === 'statusReturnView') {
            PosnicPro.paymentreturntransaction.paymentreturntransactionTable();
        } else {
            PosnicPro.paymentransaction.paymentransactionTable();
        }

    }
};
$(document).ready(function () {
    var hash = window.location.hash.slice(1);
    if (hash === '/paymentreport') {
        var loader = $(".loader-sales-payment-report");
        loader.find(".loadingSpinner:first").remove();
        PosnicPro.paymentreport.paymentSaleReportView();
    }
});
