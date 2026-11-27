'use strict';

/*
 * The two failures this work started from, plus the guards around them:
 *
 *  - a profit arithmetic question ("... نكسب 30 الف ... نبيع بكام بناء على
 *    متوسط الارباح") must never be answered with a product price card;
 *  - a self-correcting create ("لأ استنى خليها 3200 ... لأ خليهم 7") must
 *    keep its final values, never swallow a correction clause into the name,
 *    and never hand the model a value the local checker refused.
 *
 * Every money case below is an assertion about what the parser may NOT do:
 * guess, drop or overwrite. A veto means the raw sentence reaches the model
 * with the suspect fields removed, never a suspect draft on its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLocalProductFlow } = require('../src/ai/local/product-flow');
const { parseProductDraft, extractCategory } = require('../src/ai/local/product-request');
const { namedCategory } = require('../src/ai/tools/ask-user');
const { extractIntent } = require('../src/ai/agent/intent');
const { runLiveRead } = require('../src/ai/agent/live-read');
const { scoreNameMatch } = require('../src/ai/text-match');

const F1 = 'احسبلي لو عايزين نكسب 30 الف في الشهر محتاجين نبيع بكام بناء على متوسط الارباح';
const F2 = 'إنشاء منتج مكنسة باناسونيك بـ 3000 جنيه... لأ استنى خليها 3200، والتكلفة 2600، والكمية 5 قطع... لأ خليهم 7، وحطها في الأدوات الكهربائية.';

const ELECTRIC = {
  id: '64b7f0c2a1b2c3d4e5f60004',
  name: 'الأدوات الكهربائية',
  itemCount: 9,
};

function makeApi({ categories = [ELECTRIC], products = [] } = {}) {
  const calls = [];
  const api = {
    calls,
    async get(path, query) {
      calls.push({ path, query });
      if (path === 'categories') {
        return { data: { list: categories, total: categories.length } };
      }
      if (path === 'items/search') {
        const wanted = String((query && query.q) || '').toLowerCase();
        const list = products.filter((item) => {
          const name = String(item.name || '').toLowerCase();
          return name.includes(wanted) || wanted.includes(name);
        });
        return { data: { list } };
      }
      if (path === 'branches/getOneStore') {
        return { data: { business_type: 'electronics' } };
      }
      if (path.startsWith('categories/')) {
        const id = path.slice('categories/'.length);
        return { data: categories.find((category) => category.id === id) || null };
      }
      if (path.startsWith('items/')) {
        const id = path.slice('items/'.length);
        return { data: products.find((item) => item.id === id) || null };
      }
      throw new Error(`Unexpected API path ${path}`);
    },
  };
  return api;
}

function makeMemory() {
  const drafts = new Map();
  return {
    drafts,
    noteDraft(id, draft) {
      drafts.set(id, draft);
    },
    userTextFor() {
      return '';
    },
  };
}

async function run(message, { api = makeApi(), pending = null, turn = { writeRequest: true } } = {}) {
  const memory = makeMemory();
  const result = await runLocalProductFlow({
    message,
    pending,
    api,
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    memory,
    turn,
  });
  return { result, api, memory };
}

function noVetoes(draft) {
  assert.ok(!draft.vetoes || draft.vetoes.length === 0,
    `expected no vetoes, got ${JSON.stringify(draft.vetoes)}`);
}

/* ---------- the two failures ---------- */

test('a profit arithmetic question is never answered with product rows', async () => {
  const intent = extractIntent(F1);

  assert.equal(intent.action, 'unknown');
  assert.equal(intent.reason, 'analytic_ask');
  assert.equal(intent.confidence, 'low');
  assert.equal(intent.live, false);

  /* Belt and braces: even a caller that kept a read intent cannot get rows. */
  const api = makeApi();
  const result = await runLiveRead({ intent: { ...intent, action: 'read_price' }, message: F1, api });
  assert.equal(result, null);
  assert.equal(api.calls.length, 0);
});

test('a self-correcting create keeps every final value and both edits', () => {
  const draft = parseProductDraft(F2);

  assert.equal(draft.name, 'مكنسة باناسونيك');
  assert.equal(draft.sellingPrice, 3200);
  assert.equal(draft.costPrice, 2600);
  assert.equal(draft.openingStock, 7);
  assert.equal(draft.categoryName, 'الأدوات الكهربائية');
  assert.deepEqual(draft.issues, []);
  noVetoes(draft);
  assert.deepEqual(draft.corrections, [
    { field: 'sellingPrice', from: 3000, to: 3200 },
    { field: 'openingStock', from: 5, to: 7 },
  ]);
});

