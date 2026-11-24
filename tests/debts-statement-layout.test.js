'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const RAW_ID = '64b000000000000000000001';

const AR = {
  lang_customer_statement: 'كشف حساب العميل',
  lang_supplier_statement: 'كشف حساب المورد',
  lang_transaction_history: 'سجل المعاملات',
  lang_date_title: 'التاريخ',
  lang_type_title: 'النوع',
  lang_value_title: 'القيمة',
  lang_invoices: 'الفواتير',
  lang_payments: 'الدفعات',
  lang_invoice: 'فاتورة',
  lang_payment: 'دفعة',
  lang_sales_title: 'بيع',
  lang_purchase: 'شراء',
  lang_paid_at_sale: 'المدفوع عند البيع',
  lang_paid_at_purchase: 'المدفوع عند الشراء',
  lang_balance: 'الرصيد',
  lang_amount_title: 'المبلغ',
  lang_after_payment: 'بعد الدفع',
  lang_remaining: 'المتبقي',
  lang_paid: 'مدفوعة',
  lang_total_paid: 'إجمالي المدفوع',
  lang_invoiced: 'إجمالي الفواتير',
  lang_po_outstanding: 'المتبقي',
  lang_showing: 'عرض',
  lang_of: 'من',
  lang_page: 'صفحة',
  lang_previous: 'السابق',
  lang_next: 'التالي',
  lang_no_records: 'لا توجد سجلات',
  lang_no_invoices: 'لا توجد فواتير',
  lang_no_payments_yet: 'لا توجد دفعات بعد',
  lang_remove: 'إزالة',
  lang_view_details: 'عرض التفاصيل',
  lang_statement: 'كشف حساب',
  lang_close_title: 'إغلاق',
};

function loadDebts(statement, type) {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<select id="debts_branch"></select>'
      + '<div id="debts_statement_modal">'
      + '<h5 id="debts_statement_title"></h5>'
      + '<div id="debts_statement_body"></div>'
      + '</div>'
      + '</body>',
    { runScripts: 'outside-only', url: 'http://localhost/' }
  );
  const w = dom.window;
  w.$ = w.jQuery = require('jquery')(w);
  w.$.fn.modal = function () { return this; };
  w.PosnicPro = {
    userACL: {
      customer: { write: true },
      supplier: { write: true },
      sales: { read: true },
      receiving: { read: true },
      report: { read: true },
    },
    local: {
      get: (key) => (key === 'currencySign' ? '$' : ''),
    },
    i18n: {
      t: (key, fallback) => AR[key] || fallback,
    },
    timeZone: () => 'Africa/Cairo',
    get: (options, success) => success({ type: 'success', data: statement }),
    delete: () => {},
    alert: () => {},
  };
  w.eval(read('frontend/static/script/js/modules/js/debts.js'));
  w.PosnicPro.debts.openStatement(type || 'customer', 'party-1');
  return { dom: dom, $: w.$, window: w };
}

function headers($, selector) {
  return $(selector + ' thead th').map(function () {
    return $(this).text().trim();
  }).get();
}

