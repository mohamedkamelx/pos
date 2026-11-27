/*
 * Live shop reads without a model request.
 *
 * Stock, price, product count and profit questions have one correct source:
 * the shop's item rows for the signed-in branch. Sending those words to the
 * model adds latency and a chance to answer from an old plan preview. This
 * module reads the same authorized item routes the tools use and answers from
 * those rows only.
 *
 * It stays deliberately narrow. A name that is not an exact match, a missing
 * permission, or an API failure falls through to the normal model flow. It
 * never guesses which product the user meant and never mixes remembered data
 * into a live answer.
 */

'use strict';

const { listCategories } = require('../tools/list-categories');
const { listProducts } = require('../tools/list-products');
const { searchProducts } = require('../tools/search-products');
const { normalizeName, scoreNameMatch } = require('../text-match');
const { isAnalyticAsk } = require('./read-shape');

const PROFIT_PAGE_LIMIT = 50;
const PROFIT_MAX_PAGES = 5;
const LIST_LIMIT = 20;
const CARD_LIMIT = 20;
/* Precision floor for quoting a row without confirming the name. Kept
   separate from search's recall threshold (FUZZY_MIN_SCORE) on purpose:
   changing how much search returns must never change answer-versus-ask. */
const LIVE_ACCEPT_MIN = 0.6;

function isArabic(value) {
  return /[\u0600-\u06FF]/.test(String(value || ''));
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const rounded = Math.round(number * 100) / 100;
  return String(rounded);
}

function money(value, currencySign) {
  const text = amount(value);
  if (!text) return '';
  const sign = String(currencySign || '').trim();
  return sign ? `${text} ${sign}` : text;
}

function unitSuffix(item) {
  const unit = String((item && item.unit) || '').trim();
  return unit && unit !== 'qty' ? ` ${unit}` : '';
}

