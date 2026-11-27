/*
 * Deterministic plan compiler.
 *
 * The model is good at deciding what the user meant. Once the meaning is
 * clear, asking it to write the same plan again is slow and invites a missing
 * target, an extra question or a stale category reference. This module turns a
 * recognised update, stock adjustment or multi-action request into the same
 * validated plan the model would propose.
 *
 * It is intentionally conservative: anything that is not fully known falls
 * back to the model with the task card. It never invents a value, never asks
 * for a record id and never offers price, cost or stock when the user asked
 * for a different field.
 */

'use strict';

const { searchProducts } = require('../tools/search-products');
const { missingProductFields } = require('../local/product-request');
const { validatePlan } = require('../actions/plan-schema');
const { normalizeName } = require('../text-match');

const FIELD_LABELS = {
  selling_price: { ar: 'سعر البيع الجديد', en: 'the new selling price' },
  cost_price: { ar: 'سعر التكلفة الجديد', en: 'the new cost price' },
  stock: { ar: 'الكمية الجديدة', en: 'the new stock quantity' },
  name: { ar: 'الاسم الجديد', en: 'the new name' },
};

const STOCK_MODE_LABELS = {
  set: { ar: 'خلي المخزون', en: 'set stock to' },
  add: { ar: 'زود', en: 'add' },
  subtract: { ar: 'اخصم', en: 'subtract' },
};

function isArabic(value) {
  return /[\u0600-\u06FF]/.test(String(value || ''));
}

function clean(value, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function pickExact(results, query) {
  const wanted = normalizeName(query);
  if (!wanted) return null;
  return (Array.isArray(results) ? results : []).find(
    (item) => normalizeName(item && item.name) === wanted,
  ) || null;
}

function oneOrMany(results, query) {
  const list = Array.isArray(results) ? results : [];
  const exact = pickExact(list, query);
  if (exact) return { kind: 'one', item: exact };
  if (list.length === 1) return { kind: 'one', item: list[0] };
  if (list.length > 1) return { kind: 'many', items: list.slice(0, 3) };
  return { kind: 'none' };
}

function choices(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 3)
    .map((item) => ({
      label: String((item && item.name) || ''),
      value: String((item && item.name) || ''),
    }))
    .filter((choice) => choice.label);
}

function clarify({ question, options = [], missing = [], draft = null, pending = '' }) {
  return {
    kind: 'clarify',
    result: {
      question,
      options,
      missing,
      draft,
      pending,
    },
  };
}

function quote(name, arabic) {
  return arabic ? `«${name}»` : `"${name}"`;
}

async function resolveTarget(api, query) {
  const result = await searchProducts({ query, limit: 8 }, { api });
  if (!result || result.kind === 'error') return { ok: false, error: result };
  return { ok: true, picked: oneOrMany(result.results, query) };
}

async function targetQuestion(intent, { api, arabic, kernel, conversationId, pending }) {
  /* "that product" can still mean the one product the conversation just
     looked at. Use that live row instead of asking again. */
  const known = kernel && typeof kernel.liveProducts === 'function'
    ? kernel.liveProducts(conversationId)
    : [];
  if (!intent.query && !(pending && pending.draft && pending.draft.name) &&
      known.length === 1) {
    return { target: known[0].name };
  }
  const options = choices(known);
  return {
    clarify: clarify({
      question: arabic
        ? 'تحب تعدل أنهي منتج؟ اكتب اسمه أو وصف قصير.'
        : 'Which product do you want to change? Type its name or a short description.',
      options,
      missing: ['product'],
      pending: pending && pending.note ? pending.note : '',
    }),
  };
}

async function resolveOrAsk(query, { api, arabic, pending, kernel, conversationId }) {
  const resolved = await resolveTarget(api, query);
  if (!resolved.ok) return { fallback: true };
  if (resolved.picked.kind === 'one') return { item: resolved.picked.item };
  if (resolved.picked.kind === 'many') {
    return {
      clarify: clarify({
        question: arabic
          ? `في أكتر من منتج قريب من «${query}»: ${resolved.picked.items
            .map((item) => `«${item.name}»`).join('، ')}. أنهي واحد؟`
          : `A few products are close to "${query}": ${resolved.picked.items
            .map((item) => `"${item.name}"`).join(', ')}. Which one?`,
        options: choices(resolved.picked.items),
        missing: ['product'],
        pending: pending && pending.note ? pending.note : '',
      }),
    };
  }
  const known = kernel && typeof kernel.liveProducts === 'function'
    ? kernel.liveProducts(conversationId)
    : [];
  return {
    clarify: clarify({
      question: arabic
        ? `مفيش منتج بالاسم «${query}» في الفرع الحالي. تحب تعدل أنهي منتج؟`
        : `No product named "${query}" exists in the current branch. Which product do you want to change?`,
      options: choices(known),
      missing: ['product'],
      pending: pending && pending.note ? pending.note : '',
    }),
  };
}

