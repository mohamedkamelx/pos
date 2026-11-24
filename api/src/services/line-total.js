'use strict';

/*
 * The money arithmetic of one sale line.
 *
 * Prices are final amounts. A line total is simply the priced quantity less
 * its discount.
 */

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function computeLineTotal(line) {
  let itemAmount = Number(line.itemAmount) || 0;
  let sellingPrice = Number(line.sellingPrice) || 0;
  const itemQuantity = Number(line.itemQuantity) || 0;
  const discountAmount = Number(line.discountAmount) || 0;
  const discountPercentage = Number(line.discountPercentage) || 0;

  if (line.roundGrossUnit === true) {
    const factor = Number(line.currencyFactor) || 100;
    sellingPrice = Math.round((sellingPrice + Number.EPSILON) * factor) / factor;
    itemAmount = sellingPrice * itemQuantity;
  }

  let discount = 0;
  if (discountAmount > 0) {
    discount = discountAmount * itemQuantity;
  } else if (discountPercentage > 0) {
    discount = itemAmount * (discountPercentage / 100);
  }

  return {
    total: itemAmount - discount,
    discount,
    subtotal: itemAmount,
  };
}

module.exports = { computeLineTotal, round2 };
