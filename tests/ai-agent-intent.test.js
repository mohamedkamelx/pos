'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractIntent } = require('../src/ai/agent/intent');

function intentFor(message, options) {
  return extractIntent(message, options);
}

test('"edit that product" is targetless and keeps only the field the user named', () => {
  const intent = intentFor('عدل المنتج ده وخلي سعره 30');

  assert.equal(intent.action, 'update_product');
  assert.equal(intent.query, '');
  assert.deepEqual(intent.requestedFields, ['selling_price']);
  assert.deepEqual(intent.values, { selling_price: 30 });
  assert.equal(intent.steps.length, 1);
});

test('"edit that product" in English never invents a field', () => {
  const intent = intentFor('edit that product');

  assert.equal(intent.action, 'update_product');
  assert.equal(intent.query, '');
  assert.deepEqual(intent.requestedFields, []);
  assert.deepEqual(intent.values, {});
});

test('an image edit asks for the picture, not any other product field', () => {
  for (const message of ['غير صورة المنتج', 'change the picture']) {
    const intent = intentFor(message);
    assert.equal(intent.action, 'update_product');
    assert.deepEqual(intent.requestedFields, ['image']);
    assert.equal(intent.imageOnly, true);
    assert.deepEqual(intent.values, {});
  }
});

test('a stock question carries the product name for a live read', () => {
  const intent = intentFor('كام مخزون كاتل؟');

  assert.equal(intent.action, 'read_stock');
  assert.equal(intent.query, 'كاتل');
  assert.equal(intent.live, true);
});

test('an English stock question keeps the product name', () => {
  const intent = intentFor('how many panadol do we have?');

  assert.equal(intent.action, 'read_stock');
  assert.equal(intent.query, 'panadol');
});

test('a price question is a live price read', () => {
  const intent = intentFor('بكام iPhone 15؟');
  assert.equal(intent.action, 'read_price');
  assert.equal(intent.query, 'iPhone 15');

  const english = intentFor('what is the price of katel?');
  assert.equal(english.action, 'read_price');
  assert.equal(english.query, 'katel');
});

test('counting products is a live count with no product name', () => {
  for (const message of ['عندنا كام منتج؟', 'how many products do we have?']) {
    const intent = intentFor(message);
    assert.equal(intent.action, 'read_count');
    assert.equal(intent.query, '');
    assert.equal(intent.live, true);
  }
});

test('listing products is a live list', () => {
  for (const message of ['اعرض كل المنتجات', 'list all products']) {
    const intent = intentFor(message);
    assert.equal(intent.action, 'list_products');
    assert.equal(intent.query, '');
  }
});

test('a full product create request keeps the parsed draft', () => {
  const intent = intentFor('أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13');

  assert.equal(intent.action, 'create_product');
  assert.equal(intent.draft.name, 'iPhone 15');
  assert.equal(intent.draft.sellingPrice, 50000);
  assert.equal(intent.draft.costPrice, 40);
  assert.equal(intent.draft.openingStock, 13);
});

test('a stock-in story with an attached create verb is a product create request', () => {
  const intent = intentFor(
    'دخل المخزن كرتونة فيها 20 لمبة ليد 12 وات، الكرتونة كلها وقفت علينا بـ 600 جنيه، عايز أبيع الواحدة بـ 45 جنيه. ضيفها في قسم الإضاءة.',
  );

  assert.equal(intent.action, 'create_product');
  assert.equal(intent.confidence, 'high');
  assert.equal(intent.draft.name, 'لمبة ليد 12 وات');
  assert.equal(intent.draft.openingStock, 20);
  assert.equal(intent.draft.costTotal, 600);
  assert.equal(intent.draft.costPrice, 30);
  assert.equal(intent.draft.sellingPrice, 45);
  assert.equal(intent.draft.categoryName, 'الإضاءة');
});

test('a category location does not turn a product create into a category create', () => {
  const intent = intentFor('أضيف منتج لمبة ليد بسعر 45 وتكلفة 30 وكمية 20 في قسم الإضاءة');
  assert.equal(intent.action, 'create_product');
  assert.equal(intent.draft.name, 'لمبة ليد');
});

test('a multi-action request becomes one ordered action list', () => {
  const intent = intentFor(
    'زيد مخزون كاتل 5 واضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 3',
  );

  assert.equal(intent.action, 'multi');
  assert.equal(intent.steps.length, 2);
  assert.equal(intent.steps[0].action, 'adjust_stock');
  assert.equal(intent.steps[0].query, 'كاتل');
  assert.deepEqual(intent.steps[0].stock, {
    mode: 'add',
    quantity: 5,
    reason: 'Stock found',
    verb: 'زيد',
  });
  assert.equal(intent.steps[1].action, 'create_product');
  assert.equal(intent.steps[1].query, 'iPhone 15');
});

