'use strict';

const { smartRegexPattern } = require('../utils/smart-search');

const SEARCH = ['name', 'sku', 'barcode', 'plu', 'supplier', 'category', 'location'];
const DISPLAY = ['sku', 'barcode', 'supplier', 'category', 'price', 'stock', 'image', 'location'];
const DEFAULT_SEARCH = ['name', 'sku', 'barcode', 'plu'];
const MAX_SMART_TERMS = 12;

function validate(key, value) {
  if (value === null) return null;
  const allowed = key === 'sales_search_fields' ? SEARCH : DISPLAY;
  if (
    !Array.isArray(value) ||
    value.some((field) => !allowed.includes(field)) ||
    (key === 'sales_search_fields' && !value.length)
  ) {
    throw new Error('Choose valid sales search fields; select at least one field to search.');
  }
  return [...new Set(value)];
}

function conditions(fields, query, regex) {
  const selected = Array.isArray(fields) && fields.length ? fields : DEFAULT_SEARCH;
  const columns = {
    name: ['name', 'translations.name'],
    sku: ['itemid', 'item_code'],
    barcode: ['barcode_id', 'barcodes'],
    supplier: ['supplier_name'],
    category: ['category_name'],
    location: ['stock_locations'],
  };
  return selected.flatMap((field) =>
    field === 'plu'
      ? [
          { short_code: regex },
          ...(/^\d{1,6}$/.test(String(query)) ? [{ plu_code: String(query) }] : []),
        ]
      : (columns[field] || []).map((column) => ({ [column]: regex }))
  );
}

/*
 * Expanded spellings for the text fields only. A code is an identifier: the
 * sale screen must not look up every product containing "2" because somebody
 * said "اتنين", while a product name should still be found when the cashier
 * says it in Egyptian Arabic or types the English word.
 */
function smartConditions(fields, expansion) {
  if (!expansion) return [];
  const selected = Array.isArray(fields) && fields.length ? fields : DEFAULT_SEARCH;
  const columns = {
    name: ['name', 'translations.name'],
    supplier: ['supplier_name'],
    category: ['category_name'],
    location: ['stock_locations'],
  };
  const terms = [
    ...new Set(
      [
        ...(expansion.tokens || []),
        ...(expansion.forms || []).filter((form) => !String(form).includes(' ')),
        ...(expansion.phrases || []),
      ]
        .map((term) => String(term || '').trim())
        .filter(Boolean)
    ),
  ].slice(0, MAX_SMART_TERMS);
  if (!terms.length) return [];

  return selected.flatMap((field) => {
    const fieldColumns = columns[field];
    if (!fieldColumns) return [];
    return fieldColumns.flatMap((column) =>
      terms.map((term) => ({ [column]: { $regex: smartRegexPattern(term), $options: 'i' } }))
    );
  });
}

/*
 * The derived item index is what makes a typo or a sound-alike reachable at
 * all: a regex cannot match "بيبسي" to "pepse" and still be safe and fast.
 * Only search it when the cashier chose the name field; a configuration that
 * searches SKUs alone must not suddenly return catalogue names.
 */
function fuzzyConditions(fields, expansion) {
  if (!expansion) return [];
  const selected = Array.isArray(fields) && fields.length ? fields : DEFAULT_SEARCH;
  if (!selected.includes('name')) return [];
  const conditions = [];
  if (Array.isArray(expansion.ngrams) && expansion.ngrams.length) {
    conditions.push({ search_ngrams: { $in: expansion.ngrams } });
  }
  if (Array.isArray(expansion.phonetics) && expansion.phonetics.length) {
    conditions.push({ search_phonetics: { $in: expansion.phonetics } });
  }
  return conditions;
}

function exactNumericCodes(query, fields) {
  const selected = Array.isArray(fields) && fields.length ? fields : DEFAULT_SEARCH;
  const columns = {
    sku: ['itemid', 'item_code'],
    barcode: ['barcode_id', 'barcodes'],
    plu: ['short_code', 'plu_code'],
  };
  const values = [String(query)];
  if (String(Number(query)) === query && Number.isSafeInteger(Number(query)))
    values.push(Number(query));
  return selected.flatMap((field) =>
    (columns[field] || []).map((column) => ({ [column]: { $in: values } }))
  );
}
module.exports = {
  SEARCH,
  DISPLAY,
  DEFAULT_SEARCH,
  validate,
  conditions,
  smartConditions,
  fuzzyConditions,
  exactNumericCodes,
};
