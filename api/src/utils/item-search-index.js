'use strict';

/*
 * Item search index.
 *
 * The POS searches a shop's catalogue by name, category, description, brand,
 * tags, shelf location, SKU and barcode. A cashier types "pepsi", "بيبسي",
 * "pepse" or half a barcode; the result must be the same short, ranked list.
 *
 * The index is derived data. It is written beside the item document, travels
 * with it through sync, and can be rebuilt at any time from the source fields.
 * The version lets a future change re-index only the documents that need it.
 *
 * Normalisation is deliberately shared by the write paths, the backfill and
 * the query builder. If they drift, a word can be indexed one way and searched
 * another, and the product silently disappears from results.
 */

const { nameSimilarity } = require('./smart-name-search');

const SEARCH_INDEX_VERSION = 1;
const MAX_TEXT_CHARS = 4000;
const MAX_TOKENS = 512;
const MAX_NGRAMS = 2048;

function normalizeSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeSearchText(value) {
  const text = normalizeSearchText(value);
  return text ? text.split(' ') : [];
}

function ngramsForToken(token) {
  const chars = Array.from(token);
  if (chars.length < 2) return [];
  const grams = [];
  if (chars.length === 2) {
    grams.push(token);
    return grams;
  }
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= chars.length - size; index += 1) {
      grams.push(chars.slice(index, index + size).join(''));
    }
  }
  return grams;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceValues(source) {
  if (!source || typeof source !== 'object') return [];
  const translations = Array.isArray(source.translations) ? source.translations : [];
  return [
    source.name,
    source.category_name,
    source.description,
    source.brand,
    source.sku,
    source.itemid,
    source.barcode_id,
    source.plu_code,
    source.gtin,
    source.gtin14,
    source.variant_parent_name,
    source.variant_value,
    ...(Array.isArray(source.tags) ? source.tags : []),
    ...(Array.isArray(source.stock_locations) ? source.stock_locations : []),
    ...(Array.isArray(source.barcodes) ? source.barcodes : []),
    ...translations.flatMap((entry) => [entry && entry.name, entry && entry.description]),
  ];
}

/**
 * Build the stored fields for one item.
 *
 * @param {object} source item document or a merged update payload
 * @returns {{search_text: string, search_tokens: string[], search_ngrams: string[], search_index_version: number}
 */
function buildSearchIndex(source) {
  const text = normalizeSearchText(sourceValues(source).filter(Boolean).join(' ')).slice(
    0,
    MAX_TEXT_CHARS
  );
  const tokens = unique(text ? text.split(' ') : []).slice(0, MAX_TOKENS);
  const ngrams = unique(tokens.flatMap(ngramsForToken)).slice(0, MAX_NGRAMS);
  return {
    search_text: text,
    search_tokens: tokens,
    search_ngrams: ngrams,
    search_index_version: SEARCH_INDEX_VERSION,
  };
}

function withSearchIndex(document) {
  return { ...document, ...buildSearchIndex(document) };
}

function stripSearchIndex(document) {
  if (!document || typeof document !== 'object') return document;
  delete document.search_text;
  delete document.search_tokens;
  delete document.search_ngrams;
  delete document.search_index_version;
  return document;
}

function escapeSearchRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function itemSearchFields(doc) {
  const translations = Array.isArray(doc.translations) ? doc.translations : [];
  return {
    name: normalizeSearchText(doc.name),
    category: normalizeSearchText(doc.category_name),
    description: normalizeSearchText(doc.description),
    brand: normalizeSearchText(doc.brand),
    tags: normalizeSearchText((doc.tags || []).join(' ')),
    locations: normalizeSearchText((doc.stock_locations || []).join(' ')),
    translations: normalizeSearchText(
      translations
        .map((entry) => [entry && entry.name, entry && entry.description].filter(Boolean).join(' '))
        .join(' ')
    ),
    codes: [
      doc.barcode_id,
      doc.sku,
      doc.itemid,
      doc.plu_code,
      doc.gtin,
      doc.gtin14,
      ...(Array.isArray(doc.barcodes) ? doc.barcodes : []),
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Rank one candidate against a normalized query.
 *
 * The score is intentionally explainable: an exact code beats an exact name,
 * a name prefix beats a description hit, and a token hit beats a typo-only
 * n-gram hit. A candidate that shares only one generic n-gram is rejected, so
 * "soap" does not start finding "soup".
 */
function scoreSearchCandidate(doc, query, queryTokens, queryNgrams) {
  const fields = itemSearchFields(doc);
  let score = 0;

  if (fields.codes.includes(String(query || '').toLowerCase())) score += 120;
  if (fields.name === query) score += 100;
  else if (fields.name.startsWith(query)) score += 80;
  else if (fields.name.includes(query)) score += 60;
  /* An edit-distance hit on the name is stronger than a description match.
     It is what catches a short transposition or a dropped letter when the
     shared n-grams alone would rank the product too low. */
  const nameAffinity = nameSimilarity(query, fields.name);
  if (nameAffinity >= 0.6) score += Math.round(nameAffinity * 40);
  if (fields.category.includes(query)) score += 30;
  if (fields.brand.includes(query)) score += 25;
  if (fields.tags.includes(query)) score += 20;
  if (fields.translations.includes(query)) score += 18;
  if (fields.description.includes(query)) score += 15;
  if (fields.locations.includes(query)) score += 10;

  const docTokens = Array.isArray(doc.search_tokens) ? doc.search_tokens : [];
  const tokenSet = new Set(docTokens);
  let tokenHits = 0;
  for (const token of queryTokens) {
    if (tokenSet.has(token)) tokenHits += 2;
    else if (docTokens.some((entry) => entry.startsWith(token))) tokenHits += 1;
  }
  score += tokenHits * 8;

  const docNgrams = new Set(Array.isArray(doc.search_ngrams) ? doc.search_ngrams : []);
  let ngramHits = 0;
  for (const gram of queryNgrams) {
    if (docNgrams.has(gram)) ngramHits += 1;
  }
  if (queryNgrams.length) {
    const ratio = ngramHits / queryNgrams.length;
    score += Math.round(ratio * 30);
    /* A shared generic n-gram alone is still not a match ("soap" / "soup").
       The edit-distance boost above only improves the order of candidates
       that already share a token or enough n-grams. */
    if (!tokenHits && ratio < 0.3) return 0;
  }

  return score;
}

function compareSearchCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  const leftName = String(left.doc.name || '').toLowerCase();
  const rightName = String(right.doc.name || '').toLowerCase();
  if (leftName !== rightName) return leftName.localeCompare(rightName);
  return String(right.doc.updated_date || '').localeCompare(String(left.doc.updated_date || ''));
}

module.exports = {
  MAX_NGRAMS,
  MAX_TEXT_CHARS,
  MAX_TOKENS,
  SEARCH_INDEX_VERSION,
  buildSearchIndex,
  compareSearchCandidates,
  escapeSearchRegex,
  itemSearchFields,
  ngramsForToken,
  normalizeSearchText,
  scoreSearchCandidate,
  sourceValues,
  stripSearchIndex,
  tokenizeSearchText,
  unique,
  withSearchIndex,
};
