'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const apiModules = path.join(__dirname, '..', 'api');
const { MongoMemoryServer } = require(
  require.resolve('mongodb-memory-server', { paths: [apiModules] })
);
const { MongoClient, ObjectId } = require(require.resolve('mongodb', { paths: [apiModules] }));
const migrate = require('../api/src/db/migrations/sale-line-cost-total');

/*
 * The migration decides which old rows stored a per-unit cost and which
 * already stored a line total. It must not scale a PHP import, a return or a
 * row it already repaired, and it must not leave an old Node sale priced at
 * one unit. This runs the real migration against synthetic documents and
 * checks both the line values and the document total.
 */
test('sale-line cost migration repairs old Node rows and leaves imported rows alone', async (t) => {
  const mongo = await MongoMemoryServer.create({
    binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY },
  });
  const client = await MongoClient.connect(mongo.getUri());
  const db = client.db('sale_line_cost_migration');
  t.after(async () => {
    await client.close();
    await mongo.stop();
  });

  const oldNode = {
    _id: new ObjectId(),
    idempotency_key: 'old-node',
    total_companyprice: 900,
    items: [{ item: new ObjectId(), item_quantity: 3, company_price_total: 900 }],
  };
  const missingDocumentTotal = {
    _id: new ObjectId(),
    idempotency_key: 'old-node-no-total',
    items: [{ item: new ObjectId(), item_quantity: 4, company_price_total: 25 }],
  };
  const ambiguousNode = {
    _id: new ObjectId(),
    idempotency_key: 'ambiguous-node',
    // The document total was already extended while the line still holds a
    // unit value. Nothing proves which convention this row used.
    total_companyprice: 50,
    items: [{ item: new ObjectId(), item_quantity: 2, company_price_total: 25 }],
  };
  const phpImport = {
    _id: new ObjectId(),
    sale_method: 'Live-Order',
    total_companyprice: 500,
    items: [{ item: new ObjectId(), item_quantity: 2, company_price_total: 500 }],
  };
  const partialReturn = {
    _id: new ObjectId(),
    idempotency_key: 'return-node',
    sale_process: 'PartialReturn',
    total_companyprice: 100,
    items: [{ item: new ObjectId(), quantity: 2, company_price_total: 100 }],
    items_return: [
      { returnArray: { returnValue: [{ quantity: 1, company_price_total: 50 }] } },
    ],
  };
  const headerOnly = {
    _id: new ObjectId(),
    idempotency_key: 'header-only',
    items: [],
    total_companyprice: 0,
  };
  const alreadyRepaired = {
    _id: new ObjectId(),
    idempotency_key: 'new-node',
    company_cost_basis: 'line-total',
    total_companyprice: 2700,
    items: [
      {
        item: new ObjectId(),
        quantity: 3,
        company_price_total: 2700,
        unit_company_price: 900,
      },
    ],
  };

  const sales = db.collection('sales');
  await sales.insertMany([
    oldNode,
    missingDocumentTotal,
    ambiguousNode,
    phpImport,
    partialReturn,
    headerOnly,
    alreadyRepaired,
  ]);

  await migrate(db);
  await migrate(db); // the migration is idempotent, as the runner requires

  const byId = new Map((await sales.find({}).toArray()).map((sale) => [String(sale._id), sale]));

  const repaired = byId.get(String(oldNode._id));
  assert.equal(repaired.items[0].company_price_total, 2700);
  assert.equal(repaired.items[0].unit_company_price, 900);
  assert.equal(repaired.total_companyprice, 2700);
  assert.equal(repaired.company_cost_basis, 'line-total');

  const missingTotal = byId.get(String(missingDocumentTotal._id));
  assert.equal(missingTotal.items[0].company_price_total, 100);
  assert.equal(missingTotal.items[0].unit_company_price, 25);
  assert.equal(missingTotal.total_companyprice, 100);

  // With no trustworthy document total, the line stays as it is.
  const ambiguous = byId.get(String(ambiguousNode._id));
  assert.equal(ambiguous.items[0].company_price_total, 25);
  assert.equal(ambiguous.company_cost_basis, 'line-total');

  const imported = byId.get(String(phpImport._id));
  assert.equal(imported.items[0].company_price_total, 500);
  assert.equal(imported.company_cost_basis, undefined);

  const returned = byId.get(String(partialReturn._id));
  assert.equal(returned.items[0].company_price_total, 100);
  assert.equal(returned.items[0].unit_company_price, 50);
  assert.equal(returned.items_return[0].returnArray.returnValue[0].company_price_total, 50);
  assert.equal(returned.items_return[0].returnArray.returnValue[0].unit_company_price, 50);

  assert.equal(byId.get(String(headerOnly._id)).company_cost_basis, 'line-total');
  assert.deepEqual(byId.get(String(alreadyRepaired._id)).items, alreadyRepaired.items);
});
