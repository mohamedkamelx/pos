/*
 * Currency wording for the assistant.
 *
 * The shop's currency is display data owned by the renderer. The assistant
 * receives only the symbol, never a token or shop credential. Replies and plan
 * summaries are normalised here so an Indian rupee sign or the formal Arabic
 * spelling cannot leak into the page.
 */

'use strict';

const DEFAULT_SIGN = '$';
const ARABIC_WORD = 'جنية';

function cleanSign(value) {
  const sign = String(value || '').trim().slice(0, 16);
  /* The requested display currency is the dollar sign. If an older shop still
     has the rupee sign saved, use the requested sign in assistant prose rather
     than repeating it. */
  if (!sign || sign === '₹') return DEFAULT_SIGN;
  return sign;
}

function normalizeCurrencyText(value) {
  return String(value || '')
    .replace(/₹/g, '$')
    .replace(/جنيه/g, ARABIC_WORD);
}

function currencyInstruction(value) {
  const sign = cleanSign(value);
  return [
    `The shop currency symbol is "${sign}".`,
    `Write every price with this symbol before the amount, for example "${sign} 200".`,
    `If you write the currency as an Arabic word, write "${ARABIC_WORD}".`,
    'Never use "₹" or "جنيه".',
  ].join(' ');
}

module.exports = {
  ARABIC_WORD,
  DEFAULT_SIGN,
  cleanSign,
  currencyInstruction,
  normalizeCurrencyText,
};