test('a self-correcting create becomes a local plan without the model', async () => {
  const { result, api } = await run(F2);

  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  const fields = result.plan.steps[0].fields;
  assert.equal(fields.name, 'مكنسة باناسونيك');
  assert.equal(fields.selling_price, 3200);
  assert.equal(fields.cost_price, 2600);
  assert.equal(fields.opening_stock, 7);
  assert.equal(fields.category_name, 'الأدوات الكهربائية');
  assert.equal(api.calls.filter((call) => call.path === 'items/search').length, 1);
});

test('the same correction story is a high-confidence create intent', () => {
  const intent = extractIntent(F2);

  assert.equal(intent.action, 'create_product');
  assert.equal(intent.confidence, 'high');
  assert.equal(intent.draft.name, 'مكنسة باناسونيك');
});

/* ---------- correction markers must not eat names ---------- */

test('a correction marker cannot swallow a product name', () => {
  /* "لاب" and "لا سلكي" start like a correction marker; the marker regex
     only matches at a word end, so both names stay whole. */
  const laptop = parseProductDraft('أضف منتج لاب توب ديل بـ 25000');
  assert.equal(laptop.name, 'لاب توب ديل');
  assert.equal(laptop.sellingPrice, 25000);
  noVetoes(laptop);

  const mouse = parseProductDraft('أضف منتج ماوس لا سلكي بـ 300');
  assert.equal(mouse.name, 'ماوس لا سلكي');
  assert.equal(mouse.sellingPrice, 300);
  noVetoes(mouse);
});

test('an unparseable correction target vetoes the draft', () => {
  /* "4K" and "iPhone 16" are not bindable values: the correction survives
     as unresolved instead of being silently dropped. */
  const screen = parseProductDraft('أضف منتج شاشة سامسونج بـ 5000، لأ خليها 4K');
  assert.ok(screen.vetoes.includes('unresolved_correction'));

  const phone = parseProductDraft('أضف منتج هاتف أبل بـ 30000، لأ خليه iPhone 16');
  assert.ok(phone.vetoes.includes('unresolved_correction'));
});

test('chained corrections collapse to the last value', () => {
  const draft = parseProductDraft('أضف منتج مكنسة بـ 3000، لأ استنى خليها 3200، لأ خليها 3300');

  assert.equal(draft.name, 'مكنسة');
  assert.equal(draft.sellingPrice, 3300);
  noVetoes(draft);
  assert.deepEqual(draft.corrections, [{ field: 'sellingPrice', from: 3000, to: 3300 }]);
});

/* ---------- amount shape ---------- */

test('a comma and a dot stay inside the amount they belong to', () => {
  /* "3,200" must survive the clause split so the correction binds to it. */
  const comma = parseProductDraft('أضف منتج ساعة سويسرية بـ 3,200 جنيه، لأ خليها 4000');
  assert.equal(comma.name, 'ساعة سويسرية');
  assert.equal(comma.sellingPrice, 4000);
  noVetoes(comma);
  assert.deepEqual(comma.corrections, [{ field: 'sellingPrice', from: 3200, to: 4000 }]);

  /* "2.5 ألف" is 2500, and the dot is not a clause boundary. */
  const dot = parseProductDraft('أضف منتج كافيه بـ 3000، لأ خليه 2.5 ألف');
  assert.equal(dot.name, 'كافيه');
  assert.equal(dot.sellingPrice, 2500);
  noVetoes(dot);
  assert.deepEqual(dot.corrections, [{ field: 'sellingPrice', from: 3000, to: 2500 }]);
});

/* ---------- conservation ---------- */

test('a value no clause claims vetoes the draft instead of guessing', () => {
  /* No punctuation means no correction clause: 3200 appears in the sentence
     but belongs to nothing, so the parse is refused, not guessed. */
  const draft = parseProductDraft('أضف منتج كافيه بـ 3000 لأ استنى 3200');
  assert.ok(draft.vetoes.includes('unclaimed_number'));
});

