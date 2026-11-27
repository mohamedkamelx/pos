/*
 * Pre-send request budget.
 *
 * Groq's free tier rejects a single request over 8,000 tokens with a 413.
 * Every turn pays for the fixed payload (the policy prompt and the nine tool
 * schemas) plus the variable layers (conversation memory, task card, local
 * pre-check, currency line and the message itself), and only then is there
 * room left for the tool results and the answer.
 *
 * Measuring the message alone hides the part that dominates, so this module
 * answers two questions before the request goes out:
 *
 *   1. will it fit, and
 *   2. if it cannot, what goes first.
 *
 * One owner does the arithmetic and one fixed order applies everywhere, so a
 * second budget rule cannot appear somewhere else in the runtime.
 */

'use strict';

/* Characters per token, deliberately conservative.
 *
 * The conversion error has two directions and they are not equally bad.
 * tokens = chars / ratio, so a larger ratio under-counts tokens. Against a
 * hard per-request cap that fails open: the payload is sent, the provider
 * counts real tokens and rejects the request. Three chars per token
 * over-counts instead, which costs headroom we can see and act on.
 *
 * Every estimate goes through this one constant, so the cap check and the
 * context-window check can never disagree about the same text. It is only a
 * ratio: when the provider reports real prompt tokens for a step, those are
 * authoritative and the reported number wins.
 */
const CHARS_PER_TOKEN = 3;

/* Tokens left for the model's own reply in one request. This covers the
   answer and any reasoning tokens counted alongside it. It does not cover
   tool results: those belong to whichever step produces them and are
   budgeted from the headroom that step has left, not from here. */
const OUTPUT_RESERVE_TOKENS = 1000;

/*
 * The reserve is not one number in practice.
 *
 * Reasoning tokens are generated on top of the answer and the provider counts
 * them against the same per-request cap, so a high effort can spend several
 * times what a low one does. Charging every level the same low figure makes a
 * high-effort turn look like it fits when it does not, and the request is
 * refused after the fact. These are deliberately rough: they set aside room,
 * they do not predict a reply, and the provider's reported tokens stay
 * authoritative once a request has been answered.
 */
const OUTPUT_RESERVE_BY_REASONING = Object.freeze({
  low: 800,
  medium: 1800,
  high: 3200,
});

/**
 * Reply tokens to set aside for the selected thinking level. An unknown or
 * invalid level falls back to the conservative default rather than guessing
 * high, because an over-large reserve starves the memory block and makes the
 * assistant ask again for something the conversation already settled.
 *
 * @param {string} [reasoning] low | medium | high
 * @returns {number} tokens
 */
function outputReserveTokens(reasoning) {
  const level = String(reasoning || '').trim().toLowerCase();
  return OUTPUT_RESERVE_BY_REASONING[level] || OUTPUT_RESERVE_TOKENS;
}

/*
 * Reference layers in the order they are spent, most load-bearing first.
 *
 *   memory - settled answers, current category, the unfinished request.
 *            Dropping this is what makes the assistant ask again for
 *            something the conversation already answered.
 *   card   - a projection of state the memory block also partly carries.
 *   local  - a pre-check hint the model can re-derive by calling a tool.
 *
 * DROP_ORDER is the reverse: whole layers go before any layer is cut, and the
 * tail is cut before the head, because every layer writes what it cannot
 * afford to lose at the top (the resolution plan, the settled answers, the
 * task header). The message and the currency line are not reference layers
 * and are never dropped.
 */
const REFERENCE_PRIORITY = ['memory', 'card', 'local'];
const DROP_ORDER = [...REFERENCE_PRIORITY].reverse();

function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN);
}

function estimateChars(tokens) {
  return Math.max(0, Math.ceil((Number(tokens) || 0) * CHARS_PER_TOKEN));
}

function isLayer(layer) {
  return !!(layer && typeof layer.text === 'string' && layer.text.length);
}

/**
 * Characters the reference layers may use: the provider's token cap converted
 * to characters, minus the fixed payload and the output reserve. An unknown
 * or missing cap returns Infinity so an unbounded provider is never refused.
 */
