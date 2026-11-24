'use strict';

const { BadRequestError } = require('../utils/appError');

const round2 = (value, decimals = 2) => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
};

function roundSaleTotal(value, enabled, decimals = 2) {
  const amount = round2(value, decimals);
  const total = enabled === true ? Math.round(amount) : amount;
  return { total, roundOff: round2(total - amount, decimals) };
}

/** Canonical sale header calculation from the line total and the shop charge. */
function calculateSaleHeader(data, sale_tot_amount, context) {
  // Extra Discount & Round Off
  const extraDiscountRaw =
    data.extra_discount == null || data.extra_discount === '' ? 0 : Number(data.extra_discount);
  if (
    !Number.isFinite(extraDiscountRaw) ||
    extraDiscountRaw < 0 ||
    (data.extra_discount_type === 'percent'
      ? extraDiscountRaw > 100
      : extraDiscountRaw > sale_tot_amount)
  )
    throw new BadRequestError(
      'Additional discount must be between zero and the bill amount (or 100%).'
    );
  const extraDiscount = round2(extraDiscountRaw, 2);
  let itemsTotAmount = sale_tot_amount - extraDiscount;
  let salesExtraDiscount = extraDiscount;

  if (data.extra_discount_type === 'percent') {
    const discAmt = sale_tot_amount * (extraDiscount / 100);
    itemsTotAmount = sale_tot_amount - discAmt;
    salesExtraDiscount = discAmt;
  }

  itemsTotAmount += Number(context.manualChargesTotal) || 0;

  // Fetch Branch Settings for Round Off
  const roundOffSetting = context.roundOff === true;

  const { total: finalSaleTotAmount, roundOff: roundOffValue } = roundSaleTotal(
    itemsTotAmount,
    roundOffSetting
  );

  const salesTotalForDoc = round2(finalSaleTotAmount, 2);
  const roundOffForDoc = round2(roundOffValue, 2);
  const itemsTotalForDoc = salesTotalForDoc;

  return {
    beforeManualDiscountForDoc: round2(sale_tot_amount, 2),
    extraDiscount,
    salesExtraDiscount,
    finalSaleTotAmount,
    salesTotalForDoc,
    roundOffForDoc,
    itemsTotalForDoc,
  };
}
module.exports = { calculateSaleHeader, round2, roundSaleTotal };