async function compileUpdate(intent, {
  api,
  arabic,
  conversationId,
  pending,
  attachments,
  userText,
  memory,
  kernel,
}) {
  const fieldsWanted = (intent.requestedFields || []).filter((field) => field !== 'image');
  const wantsImage = (intent.requestedFields || []).includes('image');

  let targetQuery = clean(intent.query) ||
    clean(pending && pending.draft && pending.draft.name);
  if (!targetQuery) {
    const asked = await targetQuestion(intent, {
      api, arabic, kernel, conversationId, pending,
    });
    if (asked && asked.target) targetQuery = asked.target;
    else if (asked && asked.clarify) return asked;
  }
  if (!targetQuery) return { fallback: true };

  const resolved = await resolveOrAsk(targetQuery, {
    api, arabic, pending, kernel, conversationId,
  });
  if (resolved.fallback) return { fallback: true };
  if (resolved.clarify) return resolved;
  const resolvedItem = resolved.item || null;

  /* A short answer after "what should I change?" may name the field without a
     target. The pending draft name is the safe target; nothing else is. */
  const values = { ...(intent.values || {}) };
  const missingValues = fieldsWanted.filter((field) => values[field] === undefined);
  if (missingValues.length) {
    const labels = missingValues.map((field) => {
      const label = FIELD_LABELS[field];
      return label ? label[arabic ? 'ar' : 'en'] : field;
    });
    return {
      clarify: clarify({
        question: arabic
          ? `تمام. ${labels.join('، ')} كام؟`
          : `Sure. What is ${labels.join(' and ')}?`,
        options: [],
        missing: missingValues,
        pending: pending && pending.note ? pending.note : '',
      }),
    };
  }

  const images = [];
  if (wantsImage) {
    const attached = attachments && typeof attachments.list === 'function'
      ? attachments.list(conversationId)
      : [];
    if (!Array.isArray(attached) || !attached.length) {
      return {
        clarify: clarify({
          question: arabic
            ? `ارفع الصورة في الشات${resolvedItem ? ` لـ ${quote(resolvedItem.name, true)}` : ''} وأنا أضيفها للمنتج.`
            : `Attach the image in the chat${resolvedItem ? ` for ${quote(resolvedItem.name, false)}` : ''} and I will add it to the product.`,
          options: [],
          missing: ['image'],
          pending: pending && pending.note ? pending.note : '',
        }),
      };
    }
    const latest = attached[attached.length - 1];
    images.push({ attachmentId: latest.id, name: latest.name, cover: true });
  }

  if (!fieldsWanted.length && !images.length) {
    return {
      clarify: clarify({
        question: arabic
          ? `تحب تغير إيه في ${resolvedItem ? quote(resolvedItem.name, true) : 'المنتج'}؟`
          : `What do you want to change${resolvedItem ? ` in ${quote(resolvedItem.name, false)}` : ''}?`,
        options: [],
        missing: ['change'],
        pending: pending && pending.note ? pending.note : '',
      }),
    };
  }

  const fields = {};
  for (const field of fieldsWanted) {
    if (values[field] !== undefined) fields[field] = values[field];
  }
  const step = {
    id: 'p1',
    action: 'update_product',
    target: resolvedItem ? resolvedItem.name : targetQuery,
    fields,
  };
  if (images.length) step.images = images;

  const name = resolvedItem ? resolvedItem.name : targetQuery;
  const planInput = {
    title: arabic ? `تعديل ${name}` : `Edit ${name}`,
    summary: arabic
      ? `تعديل ${name}${fieldsWanted.length ? `: ${fieldsWanted.join('، ')}` : ''}${images.length ? ' مع صورة جديدة' : ''}.`
      : `Edit ${name}${fieldsWanted.length ? `: ${fieldsWanted.join(', ')}` : ''}${images.length ? ' with a new image' : ''}.`,
    steps: [step],
  };
  const validated = await validatePlan(planInput, {
    api,
    sessionID: conversationId,
    attachments,
    userText,
    lookups: { knownIds: knownIdsFor(memory, conversationId) },
  });
  if (!validated.ok) return { fallback: true };
  return { plan: validated.plan };
}

