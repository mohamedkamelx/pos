'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runCompiler } = require('../src/ai/agent/compiler');
const { extractIntent } = require('../src/ai/agent/intent');
const { createTaskKernel } = require('../src/ai/agent/task-kernel');

const MOBILE = { id: '64b7f0c2a1b2c3d4e5f60001', name: 'موبايلات' };
const DRINKS = { id: '64b7f0c2a1b2c3d4e5f60002', name: 'مشروبات' };

function product(overrides = {}) {
  return {
    id: '64b7f0c2a1b2c3d4e5f60010',
    name: 'كاتل',
    selling_price: 100,
    company_price: 70,
    available_quantity: 8,
    category_id: DRINKS.id,
    category_name: DRINKS.name,
    track_inventory: true,
    unit: 'qty',
    ...overrides,
  };
}

function makeApi({ products = [product()], categories = [MOBILE, DRINKS] } = {}) {
  const calls = [];
  const api = {
    calls,
    async get(path, query = {}) {
      calls.push({ path, query });
      if (path === 'items/search') {
        const wanted = String(query.q || '').toLowerCase();
        const list = products.filter((item) => {
          const name = String(item.name || '').toLowerCase();
          return name.includes(wanted) || wanted.includes(name);
        });
        return { data: { list } };
      }
      if (path.startsWith('items/')) {
        const id = decodeURIComponent(path.slice('items/'.length));
        return { data: products.find((item) => item.id === id) || null };
      }
      if (path === 'categories') {
        return { data: { list: categories, total: categories.length } };
      }
      if (path.startsWith('categories/')) {
        const id = decodeURIComponent(path.slice('categories/'.length));
        return { data: categories.find((item) => item.id === id) || null };
      }
      throw new Error(`Unexpected API path ${path}`);
    },
  };
  return api;
}

function makeMemory({
  message = '',
  currentCategory = null,
} = {}) {
  return {
    userTextFor() {
      return message;
    },
    currentCategory() {
      return currentCategory;
    },
  };
}

function makeKernel(rows = []) {
  return {
    liveProducts() {
      return rows;
    },
  };
}

function attachmentsFor(list = []) {
  return {
    list() {
      return list;
    },
    describe(_sessionId, ids) {
      const id = ids && ids[0];
      const item = list.find((entry) => entry.id === id);
      if (!item) return { ok: false, code: 'attachment_missing', message: 'Attach the image again.' };
      return { ok: true, attachments: [item] };
    },
  };
}

async function compile(message, {
  api = makeApi(),
  conversationId = 'conversation-1',
  pending = null,
  kernel = makeKernel(),
  memory = makeMemory({ message }),
  attachments = null,
  currencySign = '',
} = {}) {
  const intent = extractIntent(message);
  const result = await runCompiler({
    intent,
    message,
    api,
    conversationId,
    pending,
    kernel,
    memory,
    attachments,
    currencySign,
  });
  return { intent, result, api };
}

