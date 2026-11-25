'use strict';

/*
 * Build the item search index for every existing product.
 *
 * The index is derived data, but it has to exist before the first search:
 * a cashier who types a misspelled product name should get the same answer on
 * the day of the upgrade as on the day after. New writes keep it current; this
 * migration handles the catalogue that was already in the database.
 *
 * The version field makes the migration restartable. A crash halfway through
 * leaves the processed documents at version 1, and the next run skips them.
 */

const { SEARCH_INDEX_VERSION, buildSearchIndex } = require('../../utils/item-search-index');

const BATCH_SIZE = 500;

const SEARCH_PROJECTION = {
  name: 1,
  description: 1,
  category_name: 1,
  brand: 1,
  tags: 1,
  stock_locations: 1,
  translations: 1,
  sku: 1,
  barcode_id: 1,
  itemid: 1,
  plu_code: 1,
  gtin: 1,
  gtin14: 1,
  barcodes: 1,
  variant_parent_name: 1,
  variant_value: 1,
};

module.exports = async function itemSearchIndex(db) {
  const items = db.collection('items');
  let processed = 0;

  const cursor = items.find(
    { search_index_version: { $ne: SEARCH_INDEX_VERSION } },
    { projection: SEARCH_PROJECTION }
  );

  let operations = [];
  for await (const item of cursor) {
    operations.push({
      updateOne: {
        filter: { _id: item._id },
        update: { $set: buildSearchIndex(item) },
      },
    });
    if (operations.length >= BATCH_SIZE) {
      await items.bulkWrite(operations, { ordered: false });
      processed += operations.length;
      operations = [];
    }
  }
  if (operations.length) {
    await items.bulkWrite(operations, { ordered: false });
    processed += operations.length;
  }

  await items.createIndex(
    { license: 1, branch_id: 1, search_tokens: 1 },
    { name: 'item_search_tokens' }
  );
  await items.createIndex(
    { license: 1, branch_id: 1, search_ngrams: 1 },
    { name: 'item_search_ngrams' }
  );

  return { processed };
};