function referenceBudgetChars({ requestTokens, fixedChars, reserveTokens } = {}) {
  const cap = Number(requestTokens) || 0;
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  /* `cap` and the reserve are tokens; `fixedChars` is already characters, so
     it is charged as it stands. Converting it too would charge the payload
     four times over and report that nothing fits. */
  const reserve = reserveTokens === undefined
    ? OUTPUT_RESERVE_TOKENS
    : Math.max(0, Number(reserveTokens) || 0);
  const usable = estimateChars(cap) - Math.max(0, Number(fixedChars) || 0) -
    estimateChars(reserve);
  return Math.max(0, usable);
}

/**
 * Fit reference layers into `budget` chars.
 *
 * Layers arrive in REFERENCE_PRIORITY order. Whole layers are dropped from
 * the least important end until the rest fit; only if a single layer is still
 * too big is it truncated, from its tail. Nothing is dropped when the budget
 * is unknown.
 *
 * @param {Array<{name: string, text: string}>} layers
 * @param {number} budget characters available to all reference layers
 * @returns {{text: string, dropped: string[], trimmed: string[]}}
 */
function fitReferenceLayers(layers, budget) {
  let kept = (Array.isArray(layers) ? layers : []).filter(isLayer).slice();
  const dropped = [];
  const trimmed = [];

  if (!Number.isFinite(budget)) {
    return { text: kept.map((layer) => layer.text).join('\n\n'), dropped, trimmed };
  }

  const size = (list) => list.reduce(
    (total, layer) => total + layer.text.length + 2, 0,
  );

  while (kept.length > 1 && size(kept) > budget) {
    const victim = kept.pop();
    dropped.push(victim.name);
  }

  let text = kept.map((layer) => layer.text).join('\n\n');
  if (kept.length && size(kept) > budget) {
    const head = kept[0];
    text = head.text.slice(0, Math.max(0, budget)).trimEnd();
    trimmed.push(head.name);
  }

  return { text, dropped, trimmed };
}

/**
 * The number that decides whether the request is sent: fixed payload plus
 * variable layers, in chars and in tokens.
 */
function requestFootprint({ fixedChars = 0, promptChars = 0 } = {}) {
  const chars = Math.max(0, fixedChars) + Math.max(0, promptChars);
  return { chars, tokens: estimateTokens(chars) };
}

/**
 * Would this request fit? An unknown cap is treated as fitting, so an
 * unbounded provider is never refused a request it can serve.
 */
function requestFits({ fixedChars, promptChars, requestTokens }) {
  const cap = Number(requestTokens) || 0;
  const footprint = requestFootprint({ fixedChars, promptChars });
  if (cap <= 0) return { fits: true, ...footprint, cap: 0 };
  return { fits: footprint.tokens <= cap, ...footprint, cap };
}

/*
 * How many model steps one turn may spend.
 *
 * Every step resends the fixed payload plus the results of the steps before
 * it, so a turn grows inside itself while the provider's per-request cap
 * stays where it is. The turn-start budget check runs once, before the first
 * step, and cannot see that growth, so the allowance itself has to be small
 * enough that the last step still fits.
 *
 * Eight steps against an 8,000-token cap cannot: the fixed payload is already
 * about half of it, and each step adds a tool result. A known small cap
 * therefore gets a smaller allowance. An unknown cap keeps the full one —
 * restricting a provider whose limit may be an order of magnitude larger
 * would break multi-step work for no measured reason — while its reference
 * layers are still bounded by the compact sizes elsewhere.
 */
const FULL_STEP_STEPS = 8;
const COMPACT_STEP_STEPS = 4;
const LOW_REQUEST_CAP = 16000;

/**
 * @param {number} [requestTokens] the provider's per-request token cap
 * @returns {number} maximum model steps for one turn
 */
function stepsForRequestTokens(requestTokens) {
  const cap = Number(requestTokens) || 0;
  return cap > 0 && cap <= LOW_REQUEST_CAP ? COMPACT_STEP_STEPS : FULL_STEP_STEPS;
}

module.exports = {
  CHARS_PER_TOKEN,
  DROP_ORDER,
  OUTPUT_RESERVE_TOKENS,
  REFERENCE_PRIORITY,
  estimateChars,
  estimateTokens,
  fitReferenceLayers,
  outputReserveTokens,
  referenceBudgetChars,
  requestFits,
  requestFootprint,
  stepsForRequestTokens,
};