test('an English stock addition keeps the whole product name', () => {
  const intent = intentFor('add 10 to katel stock');

  assert.equal(intent.action, 'adjust_stock');
  assert.equal(intent.query, 'katel');
  assert.equal(intent.stock.mode, 'add');
  assert.equal(intent.stock.quantity, 10);
});

test('setting a named price is an update, not a price read', () => {
  const arabic = intentFor('خلي سعر كاتل 30');
  assert.equal(arabic.action, 'update_product');
  assert.equal(arabic.query, 'كاتل');
  assert.deepEqual(arabic.requestedFields, ['selling_price']);
  assert.deepEqual(arabic.values, { selling_price: 30 });

  const english = intentFor('set the price of katel to 30');
  assert.equal(english.action, 'update_product');
  assert.equal(english.query, 'katel');
  assert.deepEqual(english.requestedFields, ['selling_price']);
  assert.deepEqual(english.values, { selling_price: 30 });
});

test('setting stock is a stock adjustment', () => {
  for (const message of ['خلي المخزون 20', 'set stock to 20']) {
    const intent = intentFor(message);
    assert.equal(intent.action, 'adjust_stock');
    assert.equal(intent.stock.mode, 'set');
    assert.equal(intent.stock.quantity, 20);
  }
});

test('a mixed price edit and stock change goes to the model, not a partial plan', () => {
  const intent = intentFor('عدل سعر كاتل وخلي المخزون 20');

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.confidence, 'low');
  assert.equal(intent.reason, 'needs_model');
  assert.deepEqual(intent.steps, []);
});

test('two questions in one message go to the model instead of a junk product name', () => {
  const intent = intentFor('كام مخزون كاتل وكام سعره؟');

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'needs_model');
  assert.equal(intent.query, '');
});

test('a second request after a question goes to the model', () => {
  const intent = intentFor('كام مخزون كاتل؟ واطلب 10 كراتين');

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'other_request');
});

test('another record type is never treated as a product', () => {
  for (const message of ['عدل العميل أحمد', 'غير إعدادات الطباعة']) {
    const intent = intentFor(message);
    assert.equal(intent.action, 'unknown');
    assert.equal(intent.reason, 'other_request');
  }
});

test('an unsupported action is not answered as a product list', () => {
  const intent = intentFor('اعرض المنتجات وابعتلي تقرير');

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'other_request');
});

test('an extra request inside a create sentence goes to the model', () => {
  const intent = intentFor(
    'أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13 وكمان قولي الأرباح',
  );

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'needs_model');
});

test('an incomplete multi-action request goes to the model', () => {
  const intent = intentFor('زيد مخزون كاتل واضيف منتج iPhone 15 بسعر 50000');

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'incomplete_multi');
});

test('a polite create question with a low-confidence name goes to the model', () => {
  const intent = intentFor('ممكن أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13؟');

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'needs_model');
});

test('a bulk new-category request is not read as one product', () => {
  const intent = intentFor('ضيف 3 منتجات في فئة جديدة اسمها أدوية');

  assert.equal(intent.action, 'bulk_create');
  assert.deepEqual(intent.category, { name: 'أدوية', create: true });
});

test('a spelled-out Arabic count is a bulk create, not a product named ten', () => {
  const intent = intentFor('عايز اضيف عشر منتاجات');

  assert.equal(intent.action, 'bulk_create');
  assert.equal(intent.bulk, 10);
  assert.equal(intent.query, '');
  assert.equal(intent.draft, null);
});

test('other spelled-out Arabic counts reach the bulk flow', () => {
  for (const [message, count] of [
    ['ضيف خمس منتجات', 5],
    ['أضيف ثمانية منتجات', 8],
    ['أضيف اربعة منتاجات', 4],
    ['أضيف عشرين منتج', 20],
  ]) {
    const intent = intentFor(message);
    assert.equal(intent.action, 'bulk_create', message);
    assert.equal(intent.bulk, count, message);
  }
});

test('a product whose name is a number word is still one product', () => {
  const intent = intentFor('أضيف منتج اسمه عشرة بسعر 50 وتكلفة 40 وكمية 3');

  assert.equal(intent.action, 'create_product');
  assert.equal(intent.bulk, null);
  assert.equal(intent.query, 'عشرة');
});

test('a category named in a read request is kept for the live query', () => {
  const intent = intentFor('كام منتج في فئة موبايلات؟');

  assert.equal(intent.action, 'read_count');
  assert.equal(intent.query, '');
  assert.equal(intent.category.name, 'موبايلات');
  assert.equal(intent.category.create, false);
});

test('a list request with a named category does not become the same-category choice', () => {
  const intent = intentFor('اعرض كل المنتجات في فئة موبايلات');
  assert.equal(intent.action, 'list_products');
  assert.equal(intent.category.name, 'موبايلات');
});

test('a how-to question is help, not a create action', () => {
  const intent = intentFor('إزاي أضيف منتج؟');
  assert.equal(intent.action, 'help');
});
