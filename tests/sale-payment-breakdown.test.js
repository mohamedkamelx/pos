'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { rows, amount } = require('../api/src/helpers/sale-payment-summary');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('saved split shapes retain each allocation without double counting Captain totals', () => {
  const expected = [{ method: 'Digital payment', amount: 300 }, { method: 'Cash', amount: 200 }];
  for (const multi_payment of [{ Upi: 300, Cash: 200 }, '{"Upi":300,"Cash":200}', [{ method: 'upi', amount: 300 }, { method: 'cash', amount: 200 }]]) {
    assert.deepEqual(rows({ multi_payment, payment_mode: 'Upi', items_total: 500 }), expected);
  }
  assert.deepEqual(rows({ captain_payments: [{ method: 'Mixed', amount: 500, tenders: [{ method: 'upi', amount: 300 }, { method: 'cash', amount: 200 }] }] }), expected);
  assert.deepEqual(rows({ multi_payment: { Cash: 100, cash: 100, UPI: 0, Card: -10, Bad: 'bad' } }), [{ method: 'Cash', amount: 200 }]);
});

test('unpaid and historical mixed bills never invent collected money', () => {
  assert.deepEqual(rows({ captain_payments: { enabled: true, printReceipt: true } }), []);
  assert.deepEqual(rows({ multi_payment: { Cash: true, Card: false } }), []);
  assert.deepEqual(rows({ payment_mode: 'Cash', payment_status: 'Unpaid', items_total: 500 }), []);
  assert.deepEqual(rows({ payment_mode: 'Cash,UPI', payment_status: 'Paid', items_total: 500 }), []);
  assert.deepEqual(rows({ payment_mode: 'Cash', payment_status: 'Unpaid', partial_check: true, partial_balance: 200, items_total: 500 }), [{ method: 'Cash', amount: 200 }]);
  assert.deepEqual(rows({ payment_mode: 'Card', payment_status: 'Paid', sales_total: 500 }), [{ method: 'Card', amount: 500 }]);
});

test('amount prefers the recorded amount, then legacy tenders, then the bill state', () => {
  // New sales record one amount; it wins over any historical tender rows.
  assert.equal(amount({ paid_amount: 125, multi_payment: { Cash: 50 }, partial_balance: 10 }), 125);
  // Legacy split bills recover the total from the tender rows.
  assert.equal(amount({ multi_payment: { Upi: 300, Cash: 200 }, items_total: 500 }), 500);
  // Legacy part payment with no tender rows.
  assert.equal(amount({ partial_check: true, partial_balance: 200, items_total: 500 }), 200);
  // Fully paid legacy bill with no tender rows.
  assert.equal(amount({ payment_status: 'Paid', items_total: 500 }), 500);
  // An unpaid bill never becomes revenue.
  assert.equal(amount({ payment_status: 'Unpaid', items_total: 500 }), 0);
});

test('background bill payload retains recorded payment allocations', () => {
  const { buildBillPayload } = require('../api/src/helpers/bill-payload');
  const sale = { sales_id: 'S-1', payment_status: 'Paid', payment_mode: 'Mixed', paid_amount: 500,
    multi_payment: { UPI: 300, Cash: 200 }, sales_total: 500, items: [] };
  assert.deepEqual(rows(buildBillPayload(sale, {}).receiptDocument), rows(sale));
});

test('sale sheet shows the amount received and never a tender name', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window;
  w.$ = w.jQuery = require('jquery')(w);
  w.PosnicPro = { sales: {}, local: { get: k => k === 'currencySign' ? '$' : '' }, i18n: { t: (_k, fallback) => fallback } };
  w.PosnicPro.escapeHtml = value => w.$('<span>').text(value).html();
  const source = read('frontend/static/script/js/modules/js/sales.js');
  const start = source.indexOf('    buildSaleSheet: function');
  const end = source.indexOf('\n    },', start);
  w.eval('PosnicPro.sales.buildSaleSheet = ' + source.slice(source.indexOf('function', start), end + 6) + ';');
  const data = { sales_id: 'S-1', payment_status: 'Paid', payment_mode: 'Mixed', multi_payment: '{"Upi":300,"Cash":200}',
    partial_amounts: 500, items: [], items_total: 500, sales_total: 500 };
  const sheet = w.$('<div>').html(w.PosnicPro.sales.buildSaleSheet(data));
  const text = sheet.text();
  assert.match(text, /Paid\s*\$\s*500\.00/);
  assert.match(text, /Remaining\s*\$\s*0\.00/);
  assert.doesNotMatch(text, /UPI|Cash|Card|tender/i);
  data.multi_payment = { '<img src=x onerror=alert(1)>': 500 };
  assert.equal(w.$('<div>').html(w.PosnicPro.sales.buildSaleSheet(data)).find('img').length, 0);
  dom.window.close();
});