test('the refused draft reaches the model with suspect fields removed', async () => {
  const message = 'أضف منتج كافيه بـ 3000 لأ استنى 3200';
  const { result } = await run(message);

  assert.equal(result.handled, false);
  assert.equal(result.context.reason, 'unverified_parse');
  assert.ok(result.context.vetoes.includes('unclaimed_number'));
  assert.ok(result.context.vetoes.includes('name_has_correction'));
  assert.ok(result.context.suspect.includes('name'));
  assert.ok(result.context.suspect.includes('sellingPrice'));
  /* The suspect values are gone; the numbers the user typed are not. */
  assert.equal(result.context.draft.name, undefined);
  assert.equal(result.context.draft.sellingPrice, undefined);
  assert.deepEqual(result.context.numbersInSentence, [3000, 3200]);
});

test('a labeled correction cannot overwrite a sibling field', async () => {
  /* "لأ التكلفة 2500" corrects the cost, not the price: the price clause
     keeps 3000 and the label path reads the new cost. */
  const draft = parseProductDraft('السعر 3000، لأ التكلفة 2500');
  assert.equal(draft.sellingPrice, 3000);
  assert.equal(draft.costPrice, 2500);
  assert.ok(!draft.name);
  noVetoes(draft);

  /* The same shape inside a create still becomes a local plan with the
     price untouched — the marker is stripped, nothing is overwritten. */
  const { result } = await run(
    'أضف منتج خلاط في قسم الأدوات الكهربائية بـ 3000، لأ التكلفة 2500، والكمية 5.',
  );
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'plan');
  const fields = result.plan.steps[0].fields;
  assert.equal(fields.name, 'خلاط');
  assert.equal(fields.selling_price, 3000);
  assert.equal(fields.cost_price, 2500);
  assert.equal(fields.opening_stock, 5);
  assert.equal(fields.category_name, 'الأدوات الكهربائية');
});

test('a typed barcode is a value, not name words', () => {
  const draft = parseProductDraft('أضف منتج ماوس بـ 100 باركود 6291041500012345');

  assert.equal(draft.name, 'ماوس');
  assert.equal(draft.sellingPrice, 100);
  assert.equal(draft.barcode, '6291041500012345');
  noVetoes(draft);
});

test('a quoted name keeps its own numbers', () => {
  const draft = parseProductDraft('أضف منتج "لابتوب 17 إنش" بـ 10000');

  assert.equal(draft.name, 'لابتوب 17 إنش');
  assert.equal(draft.sellingPrice, 10000);
  noVetoes(draft);
});

test('a money-shaped number in the name vetoes the draft', () => {
  const draft = parseProductDraft('أضف منتج Samsung 25000 بـ 30000');

  assert.ok(draft.vetoes.includes('name_has_money_number'));
  assert.ok(draft.vetoes.includes('unclaimed_number'));
});

/* ---------- the analytic lexicon ---------- */

test('the analytic lexicon stops profit questions but keeps ordinary reads live', () => {
  /* Weak words alone ("متوسط", a polite "لو سمحت") are ordinary reads. */
  assert.equal(extractIntent('بيتزا متوسط بكام').action, 'read_price');
  assert.equal(extractIntent('لو سمحت بكام الشاي').action, 'read_price');
  assert.equal(extractIntent('أكتر منتج بيكسب').action, 'read_profit');

  /* A strong analytic shape is never a read, whatever the tail says. */
  const margin = extractIntent('نسبة الربح كام');
  assert.equal(margin.action, 'unknown');
  assert.equal(margin.reason, 'analytic_ask');
});

test('the live read belt stops an analytic sentence even for a hand-built read intent', async () => {
  const api = makeApi();
  const intent = extractIntent('بكام كاتل');
  assert.equal(intent.action, 'read_price');

  const result = await runLiveRead({ intent, message: 'متوسط الارباح كام', api });

  assert.equal(result, null);
  assert.equal(api.calls.length, 0);
});

test('the live accept threshold separates a real name from a story', () => {
  /* LIVE_ACCEPT_MIN in live-read.js is 0.6: at or above it a row is the
     product the user named; below it no row is close enough to answer. */
  assert.ok(scoreNameMatch('كاتل', 'كاتل') >= 0.6);
  assert.ok(scoreNameMatch('سماعات بلوتوث', 'سماعات بلوتوث لاسلكية') >= 0.6);
  assert.ok(scoreNameMatch('بيتزا مارجريتا', 'كاتل') < 0.6);
  assert.ok(scoreNameMatch('كابتشر', 'catle') < 0.6);
});

/* ---------- review #3: the four gaps ---------- */

