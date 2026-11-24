'use strict';

const {
  WALK_IN_NAME,
  GENERAL_SUPPLIER_NAME,
  isWalkIn,
  isGeneralSupplier,
} = require('../../src/utils/default-parties');
const migrate = require('../../src/db/migrations/arabic-default-party-names');

const matches = (row, query = {}) =>
  Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((part) => matches(row, part));
    if (expected && typeof expected === 'object' && !(expected instanceof RegExp)) {
      if ('$regex' in expected) return expected.$regex.test(String(row[key] || ''));
      if ('$in' in expected) return expected.$in.some((value) => value === row[key]);
      if ('$ne' in expected) return row[key] !== expected.$ne;
      if ('$exists' in expected) return (row[key] !== undefined) === expected.$exists;
    }
    return row[key] === expected;
  });

function collection(rows) {
  const found = (query) => rows.filter((row) => matches(row, query));
  return {
    find(query = {}) {
      const result = found(query);
      return {
        toArray: async () => result,
        async *[Symbol.asyncIterator]() {
          for (const row of result) yield row;
        },
      };
    },
    async findOne(query = {}) {
      return found(query)[0] || null;
    },
    async updateOne(filter, update) {
      const row = found(filter)[0];
      if (!row) return { matchedCount: 0 };
      Object.assign(row, update.$set || {});
      return { matchedCount: 1 };
    },
    async updateMany(filter, update) {
      const rowsToUpdate = found(filter);
      for (const row of rowsToUpdate) Object.assign(row, update.$set || {});
      return { modifiedCount: rowsToUpdate.length };
    },
  };
}

function fakeDatabase() {
  const data = {
    branches: [
      { _id: 'b1', default_customer: 'c1', default_supplier: 's1' },
      { _id: 'b2', default_customer: 'c2', default_supplier: 's2' },
    ],
    customers: [
      { _id: 'c1', name: 'Walk-in Customer' },
      { _id: 'c2', name: WALK_IN_NAME },
      { _id: 'c3', name: 'Ravi' },
      { _id: 'c4', name: 'Walk-In-Customer' },
    ],
    suppliers: [
      { _id: 's1', name: 'General Supplier' },
      { _id: 's2', name: GENERAL_SUPPLIER_NAME },
      { _id: 's3', name: 'Acme Trading' },
    ],
    party_payments: [
      { _id: 'p1', party_type: 'customer', party_id: 'c1', party_name: 'Walk-in Customer' },
      { _id: 'p2', party_type: 'customer', party_id: 'c4', party_name: 'Walk-In-Customer' },
      { _id: 'p3', party_type: 'customer', party_id: 'c3', party_name: 'Ravi' },
      { _id: 'p4', party_type: 'supplier', party_id: 's1', party_name: 'General Supplier' },
    ],
  };
  return {
    data,
    db: {
      collection: (name) => collection(data[name]),
    },
  };
}

test('the placeholder names are the Arabic names the shop asked for', () => {
  expect(WALK_IN_NAME).toBe('زبون محل');
  expect(GENERAL_SUPPLIER_NAME).toBe('مورد عام');
  expect(isWalkIn(WALK_IN_NAME)).toBe(true);
  expect(isGeneralSupplier(GENERAL_SUPPLIER_NAME)).toBe(true);
});

test.each(['General Supplier', 'General supplier', GENERAL_SUPPLIER_NAME, 'المورد العام'])(
  '"%s" is the general supplier placeholder',
  (name) => {
    expect(isGeneralSupplier(name)).toBe(true);
  }
);

test.each(['Acme Trading', 'General', 'Supplier', 'مورد', ''])(
  '"%s" is a real supplier and keeps its name',
  (name) => {
    expect(isGeneralSupplier(name)).toBe(false);
  }
);

test('renames the branch defaults and every old placeholder spelling', async () => {
  const { db, data } = fakeDatabase();

  await migrate(db);

  expect(data.customers.map((row) => row.name)).toEqual([
    WALK_IN_NAME,
    WALK_IN_NAME,
    'Ravi',
    WALK_IN_NAME,
  ]);
  expect(data.suppliers.map((row) => row.name)).toEqual([
    GENERAL_SUPPLIER_NAME,
    GENERAL_SUPPLIER_NAME,
    'Acme Trading',
  ]);
  expect(data.party_payments.map((row) => row.party_name)).toEqual([
    WALK_IN_NAME,
    WALK_IN_NAME,
    'Ravi',
    GENERAL_SUPPLIER_NAME,
  ]);
});

test('is idempotent and leaves real parties alone', async () => {
  const { db, data } = fakeDatabase();
  await migrate(db);
  const first = JSON.stringify(data);
  await migrate(db);
  expect(JSON.stringify(data)).toBe(first);
  expect(data.customers.find((row) => row._id === 'c3').name).toBe('Ravi');
  expect(data.suppliers.find((row) => row._id === 's3').name).toBe('Acme Trading');
});
