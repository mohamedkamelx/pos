/*
 * The assistant's fixed prompt payload must stay small and single-sourced.
 *
 * Two things break the shop assistant in the field:
 *   1. Groq models declare an 8000-token per-request cap, so a big fixed
 *      payload leaves no room for a tool result and the turn dies with
 *      "the provider limits one request to about 8000 tokens".
 *   2. Editing a rule in one of two places leaves a stale, contradictory copy.
 *
 * So this test pins the shape of what the model is handed: how big it is,
 * that every tool is registered, that the structural part of each schema
 * (names, types, enums, bounds, required) is exactly the recorded fingerprint,
 * and that no code path builds a budget- or provider-specific variant.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'src', 'ai', 'tools', 'plugin.js');
const FINGERPRINT = path.join(__dirname, 'fixtures', 'ai-tool-schema-fingerprint.json');

/* Measured at 3.80 chars/token on the text actually sent to the provider.
   6500 chars is ~1710 tokens, against a hard cap of 8000; the ceiling moved
   from 6300 when posnic_propose_plan declared its corrections property (the
   plan tool input carries the local checker's corrections for the card). */
const MAX_PAYLOAD_CHARS = 6500;
/* Above this the fixed payload is drifting back; below it a description was
   probably deleted rather than rewritten. */
const MIN_PAYLOAD_CHARS = 5600;

const registry = [];

async function registerTools() {
  if (registry.length) return registry;
  const { createPosnicToolPlugin } = require(PLUGIN);
  const plugin = createPosnicToolPlugin({ store: { get: () => null } });
  await plugin.setup({
    tool: {
      async transform(fn) {
        return fn({ add(definition) { registry.push(definition); } });
      },
    },
  });
  return registry;
}

/* Everything the model is charged for: the text of every tool description
   plus its input schema as JSON. */
function payloadChars(tools) {
  return tools.reduce(
    (total, tool) => total + String(tool.description || '').length +
      JSON.stringify(tool.input || {}).length,
    0,
  );
}

/* The part that must never drift: property names, types, enums, bounds,
   required lists, patterns. Descriptions are deliberately excluded so prose
   can be tightened without touching behaviour. */
function structuralView(value) {
  if (Array.isArray(value)) return value.map(structuralView);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'description') continue;
      out[key] = structuralView(item);
    }
    return out;
  }
  return value;
}

function fingerprint(tools) {
  const out = {};
  for (const tool of tools) {
    out[tool.name] = structuralView(tool.input);
  }
  return out;
}

test('every assistant tool is registered exactly once', async () => {
  const tools = await registerTools();
  const { TOOL_NAMES } = require(PLUGIN);
  assert.deepStrictEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
    'the registry and the registered tools must agree',
  );
  assert.strictEqual(
    new Set(tools.map((tool) => tool.name)).size,
    tools.length,
    'a tool registered twice would be sent twice',
  );
});

/* The system prompt and the tool descriptions travel together on every
   request, so a rule may live in either one. What must never happen is a rule
   disappearing from both, which is what a "repack" normally achieves. */
function combinedPayload(tools) {
  const { systemPrompt } = require(path.join(ROOT, 'src', 'ai', 'provider-registry.js'));
  return [
    systemPrompt(),
    ...tools.map((tool) => `${tool.name} ${tool.description} ${JSON.stringify(tool.input)}`),
  ].join('\n').toLowerCase();
}

test('the fixed tool payload stays inside the request budget', async () => {
  const tools = await registerTools();
  const chars = payloadChars(tools);
  assert.ok(
    chars <= MAX_PAYLOAD_CHARS,
    `tool schemas are ${chars} chars; the budget is ${MAX_PAYLOAD_CHARS} ` +
      `(~${Math.round(MAX_PAYLOAD_CHARS / 3.8)} tokens of an 8000-token cap)`,
  );
  assert.ok(
    chars >= MIN_PAYLOAD_CHARS,
    `tool schemas are only ${chars} chars; a description was deleted instead of rewritten`,
  );
});

test('every tool carries a description', async () => {
  const tools = await registerTools();
  for (const tool of tools) {
    assert.ok(
      String(tool.description || '').trim().length > 0,
      `${tool.name} has no description`,
    );
  }
});

