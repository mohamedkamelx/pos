'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// The API owns its database tooling; root tests resolve it through the API
// install rather than expecting a second copy at the repository root.
const apiModules = path.join(__dirname, '..', 'api');
const { MongoMemoryServer } = require(
  require.resolve('mongodb-memory-server', { paths: [apiModules] })
);
const { MongoClient, ObjectId } = require(require.resolve('mongodb', { paths: [apiModules] }));
const BaseModel = require('../api/src/models/base.model');
const DashboardModel = require('../api/src/models/dashboard.model');

/*
 * The dashboard's profit is only as good as the aggregation that prices its
 * sale lines. This exercises the real Mongo pipeline, not a mocked total:
 * quantity x unit cost, the legacy per-unit field on old Node sales, the
 * legacy line-total field on PHP sales, the item's cost as a fallback, and a
 * header-only import. Getting any one of these wrong silently changes profit.
 */
test('sale-line COGS uses quantities, unit costs and legacy line totals', async (t) => {
  const mongo = await MongoMemoryServer.create({
    binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY },
  });
  const client = await MongoClient.connect(mongo.getUri());

  /*
   * The collection is open already. Tell BaseModel that is the shared
   * connection so constructing the dashboard does not open a second one that
   * outlives the test.
   */
  const db = client.db('sale_line_cost');
  const previousClient = BaseModel.mongoClient;
  const previousDatabase = BaseModel.database;
  const previousConnectedUri = BaseModel._connectedUri;
  BaseModel.mongoClient = client;
  BaseModel.database = db;
  BaseModel._connectedUri = null;
  t.after(async () => {
    BaseModel.mongoClient = previousClient;
    BaseModel.database = previousDatabase;
    BaseModel._connectedUri = previousConnectedUri;
    await client.close();
    await mongo.stop();
  });

  const license = new ObjectId();
  const branch = new ObjectId();
  const product = new ObjectId();
  await db.collection('items').insertOne({ _id: product, company_price: 50 });

  await db.collection('sales').insertMany([
    // New sale: the line total is stored and the basis says so.
    {
      license,
      branch_id: branch,
      items: [
        {
          item: product,
          item_quantity: 3,
          company_price_total: 2700,
          unit_company_price: 900,
          company_cost_basis: 'line-total',
        },
      ],
      total_companyprice: 1,
    },
    // Legacy PHP sale: company_price_total is already the whole line.
    {
      license,
      branch_id: branch,
      sale_method: 'Live-Order',
      items: [{ item: product, item_quantity: 2, company_price_total: 500 }],
      total_companyprice: 1,
    },
    // Old Node sale without a basis marker: the stored value was per unit.
    {
      license,
      branch_id: branch,
      idempotency_key: 'old-node-sale',
      items: [{ item: product, item_quantity: 4, company_price_total: 25 }],
      total_companyprice: 1,
    },
    // No cost snapshot on the line: the joined product's unit cost is used.
    {
      license,
      branch_id: branch,
      items: [{ item: product, item_quantity: 2 }],
      total_companyprice: 1,
    },
    // Repaired Node sale: the marker makes the stored value a line total.
    {
      license,
      branch_id: branch,
      idempotency_key: 'repaired-node-sale',
      company_cost_basis: 'line-total',
      items: [{ item: product, item_quantity: 5, company_price_total: 125 }],
      total_companyprice: 1,
    },
    // A zero cost is a real cost and must not fall back to the product.
    {
      license,
      branch_id: branch,
      company_cost_basis: 'line-total',
      items: [{ item: product, item_quantity: 5, company_price_total: 0 }],
      total_companyprice: 1,
    },
    // Header-only import: no lines, so the header snapshot is the fallback.
    { license, branch_id: branch, total_companyprice: 75 },
  ]);

  const dashboard = new DashboardModel();
  dashboard.getCollection = async (name) => db.collection(name);

  const total = await dashboard.sumSaleLineCosts({ license, branch_id: branch });

  assert.equal(total, 3600);
});
