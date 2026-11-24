'use strict';

/*
 * Remove every record the old sample-data packs left behind.
 *
 * Demo packs are gone from the installer and from the product. There is no
 * switch left to hide them and no screen that should ever show them again, so
 * the rows themselves are deleted once. This is intentionally broader than the
 * old "remove samples" action: that action protected records a shop had edited,
 * sold or received, which was correct while the samples could still be turned
 * back on. They cannot be turned back on now, and half-removed samples are
 * worse than none.
 *
 * The tag is `demo_pack`, written by every pack seeded since August 2026.
 * Older sales, purchases and quotes predate the tag and are found by the id
 * pattern the seeder used. No real document carries those prefixes: running
 * numbers are S-000001, R-000001 and QUO-000001.
 *
 * Idempotent: deleteMany on an already-clean collection is a no-op, so a crash
 * between the deletion and the ledger write simply repeats the same work.
 */
const TAGGED_COLLECTIONS = [
  'items',
  'categories',
  'customers',
  'suppliers',
  'sales',
  'receivings',
  'quotes',
];

const LEGACY_IDS = {
  sales: 'sales_id',
  receivings: 'receiving_id',
  quotes: 'quote_id',
};

async function removeDemoRecords(db) {
  for (const name of TAGGED_COLLECTIONS) {
    const collection = db.collection(name);
    const legacyField = LEGACY_IDS[name];
    const query = legacyField
      ? {
          $or: [
            { demo_pack: { $exists: true } },
            { [legacyField]: { $regex: '^(S|R|QUO)-DEMO-' } },
          ],
        }
      : { demo_pack: { $exists: true } };
    await collection.deleteMany(query);
  }

  /*
   * Recycled samples are still samples. The bin has held more than one shape
   * over the years (a `document` field, a `body` field, and a flat copy), so
   * all three are checked rather than assuming today's writer.
   */
  await db.collection('recycle_bin').deleteMany({
    $or: [
      { demo_pack: { $exists: true } },
      { 'document.demo_pack': { $exists: true } },
      { 'body.demo_pack': { $exists: true } },
    ],
  });
}

module.exports = removeDemoRecords;