test('no constraint-bearing schema mechanic changed', async () => {
  const tools = await registerTools();
  assert.ok(
    fs.existsSync(FINGERPRINT),
    'record the fingerprint first: node tests/ai-tool-schema-size.test.js --record',
  );
  const expected = JSON.parse(fs.readFileSync(FINGERPRINT, 'utf8'));
  assert.deepStrictEqual(
    fingerprint(tools),
    expected,
    'property names, types, enums, bounds, required lists and patterns are ' +
      'enforced; only descriptions may change',
  );
});

test('critical constraints survive in the payload the model reads', async () => {
  const tools = await registerTools();
  const text = combinedPayload(tools);

  /* Each phrase stands for a rule that, when it disappeared, produced a real
     failure in the field. Losing the phrase means losing the rule. The rule
     may be phrased in the system prompt or in a tool description; what it may
     not be is gone. */
  const required = [
    'nothing is saved',            // a preview is never a write
    'press confirm',                // the user must confirm
    'do not claim',                // never claim the change is done
    'create_product',              // plan actions
    'adjust_stock',
    'selling_price',
    'cost_price',
    'opening_stock',
    'stock_mode',
    'mrp_price',
    'leave it uncategorized',      // "no category" must resolve to empty
    'create a named category',      // the other half of that choice
    'attachment id',
    'internal identifier',
    'field labels only',           // missing holds labels, not prose
    'defaults to label',           // option value falls back to its label
    'exact duplicate',             // a create searches only for its own name
    'never hides',                 // the category filter only ranks
    'not synced',                  // local notes stay local
    'preferences',                 // profile section enum
    'never treat them as prices',  // local notes are not shop data
    'never ask for every editable field',  // an update asks only what changed
    'permission question',         // never ask yes/no when values are missing
  ];
  const missing = required.filter((phrase) => !text.includes(phrase));
  assert.deepStrictEqual(missing, [], `constraints dropped: ${missing.join(', ')}`);
});

test('load-bearing sentences keep their negations and quantities', async () => {
  const tools = await registerTools();
  /* The word-coverage check used when the payload was repacked scores a
     sentence on how many content words survived. Negation words are stop
     words, so a sentence that lost its "never" still scores high - the rule
     inverts and the test stays green. These are asserted verbatim, as whole
     sentences, because the negation is the rule. */
  const payload = combinedPayload(tools).replace(/\s+/g, ' ');

  const sentences = [
    'You never save a change yourself.',
    'Never ask for a keyword or category when the user asked for all products.',
    'Do not repeat a search that already answered the question.',
    'Never answer a shop-data question (stock, price, cost, count) from memory, a plan preview or a plan id;',
    'Never invent a product, price, stock count, category, menu name, button, route or report.',
    'Never ask the user to type a record id, product id, attachment id, category id or any internal identifier.',
    'Do not propose or perform sales, purchases, refunds, customers, stock counts or deletes;',
    'Do not invent tax rules or legal requirements.',
    'Do not mention tool names, endpoints, tokens or internal implementation.',
    "Do not default prices or stock to zero or copy a previous product's values.",
    'Do not ask for confirmation for a read.',
    'New product or other shop change: search only the exact name, barcode or SKU the user gave, to catch an exact duplicate;',
    'never ask for every editable field or for price, cost, stock or other fields they did not mention.',
    'never create a near-duplicate.',
    'never choose an unrelated category.',
    'never put product_id in fields.',
    'A settled answer is final; "none" means leave that field empty and is never a name.',
    'Ask once for everything still missing: missing values and the category choice.',
    'An optional image defaults to empty and never blocks the question.',
    'Leave the category empty only when the user says no category or not important.',
    'For add/create, search only the exact name or code to check for an exact duplicate;',
    'never browse similar products.',
    'A step reference only works inside the same plan;',
    "Use the user's local notes only to adapt wording, language and workflow;",
    'they may be stale, are not shop data, and are never a price, stock, category or permission.',
    'Also never record credentials or one-off requests in them.',
    'Never record names, phone numbers, emails, prices, stock, tokens or customer data.',
    'Read this user\'s local notes once at the start of a new conversation.',
    'update_*: only the fields the user wants changed, never fill others.',
    'Always include a compact pending note naming the record, what is known and what is missing, and list the missing fields in missing.',
    'A bare acknowledgement such as',
    'is not a value: keep the request in the collecting stage and ask once for the remaining values.',
  ];

  /* combinedPayload is lower-cased, so compare case-insensitively while the
     assertion still reports the sentence in its original form. */
  const missing = sentences.filter(
    (sentence) => !payload.includes(sentence.toLowerCase().replace(/\s+/g, ' ')),
  );
  assert.deepStrictEqual(
    missing,
    [],
    `negation-bearing sentences no longer verbatim in the payload:\n  ${missing.join('\n  ')}`,
  );
});

