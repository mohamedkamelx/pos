'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const stock = require('../../../src/services/sale-stock');

function fakeRepository(rows) {
  const items = new Map(rows.map((row) => [String(row._id), { ...row }]));
  return {
    async findItemById(id) {
      return items.get(String(id)) || null;
    },
    async deductStockIfAvailable(id, quantity) {
      const row = items.get(String(id));
      if (!row) return null;
      if (row.track_inventory !== true && row.track_inventory !== 'true') return null;
      if (row.negative_stock === true || row.negative_stock === 'true') return null;
      if (!(Number(row.available_quantity) >= Number(quantity))) return null;
      row.available_quantity = Number(row.available_quantity) - Number(quantity);
      return { ...row };
    },
    async updateStock(id, quantity) {
      const row = items.get(String(id));
      row.available_quantity = Number(row.available_quantity) + Number(quantity);
      return row;
    },
    row(id) {
      return items.get(String(id));
    },
  };
}

test('line quantities are converted to base units before they are added together', () => {
  const lines = [
    { item_id: 'a', item_quantity: 2, unit_conversion: { factor: 12 } },
    { item_id: 'a', item_quantity: 1, unit_conversion: { factor: 12 } },
    { item_id: 'b', item_quantity: 0.5, stock_quantity: 0.5 },
  ];
  const requests = stock.aggregate(lines);
  assert.equal(requests.get('a').quantity, 36);
  assert.equal(requests.get('b').quantity, 0.5);
});

test('reserve deducts the aggregate once and reports the short item', async () => {
  const id = new ObjectId();
  const repo = fakeRepository([{
    _id: id,
    name: 'Mint tea',
    track_inventory: true,
    negative_stock: false,
    available_quantity: 5,
  }]);

  const result = await stock.reserve([
    { item_id: String(id), item_quantity: 1, unit_conversion: { factor: 1 } },
    { item_id: String(id), item_quantity: 1, unit_conversion: { factor: 1 } },
  ], repo);

  assert.deepEqual(result.shortages, []);
  assert.equal(repo.row(id).available_quantity, 3);
  assert.equal(result.reservations.get(String(id)).quantity, 2);
});

test('a rejected reservation releases earlier item reservations', async () => {
  const first = new ObjectId();
  const second = new ObjectId();
  const repo = fakeRepository([
    { _id: first, name: 'Soap', track_inventory: true, negative_stock: false, available_quantity: 4 },
    { _id: second, name: 'Rice', track_inventory: 'true', negative_stock: 'false', available_quantity: 1 },
  ]);

  const result = await stock.reserve([
    { item_id: String(first), item_quantity: 2, unit_conversion: { factor: 1 } },
    { item_id: String(second), item_quantity: 2, unit_conversion: { factor: 1 } },
  ], repo);

  assert.equal(result.shortages.length, 1);
  assert.equal(result.shortages[0].item_id, String(second));
  assert.equal(result.shortages[0].available_quantity, 1);
  assert.equal(repo.row(first).available_quantity, 4, 'first reservation was not rolled back');
  assert.equal(result.reservations.size, 0);
});

test('untracked and negative-stock items are not reserved', async () => {
  const untracked = new ObjectId();
  const negative = new ObjectId();
  const repo = fakeRepository([
    { _id: untracked, name: 'Service', track_inventory: false, negative_stock: false, available_quantity: 0 },
    { _id: negative, name: 'Loose sweets', track_inventory: true, negative_stock: true, available_quantity: 0 },
  ]);

  const result = await stock.reserve([
    { item_id: String(untracked), item_quantity: 3, unit_conversion: { factor: 1 } },
    { item_id: String(negative), item_quantity: 3, unit_conversion: { factor: 1 } },
  ], repo);

  assert.deepEqual(result.shortages, []);
  assert.equal(result.reservations.size, 0);
  assert.equal(repo.row(untracked).available_quantity, 0);
  assert.equal(repo.row(negative).available_quantity, 0);
});

test('inspect reports every shortage without changing stock', async () => {
  const first = new ObjectId();
  const second = new ObjectId();
  const repo = fakeRepository([
    { _id: first, name: 'Milk', track_inventory: true, negative_stock: false, available_quantity: 1 },
    { _id: second, name: 'Bread', track_inventory: true, negative_stock: false, available_quantity: 4 },
  ]);

  const shortages = await stock.inspect([
    { item_id: String(first), item_quantity: 2, unit_conversion: { factor: 1 } },
    { item_id: String(second), item_quantity: 5, unit_conversion: { factor: 1 } },
  ], repo);

  assert.deepEqual(shortages.map((row) => row.item_id).sort(), [String(first), String(second)].sort());
  assert.equal(repo.row(first).available_quantity, 1);
  assert.equal(repo.row(second).available_quantity, 4);
});

test('release puts the full reservation back', async () => {
  const id = new ObjectId();
  const repo = fakeRepository([
    { _id: id, name: 'Coffee', track_inventory: true, negative_stock: false, available_quantity: 10 },
  ]);
  const result = await stock.reserve([
    { item_id: String(id), item_quantity: 4, unit_conversion: { factor: 1 } },
  ], repo);
  assert.equal(repo.row(id).available_quantity, 6);
  await stock.release(result.reservations, repo);
  assert.equal(repo.row(id).available_quantity, 10);
  assert.equal(result.reservations.size, 0);
});