test('a name objection after a resolved correction still vetoes', () => {
  /* Gap A: "لأ مش مكنسة" leaves words behind, so it is not a bare marker.
     The value correction applies, but the objection must never be dropped
     just because an earlier correction in the same sentence resolved. */
  const draft = parseProductDraft(
    'أضف منتج مكنسة، بسعر 3000، لأ بسعر 3200، لأ مش مكنسة',
  );
  assert.deepEqual(draft.corrections, [{ field: 'sellingPrice', from: 3000, to: 3200 }]);
  assert.equal(draft.sellingPrice, 3200);
  assert.ok(draft.vetoes.includes('unresolved_correction'));
  assert.ok(draft.vetoes.includes('name_has_correction'));
});

test('a count noun after the stock amount is consumed whole, never half', () => {
  /* Gap B: the suffix must end at a word boundary — "لمبات" matched as
     "لمب" used to leave "ات" in the name. */
  const lamps = parseProductDraft('أضف منتج خلاط بـ 3000 والكمية 7 لمبات');
  assert.equal(lamps.name, 'خلاط');
  assert.equal(lamps.openingStock, 7);
  noVetoes(lamps);

  const pairs = parseProductDraft('أضف منتج خلاط بـ 3000 والكمية 5 قطعتين');
  assert.equal(pairs.name, 'خلاط');
  noVetoes(pairs);

  /* An unknown plural stays whole and visible instead of half-eaten. */
  const pills = parseProductDraft('أضف منتج خلاط بـ 3000 والكمية 7 حبوب');
  assert.equal(pills.name, 'خلاط حبوب');
  noVetoes(pills);
});

test('a barcode swallows no adjacent number', () => {
  /* Gap C: "باركود <16 digits>,3000" must capture the barcode only; the
     3000 left behind is unclaimed, so the draft goes to the model rather
     than silently folding the price into the barcode. */
  const draft = parseProductDraft('أضف منتج ماوس بـ 100 باركود 6291041500012345,3000');

  assert.equal(draft.barcode, '6291041500012345');
  assert.ok(draft.vetoes.includes('unclaimed_number'));
  assert.notEqual(draft.sellingPrice, 3000);
});

test('a spec-unit correction never becomes a value correction', () => {
  /* Gap D: "لأ خليها 55 بوصة" is a spec correction, not a price change.
     It must fail as unresolved — not bind 55 as the selling price that the
     conservation pool then skips as a descriptor. */
  for (const message of [
    'أضف منتج مكنسة بـ 3000، لأ خليها 55 بوصة',
    'أضف منتج مكنسة بـ 3000، لأ خليه 2 كيلو',
    'أضف منتج مكنسة بـ 3000، لأ خليها 12 وات',
  ]) {
    const draft = parseProductDraft(message);
    assert.ok(draft.vetoes.includes('unresolved_correction'), message);
    assert.ok(!draft.vetoes.includes('unclaimed_number'), message);
  }
});

test('a labeled correction binds the earlier labeled clause, never -2', () => {
  /* Both clauses carry the same label, so the correction binds the earlier
     clause (index >= 0). Taking the -2 path would leave two selling values
     and first-match extraction could silently keep the stale 3000. */
  for (const message of [
    'بسعر 3000، لأ بسعر 3200',
    'السعر 3000، لأ السعر 3200',
  ]) {
    const draft = parseProductDraft(message);
    assert.equal(draft.sellingPrice, 3200, message);
    assert.deepEqual(
      draft.corrections, [{ field: 'sellingPrice', from: 3000, to: 3200 }], message,
    );
    noVetoes(draft);
  }
});

/* ---------- review #3: shared category terms ---------- */

test('a category name stops before a field, a plain ب and a number', () => {
  assert.equal(
    extractCategory('أضف منتج خلاط في قسم الأدوات الكهربائية بـ 3000').name,
    'الأدوات الكهربائية',
  );
  assert.equal(
    extractCategory('أضف منتج خلاط في قسم الأدوات الكهربائية السعر 3000').name,
    'الأدوات الكهربائية',
  );
  assert.equal(
    extractCategory('أضف منتج خلاط في قسم الأدوات الكهربائية والكمية 7').name,
    'الأدوات الكهربائية',
  );
  /* A number can never join a category name. */
  assert.equal(extractCategory('أضف منتج خلاط في قسم 3000'), null);
  /* The ask-user tool reads the same value with the same shared rules. */
  assert.equal(namedCategory('في قسم الأدوات الكهربائية بـ 3000'), 'الأدوات الكهربائية');
  /* Spoken forms with ه and plain ب must stop in the same place through
     namedCategory itself, not only through extractCategory's regex. */
  assert.equal(namedCategory('في قسم الأدوات الكهربائية والكميه 7'), 'الأدوات الكهربائية');
  assert.equal(namedCategory('في قسم الأدوات الكهربائية بكمية 7'), 'الأدوات الكهربائية');
  assert.equal(namedCategory('في قسم الأدوات الكهربائية ب 3000'), 'الأدوات الكهربائية');
});