async function compileAdjust(intent, {
  api,
  arabic,
  conversationId,
  pending,
  attachments,
  userText,
  memory,
  kernel,
}) {
  const targetQuery = clean(intent.query) ||
    clean(pending && pending.draft && pending.draft.name);
  let resolvedItem = null;
  if (!targetQuery) {
    const asked = await targetQuestion(intent, {
      api, arabic, kernel, conversationId, pending,
    });
    if (asked && asked.clarify) return asked;
    if (asked && asked.target) {
      const resolved = await resolveOrAsk(asked.target, {
        api, arabic, pending, kernel, conversationId,
      });
      if (resolved.item) resolvedItem = resolved.item;
      else if (resolved.clarify) return resolved;
      else return { fallback: true };
    }
  } else {
    const resolved = await resolveOrAsk(targetQuery, {
      api, arabic, pending, kernel, conversationId,
    });
    if (resolved.fallback) return { fallback: true };
    if (resolved.clarify) return resolved;
    resolvedItem = resolved.item;
  }

  const stock = intent.stock || {};
  if (!stock.mode) {
    return {
      clarify: clarify({
        question: arabic
          ? `تحب ${resolvedItem ? `مخزون ${quote(resolvedItem.name, true)}` : 'المخزون'} يزيد ولا يقل؟`
          : `Should the stock${resolvedItem ? ` for ${quote(resolvedItem.name, false)}` : ''} go up or down?`,
        options: [
          { label: arabic ? 'زيادة' : 'Increase', value: arabic ? 'زيادة' : 'increase' },
          { label: arabic ? 'خصم' : 'Decrease', value: arabic ? 'خصم' : 'decrease' },
        ],
        missing: ['mode'],
        pending: pending && pending.note ? pending.note : '',
      }),
    };
  }
  if (stock.quantity === null || stock.quantity === undefined) {
    return {
      clarify: clarify({
        question: arabic ? 'الكمية كام؟' : 'What is the quantity?',
        options: [],
        missing: ['quantity'],
        pending: pending && pending.note ? pending.note : '',
      }),
    };
  }

  const name = resolvedItem ? resolvedItem.name : targetQuery;
  const planInput = {
    title: arabic ? `تعديل مخزون ${name}` : `Adjust stock for ${name}`,
    summary: arabic
      ? `${STOCK_MODE_LABELS[stock.mode].ar} ${stock.quantity} من ${name}.`
      : `${STOCK_MODE_LABELS[stock.mode].en} ${stock.quantity} for ${name}.`,
    steps: [{
      id: 's1',
      action: 'adjust_stock',
      target: name,
      fields: {
        stock_mode: stock.mode,
        stock_quantity: stock.quantity,
        reason: stock.reason || (stock.mode === 'set' ? 'Inventory count' : stock.mode === 'add' ? 'Stock found' : 'Loss'),
      },
    }],
  };
  const validated = await validatePlan(planInput, {
    api,
    sessionID: conversationId,
    attachments,
    userText,
    lookups: { knownIds: knownIdsFor(memory, conversationId) },
  });
  if (!validated.ok) return { fallback: true };
  return { plan: validated.plan };
}

async function compileCreateCategory(intent, {
  api, arabic, conversationId, attachments, userText,
}) {
  const name = clean(intent.category && intent.category.name);
  if (!name) {
    return {
      clarify: clarify({
        question: arabic ? 'اسم الفئة الجديدة إيه؟' : 'What should the new category be called?',
        missing: ['category name'],
      }),
    };
  }
  const planInput = {
    title: arabic ? `إنشاء فئة ${name}` : `Create category ${name}`,
    summary: arabic ? `إضافة فئة «${name}».` : `Add the category "${name}".`,
    steps: [{ id: 'c1', action: 'create_category', fields: { name } }],
  };
  const validated = await validatePlan(planInput, {
    api,
    sessionID: conversationId,
    attachments,
    userText,
  });
  if (!validated.ok) return { fallback: true };
  return { plan: validated.plan };
}

/* The allow-list for raw id targets: the same interface on both paths, ids
   this conversation has seen. The compiler normally targets a name it just
   resolved, but an id that arrives in a field must pass the same test the
   assistant's plan does. */
