'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup() {
  const nodes = new Map();
  function $(key) {
    if (!nodes.has(key)) {
      const node = {
        value: '',
        textValue: '',
        handlers: {},
        classes: new Set(),
        val(v) { if (v === undefined) return this.value; this.value = v; return this; },
        text(v) { this.textValue = v; return this; },
        html(v) { if (v === undefined) return this.textValue; this.textValue = v; return this; },
        one(event, fn) { this.handlers[event] = fn; return this; },
        on(event, fn) { this.handlers[event] = fn; return this; },
        off(event) { delete this.handlers[event]; return this; },
        trigger(event) { const fn = this.handlers[event]; if (fn) fn(); return this; },
        hasClass(name) { return this.classes.has(name); },
        addClass(name) { this.classes.add(name); return this; },
        removeClass(name) { if (name === undefined) this.classes.clear(); else this.classes.delete(name); return this; },
        modal(action) {
          if (action === 'show') {
            this.classes.add('show');
            const fn = this.handlers['shown.bs.modal.restock'];
            if (fn) { delete this.handlers['shown.bs.modal.restock']; fn(); }
          }
          if (action === 'hide') {
            this.classes.delete('show');
            for (const event of ['hidden.bs.modal', 'hidden.bs.modal.restock']) {
              const fn = this.handlers[event];
              if (fn) { delete this.handlers[event]; fn(); }
            }
          }
          return this;
        },
        closest() { return this; },
        find() { return this; },
        appendTo() { return this; },
        select2() { return this; },
        empty() { this.textValue = ''; return this; },
        toggle() { return this; },
        prop() { return this; },
        attr() { return this; },
        hide() { return this; },
        show() { return this; },
      };
      nodes.set(key, node);
    }
    return nodes.get(key);
  }
  const storage = new Map();
  let branch = 'branch-a', request, route, postRequest;
  const added = [];
  const PosnicPro = {
    local: { get: () => branch },
    i18n: { t: (key, fallback) => fallback },
    ACLForModule() {},
    alert() {},
    receiving_lineitems: [],
    get(url, yes, no) { request = { url, yes, no }; },
    post(params, yes, no) { postRequest = Object.assign({}, params, { yes, no }); },
    items: { _adjRows: {}, openStockAdjustment() { this._adjRows = {}; }, adjReasonChanged() {} },
    receivings: { clearReceivingForm() {}, addReceivingLineItems(r) { added.push(r); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/static/script/js/modules/js/lowstock.js'), 'utf8'), {
    PosnicPro,
    $,
    document: {},
    setTimeout,
    hasher: { setHash(v) { route = v; } },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    swal: () => ({ then(fn) { fn({ value: true }); } }),
  });
  const app = PosnicPro.lowstockitems;
  app.restockContext();
  return { app, $, PosnicPro, added, request: () => request, post: () => postRequest, route: () => route, branch(v) { branch = v; } };
}
test('restock starts at one, does not navigate, and reopening does not duplicate', () => {
  const t = setup(); t.app.loadLowStockValue('a');
  t.request().yes({ type: 'success', data: { name: 'Cable', available_quantity: 9 } });
  assert.equal(t.app._restock.a.qty, 1);
  t.app._restock.a.qty = 4; t.app.loadLowStockValue('a');
  assert.equal(t.app._restock.a.qty, 4); assert.equal(t.route(), undefined);
});
test('invalid quantities cannot finish and failed fetch leaves no phantom row', () => {
  const t = setup(); t.app.loadLowStockValue('a'); t.request().no();
  assert.equal(Object.keys(t.app._restock).length, 0);
  for (const qty of [0, -1, '', 'NaN', Infinity, 100001]) { t.app._restock.a = { qty }; assert.equal(t.app.validRestock(), false); }
  t.app._restock.a.qty = 2; assert.equal(t.app.validRestock(), true);
});
test('branch switch ignores an outstanding response and keeps baskets separate', () => {
  const t = setup(); t.app.loadLowStockValue('a'); t.branch('branch-b');
  t.request().yes({ type: 'success', data: { name: 'Cable' } });
  assert.equal(Object.keys(t.app._restock).length, 0);
});
test('direct stock addition is reviewed first and only confirmed rows leave basket', () => {
  const t = setup(); t.app._restock = { a: { name: 'Cable', qty: 3, available_quantity: 4 }, b: { name: 'Brush', qty: 2, available_quantity: 0 } };
  t.app.loadList = () => {};
  t.app.restockDirect();
  const req = t.post();
  assert.ok(req, 'the confirmation must post the adjustment');
  assert.equal(req.url, 'items/stockAdjustment');
  const body = JSON.parse(req.data);
  assert.equal(body.reason, 'Restock');
  assert.equal(body.mode, 'add');
  assert.deepEqual(body.rows, [{ item_id: 'a', qty: 3 }, { item_id: 'b', qty: 2 }]);
  assert.equal(Object.keys(t.app._restock).length, 2, 'nothing leaves before the server confirms');
  req.yes({ type: 'success', message: 'Adjusted', data: { updatedItemIds: ['a'] } });
  assert.deepEqual(Object.keys(t.app._restock), ['b']);
});
test('purchase transfers a supplier group and keeps basket rows until the purchase saves', () => {
  const t = setup(); t.app._restock = { a: { name: 'Cable', qty: 3, supplier_id: 'supplier-a', company_price: 2 }, b: { name: 'Brush', qty: 2, supplier_id: 'supplier-b' } };
  t.$('#restock_supplier').val('supplier-a'); t.app.restockPurchase();
  t.request().yes({ type: 'success', data: { address: 'Test supplier address' } });
  assert.equal(t.route(), 'receivings/new'); assert.equal(t.added.length, 0);
  t.app.applyPurchaseDraft();
  assert.equal(t.$('#receiving_add_supplier_address').val(), 'Test supplier address');
  assert.equal(t.added.length, 1); assert.equal(t.added[0].item_quantity, 3);
  assert.equal(t.added[0].item_id, 'a'); assert.equal(t.$('#receiving_add_supplier_id').val(), 'supplier-a');
  assert.deepEqual(Object.keys(t.app._restock), ['a', 'b'], 'the basket stays until the purchase is saved');
  t.app.loadList = () => {};
  t.app.completePurchaseRestock(['a']);
  assert.deepEqual(Object.keys(t.app._restock), ['b']);
});
test('touch quantity steps use whole units and preserve positive fractional quantities', () => {
  const { app } = setup();
  assert.equal(app.stepRestockQuantity(1, 1), 2);
  assert.equal(app.stepRestockQuantity(2, -1), 1);
  assert.equal(app.stepRestockQuantity(1, -1), 1);
  assert.equal(app.stepRestockQuantity(0.5, -1), 0.5);
  assert.equal(app.stepRestockQuantity(1.5, -1), 0.5);
  assert.equal(app.stepRestockQuantity(100000, 1), 100000);
  assert.equal(app.stepRestockQuantity('', 1), 1);
});
test('a chosen supplier receives unassigned items without taking another supplier group', () => {
  const t = setup();
  t.app._restock = { a: { name: 'Unassigned', qty: 4 }, b: { name: 'Other supplier', qty: 2, supplier_id: 'other' } };
  t.$('#restock_supplier').val('general');
  t.app.restockPurchase();
  assert.equal(t.request().url, 'suppliers/general');
  t.request().yes({ type: 'success', data: { name: 'General Supplier' } });
  t.app.applyPurchaseDraft();
  assert.equal(t.$('#receiving_add_supplier_name').val(), 'General Supplier');
  assert.equal(t.added[0].item_quantity, 4);
  assert.equal(t.added[0].supplier, 'General Supplier');
  assert.deepEqual(Object.keys(t.app._restock), ['a', 'b'], 'the basket stays until the purchase is saved');
  t.app.loadList = () => {};
  t.app.completePurchaseRestock(['a']);
  assert.deepEqual(Object.keys(t.app._restock), ['b']);
});
test('existing purchase is never erased by a restock handoff', () => {
  const t = setup(); t.PosnicPro.receiving_lineitems = [{ item_id: 'existing' }];
  t.app._restock = { a: { name: 'Cable', qty: 1 } }; t.app.restockPurchase();
  assert.equal(t.route(), undefined); assert.equal(t.app._restock.a.qty, 1);
});