/* ---------- Claude review #4: word-end stops, mirrors and separators ---------- */

test('the category stop leaves real category words whole', () => {
  /* Decision 5 regression: the stop is a word, not a prefix. خلي must not
     block خليط, حط must not block حطب, and عدد stops only before digits so
     the shelf العدد والأدوات survives "بـ 100". */
  assert.equal(
    extractCategory('أضف منتج خلاط في قسم خليط').name,
    'خليط',
  );
  assert.equal(
    extractCategory('أضف منتج حطب في قسم حطب').name,
    'حطب',
  );
  assert.equal(
    extractCategory('أضف منتج كابل في قسم العدد والأدوات بـ 100').name,
    'العدد والأدوات',
  );
});

test('the category stop reads the و/ب prefixes and the ة/ه spellings', () => {
  /* Common spoken spelling: والكميه and بكمية must end the category phrase
     instead of becoming part of it. */
  assert.equal(
    extractCategory('أضف منتج في قسم الأدوات الكهربائية والكميه 7').name,
    'الأدوات الكهربائية',
  );
  assert.equal(
    extractCategory('أضف منتج في قسم الأدوات الكهربائية بكمية 7').name,
    'الأدوات الكهربائية',
  );
});

test('a follow-up that really names something else keeps the name and vetoes', () => {
  /* Fail closed (Claude review #5): a rename instruction on a follow-up
     ("خليه Samsung") is neither clobbered nor dropped silently —
     followup_text_unclaimed sends the raw sentence to the model, which can
     perform the rename. Value follow-ups, ACKs and picture phrases yield no
     differing name and stay local. */
  const previous = { name: 'iPhone 15', sellingPrice: 50000 };

  const rename = parseProductDraft('خليه Samsung', previous, { pending: previous });
  assert.equal(rename.name, 'iPhone 15');
  assert.ok(rename.vetoes.includes('followup_text_unclaimed'));

  const values = parseProductDraft('السعر 45000 والتكلفة 30 والكمية 9', previous, { pending: previous });
  assert.equal(values.name, 'iPhone 15');
  assert.equal(values.sellingPrice, 45000);
  assert.ok(!(values.vetoes || []).includes('followup_text_unclaimed'));

  const ack = parseProductDraft('تمام', previous, { pending: previous });
  assert.equal(ack.name, 'iPhone 15');
  assert.ok(!(ack.vetoes || []).includes('followup_text_unclaimed'));

  const picture = parseProductDraft('استخدم الصورة المرفقة.', previous, { pending: previous });
  assert.equal(picture.name, 'iPhone 15');
  assert.ok(!(picture.vetoes || []).includes('followup_text_unclaimed'));
});

test('a category answer or skip on an open draft never vetoes', () => {
  /* Claude review #6 check 1: an earlier gate claims these follow-ups, so
     the conflict check must not run — extractName("موبايلات") would return
     the answer itself, differ from the recorded name and send every category
     reply to the model. */
  const previous = { name: 'iPhone 15', sellingPrice: 50000, kind: 'create_product' };
  const pending = { ...previous, categoryAsked: true };

  const named = parseProductDraft('موبايلات', previous, { pending });
  assert.ok(!(named.vetoes || []).includes('followup_text_unclaimed'));
  assert.equal(named.categoryChoice, 'named');
  assert.equal(named.categoryName, 'موبايلات');
  assert.equal(named.name, 'iPhone 15');

  const skip = parseProductDraft('مش مهم', previous, { pending });
  assert.ok(!(skip.vetoes || []).includes('followup_text_unclaimed'));
  assert.equal(skip.categoryChoice, 'uncategorized');

  const none = parseProductDraft('بدون تصنيف', previous, { pending });
  assert.ok(!(none.vetoes || []).includes('followup_text_unclaimed'));
  assert.equal(none.categoryChoice, 'uncategorized');
});

