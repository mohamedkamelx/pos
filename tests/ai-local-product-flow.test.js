'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLocalProductFlow } = require('../src/ai/local/product-flow');

const MOBILE = { id: '64b7f0c2a1b2c3d4e5f60001', name: 'موبايلات', itemCount: 12 };
const CLOTHES = { id: '64b7f0c2a1b2c3d4e5f60002', name: 'ملابس', itemCount: 7 };
const SHOES = { id: '64b7f0c2a1b2c3d4e5f60003', name: 'أحذية', itemCount: 4 };

function product(overrides = {}) {
  return {
    id: '64b7f0c2a1b2c3d4e5f60010',
    name: 'iPhone 15',
    selling_price: 50000,
    company_price: 40000,
    available_quantity: 3,
    ...overrides,
  };
}

function makeApi({
  categories = [MOBILE, CLOTHES, SHOES],
  products = [],
  storeType = 'electronics',
  searchResults = null,
} = {}) {
  const calls = [];
  const api = {
    calls,
    async get(path, query) {
      calls.push({ path, query });
      if (path === 'categories') {
        return { data: { list: categories, total: categories.length } };
      }
      if (path === 'items/search') {
        if (searchResults) return { data: { list: searchResults } };
        const wanted = String((query && query.q) || '').toLowerCase();
        const list = products.filter((item) => {
          const name = String(item.name || '').toLowerCase();
          return name.includes(wanted) || wanted.includes(name);
        });
        return { data: { list } };
      }
      if (path === 'branches/getOneStore') {
        return { data: { business_type: storeType } };
      }
      if (path.startsWith('categories/')) {
        const id = path.slice('categories/'.length);
        return { data: categories.find((category) => category.id === id) || null };
      }
      if (path.startsWith('items/')) {
        const id = path.slice('items/'.length);
        return { data: products.find((item) => item.id === id) || null };
      }
      throw new Error(`Unexpected API path ${path}`);
    },
  };
  return api;
}

function makeMemory() {
  const drafts = new Map();
  return {
    drafts,
    noteDraft(id, draft) {
      drafts.set(id, draft);
    },
    userTextFor() {
      return '';
    },
  };
}

async function run(message, { api = makeApi(), pending = null, turn = { writeRequest: true } } = {}) {
  const memory = makeMemory();
  const result = await runLocalProductFlow({
    message,
    pending,
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory,
    turn,
  });
  return { result, api, memory };
}

test('a complete standard product request becomes a local plan with one category search', async () => {
  const api = makeApi();
  const { result } = await run(
    'أضيف منتج iPhone 15 8 RAM 32GB سعر البيع 50000 جنيه والتكلفة 40 والكمية 13',
    { api },
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps.length, 1);
  const fields = result.plan.steps[0].fields;
  assert.equal(fields.name, 'iPhone 15 8 RAM 32GB');
  assert.equal(fields.selling_price, 50000);
  assert.equal(fields.cost_price, 40);
  assert.equal(fields.opening_stock, 13);
  assert.equal(fields.category_id, MOBILE.id);
  assert.equal(fields.category_name, 'موبايلات');

  const categoryCalls = api.calls.filter((call) => call.path === 'categories');
  const productCalls = api.calls.filter((call) => call.path === 'items/search');
  assert.equal(categoryCalls.length, 1);
  assert.equal(productCalls.length, 1);
});

test('a stock-in story is handed to the model with the pack arithmetic', async () => {
  const api = makeApi();
  const { result } = await run(
    'دخل المخزن كرتونة فيها 20 لمبة ليد 12 وات، الكرتونة كلها وقفت علينا بـ 600 جنيه، عايز أبيع الواحدة بـ 45 جنيه. ضيفها في قسم الإضاءة.',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'complex_commerce');
  assert.equal(result.context.draft.name, 'لمبة ليد 12 وات');
  assert.equal(result.context.draft.openingStock, 20);
  assert.equal(result.context.draft.costTotal, 600);
  assert.equal(result.context.draft.costPrice, 30);
  assert.equal(result.context.draft.sellingPrice, 45);
  assert.deepEqual(result.context.calculation, {
    cost_total: 600,
    units: 20,
    unit_cost: 30,
  });
  assert.deepEqual(result.context.resolution.tools, [
    'posnic_search_products',
    'posnic_list_categories',
    'posnic_propose_plan',
  ]);
  assert.ok(result.context.resolution.steps.some((step) => /600\s*÷\s*20/.test(step)));
  assert.ok(result.context.resolution.steps.some((step) => /الإضاءة/.test(step)));
  assert.deepEqual(result.context.missing, []);
  assert.equal(api.calls.filter((call) => call.path === 'items/search').length, 0);
});

