'use strict';

/*
 * The item search migration has to be safe to run on a live shop database:
 * it backfills every existing product, creates the indexes the search uses,
 * and can be re-run after a crash without redoing finished work.
 */

const migration = require('../../../src/db/migrations/008-item-search-index');
const { SEARCH_INDEX_VERSION } = require('../../../src/utils/item-search-index');

function fakeDatabase(documents) {
  const updates = [];
  const indexes = [];
  const collection = {
    find(filter) {
      const excluded = filter && filter.search_index_version
        ? filter.search_index_version.$ne
        : undefined;
      const rows = documents.filter(
        (doc) => excluded === undefined || doc.search_index_version !== excluded
      );
      return {
        async *[Symbol.asyncIterator]() {
          for (const row of rows) yield row;
        },
      };
    },
    async bulkWrite(operations) {
      updates.push(...operations);
      for (const operation of operations) {
        const target = documents.find(
          (doc) => doc._id === operation.updateOne.filter._id
        );
        if (target) Object.assign(target, operation.updateOne.update.$set);
      }
    },
    async createIndex(keys, options) {
      indexes.push({ keys, options });
    },
  };
  return {
    db: { collection: (name) => (name === 'items' ? collection : null) },
    updates,
    indexes,
  };
}

describe('item search migration', () => {
  test('backfills every item and creates the search indexes', async () => {
    const { db, updates, indexes } = fakeDatabase([
      { _id: '1', name: 'Pepsi 1L' },
      { _id: '2', name: 'بيبسي' },
    ]);

    const result = await migration(db);

    expect(result.processed).toBe(2);
    expect(updates).toHaveLength(2);
    expect(updates[0].updateOne.update.$set.search_index_version).toBe(
      SEARCH_INDEX_VERSION
    );
    expect(updates[0].updateOne.update.$set.search_tokens).toContain('pepsi');
    expect(updates[1].updateOne.update.$set.search_tokens).toContain('بيبسي');
    expect(indexes.map((entry) => entry.options.name)).toEqual([
      'item_search_tokens',
      'item_search_ngrams',
    ]);
  });

  test('skips documents that are already on the current index version', async () => {
    const { db, updates } = fakeDatabase([
      { _id: '1', name: 'Pepsi 1L', search_index_version: SEARCH_INDEX_VERSION },
    ]);

    const result = await migration(db);

    expect(result.processed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  test('is restartable: a second run does no work', async () => {
    const { db, updates } = fakeDatabase([{ _id: '1', name: 'Pepsi 1L' }]);

    await migration(db);
    await migration(db);

    expect(updates).toHaveLength(1);
  });
});
