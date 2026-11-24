'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../frontend/static/script/js/modules/js/sales.js'), 'utf8');

function setup() {
  const dom = new JSDOM(
    '<div id="payment_id"></div>' +
    '<input id="Partial_amount" class="partial_amount" value="">' +
    '<input id="sales_new_customer_partial_balance">' +
    '<input id="sales_new_customer_name" value="Walk-in customer">' +
    '<button id="save_btn"></button>' +
    '<span class="balanceDue"></span>' +
    '<span class="tendered_total"></span><span class="tendered_payment"></span>' +
    '<span id="tendered_subtotal"></span><span id="tendered_discount"></span>' +
    '<div id="tenderpage"></div><div id="infobar-settings-sidebar-tender-details"></div>' +
    '<div id="newsalespage"></div>',
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window;
  const $ = require('jquery')(win);
  win.$ = win.jQuery = $;
  win.PosnicPro = {
    local: { get: () => '$' },
    alert: (_type, message) => { win.lastError = message; },
    i18n: { t: (_key, fallback) => fallback },
    saleExtensions: null,
    sales: {
      extraDiscount: { sale_new_tot: 262.5 },
      EditRecentSaleParams: { sales_total: 262.5, partial_amounts: 0 },
      paymentOnlyMode: true,
      submissionInProgress: false,
      SaleAction: 'add',
      saleDoneTimer: { stop: () => {} },
      ensureCustomer: () => {},
      refreshCustomerAccount: () => {},
      renderTenderReceiptPreview: () => {}
    }
  };
  for (const name of ['sub', 'openTenderModel']) {
    const start = source.indexOf('    ' + name + ': function');
    const end = source.indexOf('\n    },', start);
    assert.ok(start >= 0 && end > start, name + ' is missing from sales.js');
    win.eval('PosnicPro.sales.' + name + ' = ' + source.slice(source.indexOf('function', start), end + 6) + ';');
  }
  return { dom, win, $, sales: win.PosnicPro.sales };
}

test('tender opens on what the customer owes, with no payment method', () => {
  const { dom, $, sales } = setup();
  sales.openTenderModel();
  assert.equal($('#Partial_amount').val(), '262.50');
  assert.equal($('.balanceDue').text(), '0.00');
  assert.equal($('#sales_new_customer_partial_balance').val(), 'false');
  assert.equal($('#save_btn').prop('disabled'), false);
  assert.equal($('#payment_id').children().length, 0);
  dom.window.close();
});

test('an amount below the bill leaves the rest as customer debt', () => {
  const { dom, $, sales } = setup();
  sales.openTenderModel();
  $('#Partial_amount').val('100').trigger('input.tenderDue');
  assert.equal($('.balanceDue').text(), '162.50');
  assert.equal($('#sales_new_customer_partial_balance').val(), 'true');
  dom.window.close();
});

test('a bill opened for settlement starts at the full payable amount', () => {
  const { dom, $, sales } = setup();
  sales.EditRecentSaleParams.partial_amounts = 100;
  sales.openTenderModel();
  assert.equal($('#Partial_amount').val(), '262.50');
  assert.equal($('.balanceDue').text(), '0.00');
  assert.equal($('#sales_new_customer_partial_balance').val(), 'false');
  dom.window.close();
});

test('payment-only stops before opening a repriced bill', () => {
  const { dom, $, sales, win } = setup();
  sales.extraDiscount.sale_new_tot = 250;
  sales.openTenderModel();
  assert.match(win.lastError, /differs from the saved bill/);
  assert.equal($('#save_btn').prop('disabled'), true);
  assert.equal($('#payment_id').children().length, 0);
  dom.window.close();
});

// Exercise the real saved-order loader and real row insertion, rather than
// constructing an already-calculated DOM. Row order affects half-paisa sums.
function savedOrderSetup() {
  const { dom, $, sales, win } = setup();
  $('body').append('<table id="sales_new_items_table"><tbody></tbody></table><input id="grand_total"><span id="extraDisc">0</span><span id="percentIcon" class="d-none"></span><span id="sales_new_grand_total"></span>');
  $.fn.number = function (value) { return this.text(Number(value).toFixed(2)); };
  $.fn.editable = function () { return this; };
  win.billingWindowId = null;
  win.db = { customerDisplay: { put: () => {}, add: () => {}, get: () => Promise.resolve(null) } };
  win.PosnicPro.escapeHtml = value => $('<i>').text(value == null ? '' : value).html();
  win.PosnicPro.i18n = { t: (_key, fallback) => fallback };
  win.PosnicPro.local.get = key => key === 'general_settings' ? '{}' : '';
  win.PosnicPro.commonEditDate = () => {};
  Object.assign(sales, {
    setDefaults: () => {}, view: { changeExtraDiscType: () => {} },
    recentMenu: { setEditSalesDetails: () => {} }, SaleTableLineItems: {},
    quantity: { formatQty: value => value },
    searchItem: () => false, _applyPriceList: value => value,
    _needsTodaysPrice: () => false, checkAutoWeightTrigger: () => {},
    customerBalanceCheck: () => {}, taxFeatureOn: () => true,
    chargesTotal: () => 0, chargesTax: () => 0,
    calculation: { billLevelDiscount: () => 0 }
  });
  function load(owner, name) {
    const start = source.indexOf('    ' + name + ': function');
    const end = source.indexOf('\n    },', start);
    win.eval(owner + '.' + name + ' = ' + source.slice(source.indexOf('function', start), end + 6) + ';');
  }
  win.eval(source.slice(source.indexOf('PosnicPro.sales.isWeighedItem ='), source.indexOf("$(document).on('click', '.sale-weight-amount'")));
  load('PosnicPro.sales', 'savedSellingPrice');
  load('PosnicPro.sales', 'savedCompanyUnitPrice');
  load('PosnicPro.sales', 'lineCompanyCostTotal');
  load('PosnicPro.sales', 'lineTotals');
  load('PosnicPro.sales', 'readLineTotals');
  load('PosnicPro.sales', 'addSalesLineItems');
  sales.parkedMenu = {};
  load('PosnicPro.sales.parkedMenu', 'paidOnResume');
  load('PosnicPro.sales.recentMenu', 'editItems');
  load('PosnicPro.sales.calculation', 'salesTableRowCart');
  load('PosnicPro.sales.calculation', 'extraDiscoundCalculation');
  return { dom, $, sales, win };
}

test('Azure saved Table 6 loads into payment at the printed total through real cart rows', () => {
  const { dom, $, sales } = savedOrderSetup();
  const units = [350,300,300,380,340,360,350,340,60,100,250,30,300,294,47.25,31.5,136.5,136.5,136.5];
  const quantities = [1,1,1,1,1,1,2,1,2,3,1,2,2,1,2,2,1,1,2];
  const bill = {
    sales_id: 'SB1D28-27-000130', sales_total: 5397.5, sales_sub_total: 5397.5,
    payment_status: 'Unpaid', sale_process: 'Add', table_number: '6',
    person_count: 10, extra_discount: 0, extra_discount_type: 'price',
    items: units.map((price, index) => ({ item_id: 'line' + index, item_name: 'Item ' + index,
      item_price: price, item_quantity: quantities[index], item_discount: 0,
      item_discount_percentage: 0, company_price_total: 0 }))
  };
  let opened = 0;
  sales.openTenderModel = () => {
    assert.equal(sales.extraDiscount.sale_new_tot, bill.sales_total,
      'real saved-order loading must retain the printed payable before opening tender');
    $('#Partial_amount').val(sales.extraDiscount.sale_new_tot);
    opened++;
  };
  sales.recentMenu.editItems('saved-table6', bill, 'edit');
  assert.equal(opened, 1);
  assert.equal($('#sales_new_items_table tbody tr').length, 19);
  assert.equal(Number($('#Partial_amount').val()), 5397.5);
  assert.deepEqual($('#sales_new_items_table tbody tr').get().map(row => row.id),
    units.map((_price, index) => 'touch_row_line' + index));
  dom.window.close();
});

test('app order keeps its saved payable when loaded for payment', () => {
  const { dom, $, sales } = savedOrderSetup();
  const bill = { sales_id: 'QA-APP', sales_total: 195, sales_sub_total: 195,
    payment_status: 'Unpaid', sale_process: 'Add', extra_discount: 0,
    items: [
      { item_id: 'paratha', item_name: 'Paratha', item_price: 45, item_quantity: 3,
        pricing: { version: 1, selling_price: 45 } },
      { item_id: 'water', item_name: 'Water', item_price: 30, item_quantity: 2,
        pricing: { version: 1, selling_price: 30 } }
    ].map(line => ({ item_discount: 0, item_discount_percentage: 0, company_price_total: 0, ...line })) };
  let opened = false;
  sales.openTenderModel = () => {
    assert.equal(sales.extraDiscount.sale_new_tot, 195);
    opened = true;
  };
  sales.recentMenu.editItems('qa-app', bill, 'edit');
  assert.equal(opened, true);
  assert.equal($('#saleInlineItemPrice_water').text(), '30');
  assert.equal($('#addSalesLineItemSellingPrice_water').text(), '30');
  dom.window.close();
});

test('saved order restores charges before checking its payable', (t) => {
  const {dom,$,sales}=savedOrderSetup(); t.after(()=>dom.window.close());
  const charges=[{name:'Service',amount:20,source:'manual'}];
  sales.chargesTotal=()=>sales.charges.reduce((n,c)=>n+c.amount,0);
  let opened=0;
  sales.openTenderModel=()=>{assert.equal(sales.extraDiscount.sale_new_tot,120);opened++;};
  sales.recentMenu.editItems('saved', {sales_id:'saved',sales_total:120,sales_sub_total:100,charges,
    payment_status:'Unpaid',sale_process:'Add',extra_discount:0,extra_discount_type:'price',
    items:[{item_id:'zero',item_name:'Zero',item_price:100,item_quantity:1,item_discount:0,item_discount_percentage:0,company_price_total:0}]},'edit');
  assert.equal(opened,1);
  sales.charges[0].amount=30; assert.equal(charges[0].amount,20,'editing must not mutate the saved snapshot');
});

test('charge action follows late-loaded settings on cart recalculation', (t) => {
  const {dom,$,sales}=savedOrderSetup();t.after(()=>dom.window.close());
  $('body').append('<a id="sale_add_charge" style="display:none">Add charge</a>');
  let enabled=false;sales.chargesEnabled=()=>enabled;sales.charges=[];
  sales.calculation.extraDiscoundCalculation();assert.equal($('#sale_add_charge').css('display'),'none');
  enabled=true;sales.calculation.extraDiscoundCalculation();assert.notEqual($('#sale_add_charge').css('display'),'none');
  enabled=false;sales.charges=[{name:'Saved charge',amount:10}];
  sales.calculation.extraDiscoundCalculation();assert.notEqual($('#sale_add_charge').css('display'),'none');
});

test('successful-sale reset clears charges before the next customer is billed', (t) => {
  const {dom,$,sales,win}=savedOrderSetup();t.after(()=>dom.window.close());
  $('body').append('<div id="sale_charges_list">Previous service 20.05</div><div id="sale_charge_entry">Unfinished charge</div>');
  win.db.customerDisplay.where=()=>({equals:()=>({delete:()=>{}})});
  const start=source.indexOf('PosnicPro.sales.setDefaults = function');
  const end=source.indexOf('\n};',start)+3;
  win.eval(source.slice(start,end));
  sales.charges=[{name:'Previous service',amount:20}];
  sales.customerViewDisplay=()=>{};
  sales.chargesTotal=()=>sales.charges.reduce((n,c)=>n+c.amount,0);
  sales.setDefaults();
  assert.equal(sales.charges.length,0);
  assert.equal($('#sale_charges_list').text(),'');
  assert.equal($('#sale_charge_entry').length,0);
  sales.paymentOnlyMode=false;
  $('#sales_new_items_table tbody').empty();
  sales.addSalesLineItems({id:'next',name:'Next customer item',selling_price:100,company_price:0,
    discount_amount:0,discount_percentage:0,quantity:1,item_quantity:1,unit:'pc'});
  sales.calculation.salesTableRowCart();
  assert.equal(sales.extraDiscount.sale_new_tot,100);
});