test('an incomplete stock-in story still gets a resolution plan, not a template', async () => {
  const api = makeApi();
  const { result } = await run(
    'وصلت كرتونة لمبات ليد 12 وات، الكرتونة كلها وقفت علينا بـ 600 جنيه، عايز أبيع الواحدة بـ 45 جنيه. ضيفها في قسم الإضاءة.',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'complex_commerce');
  assert.equal(result.context.draft.costTotal, 600);
  assert.equal(result.context.draft.sellingPrice, 45);
  assert.ok(result.context.missing.includes('opening_stock'));
  assert.ok(result.context.resolution.steps.some((step) => /number of units/.test(step)));
  assert.ok(result.context.resolution.tools.includes('posnic_ask_user'));
});

test('a logical ask without a pack story is forwarded with a resolution plan', async () => {
  const api = makeApi();
  const { result } = await run(
    'أضيف منتج لمبة ليد بسعر 45 وتكلفة 30 وكمية 20 واعمل خصم 10%',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'complex_commerce');
  assert.equal(result.context.draft.name, 'لمبة ليد');
  assert.ok(result.context.resolution.steps.some((step) => /discount|percentage/i.test(step)));
  assert.ok(result.context.resolution.tools.includes('posnic_propose_plan'));
});

test('a typo of "new" asks the model for the product name instead of becoming the name', async () => {
  const api = makeApi();
  const { result } = await run('عايز اضيف منتج جديدي', { api });

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_name');
  assert.ok(result.context.missing.includes('name'));
  assert.equal(result.context.draft.name, undefined);
  assert.ok(result.context.resolution.tools.includes('posnic_ask_user'));
  assert.ok(result.context.resolution.steps.some((step) => /name/.test(step)));
  assert.equal(api.calls.filter((call) => call.path === 'categories').length, 0);
});

test('a "new" typo with a price keeps the price and asks only for the name', async () => {
  const { result } = await run('عايز اضيف منتج جديدي بسعر 50000');

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_name');
  assert.equal(result.context.draft.name, undefined);
  assert.equal(result.context.draft.sellingPrice, 50000);
  assert.ok(result.context.missing.includes('name'));
  assert.ok(result.context.resolution.steps.some((step) => /Ask one short natural question for: name/.test(step)));
});

test('missing values are handed to the model with the draft', async () => {
  const { result, memory } = await run('أضيف منتج iPhone 15');

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_values');
  assert.ok(result.context.missing.includes('selling_price'));
  assert.ok(result.context.missing.includes('cost_price'));
  assert.ok(result.context.missing.includes('opening_stock'));
  assert.ok(result.context.resolution.tools.includes('posnic_ask_user'));
  assert.ok(result.context.resolution.steps.some((step) => /selling_price/.test(step)));
  assert.ok(memory.drafts.get('conversation-1'));
  assert.equal(memory.drafts.get('conversation-1').name, 'iPhone 15');
});

test('an exact duplicate is handed to the model instead of proposing a plan', async () => {
  const api = makeApi({ products: [product()] });
  const { result } = await run('أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40000 وكمية 3', { api });

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'duplicate');
  assert.equal(result.context.duplicate.name, 'iPhone 15');
  assert.ok(result.context.resolution.steps.some((step) => /update it or create a new one/.test(step)));
});

test('a one-letter spelling slip is handed to the model instead of creating a duplicate', async () => {
  const api = makeApi({ searchResults: [product()] });
  const { result } = await run(
    'أضيف منتج iPhon 15 بسعر 50000 وتكلفة 40000 وكمية 3',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'duplicate');
  assert.equal(result.context.duplicate.name, 'iPhone 15');
  assert.equal(result.context.duplicate.near, true);
});