test('customer statement is date/type/value and payment rows carry before, paid and after', () => {
  const statement = {
    party: { name: 'أحمد علي', phone: '01000000000', address: 'القاهرة' },
    summary: { invoiced: 300, paid_at_sale: 0, collected: 150, outstanding: 150 },
    ledger: [
      {
        date: '2026-11-01T10:00:00.000Z',
        kind: 'sale',
        number: 'INV-1',
        record_id: RAW_ID,
        debit: 300,
        credit: 0,
        balance: 300,
      },
      {
        date: '2026-11-02T11:00:00.000Z',
        kind: 'payment',
        record_id: 'payment-1',
        debit: 0,
        credit: 100,
        balance: 200,
        note: 'دفعة أولى',
      },
      {
        date: '2026-11-03T12:00:00.000Z',
        kind: 'payment',
        record_id: 'payment-2',
        debit: 0,
        credit: 50,
        balance: 150,
      },
    ],
    invoices: [
      {
        id: RAW_ID,
        number: 'INV-1',
        date: '2026-11-01T10:00:00.000Z',
        total: 300,
        paid_at_sale: 0,
        paid_later: 150,
        remaining: 150,
      },
    ],
    payments: [
      { id: 'payment-1', date: '2026-11-02T11:00:00.000Z', amount: 100, note: 'دفعة أولى' },
      { id: 'payment-2', date: '2026-11-03T12:00:00.000Z', amount: 50 },
    ],
  };
  const { $ } = loadDebts(statement);
  const root = $('#debts_statement_body');
  assert.deepEqual(headers($, '#debts_statement_body .debts-ledger-table'), ['التاريخ', 'النوع', 'القيمة']);
  $('#debts_statement_body .debts-statement-table').each(function () {
    assert.equal($(this).find('thead th').length, 3, 'every statement table keeps three columns');
  });

  const ledgerRows = $('#debts_statement_ledger_rows tr');
  assert.equal(ledgerRows.length, 3);
  const first = ledgerRows.eq(0);
  assert.match(first.text(), /INV-1/);
  assert.equal(first.find('a.debts-doc-link').attr('href'), '#/sales/' + RAW_ID);
  assert.match(first.text(), /\$ 300\.00/);

  const firstPayment = ledgerRows.eq(1).find('.debts-flow');
  assert.ok(firstPayment.length, 'a payment row shows the account flow');
  assert.match(firstPayment.text(), /الرصيد/);
  assert.match(firstPayment.text(), /\$ 300\.00/);
  assert.match(firstPayment.text(), /\$ 100\.00/);
  assert.match(firstPayment.text(), /بعد الدفع/);
  assert.match(firstPayment.text(), /\$ 200\.00/);
  assert.match(ledgerRows.eq(2).find('.debts-flow').text(), /\$ 200\.00/);
  assert.match(ledgerRows.eq(2).find('.debts-flow').text(), /\$ 50\.00/);
  assert.match(ledgerRows.eq(2).find('.debts-flow').text(), /\$ 150\.00/);

  assert.ok(root.find('.debts-summary-value').text().includes('$ 150.00'));
  assert.match(root.find('.debts-summary-item').last().text(), /الدفعات/);
  assert.match(root.find('.debts-summary-item').last().text(), /\$ 150\.00/);
  assert.ok(!root.text().includes(RAW_ID), 'the database id is never printed as a reference');

  const invoices = $('#debts_statement_invoices');
  const payments = $('#debts_statement_payments');
  assert.equal(invoices.hasClass('show'), false, 'invoices start collapsed');
  assert.equal(payments.hasClass('show'), false, 'payments start collapsed');
  assert.equal($('button[data-target="#debts_statement_invoices"]').attr('aria-expanded'), 'false');
  assert.equal($('button[data-target="#debts_statement_payments"]').attr('aria-expanded'), 'false');

  assert.equal($('#debts_statement_invoices_rows tr').length, 1);
  assert.match($('#debts_statement_invoices_rows').text(), /INV-1/);
  assert.match($('#debts_statement_invoices_rows').text(), /المتبقي/);
});

test('statement shows FIFO and direct settlement balances across several invoices', () => {
  const makeStatement = (payment, oldPaid, oldRemaining, newPaid, newRemaining) => ({
    party: { name: 'أحمد علي' },
    summary: { invoiced: 700, paid_at_sale: 0, collected: payment, outstanding: 700 - payment },
    ledger: [
      { date: '2026-11-01T10:00:00.000Z', kind: 'sale', number: 'INV-OLD', record_id: RAW_ID, debit: 300, credit: 0, balance: 300 },
      { date: '2026-11-05T10:00:00.000Z', kind: 'sale', number: 'INV-NEW', record_id: '64b000000000000000000002', debit: 400, credit: 0, balance: 700 },
      { date: '2026-11-06T10:00:00.000Z', kind: 'payment', record_id: 'payment-1', debit: 0, credit: payment, balance: 700 - payment },
    ],
    invoices: [
      { id: RAW_ID, number: 'INV-OLD', date: '2026-11-01T10:00:00.000Z', total: 300, paid_at_sale: 0, paid_later: oldPaid, remaining: oldRemaining },
      { id: '64b000000000000000000002', number: 'INV-NEW', date: '2026-11-05T10:00:00.000Z', total: 400, paid_at_sale: 0, paid_later: newPaid, remaining: newRemaining },
    ],
    payments: [{ id: 'payment-1', date: '2026-11-06T10:00:00.000Z', amount: payment }],
  });

  // Oldest-first collection: the old bill carries the money, the new one is untouched.
  let { $ } = loadDebts(makeStatement(200, 200, 100, 0, 400));
  let invoices = $('#debts_statement_invoices_rows tr');
  assert.equal(invoices.length, 2);
  assert.match(invoices.eq(0).text(), /INV-NEW[\s\S]*\$ 400\.00/);
  assert.match(invoices.eq(1).text(), /INV-OLD[\s\S]*\$ 300\.00[\s\S]*\$ 100\.00/);
  let flow = $('#debts_statement_ledger_rows tr').eq(2).find('.debts-flow').text();
  assert.match(flow, /\$ 700\.00/);
  assert.match(flow, /\$ 200\.00/);
  assert.match(flow, /\$ 500\.00/);

  // Direct settlement: the chosen newer bill is paid, the old bill is untouched.
  ({ $ } = loadDebts(makeStatement(400, 0, 300, 400, 0)));
  invoices = $('#debts_statement_invoices_rows tr');
  assert.match(invoices.eq(0).text(), /INV-NEW[\s\S]*مدفوعة/);
  assert.match(invoices.eq(1).text(), /INV-OLD[\s\S]*\$ 300\.00/);
  flow = $('#debts_statement_ledger_rows tr').eq(2).find('.debts-flow').text();
  assert.match(flow, /\$ 700\.00/);
  assert.match(flow, /\$ 400\.00/);
  assert.match(flow, /\$ 300\.00/);
});

