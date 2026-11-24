'use strict';

const { BadRequestError } = require('../utils/appError');
const { round2 } = require('./sale-header');

// Normalize once: payment validation and the saved document must use the same
// charges. Each amount is already the final amount the customer pays.
async function normalizeSaleCharges(input, existing) {
  if (input === undefined) return existing || [];
  if (!Array.isArray(input) || input.length > 20)
    throw new BadRequestError('Provide at most 20 additional charges.');
  const output = [];
  for (const charge of input) {
    const name = String(charge?.name || '').trim();
    const value = Number(charge?.amount);
    if (!name || name.length > 60 || !Number.isFinite(value) || value <= 0)
      throw new BadRequestError(
        'Each additional charge needs a name and a positive finite amount.'
      );
    const amount = round2(value);
    if (amount <= 0) throw new BadRequestError('Additional charges must be at least 0.01.');
    output.push({
      name,
      amount,
      source: charge.source === 'quote' ? 'quote' : 'manual',
    });
  }
  return output;
}

module.exports = { normalizeSaleCharges };