test('a different product with an extra word is not treated as a duplicate', async () => {
  const api = makeApi({ searchResults: [product()] });
  const { result } = await run(
    'أضيف منتج iPhone 15 Pro بسعر 50000 وتكلفة 40000 وكمية 3',
    { api },
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps[0].fields.name, 'iPhone 15 Pro');
});

test('a close product kept as new keeps the typed name and finds its category', async () => {
  const api = makeApi({ searchResults: [product()] });
  const memory = makeMemory();
  const first = await runLocalProductFlow({
    message: 'أضيف منتج iPhon 15 بسعر 50000 وتكلفة 40000 وكمية 3',
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory,
    turn: { writeRequest: true },
  });
  assert.equal(first.handled, false);
  assert.equal(first.context.reason, 'duplicate');

  const second = await runLocalProductFlow({
    message: 'منتج جديد',
    pending: { kind: 'create_product', draft: memory.drafts.get('conversation-1') },
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory,
    turn: { pendingAnswer: true },
  });

  assert.equal(second.handled, true);
  assert.equal(second.kind, 'plan');
  assert.equal(second.plan.steps[0].fields.name, 'iPhon 15');
  assert.equal(second.plan.steps[0].fields.category_id, MOBILE.id);
});

test('a fashion shop does not get a mobile category for an iPhone', async () => {
  const api = makeApi({ storeType: 'fashion' });
  const { result } = await run(
    'أضيف منتج iPhone 15 8 RAM 32GB بسعر 50000 وتكلفة 40 وكمية 13',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'category_choice');
  assert.ok(!result.context.draft.categoryChoice);
  assert.ok(!result.context.draft.categoryName);
  const candidateNames = (result.context.category && result.context.category.candidates || [])
    .map((candidate) => candidate.name);
  assert.ok(!candidateNames.includes('موبايلات'));
  assert.ok(result.context.resolution.steps.some((step) => /category/i.test(step)));
});

test('the store type from the branch is used before the model is started', async () => {
  const api = makeApi({ storeType: 'fashion' });
  await run('أضيف منتج iPhone 15 8 RAM 32GB بسعر 50000 وتكلفة 40 وكمية 13', { api });

  const branchCalls = api.calls.filter((call) => call.path === 'branches/getOneStore');
  assert.equal(branchCalls.length, 1);
});

test('a named category that does not exist asks whether to create it', async () => {
  const api = makeApi({ categories: [CLOTHES, SHOES] });
  const { result } = await run(
    'أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13 في فئة موبايلات',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'category_choice');
  assert.ok(result.context.resolution.steps.some((step) => /موبايلات/.test(step)));
  assert.ok(result.context.resolution.steps.some((step) => /create/i.test(step)));
});

test('a named category resolves to the shop synonym instead of asking to create it', async () => {
  const phones = { id: '64b7f0c2a1b2c3d4e5f60004', name: 'هواتف', itemCount: 6 };
  const api = makeApi({ categories: [phones] });
  const { result } = await run(
    'أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13 في فئة موبايلات',
    { api },
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  const fields = result.plan.steps[0].fields;
  assert.equal(fields.category_id, phones.id);
  assert.equal(fields.category_name, 'هواتف');
});

test('creating a category that already exists reuses it in the plan', async () => {
  const api = makeApi();
  const { result } = await run(
    'أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13 وأنشئ فئة موبايلات',
    { api },
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.steps[0].action, 'create_category');
  assert.equal(result.plan.steps[0].reuse.id, MOBILE.id);
  assert.equal(result.plan.steps[1].action, 'create_product');
  assert.deepEqual(result.plan.steps[1].fields.category_id, { step: 'cat1', field: 'id' });
});

test('a shop with no categories asks whether to create a category or stay uncategorized', async () => {
  const api = makeApi({ categories: [] });
  const { result } = await run(
    'أضيف منتج Samsung TV بسعر 50000 وتكلفة 40 وكمية 13',
    { api },
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'category_choice');
  assert.deepEqual(result.context.categoryNames, []);
  assert.ok(result.context.resolution.steps.some((step) => /No category matched/.test(step)));
});

test('an ambiguous price is handed to the model with the parsed draft', async () => {
  const { result } = await run(
    'أضيف منتج iPhone 15 50000 والتكلفة 40 والكمية 13',
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'ambiguous_parse');
  assert.equal(result.context.draft.name, 'iPhone 15 50000');
  assert.equal(result.context.draft.priceAmbiguous, true);
  assert.ok(result.context.draft.unlabeledAmounts.includes(15));
  assert.ok(result.context.draft.unlabeledAmounts.includes(50000));
});

test('a side question pauses the product request instead of being parsed as a value', async () => {
  const pending = {
    kind: 'create_product',
    draft: {
      kind: 'create_product',
      name: 'iPhone 15',
      sellingPrice: 50000,
      costPrice: 40,
      openingStock: 13,
      categoryAsked: false,
    },
  };
  const { result } = await run('إيه سعر iPhone 15؟', {
    pending,
    turn: { sideQuestion: true },
  });

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'side_question');
  assert.equal(result.context.draft.name, 'iPhone 15');
});

