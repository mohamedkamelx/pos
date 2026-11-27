'use strict';

/*
 * Reads the shop can answer, and asks it cannot.
 *
 * The live read path quotes item rows: it has no arithmetic, no averages and
 * no monthly targets. A sentence asking for those still reaches it whenever
 * it contains one price word, so the guard checks the user's sentence before
 * a read step is returned and again inside runLiveRead. Strong cues never
 * belong to a product lookup; weak cues only count together, because one
 * weak word collides with real names ("اشتراك شهري") and polite phrasing
 * ("لو سمحت بكام الشاي").
 *
 * The cue text is normalized first: أحسبلي must match احسب, so alef variants
 * fold to ا and tashkeel/tatweel are stripped before any pattern runs.
 *
 * A refused ask returns unknown, which falls through to the model instead of
 * being answered with an unrelated product card.
 */

/* Statistics pattern only: متوسط alone means "medium" in ordinary lookups
   ("بيتزا متوسط بكام"), while متوسط الارباح is the arithmetic ask. Bare
   حساب means account/bill and is deliberately absent (احسب covers it). */
const STRONG_CORE_RE = new RegExp(
  String.raw`(?:احسب|احسبي|احسبلي|حسابلي|حسبلي|نكسب|متوسط\s+ال` +
    String.raw`|margin|average|calculate|break\s*even|per\s+month)`,
  'iu',
);

/* These read as arithmetic only outside a profit read: "هامش الربح كام" and
   "نسبة الربح" are legitimate live profit questions. */
const STRONG_EXTRA_RE = /(?:نسبة|بالمية|في\s*المية|هامش)/iu;

const WEAK_PATTERN = String.raw`(?:لو\s+(?:عاي[زس]|نبي|هنبيع)|هدف|شهري|في\s+الشهر|إجمالي|اجمالي|target|الارباح|أرباح|ارباح|التكلفة\s+الشهرية)`;
const WEAK_COUNT_REQUIRED = 2;

/* A lookup shape is short: a record name, not a story. */
const QUERY_MAX_TOKENS = 6;

function normalizeAnalytic(value) {
  return String(value || '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا');
}

function isAnalyticAsk(raw, action) {
  const text = normalizeAnalytic(raw);
  if (!text) return false;
  if (STRONG_CORE_RE.test(text)) return true;
  if (action !== 'read_profit' && STRONG_EXTRA_RE.test(text)) return true;
  if (action === 'read_profit' || action === 'list_products') return false;
  /* Fresh regex each call: the count below must never depend on lastIndex. */
  const weak = text.match(new RegExp(WEAK_PATTERN, 'giu')) || [];
  return weak.length >= WEAK_COUNT_REQUIRED;
}

function queryIsShortEnough(query) {
  const tokens = String(query || '').split(/\s+/).filter(Boolean);
  return tokens.length <= QUERY_MAX_TOKENS;
}

module.exports = { isAnalyticAsk, queryIsShortEnough };
