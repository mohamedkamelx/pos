'use strict';

const {
  smartConditions,
  fuzzyConditions,
} = require('../../../src/helpers/sales-search-fields');
const { expandQuery } = require('../../../src/utils/smart-search');

describe('sales search smart conditions', () => {
  const expansion = expandQuery('washing machine');

  test('expands a product name to its Arabic family but not to code fields', () => {
    const conditions = smartConditions(['name', 'sku', 'barcode'], expansion);
    const columns = conditions.map((condition) => Object.keys(condition)[0]);

    expect(columns).toContain('name');
    expect(columns).not.toContain('itemid');
    expect(columns).not.toContain('item_code');
    expect(columns).not.toContain('barcode_id');

    const namePatterns = conditions
      .filter((condition) => condition.name)
      .map((condition) => new RegExp(condition.name.$regex, 'i'));
    expect(namePatterns.some((pattern) => pattern.test('غسالة سامسونج 8 كيلو'))).toBe(true);
  });

  test('never turns a number word into a code search', () => {
    const conditions = smartConditions(['sku', 'plu'], expandQuery('اتنين'));
    expect(conditions).toEqual([]);
  });

  test('searches the derived index only when the name field is selected', () => {
    const byName = fuzzyConditions(['name'], expansion);
    expect(byName.some((condition) => condition.search_ngrams)).toBe(true);
    expect(byName.some((condition) => condition.search_phonetics)).toBe(true);
    expect(fuzzyConditions(['sku'], expansion)).toEqual([]);
  });
});