test('the schemas are one set, not a budget- or provider-specific variant', () => {
  const source = fs.readFileSync(PLUGIN, 'utf8');

  /* A compact variant selected at request time would be a second copy of every
     rule, and it would go stale the moment the user switches provider
     mid-session. There is exactly one registration path. */
  assert.strictEqual(
    (source.match(/editor\.add\(/g) || []).length,
    9,
    'register each tool once',
  );
  assert.ok(
    !/lowRequestBudget|requestTokens|providerID\s*===|if\s*\(\s*budget/.test(source),
    'plugin.js must not branch on the request budget or the provider when ' +
      'building tool schemas',
  );
});

/*
 * The policy payload obeys the same two rules as the schemas: it must stay
 * small, it must never be a variant, and every rule must have exactly one
 * home. A rule copied into both the prompt and a tool description is two
 * copies waiting to disagree on the next edit.
 */
test('the policy payload stays compact and single-sourced', async () => {
  const tools = await registerTools();
  const { systemPrompt } = require(path.join(ROOT, 'src', 'ai', 'provider-registry.js'));
  const prompt = systemPrompt();

  /* Measured 9358 chars before the compaction, at the same 3.80 chars/token. */
  assert.ok(
    prompt.length <= 7700,
    `policy payload is ${prompt.length} chars; the ceiling is 7700 ` +
      `(~${Math.round(7700 / 3.8)} tokens)`,
  );
  assert.ok(
    prompt.length >= 6800,
    `policy payload is only ${prompt.length} chars; a rule was deleted rather ` +
      'than merged with its surviving copy',
  );

  /* Rules that now have one home and one home only. Two hits would mean the
     prompt and a tool each hold a copy that can drift apart. */
  const combined = `${prompt}\n${tools
    .map((tool) => `${tool.description} ${JSON.stringify(tool.input)}`)
    .join('\n')}`.toLowerCase();
  for (const rule of [
    'press confirm',                   // posnic_propose_plan only
    'nothing is saved',                // posnic_propose_plan only
    'end your turn',                   // posnic_ask_user only
    'at most one cover',               // the plan images schema only
    'permission question',             // the policy payload only
    'list the missing fields in missing', // the policy payload only
  ]) {
    const hits = combined.split(rule).length - 1;
    assert.strictEqual(hits, 1, `"${rule}" should have exactly one home, not ${hits}`);
  }
});

test('the plan schema declares the local checker corrections', async () => {
  /* Claude review #6 item 4: localPlanCall input carries corrections, so the
     tool's schema must accept it even though additionalProperties is false. */
  const tools = await registerTools();
  const plan = tools.find((tool) => tool.name === 'posnic_propose_plan');
  assert.ok(plan, 'posnic_propose_plan is registered');
  assert.ok(plan.input.properties.corrections, 'corrections is a declared property');
  assert.equal(plan.input.properties.corrections.type, 'array');
  assert.equal(plan.input.properties.corrections.maxItems, 8);
  assert.equal(plan.input.additionalProperties, false);
});

if (process.argv.includes('--record')) {
  registerTools().then((tools) => {
    fs.mkdirSync(path.dirname(FINGERPRINT), { recursive: true });
    fs.writeFileSync(
      FINGERPRINT,
      `${JSON.stringify(fingerprint(tools), null, 2)}\n`,
      'utf8',
    );
    console.log(`recorded ${Object.keys(fingerprint(tools)).length} tools -> ${FINGERPRINT}`);
  });
}