test('supplier statement links to the purchase, folds long lists and pages them', () => {
  const invoices = [];
  const ledger = [];
  for (let i = 1; i <= 25; i += 1) {
    const date = '2026-10-' + String(i).padStart(2, '0') + 'T09:00:00.000Z';
    invoices.push({
      id: '64b0000000000000000000' + String(i).padStart(2, '0'),
      number: 'PUR-' + i,
      date,
      total: 100 + i,
      paid_at_sale: 0,
      paid_later: 0,
      remaining: 100 + i,
    });
    ledger.push({
      date,
      kind: 'purchase',
      number: 'PUR-' + i,
      record_id: '64b0000000000000000000' + String(i).padStart(2, '0'),
      debit: 100 + i,
      credit: 0,
      balance: 100 + i,
    });
  }
  const payments = [];
  for (let i = 1; i <= 12; i += 1) {
    payments.push({
      id: 'payment-' + i,
      date: '2026-11-' + String(i).padStart(2, '0') + 'T10:00:00.000Z',
      amount: i * 5,
      note: 'سداد ' + i,
    });
  }
  const statement = {
    party: { name: 'مورد عام', phone: '0222222222' },
    summary: { invoiced: 3225, paid_at_sale: 0, collected: 390, outstanding: 3225 },
    ledger,
    invoices,
    payments,
  };
  const { $, window } = loadDebts(statement, 'supplier');
  $('#debts_statement_body .debts-statement-table').each(function () {
    assert.equal($(this).find('thead th').length, 3);
  });

  assert.equal($('#debts_statement_invoices_rows tr').length, 10, 'only one page is in the DOM');
  assert.match($('#debts_statement_invoices_rows tr').first().text(), /PUR-25/);
  assert.match($('#debts_statement_invoices').text(), /PUR-25/);
  assert.equal(
    $('#debts_statement_invoices_rows a.debts-doc-link').first().attr('href'),
    '#/purchaseorders/64b000000000000000000025'
  );

  const nextInvoicePage = $('#debts_statement_invoices_pager .debts-statement-page[data-page="2"]');
  assert.ok(nextInvoicePage.length, 'long invoice lists get a next page');
  nextInvoicePage.trigger('click');
  assert.equal($('#debts_statement_invoices_rows tr').length, 10);
  assert.match($('#debts_statement_invoices_rows tr').first().text(), /PUR-15/);
  assert.equal($('#debts_statement_invoices').hasClass('show'), false, 'paging does not open the tab');

  assert.equal($('#debts_statement_payments_rows tr').length, 10);
  assert.match($('#debts_statement_payments_pager').text(), /صفحة 1 \/ 2/);
  assert.ok($('#debts_statement_payments_rows .debts-remove-payment').length, 'the reversal action stays available without a column');

  assert.ok($('#debts_statement_ledger_pager .debts-statement-page').length, 'the ledger pages too');
  assert.equal($('#debts_statement_ledger_rows tr').length, 20);

  const rawId = ledger[0].record_id;
  assert.ok(!$('#debts_statement_body').text().includes(rawId));
  assert.ok(!$('#debts_statement_body').text().includes('purchaseorders/' + rawId), 'links carry ids, text does not');
  assert.equal(typeof window.PosnicPro.debts.openStatement, 'function');
});
