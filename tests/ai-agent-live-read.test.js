'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLiveRead } = require('../src/ai/agent/live-read');
const { extractIntent } = require('../src/ai/agent/intent');

const PHONES = { id: '64b7f0c2a1b2c3d4e5f60001', name: 'موبايلات' };
const DRINKS = { id: '64b7f0c2a1b2c3d4e5f60002', name: 'مشروبات' };

function row(overrides = {}) {
  return {
    id: '64b7f0c2a1b2c3d4e5f60010',
    name: 'كاتل',
    selling_price: 100,
    company_price: 70,
    available_quantity: 8,
    category_id: PHONES.id,
    category_name: PHONES.name,
    track_inventory: true,
    unit: 'qty',
    ...overrides,
  };
}

function makeApi({
  products = [row()],
  categories = [PHONES, DRINKS],
  fail = false,
} = {}) {
  const calls = [];
  const api = {
    calls,
    async get(path, query = {}) {
      calls.push({ path, query });
      if (fail) throw new Error('The shop data service failed.');
      if (path === 'categories') {
        const wanted = String(query.search || '').toLowerCase();
        const list = categories.filter(
          (category) => !wanted || category.name.toLowerCase().includes(wanted),
        );
        return { data: { list, total: list.length } };
      }
      if (path === 'items/search') {
        const wanted = String(query.q || '').toLowerCase();
        const list = products.filter((item) => {
          const name = String(item.name || '').toLowerCase();
          return name.includes(wanted) || wanted.includes(name);
        });
        return { data: { list } };
      }
      if (path === 'items') {
        const filters = query.filters ? JSON.parse(query.filters) : {};
        let list = products.slice();
        if (filters.category_id) {
          list = list.filter((item) => item.category_id === filters.category_id);
        }
        const limit = Number(query.limit) || 20;
        const page = Number(query.page) || 1;
        const start = (page - 1) * limit;
        return {
          data: {
            list: list.slice(start, start + limit),
            total: list.length,
            total_pages: Math.max(1, Math.ceil(list.length / limit)),
          },
        };
      }
      throw new Error(`Unexpected API path ${path}`);
    },
  };
  return api;
}

async function run(message, options = {}) {
  const api = options.api || makeApi();
  const intent = options.intent || extractIntent(message);
  const result = await runLiveRead({
    intent,
    message,
    api,
    currencySign: options.currencySign || '',
  });
  return { result, api, intent };
}

test('a named stock question is answered from the live item row', async () => {
  const { result } = await run('كام مخزون كاتل؟');

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'text');
  assert.match(result.text, /«كاتل» متوفر 8/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].metadata.posnic.kind, 'product_search');
  assert.equal(result.toolCalls[0].metadata.posnic.internal, undefined);
});

test('a price question uses the live selling price and the shop currency', async () => {
  const { result } = await run('بكام كاتل؟', { currencySign: 'ج.م' });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /سعر «كاتل»: 100 ج\.م/);
});

test('a close name with more than one match asks by name, not by id', async () => {
  const api = makeApi({
    products: [
      row({ id: 'a', name: 'كاتل مياه' }),
      row({ id: 'b', name: 'كاتل غاز' }),
    ],
  });
  const { result } = await run('كام مخزون كاتل؟', { api });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /«كاتل مياه»/);
  assert.match(result.text, /«كاتل غاز»/);
  assert.match(result.text, /أنهي واحد/);
  assert.doesNotMatch(result.text, /\bid\b/i);
});

test('a product count reads the live total and hides the raw row card', async () => {
  const api = makeApi({
    products: [
      row({ id: 'a' }),
      row({ id: 'b', name: 'شاي' }),
    ],
  });
  const { result } = await run('عندنا كام منتج؟', { api });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /عدد المنتجات في الفرع الحالي: 2/);
  assert.equal(result.toolCalls[0].metadata.posnic.internal, true);
});

test('a profit question ranks live rows by unit margin', async () => {
  const api = makeApi({
    products: [
      row({ id: 'a', name: 'كاتل', selling_price: 100, company_price: 80 }),
      row({ id: 'b', name: 'شاي', selling_price: 50, company_price: 20 }),
    ],
  });
  const { result } = await run('أكتر منتج بيكسب', { api });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /«شاي»/);
  assert.ok(result.text.indexOf('«شاي»') < result.text.indexOf('«كاتل»'));
  assert.equal(result.toolCalls[0].metadata.posnic.kind, 'product_list');
});

test('a list request answers from the live list', async () => {
  const { result } = await run('اعرض كل المنتجات');

  assert.equal(result.kind, 'text');
  assert.match(result.text, /المنتجات:/);
  assert.match(result.text, /«كاتل»/);
  assert.equal(result.toolCalls[0].name, 'posnic_list_products');
});

test('a named category filters the live list by its branch id', async () => {
  const api = makeApi({
    products: [
      row({ id: 'a', name: 'iPhone 15', category_id: PHONES.id, category_name: PHONES.name }),
      row({ id: 'b', name: 'شاي', category_id: DRINKS.id, category_name: DRINKS.name }),
    ],
  });
  const { result, intent } = await run('اعرض كل المنتجات في فئة موبايلات', { api });

  assert.equal(intent.category.name, 'موبايلات');
  assert.match(result.text, /iPhone 15/);
  assert.doesNotMatch(result.text, /شاي/);
  const itemCall = api.calls.find((call) => call.path === 'items');
  assert.equal(JSON.parse(itemCall.query.filters).category_id, PHONES.id);
});

test('an unknown category is reported instead of listing everything', async () => {
  const { result } = await run('اعرض كل المنتجات في فئة إلكترونيات');

  assert.equal(result.kind, 'text');
  assert.match(result.text, /مش لاقي فئة اسمها «إلكترونيات»/);
});

test('a failed live read falls back to the model instead of inventing data', async () => {
  const { result } = await run('كام مخزون كاتل؟', { api: makeApi({ fail: true }) });
  assert.equal(result, null);
});

test('a low-confidence intent is not answered locally', async () => {
  const { result } = await run('كام مخزون كاتل وكام سعره؟', {
    intent: {
      action: 'read_stock',
      query: 'كاتل',
      confidence: 'low',
    },
  });

  assert.equal(result, null);
});
