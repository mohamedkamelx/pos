/*
 * Pre-send request budget.
 *
 * These tests pin the invariants that must hold whatever the chosen numbers
 * are: an unknown limit never costs you a layer, whole layers are dropped
 * before anything is cut, the cut takes the tail rather than the head, and
 * the user's own words are never a reference layer that can be spent.
 * The constants themselves are policy and are asserted only for consistency
 * with the code that uses them.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const budget = require(path.join(__dirname, '..', 'src', 'ai', 'context-budget.js'));

const LAYERS = [
  { name: 'memory', text: 'MEMORY-LINE\nMEMORY-LINE' },
  { name: 'card', text: 'CARD-LINE' },
  { name: 'local', text: 'LOCAL-LINE' },
];

test('the drop order is the reverse of priority and never names the message', () => {
  assert.deepEqual(budget.DROP_ORDER, ['local', 'card', 'memory']);
  assert.deepEqual(budget.REFERENCE_PRIORITY, ['memory', 'card', 'local']);
  for (const name of budget.DROP_ORDER) {
    assert.ok(name !== 'message', 'the user wording is never dropped');
    assert.ok(name !== 'currency', 'the currency line is never dropped');
  }
});

test('an unknown request limit costs nothing', () => {
  const fitted = budget.fitReferenceLayers(LAYERS, Infinity);
  assert.equal(fitted.dropped.length, 0, 'nothing may be dropped without a limit');
  assert.equal(fitted.trimmed.length, 0);
  assert.match(fitted.text, /MEMORY-LINE/);
  assert.match(fitted.text, /CARD-LINE/);
  assert.match(fitted.text, /LOCAL-LINE/);

  assert.equal(budget.referenceBudgetChars({ requestTokens: 0, fixedChars: 100000 }), Infinity);
  assert.equal(
    budget.requestFits({ fixedChars: 1000000, promptChars: 1000000, requestTokens: 0 }).fits,
    true,
    'no known cap means no refusal',
  );
});

test('a layer that fits whole is never cut', () => {
  const total = LAYERS.reduce((n, layer) => n + layer.text.length + 2, 0);
  const fitted = budget.fitReferenceLayers(LAYERS, total);

  assert.equal(fitted.dropped.length, 0);
  assert.equal(fitted.trimmed.length, 0);
  assert.equal(fitted.text, LAYERS.map((layer) => layer.text).join('\n\n'));
});

test('whole layers are dropped from the least important end before any cut', () => {
  /* One char short of the whole: local must go first, then card. */
  const total = LAYERS.reduce((n, layer) => n + layer.text.length + 2, 0);
  const fitted = budget.fitReferenceLayers(LAYERS, total - 1);

  assert.deepEqual(fitted.dropped, ['local']);
  assert.match(fitted.text, /MEMORY-LINE/, 'memory survives a shortfall');
  assert.match(fitted.text, /CARD-LINE/);

  const tighter = budget.fitReferenceLayers(LAYERS, LAYERS[0].text.length + 4);
  assert.deepEqual(tighter.dropped, ['local', 'card']);
  assert.match(tighter.text, /MEMORY-LINE/);
  assert.doesNotMatch(tighter.text, /CARD-LINE/);
});

test('a memory block too big for the budget is cut from its tail, not its head', () => {
  const memory = {
    name: 'memory',
    text: 'Active topic: Irons\nAnswered: price -> 30\nResolved plan near the front.'.repeat(6),
  };
  const fitted = budget.fitReferenceLayers([memory], 120);

  assert.match(fitted.text, /^Active topic: Irons/, 'the head must survive');
  assert.deepEqual(fitted.trimmed, ['memory']);
  assert.deepEqual(fitted.dropped, [], 'truncated, not dropped');
  assert.ok(fitted.text.length <= 120, `was ${fitted.text.length}`);
  assert.doesNotMatch(fitted.text, /Resolved plan near the front\.$/, 'the tail is what goes');
});

test('the budget leaves room for the fixed payload and for output', () => {
  /* 8000 tokens of Groq, the payload we actually send, minus a reserve. */
  const usable = budget.referenceBudgetChars({ requestTokens: 8000, fixedChars: 13643 });
  const reserved = budget.estimateChars(budget.OUTPUT_RESERVE_TOKENS);
  const expected = 8000 * budget.CHARS_PER_TOKEN - 13643 - reserved;

  assert.equal(usable, expected);
  assert.ok(usable > 0, 'the payload plus reserve must still fit under the cap');
  assert.ok(
    usable < 8000 * budget.CHARS_PER_TOKEN,
    'the fixed payload must actually be charged against the cap',
  );
});

