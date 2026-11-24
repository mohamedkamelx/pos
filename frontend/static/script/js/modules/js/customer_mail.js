PosnicPro.customermail = {

    customerMailPrint: function () {
        let id = PosnicPro.getAllUrlParams().id;
        let params = {
            url: 'sales/getCustomerPrint',
            data: {customer_id: id}
        };
        PosnicPro.get(params, function (response) {
            if (response.type === 'success') {

                const data = response.data || {};
                const money = (value) => (Number(value) || 0).toFixed(2);
                const image_path = (data.branch_image !== "store.png") ? data.branch_image : 'static/images/default/' + data.branch_image;
                $('.branch_image').attr('src', image_path);
                $("#getCustomerMailId").val(id);
                $(".branch-name").html(data.branch_name);
                $(".branch-email").html(data.branch_email);
                $(".branch-phone").html(data.branch_phone);
                $(".branch-address").html(data.branch_address);
                $('.sales_id').html(data.sales_id);
                $('.customer_date_view').html(data.date);
                $('.customer_time_view').html(data.time);
                $('.customer_name_view').html(data.customer_name);
                $('.customer_phone_view').html(data.customer_phone);
                $('.customer_email_view').html(data.customer_email);
                $('.customer_address_view').html(data.customer_address);
                $('#barcodeValue').val(data.sales_id);
                PosnicPro.printBarcode();

                if (money(data.discount) !== '0.00') {
                    $('.customer_discount_view').html(money(data.discount));
                } else {
                    $('#customer_discount_view').hide();
                }

                $('.customer_subtotal_view').html(data.branch_currency + '&nbsp;' + money(data.sales_sub_total));
                $('.customer_total_view').html(data.branch_currency + '&nbsp;' + money(data.total_amount));
                $('.customer_payments_view').html(data.branch_currency + '&nbsp;' + money(data.partial_balance));
                $('.customer_BalanceDue_view').html(data.branch_currency + '&nbsp;' + money(data.payment_pending));
                $('.customer_PaymentStatus_view').html(data.payment_status);

                (data.payment_status == null || data.payment_status === 'Paid') ?
                        $('.customer_PaymentStatus_view').addClass('badge badge-success-inverse') :
                        $('.customer_PaymentStatus_view').addClass('badge badge-warning-inverse');
                (data.partial_check === "true") ? $('.partial-check-hide').show() : $('.partial-check-hide').hide();

                const items = Array.isArray(data.items) ? data.items : [];
                let qtyTotal = 0;
                $('#customer_item_list tbody').empty();
                items.forEach(function (item) {
                    const qty = Number(item.item_quantity) || 0;
                    const price = Number(item.item_price) || 0;
                    let lineTotal = Number(item.total_amount);
                    if (!Number.isFinite(lineTotal)) {
                        lineTotal = price * qty;
                        const lineDiscount = Number(item.item_discount) || 0;
                        const lineDiscountPercent = Number(item.item_discount_percentage) || 0;
                        lineTotal -= lineDiscount > 0 ? lineDiscount * qty : lineTotal * lineDiscountPercent / 100;
                    }
                    qtyTotal += qty;
                    const rowHTMLLine = ' <tr> ' +
                            '<td class="text-left">' + item.item_name + '</td>' +
                            '<td class="text-center">' + qty + '</td>' +
                            '<td class="text-right">' + data.branch_currency + '&nbsp;' + lineTotal.toFixed(2) + ' </td>' +
                            '</tr>';
                    $('#customer_item_list tbody').append(rowHTMLLine);
                });

                $('.customer_itemlength_view').html(items.length);
                $('.customer_itemqty_view').html(qtyTotal);

                const roundOffValue = Number(data.round_off) || 0;
                $('#customer_roundoff_view').hide();
                if (roundOffValue !== 0) {
                    $('#customer_roundoff_view').show();
                    $('.customer_roundoff_view').html(data.branch_currency + '<span class="number">' + roundOffValue.toFixed(2));
                }

            } else {
                PosnicPro.alert(response.type, response.message);
            }
        }, function (xhr) {
            var response = jQuery.parseJSON(xhr.responseText);
            PosnicPro.alert(response.type, response.message);
        });
        return false;
    }
};

$(document).ready(function () {
    PosnicPro.customermail.customerMailPrint();
});

$("#downloadPDF").click(function () {
    const {jsPDF} = window.jspdf;

    const receiptElement = document.getElementById("receipt");

    // Higher render scale = sharper output. Factor in the device pixel ratio so
    // it stays crisp on hi-dpi screens; floor at 3 and cap at 4 to keep memory
    // and file size reasonable.
    const scale = Math.min(4, Math.max(3, (window.devicePixelRatio || 1) * 2));

    html2canvas(receiptElement, {
        scale: scale,
        useCORS: true, // Ensures cross-origin images work
        backgroundColor: "#ffffff", // solid white, no transparency artifacts
        width: receiptElement.scrollWidth,   // capture full content width (no right-edge clipping)
        height: receiptElement.scrollHeight,
        windowWidth: receiptElement.scrollWidth,
        logging: false
    }).then(canvas => {
        const imgData = canvas.toDataURL("image/png"); // PNG = lossless

        // Set PDF dimensions. The receipt keeps its 80mm width; a left margin is
        // added to the PDF only (the on-screen receipt is unaffected).
        const contentWidth = 80; // receipt width in mm
        const leftMarginMm = 60 * 25.4 / 96; // 60px -> ~15.88mm at 96dpi
        const pageWidth = contentWidth + leftMarginMm;
        const pdfHeight = (canvas.height * contentWidth) / canvas.width; // keep aspect ratio

        const pdf = new jsPDF({
            unit: "mm",
            format: [pageWidth, pdfHeight],
            compress: false // keep the receipt image at full quality
        });

        // Offset by the left margin; "NONE" = no re-compression -> max sharpness
        pdf.addImage(imgData, "PNG", leftMarginMm, 0, contentWidth, pdfHeight, undefined, "NONE");
        let saleId = $('.sales_id').html();
        pdf.save(saleId + ".pdf");
    });
});
