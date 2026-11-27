/*
 * Validation and normalisation for assistant write plans.
 *
 * The model never receives a create or update tool. It can only propose an
 * ordered plan, and this module decides whether that plan is complete and
 * safe enough to show to the user. The main process still executes every step
 * with the user's own JWT and branch, so the API remains the final authority.
 */

'use strict';

const crypto = require('crypto');
const { normalizeCurrencyText } = require('../currency');
const {
  correctCommonSpelling,
  nameSimilarity,
  rankNameMatches,
  scoreNameMatch,
} = require('../text-match');

const MAX_STEPS = 20;
const MAX_IMAGES = 8;

const ACTIONS = {
  create_category: {
    label: 'Create category',
    permission: 'category.write',
    target: false,
    fields: ['name', 'description'],
    resultFields: ['id', 'name'],
  },
  update_category: {
    label: 'Update category',
    permission: 'category.write',
    target: true,
    fields: ['name', 'description', 'is_active'],
    resultFields: ['id', 'name'],
  },
  create_product: {
    label: 'Create product',
    permission: 'item.write',
    target: false,
    fields: [
      'name',
      'selling_price',
      'cost_price',
      'mrp_price',
      'opening_stock',
      'inventory',
      'negative_stock',
      'item_kind',
      'category_id',
      'category_name',
      'barcode',
      'sku',
      'description',
      'unit',
    ],
    resultFields: ['id', 'name'],
  },
  update_product: {
    label: 'Update product',
    permission: 'item.write',
    target: true,
    fields: [
      'name',
      'selling_price',
      'cost_price',
      'mrp_price',
      'inventory',
      'negative_stock',
      'item_kind',
      'category_id',
      'category_name',
      'barcode',
      'sku',
      'description',
      'unit',
    ],
    resultFields: ['id', 'name'],
  },
  adjust_stock: {
    label: 'Adjust stock',
    permission: 'item.write',
    target: true,
    fields: ['stock_mode', 'stock_quantity', 'reason', 'note'],
    resultFields: ['id', 'name'],
  },
};

const PRODUCT_ACTIONS = new Set(['create_product', 'update_product']);
const SHARED_FIELDS = new Set([
  'category_id',
  'category_name',
  'inventory',
  'negative_stock',
  'item_kind',
  'unit',
]);

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function normaliseName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokenCount(value) {
  return normaliseName(value).split(' ').filter(Boolean).length;
}

/* A create-category step that a later step uses may be a misspelling of an
   existing category. Reusing it is safer than creating a duplicate, but a
   standalone create-category request must still report the duplicate. */
function laterStepUsesCategory(rawSteps, index, stepID, categoryName) {
  for (let laterIndex = index + 1; laterIndex < rawSteps.length; laterIndex += 1) {
    const later = rawSteps[laterIndex];
    if (!isObject(later)) continue;
    if (Array.isArray(later.dependsOn) &&
        later.dependsOn.some((dep) => cleanText(dep, 40) === stepID)) {
      return true;
    }
    const fields = isObject(later.fields) ? later.fields : {};
    for (const value of Object.values(fields)) {
      if (isRef(value) && value.step === stepID) return true;
    }
    if ((later.action === 'create_product' || later.action === 'update_product') &&
        typeof fields.category_name === 'string' &&
        normaliseName(fields.category_name) === normaliseName(categoryName)) {
      return true;
    }
  }
  return false;
}

function hasExplicitPriceZero(text) {
  const source = String(text || '');
  if (/(?:ببلاش|مجانا|مجاناً|مجاني|free)\b/i.test(source)) return true;
  return /(?:سعر|بيع|تكلفة|تجزئة|price|cost|retail)[^\n]{0,24}(?:0|٠|صفر|مجان|free)/i.test(source) ||
    /(?:0|٠|صفر|مجان|free)[^\n]{0,24}(?:سعر|بيع|تكلفة|تجزئة|price|cost|retail)/i.test(source);
}

function hasSamePriceReference(text) {
  return /(?:same price|same cost|نفس السعر|نفس سعر|نفس التكلفة|نفس تكلفة|زي السعر|زى السعر|السعر السابق|سعر السابق)/i.test(String(text || ''));
}

function explicitNoCategory(text) {
  return /(?:بدون\s*(?:فئة|تصنيف|قسم)|من\s*غير\s*(?:فئة|تصنيف|قسم)|no\s+category|without\s+(?:a\s+)?category|uncategorized)/i.test(String(text || ''));
}