test('a vetoed follow-up keeps the values it extracted', () => {
  /* Claude review #6 check 2: يا باشا makes the sentence a rename conflict,
     but the values stay on the draft — followup_text_unclaimed is neither a
     name veto nor a value veto, so the model-facing draft keeps them and the
     raw sentence is passed as well; nothing the user wrote is lost. */
  const previous = { name: 'iPhone 15', sellingPrice: 50000, kind: 'create_product' };
  const draft = parseProductDraft(
    'السعر 45000 والتكلفة 30 والكمية 9 يا باشا',
    previous,
    { pending: previous },
  );
  assert.ok(draft.vetoes.includes('followup_text_unclaimed'));
  assert.equal(draft.name, 'iPhone 15');
  assert.equal(draft.sellingPrice, 45000);
  assert.equal(draft.costPrice, 30);
  assert.equal(draft.openingStock, 9);
});

test('money evidence never binds a correction to stock', () => {
  /* Claude review #6 item 6: جنيه or بـ makes the correction a price, so
     "الكمية 200، لأ خليها 3200 جنيه" — a 16x jump, under the magnitude
     guard — must not write money as a count. It stays unresolved for the
     model; a plain quantity correction still binds. */
  const pounds = parseProductDraft('أضف منتج ساعة، الكمية 200، لأ خليها 3200 جنيه');
  assert.ok(pounds.vetoes.includes('unresolved_correction'));
  assert.equal(pounds.openingStock, 200);

  const idiom = parseProductDraft('أضف منتج ساعة، الكمية 200، لأ بـ 3200');
  assert.ok(idiom.vetoes.includes('unresolved_correction'));
  assert.equal(idiom.openingStock, 200);

  const quantity = parseProductDraft('أضف منتج ساعة، الكمية 5، لأ خليها 7');
  assert.ok(!(quantity.vetoes || []).includes('unresolved_correction'));
  assert.equal(quantity.openingStock, 7);
});

test('a count-noun correction fails unconsumed and goes to the model', () => {
  /* Mirror of the spec-unit case in the most common spoken form: the count
     noun is not stripped, so the clause is unconsumed and the draft reaches
     the model instead of silently changing stock. */
  for (const message of [
    'أضف منتج ساعة، الكمية 7 قطع، لأ الكمية 7 قطع',
    'أضف منتج ساعة، الكمية 7 قطع، لأ خليها 7 قطع',
  ]) {
    const draft = parseProductDraft(message);
    assert.ok(draft.vetoes.includes('unresolved_correction'), message);
    assert.ok(!draft.vetoes.includes('unclaimed_number'), message);
  }
});

test('an unlabeled correction binds only the immediately preceding clause', () => {
  /* Decision 4: "لأ خليها 3200" carries no field name, so it may only bind
     the clause right before it. The magnitude guard then refuses an
     unlabeled jump of 20x or more — stock 5 -> 3200 reads as a mis-bind,
     not an edit — and sends the sentence to the model unresolved; a real
     self-correction (3000 -> 3200) binds as before. With no number clause
     behind it the correction goes unresolved instead of guessing. */
  const bound = parseProductDraft('أضف منتج ساعة، السعر 3000، لأ خليها 3200');
  assert.equal(bound.sellingPrice, 3200);
  assert.deepEqual(bound.corrections, [{ field: 'sellingPrice', from: 3000, to: 3200 }]);
  assert.ok(!(bound.vetoes || []).includes('unresolved_correction'));

  const jump = parseProductDraft('أضف منتج ساعة، السعر 3000، الكمية 5، لأ خليها 3200');
  assert.equal(jump.sellingPrice, 3000);
  assert.equal(jump.openingStock, 5);
  assert.ok(!(jump.corrections || []).length);
  assert.ok(jump.vetoes.includes('unresolved_correction'));

  const unbound = parseProductDraft('أضف منتج ساعة، لأ 3200');
  assert.ok(unbound.vetoes.includes('unresolved_correction'));
});

test('Arabic thousands separators fold into the amount', () => {
  /* foldDigits must fold ٬ and ٫ with the digits: ٣٬٢٠٠ is 3200, not a
     number the field regex stops reading at the separator. */
  const draft = parseProductDraft('أضف منتج ساعة بـ ٣٬٢٠٠ جنيه');
  assert.equal(draft.sellingPrice, 3200);
  assert.ok(!(draft.vetoes || []).includes('unclaimed_number'));
});
