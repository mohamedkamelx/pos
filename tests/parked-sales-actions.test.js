const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../frontend/static/script/js/modules/js/sales.js'), 'utf8');
const start = source.indexOf('PosnicPro.sales.parkedMenu = {');
const end = source.indexOf('\n};', start) + 3;

function boot(allowDelete, confirm = () => false) {
  const dom = new JSDOM('<div class="loader-product"></div><div id="sales_new_productList"></div><div id="sales_new_categoryList"></div>');
  const $ = require('jquery')(dom.window);
  const PosnicPro = {
    local: { get: k => ({ usertype: 'super_admin', allow_sale_hard_delete: String(allowDelete), currencySign: '₹' })[k] },
    sales: { parkedAgo: () => ({ text: '1 minute', exact: 'Now', stale: false }) },
    get: (_, done) => done({ data: JSON.stringify([{ sales_document_id: 'abc123', customer_name: '<script>bad</script>', total_amount: 70, number_of_items: 1 }]) }),
    alert: () => {},
  };
  vm.runInNewContext(source.slice(start, end), { PosnicPro, $, jQuery: $, Date, Number, String, window: { confirm } });
  return { $, menu: PosnicPro.sales.parkedMenu, PosnicPro };
}

test('parked rows expose resume and clear-all without hard deletion or interpreting customer HTML', () => {
  for (const enabled of [false, true]) {
    const { $, menu } = boot(enabled);
    menu.list();
    assert.equal($('a[href="#/sales/abc123/hold"]').length, 1);
    assert.equal($('a[href="#/sales/abc123/delete"]').length, 0);
    assert.equal($('#clear_all_parked_sales').prop('disabled'), false);
    assert.equal($('#parked_sales_table script').length, 0);
    assert.match($('#parked_sales_table').text(), /<script>bad<\/script>/);
  }
});

test('cancel sends nothing; confirmed clear submits once, refreshes, and failures allow retry', () => {
  let confirmed = false, sent = 0, success, failure;
  const { $, menu, PosnicPro } = boot(false, () => confirmed);
  PosnicPro.post = (request, done, fail) => {
    sent++; success = done; failure = fail;
    assert.equal(request.url, 'sales/parked/clear');
    assert.deepEqual(JSON.parse(request.data), { confirmed: true });
  };
  menu.list();
  menu.clearAll(); assert.equal(sent, 0);
  confirmed = true;
  menu.clearAll(); menu.clearAll(); assert.equal(sent, 1);
  assert.equal($('#clear_all_parked_sales').prop('disabled'), true);
  failure(); assert.equal(menu.clearing, false);
  menu.clearAll(); assert.equal(sent, 2);
  PosnicPro.get = (_, done) => done({ data: 0 });
  success({ type: 'success', data: { cleared: 25 } });
  assert.equal(menu.clearing, false);
  assert.match($('#parked_sales_table').text(), /Nothing parked/);
  assert.equal($('#clear_all_parked_sales').prop('disabled'), true);
});

test('ordinary parked drafts resume paid regardless of network latency; other bills retain state', () => {
  const { menu } = boot(false);
  assert.equal(menu.paidOnResume({ sale_process: 'Hold' }, false), true);
  assert.equal(menu.paidOnResume({ sale_process: 'Edit' }, false), false);
  assert.equal(menu.paidOnResume({ sale_process: 'BILL' }, false), false);
});

test('auto-print accepts persisted checkbox strings and never treats false as truthy', () => {
  const { menu } = boot(false);
  for (const value of [true, 'true']) assert.equal(menu.printEnabled(value), true);
  for (const value of [false, 'false', undefined, null, '']) assert.equal(menu.printEnabled(value), false);
});

function loadPrintAfterSave(PosnicPro, window) {
  const begin = source.indexOf('PosnicPro.sales.printAfterSave = function');
  const finish = source.indexOf('PosnicPro.sales.parkedMenu = {', begin);
  assert.ok(begin > 0 && finish > begin, 'printAfterSave is missing');
  vm.runInNewContext(source.slice(begin, finish), { PosnicPro, window, Promise, Array, console });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a completed sale prints only when the saved print option is enabled', () => {
  const callSite = source.slice(
    source.indexOf('if (PosnicPro.sales.parkedMenu.printEnabled(response.data.print))'),
    source.indexOf("var path = '#/sales/' + response.data.sales_id;"),
  );
  assert.match(callSite, /printEnabled\(response\.data\.print\)/);
  assert.match(callSite, /printAfterSave\(response\.data\.sales_id\)/);
});

test('printAfterSave prints when a printer exists and warns once when none is connected', async () => {
  const { PosnicPro } = boot(false);
  const printed = [];
  const alerts = [];
  PosnicPro.sales.view = { printSale: (...args) => printed.push(args) };
  PosnicPro.i18n = { t: (_key, english) => english };
  PosnicPro.alert = (type, message) => alerts.push(type + ': ' + message);

  // A browser till has no printer list to inspect; it prints through the dialog.
  loadPrintAfterSave(PosnicPro, {});
  PosnicPro.sales.printAfterSave('browser-sale');
  await settle();
  assert.deepEqual(printed, [['browser-sale', 'sale']]);
  assert.equal(alerts.length, 0);

  // No connected printer: no print call, exactly one warning, sale untouched.
  loadPrintAfterSave(PosnicPro, {
    electronAPI: { printer: { list: () => Promise.resolve([]) } },
  });
  PosnicPro.sales.printAfterSave('no-printer');
  await settle();
  assert.deepEqual(printed, [['browser-sale', 'sale']]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^warning: Sale saved\. No printer is connected/);

  // A printer is connected: print normally.
  loadPrintAfterSave(PosnicPro, {
    electronAPI: { printer: { list: () => Promise.resolve([{ name: 'Till' }]) } },
  });
  PosnicPro.sales.printAfterSave('printed-sale');
  await settle();
  assert.deepEqual(printed, [['browser-sale', 'sale'], ['printed-sale', 'sale']]);
  assert.equal(alerts.length, 1);

  // A failing printer check is the same clear skip, not a retry loop.
  loadPrintAfterSave(PosnicPro, {
    electronAPI: { printer: { list: () => Promise.reject(new Error('offline')) } },
  });
  PosnicPro.sales.printAfterSave('failed-check');
  await settle();
  assert.equal(printed.length, 2);
  assert.equal(alerts.length, 2);
});
