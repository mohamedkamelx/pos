'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../frontend/static/script/js/modules/js/sales.js'), 'utf8');
const start = source.indexOf('PosnicPro.sales.editSale = {');
const end = source.indexOf('/*********** END - EDIT ,RETURN AND EXCHANGE ***********/', start);

function boot() {
  const dom = new JSDOM(
    '<div class="loader-sales-balance"></div>' +
    '<table id="sales_new_items_table"><tbody></tbody></table>' +
    '<input id="Partial_amount" value="50">' +
    '<input id="grand_total" value="100">' +
    '<input id="sales_new_customer_name" value="Walk-in customer">' +
    '<span id="extraDisc">0</span><span id="percentIcon" class="d-none"></span>' +
    '<a class="printSalesReceipt"></a><div id="qr_view"></div>',
    { url: 'http://localhost/' }
  );
  const $ = require('jquery')(dom.window);
  $.fn.editable = function () { return this; };
  $.fn.modal = function () { return this; };
  const requests = [];
  const printed = [];
  const PosnicPro = {
    local: { get: () => '' },
    alert: () => {},
    i18n: { t: (_key, fallback) => fallback },
    request: (params, success, failure) => {
      params.success = success;
      params.failure = failure;
      requests.push(params);
    },
    sales: {
      paymentOnlyMode: true,
      refundSaleAction: false,
      salesExchange: false,
      editSaleId: 'SB1',
      refundSaleId: 'RF1',
      salesId: '',
      EditRecentSaleParams: {},
      SaleTableLineItems: {},
      charges: [],
      recentSaleAction: false,
      itemCache: { clear: () => {} },
      recentMenu: { recentSalesTabDetails: () => {} },
      parkedMenu: { printEnabled: value => value === true || value === 'true' },
      printAfterSave: saleId => printed.push(saleId),
      ensureCustomer: () => {},
      saleRegisterId: () => 'REG1',
      lineCompanyCostTotal: () => 0
    }
  };
  const db = { customerDisplay: { where: () => ({ equals: () => ({ delete: () => {} }) }) } };
  vm.runInNewContext(source.slice(start, end), {
    PosnicPro, $, jQuery: $, db, window: {}, isFinite, parseFloat, String, JSON
  });
  return { dom, $, PosnicPro, requests, printed };
}

test('an edit or payment-only submit sends the sale instead of spinning forever', () => {
  const { dom, PosnicPro, requests } = boot();
  assert.ok(start > 0 && end > start, 'editSale is missing from sales.js');

  const result = PosnicPro.sales.editSale.cartOrderSubmit();

  assert.equal(result, false);
  assert.equal(requests.length, 1, 'the save request must be sent exactly once');
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].url, 'sales/SB1');
  const body = JSON.parse(requests[0].data);
  assert.equal(body.partial_balance, '50.00');
  assert.equal(body.partial_check, 'true');
  dom.window.close();
});

test('a completed parked bill follows Auto Print and never prints from a plain edit', () => {
  const { dom, PosnicPro, requests, printed } = boot();
  PosnicPro.sales.EditRecentSaleParams = { sale_process: 'Hold' };

  PosnicPro.sales.editSale.cartOrderSubmit();
  requests[0].success({ type: 'success', data: { sales_id: 'SB1', print: true }, message: 'Sale updated' });
  assert.deepEqual(printed, ['SB1']);

  PosnicPro.sales.editSale.cartOrderSubmit();
  requests[1].success({ type: 'success', data: { sales_id: 'SB2', print: false }, message: 'Sale updated' });
  assert.deepEqual(printed, ['SB1'], 'Auto Print off must not print');

  PosnicPro.sales.EditRecentSaleParams = { sale_process: 'Edit' };
  PosnicPro.sales.editSale.cartOrderSubmit();
  requests[2].success({ type: 'success', data: { sales_id: 'SB3', print: true }, message: 'Sale updated' });
  assert.deepEqual(printed, ['SB1'], 'an ordinary edit must not reprint a bill');
  dom.window.close();
});
