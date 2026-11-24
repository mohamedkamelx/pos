'use strict';

const { computeLineTotal, round2 } = require('./line-total');

function preview(input) {
  const price = Number(input.price);
  const amount = Number(input.discount_amount || 0);
  const percent = Number(input.discount_percentage || 0);
  if (
    input.price === '' ||
    input.price === undefined ||
    ![price, amount, percent].every(Number.isFinite) ||
    price < 0 ||
    amount < 0 ||
    percent < 0 ||
    percent > 100
  )
    throw new Error('Check the price and discount.');
  const result = computeLineTotal({
    itemAmount: price,
    sellingPrice: price,
    itemQuantity: 1,
    discountAmount: amount,
    discountPercentage: percent,
  });
  if (result.total < 0 || result.subtotal - result.discount < 0)
    throw new Error('The discount is greater than the price.');
  return {
    base: round2(result.subtotal),
    discount: round2(result.discount),
    total: round2(result.total),
  };
}

module.exports = { preview };
