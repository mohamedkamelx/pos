'use strict';

// Callers supply documents loaded in authenticated scope, never request-owned
// policy objects. Submitted prices are assertions, not configuration.
const Money = require('../utils/currency');
const tradingDay = require('../utils/trading-day');

class PricingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = 409;
    this.details = { state: code, ...details };
  }
}
const fail = (code, message, details) => {
  throw new PricingError(code, message, details);
};
function number(value, label) {
  if (
    value === '' ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'object' ||
    !Number.isFinite(Number(value))
  )
    fail('invalid_price', `${label} must be a finite number.`);
  return Number(value);
}
function isVariable(product, branch) {
  return (
    product.open_price === true ||
    product.item_status === 'instant' ||
    (product.daily_price === true && !tradingDay.isToday(product.price_set_on, branch)) ||
    Number(product.selling_price ?? product.item_price ?? 0) <= 0
  );
}
function resolve({
  product,
  branch = {},
  submitted,
  previous,
  extras = 0,
  priceList,
  allowCounterPriceOverride = false,
  allowParkedPriceOverride = false,
  roundGrossUnit = false,
}) {
  const monetary = Money.policy(branch);
  const round = (value) => Money.fromMinor(Money.toMinor(value, monetary), monetary);
  const name = product.name || product.item_name || 'Item';
  if (product.available_for_sale === false && !previous)
    fail(
      'item_hidden',
      `${name} is hidden from sales. Remove this basket line or ask an authorised user to restore the product.`,
      { itemId: String(product._id) }
    );
  const old = previous?.pricing;
  // Only a stored snapshot may preserve a historical price. Clients cannot
  // install one: adapters read previous from the persisted order.
  if (old?.version === 1) {
    if (String(old.item_id) !== String(product._id))
      fail('price_context_mismatch', 'Item pricing context changed.');
    const expected = number(old.selling_price, 'Stored price');
    if (
      allowParkedPriceOverride === true &&
      allowCounterPriceOverride === true &&
      ['catalogue', 'counter_override', 'quick_item', 'variable'].includes(old.source) &&
      submitted !== undefined &&
      round(number(submitted, 'Entered price')) !== round(expected)
    ) {
      const entered = number(submitted, 'Entered price');
      if (entered <= 0 || entered > 1000000)
        fail('item_price_too_high', `${name}: price is outside the allowed range.`);
      return { ...old, selling_price: round(entered), source: 'counter_override' };
    }
    assertPrice(submitted, expected, round, name);
    return { ...old };
  }
  const catalogue = number(product.selling_price ?? product.item_price ?? 0, 'Catalogue price');
  const variable = isVariable(product, branch);
  let selling = catalogue;
  let source = 'catalogue';
  let ruleId = null;
  if (variable) {
    if (product.item_status === 'instant' && submitted === undefined && catalogue > 0)
      submitted = catalogue;
    if (
      submitted === undefined ||
      submitted === null ||
      submitted === '' ||
      !Number.isFinite(Number(submitted)) ||
      Number(submitted) <= 0
    )
      fail('item_needs_price', `${name} is priced on the day, so it needs a valid entered price.`);
    selling = number(submitted, 'Entered price');
    source = product.item_status === 'instant' ? 'quick_item' : 'variable';
  } else if (priceList) {
    const override = priceList.item_overrides?.find(
      (p) => String(p.item_id) === String(product._id)
    );
    selling = override
      ? number(override.price, 'Price list price')
      : round(catalogue * (1 - number(priceList.percent_off ?? 0, 'Price list discount') / 100));
    source = 'price_list';
    ruleId = String(priceList._id);
  }
  selling += number(extras, 'Modifier price');
  // This flag comes only from the authenticated host context, never sale JSON.
  if (allowCounterPriceOverride === true && !priceList && submitted !== undefined) {
    selling = number(submitted, 'Entered price');
    if (selling <= 0 || selling > 1000000)
      fail('item_price_too_high', `${name}: price is outside the allowed range.`);
    source = 'counter_override';
  }
  selling = roundGrossUnit === true ? Number(selling.toFixed(8)) : round(selling);
  if (selling < 0 || (variable && selling > 1000000))
    fail('item_price_too_high', `${name}: price is outside the allowed range.`);
  if (!variable) assertPrice(submitted, selling, round, name);
  return {
    version: 1,
    item_id: String(product._id),
    source,
    rule_id: ruleId,
    selling_price: selling,
    ...(roundGrossUnit === true ? { roundGrossUnit: true } : {}),
    currency: monetary,
    catalogue_price: catalogue,
    modifier_delta: extras,
    rule_revision: priceList?.updated_date || null,
    catalogue_revision: product.updated_date || null,
  };
}
function assertPrice(submitted, expected, round, name) {
  if (submitted === undefined) return;
  const actual = number(submitted, 'Submitted price');
  if (round(actual) !== round(expected))
    fail(
      'item_price_mismatch',
      `${name}: price changed or does not match the saved catalogue price. Refresh the menu before saving.`,
      { item: name, expected_price: round(expected), submitted_price: actual }
    );
}
// Older desktop rows stringify an unset inline override into the hidden cell.
// Only these missing-value sentinels may fall back to the selling-price field.
function desktopSubmittedPrice(item) {
  const inline = item.sale_inline_item_price;
  const absent =
    inline == null ||
    (typeof inline === 'string' && ['', 'undefined', 'null'].includes(inline.trim()));
  return absent ? item.item_price_total : inline;
}
function failure(error) {
  if (!(error instanceof PricingError)) throw error;
  return { status: false, message: error.message, data: error.details };
}
function calculate(pricing, quantity, branch = {}, discountAmount = 0, discountPercentage = 0) {
  const qty = number(quantity, 'Quantity');
  if (qty <= 0) fail('invalid_quantity', 'Quantity must be greater than zero.');
  const monetary = Money.policy(pricing.currency || branch);
  const round = (value) => Money.fromMinor(Money.toMinor(value, monetary), monetary);
  const result = require('./line-total').computeLineTotal({
    sellingPrice: pricing.selling_price,
    itemAmount: pricing.selling_price * qty,
    itemQuantity: qty,
    roundGrossUnit: pricing.roundGrossUnit === true,
    currencyFactor: monetary.factor,
    discountAmount,
    discountPercentage,
  });
  const base = pricing.selling_price;
  const total = round(result.total);
  return {
    pricing,
    unit_price: round(base),
    item_price: round(base),
    item_base_price: round(base),
    item_subtotal: round(result.subtotal),
    sale_inline_item_price: pricing.selling_price,
    quantity: qty,
    item_quantity: qty,
    total,
    totalSubminor: Math.round(result.total * monetary.factor * 1000000),
    item_total: total,
    total_amount: total,
    item_discount: round(result.discount),
    item_discount_percentage: discountPercentage,
    sale_inline_discount_value: discountAmount,
    sale_inline_discount_pervalue: discountPercentage,
  };
}
async function loadContext(db, order) {
  const { ObjectId } = require('mongodb');
  const scope = { license: order.license, branch_id: order.branch_id };
  const result = {};
  if (order.customer_id && ObjectId.isValid(String(order.customer_id))) {
    const customer = await db
      .collection('customers')
      .findOne({ license: order.license, _id: new ObjectId(String(order.customer_id)) });
    if (customer?.category_id)
      result.priceList = await db
        .collection('price_lists')
        .findOne({ ...scope, customer_category_id: String(customer.category_id) });
  }
  return result;
}
function menuQuote(product, branch = {}) {
  if (isVariable(product, branch)) {
    const indicative = number(product.selling_price ?? 0, 'Catalogue price');
    const amounts = calculate({ selling_price: indicative }, 1, branch);
    return {
      price: indicative,
      final_price: amounts.total,
      price_mode: 'variable',
      price_basis: 'selling_price',
      quote_required: true,
    };
  }
  const pricing = resolve({ product, branch });
  const line = calculate(
    pricing,
    1,
    branch,
    Number(product.discount_amount || 0),
    Number(product.discount_percentage || 0)
  );
  return {
    price: pricing.selling_price,
    final_price: line.total,
    discount_price: line.item_discount,
    price_mode: 'fixed',
    price_basis: 'selling_price',
    quote_required: false,
  };
}
module.exports = {
  isVariable,
  resolve,
  calculate,
  assertPrice,
  desktopSubmittedPrice,
  PricingError,
  failure,
  loadContext,
  menuQuote,
};
