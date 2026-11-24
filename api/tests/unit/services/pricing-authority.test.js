'use strict';
const pricing = require('../../../src/services/pricing-authority');
const product = {
  _id: 'paratha',
  name: 'Paratha',
  selling_price: 45,
};
const quote = (changes = {}) => pricing.resolve({ product, ...changes });

test('rejects a price assertion that disagrees with the catalogue, and never substitutes one', () => {
  expect(() => quote({ submitted: 47.25 })).toThrow(/does not match/);
  expect(pricing.calculate(quote({ submitted: 45 }), 2)).toMatchObject({
    unit_price: 45,
    total: 90,
  });
});
test('a final price stays the final price, including after quantity changes', () => {
  const q = quote({
    product: { ...product, selling_price: 30 },
    submitted: 30,
  });
  expect(pricing.calculate(q, 2)).toMatchObject({ total: 60, item_subtotal: 60 });
});
test('a channel label does not authorize an arbitrary price', () => {
  expect(() => quote({ channel: 'online', submitted: 60 })).toThrow(/does not match/);
});
test('counter override cannot bypass a configured price list', () => {
  expect(() =>
    quote({
      priceList: { _id: 'wholesale', percent_off: 10 },
      allowCounterPriceOverride: true,
      submitted: 70,
    })
  ).toThrow();
});
test('configured customer prices are enforced', () => {
  expect(quote({ priceList: { _id: 'wholesale', percent_off: 10 }, submitted: 40.5 }).source).toBe(
    'price_list'
  );
  expect(
    quote({ priceList: { _id: 'wholesale', percent_off: 10 }, submitted: 40.5 }).selling_price
  ).toBe(40.5);
  expect(() =>
    quote({ priceList: { _id: 'wholesale', percent_off: 10 }, submitted: 45 })
  ).toThrow();
});
test('stored snapshots preserve the agreed price after catalogue edits', () => {
  const previous = { pricing: quote() };
  expect(quote({ product: { ...product, selling_price: 60 }, previous, submitted: 45 })).toEqual(
    previous.pricing
  );
  expect(() => quote({ previous, submitted: 1 })).toThrow();
});

test('authorised parked counter price edits keep the snapshot but not a stale price', () => {
  const previous = { pricing: quote() };
  const options = {
    previous,
    submitted: 70,
    allowCounterPriceOverride: true,
    allowParkedPriceOverride: true,
  };
  expect(quote({ ...options, product: { ...product, name: 'Paratha' } })).toMatchObject({
    version: 1,
    selling_price: 70,
    source: 'counter_override',
  });
  expect(() => quote({ ...options, allowParkedPriceOverride: false })).toThrow();
  expect(() => quote({ ...options, allowCounterPriceOverride: false })).toThrow();
  expect(() =>
    quote({ ...options, previous: { pricing: { ...previous.pricing, source: 'outlet' } } })
  ).toThrow();
  for (const submitted of [0, -1, 1000001, 'bad'])
    expect(() => quote({ ...options, submitted })).toThrow();
});
test.each(['variable', 'quick'])('%s is explicit and bounded', (kind) => {
  const p = {
    ...product,
    ...(kind === 'quick' ? { item_status: 'instant' } : { open_price: true }),
  };
  expect(quote({ product: p, submitted: 250 }).selling_price).toBe(250);
  for (const invalid of [
    ...(kind === 'quick' ? [] : [undefined]),
    '',
    null,
    -1,
    0,
    NaN,
    Infinity,
    1000001,
    true,
    {},
  ])
    expect(() => quote({ product: p, submitted: invalid })).toThrow();
});
test('modifiers are part of the validated price before the final line total', () => {
  const q = quote({ extras: 10, submitted: 55 });
  expect(pricing.calculate(q, 2)).toMatchObject({ total: 110, item_subtotal: 110 });
});
test('menu quote and admission share exclusive/inclusive/discount arithmetic', () => {
  for (const legacyTaxType of ['exclusive', 'inclusive']) {
    const p = { ...product, selling_price: 130, tax_type: legacyTaxType, discount_amount: 10 };
    const menu = pricing.menuQuote(p, {});
    const accepted = pricing.resolve({ product: p, submitted: menu.price });
    expect(pricing.calculate(accepted, 1, {}, 10).total).toBe(menu.final_price);
    expect(menu.price_basis).toBe('selling_price');
  }
});
test('quantity subtotal reconciles even when the stored unit is rounded', () => {
  const p = quote({
    product: { ...product, selling_price: 30 },
    roundGrossUnit: true,
  });
  const line = pricing.calculate(p, 99);
  expect(line.total).toBe(2970);
  expect(line.item_subtotal).toBeCloseTo(line.total, 2);
});