function mentionsRetailPrice(text) {
  return /(?:سعر\s*(?:ال)?تجزئة|التجزئة|تجزئة|retail(?:\s*price)?|\bmrp\b)/i.test(String(text || ''));
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRef(value) {
  if (isObject(value) && typeof value.step === 'string') return true;
  return typeof value === 'string' && /^@[a-z0-9_-]+(?:\.[a-z0-9_]+)?$/i.test(value.trim());
}

function parseRef(value) {
  if (isObject(value)) {
    return {
      step: cleanText(value.step, 40),
      field: cleanText(value.field, 20) || 'id',
    };
  }
  const text = String(value || '').trim();
  const match = /^@([a-z0-9_-]+)(?:\.([a-z0-9_]+))?$/i.exec(text);
  return match ? { step: match[1], field: match[2] || 'id' } : null;
}

function number(value, { min = 0, max = 1000000000 } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return null;
  let text;
  if (typeof value === 'number') {
    text = String(value);
  } else if (typeof value === 'string') {
    /* Models naturally repeat the currency from the user's sentence
       ("$ 500", "١٠٠ جنيه"). Accept that spelling, then keep only the
       number; a value that is not a single amount still fails. */
    text = value
      .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
      .replace(/(?:جنيه|جنية|ج\.?\s*م\.?)/g, '')
      .replace(/[₹$€£¥]/g, '')
      .replace(/[،,٬\s]/g, '')
      .replace(/٫/g, '.')
      .trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  } else {
    return null;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return Math.round(parsed * 100) / 100;
}

function boolean(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

function id(value) {
  const text = cleanText(value, 80);
  return /^[a-f0-9]{24}$/i.test(text) ? text : '';
}

function error(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

function dataList(payload) {
  const data = payload && payload.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  if (payload && Array.isArray(payload.list)) return payload.list;
  return [];
}

function itemName(item) {
  return cleanText(item && item.name, 200);
}

function itemBarcode(item) {
  return cleanText(item && (item.barcode_id || item.barcode), 120);
}

function itemSku(item) {
  return cleanText(item && (item.sku || item.sku_id || item.itemid), 120);
}

function beforeProduct(item) {
  return {
    id: String((item && (item.id || item._id)) || ''),
    name: itemName(item),
    sellingPrice: Number(item && item.selling_price) || 0,
    costPrice: Number(item && item.company_price) || 0,
    stock: Number(item && item.available_quantity) || 0,
    category: cleanText(item && item.category_name, 160),
    barcode: itemBarcode(item),
    sku: itemSku(item),
    unit: cleanText(item && item.unit, 40),
    trackInventory: !!(item && item.track_inventory),
    negativeStock: !!(item && item.negative_stock),
    itemKind: item && item.item_kind === 'service' ? 'service' : 'product',
    images: Array.isArray(item && item.multi_image) ? item.multi_image.length : 0,
  };
}

function beforeCategory(item) {
  return {
    id: String((item && (item.id || item._id)) || ''),
    name: cleanText(item && item.name, 200),
    description: cleanText(item && item.description, 1000),
    active: !(item && item.is_active === false),
  };
}

async function findCategoriesByName(api, name) {
  const payload = await api.get('categories', { search: name, limit: 50, status: 'active' });
  const ranked = rankNameMatches(name, dataList(payload), (row) => row && row.name);
  const exact = ranked.filter((entry) => entry.score === 1);
  return (exact.length ? exact : ranked).slice(0, 8).map((entry) => entry.item);
}

async function findCategoryByName(api, name) {
  const matches = await findCategoriesByName(api, name);
  return matches[0] || null;
}

/* The local product flow has already loaded the category list and searched
   for the product. Reuse those answers instead of asking the API the same
   questions again while validating its plan. */
function categoryFromList(categories, name) {
  const list = Array.isArray(categories) ? categories : [];
  const ranked = rankNameMatches(name, list, (row) => row && row.name);
  return (ranked[0] && ranked[0].item) || null;
}

function categoriesFromList(categories, name) {
  const list = Array.isArray(categories) ? categories : [];
  return rankNameMatches(name, list, (row) => row && row.name)
    .slice(0, 8)
    .map((entry) => entry.item);
}

function categoryById(categories, id) {
  const wanted = String(id || '');
  if (!wanted) return null;
  return (Array.isArray(categories) ? categories : []).find((category) =>
    String((category && (category.id || category._id)) || '') === wanted) || null;
}

async function lookupCategoryByName(api, name, preloadedCategories, categoriesComplete) {
  if (preloadedCategories) {
    const existing = categoryFromList(preloadedCategories, name);
    if (existing) return existing;
    if (categoriesComplete) return null;
  }
  return findCategoryByName(api, name);
}

async function lookupCategoriesByName(api, name, preloadedCategories, categoriesComplete) {
  if (!preloadedCategories) return findCategoriesByName(api, name);
  const local = categoriesFromList(preloadedCategories, name);
  if (categoriesComplete) return local;
  const remote = await findCategoriesByName(api, name);
  const seen = new Set(local.map((row) => String((row && (row.id || row._id)) || '')));
  return local
    .concat(remote.filter((row) => !seen.has(String((row && (row.id || row._id)) || ''))))
    .slice(0, 8);
}

async function lookupCategoryById(api, id, preloadedCategories, categoriesComplete) {
  if (preloadedCategories) {
    const existing = categoryById(preloadedCategories, id);
    if (existing) return existing;
    if (categoriesComplete) return null;
  }
  return fetchCategory(api, id);
}

async function findProduct(api, query) {
  const payload = await api.get('items/search', { q: query, limit: 20 });
  return dataList(payload);
}

async function resolveProductTarget(api, text) {
  const matches = await findProduct(api, text);
  const wanted = normaliseName(text);
  const code = String(text || '').trim().toLowerCase();
  const exact = matches.filter((item) => {
    if (normaliseName(itemName(item)) === wanted) return true;
    if (!code) return false;
    return String(itemBarcode(item)).trim().toLowerCase() === code ||
      String(itemSku(item)).trim().toLowerCase() === code;
  });
  if (exact.length === 1) {
    return {
      ok: true,
      id: String(exact[0].id || exact[0]._id || ''),
      name: itemName(exact[0]),
    };
  }
  if (exact.length > 1) {
    const names = exact.slice(0, 8).map(itemName).filter(Boolean);
    return {
      ok: false,
      code: 'ambiguous_target',
      message: `More than one product matches "${text}": ${names.join(', ')}. Ask which one by name; never ask for an id.`,
      matches: exact.slice(0, 8).map((item) => ({
        id: String(item.id || item._id || ''),
        name: itemName(item),
        barcode: itemBarcode(item),
        sku: itemSku(item),
      })),
    };
  }

  /* A typo should still find the product ("جزمة حمرى" -> "جزمة حمراء"), but
     only an unambiguously close name may be changed without asking. */
  const ranked = rankNameMatches(text, matches, itemName);
  const strict = ranked.filter((entry) => nameSimilarity(text, itemName(entry.item)) >= 0.72);
  if (strict.length === 1) {
    return {
      ok: true,
      id: String(strict[0].item.id || strict[0].item._id || ''),
      name: itemName(strict[0].item),
    };
  }
  if (strict.length > 1) {
    const names = strict.slice(0, 8).map((entry) => itemName(entry.item)).filter(Boolean);
    return {
      ok: false,
      code: 'ambiguous_target',
      message: `More than one product matches "${text}": ${names.join(', ')}. Ask which one by name; never ask for an id.`,
      matches: strict.slice(0, 8).map((entry) => ({
        id: String(entry.item.id || entry.item._id || ''),
        name: itemName(entry.item),
        barcode: itemBarcode(entry.item),
        sku: itemSku(entry.item),
      })),
    };
  }
  const closest = ranked.slice(0, 5).map((entry) => itemName(entry.item)).filter(Boolean);
  return {
    ok: false,
    code: closest.length ? 'ambiguous_target' : 'not_found',
    message: closest.length
      ? `No product is named exactly "${text}". Closest matches: ${closest.join(', ')}. Ask which one by name; never ask for an id.`
      : `No product in this branch matches "${text}". Ask for a different name or description, or offer to create it.`,
    matches: closest,
  };
}

async function resolveCategoryTarget(api, text) {
  const matches = await findCategoriesByName(api, text);
  if (matches.length === 1) {
    return {
      ok: true,
      id: String(matches[0].id || matches[0]._id || ''),
      name: cleanText(matches[0].name, 200),
    };
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 8).map((item) => cleanText(item.name, 200)).filter(Boolean);
    return {
      ok: false,
      code: 'ambiguous_target',
      message: `More than one category matches "${text}": ${names.join(', ')}. Ask which one by name; never ask for an id.`,
      matches: matches.slice(0, 8).map((item) => ({
        id: String(item.id || item._id || ''),
        name: cleanText(item.name, 200),
      })),
    };
  }
  return {
    ok: false,
    code: 'not_found',
    message: `No category in this branch is named exactly "${text}". Ask for a different name or offer to create it.`,
  };
}

async function fetchItem(api, target) {
  const payload = await api.get('items/' + encodeURIComponent(target));
  return payload && payload.data ? payload.data : null;
}

async function fetchCategory(api, target) {
  const payload = await api.get('categories/' + encodeURIComponent(target));
  return payload && payload.data ? payload.data : null;
}

function fieldValue(action, key, value) {
  if (isRef(value)) {
    return parseRef(value);
  }
  if (key === 'name' || key === 'category_name' || key === 'barcode' || key === 'sku' ||
      key === 'unit' || key === 'reason' || key === 'note' || key === 'description') {
    return cleanText(value, key === 'description' ? 1000 : key === 'note' ? 300 : 200);
  }
  if (key === 'selling_price' || key === 'cost_price' || key === 'mrp_price' ||
      key === 'opening_stock' || key === 'stock_quantity') {
    return number(value);
  }
  if (key === 'inventory' || key === 'negative_stock' || key === 'is_active') {
    return boolean(value);
  }
  if (key === 'item_kind') {
    return value === 'service' ? 'service' : 'product';
  }
  if (key === 'stock_mode') {
    return ['set', 'add', 'subtract'].includes(value) ? value : '';
  }
  if (key === 'category_id') {
    return id(value);
  }
  return value;
}

function normaliseFields(raw, actionName, stepIDs) {
  if (!isObject(raw)) return error('invalid_fields', 'Each step needs a fields object.');
  const spec = ACTIONS[actionName];
  const allowed = new Set(spec.fields);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) {
      const hint = actionName === 'adjust_stock'
        ? ' Put the product in target and use stock_mode, stock_quantity and reason in fields.'
        : '';
      return error('field_not_allowed', `"${key}" cannot be used in ${spec.label.toLowerCase()}.${hint}`);
    }
    if (value === undefined || value === null || value === '') continue;
    const next = fieldValue(actionName, key, value);
    if (next === null) {
      return error('invalid_field', `"${key}" must be a valid non-negative number.`);
    }
    if (isRef(next)) {
      if (!stepIDs.has(next.step)) {
        return error('invalid_reference', `"${key}" refers to a step that is not earlier in this plan.`);
      }
      if (!['id', 'name'].includes(next.field)) {
        return error('invalid_reference', `"${key}" can only use a step's id or name.`);
      }
    }
    if (key === 'category_id' && !isRef(next) && !next) {
      return error('invalid_field', '"category_id" is not a valid category id.');
    }
    if (key === 'stock_mode' && !next) {
      return error('invalid_field', '"stock_mode" must be set, add or subtract.');
    }
    if (typeof next === 'string' && next === '' && key !== 'description' && key !== 'note') {
      continue;
    }
    out[key] = next;
  }
  return { ok: true, fields: out };
}

/* The model often copies a product's id or name from a search result into
   fields as product_id/product_name, because that is the shape of the row it
   just read. Accept that natural shape for actions whose target is a product
   instead of rejecting the plan with a field-name error. */
function takeTargetAliases(input, actionName) {
  if (!isObject(input)) return input;
  const aliases = actionName === 'adjust_stock'
    ? ['product_id', 'item_id', 'product_name', 'item_name', 'id', 'name', 'target']
    : actionName === 'update_product'
      ? ['product_id', 'item_id', 'product_name', 'item_name', 'target']
      : actionName === 'update_category'
        ? ['target']
        : [];
  if (!aliases.length) return input;
  const fields = isObject(input.fields) ? { ...input.fields } : input.fields;
  if (!isObject(fields)) return input;
  let target = input.target;
  for (const alias of aliases) {
    const value = fields[alias];
    if (value === undefined || value === null || value === '') {
      delete fields[alias];
      continue;
    }
    if (target === undefined || target === null || target === '') target = value;
    delete fields[alias];
  }
  return { ...input, target, fields };
}

function stepTitle(step) {
  const spec = ACTIONS[step.action];
  const label = step.label || spec.label;
  const name = step.fields && step.fields.name;
  if (name && typeof name === 'string') return `${label}: ${name}`;
  if (step.before && step.before.name) return `${label}: ${step.before.name}`;
  return label;
}

function mergeShared(fields, shared, actionName) {
  if (!PRODUCT_ACTIONS.has(actionName)) return fields;
  const out = { ...fields };
  for (const [key, value] of Object.entries(shared || {})) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/* The model occasionally repeats an attachment id from an earlier turn after
   that image has expired. When the conversation still holds exactly one image,
   or the id is really the file name, use the live attachment instead of
   rejecting a plan the user can see is correct. Ambiguous multi-image turns
   still fail so the wrong photo is never attached. */
function describeAttachment(attachments, sessionID, attachmentId, requestedName = '') {
  const described = attachments.describe(sessionID, [attachmentId]);
  if (!described || described.ok || typeof attachments.list !== 'function') return described;
  const current = attachments.list(sessionID);
  if (!Array.isArray(current) || !current.length) return described;
  const wanted = [requestedName, attachmentId]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const byName = current.find(
    (item) => item && wanted.includes(String(item.name || '').trim().toLowerCase()),
  );
  if (byName) {
    const exact = attachments.describe(sessionID, [byName.id]);
    if (exact && exact.ok) return exact;
  }
  if (current.length === 1) {
    const only = attachments.describe(sessionID, [current[0].id]);
    if (only && only.ok) return only;
  }
  return described;
}

async function validatePlan(raw, {
  api,
  sessionID,
  attachments,
  userText = '',
  lookups = null,
} = {}) {
  const userWords = cleanText(userText, 4000);
  const preloaded = lookups && typeof lookups === 'object' ? lookups : {};
  const preloadedCategories = Array.isArray(preloaded.categories) ? preloaded.categories : null;
  const categoriesComplete = preloaded.categoriesComplete === true && !!preloadedCategories;
  const preloadedProducts = Array.isArray(preloaded.products) ? preloaded.products : null;
  const currentCategory = preloaded.currentCategory && typeof preloaded.currentCategory === 'object'
    ? {
        id: cleanText(preloaded.currentCategory.id, 80),
        name: cleanText(preloaded.currentCategory.name, 200),
      }
    : null;
  if (!api || typeof api.get !== 'function') {
    return error('configuration_error', 'The shop data service is not available.');
  }
  if (!isObject(raw)) return error('invalid_plan', 'The plan must be an object.');
  if (!Array.isArray(raw.steps) || !raw.steps.length) {
    return error('invalid_plan', 'A plan needs at least one step.');
  }
  if (raw.steps.length > MAX_STEPS) {
    return error('invalid_plan', `A plan can have at most ${MAX_STEPS} steps.`);
  }

  const allStepIDs = new Set();
  raw.steps.forEach((step, index) => {
    const stepID = cleanText(step && step.id, 40) || `s${index + 1}`;
    allStepIDs.add(stepID);
  });

  const warnings = [];

  /* A category reference is only valid inside the plan that contains the
     category step. When the model carries a reference from an earlier plan
     (for example after the user just created a category), use the current
     category from the conversation instead of failing the whole plan. */
  function repairCategoryFields(fields, stepIDs, label) {
    if (!isObject(fields)) return fields;
    const out = { ...fields };
    const idRef = isRef(out.category_id) && !stepIDs.has(out.category_id.step);
    const nameRef = isRef(out.category_name) && !stepIDs.has(out.category_name.step);
    if (!idRef && !nameRef) return out;
    const concreteId = !isRef(out.category_id) ? cleanText(out.category_id, 80) : '';
    const concreteName = !isRef(out.category_name) ? cleanText(out.category_name, 200) : '';
    if (idRef) delete out.category_id;
    if (nameRef) delete out.category_name;
    if (concreteId || concreteName) {
      warnings.push(`Ignored a category reference in ${label} that points to an earlier plan.`);
      return out;
    }
    if (currentCategory && (currentCategory.id || currentCategory.name)) {
      if (currentCategory.id) out.category_id = currentCategory.id;
      if (currentCategory.name) out.category_name = currentCategory.name;
      warnings.push(
        `The category reference in ${label} came from an earlier plan; ` +
        `using the current category "${currentCategory.name || currentCategory.id}".`,
      );
    } else {
      warnings.push(`Ignored a category reference in ${label} that points to an earlier plan.`);
    }
    return out;
  }

  const sharedInput = repairCategoryFields(raw.shared, allStepIDs, 'shared fields');
  if (isObject(sharedInput)) {
    for (const key of Object.keys(sharedInput)) {
      if (!SHARED_FIELDS.has(key)) {
        return error('field_not_allowed', `"${key}" cannot be shared across every step.`);
      }
    }
  }

  const shared = {};
  if (isObject(sharedInput)) {
    for (const key of Object.keys(sharedInput)) {
      const next = fieldValue('create_product', key, sharedInput[key]);
      if (next === null) return error('invalid_field', `Shared "${key}" must be valid.`);
      if (isRef(next) && !allStepIDs.has(next.step)) {
        return error('invalid_reference', `Shared "${key}" refers to a step that is not in this plan.`);
      }
      if (next !== undefined) shared[key] = next;
    }
  }

  const steps = [];
  const stepIDs = new Set();
  const categorySteps = new Set();
  const productNames = new Set();
  const productCodes = new Set();
  const textCorrections = new Map();

  for (let index = 0; index < raw.steps.length; index += 1) {
    let input = raw.steps[index];
    if (!isObject(input)) return error('invalid_plan', `Step ${index + 1} is not an object.`);
    const actionName = cleanText(input.action, 40);
    const spec = ACTIONS[actionName];
    if (!spec) return error('invalid_action', `Step ${index + 1} has an unknown action.`);
    input = takeTargetAliases(input, actionName);

    const stepID = cleanText(input.id, 40) || `s${index + 1}`;
    if (!/^[a-z0-9_-]+$/i.test(stepID)) {
      return error('invalid_plan', `Step ${index + 1} has an invalid id.`);
    }
    if (stepIDs.has(stepID)) {
      return error('invalid_plan', `Step id "${stepID}" is used twice.`);
    }

    const repairedFields = repairCategoryFields(input.fields || {}, allStepIDs, `step "${stepID}"`);
    const normalized = normaliseFields(repairedFields, actionName, stepIDs);
    if (!normalized.ok) return normalized;
    let fields = mergeShared(normalized.fields, shared, actionName);
    for (const value of Object.values(fields)) {
      if (isRef(value) && !stepIDs.has(value.step)) {
        return error(
          'invalid_reference',
          `Step "${stepID}" refers to a step that is not earlier in this plan.`,
        );
      }
    }

    /* A product added in the same topic belongs to the category the topic is
       already working in. The model should include it explicitly, but when it
       omits the category, the conversation's current category is the safe
       default; an explicit "without category" still wins. */
    if (actionName === 'create_product' && currentCategory &&
        !fields.category_id && !fields.category_name && !explicitNoCategory(userWords)) {
      const categoryId = /^[a-f0-9]{24}$/i.test(currentCategory.id) ? currentCategory.id : '';
      if (categoryId) fields.category_id = categoryId;
      if (currentCategory.name) fields.category_name = currentCategory.name;
      if (categoryId || currentCategory.name) {
        warnings.push(`Used the current category "${currentCategory.name || currentCategory.id}".`);
      }
    }

    const images = [];
    if (input.images !== undefined) {
      if (!PRODUCT_ACTIONS.has(actionName)) {
        return error('field_not_allowed', 'Images can only be attached to product steps.');
      }
      if (!Array.isArray(input.images) || input.images.length > MAX_IMAGES) {
        return error('invalid_images', `Attach up to ${MAX_IMAGES} images to a product.`);
      }
      for (const image of input.images) {
        const attachmentId = cleanText(image && image.attachmentId, 80);
        if (!attachmentId) return error('invalid_images', 'Each image needs an attachment id.');
        if (!attachments || typeof attachments.describe !== 'function') {
          return error('attachment_missing', 'The attached image is no longer available. Attach it again.');
        }
        const described = describeAttachment(attachments, sessionID, attachmentId, image && image.name);
        if (!described.ok) return error(described.code, described.message);
        const resolved = described.attachments[0];
        images.push({
          attachmentId: resolved.id,
          name: resolved.name,
          cover: image && image.cover === true,
        });
      }
    }

    const step = {
      id: stepID,
      action: actionName,
      label: spec.label,
      permission: spec.permission,
      fields,
      images,
      status: 'pending',
      warnings: [],
    };

    if (spec.target) {
      const target = input.target;
      if (isRef(target)) {
        const ref = parseRef(target);
        if (!stepIDs.has(ref.step)) {
          return error(
            'invalid_reference',
            `Step "${stepID}" targets a step that is not earlier in this plan. ` +
            'Use the product name or id from the search result, or add that step earlier in this same plan.',
          );
        }
        step.target = ref;
      } else {
        const targetText = cleanText(target, 200);
        if (!targetText) {
          if (actionName === 'adjust_stock') {
            return error(
              'invalid_target',
              `Step "${stepID}" needs the product in target, not in fields. ` +
              'Use the name or id from the search result, for example ' +
              '{"target":"كاتل مياه استانلس 1.7 لتر","fields":{"stock_mode":"subtract","stock_quantity":3}}.',
            );
          }
          return error(
            'invalid_target',
            `Step "${stepID}" needs a product or category name, description, barcode or SKU. An id from a tool result also works, but never ask the user for one.`,
          );
        }
        const targetID = id(targetText);
        if (targetID) {
          step.target = targetID;
        } else {
          const resolveTarget = actionName === 'update_category'
            ? resolveCategoryTarget
            : resolveProductTarget;
          try {
            const resolved = await resolveTarget(api, targetText);
            if (!resolved.ok) {
              return error(resolved.code, resolved.message, {
                matches: resolved.matches,
              });
            }
            step.target = resolved.id;
            step.targetName = resolved.name;
          } catch (caught) {
            return error(
              caught.code || 'request_failed',
              caught.message || 'The record could not be found in this branch.',
            );
          }
        }
      }
    }

    if (input.dependsOn !== undefined) {
      if (!Array.isArray(input.dependsOn)) return error('invalid_plan', `Step "${stepID}" has invalid dependencies.`);
      for (const dep of input.dependsOn) {
        const depID = cleanText(dep, 40);
        if (!stepIDs.has(depID)) {
          return error('invalid_reference', `Step "${stepID}" depends on a step that is not earlier in this plan.`);
        }
        step.dependsOn = step.dependsOn || [];
        step.dependsOn.push(depID);
      }
    }
    for (const value of Object.values(fields)) {
      if (!isRef(value)) continue;
      step.dependsOn = step.dependsOn || [];
      if (!step.dependsOn.includes(value.step)) step.dependsOn.push(value.step);
    }

    if (actionName === 'create_category' || actionName === 'update_category') {
      if (actionName === 'create_category' && !fields.name) {
        return error('missing_name', 'A new category needs a name.');
      }
      if (actionName === 'update_category' && !Object.keys(fields).length) {
        return error('missing_fields', 'Choose at least one category field to change.');
      }
    }

    if (actionName === 'create_product') {
      if (!fields.name) return error('missing_name', 'A new product needs a name.');
      const correctedName = correctCommonSpelling(fields.name);
      if (correctedName !== fields.name) {
        warnings.push(`Corrected the product name "${fields.name}" to "${correctedName}".`);
        textCorrections.set(fields.name, correctedName);
        fields.name = correctedName;
      }
      const provided = { ...fields };
      fields = {
        item_kind: 'product',
        inventory: true,
        negative_stock: false,
        unit: 'qty',
        description: '',
        barcode: '',
        sku: '',
        category_id: '',
        category_name: '',
        ...provided,
      };
      if (typeof fields.description === 'string') {
        const correctedDescription = correctCommonSpelling(fields.description);
        if (correctedDescription !== fields.description) {
          warnings.push('Corrected the spelling in the product description.');
          fields.description = correctedDescription;
        }
      }
      /* A new product is a purchase decision, not a placeholder. Require the
         four values a shopkeeper needs before the preview. Zero is accepted
         when the user explicitly gave zero; a missing value is not. */
      const required = fields.item_kind === 'service'
        ? [['selling_price', 'selling price']]
        : [
            ['selling_price', 'selling price'],
            ['cost_price', 'cost price'],
            ['opening_stock', 'opening stock'],
          ];
      for (const [key, label] of required) {
        if (provided[key] === undefined || provided[key] === '') {
          return error(
            `missing_${key}`,
            `A new product needs a ${label}. Ask the user for it; do not default it to zero.`,
          );
        }
      }
      /* The model sometimes fills an unstated price with 0. Reject that: the
         user's own words must contain a zero price (or an explicit "same
         price") before zero is accepted. */
      if (userWords && fields.item_kind !== 'service' &&
          !hasExplicitPriceZero(userWords) && !hasSamePriceReference(userWords)) {
        if (Number(provided.selling_price) === 0) {
          return error(
            'missing_selling_price',
            'The user did not give a selling price. Ask for the selling price; do not use 0 unless the user said it is free or zero.',
          );
        }
        if (Number(provided.cost_price) === 0) {
          return error(
            'missing_cost_price',
            'The user did not give a cost price. Ask for the cost price; do not use 0 unless the user said it is zero.',
          );
        }
      }
      if (fields.item_kind === 'service') {
        fields.inventory = false;
        fields.opening_stock = 0;
      }
      /* Selling price and retail price are the same figure unless the user
         explicitly gave a different retail price. A stray 0 from the model is
         treated as "not given", not as a deliberate free retail price. */
      if (provided.mrp_price === undefined ||
          (!mentionsRetailPrice(userWords) && Number(provided.mrp_price) === 0)) {
        fields.mrp_price = fields.selling_price;
      }
      if (isRef(fields.category_id)) {
        fields.category_name = { step: fields.category_id.step, field: 'name' };
      }
      if (isRef(fields.category_name) && !fields.category_id) {
        fields.category_id = { step: fields.category_name.step, field: 'id' };
      }
      for (const categoryRef of [fields.category_id, fields.category_name]) {
        if (!isRef(categoryRef)) continue;
        step.dependsOn = step.dependsOn || [];
        if (!step.dependsOn.includes(categoryRef.step)) step.dependsOn.push(categoryRef.step);
      }
      step.fields = fields;
      const wanted = normaliseName(fields.name);
      if (productNames.has(wanted)) {
        return error('duplicate_in_plan', `The plan creates "${fields.name}" more than once.`);
      }
      productNames.add(wanted);
      for (const code of [fields.barcode, fields.sku]) {
        const key = String(code || '').trim().toLowerCase();
        if (!key) continue;
        if (productCodes.has(key)) {
          return error('duplicate_in_plan', `The plan uses the code "${code}" more than once.`);
        }
        productCodes.add(key);
      }

      if (!isRef(fields.category_id) && !fields.category_id && fields.category_name && !isRef(fields.category_name)) {
        let existing;
        try {
          existing = await lookupCategoryByName(api, fields.category_name, preloadedCategories, categoriesComplete);
        } catch (caught) {
          return error(caught.code || 'request_failed', caught.message || 'The category could not be checked.');
        }
        if (!existing) {
          return error(
            'category_not_found',
            `No category named "${fields.category_name}" exists. Create it first in this plan, or leave the category empty.`,
          );
        }
        fields.category_id = String(existing.id || existing._id || '');
        fields.category_name = cleanText(existing.name, 200);
      }
      if (fields.category_id && !isRef(fields.category_id)) {
        try {
          const category = await lookupCategoryById(api, fields.category_id, preloadedCategories, categoriesComplete);
          if (category) fields.category_name = cleanText(category.name, 200);
        } catch (caught) {
          return error('category_not_found', 'That category was not found in this branch.');
        }
      }

      try {
        const matches = preloadedProducts || await findProduct(api, fields.name);
        const exact = matches.find((item) => normaliseName(itemName(item)) === wanted);
        if (exact) {
          return error(
            'possible_duplicate',
            `A product named "${fields.name}" already exists. Update that product instead, or choose a different name.`,
            { existingId: String(exact.id || exact._id || '') },
          );
        }
        for (const code of [fields.barcode, fields.sku]) {
          const wantedCode = String(code || '').trim().toLowerCase();
          if (!wantedCode) continue;
          const codeMatch = matches.find((item) =>
            String(itemBarcode(item)).trim().toLowerCase() === wantedCode ||
            String(itemSku(item)).trim().toLowerCase() === wantedCode);
          if (codeMatch) {
            return error(
              'possible_duplicate',
              `The code "${code}" is already used by "${itemName(codeMatch)}". Choose another code or update that product.`,
              { existingId: String(codeMatch.id || codeMatch._id || '') },
            );
          }
          /* The name search cannot see a different-name product carrying the
             same code, and the server refuses that write only at execution
             time. Ask the catalogue by the code itself — trimmed and
             lowercased, leading zeros kept — so the clash surfaces as
             possible_duplicate with the product to update. The real search
             matches exact codes (barcode_id, sku, itemid, plu_code, gtin,
             barcodes — item.repository.searchItems). If this lookup cannot
             run, fail open with a logged warning: the server's barcode write
             lock is the backstop, while the name check above keeps its
             fail-closed path as the primary duplicate gate. */
          let byCode = [];
          try {
            byCode = await findProduct(api, String(code).trim());
          } catch (lookupError) {
            step.warnings.push(
              `The barcode duplicate check could not run (${lookupError.message || lookupError}); ` +
              'the server will still refuse a code clash.',
            );
          }
          const exactCode = byCode.find((item) =>
            String(itemBarcode(item)).trim().toLowerCase() === wantedCode ||
            String(itemSku(item)).trim().toLowerCase() === wantedCode);
          if (exactCode) {
            return error(
              'possible_duplicate',
              `The code "${code}" is already used by "${itemName(exactCode)}". Choose another code or update that product.`,
              { existingId: String(exactCode.id || exactCode._id || '') },
            );
          }
        }
      } catch (caught) {
        return error(caught.code || 'request_failed', caught.message || 'The product could not be checked.');
      }
    }

    if (actionName === 'update_product') {
      if (!Object.keys(fields).length && !images.length) {
        return error('missing_fields', 'Choose at least one product field or image to change.');
      }
      if (fields.name) {
        const correctedName = correctCommonSpelling(fields.name);
        if (correctedName !== fields.name) {
          step.warnings.push(`Corrected the product name "${fields.name}" to "${correctedName}".`);
          textCorrections.set(fields.name, correctedName);
          fields.name = correctedName;
        }
      }
      if (typeof fields.description === 'string') {
        const correctedDescription = correctCommonSpelling(fields.description);
        if (correctedDescription !== fields.description) {
          step.warnings.push('Corrected the spelling in the product description.');
          fields.description = correctedDescription;
        }
      }
      if (fields.mrp_price === undefined && fields.selling_price !== undefined &&
          !mentionsRetailPrice(userWords)) {
        fields.mrp_price = fields.selling_price;
      }
      if (isRef(fields.category_id)) {
        fields.category_name = { step: fields.category_id.step, field: 'name' };
      }
      if (isRef(fields.category_name) && !fields.category_id) {
        fields.category_id = { step: fields.category_name.step, field: 'id' };
      }
      for (const categoryRef of [fields.category_id, fields.category_name]) {
        if (!isRef(categoryRef)) continue;
        step.dependsOn = step.dependsOn || [];
        if (!step.dependsOn.includes(categoryRef.step)) step.dependsOn.push(categoryRef.step);
      }
      if (!isRef(step.target)) {
        try {
          const current = await fetchItem(api, step.target);
          if (!current) return error('not_found', 'That product was not found in this branch.');
          step.before = beforeProduct(current);
        } catch (caught) {
          if (caught.code === 'not_found') return error('not_found', 'That product was not found in this branch.');
          return error(caught.code || 'request_failed', caught.message || 'The product could not be loaded.');
        }
      }
      if (fields.name && step.before && normaliseName(fields.name) !== normaliseName(step.before.name)) {
        try {
          const matches = await findProduct(api, fields.name);
          const exact = matches.find((item) =>
            normaliseName(itemName(item)) === normaliseName(fields.name) &&
            String(item.id || item._id || '') !== step.target);
          if (exact) {
            return error(
              'possible_duplicate',
              `Another product is already named "${fields.name}". Choose a different name or update that product.`,
              { existingId: String(exact.id || exact._id || '') },
            );
          }
        } catch (caught) {
          return error(caught.code || 'request_failed', caught.message || 'The product could not be checked.');
        }
      }
      if (fields.category_name && !fields.category_id && !isRef(fields.category_name)) {
        let existing;
        try {
          existing = await lookupCategoryByName(api, fields.category_name, preloadedCategories, categoriesComplete);
        } catch (caught) {
          return error(caught.code || 'request_failed', caught.message || 'The category could not be checked.');
        }
        if (!existing) {
          return error(
            'category_not_found',
            `No category named "${fields.category_name}" exists. Create it first in this plan, or choose an existing category.`,
          );
        }
        fields.category_id = String(existing.id || existing._id || '');
        fields.category_name = cleanText(existing.name, 200);
      }
      if (fields.category_id && !isRef(fields.category_id)) {
        try {
          const category = await lookupCategoryById(api, fields.category_id, preloadedCategories, categoriesComplete);
          if (category) fields.category_name = cleanText(category.name, 200);
        } catch (caught) {
          return error('category_not_found', 'That category was not found in this branch.');
        }
      }
      if (step.before) {
        step.warnings.push('This changes an existing product. Review the new values before confirming.');
        if (fields.selling_price !== undefined && fields.selling_price !== step.before.sellingPrice) {
          step.warnings.push('The selling price will change.');
        }
      }
    }

    if (actionName === 'create_category') {
      const wanted = normaliseName(fields.name);
      let reusedCategory = false;
      try {
        const candidates = await lookupCategoriesByName(
          api,
          fields.name,
          preloadedCategories,
          categoriesComplete,
        );
        const existing = candidates.find((row) => normaliseName(row.name) === wanted);
        if (existing) {
          const existingId = String(existing.id || existing._id || '');
          const existingName = cleanText(existing.name, 200);
          /* A plan that creates a category and then puts a product in it is
             asking for that shelf, not for a second category with the same
             name. Reuse the shelf that is already there. */
          if (laterStepUsesCategory(raw.steps, index, stepID, fields.name)) {
            step.reuse = { id: existingId, name: existingName };
            step.label = 'Use existing category';
            textCorrections.set(fields.name, existingName);
            fields.name = existingName;
            step.warnings.push(
              `Reused the existing category "${existingName}" instead of creating a duplicate.`,
            );
            warnings.push(`Reuses the existing category "${existingName}".`);
            reusedCategory = true;
          } else {
            return error(
              'possible_duplicate',
              `A category named "${fields.name}" already exists. Use that category or choose a different name.`,
              { existingId, existingName },
            );
          }
        }
        const similar = candidates[0];
        if (!reusedCategory && similar) {
          const score = scoreNameMatch(fields.name, similar.name);
          /* The same number of words plus a close spelling is a variant of an
             existing category (الاحزايا -> احذية), not a new one. Multi-word
             names such as احذية اطفال are allowed because they add a word. */
          if (score >= 0.5 && nameTokenCount(fields.name) === nameTokenCount(similar.name)) {
            const existingId = String(similar.id || similar._id || '');
            const existingName = cleanText(similar.name, 200);
            const requestedName = fields.name;
            if (!laterStepUsesCategory(raw.steps, index, stepID, requestedName)) {
              return error(
                'possible_duplicate',
                `The category "${existingName}" already exists and is the closest match to "${requestedName}". Use that category instead of creating a near-duplicate.`,
                { existingId, existingName },
              );
            }
            /* The request names a category that is only a misspelling of an
               existing one and a later step uses it. Reuse it rather than
               creating the duplicate the user did not intend. */
            step.reuse = { id: existingId, name: existingName };
            step.label = 'Use existing category';
            textCorrections.set(requestedName, existingName);
            fields.name = existingName;
            step.warnings.push(
              `Reused the existing category "${existingName}" instead of creating "${requestedName}".`,
            );
            warnings.push(`Reuses the existing category "${existingName}".`);
            reusedCategory = true;
          }
          if (!reusedCategory && score >= 0.6) {
            warnings.push(
              `A similar category already exists: "${cleanText(similar.name, 200)}". Check that this is not a duplicate.`,
            );
          }
        }
      } catch (caught) {
        return error(caught.code || 'request_failed', caught.message || 'The category could not be checked.');
      }
      fields.description = fields.description || '';
      step.fields = fields;
      categorySteps.add(stepID);
      if (!reusedCategory) warnings.push(`Creates the category "${fields.name}".`);
    }

    if (actionName === 'update_category') {
      if (!isRef(step.target)) {
        try {
          const current = await fetchCategory(api, step.target);
          if (!current) return error('not_found', 'That category was not found in this branch.');
          step.before = beforeCategory(current);
        } catch (caught) {
          if (caught.code === 'not_found') return error('not_found', 'That category was not found in this branch.');
          return error(caught.code || 'request_failed', caught.message || 'The category could not be loaded.');
        }
      }
      step.warnings.push('This changes an existing category. Review the new values before confirming.');
    }

    if (actionName === 'adjust_stock') {
      if (!fields.stock_mode) return error('missing_fields', 'Choose set, add or subtract for the stock change.');
      if (fields.stock_quantity === undefined) return error('missing_fields', 'Enter the stock quantity to change.');
      fields.reason = fields.reason || (fields.stock_mode === 'set' ? 'Inventory count' : fields.stock_mode === 'add' ? 'Stock found' : 'Loss');
      step.fields = fields;
      if (!isRef(step.target)) {
        try {
          const current = await fetchItem(api, step.target);
          if (!current) return error('not_found', 'That product was not found in this branch.');
          step.before = beforeProduct(current);
        } catch (caught) {
          if (caught.code === 'not_found') return error('not_found', 'That product was not found in this branch.');
          return error(caught.code || 'request_failed', caught.message || 'The product could not be loaded.');
        }
      }
      step.warnings.push('This changes stock and writes an audited stock log.');
      warnings.push(`Adjusts stock for "${step.before ? step.before.name : 'the product'}".`);
    }

    if (step.warnings.length) warnings.push(...step.warnings);
    steps.push(step);
    stepIDs.add(stepID);
  }

  /* The model drafts the plan title and summary from the user's words. Apply
     the same spelling and category-name corrections the steps received so the
     preview never shows a name that is about to be changed. */
  const correctPlanText = (value) => {
    let text = value;
    for (const [from, to] of textCorrections) {
      if (from && to && from !== to) text = text.split(from).join(to);
    }
    return normalizeCurrencyText(text);
  };
  const title = correctPlanText(cleanText(raw.title, 120)) ||
    `${steps.length} change${steps.length === 1 ? '' : 's'}`;
  const summary = correctPlanText(cleanText(raw.summary, 400)) ||
    steps.map(stepTitle).join(' · ');
  const planId = 'plan_' + crypto.randomBytes(10).toString('hex');
  return {
    ok: true,
    plan: {
      id: planId,
      idempotencyKey: planId,
      title,
      summary,
      shared,
      steps,
      warnings: Array.from(new Set(warnings.map(normalizeCurrencyText))),
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000,
    },
  };
}

module.exports = {
  ACTIONS,
  MAX_IMAGES,
  MAX_STEPS,
  SHARED_FIELDS,
  normaliseName,
  validatePlan,
};