test('a multi-action request is handed to the model', async () => {
  const { result } = await run(
    'أضيف منتج iPhone 15 بسعر 50000 وتكلفة 40 وكمية 13 وكمان أضيف منتج Samsung TV',
  );

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'complex_request');
});

test('a price after "بـ" is recognized without a cost or stock label', async () => {
  const { result } = await run('أضيف منتج iPhone 15 بـ 50000');

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'needs_values');
  assert.equal(result.context.draft.name, 'iPhone 15');
  assert.equal(result.context.draft.sellingPrice, 50000);
  assert.ok(result.context.missing.includes('cost_price'));
  assert.ok(result.context.missing.includes('opening_stock'));
});

test('an explicit "cost is the same as price" answer fills the cost', async () => {
  const { result } = await run(
    'أضيف منتج iPhone 15 بسعر 50000 والتكلفة نفس السعر والكمية 13',
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps[0].fields.name, 'iPhone 15');
  assert.equal(result.plan.steps[0].fields.cost_price, 50000);
});

test('an explicit "no stock" answer fills zero instead of asking again', async () => {
  const { result } = await run(
    'أضيف منتج iPhone 15 بسعر 50000 والتكلفة 40 ومفيش مخزون',
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps[0].fields.name, 'iPhone 15');
  assert.equal(result.plan.steps[0].fields.opening_stock, 0);
});

test('"not important" after a category question leaves the product uncategorized', async () => {
  const pending = {
    kind: 'create_product',
    draft: {
      kind: 'create_product',
      name: 'iPhone 15',
      sellingPrice: 50000,
      costPrice: 40,
      openingStock: 13,
      categoryAsked: true,
      categoryCandidates: [{ id: MOBILE.id, name: MOBILE.name, score: 0.9 }],
    },
  };
  const { result } = await run('مش مهم', { pending });

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps[0].fields.category_id, '');
  assert.equal(result.plan.steps[0].fields.name, 'iPhone 15');
});

test('"choose for me" after a category suggestion accepts the top candidate', async () => {
  const pending = {
    kind: 'create_product',
    draft: {
      kind: 'create_product',
      name: 'iPhone 15',
      sellingPrice: 50000,
      costPrice: 40,
      openingStock: 13,
      categoryAsked: true,
      categoryCandidates: [{ id: MOBILE.id, name: MOBILE.name, score: 0.9 }],
    },
  };
  const { result } = await run('اختار إنت', { pending });

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps[0].fields.category_id, MOBILE.id);
  assert.equal(result.plan.steps[0].fields.category_name, MOBILE.name);
});

test('"I do not know" about a required value is handed to the model for help', async () => {
  const pending = {
    kind: 'create_product',
    draft: {
      kind: 'create_product',
      name: 'iPhone 15',
      sellingPrice: 50000,
      categoryAsked: false,
    },
  };
  const { result } = await run('مش عارف التكلفة', { pending });

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'user_unsure');
  assert.equal(result.context.draft.name, 'iPhone 15');
  assert.equal(result.context.draft.sellingPrice, 50000);
  assert.ok(result.context.missing.includes('cost_price'));
});