test('a targetless price edit uses the one live product instead of asking for one', async () => {
  const { result } = await compile('عدل المنتج ده وخلي سعره 30', {
    kernel: makeKernel([product()]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps.length, 1);
  const step = result.plan.steps[0];
  assert.equal(step.action, 'update_product');
  assert.equal(step.targetName, 'كاتل');
  assert.equal(step.fields.selling_price, 30);
  assert.equal(step.fields.cost_price, undefined);
  assert.equal(step.fields.stock, undefined);
});

test('a targetless edit with no product context is handed to the model', async () => {
  const { result } = await compile('edit that product');

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_input');
  assert.equal(result.context.missing[0], 'product');
  assert.match(result.context.instruction, /own words/);
});

test('an image edit is handed to the model with the missing image', async () => {
  const { result } = await compile('غير صورة المنتج', {
    pending: {
      kind: 'create_product',
      draft: { kind: 'create_product', name: 'كاتل' },
    },
  });

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_input');
  assert.deepEqual(result.context.missing, ['image']);
  assert.match(result.context.instruction, /own words/);
});

test('an image edit with a chat attachment builds the image step', async () => {
  const { result } = await compile('غير صورة المنتج', {
    pending: {
      kind: 'create_product',
      draft: { kind: 'create_product', name: 'كاتل' },
    },
    attachments: attachmentsFor([{ id: 'att1', name: 'pack.jpg' }]),
  });

  assert.equal(result.kind, 'plan');
  const step = result.plan.steps[0];
  assert.deepEqual(step.images.map((image) => image.attachmentId), ['att1']);
  assert.equal(step.images[0].cover, true);
});

test('a stock addition becomes one adjust_stock plan', async () => {
  const { result } = await compile('زيد مخزون كاتل 5');

  assert.equal(result.kind, 'plan');
  const step = result.plan.steps[0];
  assert.equal(step.action, 'adjust_stock');
  assert.equal(step.targetName, 'كاتل');
  assert.equal(step.fields.stock_mode, 'add');
  assert.equal(step.fields.stock_quantity, 5);
  assert.equal(step.fields.reason, 'Stock found');
});

test('a targetless stock set uses the live product', async () => {
  const { result } = await compile('خلي المخزون 20', {
    kernel: makeKernel([product()]),
  });

  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps[0].fields.stock_mode, 'set');
  assert.equal(result.plan.steps[0].fields.stock_quantity, 20);
});

test('an ambiguous update target is handed to the model with the choices', async () => {
  const api = makeApi({
    products: [
      product({ id: 'a', name: 'كاتل مياه' }),
      product({ id: 'b', name: 'كاتل غاز' }),
    ],
  });
  const { result } = await compile('عدل سعر كاتل وخليه 120', { api });

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_input');
  const labels = result.context.options.map((option) => option.label);
  assert.ok(labels.includes('كاتل مياه'));
  assert.ok(labels.includes('كاتل غاز'));
  assert.ok(result.context.options.every((option) => !/\bid\b/i.test(option.label)));
});

test('a verified two-action request becomes one ordered plan', async () => {
  const { result } = await compile(
    'زيد مخزون كاتل 5 واضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 3',
  );

  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.steps[0].action, 'adjust_stock');
  assert.equal(result.plan.steps[0].fields.stock_mode, 'add');
  assert.equal(result.plan.steps[0].fields.stock_quantity, 5);
  assert.equal(result.plan.steps[1].action, 'create_product');
  assert.equal(result.plan.steps[1].fields.name, 'iPhone 15');
  assert.equal(result.plan.steps[1].fields.selling_price, 50000);
  assert.equal(result.plan.steps[1].fields.cost_price, 40);
  assert.equal(result.plan.steps[1].fields.opening_stock, 3);
});

test('a category carried in the pending draft stays concrete, not a step reference', async () => {
  const api = makeApi();
  const memory = makeMemory({
    message: 'ضيف منتج شاي بسعر 10 وتكلفة 5 وكمية 20 في نفس الفئة',
    currentCategory: MOBILE,
  });
  const intent = {
    action: 'multi',
    confidence: 'high',
    steps: [{
      action: 'create_product',
      query: 'شاي',
      draft: {
        kind: 'create_product',
        name: 'شاي',
        sellingPrice: 10,
        costPrice: 5,
        openingStock: 20,
        categoryChoice: 'same',
      },
    }],
  };
  const result = await runCompiler({
    intent,
    message: memory.userTextFor(),
    api,
    conversationId: 'conversation-1',
    memory,
    pending: null,
    kernel: makeKernel(),
    attachments: null,
  });

  assert.equal(result.kind, 'plan');
  const fields = result.plan.steps[0].fields;
  assert.equal(fields.category_id, MOBILE.id);
  assert.equal(fields.category_name, MOBILE.name);
  assert.deepEqual(result.plan.steps[0].dependsOn, undefined);
});

test('a bulk create request is handed to the model for the product details', async () => {
  const { result } = await compile('ضيف 3 منتجات في فئة جديدة اسمها أدوية');

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_input');
  assert.deepEqual(result.context.missing, ['product details']);
  assert.match(result.context.instruction, /own words/);
  assert.equal(result.context.draft, null);
});

test('a spelled-out Arabic count reaches the bulk clarification context', async () => {
  const { intent, result } = await compile('عايز اضيف عشر منتاجات');

  assert.equal(intent.action, 'bulk_create');
  assert.equal(intent.bulk, 10);
  assert.equal(result.handled, false);
  assert.equal(result.context.operation, 'bulk_create');
  assert.deepEqual(result.context.missing, ['product details']);
  assert.equal(result.context.draft, null);
});

test('a low-confidence or mixed intent never reaches a local plan', async () => {
  const { result } = await compile('عدل سعر كاتل وخلي المخزون 20');
  assert.equal(result, null);
});

test('a provider or API failure falls back to the model', async () => {
  const api = makeApi();
  api.get = async () => {
    throw new Error('The shop data service failed.');
  };
  const { result } = await compile('عدل سعر كاتل وخليه 120', { api });

  assert.equal(result, null);
});
