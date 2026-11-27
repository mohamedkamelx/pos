/*
 * What the read tools actually put in front of the model.
 *
 * The model only ever sees the formatter's text, never the mapped row. Cost
 * was mapped from the API and then dropped on the way out, so every margin,
 * markup and "cost stuck in the store" question had one answer: ask the user
 * for a number the database already had. These tests pin the projection, not
 * the wording.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { formatForModel: formatSearch } = require(path.join(ROOT, 'src', 'ai', 'tools', 'search-products.js'));
const { formatForModel: formatList } = require(path.join(ROOT, 'src', 'ai', 'tools', 'list-products.js'));

function searchResult(costPrice) {
  return {
    kind: 'product_search',
    query: 'iron',
    count: 1,
    results: [{
      id: 'item-1',
      name: 'Tefal iron 2000W',
      category: 'Appliances',
      sellingPrice: 1600,
      costPrice,
      stock: 10,
      unit: '',
      barcode: '2000000000017',
      sku: 'TEF-2000',
    }],
  };
}

function listResult(costPrice) {
  return {
    kind: 'product_list',
    query: '',
    categoryName: 'Appliances',
    count: 1,
    total: 1,
    page: 1,
    totalPages: 1,
    hasMore: false,
    results: [{
      id: 'item-1',
      name: 'Tefal iron 2000W',
      category: 'Appliances',
      sellingPrice: 1600,
      costPrice,
      stock: 10,
      unit: 'pcs',
    }],
  };
}

test('a search row shows the cost the model needs for a margin', () => {
  const text = formatSearch(searchResult(1200));
  assert.match(text, /price: 1600/, 'the selling price must be there');
  assert.match(text, /cost: 1200/, 'margin cannot be computed without cost');
  /* Both halves of margin = (price - cost) / price arrive in the same row. */
  assert.match(text, /stock: 10/);
});

test('a list row shows the cost so a whole-shelf total is computable', () => {
  const text = formatList(listResult(1200));
  assert.match(text, /price: 1600/);
  assert.match(text, /cost: 1200/);
  assert.match(text, /stock: 10/);
});

test('an unset cost is omitted rather than shown as a real zero', () => {
  /* The prompt forbids treating an unknown cost as zero. Printing "cost: 0"
     would hand the model exactly that trap. */
  assert.doesNotMatch(formatSearch(searchResult(0)), /cost:/);
  assert.doesNotMatch(formatList(listResult(0)), /cost:/);
  assert.doesNotMatch(formatSearch(searchResult(undefined)), /cost:/);
});

test('the row still carries the code fields a single match needs', () => {
  const text = formatSearch(searchResult(1200));
  assert.match(text, /barcode: 2000000000017/, 'barcodes stay in Latin digits');
  assert.match(text, /sku: TEF-2000/);
});
