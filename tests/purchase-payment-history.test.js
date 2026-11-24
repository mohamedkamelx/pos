'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('purchase view lists paid at purchase, every later supplier payment and the remaining balance', () => {
  const dom = new JSDOM('<!doctype html><table><tbody id="receiving_view_debt"></tbody></table>', {
    runScripts: 'outside-only',
  });
  const w = dom.window;
  w.$ = w.jQuery = require('jquery')(w);
  let opened = null;
  w.PosnicPro = {
    receivings: { view: {} },
    local: { get: (key) => (key === 'currencySign' ? '$' : '') },
    i18n: { t: (_key, fallback) => fallback },
    debts: {
      formatDateTime: (value) => (value ? '2026-11-23 14:05' : ''),
      openStatement: (type, id) => {
        opened = [type, id];
      },
    },
  };

  const source = read('frontend/static/script/js/modules/js/receiving_view.js');
  const start = source.indexOf('    _renderPurchaseDebt: function');
  const end = source.indexOf('\n    },', start);
  w.eval(
    'PosnicPro.receivings.view._renderPurchaseDebt = ' +
      source.slice(source.indexOf('function', start), end + 6) +
      ';'
  );

  w.PosnicPro.receivings.view._renderPurchaseDebt({
    date: '2026-11-20 10:00 AM',
    payment_mode: 'Cash',
    debt_account: {
      party_id: 'supplier-1',
      outstanding: 150,
      invoice_total: 500,
      invoice_remaining: 150,
      paid_at_sale: 200,
      paid_later: 150,
      payments: [
        {
          date: '2026-11-23T12:05:00.000Z',
          amount: 150,
          note: 'Transfer <img src=x onerror=alert(1)>',
        },
      ],
    },
  });

  const body = w.$('#receiving_view_debt');
  assert.match(body.find('.receiving-paid-row').text(), /Paid\s*\$ 350\.00/);
  assert.match(body.find('.receiving-remaining-row').text(), /Remaining\s*\$ 150\.00/);
  assert.equal(body.find('.q-payment-line').length, 2);
  assert.equal(body.find('img').length, 0);
  assert.match(body.text(), /Transfer <img src=x onerror=alert\(1\)>/);

  body.find('.q-account-link').trigger('click');
  assert.deepEqual(opened, ['supplier', 'supplier-1']);
  assert.match(body.find('.q-account-link').text(), /\$ 150\.00/);
  dom.window.close();
});

test('printed purchase sheet keeps the supplier payment history under its total', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window;
  w.$ = w.jQuery = require('jquery')(w);
  w.PosnicPro = {
    purchaseorders: { statusLabel: (value) => String(value || '') },
    local: {
      get: (key) => {
        if (key === 'currencySign') return '$';
        if (key === 'branchname') return 'Shop';
        return '';
      },
    },
    i18n: { t: (_key, fallback) => fallback },
    debts: { formatDateTime: (value) => (value ? '2026-11-23 14:05' : '') },
  };

  const source = read('frontend/static/script/js/modules/js/receiving_add.js');
  const start = source.indexOf('    buildPurchaseSheet: function');
  const end = source.indexOf('\n    },', start);
  w.eval(
    'PosnicPro.purchaseorders.buildPurchaseSheet = ' +
      source.slice(source.indexOf('function', start), end + 6) +
      ';'
  );

  const html = w.PosnicPro.purchaseorders.buildPurchaseSheet({
    receiving_id: 'P-1',
    receiving_status: 'Received',
    date: '2026-11-20 10:00 AM',
    supplier_name: 'Supplier',
    payment_mode: 'Cash',
    items: [
      { item_name: 'Stock', item_quantity: 5, item_unit: 'pc', item_price: 100, total_amount: 500 },
    ],
    subtotal_amount: 500,
    total_amount: 500,
    debt_account: {
      party_id: 'supplier-1',
      outstanding: 150,
      invoice_total: 500,
      invoice_remaining: 150,
      paid_at_sale: 200,
      paid_later: 150,
      payments: [
        {
          date: '2026-11-23T12:05:00.000Z',
          amount: 150,
          note: 'Later transfer <img src=x onerror=alert(1)>',
        },
      ],
    },
  });

  const sheet = w.$('<div>').html(html);
  assert.match(sheet.find('.q-paid').text(), /Paid\s*\$\s*350\.00/);
  assert.match(sheet.find('.q-due').text(), /Remaining\s*\$\s*150\.00/);
  assert.equal(sheet.find('.q-payment-line').length, 2);
  assert.equal(sheet.find('img').length, 0);
  assert.match(sheet.text(), /Later transfer <img src=x onerror=alert\(1\)>/);
  assert.match(sheet.find('.q-account-link').attr('onclick'), /openStatement\('supplier','supplier-1'\)/);
  dom.window.close();
});

test('purchase view leaves the payment section empty without an attached supplier account', () => {
  const dom = new JSDOM('<!doctype html><table><tbody id="receiving_view_debt"></tbody></table>', {
    runScripts: 'outside-only',
  });
  const w = dom.window;
  w.$ = w.jQuery = require('jquery')(w);
  w.PosnicPro = {
    receivings: { view: {} },
    local: { get: () => '$' },
    i18n: { t: (_key, fallback) => fallback },
  };

  const source = read('frontend/static/script/js/modules/js/receiving_view.js');
  const start = source.indexOf('    _renderPurchaseDebt: function');
  const end = source.indexOf('\n    },', start);
  w.eval(
    'PosnicPro.receivings.view._renderPurchaseDebt = ' +
      source.slice(source.indexOf('function', start), end + 6) +
      ';'
  );

  w.PosnicPro.receivings.view._renderPurchaseDebt({ date: '2026-11-20' });
  assert.equal(w.$('#receiving_view_debt').children().length, 0);
  dom.window.close();
});