test('sale sheet lists every recorded collection and links the account under the total', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window;
  w.$ = w.jQuery = require('jquery')(w);
  w.PosnicPro = {
    sales: {},
    local: { get: k => k === 'currencySign' ? '$' : '' },
    i18n: { t: (_k, fallback) => fallback },
    timeZone: () => 'Africa/Cairo',
    debts: { formatDateTime: value => value ? '2026-11-23 14:05' : '' }
  };
  w.PosnicPro.escapeHtml = value => w.$('<span>').text(value).html();
  const source = read('frontend/static/script/js/modules/js/sales.js');
  const start = source.indexOf('    buildSaleSheet: function');
  const end = source.indexOf('\n    },', start);
  w.eval('PosnicPro.sales.buildSaleSheet = ' + source.slice(source.indexOf('function', start), end + 6) + ';');
  const data = {
    sales_id: 'S-2', payment_status: 'Partially Paid', payment_mode: 'Cash',
    items: [], items_total: 500, sales_total: 500,
    date: '2026-11-20T10:00:00.000Z',
    debt_account: {
      party_type: 'customer', party_id: 'customer-1', outstanding: 150,
      invoice_total: 500, invoice_remaining: 150, paid_at_sale: 200, paid_later: 150,
      payments: [{ date: '2026-11-23T12:05:00.000Z', amount: 150, note: 'Second collection' }]
    }
  };
  const sheet = w.$('<div>').html(w.PosnicPro.sales.buildSaleSheet(data));
  const text = sheet.text();
  assert.match(text, /Paid\s*\$\s*350\.00/);
  assert.match(text, /Remaining\s*\$\s*150\.00/);
  assert.match(text, /Second collection/);
  assert.equal(sheet.find('.q-payment-line').length, 2);
  assert.equal(sheet.find('.q-account-link').length, 1);
  dom.window.close();
});

test('desktop legacy card names and Captain card tenders use one Card total', () => {
  for (const method of ['CreditCard', 'Credit Card', 'DebitCard', 'Card']) {
    assert.deepEqual(rows({ payment_mode: method, payment_status: 'Paid', sales_total: 500 }), [{ method: 'Card', amount: 500 }]);
  }
  assert.deepEqual(rows({ multi_payment: { CreditCard: 100, Card: 50, Cash: 25 } }), [{ method: 'Card', amount: 150 }, { method: 'Cash', amount: 25 }]);
});

test('receipt reference is explicit opt-in and never changes payment reporting', () => {
  const { receiptRows } = require('../api/src/helpers/sale-payment-summary');
  const sale = {multi_payment:{'ROOM PENDING':473, Card:20}, captain_payments:[
    {method:'ROOM PENDING',amount:473,reference:'234',printReference:true},
    {method:'Card',amount:20,reference:'private-bank-ref'},
  ]};
  assert.deepEqual(receiptRows(sale), [{method:'ROOM PENDING · 234',amount:473},{method:'Card',amount:20}]);
  assert.deepEqual(rows(sale), [{method:'ROOM PENDING',amount:473},{method:'Card',amount:20}]);
  sale.captain_payments[0].printReference = 'true';
  assert.equal(receiptRows(sale)[0].method, 'ROOM PENDING');
  sale.captain_payments = [{tenders:[{method:'ROOM PENDING', reference:'234', printReference:true},{method:'Card',reference:'A\nB',printReference:true}]}];
  assert.equal(receiptRows(sale)[1].method, 'Card · A B');
});
