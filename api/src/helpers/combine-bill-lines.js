'use strict';
const Money = require('../utils/currency');

function stable(value) {
  if (value == null) return null;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  return value;
}

// Presentation only: never rewrite sale lines or their return identity.
const fields = [
  'item_unit',
  'unit',
  'variant_id',
  'variation_id',
  'variant',
  'item_variant',
  'sku',
  'barcode',
  'serial_number',
  'options',
  'modifiers',
  'addons',
  'note',
  'allergy_note',
  'discount_type',
  'discount',
  'item_discount',
  'sale_inline_item_price',
  'sale_inline_discount_value',
  'sale_inline_discount_pervalue',
  'item_price',
  'item_base_price',
  'unit_price',
  'item_status',
  'return',
];

module.exports = function combineBillLines(source, displayed, monetary) {
  const groups = new Map();
  const result = [];
  displayed.forEach((line, index) => {
    const original = source[index];
    const identity = original.item_id || original.item;
    const qty = Number(line.qty);
    const key =
      identity && Number.isFinite(qty) && qty > 0
        ? JSON.stringify(
            stable({
              identity,
              name: line.name,
              rate: line.rate,
              translations: line.translations,
              default_language: line.default_language,
              terms: fields.map((field) => original[field]),
            })
          )
        : null;
    const existing = key && groups.get(key);
    if (existing) {
      existing.qty = String(Math.round((Number(existing.qty) + qty) * 1e6) / 1e6);
      existing.amount = Money.fromMinor(
        Money.toMinor(existing.amount, monetary) + Money.toMinor(line.amount, monetary),
        monetary
      );
    } else {
      const copy = { ...line };
      result.push(copy);
      if (key) groups.set(key, copy);
    }
  });
  return result;
};

module.exports.source = (item) =>
  Object.fromEntries(
    ['item_id', 'item', ...fields]
      .filter((field) => item[field] != null)
      .map((field) => [field, item[field]])
  );