test('a payload that exceeds the cap is reported as not fitting', () => {
  const over = budget.requestFits({ fixedChars: 30000, promptChars: 5000, requestTokens: 8000 });
  assert.equal(over.fits, false);
  assert.ok(over.tokens > over.cap);

  const under = budget.requestFits({ fixedChars: 13643, promptChars: 4300, requestTokens: 8000 });
  assert.equal(under.fits, true, `was ${under.tokens} tokens against ${under.cap}`);
});

test('the fixed payload plus a bounded message fits an 8000-token cap today', () => {
  /* The regression this module exists to keep visible: the message side is
     bounded, so the fixed payload is what decides headroom. */
  const { SYSTEM_PROMPT } = require(path.join(__dirname, '..', 'src', 'ai', 'provider-registry.js'));
  const { createPosnicToolPlugin } = require(path.join(__dirname, '..', 'src', 'ai', 'tools', 'plugin.js'));

  const registry = [];
  const plugin = createPosnicToolPlugin({ store: { get: () => null } });

  return plugin.setup({
    tool: { async transform(fn) { return fn({ add(def) { registry.push(def); } }); } },
  }).then(() => {
    const schemas = registry.reduce(
      (total, tool) => total + String(tool.description || '').length +
        JSON.stringify(tool.input || {}).length,
      0,
    );
    const fixedChars = SYSTEM_PROMPT.length + schemas;
    const measured = budget.requestFootprint({ fixedChars, promptChars: 0 });

    /* The compact memory cap, not the full one: a provider with a request
       limit is served with full=false, which is what holds memory to
       MAX_SHORT_CONTEXT_CHARS. The 6000 cap only ever applies to a provider
       with no request limit, where there is nothing to be tight about. */
    const widest = budget.requestFootprint({
      fixedChars,
      promptChars: 2200 + 900 + 1200,
    });

    assert.ok(
      measured.tokens < 8000,
      `fixed payload alone is ${fixedChars} chars = ${measured.tokens} tokens`,
    );
    assert.ok(
      widest.tokens < 8000,
      `fixed plus widest message is ${widest.chars} chars = ${widest.tokens} tokens; ` +
        'there would be no room left for tool results',
    );
    assert.ok(
      8000 - widest.tokens >= budget.OUTPUT_RESERVE_TOKENS,
      `only ${8000 - widest.tokens} tokens remain for tool results and the answer`,
    );
  });
});

/*
 * The reserve grows with the thinking level, because reasoning tokens are
 * counted against the same per-request cap as the prompt. Charging every
 * level the same small figure makes a high-effort turn look like it fits
 * when it does not, and the request is refused after the fact.
 */
test('the reply reserve grows with the thinking level', () => {
  const low = budget.outputReserveTokens('low');
  const medium = budget.outputReserveTokens('medium');
  const high = budget.outputReserveTokens('high');

  assert.ok(low < medium, `${low} must be under ${medium}`);
  assert.ok(medium < high, `${medium} must be under ${high}`);

  /* An unknown or invalid level keeps the conservative default rather than
     guessing high: an over-large reserve starves the memory block and makes
     the assistant ask again for something already settled. */
  assert.equal(budget.outputReserveTokens(undefined), budget.OUTPUT_RESERVE_TOKENS);
  assert.equal(budget.outputReserveTokens('extreme'), budget.OUTPUT_RESERVE_TOKENS);
  assert.equal(budget.outputReserveTokens(' LOW '), low, 'level ids are normalised');
});

test('a bigger reserve leaves the reference layers less room', () => {
  const fixedChars = 13916;
  const tight = budget.referenceBudgetChars({
    requestTokens: 8000, fixedChars, reserveTokens: 3200,
  });
  const roomy = budget.referenceBudgetChars({
    requestTokens: 8000, fixedChars, reserveTokens: 800,
  });

  assert.ok(tight < roomy, 'reserving more for the reply must cost the reference');
  assert.equal(
    roomy - tight,
    budget.estimateChars(3200) - budget.estimateChars(800),
    'the difference is exactly the difference in reserve',
  );
  assert.ok(tight > 0, 'even the tightest budget must leave the message somewhere to go');
});

/*
 * Every step resends the fixed payload plus the results of the steps before
 * it, so the turn grows inside itself while the cap does not move. A known
 * small cap therefore gets a smaller allowance; an unknown cap keeps the full
 * one, because restricting a provider whose limit may be far larger would
 * break multi-step work for no measured reason.
 */
test('the step allowance follows the request cap, not a constant', () => {
  assert.ok(
    budget.stepsForRequestTokens(8000) < budget.stepsForRequestTokens(131072),
    'a small declared cap must allow fewer steps',
  );
  assert.equal(
    budget.stepsForRequestTokens(0),
    budget.stepsForRequestTokens(131072),
    'an unknown cap must not be restricted',
  );
  assert.ok(budget.stepsForRequestTokens(8000) >= 2,
    'the allowance must still permit a search followed by a plan');
  assert.equal(budget.stepsForRequestTokens(8000), 4);
});