function knownIdsFor(memory, conversationId) {
  return memory && typeof memory.knownIds === 'function'
    ? memory.knownIds(conversationId)
    : null;
}

function currentCategoryFor(pending, memory, conversationId) {
  if (pending && pending.category && pending.category.name) {
    return { id: pending.category.id || '', name: pending.category.name };
  }
  if (memory && typeof memory.currentCategory === 'function') {
    const current = memory.currentCategory(conversationId);
    if (current && current.name) return { id: current.id || '', name: current.name };
  }
  return null;
}

function productStepFromDraft(step, index, {
  pending, memory, conversationId,
}) {
  const draft = step.draft;
  if (!draft || missingProductFields(draft).length) return null;
  const category = currentCategoryFor(pending, memory, conversationId);
  const fields = {
    name: draft.name,
    selling_price: draft.sellingPrice,
    cost_price: draft.costPrice,
    opening_stock: draft.openingStock,
    category_id: '',
    category_name: '',
  };
  let categoryStep = null;

  if (draft.categoryChoice === 'create' && draft.categoryName) {
    const categoryId = `cat${index}`;
    categoryStep = {
      id: categoryId,
      action: 'create_category',
      fields: { name: draft.categoryName },
    };
    fields.category_id = { step: categoryId, field: 'id' };
    fields.category_name = { step: categoryId, field: 'name' };
  } else if (draft.categoryChoice === 'same') {
    if (!category) return { needCategory: true };
    fields.category_id = category.id;
    fields.category_name = category.name;
  } else if (draft.categoryChoice === 'named' && draft.categoryName) {
    fields.category_name = draft.categoryName;
  } else if (draft.categoryChoice === 'uncategorized') {
    /* leave both empty */
  } else if (category) {
    fields.category_id = category.id;
    fields.category_name = category.name;
  }
  return {
    categoryStep,
    step: {
      id: `p${index}`,
      action: 'create_product',
      fields,
    },
  };
}

function multiPlanText(steps, arabic) {
  const parts = steps.map((step) => {
    if (step.action === 'adjust_stock') {
      return arabic
        ? `${STOCK_MODE_LABELS[step.fields.stock_mode].ar} ${step.fields.stock_quantity} من ${step.target}`
        : `${STOCK_MODE_LABELS[step.fields.stock_mode].en} ${step.fields.stock_quantity} for ${step.target}`;
    }
    if (step.action === 'create_product') {
      return arabic ? `إضافة ${step.fields.name}` : `Add ${step.fields.name}`;
    }
    if (step.action === 'create_category') {
      return arabic ? `إنشاء فئة ${step.fields.name}` : `Create category ${step.fields.name}`;
    }
    return step.action;
  });
  return parts.join(arabic ? '، ' : ', ');
}