test('the pending draft answers a short follow-up without asking for known values', async () => {
  const api = makeApi();
  const first = await run('أضيف منتج iPhone 15', { api });
  const pending = { kind: 'create_product', draft: first.memory.drafts.get('conversation-1') };

  const second = await runLocalProductFlow({
    message: 'السعر 50000 والتكلفة 40 والكمية 13',
    pending,
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory: first.memory,
    turn: { pendingAnswer: true },
  });

  assert.equal(second.handled, true);
  assert.equal(second.kind, 'plan');
  assert.equal(second.plan.steps[0].fields.name, 'iPhone 15');
  assert.equal(second.plan.steps[0].fields.selling_price, 50000);
});

/* The image question used to be answered and then dropped: the plan was
   always built with `images: []`, so the picture the operator attached never
   reached the product. The draft owns the answer, and the plan reads it from
   there - only an explicitly attached image, never an unanswered or
   declined one. */
test('an image the operator attached reaches the plan, and a declined one does not', async () => {
  const attachments = {
    describe(sessionID, ids) {
      const list = sessionID === 'conversation-1'
        ? [{ id: 'att-7', name: 'photo.png', mime: 'image/png' }]
        : [];
      const found = ids.map((id) => list.find((item) => item.id === id)).filter(Boolean);
      return found.length === ids.length
        ? { ok: true, attachments: found }
        : { ok: false, code: 'attachment_missing', message: 'gone' };
    },
    list() { return []; },
  };

  const api = makeApi();
  const first = await run('أضيف منتج iPhone 15', { api });
  const attachedDraft = first.memory.drafts.get('conversation-1');
  attachedDraft.image = { status: 'attached', attachmentIds: ['att-7'] };

  const attached = await runLocalProductFlow({
    message: 'السعر 50000 والتكلفة 40 والكمية 13',
    pending: { kind: 'create_product', draft: attachedDraft },
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory: first.memory,
    turn: { pendingAnswer: true },
    attachments,
  });
  assert.equal(attached.handled, true);
  assert.deepEqual(attached.plan.steps[0].images, [
    { attachmentId: 'att-7', name: 'photo.png', cover: true },
  ]);

  const otherApi = makeApi();
  const start = await run('أضيف منتج iPhone 15', { api: otherApi });
  const declinedDraft = start.memory.drafts.get('conversation-1');
  declinedDraft.image = { status: 'none', attachmentIds: [] };

  const declined = await runLocalProductFlow({
    message: 'السعر 50000 والتكلفة 40 والكمية 13',
    pending: { kind: 'create_product', draft: declinedDraft },
    api: otherApi,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory: start.memory,
    turn: { pendingAnswer: true },
    attachments,
  });
  assert.equal(declined.handled, true);
  assert.deepEqual(declined.plan.steps[0].images, []);
});

/* The attach turn arrives as its own sentence ("استخدم الصورة المرفقة.").
   It must read as an answer to the image question and nothing else: the name
   the request already recorded stays, and the image it carried stays with it
   all the way to the plan. Losing the name here is what made the model ask
   for it a second time. */
