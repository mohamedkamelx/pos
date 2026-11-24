'use strict';

/*
 * Give every existing branch's placeholder customer and supplier their Arabic
 * names.
 *
 * New installs and branch self-heal paths write `زبون محل` and `مورد عام`
 * from utils/default-parties.js. A shop that was installed before that change
 * still has `Walk-in Customer` and `General Supplier` in its database. Those
 * strings are data, not translation keys, so changing the language catalog
 * does nothing for them.
 *
 * The migration only renames records that are recognisably the placeholder:
 * the branch's `default_customer`/`default_supplier` target, or a record whose
 * name matches the walk-in/general-supplier pattern. It never touches a named
 * party. Running it twice is a no-op because the canonical name is already
 * excluded.
 *
 * Sale and purchase snapshots keep the name that was true when the document
 * was saved. The print path already recognises both spellings, so an old bill
 * still hides the walk-in placeholder instead of printing it.
 */

const {
  WALK_IN_NAME,
  GENERAL_SUPPLIER_NAME,
  isWalkIn,
  isGeneralSupplier,
} = require('../../utils/default-parties');

// Deliberately looser than the canonical matcher so trailing whitespace and
// old spellings reach isWalkIn/isGeneralSupplier, which make the exact call.
const WALK_IN_CANDIDATE = /walk[\s._-]?in|زبون\s*(?:ال)?محل|(?:عميل|زبون)\s*عابر/i;
const GENERAL_SUPPLIER_CANDIDATE = /general\s+supplier|مورد\s+عام|المورد\s+العام/i;

async function renameMatches(collection, query, predicate, canonical, now) {
  const renamed = [];
  const cursor = collection.find(query, { projection: { name: 1 } });
  for await (const row of cursor) {
    if (row.name === canonical || !predicate(row.name)) continue;
    await collection.updateOne({ _id: row._id }, { $set: { name: canonical, updated_date: now } });
    renamed.push(row._id);
  }
  return renamed;
}

module.exports = async function arabicDefaultPartyNames(db) {
  if (!db) throw new Error('arabic-default-party-names needs a database handle');

  const now = new Date();
  const customers = db.collection('customers');
  const suppliers = db.collection('suppliers');
  const partyPayments = db.collection('party_payments');

  /*
   * Start from the branch pointers. This is the exact record a branch will use
   * for its next cash sale or quick purchase, so it must be right even if a
   * shop renamed the record to something that no longer looks like a
   * placeholder.
   */
  const branches = db.collection('branches');
  const renamedCustomers = [];
  const renamedSuppliers = [];
  const branchRows = await branches
    .find(
      { $or: [{ default_customer: { $exists: true } }, { default_supplier: { $exists: true } }] },
      { projection: { default_customer: 1, default_supplier: 1 } }
    )
    .toArray();
  for (const branch of branchRows) {
    if (branch.default_customer) {
      const row = await customers.findOne(
        { _id: branch.default_customer },
        { projection: { name: 1 } }
      );
      if (row && row.name !== WALK_IN_NAME && isWalkIn(row.name)) {
        await customers.updateOne(
          { _id: row._id },
          { $set: { name: WALK_IN_NAME, updated_date: now } }
        );
        renamedCustomers.push(row._id);
      }
    }
    if (branch.default_supplier) {
      const row = await suppliers.findOne(
        { _id: branch.default_supplier },
        { projection: { name: 1 } }
      );
      if (row && row.name !== GENERAL_SUPPLIER_NAME && isGeneralSupplier(row.name)) {
        await suppliers.updateOne(
          { _id: row._id },
          { $set: { name: GENERAL_SUPPLIER_NAME, updated_date: now } }
        );
        renamedSuppliers.push(row._id);
      }
    }
  }

  /*
   * Then sweep any remaining placeholder spellings. A branch may have lost its
   * pointer over the years, or an older install path may have created the same
   * record without setting one.
   */
  renamedCustomers.push(
    ...(await renameMatches(
      customers,
      { name: { $regex: WALK_IN_CANDIDATE } },
      isWalkIn,
      WALK_IN_NAME,
      now
    ))
  );
  renamedSuppliers.push(
    ...(await renameMatches(
      suppliers,
      { name: { $regex: GENERAL_SUPPLIER_CANDIDATE } },
      isGeneralSupplier,
      GENERAL_SUPPLIER_NAME,
      now
    ))
  );

  /*
   * The ledger keeps a display name beside the party id. New rows read the
   * party document, but old statements and exports may show the ledger name,
   * so keep it in step with the record it belongs to.
   */
  if (renamedCustomers.length) {
    await partyPayments.updateMany(
      { party_type: 'customer', party_id: { $in: renamedCustomers } },
      { $set: { party_name: WALK_IN_NAME, updated_date: now } }
    );
  }
  if (renamedSuppliers.length) {
    await partyPayments.updateMany(
      { party_type: 'supplier', party_id: { $in: renamedSuppliers } },
      { $set: { party_name: GENERAL_SUPPLIER_NAME, updated_date: now } }
    );
  }
};
