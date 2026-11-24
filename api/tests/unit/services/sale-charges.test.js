'use strict';

const { normalizeSaleCharges } = require('../../../src/services/sale-charges');

test('charge amounts are final; untrusted tax fields are not carried into the sale', async () => {
  const result = await normalizeSaleCharges(
    [
      { name: 'Service', amount: 20, tax_amount: 1, tax_name: 'Untrusted' },
      { name: 'Parcel', amount: 10, tax_amount: 999 },
    ],
    []
  );
  expect(result).toEqual([
    { name: 'Service', amount: 20, source: 'manual' },
    { name: 'Parcel', amount: 10, source: 'manual' },
  ]);
});

test.each([-1, 0, Infinity, 'bad', '20abc'])('rejects invalid charge amount %s', async (amount) => {
  await expect(normalizeSaleCharges([{ name: 'Parcel', amount }], [])).rejects.toThrow();
});

test('an omitted charge list leaves an existing snapshot untouched', async () => {
  const saved = [
    { name: 'Service', amount: 20, source: 'manual', tax_amount: 0.5, tax_name: 'Old tax' },
  ];
  expect(await normalizeSaleCharges(undefined, saved)).toEqual(saved);
});

test('an explicit charge list replaces the snapshot and rebuilds each row', async () => {
  const saved = [{ name: 'Service', amount: 999, source: 'manual' }];
  expect(await normalizeSaleCharges([{ name: 'Service', amount: 20 }], saved)).toEqual([
    { name: 'Service', amount: 20, source: 'manual' },
  ]);
});

test('explicit removal clears charges; oversized lists and empty names are rejected', async () => {
  expect(await normalizeSaleCharges([], [])).toEqual([]);
  await expect(
    normalizeSaleCharges(Array(21).fill({ name: 'Parcel', amount: 1 }), [])
  ).rejects.toThrow();
  await expect(normalizeSaleCharges([{ name: ' ', amount: 1 }], [])).rejects.toThrow();
});

test('a quote-sourced charge keeps its provenance', async () => {
  expect(
    await normalizeSaleCharges([{ name: 'Service', amount: 20, source: 'quote' }], [])
  ).toEqual([{ name: 'Service', amount: 20, source: 'quote' }]);
});
