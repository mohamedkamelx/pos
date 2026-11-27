'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIVE_FRESH_MS,
  createTaskKernel,
  liveIsFresh,
} = require('../src/ai/agent/task-kernel');
const { extractIntent } = require('../src/ai/agent/intent');

function product(overrides = {}) {
  return {
    id: '64b7f0c2a1b2c3d4e5f60010',
    name: 'كاتل',
    sellingPrice: 100,
    costPrice: 70,
    stock: 8,
    category: 'أجهزة',
    ...overrides,
  };
}

function observeMessage(kernel, message, options = {}) {
  const intent = extractIntent(message);
  const state = kernel.observe('conversation-1', {
    intent,
    pending: options.pending || null,
    memory: options.memory || null,
  });
  return { intent, state, card: kernel.taskCard(state) };
}

test('a targetless price edit asks for the product, never for a price it did not name', () => {
  const kernel = createTaskKernel();
  const { card } = observeMessage(kernel, 'edit that product');

  assert.match(card, /Task: edit a product/);
  assert.match(card, /Missing: product/);
  assert.match(card, /Ask for the product name/);
  assert.match(card, /Do not ask for an id, price, cost or stock/);
});

test('an edit that named a price may ask for that value but not for cost or stock', () => {
  const kernel = createTaskKernel();
  const { card } = observeMessage(kernel, 'عدل المنتج ده وخلي سعره 30');

  assert.match(card, /Requested fields: selling_price/);
  assert.doesNotMatch(card, /Never ask for: .*selling price/);
  assert.match(card, /Never ask for: .*cost price/);
});

/* The card's "Missing:" line is what tells the model to ask again. A clicked
   option settles the field but carries no words for the extractor to read,
   so the decision itself has to clear the line. */
test('a field settled by a clicked option is not listed as missing again', () => {
  const kernel = createTaskKernel();
  const pending = {
    kind: 'create_product',
    stage: 'collecting',
    draft: { kind: 'create_product', name: 'كاتل', sellingPrice: 10 },
    answers: [],
  };

  const before = observeMessage(kernel, 'عدل سعر المنتج ده', { pending });
  assert.match(before.card, /Missing: selling_price/);

  pending.answers.push({
    question: 'إيه السعر الجديد؟',
    answer: '50',
    decision: { slot: 'price', kind: 'value', value: '50' },
  });
  const after = observeMessage(kernel, 'عدل سعر المنتج ده', { pending });
  assert.doesNotMatch(after.card, /Missing:/);
});

/* A decline is not an answer. It empties an optional field, but a required one
   stays on the Missing line so the model may ask once more - the card must not
   demand a price nobody will give, and the plan must not be built without one
   either. */
test('a declined required value stays missing', () => {
  const kernel = createTaskKernel();
  const pending = {
    kind: 'create_product',
    stage: 'collecting',
    draft: { kind: 'create_product', name: 'كاتل', sellingPrice: 10 },
    answers: [{
      question: 'إيه السعر؟',
      answer: 'بدون',
      decision: { slot: 'price', kind: 'none', value: '', label: 'بدون' },
    }],
  };

  const after = observeMessage(kernel, 'عدل سعر المنتج ده', { pending });
  assert.match(after.card, /Missing: selling_price/);

  /* And a value that arrives later still clears it. */
  pending.answers.push({
    question: 'إيه السعر؟',
    answer: '50',
    decision: { slot: 'price', kind: 'value', value: '50' },
  });
  const answered = observeMessage(kernel, 'عدل سعر المنتج ده', { pending });
  assert.doesNotMatch(answered.card, /Missing:/);
});

test('an image-only edit asks for a chat attachment, not an attachment id', () => {
  const kernel = createTaskKernel();
  const { card } = observeMessage(kernel, 'غير صورة المنتج', {
    pending: {
      kind: 'create_product',
      stage: 'collecting',
      draft: { kind: 'create_product', name: 'كاتل', sellingPrice: 10 },
      missing: ['cost_price'],
    },
  });

  assert.match(card, /attach the image in the chat/i);
  assert.doesNotMatch(card, /what is the attachment id/i);
});

test('a live stock read is answered from live rows only', () => {
  const kernel = createTaskKernel();
  const { card } = observeMessage(kernel, 'كام مخزون كاتل؟');

  assert.match(card, /Task: read live stock/);
  assert.match(card, /Read the live rows with a read tool in this turn/);
  assert.match(card, /Do not answer from memory or a plan preview/);
});

test('product rows noted from a read tool become the live cache', () => {
  const kernel = createTaskKernel();
  kernel.observe('conversation-1', {
    intent: extractIntent('كام مخزون كاتل؟'),
  });
  const row = product();
  kernel.noteToolCalls('conversation-1', [{
    metadata: { posnic: { kind: 'product_search', query: 'كاتل', results: [row] } },
  }]);

  assert.equal(kernel.liveIsFresh('conversation-1'), true);
  assert.deepEqual(kernel.liveProducts('conversation-1'), [row]);

  const state = kernel.stateFor('conversation-1');
  const card = kernel.taskCard(state);
  assert.match(card, /Live rows \(read 0s ago\)/);
  assert.match(card, /كاتل \| price 100 \| cost 70 \| stock 8/);
});

test('a conversation recall does not become live shop data', () => {
  const kernel = createTaskKernel();
  kernel.noteToolCalls('conversation-1', [{
    metadata: { posnic: { kind: 'conversation_recall', message: 'we talked about كاتل' } },
  }]);

  assert.equal(kernel.liveIsFresh('conversation-1'), false);
  assert.deepEqual(kernel.liveProducts('conversation-1'), []);
});