test('the attach turn keeps the name and the image the request already recorded', async () => {
  const attachments = {
    describe(sessionID, ids) {
      const list = sessionID === 'conversation-1'
        ? [{ id: 'att-7', name: 'photo.png', mime: 'image/png' }]
        : [];
      const found = ids.map((id) => list.find((item) => item.id === id)).filter(Boolean);
      return found.length === ids.length
        ? { ok: true, attachments: found }
        : { ok: false, code: 'attachment_missing', message: 'gone' };
    },
    list() { return []; },
  };

  const api = makeApi();
  const first = await run('أضيف منتج iPhone 15', { api });
  const draft = first.memory.drafts.get('conversation-1');
  assert.equal(draft.name, 'iPhone 15');
  draft.image = { status: 'attached', attachmentIds: ['att-7'] };

  const afterAttach = await runLocalProductFlow({
    message: 'استخدم الصورة المرفقة.',
    pending: { kind: 'create_product', draft },
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory: first.memory,
    turn: { pendingAnswer: true },
    attachments,
  });
  assert.equal(afterAttach.handled, false);
  /* The model-facing draft keeps the name, and the stored draft keeps both the
     name and the image the attach turn answered with. */
  assert.equal(afterAttach.context.draft.name, 'iPhone 15');
  const stored = first.memory.drafts.get('conversation-1');
  assert.equal(stored.name, 'iPhone 15');
  assert.deepEqual(stored.image, { status: 'attached', attachmentIds: ['att-7'] });

  const finished = await runLocalProductFlow({
    message: 'السعر 50000 والتكلفة 40 والكمية 13',
    pending: { kind: 'create_product', draft: stored },
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory: first.memory,
    turn: { pendingAnswer: true },
    attachments,
  });
  assert.equal(finished.handled, true);
  assert.equal(finished.plan.steps[0].fields.name, 'iPhone 15');
  assert.deepEqual(finished.plan.steps[0].images, [
    { attachmentId: 'att-7', name: 'photo.png', cover: true },
  ]);
});

/* The click case: the page sends the option label together with the
   structured answer, and conversation-memory has already settled the slot.
   The flow must resume the recorded draft instead of parsing the label —
   this label sits outside the typed vocabulary, so only the settled-slot
   signal can keep the name. */
test('a clicked image answer resumes the recorded draft without parsing the label', async () => {
  const attachments = {
    describe(sessionID, ids) {
      const list = sessionID === 'conversation-1'
        ? [{ id: 'att-7', name: 'photo.png', mime: 'image/png' }]
        : [];
      const found = ids.map((id) => list.find((item) => item.id === id)).filter(Boolean);
      return found.length === ids.length
        ? { ok: true, attachments: found }
        : { ok: false, code: 'attachment_missing', message: 'gone' };
    },
    list() { return []; },
  };

  const api = makeApi();
  const first = await run('أضيف منتج iPhone 15', { api });
  const draft = first.memory.drafts.get('conversation-1');
  assert.equal(draft.name, 'iPhone 15');
  draft.image = { status: 'attached', attachmentIds: ['att-7'] };

  const afterClick = await runLocalProductFlow({
    message: 'أرفق صورة من الموبايل',
    pending: { kind: 'create_product', draft },
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory: first.memory,
    turn: { pendingAnswer: true, answered: { slot: 'image', kind: 'attachment' } },
    attachments,
  });
  assert.equal(afterClick.handled, false);
  /* The model-facing draft keeps the name, and the stored draft keeps both
     the name and the image the click answered with. */
  assert.equal(afterClick.context.draft.name, 'iPhone 15');
  const stored = first.memory.drafts.get('conversation-1');
  assert.equal(stored.name, 'iPhone 15');
  assert.deepEqual(stored.image, { status: 'attached', attachmentIds: ['att-7'] });
  /* The label is outside the typed vocabulary, so parsing it would extract
     a differing name and raise followup_text_unclaimed — only the settled
     slot keeps this turn's draft free of it. */
  assert.ok(!(afterClick.context.vetoes || []).includes('followup_text_unclaimed'));
});

test('a vetoed draft stays refused through an attach click', async () => {
  /* Claude review #6: a draft whose values were vetoed still holds them, so
     the image clone must not clear the vetoes — otherwise the click resumes
     it as if it were clean and a local plan is built from suspect values. */
  const api = makeApi();
  const draft = {
    kind: 'create_product',
    name: 'Samsung TV',
    sellingPrice: 25000,
    costPrice: 40,
    openingStock: 5,
    vetoes: ['followup_text_unclaimed'],
  };
  const { result, memory } = await run('أرفق صورة', {
    api,
    pending: { kind: 'create_product', draft },
    turn: { pendingAnswer: true, answered: { slot: 'image', kind: 'attachment' } },
  });
  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'unverified_parse');
  assert.deepEqual(memory.drafts.get('conversation-1').vetoes, ['followup_text_unclaimed']);
  assert.equal(api.calls.length, 0, 'no search or write runs for a refused draft');
});