function productToolCall(result) {
  return {
    id: `posnic_live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: result.kind === 'product_search' ? 'posnic_search_products' : 'posnic_list_products',
    status: 'completed',
    input: result.query ? { query: result.query } : {},
    metadata: { posnic: result },
  };
}

function hiddenToolCall(result) {
  return {
    ...productToolCall(result),
    metadata: { posnic: { ...result, internal: true } },
  };
}

function exactMatch(results, query) {
  const wanted = normalizeName(query);
  if (!wanted) return null;
  return (Array.isArray(results) ? results : []).find(
    (item) => normalizeName(item && item.name) === wanted,
  ) || null;
}

/* The spec (reference/BEHAVIOR.md) says a close-but-not-exact result must be
   confirmed before it is quoted as a price or stock answer. A search row is
   only "the product" when it actually shares its name with the query, so a
   single unrelated row can never answer a read. */
function rowMatches(query, item) {
  const wanted = normalizeName(query);
  if (!wanted) return false;
  if (scoreNameMatch(query, item && item.name) >= LIVE_ACCEPT_MIN) return true;
  return [item && item.sku, item && item.barcode].some(
    (value) => value && normalizeName(value) === wanted,
  );
}

function pickProduct(results, query) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return { kind: 'none' };
  const exact = exactMatch(list, query);
  if (exact) return { kind: 'one', item: exact };
  const near = list.filter((item) => rowMatches(query, item));
  if (near.length === 1) return { kind: 'one', item: near[0] };
  if (near.length > 1) return { kind: 'many', items: near.slice(0, 3) };
  /* Nothing in the result actually matches: the model decides, per spec. */
  return { kind: 'close', items: list.slice(0, 1) };
}

function productNames(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String((item && item.name) || '').trim())
    .filter(Boolean);
}

function nameQuestion(items, arabic) {
  const names = productNames(items);
  if (!names.length) return '';
  if (arabic) {
    return `في أكتر من منتج قريب: ${names.map((name) => `«${name}»`).join('، ')}. أنهي واحد تقصد؟`;
  }
  return `A few products are close: ${names.map((name) => `"${name}"`).join(', ')}. Which one do you mean?`;
}

async function resolveCategory(api, name) {
  if (!name) return { ok: true, category: null };
  const result = await listCategories({ query: name, limit: 20 }, { api });
  if (!result || result.kind === 'error') {
    return { ok: false, error: result || { message: 'The category list failed.' } };
  }
  const wanted = normalizeName(name);
  const category = (result.categories || []).find(
    (candidate) => normalizeName(candidate && candidate.name) === wanted,
  ) || null;
  return { ok: true, category };
}

async function searchFor(api, query) {
  return searchProducts({ query, limit: 8 }, { api });
}

function countReply(total, categoryName, arabic) {
  if (arabic) {
    return categoryName
      ? `عدد المنتجات في فئة «${categoryName}»: ${amount(total)}.`
      : `عدد المنتجات في الفرع الحالي: ${amount(total)}.`;
  }
  return categoryName
    ? `Products in the category "${categoryName}": ${amount(total)}.`
    : `Products in the current branch: ${amount(total)}.`;
}

function listReply(result, categoryName, arabic) {
  const rows = (result.results || []).slice(0, 8);
  const scope = categoryName
    ? (arabic ? ` في فئة «${categoryName}»` : ` in the category "${categoryName}"`)
    : '';
  const total = Number(result.total);
  const shown = rows.map((item) => {
    const parts = [`«${item.name}»`];
    if (Number.isFinite(Number(item.sellingPrice))) {
      parts.push(arabic ? `سعر ${amount(item.sellingPrice)}` : `price ${amount(item.sellingPrice)}`);
    }
    if (Number.isFinite(Number(item.stock))) {
      parts.push(arabic ? `مخزون ${amount(item.stock)}` : `stock ${amount(item.stock)}`);
    }
    return parts.join(arabic ? '، ' : ', ');
  });
  if (!shown.length) {
    return arabic
      ? `مفيش منتجات${scope} في الفرع الحالي.`
      : `No products${scope} in the current branch.`;
  }
  const more = Number.isFinite(total) && total > shown.length
    ? (arabic ? ` وفي ${amount(total - shown.length)} غيرهم.` : ` ${amount(total - shown.length)} more.`)
    : '';
  const heading = arabic ? `المنتجات${scope}:` : `Products${scope}:`;
  return [heading, ...shown.map((line) => `- ${line}`)].join('\n') + more;
}

function stockReply(item, arabic) {
  if (!item) return '';
  const stock = amount(item.stock);
  if (arabic) {
    if (item.trackInventory === false) return `«${item.name}» مش متتبَّع بالمخزون.`;
    if (Number(item.stock) <= 0) return `«${item.name}» مخزونه صفر في الفرع الحالي.`;
    return `«${item.name}» متوفر ${stock}${unitSuffix(item)} في الفرع الحالي.`;
  }
  if (item.trackInventory === false) return `"${item.name}" does not track inventory.`;
  if (Number(item.stock) <= 0) return `"${item.name}" has no stock in the current branch.`;
  return `"${item.name}" has ${stock}${unitSuffix(item)} in stock in the current branch.`;
}

function priceReply(item, currencySign, arabic) {
  if (!item) return '';
  if (!Number.isFinite(Number(item.sellingPrice))) {
    return arabic
      ? `سعر «${item.name}» مش مسجل في الفرع الحالي.`
      : `"${item.name}" has no selling price in the current branch.`;
  }
  const price = money(item.sellingPrice, currencySign);
  return arabic ? `سعر «${item.name}»: ${price}.` : `The price of "${item.name}" is ${price}.`;
}

function profitReply(rows, categoryName, arabic) {
  const ranked = (Array.isArray(rows) ? rows : [])
    .filter((item) => Number.isFinite(Number(item.sellingPrice)) && Number.isFinite(Number(item.costPrice)))
    .map((item) => ({
      item,
      margin: Number(item.sellingPrice) - Number(item.costPrice),
    }))
    .sort((left, right) => right.margin - left.margin);
  if (!ranked.length) {
    return arabic
      ? 'مفيش منتجات بسعر بيع وتكلفة معروفين في الفرع الحالي.'
      : 'No products have both a selling price and a cost price in the current branch.';
  }
  const scope = categoryName
    ? (arabic ? ` في فئة «${categoryName}»` : ` in the category "${categoryName}"`)
    : '';
  const lines = ranked.slice(0, 3).map(({ item, margin }) => {
    if (arabic) {
      return `«${item.name}» — بيع ${amount(item.sellingPrice)}، تكلفة ${amount(item.costPrice)}، هامش ${amount(margin)}.`;
    }
    return `"${item.name}" — selling ${amount(item.sellingPrice)}, cost ${amount(item.costPrice)}, margin ${amount(margin)}.`;
  });
  const heading = arabic
    ? `أعلى هامش ربح للوحدة${scope}:`
    : `Highest unit margin${scope}:`;
  return [heading, ...lines.map((line) => `- ${line}`)].join('\n');
}

function listToolResult(base, results) {
  return {
    ...base,
    kind: 'product_list',
    count: (results || []).length,
    results: (results || []).slice(0, CARD_LIMIT),
  };
}

async function loadProfitRows(api, categoryId) {
  const rows = [];
  let total = 0;
  let hasMore = false;
  for (let page = 1; page <= PROFIT_MAX_PAGES; page += 1) {
    const result = await listProducts({
      limit: PROFIT_PAGE_LIMIT,
      page,
      categoryId: categoryId || '',
    }, { api });
    if (!result || result.kind === 'error') return { error: result };
    if (page === 1) total = Number(result.total) || result.count;
    rows.push(...(result.results || []));
    hasMore = !!result.hasMore;
    if (!hasMore) break;
  }
  return { rows, total, hasMore };
}

async function runLiveRead({ intent, message, api, currencySign = '' } = {}) {
  const action = String((intent && intent.action) || '');
  if (!api || typeof api.get !== 'function') return null;
  if (!intent || intent.confidence === 'low') return null;
  if (!['read_stock', 'read_price', 'read_count', 'read_profit', 'list_products'].includes(action)) {
    return null;
  }
  /* The same lexicon extractIntent uses: an arithmetic, average or target
     sentence never gets an answer from rows, even when a caller built a read
     intent by hand. pickProduct below is the structural guard; this is the
     cheap first filter. */
  if (isAnalyticAsk(message, action)) return null;

  const arabic = isArabic(message);
  const query = String((intent && intent.query) || '').trim();
  const categoryName = intent && intent.category && intent.category.name
    ? String(intent.category.name).trim()
    : '';
  const categoryChoice = intent && intent.category && intent.category.choice
    ? String(intent.category.choice)
    : '';
  if (categoryName && categoryChoice && categoryChoice !== 'named' &&
      categoryChoice !== 'create') {
    return null;
  }

  let category = null;
  if (categoryName) {
    const resolved = await resolveCategory(api, categoryName);
    if (!resolved.ok) return null;
    if (!resolved.category) {
      const text = arabic
        ? `مش لاقي فئة اسمها «${categoryName}» في الفرع الحالي.`
        : `No category named "${categoryName}" exists in the current branch.`;
      return { handled: true, kind: 'text', text, toolCalls: [] };
    }
    category = resolved.category;
  }

  if (action === 'read_stock' || action === 'read_price') {
    if (!query) return null;
    const result = await searchFor(api, query);
    if (!result || result.kind === 'error') return null;
    const picked = pickProduct(result.results, query);
    /* Close but not exact: fall through to the model instead of quoting a
       row the user never named (BEHAVIOR.md confirms close matches first). */
    if (picked.kind === 'close') return null;
    if (picked.kind === 'none') {
      return {
        handled: true,
        kind: 'text',
        text: arabic
          ? `مفيش منتج بالاسم «${query}» في الفرع الحالي.`
          : `No product named "${query}" exists in the current branch.`,
        toolCalls: [productToolCall(result)],
      };
    }
    if (picked.kind === 'many') {
      return {
        handled: true,
        kind: 'text',
        text: nameQuestion(picked.items, arabic),
        toolCalls: [productToolCall(result)],
      };
    }
    return {
      handled: true,
      kind: 'text',
      text: action === 'read_stock'
        ? stockReply(picked.item, arabic)
        : priceReply(picked.item, currencySign, arabic),
      toolCalls: [productToolCall(result)],
    };
  }

  if (action === 'read_count') {
    if (query && !category) {
      const result = await searchFor(api, query);
      if (!result || result.kind === 'error') return null;
      const names = productNames(result.results).slice(0, 5);
      const text = arabic
        ? (result.count
          ? `لقيت ${amount(result.count)} منتج مطابق لـ «${query}»: ${names.map((name) => `«${name}»`).join('، ')}.`
          : `مفيش منتج مطابق لـ «${query}» في الفرع الحالي.`)
        : (result.count
          ? `Found ${amount(result.count)} matching products for "${query}": ${names.map((name) => `"${name}"`).join(', ')}.`
          : `No products matched "${query}" in the current branch.`);
      return { handled: true, kind: 'text', text, toolCalls: [productToolCall(result)] };
    }
    const result = await listProducts({
      limit: LIST_LIMIT,
      page: 1,
      categoryId: category ? category.id : '',
    }, { api });
    if (!result || result.kind === 'error') return null;
    const total = Number.isFinite(Number(result.total)) ? Number(result.total) : result.count;
    const toolResult = { ...result, categoryName: category ? category.name : '' };
    return {
      handled: true,
      kind: 'text',
      text: countReply(total, category ? category.name : '', arabic),
      toolCalls: [hiddenToolCall(toolResult)],
    };
  }

  if (action === 'read_profit') {
    const loaded = await loadProfitRows(api, category ? category.id : '');
    if (loaded.error) return null;
    const rows = loaded.rows;
    const ranked = rows.slice().sort((left, right) =>
      (Number(right.sellingPrice) - Number(right.costPrice)) -
      (Number(left.sellingPrice) - Number(left.costPrice)));
    const base = {
      kind: 'product_list',
      query: '',
      categoryId: category ? category.id : '',
      categoryName: category ? category.name : '',
      total: Number.isFinite(loaded.total) ? loaded.total : rows.length,
      page: 1,
      totalPages: 1,
      hasMore: false,
    };
    return {
      handled: true,
      kind: 'text',
      text: profitReply(rows, category ? category.name : '', arabic),
      toolCalls: [productToolCall(listToolResult(base, ranked))],
    };
  }

  /* list_products */
  const result = await listProducts({
    limit: LIST_LIMIT,
    page: 1,
    categoryId: category ? category.id : '',
  }, { api });
  if (!result || result.kind === 'error') return null;
  return {
    handled: true,
    kind: 'text',
    text: listReply(result, category ? category.name : '', arabic),
    toolCalls: [productToolCall({
      ...result,
      categoryName: category ? category.name : '',
    })],
  };
}

module.exports = {
  amount,
  listReply,
  money,
  priceReply,
  profitReply,
  runLiveRead,
  stockReply,
};