test('a stale live row is dropped instead of looking current', () => {
  const kernel = createTaskKernel();
  kernel.observe('conversation-1', {
    intent: extractIntent('كام مخزون كاتل؟'),
  });
  kernel.noteToolCalls('conversation-1', [{
    metadata: { posnic: { kind: 'product_search', query: 'كاتل', results: [product()] } },
  }]);
  const state = kernel.stateFor('conversation-1');
  state.live.at = Date.now() - LIVE_FRESH_MS - 1000;

  assert.equal(liveIsFresh(state), false);
  assert.deepEqual(kernel.liveProducts('conversation-1'), []);
  assert.match(kernel.taskCard(state), /stale\. Search again before using a price, stock or count/);
});

test('a plan preview is labelled as not live shop data', () => {
  const kernel = createTaskKernel();
  kernel.notePlan('conversation-1', {
    id: 'plan_1',
    status: 'pending',
    steps: [{ action: 'update_product' }],
  });

  const card = kernel.taskCard(kernel.stateFor('conversation-1'));
  assert.match(card, /Plan preview: plan_1 \(pending\)\. It is not live shop data\./);
});

test('a pending create draft supplies the target name', () => {
  const kernel = createTaskKernel();
  const { card } = observeMessage(kernel, 'edit that product', {
    pending: {
      kind: 'create_product',
      stage: 'collecting',
      draft: { kind: 'create_product', name: 'كاتل', sellingPrice: 10 },
      missing: ['cost_price'],
    },
  });

  assert.match(card, /Target: كاتل/);
  assert.match(card, /Selected: كاتل/);
});

test('count questions tell the model to read live data', () => {
  const kernel = createTaskKernel();
  const { card } = observeMessage(kernel, 'عندنا كام منتج؟');

  assert.match(card, /Task: count live products/);
  assert.match(card, /Do not answer from memory or a plan preview/);
});

test('cardFor renders the conversation state by its id', () => {
  const kernel = createTaskKernel();
  const { state, card } = observeMessage(kernel, 'كام مخزون كاتل؟');

  assert.equal(kernel.cardFor('conversation-1'), card);
  assert.equal(kernel.cardFor('conversation-1'), kernel.taskCard(state));
});

test('a completed plan invalidates the cached live rows', () => {
  const kernel = createTaskKernel();
  kernel.noteToolCalls('conversation-1', [{
    metadata: { posnic: { kind: 'product_search', query: 'كاتل', results: [product()] } },
  }]);
  assert.equal(kernel.liveIsFresh('conversation-1'), true);

  kernel.invalidateLive('conversation-1');
  assert.equal(kernel.liveIsFresh('conversation-1'), false);
  assert.deepEqual(kernel.liveProducts('conversation-1'), []);
});

/*
 * The resolved target belongs to the conversation, not to one turn of it.
 * A search that settles on one row, followed by a turn that only supplies a
 * value, must not turn back into "which product?". Rebuilding the target from
 * the current message alone is what produced a card that listed the live row
 * and asked for the product name at the same time.
 */
test('a target resolved on an earlier turn is not asked for again', () => {
  const kernel = createTaskKernel();

  kernel.observe('conversation-1', {
    intent: { action: 'update_product', query: 'كاتل', requestedFields: ['selling_price'] },
  });
  kernel.noteToolCalls('conversation-1', [{
    metadata: { posnic: { kind: 'product_search', query: 'كاتل', results: [product()] } },
  }]);

  const state = kernel.observe('conversation-1', {
    intent: {
      action: 'update_product',
      requestedFields: ['selling_price'],
      values: { selling_price: 30 },
    },
  });
  const card = kernel.taskCard(state);

  assert.equal(state.target.selected.name, 'كاتل');
  assert.ok(
    !state.missing.includes('product'),
    `the product was already resolved, missing was ${JSON.stringify(state.missing)}`,
  );
  assert.doesNotMatch(card, /Ask for the product name/);
  assert.match(card, /Propose one plan with update_product/);
});

test('a multi-row search is remembered as ambiguous, never as a choice', () => {
  const kernel = createTaskKernel();
  kernel.noteToolCalls('conversation-1', [{
    metadata: {
      posnic: {
        kind: 'product_search',
        query: 'كاتل',
        results: [product(), product({ id: '64b7f0c2a1b2c3d4e5f60020', name: 'كاتل احترافي' })],
      },
    },
  }]);

  const state = kernel.observe('conversation-1', {
    intent: { action: 'update_product', requestedFields: ['selling_price'], values: { selling_price: 30 } },
  });

  assert.equal(state.target.selected, null, 'several matches are not a selection');
  assert.equal(state.target.ambiguous, true, 'the ambiguity must survive the turn');
  assert.ok(state.missing.includes('product'));
  assert.match(kernel.taskCard(state), /Ask for the product name/);
});

test('a new product name replaces the target found earlier', () => {
  const kernel = createTaskKernel();
  kernel.noteToolCalls('conversation-1', [{
    metadata: { posnic: { kind: 'product_search', query: 'كاتل', results: [product()] } },
  }]);

  const state = kernel.observe('conversation-1', {
    intent: { action: 'update_product', query: 'غلاية' },
  });

  assert.equal(state.target.query, 'غلاية');
  assert.equal(state.target.selected, null, 'the previous row must not ride along');
  assert.equal(state.target.ambiguous, false);
});
