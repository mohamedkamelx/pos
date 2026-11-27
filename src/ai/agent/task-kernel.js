/*
 * One compact task state per conversation.
 *
 * The model is good at language and judgement. It is not a reliable place to
 * keep "which product, which fields, which values, which step comes next".
 * This kernel keeps that state, renders a short Task Card for the prompt and
 * decides the next action policy. It does not script the conversation: the
 * model can still choose a tool and handle an unusual request.
 *
 * Live shop data is kept separately from remembered data. A plan preview is
 * never live data, and a cached row is labelled with its age so the model
 * cannot answer a stock question from a preview.
 */

'use strict';

const { missingProductFields } = require('../local/product-request');
const { slotFromFields } = require('../ask-slots');

const LIVE_FRESH_MS = 120000;

function clean(value, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function normaliseAction(value) {
  return clean(value, 40) || 'unknown';
}

function actionLabel(action) {
  switch (action) {
    case 'read_stock': return 'read live stock';
    case 'read_price': return 'read the live price';
    case 'read_count': return 'count live products';
    case 'read_profit': return 'find the most profitable product from live rows';
    case 'list_products': return 'list live products';
    case 'create_product': return 'create a product';
    case 'bulk_create': return 'create several products';
    case 'update_product': return 'edit a product';
    case 'adjust_stock': return 'adjust stock';
    case 'create_category': return 'create a category';
    case 'multi': return 'complete several actions in order';
    case 'help': return 'answer a how-to question';
    default: return 'understand the request';
  }
}

function stateFor(store, conversationId) {
  const key = clean(conversationId, 100) || 'default';
  let state = store.get(key);
  if (!state) {
    state = {
      conversationId: key,
      at: 0,
      intent: 'unknown',
      steps: [],
      target: { query: '', selected: null, ambiguous: false },
      requestedFields: [],
      collected: {},
      missing: [],
      currentCategory: null,
      live: { at: 0, products: [], reads: [] },
      plan: null,
      lastQuestion: '',
      turn: {},
    };
    store.set(key, state);
  }
  return state;
}

function requestedValueLabels(intent) {
  const fields = Array.isArray(intent.requestedFields) ? intent.requestedFields : [];
  return fields.filter((field) => field !== 'image');
}

/* A field a settled decision already supplies is not missing. The card's
   "Missing:" line is what tells the model to ask again, and a click carries
   no words for the extractor to read - so without this the operator answers
   a price button and the next card still demands the price. The slot
   vocabulary is the same one the card's options are built from, so a decided
   price is a decided price here too. */
/* An optional field the operator declined is settled-empty; a required one is
   not. "No image" ends the image question for good, while a declined price
   still has to be asked for - the card must not demand a price nobody will
   give, and the plan must not be built without one either. */
const OPTIONAL_SLOTS = new Set(['image']);

function missingFor(intent, pending, target) {
  const answers = pending && Array.isArray(pending.answers) ? pending.answers : [];
  const decided = new Map();
  for (const item of answers) {
    const decision = item && item.decision;
    if (decision && decision.slot) decided.set(decision.slot, decision.kind);
  }
  return missingFields(intent, pending, target).filter((entry) => {
    const slot = slotFromFields([entry]);
    if (!slot || !decided.has(slot)) return true;
    if (decided.get(slot) === 'none') return !OPTIONAL_SLOTS.has(slot);
    return false;
  });
}

function missingFields(intent, pending, target) {
  const action = normaliseAction(intent.action);
  /* The record may have been settled on an earlier turn. Reading only the
     current message would ask for a product the conversation already found,
     which is how the card ended up listing the live row and demanding the
     product name in the same breath. */
  const resolved = target || {};
  const targetKnown = !!(
    (typeof resolved.query === 'string' && resolved.query.trim()) ||
    resolved.selected ||
    intent.query ||
    (pending && pending.draft && pending.draft.name)
  );
  if (action === 'update_product') {
    const missing = [];
    if (!targetKnown) missing.push('product');
    const fields = requestedValueLabels(intent);
    if (!fields.length && !(intent.requestedFields || []).length) missing.push('change');
    const values = intent.values || {};
    for (const field of fields) {
      if (values[field] === undefined || values[field] === null) {
        missing.push(field);
      }
    }
    return missing;
  }
  if (action === 'adjust_stock') {
    const missing = [];
    if (!targetKnown) missing.push('product');
    if (!intent.stock || !intent.stock.mode) missing.push('mode');
    if (!intent.stock || intent.stock.quantity === null || intent.stock.quantity === undefined) {
      missing.push('quantity');
    }
    return missing;
  }
  if (action === 'bulk_create') {
    return ['product details'];
  }
  if (action === 'create_product') {
    const draft = intent.draft || (pending && pending.draft) || null;
    const missing = draft ? missingProductFields(draft) : ['product details'];
    if (intent.newCategory && !(intent.category && intent.category.name)) {
      missing.push('category name');
    }
    return missing;
  }
  if (action === 'create_category') {
    return intent.category && intent.category.name ? [] : ['category name'];
  }
  if (action === 'multi') {
    return (intent.steps || []).flatMap((step) => missingFor(step, pending, target));
  }
  return [];
}

function liveAgeOf(live) {
  if (!live || !live.at) return null;
  return Math.max(0, Date.now() - live.at);
}

function liveAge(state) {
  return liveAgeOf(state && state.live);
}

function liveCacheIsFresh(live, maxAgeMs = LIVE_FRESH_MS) {
  const age = liveAgeOf(live);
  return age !== null && age <= maxAgeMs;
}

function liveIsFresh(state, maxAgeMs = LIVE_FRESH_MS) {
  return liveCacheIsFresh(state && state.live, maxAgeMs);
}

function productLine(item) {
  const parts = [];
  if (item.name) parts.push(item.name);
  if (Number.isFinite(Number(item.sellingPrice))) parts.push(`price ${item.sellingPrice}`);
  if (Number.isFinite(Number(item.costPrice))) parts.push(`cost ${item.costPrice}`);
  if (Number.isFinite(Number(item.stock))) parts.push(`stock ${item.stock}`);
  if (item.category) parts.push(`category ${item.category}`);
  return parts.join(' | ');
}

function nextActionFor(state) {
  const intent = state.intent;
  switch (intent) {
    case 'read_stock':
    case 'read_price':
    case 'read_count':
    case 'read_profit':
    case 'list_products':
      return 'Read the live rows with a read tool in this turn, then answer from those rows only. Do not answer from memory or a plan preview.';
    case 'update_product':
      if (state.missing.includes('product')) {
        return 'Ask for the product name or a short description, then search. Do not ask for an id, price, cost or stock.';
      }
      if (state.missing.includes('change')) {
        return 'Ask what the user wants to change. Do not offer or ask for price, cost or stock unless the user asked for them.';
      }
      if ((state.requestedFields || []).includes('image') && !state.missing.some((field) => field !== 'product')) {
        return 'Ask the user to attach the image in the chat. Never ask for an attachment id.';
      }
      if (state.missing.length) {
        return `Ask once for the missing value(s): ${state.missing.join(', ')}. Keep every value the user already gave.`;
      }
      return 'Propose one plan with update_product containing only the requested fields.';
    case 'adjust_stock':
      if (state.missing.includes('product')) {
        return 'Ask for the product name or description, then search. Do not ask for an id, price or cost.';
      }
      if (state.missing.includes('quantity')) {
        return 'Ask for the quantity to change.';
      }
      return 'Propose one plan with adjust_stock, the live product name as target, the mode and the quantity.';
    case 'create_product':
    case 'bulk_create':
      if (state.missing.length) {
        return 'Ask once, in one question, for the missing product values. Keep the values the user already gave.';
      }
      return 'Propose one plan with the product steps. Use the current category when the user said to use it.';
    case 'create_category':
      return 'Propose one plan with create_category and the category name.';
    case 'multi':
      return 'Propose one plan with the actions in order; later steps may reference earlier step ids.';
    case 'help':
      return 'Call posnic_help and answer with the exact path or control.';
    default:
      return 'Continue the request. Search live data before answering a price, stock or count question.';
  }
}

function doNotAskFor(state) {
  const forbidden = new Set(['product id', 'item id', 'record id', 'category id', 'attachment id']);
  if (state.intent === 'update_product') {
    const requested = new Set(state.requestedFields || []);
    if (!requested.has('selling_price')) forbidden.add('selling price');
    if (!requested.has('cost_price')) forbidden.add('cost price');
    if (!requested.has('stock')) forbidden.add('stock');
    if (!requested.has('image')) forbidden.add('image');
  }
  if (state.intent === 'adjust_stock') {
    forbidden.add('selling price');
    forbidden.add('cost price');
  }
  return [...forbidden];
}

function taskCard(state) {
  if (!state || (state.intent === 'unknown' && !state.plan)) return '';
  const lines = ['[Task card]', `Task: ${actionLabel(state.intent)}`];
  if (state.target.query) lines.push(`Target: ${state.target.query}`);
  if (state.target.selected && state.target.selected.name) {
    lines.push(`Selected: ${state.target.selected.name}`);
  }
  if (state.currentCategory && state.currentCategory.name) {
    lines.push(`Current category: ${state.currentCategory.name}`);
  }
  if (state.requestedFields && state.requestedFields.length) {
    lines.push(`Requested fields: ${state.requestedFields.join(', ')}`);
  }
  if (state.collected && Object.keys(state.collected).length) {
    lines.push(`Collected: ${JSON.stringify(state.collected).slice(0, 500)}`);
  }
  if (state.missing.length) lines.push(`Missing: ${state.missing.join(', ')}`);
  if (state.plan) {
    lines.push(`Plan preview: ${state.plan.id || 'prepared'} (${state.plan.status || 'pending'}). It is not live shop data.`);
  }
  const age = liveAge(state);
  if (age !== null && state.live.products.length) {
    if (age <= LIVE_FRESH_MS) {
      lines.push(`Live rows (read ${Math.round(age / 1000)}s ago):`);
      for (const item of state.live.products.slice(0, 6)) lines.push(`- ${productLine(item)}`);
    } else {
      lines.push('Live rows from an earlier turn are stale. Search again before using a price, stock or count.');
    }
  }
  lines.push(`Next: ${nextActionFor(state)}`);
  const forbidden = doNotAskFor(state);
  if (forbidden.length) lines.push(`Never ask for: ${forbidden.join(', ')}.`);
  lines.push('[End task card]');
  const text = lines.join('\n');
  return text.length > 1800 ? `${text.slice(0, 1780)}...\n[End task card]` : text;
}

function createTaskKernel() {
  const store = new Map();

  function observe(conversationId, {
    intent = null,
    pending = null,
    memory = null,
    turn = null,
  } = {}) {
    const state = stateFor(store, conversationId);
    const previousLive = state.live;
    state.at = Date.now();
    state.intent = normaliseAction(intent && intent.action);
    state.steps = Array.isArray(intent && intent.steps) ? intent.steps : [];
    state.requestedFields = Array.isArray(intent && intent.requestedFields)
      ? intent.requestedFields.slice()
      : [];
    state.collected = intent && intent.values ? { ...intent.values } : {};
    state.turn = {
      writeRequest: !!(turn && turn.writeRequest),
      pendingAnswer: !!(turn && turn.pendingAnswer),
      sideQuestion: !!(turn && turn.sideQuestion),
    };
    const current = memory && typeof memory.currentCategory === 'function'
      ? memory.currentCategory(conversationId)
      : null;
    state.currentCategory = current && current.name ? current : null;

    /* The previous turn's resolution. It must be read before it is rebuilt. */
    const previousTarget = state.target || {};
    let query = clean(intent && intent.query, 200);
    let selected = null;
    let ambiguous = false;
    if (!query && pending && pending.draft && pending.draft.name) {
      query = clean(pending.draft.name, 200);
      selected = { name: query, id: '' };
    }
    if (!query && pending && pending.category && pending.category.name && intent && intent.action === 'create_product') {
      /* The product search result is not in the compact pending note; the
         model will search the live row. Kept empty on purpose. */
      query = '';
    }
    if (!query && !selected) {
      /* This turn named nothing, so the record settled earlier still stands:
         the value just arrived without repeating the product name. A search
         that matched several rows stays unresolved, because carrying one of
         them forward would be inventing a choice. */
      query = clean(previousTarget.query, 200);
      selected = previousTarget.selected && previousTarget.selected.name
        ? previousTarget.selected
        : null;
      ambiguous = !!previousTarget.ambiguous;
    }
    state.target = { query, selected, ambiguous };
    state.missing = missingFor(
      state.steps.length > 1 ? intent : (intent || {}),
      pending,
      state.target,
    );
    state.lastQuestion = pending && pending.question ? pending.question : '';
    if (pending && pending.category && pending.category.name) {
      state.currentCategory = {
        id: pending.category.id || '',
        name: pending.category.name,
      };
    }
    if (pending && pending.draft && pending.draft.kind === 'create_product') {
      state.collected = {
        ...state.collected,
        name: pending.draft.name,
        selling_price: pending.draft.sellingPrice,
        cost_price: pending.draft.costPrice,
        opening_stock: pending.draft.openingStock,
      };
    }
    /* A cache older than the freshness window is not live data. Dropping it
       forces a read instead of letting a stale number look current. */
    if (!liveCacheIsFresh(previousLive)) {
      state.live = { at: 0, products: [], reads: [] };
    }
    return state;
  }

  function noteToolCalls(conversationId, toolCalls) {
    const state = stateFor(store, conversationId);
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    for (const call of calls) {
      const result = call && call.metadata && call.metadata.posnic;
      if (!result) continue;
      if (result.kind === 'product_search' || result.kind === 'product_list') {
        const rows = Array.isArray(result.results) ? result.results : [];
        state.live.at = Date.now();
        state.live.products = rows.slice(0, 20);
        state.live.reads.push({ kind: result.kind, query: result.query || '', at: state.live.at });
        if (rows.length === 1) {
          state.target.selected = {
            id: String(rows[0].id || ''),
            name: String(rows[0].name || ''),
          };
          state.target.query = state.target.selected.name;
        }
        if (rows.length > 1) state.target.ambiguous = true;
      }
      if (result.kind === 'conversation_recall') {
        /* Recall is memory, not shop data. It never refreshes live rows. */
        state.live.reads.push({ kind: 'recall', at: Date.now(), memory: true });
      }
      if (result.kind === 'write_plan' && result.plan) {
        state.plan = {
          id: result.plan.id,
          status: result.plan.status || 'pending',
          steps: Array.isArray(result.plan.steps) ? result.plan.steps : [],
        };
      }
      if (result.kind === 'clarify') {
        state.lastQuestion = result.question || '';
      }
    }
    return state;
  }

  function notePlan(conversationId, plan, status) {
    const state = stateFor(store, conversationId);
    if (plan) {
      state.plan = {
        id: plan.id,
        status: status || plan.status || 'pending',
        steps: Array.isArray(plan.steps) ? plan.steps : [],
      };
    }
    return state;
  }

  function liveProducts(conversationId) {
    const state = stateFor(store, conversationId);
    return liveIsFresh(state) ? state.live.products.slice() : [];
  }

  function invalidateLive(conversationId) {
    const state = stateFor(store, conversationId);
    state.live = { at: 0, products: [], reads: [] };
    return state;
  }

  function reset(conversationId) {
    if (conversationId) store.delete(clean(conversationId, 100));
    else store.clear();
  }

  return {
    cardFor: (conversationId) => taskCard(stateFor(store, conversationId)),
    invalidateLive,
    liveIsFresh: (conversationId) => liveIsFresh(stateFor(store, conversationId)),
    liveProducts,
    notePlan,
    noteToolCalls,
    observe,
    reset,
    stateFor: (conversationId) => stateFor(store, conversationId),
    taskCard,
  };
}

module.exports = {
  LIVE_FRESH_MS,
  actionLabel,
  createTaskKernel,
  liveIsFresh,
  taskCard,
};
