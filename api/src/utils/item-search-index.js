'use strict';

/*
 * Item search index.
 *
 * The POS searches a shop's catalogue by name, category, description, brand,
 * tags, shelf location, SKU and barcode. A cashier types "pepsi", "بيبسي",
 * "pepse", "شرب" or half a barcode; the result must be the same short,
 * ranked list.
 *
 * The index is derived data. It is written beside the item document, travels
 * with it through sync, and can be rebuilt at any time from the source fields.
 * The version lets a future change re-index only the documents that need it.
 *
 * Normalisation is deliberately shared by the write paths, the backfill and
 * the query builder. If they drift, a word can be indexed one way and searched
 * another, and the product silently disappears from results.
 */

const {
  expandQuery,
  nameSimilarity,
  ngramsForToken,
  normalizeSearchText,
  phoneticKey,
  rootKey,
  scoreNameMatch,
  stemToken,
  tokenizeSearchText,
  trigramSimilarity,
  unique,
} = require('./smart-search');

const SEARCH_INDEX_VERSION = 2;
const MAX_TEXT_CHARS = 4000;
const MAX_TOKENS = 512;
const MAX_NGRAMS = 2048;

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
 * @returns {{search_text: string, search_tokens: string[], search_ngrams: string[], search_phonetics: string[], search_index_version: number}}
 */
function buildSearchIndex(source) {
  const text = normalizeSearchText(sourceValues(source).filter(Boolean).join(' ')).slice(
    0,
    MAX_TEXT_CHARS
  );
  const tokens = unique(text ? text.split(' ') : []).slice(0, MAX_TOKENS);
  const ngrams = unique(tokens.flatMap(ngramsForToken)).slice(0, MAX_NGRAMS);
  /* A separate field lets a query such as "شرب" find the product "Sharp"
     without making every ordinary token match a sound-alike. Short keys are
     deliberately dropped: "soap" and "soup" share "sb", which is not
     evidence that they are the same product. */
  const phonetics = unique(tokens.map(phoneticKey))
    .filter((key) => key.length >= 3 && !/^[0-9]+$/.test(key))
    .slice(0, MAX_TOKENS);
  return {
    search_text: text,
    search_tokens: tokens,
    search_ngrams: ngrams,
    search_phonetics: phonetics,
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
  delete document.search_phonetics;
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
      .map((value) =>
        String(value || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean),
  };
}

function docTokenForms(tokens) {
  const forms = new Set();
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token) continue;
    forms.add(token);
    const stem = stemToken(token);
    if (stem) forms.add(stem);
    const root = rootKey(token);
    if (root) forms.add(root);
  }
  return forms;
}

/**
 * Rank one candidate against a query.
 *
 * The score is intentionally explainable: an exact code beats an exact name,
 * a name prefix beats a description hit, a shared stem or sound key beats a
 * typo-only n-gram hit, and context (the category the conversation is in)
 * breaks ties. A candidate that shares only one generic n-gram is rejected,
 * so "soap" does not start finding "soup".
 *
 * `queryTokens` may be the legacy array of tokens or the expansion object
 * returned by expandQuery(). The legacy form remains supported because the
 * index tests and older callers pass it directly.
 */
function scoreSearchCandidate(doc, query, queryTokens, queryNgrams, options = {}) {
  const normalizedQuery = normalizeSearchText(query);
  const expansion =
    queryTokens && !Array.isArray(queryTokens) && queryTokens.normalized
      ? queryTokens
      : expandQuery(normalizedQuery, options);
  const tokens = Array.isArray(queryTokens) ? unique(queryTokens) : expansion.tokens;
  const ngrams = Array.isArray(queryNgrams) ? queryNgrams : expansion.ngrams;
  const fields = itemSearchFields(doc);
  let score = 0;

  if (fields.codes.includes(normalizedQuery)) score += 120;
  if (fields.name === normalizedQuery) score += 100;
  else if (fields.name.startsWith(normalizedQuery)) score += 80;
  else if (fields.name.includes(normalizedQuery)) score += 60;
  /* A stem, synonym or sound-alike hit on the name is stronger than a
     description match. It catches Arabic plurals and Egyptian pronunciation
     before the generic n-grams have to carry the result. */
  const nameAffinity = scoreNameMatch(normalizedQuery, fields.name);
  if (nameAffinity >= 0.6) score += Math.round(nameAffinity * 40);
  if (fields.category.includes(normalizedQuery)) score += 30;
  if (fields.brand.includes(normalizedQuery)) score += 25;
  if (fields.tags.includes(normalizedQuery)) score += 20;
  if (fields.translations.includes(normalizedQuery)) score += 18;
  if (fields.description.includes(normalizedQuery)) score += 15;
  if (fields.locations.includes(normalizedQuery)) score += 10;

  const docTokens = Array.isArray(doc.search_tokens) ? doc.search_tokens : [];
  const tokenSet = new Set(docTokens);
  let tokenHits = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) tokenHits += 2;
    else if (docTokens.some((entry) => entry.startsWith(token))) tokenHits += 1;
  }
  score += tokenHits * 8;

  const docForms = docTokenForms(docTokens);
  let formHits = 0;
  for (const form of expansion.forms) {
    if (form.length < 3 || /^[0-9]+$/.test(form)) continue;
    if (
      docForms.has(form) ||
      fields.name.includes(form) ||
      fields.category.includes(form) ||
      fields.brand.includes(form) ||
      fields.tags.includes(form) ||
      fields.translations.includes(form) ||
      fields.description.includes(form) ||
      fields.locations.includes(form)
    ) {
      formHits += 1;
    }
  }
  score += Math.min(formHits, 6) * 6;

  const docPhonetics = new Set(Array.isArray(doc.search_phonetics) ? doc.search_phonetics : []);
  let phoneticHits = 0;
  for (const key of expansion.phonetics) {
    if (docPhonetics.has(key)) phoneticHits += 1;
  }
  score += Math.min(phoneticHits, 4) * 10;

  const trigram = trigramSimilarity(normalizedQuery, fields.name);
  if (trigram >= 0.3) score += Math.round(trigram * 18);

  let contextHits = 0;
  for (const form of expansion.contextForms) {
    if (form.length < 3) continue;
    if (fields.category.includes(form) || fields.tags.includes(form) || fields.name.includes(form)) {
      contextHits += 1;
    }
  }
  score += Math.min(contextHits, 4) * 10;
  const contextCategory = normalizeSearchText(options.category);
  if (contextCategory && (fields.category === contextCategory || fields.category.includes(contextCategory))) {
    score += 20;
  }

  const docNgrams = new Set(Array.isArray(doc.search_ngrams) ? doc.search_ngrams : []);
  let ngramHits = 0;
  for (const gram of ngrams) {
    if (docNgrams.has(gram)) ngramHits += 1;
  }
  if (ngrams.length) {
    const ratio = ngramHits / ngrams.length;
    score += Math.round(ratio * 30);
    /* A shared generic n-gram alone is still not a match ("soap" / "soup").
       A stem or sound key of at least three characters is evidence; the
       edit-distance boost above only improves the order of candidates that
       already share a token, a strong form or enough n-grams. */
    if (!tokenHits && !formHits && !phoneticHits && ratio < 0.3) return 0;
  } else if (!tokenHits && !formHits && !phoneticHits) {
    return 0;
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
