/* Party debt: customer receivables, supplier payables, collections and statements. */
(function () {
    'use strict';

    var state = {
        initialized: false,
        active: 'customer',
        search: '',
        sort: 'outstanding',
        page: { customer: 1, supplier: 1 },
        limit: 20,
        rows: { customer: [], supplier: [] },
        totals: { customer: 0, supplier: 0 },
        statement: null,
        statementPage: { ledger: 1, invoices: 1, payments: 1 }
    };

    var STATEMENT_PAGE_SIZE = { ledger: 20, invoices: 10, payments: 10 };

    function aclCan(module, perm) {
        var u = PosnicPro.userACL;
        return !!(u && u[module] && u[module][perm] === true);
    }

    function canWrite(type) {
        return aclCan(type === 'supplier' ? 'supplier' : 'customer', 'write');
    }

    function esc(value) {
        return $('<i>').text(value === null || value === undefined ? '' : String(value)).html();
    }

    function responseError(xhr, fallback) {
        var response = {};
        try { response = JSON.parse(xhr.responseText); } catch (e) { /* plain text */ }
        return (response && response.message) || fallback;
    }

    function currency() {
        return PosnicPro.local.get('currencySign') || '$';
    }

    function money(value) {
        var n = Number(value);
        if (!Number.isFinite(n)) n = 0;
        return currency() + ' ' + n.toFixed(2);
    }

    function roundAmount(value) {
        var n = Number(value);
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    }

    function t(key, fallback) {
        return PosnicPro.i18n.t(key, fallback);
    }

    function dateText(value) {
        if (!value) return '—';
        if (typeof moment !== 'undefined') {
            var m = moment(value);
            if (m.isValid()) return m.format('YYYY-MM-DD');
        }
        return String(value).slice(0, 10);
    }

    /*
     * A statement is an audit trail, so the time matters as much as the day:
     * two collections on the same afternoon must not look identical. Times
     * are shown in the shop's timezone, not the browser's, so the ledger
     * agrees with the till that recorded it.
     */
    function dateTimeText(value) {
        if (!value) return '—';
        if (typeof moment !== 'undefined') {
            var m = moment(value);
            if (m.isValid()) {
                try {
                    if (PosnicPro.timeZone) m = m.tz(PosnicPro.timeZone());
                } catch (e) { /* leave the parsed value */ }
                return m.format('YYYY-MM-DD HH:mm');
            }
        }
        var text = String(value).replace('T', ' ');
        return text.length > 16 ? text.slice(0, 16) : text;
    }

    function localDateTimeValue(date) {
        var d = date || new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function branches() {
        var $select = $('#debts_branch');
        var value = $select.val() || [];
        if (!Array.isArray(value)) value = [value];
        /* The picker's "select all" option carries a comma-joined value. */
        value = value.reduce(function (ids, id) {
            return ids.concat(String(id).split(','));
        }, []).filter(function (id) { return !!id; });
        if (!value.length) {
            /*
             * The branch picker is filled by the global branch loader. On a
             * slow start it still holds only the "All" placeholder, and an
             * empty scope would silently mean every branch while the picker
             * is about to show the current one. Fall back to the branch the
             * session is already on until the real options arrive.
             */
            var hasBranchOption = $select.find('option').filter(function () {
                return !!this.value;
            }).length > 0;
            if (!hasBranchOption) {
                var current = PosnicPro.local.get('branch_id_set');
                if (current) return [current];
            }
        }
        return value;
    }

    /*
     * A payment belongs to exactly one branch. The supplier/customer detail
     * screens open this dialog without ever visiting the Debts page, so the
     * hidden branch picker can still be empty. In that case use the branch
     * the session is already working in; never silently post a payment with
     * no branch or with several.
     */
    function paymentBranch() {
        var list = branches();
        if (list.length === 1) return String(list[0]);
        if (!list.length) {
            var current = String(PosnicPro.local.get('branch_id_set') || '');
            if (current) return current;
        }
        return '';
    }

    function requestId() {
        try {
            if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
            if (window.crypto && window.crypto.getRandomValues) {
                var bytes = new Uint8Array(16);
                window.crypto.getRandomValues(bytes);
                return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
            }
        } catch (e) { /* fall through */ }
        return 'debt-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    }

    function apiData(type) {
        return {
            page: state.page[type],
            limit: state.limit,
            search: state.search,
            sort: state.sort,
            branch: branches()
        };
    }

    function loading(type, on) {
        var $tbody = $('#debts_' + type + '_table tbody');
        if (on && !$tbody.children('tr.debts-loading').length) {
            $tbody.html('<tr class="debts-loading"><td colspan="8" class="text-center py-4"><div class="loadingSpinner"></div></td></tr>');
        } else if (!on) {
            $tbody.children('tr.debts-loading').remove();
        }
    }

    function pager(type, total, page) {
        var pages = Math.max(1, Math.ceil(total / state.limit));
        var host = $('#debts_' + type + '_pager').empty();
        if (pages <= 1) return;
        var prev = $('<button type="button" class="btn btn-sm btn-outline-secondary">‹</button>')
            .prop('disabled', page <= 1)
            .on('click', function () { goPage(type, page - 1); });
        host.append(prev);
        var from = Math.max(1, page - 2);
        var to = Math.min(pages, from + 4);
        from = Math.max(1, to - 4);
        for (var i = from; i <= to; i += 1) {
            (function (n) {
                host.append(
                    $('<button type="button" class="btn btn-sm ' + (n === page ? 'btn-primary' : 'btn-outline-secondary') + '">' + n + '</button>')
                        .on('click', function () { goPage(type, n); })
                );
            })(i);
        }
        host.append(
            $('<button type="button" class="btn btn-sm btn-outline-secondary">›</button>')
                .prop('disabled', page >= pages)
                .on('click', function () { goPage(type, page + 1); })
        );
    }

    function goPage(type, page) {
        state.page[type] = Math.max(1, page);
        loadList(type);
    }

    function render(type, response) {
        var rows = (response && response.data) || [];
        state.rows[type] = rows;
        state.totals[type] = (response && response.total) || 0;
        state.page[type] = (response && response.page) || 1;
        var $tbody = $('#debts_' + type + '_table tbody').empty();
        if (!rows.length) {
            $('#debts_' + type + '_empty').show();
            $('#debts_' + type + '_total').text(0);
            pager(type, 0, 1);
            return;
        }
        $('#debts_' + type + '_empty').hide();
        $('#debts_' + type + '_total').text(state.totals[type]);
        var start = (state.page[type] - 1) * state.limit;
        rows.forEach(function (row, index) {
            var name = row.name || row.phone || '';
            var actions = '<button type="button" class="btn btn-sm btn-outline-secondary debts-statement mr-1" data-type="' + type + '" data-id="' + esc(row.id) + '">'
                + esc(PosnicPro.i18n.t('lang_statement', 'Statement')) + '</button>';
            if (canWrite(type)) {
                actions += '<button type="button" class="btn btn-sm btn-primary debts-pay" data-type="' + type + '" data-id="' + esc(row.id) + '">'
                    + esc(type === 'supplier'
                        ? PosnicPro.i18n.t('lang_pay_supplier', 'Pay supplier')
                        : PosnicPro.i18n.t('lang_collect_payment', 'Collect payment')) + '</button>';
            }
            var $tr = $('<tr>')
                .append($('<td>').text(start + index + 1))
                .append($('<td>').text(name))
                .append($('<td>').text(row.phone || '—'))
                .append($('<td class="text-right font-weight-bold">').text(money(row.outstanding)))
                .append($('<td class="text-center">').text(row.invoice_count || 0))
                .append($('<td>').text(dateText(row.oldest_due)))
                .append($('<td>').text(row.last_payment ? dateTimeText(row.last_payment) : dateText(row.last_payment)))
                .append($('<td class="text-right">').html(actions));
            $tbody.append($tr);
        });
        pager(type, state.totals[type], state.page[type]);
    }

    function loadList(type) {
        loading(type, true);
        var url = type === 'supplier' ? 'debts/suppliers' : 'debts/customers';
        PosnicPro.get({ url: url, data: apiData(type) }, function (response) {
            if (response.type !== 'success') {
                loading(type, false);
                PosnicPro.alert('error', response.message || 'Could not load debts.');
                return;
            }
            render(type, response.data);
        }, function (xhr) {
            loading(type, false);
            PosnicPro.alert('error', responseError(xhr, 'Could not load debts.'));
        });
    }

    function loadSummary() {
        PosnicPro.get({ url: 'debts/summary', data: { branch: branches() } }, function (response) {
            if (response.type !== 'success' || !response.data) return;
            var data = response.data;
            $('#debts_receivables').text(Number(data.receivables || 0).toFixed(2));
            $('#debts_payables').text(Number(data.payables || 0).toFixed(2));
            $('#debts_net').text(Number(data.net || 0).toFixed(2));
            $('#debts_customer_count').text(data.customers || 0);
            $('#debts_supplier_count').text(data.suppliers || 0);
        }, function () {
            /* Never show a failed summary as a real zero. */
            $('#debts_receivables, #debts_payables, #debts_net').text('—');
        });
    }

    function openPayment(type, id, suppliedRow) {
        /*
         * A collection is posted against one branch. Allowing a payment while
         * several branches are in view would allocate it across branches but
         * file the ledger row under only one of them, so the other branch's
         * statement would show a reduced invoice with no matching payment.
         */
        var branch = paymentBranch();
        if (!branch) {
            PosnicPro.alert('information', PosnicPro.i18n.t('lang_select_one_branch_for_payment', 'Select one branch to record a payment.'));
            return;
        }
        /*
         * The customer and supplier screens open this modal directly. Their
         * shortcut must not depend on the Debts page having been visited
         * first, because init() is what binds the form's submit handler.
         */
        init();
        var row = suppliedRow || (state.rows[type] || []).find(function (item) { return String(item.id) === String(id); });
        if (!row) {
            PosnicPro.get({
                url: 'debts/' + (type === 'supplier' ? 'suppliers' : 'customers') + '/' + encodeURIComponent(id) + '/statement',
                data: { branch: [branch] }
            }, function (response) {
                if (response.type !== 'success' || !response.data) {
                    PosnicPro.alert('error', (response && response.message) || 'Could not load this party.');
                    return;
                }
                var party = response.data.party || {};
                var summary = response.data.summary || {};
                if (Number(summary.outstanding) <= 0.004) {
                    PosnicPro.alert('information', PosnicPro.i18n.t('lang_nothing_outstanding_for_this_party', 'There is no outstanding balance for this party.'));
                    return;
                }
                openPayment(type, id, {
                    id: party.id || id,
                    name: party.name || '',
                    phone: party.phone || '',
                    outstanding: summary.outstanding
                });
            }, function (xhr) {
                PosnicPro.alert('error', responseError(xhr, 'Could not load this party.'));
            });
            return;
        }
        var customer = type === 'customer';
        $('#debts_payment_party_type').val(type);
        $('#debts_payment_party_id').val(row.id);
        $('#debts_payment_party_name').val(row.name || row.phone || '');
        $('#debts_payment_outstanding')
            .val(money(row.outstanding))
            .data('amount', Number(row.outstanding) || 0);
        $('#debts_payment_amount')
            .val(Number(row.outstanding).toFixed(2))
            .att('max', Number(row.outstanding).toFixed(2));
        $('#debts_payment_note').val('');
        $('#debts_payment_error').addClass('d-none').text('');
        $('#debts_payment_date').val(localDateTimeValue(new Date()));
        $('#debts_payment_request_id').val(requestId());
        $('#debts_payment_title').text(
            customer
                ? PosnicPro.i18n.t('lang_collect_payment', 'Collect payment')
                : PosnicPro.i18n.t('lang_pay_supplier', 'Pay supplier')
        );
        $('#debts_payment_modal').modal('show');
    }

    function submitPayment(event) {
        event.preventDefault();
        var amount = Number($('#debts_payment_amount').val());
        var outstanding = Number($('#debts_payment_outstanding').data('amount'));
        var $error = $('#debts_payment_error').addClass('d-none').text('');
        if (!Number.isFinite(amount) || amount <= 0) {
            $error.text(PosnicPro.i18n.t('lang_enter_a_payment_amount_greater_than_zero', 'Enter a payment amount greater than zero.')).removeClass('d-none');
            return;
        }
        if (Number.isFinite(outstanding) && amount > outstanding + 0.004) {
            $error.text(PosnicPro.i18n.t('lang_amount_is_more_than_outstanding', 'The amount is more than the outstanding balance.')).removeClass('d-none');
            return;
        }
        var branch = paymentBranch();
        if (!branch) {
            $error.text(PosnicPro.i18n.t('lang_select_one_branch_for_payment', 'Select one branch to record a payment.')).removeClass('d-none');
            return;
        }
        var $save = $('#debts_payment_save').prop('disabled', true);
        /*
         * datetime-local has no timezone. Convert it with the browser's own
         * offset so the server stores the instant the cashier chose, and the
         * statement can render it back in the shop's timezone.
         */
        var dateValue = $('#debts_payment_date').val();
        var dateIso = '';
        if (dateValue) {
            var chosen = new Date(dateValue);
            if (!Number.isNaN(chosen.getTime())) dateIso = chosen.toISOString();
        }
        var payload = {
            party_type: $('#debts_payment_party_type').val(),
            party_id: $('#debts_payment_party_id').val(),
            amount: amount,
            date: dateIso,
            note: $('#debts_payment_note').val(),
            request_id: $('#debts_payment_request_id').val(),
            branch: [branch],
            branch_id: branch
        };
        PosnicPro.post({ url: 'debts/payments', data: JSON.stringify(payload) }, function (response) {
            $save.prop('disabled', false);
            if (response.type !== 'success') {
                $error.text(response.message || 'Could not record the payment.').removeClass('d-none');
                return;
            }
            $('#debts_payment_modal').modal('hide');
            PosnicPro.alert('success', response.message || 'Payment recorded');
            loadSummary();
            loadList(payload.party_type);
        }, function (xhr) {
            $save.prop('disabled', false);
            $error.text(responseError(xhr, 'Could not record the payment.')).removeClass('d-none');
        });
    }

    /*
     * The statement is deliberately three columns: when it happened, what it
     * was, and what it did to the account. The bill number lives inside the
     * type link instead of taking a column of its own.
     */
    function statementReference(row) {
        var value = row && (row.number || row.reference);
        value = value === null || value === undefined ? '' : String(value).trim();
        if (!value) return '';
        if (row && row.record_id && value === String(row.record_id)) return '';
        if (/^[a-f0-9]{24}$/i.test(value)) return '';
        return value;
    }

    function statementMoney(value) {
        return '<span class="debts-money" dir="ltr">' + esc(money(value)) + '</span>';
    }

    function statementDocLink(type, row, inner) {
        if (!row || !row.record_id) return '';
        if (row.kind !== 'sale' && row.kind !== 'purchase' && row.kind !== 'paid_at_sale') return '';
        var module = type === 'supplier' ? 'receiving' : 'sales';
        if (!aclCan(module, 'read')) return '';
        var route = type === 'supplier' ? 'purchaseorders' : 'sales';
        var href = '#/' + route + '/' + encodeURIComponent(String(row.record_id));
        return '<a href="' + esc(href) + '" class="debts-doc-link" data-module="' + esc(module)
            + '" data-access="read" title="' + esc(t('lang_view_details', 'View details')) + '">'
            + inner + '</a>';
    }

    function statementTypeCell(type, row, label) {
        var reference = statementReference(row);
        var inner = '<span class="debts-type-label">' + esc(label) + '</span>'
            + (reference ? '<span class="debts-type-ref">' + esc(reference) + '</span>' : '');
        var link = statementDocLink(type, row, inner);
        var sub = row && row.kind === 'payment' && row.note
            ? '<small class="debts-type-sub" title="' + esc(row.note) + '">' + esc(row.note) + '</small>'
            : '';
        return '<div class="debts-type-cell">' + (link || inner) + sub + '</div>';
    }

    function statementFlowPart(label, value, className) {
        return '<span class="debts-flow-part ' + (className || '') + '">'
            + '<small>' + esc(label) + '</small>'
            + '<b>' + statementMoney(value) + '</b></span>';
    }

    function statementLedgerValue(row) {
        var debit = roundAmount(row.debit);
        var credit = roundAmount(row.credit);
        var balance = roundAmount(row.balance);
        if (credit > 0.004) {
            var before = roundAmount(balance + credit - debit);
            var label = t('lang_balance', 'Balance') + ': ' + money(before)
                + ' - ' + t('lang_amount_title', 'Amount') + ': ' + money(credit)
                + ' = ' + t('lang_after_payment', 'After payment') + ': ' + money(balance);
            return '<div class="debts-value-cell"><div class="debts-flow" aria-label="' + esc(label) + '">'
                + statementFlowPart(t('lang_balance', 'Balance'), before, 'debts-flow-before')
                + '<span class="debts-flow-op" aria-hidden="true">−</span>'
                + statementFlowPart(t('lang_amount_title', 'Amount'), credit, 'debts-flow-paid')
                + '<span class="debts-flow-op" aria-hidden="true">=</span>'
                + statementFlowPart(t('lang_after_payment', 'After payment'), balance, 'debts-flow-after')
                + '</div></div>';
        }
        return '<div class="debts-value-cell">'
            + '<strong class="debts-value-main">' + statementMoney(debit || balance) + '</strong>'
            + '<small class="debts-value-sub">' + esc(t('lang_balance', 'Balance')) + ' '
            + statementMoney(balance) + '</small></div>';
    }

    function statementInvoiceValue(invoice) {
        var remaining = roundAmount(invoice.remaining);
        var status = remaining > 0.004
            ? esc(t('lang_remaining', 'Remaining')) + ' ' + statementMoney(remaining)
            : '<span class="text-success">' + esc(t('lang_paid', 'Paid')) + '</span>';
        return '<div class="debts-value-cell">'
            + '<strong class="debts-value-main">' + statementMoney(invoice.total) + '</strong>'
            + '<small class="debts-value-sub">' + status + '</small></div>';
    }

    function statementPager(section, total, page, limit) {
        var pages = Math.max(1, Math.ceil(total / limit));
        var from = total ? (page - 1) * limit + 1 : 0;
        var to = Math.min(total, page * limit);
        var label = t('lang_showing', 'Showing') + ' ' + from + '–' + to
            + ' ' + t('lang_of', 'of') + ' ' + total;
        if (pages <= 1) return '<span class="debts-page-count">' + esc(label) + '</span>';
        return '<span class="debts-page-count">' + esc(label) + '</span>'
            + '<span class="debts-page-position">' + esc(t('lang_page', 'Page')) + ' '
            + page + ' / ' + pages + '</span>'
            + '<span class="debts-page-actions">'
            + '<button type="button" class="debts-statement-page" data-section="' + esc(section)
            + '" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '')
            + ' aria-label="' + esc(t('lang_previous', 'Previous')) + '">&lsaquo;</button>'
            + '<button type="button" class="debts-statement-page" data-section="' + esc(section)
            + '" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '')
            + ' aria-label="' + esc(t('lang_next', 'Next')) + '">&rsaquo;</button>'
            + '</span>';
    }

    function statementSection(section, title, count, total) {
        return '<section class="debts-statement-section">'
            + '<button type="button" class="debts-statement-toggle collapsed" data-toggle="collapse"'
            + ' data-target="#debts_statement_' + section + '" aria-expanded="false"'
            + ' aria-controls="debts_statement_' + section + '">'
            + '<span class="debts-section-heading"><i class="feather icon-chevron-down debts-section-chevron" aria-hidden="true"></i>'
            + esc(title) + '<span class="debts-section-count">' + Number(count || 0) + '</span></span>'
            + '<span class="debts-section-total">' + statementMoney(total || 0) + '</span>'
            + '</button>'
            + '<div class="collapse" id="debts_statement_' + section + '">'
            + '<div class="table-responsive"><table class="table table-sm debts-statement-table">'
            + '<thead><tr><th>' + esc(t('lang_date_title', 'Date')) + '</th>'
            + '<th>' + esc(t('lang_type_title', 'Type')) + '</th>'
            + '<th class="debts-value-col">' + esc(t('lang_value_title', 'Value')) + '</th>'
            + '</tr></thead><tbody id="debts_statement_' + section + '_rows"></tbody></table></div>'
            + '<div class="debts-statement-pager" id="debts_statement_' + section + '_pager"></div>'
            + '</div></section>';
    }

    function statementSummary(data) {
        var summary = data.summary || {};
        var paid = roundAmount(Number(summary.paid_at_sale || 0) + Number(summary.collected || 0));
        var credit = roundAmount(summary.credit);
        return '<div class="debts-statement-summary">'
            + '<div class="debts-summary-primary">'
            + '<span class="debts-summary-label">' + esc(t('lang_po_outstanding', 'Outstanding')) + '</span>'
            + '<strong class="debts-summary-value">' + statementMoney(summary.outstanding) + '</strong>'
            + (credit > 0.004
                ? '<small class="debts-summary-credit">' + esc(t('lang_credit_title', 'Credit'))
                    + ' ' + statementMoney(credit) + '</small>'
                : '')
            + '</div>'
            + '<div class="debts-summary-item"><span class="debts-summary-label">'
            + esc(t('lang_invoiced', 'Invoiced')) + '</span><strong>'
            + statementMoney(summary.invoiced) + '</strong></div>'
            + '<div class="debts-summary-item"><span class="debts-summary-label">'
            + esc(t('lang_payments', 'Payments')) + '</span><strong>'
            + statementMoney(paid) + '</strong></div>'
            + '</div>';
    }

    function sortedStatementRows(section, data) {
        var rows = section === 'ledger'
            ? data.ledger || []
            : section === 'invoices'
                ? (data.invoices || []).slice()
                : (data.payments || []).slice();
        if (section === 'ledger') return rows;
        return rows.sort(function (a, b) {
            return String(b.date || '').localeCompare(String(a.date || ''));
        });
    }

    function statementEmptyRow(text) {
        return '<tr><td colspan="3" class="debts-statement-empty">' + esc(text) + '</td></tr>';
    }

    function statementLedgerRow(type, row) {
        var label = row.kind === 'sale'
            ? t('lang_sales_title', 'Sale')
            : row.kind === 'purchase'
                ? t('lang_purchase', 'Purchase')
                : row.kind === 'paid_at_sale'
                    ? (type === 'supplier'
                        ? t('lang_paid_at_purchase', 'Paid at purchase')
                        : t('lang_paid_at_sale', 'Paid at sale'))
                    : t('lang_payment', 'Payment');
        return '<tr><td class="debts-nowrap">' + esc(dateTimeText(row.date)) + '</td>'
            + '<td>' + statementTypeCell(type, row, label) + '</td>'
            + '<td class="debts-value-col">' + statementLedgerValue(row) + '</td></tr>';
    }

    function statementInvoiceRow(type, invoice) {
        var row = {
            kind: type === 'supplier' ? 'purchase' : 'sale',
            record_id: invoice.id,
            number: invoice.number,
            reference: invoice.number
        };
        return '<tr><td class="debts-nowrap">' + esc(dateTimeText(invoice.date)) + '</td>'
            + '<td>' + statementTypeCell(type, row, t('lang_invoice', 'Invoice')) + '</td>'
            + '<td class="debts-value-col">' + statementInvoiceValue(invoice) + '</td></tr>';
    }

    function statementPaymentRow(type, payment) {
        var row = { kind: 'payment', reference: payment.reference, note: payment.note };
        var remove = '';
        if (canWrite(type)) {
            remove = '<button type="button" class="debts-remove-payment debts-icon-btn"'
                + ' data-type="' + esc(type) + '" data-id="' + esc(payment.id) + '"'
                + ' title="' + esc(t('lang_remove', 'Remove')) + '"'
                + ' aria-label="' + esc(t('lang_remove', 'Remove')) + '">'
                + '<i class="feather icon-trash-2" aria-hidden="true"></i></button>';
        }
        return '<tr><td class="debts-nowrap">' + esc(dateTimeText(payment.date)) + '</td>'
            + '<td>' + statementTypeCell(type, row, t('lang_payment', 'Payment')) + '</td>'
            + '<td class="debts-value-col"><div class="debts-payment-value">'
            + '<strong class="debts-value-main">' + statementMoney(payment.amount) + '</strong>'
            + remove + '</div></td></tr>';
    }

    function paintStatementSection(section) {
        var statement = state.statement;
        if (!statement) return;
        var data = statement.data || {};
        var rows = sortedStatementRows(section, data);
        var limit = STATEMENT_PAGE_SIZE[section] || 20;
        var pages = Math.max(1, Math.ceil(rows.length / limit));
        var page = Math.min(Math.max(1, Number(state.statementPage[section]) || 1), pages);
        state.statementPage[section] = page;
        var start = (page - 1) * limit;
        var visible = rows.slice(start, start + limit);
        var html = '';
        if (section === 'ledger') {
            if (!visible.length) html = statementEmptyRow(t('lang_no_records', 'No Records'));
            visible.forEach(function (row) { html += statementLedgerRow(statement.type, row); });
        } else if (section === 'invoices') {
            if (!visible.length) html = statementEmptyRow(t('lang_no_invoices', 'No invoices'));
            visible.forEach(function (invoice) { html += statementInvoiceRow(statement.type, invoice); });
        } else {
            if (!visible.length) html = statementEmptyRow(t('lang_no_payments_yet', 'No payments yet'));
            visible.forEach(function (payment) { html += statementPaymentRow(statement.type, payment); });
        }
        $('#debts_statement_' + section + '_rows').html(html);
        $('#debts_statement_' + section + '_pager').html(rows.length
            ? statementPager(section, rows.length, page, limit)
            : '');
    }

    function paintStatement() {
        paintStatementSection('ledger');
        paintStatementSection('invoices');
        paintStatementSection('payments');
    }

    function statementRows(type, data) {
        data = data || {};
        return '<div class="debts-statement-sheet">'
            + statementSummary(data)
            /* One account, oldest first. Charges debit the account; money
               handed over at the sale and every later collection/payment
               credit it. */
            + '<section class="debts-statement-section debts-ledger-section">'
            + '<div class="debts-section-static"><span class="debts-section-heading">'
            + esc(t('lang_transaction_history', 'Transaction History'))
            + '<span class="debts-section-count">' + (data.ledger || []).length + '</span></span></div>'
            + '<div class="table-responsive"><table class="table table-sm debts-statement-table debts-ledger-table">'
            + '<thead><tr><th>' + esc(t('lang_date_title', 'Date')) + '</th>'
            + '<th>' + esc(t('lang_type_title', 'Type')) + '</th>'
            + '<th class="debts-value-col">' + esc(t('lang_value_title', 'Value')) + '</th>'
            + '</tr></thead><tbody id="debts_statement_ledger_rows"></tbody></table></div>'
            + '<div class="debts-statement-pager" id="debts_statement_ledger_pager"></div>'
            + '</section>'
            + statementSection('invoices', t('lang_invoices', 'Invoices'),
                sortedStatementRows('invoices', data).length, data.summary && data.summary.invoiced)
            + statementSection('payments', t('lang_payments', 'Payments'),
                sortedStatementRows('payments', data).length, data.summary && data.summary.collected)
            + '</div>';
    }

    function openStatement(type, id) {
        init();
        state.statement = null;
        state.statementPage = { ledger: 1, invoices: 1, payments: 1 };
        $('#debts_statement_title').text(
            type === 'supplier'
                ? PosnicPro.i18n.t('lang_supplier_statement', 'Supplier statement')
                : PosnicPro.i18n.t('lang_customer_statement', 'Customer statement')
        );
        $('#debts_statement_body').html('<div class="text-center py-4"><div class="loadingSpinner"></div></div>');
        $('#debts_statement_modal').modal('show');
        PosnicPro.get({
            url: 'debts/' + (type === 'supplier' ? 'suppliers' : 'customers') + '/' + encodeURIComponent(id) + '/statement',
            data: { branch: branches() }
        }, function (response) {
            if (response.type !== 'success') {
                $('#debts_statement_body').html('<div class="alert alert-danger">' + esc(response.message || 'Could not load the statement.') + '</div>');
                return;
            }
            var data = response.data || {};
            var party = data.party || {};
            var meta = [];
            if (party.phone) meta.push(party.phone);
            if (party.address) meta.push(party.address);
            state.statement = { type: type, id: id, data: data };
            var heading = '<div class="debts-statement-party"><h5 class="mb-1">'
                + esc(party.name || '') + '</h5>'
                + (meta.length ? '<p class="text-muted mb-0">' + esc(meta.join(' · ')) + '</p>' : '')
                + '</div>';
            $('#debts_statement_body').html(heading + statementRows(type, data));
            paintStatement();
        }, function (xhr) {
            $('#debts_statement_body').html('<div class="alert alert-danger">' + esc(responseError(xhr, 'Could not load the statement.')) + '</div>');
        });
    }

    function removePayment(type, id) {
        swal({
            title: PosnicPro.i18n.t('lang_remove_payment', 'Remove this payment?'),
            text: PosnicPro.i18n.t('lang_remove_payment_note', 'The debt will go back to what it was.'),
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: PosnicPro.i18n.t('lang_remove', 'Remove'),
            cancelButtonText: PosnicPro.i18n.t('lang_cancel_title', 'Cancel')
        }).then(function (result) {
            if (!result || !result.value) return;
            PosnicPro.delete({ url: 'debts/payments/' + encodeURIComponent(id), data: {} }, function (response) {
                if (response.type !== 'success') {
                    PosnicPro.alert('error', response.message || 'Could not remove the payment.');
                    return;
                }
                PosnicPro.alert('success', response.message || 'Payment removed');
                loadSummary();
                loadList(type);
                $('#debts_statement_modal').modal('hide');
            }, function (xhr) {
                PosnicPro.alert('error', responseError(xhr, 'Could not remove the payment.'));
            });
        });
    }

    function debounce(fn, wait) {
        var timer;
        return function () {
            var args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(null, args); }, wait);
        };
    }

    function init() {
        if (state.initialized) return;
        state.initialized = true;
        $('#debts_search').on('input', debounce(function () {
            state.search = $(this).val();
            state.page.customer = 1;
            state.page.supplier = 1;
            loadList(state.active);
        }, 300));
        $('#debts_sort').on('change', function () {
            state.sort = $(this).val();
            state.page.customer = 1;
            state.page.supplier = 1;
            loadList(state.active);
        });
        $('#debts_branch').on('change', function () {
            state.page.customer = 1;
            state.page.supplier = 1;
            loadSummary();
            loadList(state.active);
        });
        $('#debts_customer_tab').on('shown.bs.tab', function () {
            state.active = 'customer';
            loadList('customer');
        });
        $('#debts_supplier_tab').on('shown.bs.tab', function () {
            state.active = 'supplier';
            loadList('supplier');
        });
        $('#debts_payment_form').on('submit', submitPayment);
        $(document).on('click', '.debts-pay', function () {
            openPayment($(this).data('type'), $(this).data('id'));
        });
        $(document).on('click', '.debts-statement', function () {
            openStatement($(this).data('type'), $(this).data('id'));
        });
        $(document).on('click', '.debts-remove-payment', function () {
            removePayment($(this).data('type'), $(this).data('id'));
        });
        $(document).on('click', '.debts-statement-page', function () {
            if (!state.statement) return;
            var section = String($(this).data('section') || '');
            var page = Number($(this).data('page'));
            if (!STATEMENT_PAGE_SIZE[section] || !Number.isFinite(page) || page < 1) return;
            state.statementPage[section] = page;
            paintStatementSection(section);
        });
        /* The statement stays a sheet in front of the shop. Opening a bill
           dismisses it first, so the detail page is not left behind a modal. */
        $(document).on('click', '.debts-doc-link', function () {
            $('#debts_statement_modal').modal('hide');
        });
    }

    PosnicPro.debts = {
        showDataTablePage: function () {
            PosnicPro.HideSideBarModal();
            $('.page_loader,#osk-container').hide();
            $('.nav-link-active,.tab-pane-active,.dropdown-item').removeClass('active');
            $('.vertical-menu li a').removeClass('active');
            $('.page-title-box,#debts_new').show();
            $('#v-pills-report-tab,#rgrp_debts_page').addClass('active');
            $('#v-pills-report').addClass('show active');
            init();
            if (!$('#debts_branch option').filter(function () { return !!this.value; }).length) {
                PosnicPro.getBranchDropdownOption();
            }
            loadSummary();
            loadList(state.active);
        },
        openPayment: openPayment,
        payParty: function (type, id) {
            openPayment(type, id);
        },
        openStatement: openStatement,
        formatDateTime: dateTimeText,
        reload: function () {
            loadSummary();
            loadList(state.active);
        }
    };
})();