async function compileMulti(intent, {
  api,
  arabic,
  conversationId,
  pending,
  attachments,
  userText,
  memory,
  kernel,
}) {
  const rawSteps = Array.isArray(intent.steps) ? intent.steps : [];
  if (!rawSteps.length) return { fallback: true };

  const planSteps = [];
  let index = 0;
  for (const raw of rawSteps) {
    index += 1;
    if (raw.action === 'adjust_stock') {
      const targetQuery = clean(raw.query) ||
        clean(pending && pending.draft && pending.draft.name);
      if (!targetQuery) {
        return {
          clarify: clarify({
            question: arabic
              ? 'تحب تعدل مخزون أنهي منتج؟ اكتب اسمه.'
              : 'Which product stock should I change? Type its name.',
            options: choices(kernel && kernel.liveProducts(conversationId)),
            missing: ['product'],
          }),
        };
      }
      const resolved = await resolveOrAsk(targetQuery, {
        api, arabic, pending, kernel, conversationId,
      });
      if (resolved.fallback) return { fallback: true };
      if (resolved.clarify) return resolved;
      if (!raw.stock || !raw.stock.mode || raw.stock.quantity === null ||
          raw.stock.quantity === undefined) {
        return {
          clarify: clarify({
            question: arabic
              ? 'كمية تعديل المخزون كام، وهل زيادة ولا خصم؟'
              : 'What stock quantity and direction should I use?',
            missing: ['quantity'],
          }),
        };
      }
      planSteps.push({
        id: `s${index}`,
        action: 'adjust_stock',
        target: resolved.item.name,
        fields: {
          stock_mode: raw.stock.mode,
          stock_quantity: raw.stock.quantity,
          reason: raw.stock.reason || (raw.stock.mode === 'set'
            ? 'Inventory count'
            : raw.stock.mode === 'add' ? 'Stock found' : 'Loss'),
        },
      });
      continue;
    }

    if (raw.action === 'create_product') {
      const compiled = productStepFromDraft(raw, index, {
        pending, memory, conversationId,
      });
      if (!compiled) return { fallback: true };
      if (compiled.needCategory) {
        return {
          clarify: clarify({
            question: arabic
              ? 'تحب أضيفه في أنهي فئة؟'
              : 'Which category should it go in?',
            missing: ['category'],
          }),
        };
      }
      if (compiled.categoryStep) planSteps.push(compiled.categoryStep);
      planSteps.push(compiled.step);
      continue;
    }

    if (raw.action === 'create_category') {
      const name = clean(raw.category && raw.category.name);
      if (!name) {
        return {
          clarify: clarify({
            question: arabic ? 'اسم الفئة الجديدة إيه؟' : 'What should the new category be called?',
            missing: ['category name'],
          }),
        };
      }
      planSteps.push({ id: `c${index}`, action: 'create_category', fields: { name } });
      continue;
    }

    /* An action this compiler does not build yet goes back to the model. */
    return { fallback: true };
  }

  if (!planSteps.length) return { fallback: true };
  const current = currentCategoryFor(pending, memory, conversationId);
  const planInput = {
    title: arabic ? `${planSteps.length} خطوات` : `${planSteps.length} changes`,
    summary: multiPlanText(planSteps, arabic),
    steps: planSteps,
  };
  const validated = await validatePlan(planInput, {
    api,
    sessionID: conversationId,
    attachments,
    userText,
    lookups: { currentCategory: current, knownIds: knownIdsFor(memory, conversationId) },
  });
  if (!validated.ok) return { fallback: true };
  return { plan: validated.plan };
}

async function runCompiler({
  intent,
  message,
  api,
  conversationId = '',
  memory = null,
  attachments = null,
  pending = null,
  kernel = null,
  currencySign = '',
} = {}) {
  const action = String((intent && intent.action) || '');
  if (!api || typeof api.get !== 'function') return null;
  if (!intent || intent.confidence === 'low') return null;
  if (!['update_product', 'adjust_stock', 'multi', 'create_category', 'bulk_create'].includes(action)) {
    return null;
  }
  /* Stock is adjusted through its own action, never through a product edit.
     A mixed sentence belongs to the model. */
  if (action === 'update_product' &&
      (intent.requestedFields || []).includes('stock')) {
    return null;
  }

  const arabic = isArabic(message);
  const userText = memory && typeof memory.userTextFor === 'function'
    ? memory.userTextFor(conversationId)
    : String(message || '');
  const common = {
    api,
    arabic,
    conversationId,
    pending,
    attachments,
    userText,
    memory,
    kernel,
  };

  if (action === 'bulk_create') {
    return {
      handled: false,
      context: {
        operation: 'bulk_create',
        reason: 'needs_input',
        instruction: 'The user asked to create several products. Ask for the details in your own words, in their language; do not paste a fixed message.',
        options: [],
        missing: ['product details'],
        draft: null,
      },
    };
  }

  let result;
  try {
    if (action === 'update_product') result = await compileUpdate(intent, common);
    else if (action === 'adjust_stock') result = await compileAdjust(intent, common);
    else if (action === 'create_category') result = await compileCreateCategory(intent, common);
    else result = await compileMulti(intent, common);
  } catch (error) {
    return null;
  }
  if (!result || result.fallback) return null;
  if (result.clarify) {
    /* A question is not a plan. Hand the parsed target, options and missing
       values to the model so it asks naturally instead of reciting a local
       template. Complete plans still stay on the deterministic fast path. */
    const detail = result.clarify.result || {};
    return {
      handled: false,
      context: {
        operation: action,
        reason: 'needs_input',
        instruction: 'The local compiler could not finish. Ask the user in your own words, in their language; do not paste a fixed question. Use the options, draft and missing list as hints.',
        options: Array.isArray(detail.options) ? detail.options : [],
        missing: Array.isArray(detail.missing) ? detail.missing : [],
        draft: detail.draft || null,
        ...(detail.pending ? { pending: detail.pending } : {}),
      },
    };
  }
  if (result.plan) return { handled: true, kind: 'plan', plan: result.plan };
  return null;
}

module.exports = {
  runCompiler,
};
