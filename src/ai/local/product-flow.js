/*
 * Local product creation flow.
 *
 * A standard "add one product" request is handled here, before the model is
 * started. The parser collects the values the user actually wrote, the shop's
 * own categories are ranked against those words, and the existing plan
 * validator prepares the same preview the model would prepare. Only a genuine
 * ambiguity, a multi-action request, an update or a side question is handed
 * back to the model with a compact context pack.
 *
 * This module never writes a shop record. The plan it returns still goes
 * through validatePlan and the normal plan store, and the user still confirms
 * it in the page.
 */

'use strict';

const {
  buildProductPlanInput,
  draftImages,
  isComplexCreate,
  isProductCreateRequest,
  looksLikeExtraAsk,
  looksLikeReasoningRequest,
  missingProductFields,
  parseProductDraft,
  sentenceNumbers,
} = require('./product-request');
const { rankCategories } = require('./category-suggest');
const { loadStoreType } = require('./store-type');
const { listCategories } = require('../tools/list-categories');
const { searchProducts } = require('../tools/search-products');
const { validatePlan } = require('../actions/plan-schema');
const { editDistance, normalizeName } = require('../text-match');

const ARABIC_RE = /[\u0600-\u06FF]/;
const MAX_CONTEXT_CATEGORIES = 40;
const MAX_NEARBY_PRODUCTS = 5;

function isArabic(value) {
  return ARABIC_RE.test(String(value || ''));
}

function compactDraft(draft) {
  if (!draft || typeof draft !== 'object') return null;
  const out = {};
  const copy = (key) => {
    const value = draft[key];
    if (value === undefined || value === null || value === '') return;
    out[key] = value;
  };
  copy('name');
  copy('sellingPrice');
  copy('costPrice');
  copy('openingStock');
  copy('costTotal');
  copy('sellingTotal');
  copy('unitsPerPack');
  copy('packCount');
  copy('categoryName');
  copy('categoryId');
  copy('categoryChoice');
  copy('suggestedName');
  copy('barcode');
  if (draft.categoryCreate) out.categoryCreate = true;
  if (draft.costDerived) out.costDerived = true;
  if (draft.sellingDerived) out.sellingDerived = true;
  if (draft.stockFromPack) out.stockFromPack = true;
  if (draft.narrative) out.narrative = true;
  if (draft.priceAmbiguous) out.priceAmbiguous = true;
  if (draft.unsure) out.unsure = true;
  if (Array.isArray(draft.issues) && draft.issues.length) out.issues = draft.issues.slice(0, 8);
  /* Why the local checker refused the parse, and what it rebound: the model
     reads both with the raw sentence instead of trusting a suspect draft. */
  if (Array.isArray(draft.vetoes) && draft.vetoes.length) out.vetoes = draft.vetoes.slice(0, 8);
  if (Array.isArray(draft.corrections) && draft.corrections.length) {
    out.corrections = draft.corrections.slice(0, 8);
  }
  if (Array.isArray(draft.unlabeledAmounts) && draft.unlabeledAmounts.length) {
    out.unlabeledAmounts = draft.unlabeledAmounts.slice(0, 6);
  }
  if (draft.conflicts && Object.keys(draft.conflicts).length) out.conflicts = draft.conflicts;
  return out;
}

function compactDuplicate(item) {
  if (!item) return null;
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
  return {
    id: String(item.id || ''),
    name: String(item.name || '').slice(0, 160),
    sellingPrice: number(item.sellingPrice),
    costPrice: number(item.costPrice),
    stock: number(item.stock),
    ...(item.near ? { near: true } : {}),
  };
}

/* A one-character spelling slip is almost always the same product. A missing
   or extra word ("iPhone 15" vs "iPhone 15 Pro") is a different product, so
   token count must match before the edit distance is considered. */
function isNearDuplicateName(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b || a === b) return false;
  const aTokens = a.split(' ');
  const bTokens = b.split(' ');
  if (aTokens.length !== bTokens.length) return false;
  return editDistance(aTokens.join(''), bTokens.join('')) <= 1;
}

function categoryNames(categories) {
  return (Array.isArray(categories) ? categories : [])
    .map((category) => String((category && category.name) || '').trim())
    .filter(Boolean)
    .slice(0, MAX_CONTEXT_CATEGORIES);
}

/* Turn the local hints into the exact next steps for the model. This is the
   difference between dumping a draft on the model and giving it a route:
   which tools to call, in what order, and which arithmetic is already known.
   The model still verifies every value against the user's words. */
function buildResolutionPlan({
  reason = '',
  message = '',
  draft,
  missing,
  ranking,
  duplicate,
  categoryQuestion = false,
  categoryMissingName = '',
  multiAction = false,
} = {}) {
  if (!draft && !multiAction) return null;
  const tools = [];
  const steps = [];
  if (multiAction || reason === 'complex_commerce') {
    steps.push('Read the whole sentence first and list every logical ask (pack, total, per-unit, discount, percentage, tax or extra action) before calling a tool.');
  }
  if (multiAction) {
    steps.push('Split the request into its actions and handle them in the order the user gave.');
  }
  if (/(?:خصم|تخفيض|discount|%|نسبة|في\s*المية|percent)/iu.test(String(message || ''))) {
    steps.push('The request includes a discount or percentage; clarify what it applies to and show the arithmetic before proposing.');
  }
  if (looksLikeExtraAsk(message)) {
    steps.push('The sentence also asks a question or adds a request; answer that part first with the appropriate tool or a short explanation, then propose the create plan.');
  }
  if (draft && draft.name) {
    tools.push('posnic_search_products');
    steps.push(`Search the current branch for «${draft.name}» before creating it.`);
  }
  const categoryName = (draft && draft.categoryName) ||
    (ranking && ranking.recommended && ranking.recommended.name) || '';
  if (categoryName && draft && draft.categoryId) {
    steps.push(`Use the resolved category «${categoryName}» from the draft.`);
  } else if (categoryName) {
    tools.push('posnic_list_categories');
    steps.push(`Resolve the category «${categoryName}» in the current branch; reuse it if it exists, otherwise create it only as part of the confirmed plan.`);
  }
  if (duplicate) {
    steps.push(`A product named «${duplicate.name}» already exists; ask whether to update it or create a new one. Never create a duplicate silently.`);
  }
  if (categoryQuestion) {
    const candidateNames = (ranking && ranking.candidates || [])
      .map((candidate) => candidate.name)
      .filter(Boolean)
      .slice(0, 3);
    if (categoryMissingName) {
      steps.push(`The category «${categoryMissingName}» was not found; ask whether to create it or choose an existing category.`);
    } else if (candidateNames.length) {
      steps.push(`The category is not clear; show ${candidateNames.join(', ')} and ask the user to choose, or offer to create a new category.`);
    } else {
      steps.push('No category matched; ask whether to create one or keep the product uncategorized.');
    }
  }
  if (draft && Array.isArray(draft.unlabeledAmounts) && draft.unlabeledAmounts.length) {
    steps.push(`The sentence has unlabeled amounts (${draft.unlabeledAmounts.join(', ')}); confirm which one is the selling price, the cost or the stock before proposing.`);
  }
  if (draft && draft.conflicts && Object.keys(draft.conflicts).length) {
    steps.push(`The sentence gives conflicting values (${Object.keys(draft.conflicts).join(', ')}); ask which one is correct.`);
  }
  if (draft && draft.costTotal !== undefined && Number(draft.openingStock) > 0) {
    steps.push(`The pack has ${draft.openingStock} units and costs ${draft.costTotal} in total; the unit cost is ${draft.costPrice} (${draft.costTotal} ÷ ${draft.openingStock}).`);
  } else if (draft && draft.costTotal !== undefined) {
    steps.push(`The user gave a total cost of ${draft.costTotal}; ask for the number of units before deriving the unit cost.`);
  }
  if (draft && draft.sellingTotal !== undefined && Number(draft.openingStock) > 0) {
    steps.push(`The total selling price ${draft.sellingTotal} is for ${draft.openingStock} units; the unit selling price is ${draft.sellingPrice} (${draft.sellingTotal} ÷ ${draft.openingStock}).`);
  } else if (draft && draft.sellingTotal !== undefined) {
    steps.push(`The user gave a total selling price of ${draft.sellingTotal}; ask for the number of units before deriving the unit selling price.`);
  }
  if (draft && draft.sellingPrice !== undefined && draft.costPrice === undefined && draft.costTotal === undefined) {
    steps.push('The user gave a selling price but no cost; ask for the cost instead of inventing one.');
  }
  const missingValues = Array.isArray(missing)
    ? missing
    : (draft ? missingProductFields(draft) : []);
  const mustAsk = missingValues.length > 0 || !!duplicate || categoryQuestion;
  if (mustAsk) {
    tools.push('posnic_ask_user');
    if (missingValues.length) {
      const askValues = (!draft || !draft.name) ? ['name'] : missingValues;
      steps.push(`Ask one short natural question for: ${askValues.join(', ')}.`);
    }
    tools.push('posnic_propose_plan');
    steps.push('After the user answers, continue with the remaining values and propose only when the plan is complete.');
  } else if (draft && draft.name) {
    tools.push('posnic_propose_plan');
    steps.push('Propose one create_product plan with the verified values and the resolved category.');
  } else if (multiAction) {
    tools.push('posnic_ask_user');
    steps.push('Ask for the details needed to act on the request, then propose the matching plan.');
  }
  if (!steps.length) return null;
  return { tools: [...new Set(tools)], steps };
}

function fallbackContext({
  reason,
  message = '',
  draft,
  missing,
  ranking,
  categories,
  duplicate,
  searchResults,
  detail,
  categoryQuestion = false,
  categoryMissingName = '',
  multiAction = false,
} = {}) {
  const missingValues = Array.isArray(missing) ? missing : missingProductFields(draft);
  /* A vetoed parse must not hand the model values the local checker refused:
     the suspect fields are removed, the raw sentence stays authoritative,
     and every number in the sentence is passed as a plain fact so nothing
     the user wrote is lost with them. */
  const vetoes = draft && Array.isArray(draft.vetoes) ? draft.vetoes.slice() : [];
  const draftOut = compactDraft(draft);
  const suspect = [];
  if (vetoes.length && draftOut) {
    const nameVeto = vetoes.some((code) => String(code).startsWith('name_'));
    const valueVeto = vetoes.includes('unresolved_correction') ||
      vetoes.includes('unclaimed_number');
    if (nameVeto || valueVeto) {
      delete draftOut.name;
      suspect.push('name');
    }
    if (valueVeto) {
      delete draftOut.sellingPrice;
      delete draftOut.costPrice;
      delete draftOut.openingStock;
      suspect.push('sellingPrice', 'costPrice', 'openingStock');
    }
  }
  const resolution = buildResolutionPlan({
    reason,
    message,
    draft,
    missing: missingValues,
    ranking,
    duplicate,
    categoryQuestion,
    categoryMissingName,
    multiAction,
  });
  /* The instruction and the resolution plan come before the long category
     list so the prompt cap can never cut the plan off. */
  const context = {
    operation: 'create_product',
    reason,
    instruction: [
      'This is a local pre-check of a product create request.',
      'Treat the draft values as hints extracted from the user sentence, not a finished form.',
      'Verify them against the user words; do not ask for a value that is already recorded.',
      'When a pack size and a total cost are present, the unit cost is total divided by units; never treat a pack total as a unit cost.',
      'Follow the resolution plan: it lists the tools and the order to use.',
      'Ask at most one short question, in your own words and the user\'s language; never paste a fixed template.',
      'Use posnic_ask_user for that question, or posnic_propose_plan when the values are complete.',
      'Do not invent a form and do not search again for a duplicate that was already checked.',
      ...(vetoes.length
        ? ['Fields listed in suspect[] were rejected by the local checker; derive them from the raw sentence and never copy them.']
        : []),
    ].join(' '),
    draft: draftOut,
    missing: missingValues,
    resolution,
    duplicate: compactDuplicate(duplicate),
    category: ranking ? {
      storeType: ranking.storeType || '',
      storeProfiles: ranking.storeProfiles || [],
      storeConfidence: ranking.storeConfidence || '',
      confidence: ranking.confidence || '',
      candidates: (ranking.candidates || []).slice(0, 3).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        score: candidate.score,
        reasons: candidate.reasons,
      })),
      suggestedName: ranking.suggestedName || '',
    } : null,
    categoryNames: categoryNames(categories),
  };
  if (!resolution) delete context.resolution;
  if (draft && draft.costTotal !== undefined && Number(draft.openingStock) > 0) {
    context.calculation = {
      cost_total: draft.costTotal,
      units: Number(draft.openingStock),
      unit_cost: draft.costPrice,
    };
  }
  if (draft && draft.sellingTotal !== undefined && Number(draft.openingStock) > 0) {
    context.calculation = {
      ...(context.calculation || {}),
      selling_total: draft.sellingTotal,
      units: Number(draft.openingStock),
      unit_selling_price: draft.sellingPrice,
    };
  }
  if (detail) context.detail = String(detail).slice(0, 300);
  if (vetoes.length) {
    context.vetoes = vetoes;
    context.suspect = suspect;
    if (message && suspect.includes('sellingPrice')) {
      context.numbersInSentence = sentenceNumbers(message);
    }
  }
  if (Array.isArray(searchResults) && searchResults.length) {
    context.nearbyProducts = searchResults.slice(0, MAX_NEARBY_PRODUCTS).map((item) => ({
      id: String((item && item.id) || ''),
      name: String((item && item.name) || '').slice(0, 160),
    }));
  }
  return context;
}

async function loadCategoryList(api) {
  const result = await listCategories({ limit: 50 }, { api });
  if (!result || result.kind === 'error') {
    return {
      error: result || { code: 'request_failed', message: 'The category list failed.' },
    };
  }
  const categories = Array.isArray(result.categories) ? result.categories : [];
  const total = Number(result.total);
  return {
    categories,
    complete: Number.isFinite(total) ? total <= categories.length : categories.length < 50,
    total: Number.isFinite(total) ? total : categories.length,
  };
}

async function searchProductMatches(api, name) {
  const result = await searchProducts({ query: name, limit: 20 }, { api });
  if (!result || result.kind === 'error') {
    return {
      error: result || { code: 'request_failed', message: 'The product search failed.' },
    };
  }
  return { results: Array.isArray(result.results) ? result.results : [] };
}

/* The image clone resumes the recorded draft; issues, vetoes and confidence
   describe the parse that produced it, not this turn, so they are cleared
   rather than re-fired. Corrections are recorded facts and persist. */
function resetPerTurnFields(draft) {
  delete draft.issues;
  delete draft.vetoes;
  delete draft.confidence;
  return draft;
}

async function runLocalProductFlow({
  message,
  pending = null,
  api,
  branchId = '',
  conversationId = '',
  memory = null,
  attachments = null,
  turn = null,
  userText = '',
  log = () => {},
} = {}) {
  const text = String(message || '').trim();
  if (!text) return { handled: false };

  const previous = pending &&
    (pending.kind === 'create_product' ||
      (pending.draft && pending.draft.kind === 'create_product'))
    ? pending.draft
    : null;
  const pendingProduct = !!(previous && previous.kind === 'create_product');
  const newProductRequest = isProductCreateRequest(text, { pending: previous });
  if (!pendingProduct && !newProductRequest) return { handled: false };

  const arabic = isArabic(text) || isArabic(previous && previous.name);
  const remember = (draft) => {
    if (memory && typeof memory.noteDraft === 'function') {
      memory.noteDraft(conversationId, draft);
    }
    return draft;
  };

  if (turn && turn.sideQuestion) {
    return {
      handled: false,
      context: fallbackContext({
        reason: 'side_question',
        draft: previous,
        detail: 'The user asked a side question. Answer it, then resume the unfinished product request.',
      }),
    };
  }

  if (!api || typeof api.get !== 'function') {
    return {
      handled: false,
      context: fallbackContext({ reason: 'auth_required', draft: previous }),
    };
  }

  /* A settled image answer has already written the draft's image status
     (conversation-memory resolves the click before the flow runs). Its label
     is a decision, not language: parsing it would rebuild the name from the
     button text. Resume the recorded draft exactly as it is, minus the
     per-turn verdicts (issues, vetoes, confidence) that belong to the parse
     which produced it — re-firing them would gate this turn on last turn's
     sentence. Recorded facts such as corrections persist. */
  const clonePrevious = () => {
    const copy = JSON.parse(JSON.stringify(previous));
    /* A vetoed draft still holds the suspect values it was refused for.
       Clearing the vetoes would let an attach click resume it as if it were
       clean, so a draft with vetoes is cloned exactly as it is and stays
       gated to the model. */
    return Array.isArray(copy.vetoes) && copy.vetoes.length
      ? copy
      : resetPerTurnFields(copy);
  };
  const draft = turn && turn.answered && turn.answered.slot === 'image' && previous
    ? clonePrevious()
    : parseProductDraft(text, previous, { pending: previous });

  if (isComplexCreate(text)) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'complex_request',
        message: text,
        draft,
        multiAction: true,
        detail: 'The request contains more than one action. Split it into actions, answer or plan each one, and use the normal plan flow.',
      }),
    };
  }

  if (draft.duplicateAction === 'update' || draft.duplicateAction === 'cancel') {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'duplicate_action',
        draft,
        duplicate: draft.duplicate,
        detail: draft.duplicateAction === 'update'
          ? 'The user chose to edit an existing product; use an update plan.'
          : 'The user chose to cancel the duplicate; confirm the cancellation.',
      }),
    };
  }

  if (draft.issues && draft.issues.length) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'ambiguous_parse',
        draft,
        detail: `The local parser was not confident: ${draft.issues.join(', ')}.`,
      }),
    };
  }

  /* "I don't know" and "not important" need an explanation, not the same
     question again. The model can help the user choose without inventing a
     financial value; the local flow has no safe default for price or cost. */
  if (draft.unsure) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'user_unsure',
        draft,
        detail: 'The user is unsure about a required value or says it is not important. Explain the options and ask at most one short question; never invent a price or cost.',
      }),
    };
  }

  /* A story, a pack, a total cost, a discount, a percentage or any sentence
     with a logical ask is not a form. Forward it to the model with the hints
     and the resolution plan; only a simple explicit form stays local. When in
     doubt this gate forwards, so the deterministic path can never swallow a
     reasoning request again. */
  if (looksLikeReasoningRequest(text, draft)) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'complex_commerce',
        message: text,
        draft,
        detail: 'The request needs reasoning (a pack, a total cost, a per-unit price, a discount or another calculation). Verify the hints, follow the resolution plan, and propose the plan when the values are complete.',
      }),
    };
  }

  /* Without a product name there is nothing to search, rank or categorize.
     The model asks for it in its own words; the local path does not recite a
     template. Known values stay in the draft. */
  if (!draft.name) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'needs_name',
        message: text,
        draft,
        detail: 'The request has no clear product name. Ask for it in one short natural question and keep the recorded values.',
      }),
    };
  }

  /* A duplicate is a decision, not a form. The model asks about it with the
     existing product in view; the local path never creates a duplicate. */
  if (draft.duplicate && !draft.allowDuplicate && !draft.duplicateAction) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'duplicate',
        message: text,
        draft,
        duplicate: draft.duplicate,
        detail: 'A product with this name already exists. Ask whether to update it or create a new one; do not create a duplicate silently.',
      }),
    };
  }

  /* The local checker refused the parse: a correction it could not bind, a
     value nothing claimed, a name that reads like a story. Only a request
     that would otherwise become a plan reaches this gate, so the model reads
     the raw sentence instead of trusting a suspect draft. */
  if (Array.isArray(draft.vetoes) && draft.vetoes.length) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'unverified_parse',
        message: text,
        draft,
        detail: `The local parser refused to trust this draft (${draft.vetoes.join(', ')}). Read the raw sentence and derive the values from it.`,
      }),
    };
  }

  /* One duplicate search per name. The same result is reused by the plan
   * validator, so a standard create does not search the same name twice. */
  let searchResults = null;
  const wantedName = normalizeName(draft.name);
  const duplicateChecked = draft.duplicateChecked === true &&
    normalizeName(draft.duplicateCheckedName) === wantedName;
  if (draft.name && !duplicateChecked) {
    const found = await searchProductMatches(api, draft.name);
    if (found.error) {
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'product_search_failed',
          draft,
          detail: found.error.message,
        }),
      };
    }
    searchResults = found.results;
    draft.duplicateChecked = true;
    draft.duplicateCheckedName = draft.name;
    const exact = searchResults.find((item) => normalizeName(item && item.name) === wantedName);
    if (exact) {
      draft.duplicate = compactDuplicate(exact);
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'duplicate',
          message: text,
          draft,
          duplicate: draft.duplicate,
          detail: 'A product with this exact name already exists. Ask whether to update it or create a new one; do not create a duplicate silently.',
        }),
      };
    }
    const near = searchResults.find((item) => isNearDuplicateName(draft.name, item && item.name));
    if (near) {
      draft.duplicate = { ...compactDuplicate(near), near: true };
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'duplicate',
          message: text,
          draft,
          duplicate: draft.duplicate,
          detail: 'A very close product name already exists. Ask whether this is the same product (update it) or a new one; do not create a duplicate silently.',
        }),
      };
    }
  }

  let categoryList = null;
  let ranking = null;
  let categoryMissingName = '';
  let categoryQuestion = false;
  let category = null;

  const categoriesOnce = async () => {
    if (!categoryList) categoryList = await loadCategoryList(api);
    return categoryList;
  };

  const storeType = draft.storeType !== undefined
    ? draft.storeType
    : await loadStoreType(api, branchId);
  draft.storeType = storeType;

  const resolveNamed = async (name) => {
    const loaded = await categoriesOnce();
    if (loaded.error) return { error: loaded.error };
    /* A named category may be a synonym of one the shop already has
       ("موبايلات" vs "هواتف"), not only an exact spelling. Use the same
       evidence and store-type filter as automatic discovery. */
    const namedRanking = rankCategories({
      name,
      message: name,
      categories: loaded.categories,
      storeType,
      products: [],
    });
    draft.suggestedName = namedRanking.suggestedName || draft.suggestedName || '';
    if (namedRanking.confidence === 'high' && namedRanking.recommended) {
      const chosen = namedRanking.recommended;
      draft.categoryChoice = 'accepted';
      draft.categoryName = chosen.name;
      draft.categoryId = String(chosen.id || '');
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
      draft.categoryCandidates = namedRanking.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        score: candidate.score,
      }));
      draft.categoryAsked = false;
      return { category: chosen };
    }
    if (namedRanking.candidates.length) {
      draft.categoryChoice = '';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
      draft.categoryCandidates = namedRanking.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        score: candidate.score,
      }));
      draft.categoryAsked = false;
      categoryQuestion = true;
      return { candidates: namedRanking.candidates };
    }
    categoryMissingName = name;
    draft.categoryChoice = '';
    draft.categoryName = '';
    draft.categoryId = '';
    draft.categoryCreate = false;
    draft.suggestedCategory = null;
    draft.categoryCandidates = [];
    draft.categoryAsked = false;
    categoryQuestion = true;
    return { missingName: name };
  };

  if (draft.categoryChoice === 'uncategorized') {
    draft.categoryName = '';
    draft.categoryId = '';
    draft.categoryCreate = false;
    draft.suggestedCategory = null;
    draft.categoryCandidates = [];
  } else if (draft.categoryChoice === 'same') {
    /* "same category" means the current category. If the conversation has
       none yet, ask for the category name rather than inventing one. */
    const current = pending && pending.category;
    if (current && (current.id || current.name)) {
      category = { id: current.id || '', name: current.name || '' };
      draft.categoryChoice = 'accepted';
      draft.categoryName = current.name || '';
      draft.categoryId = current.id || '';
      draft.categoryCreate = false;
      draft.categoryAsked = false;
    } else {
      draft.categoryChoice = 'other';
      draft.categoryAsked = false;
      categoryQuestion = true;
    }
  } else if (draft.categoryChoice === 'create' && draft.categoryName) {
    category = { create: true, name: draft.categoryName };
  } else if (draft.categoryChoice === 'create' && !draft.categoryName) {
    categoryQuestion = true;
    draft.categoryAsked = false;
  } else if (draft.categoryChoice === 'other') {
    categoryQuestion = true;
    draft.categoryAsked = false;
  } else if (draft.categoryChoice === 'rejected') {
    const loaded = await categoriesOnce();
    if (loaded.error) {
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'category_read_failed',
          draft,
          detail: loaded.error.message,
        }),
      };
    }
    ranking = rankCategories({
      name: draft.name,
      message: [pending && pending.text, text].filter(Boolean).join(' '),
      categories: loaded.categories,
      storeType,
      products: searchResults || [],
    });
    draft.suggestedName = ranking.suggestedName;
    draft.categoryCandidates = [];
    draft.suggestedCategory = null;
    draft.categoryAsked = false;
    categoryQuestion = true;
  } else if (draft.categoryChoice === 'accepted' && draft.categoryName) {
    if (draft.categoryId) {
      category = { id: draft.categoryId, name: draft.categoryName };
    } else {
      const resolved = await resolveNamed(draft.categoryName);
      if (resolved.error) {
        remember(draft);
        return {
          handled: false,
          context: fallbackContext({
            reason: 'category_read_failed',
            draft,
            detail: resolved.error.message,
          }),
        };
      }
      if (resolved.category) {
        category = { id: resolved.category.id, name: resolved.category.name };
      } else {
        categoryQuestion = true;
      }
    }
  } else if (draft.categoryChoice === 'named' && draft.categoryName) {
    const resolved = await resolveNamed(draft.categoryName);
    if (resolved.error) {
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'category_read_failed',
          draft,
          detail: resolved.error.message,
        }),
      };
    }
    if (resolved.category) {
      category = { id: resolved.category.id, name: resolved.category.name };
    } else {
      categoryQuestion = true;
    }
  } else {
    const loaded = await categoriesOnce();
    if (loaded.error) {
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'category_read_failed',
          draft,
          detail: loaded.error.message,
        }),
      };
    }
    ranking = rankCategories({
      name: draft.name,
      message: [pending && pending.text, text].filter(Boolean).join(' '),
      categories: loaded.categories,
      storeType,
      products: searchResults || [],
    });
    draft.suggestedName = ranking.suggestedName;
    draft.categoryCandidates = (ranking.candidates || []).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      score: candidate.score,
    }));
    draft.suggestedCategory = ranking.recommended
      ? { id: ranking.recommended.id, name: ranking.recommended.name }
      : null;
    if (ranking.confidence === 'high' && ranking.recommended) {
      draft.categoryChoice = 'accepted';
      draft.categoryName = ranking.recommended.name;
      draft.categoryId = ranking.recommended.id;
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
      draft.categoryAsked = false;
      category = { id: ranking.recommended.id, name: ranking.recommended.name };
    } else {
      draft.categoryChoice = '';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.categoryAsked = false;
      categoryQuestion = true;
    }
  }

  const missing = missingProductFields(draft);
  if (missing.length || categoryQuestion) {
    /* No local question. The model writes the follow-up in its own words,
       using the draft, the missing list and the category candidates. The
       local path only proposes a plan when everything is already direct. */
    draft.categoryAsked = !!categoryQuestion;
    draft.awaitingValues = missing.length > 0;
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: missing.length ? 'needs_values' : 'category_choice',
        message: text,
        draft,
        missing,
        ranking,
        categories: categoryList && !categoryList.error ? categoryList.categories : [],
        categoryQuestion,
        categoryMissingName,
        detail: missing.length
          ? 'The request is missing required values. Ask one short natural question for them; do not use a fixed template.'
          : 'The category is not clear. Ask the user to choose from the candidates or keep the product uncategorized; do not use a fixed template.',
      }),
    };
  }

  const planInput = buildProductPlanInput(draft, { category, images: draftImages(draft), arabic });
  if (!planInput) {
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({ reason: 'plan_incomplete', draft, missing }),
    };
  }

  const lookups = {
    categories: categoryList && !categoryList.error ? categoryList.categories : null,
    categoriesComplete: !!(categoryList && !categoryList.error && categoryList.complete),
    /* The duplicate check above is authoritative for this name. An empty
       product list tells the validator not to repeat that search. */
    products: duplicateChecked ? [] : (searchResults || null),
  };
  const allUserText = memory && typeof memory.userTextFor === 'function'
    ? memory.userTextFor(conversationId)
    : [pending && pending.text, userText, text].filter(Boolean).join('\n');

  let validated = await validatePlan(planInput, {
    api,
    sessionID: conversationId,
    attachments,
    userText: allUserText,
    lookups,
  });

  /* "Create category X" where X already exists should use X, not fail and
     make the user repeat the request. */
  if (!validated.ok && validated.code === 'possible_duplicate' &&
      draft.categoryChoice === 'create' && validated.existingName) {
    draft.categoryChoice = 'accepted';
    draft.categoryName = validated.existingName;
    draft.categoryId = String(validated.existingId || '');
    draft.categoryCreate = false;
    const retryInput = buildProductPlanInput(draft, {
      category: { id: draft.categoryId, name: draft.categoryName },
      images: draftImages(draft),
      arabic,
    });
    if (retryInput) {
      validated = await validatePlan(retryInput, {
        api,
        sessionID: conversationId,
        attachments,
        userText: allUserText,
        lookups,
      });
    }
  }

  if (!validated.ok) {
    if (validated.code === 'category_not_found') {
      categoryMissingName = draft.categoryName || '';
      draft.categoryChoice = '';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.categoryCandidates = [];
      draft.categoryAsked = false;
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'category_choice',
          message: text,
          draft,
          ranking,
          categories: categoryList && !categoryList.error ? categoryList.categories : [],
          categoryQuestion: true,
          categoryMissingName,
          detail: 'The named category was not found. Ask whether to create it or choose an existing category; do not use a fixed template.',
        }),
      };
    }
    if (validated.code === 'possible_duplicate' && validated.existingId) {
      const duplicate = compactDuplicate({
        id: validated.existingId,
        name: draft.name,
      });
      draft.duplicate = duplicate;
      remember(draft);
      return {
        handled: false,
        context: fallbackContext({
          reason: 'duplicate',
          message: text,
          draft,
          duplicate,
          detail: 'A product with this name already exists. Ask whether to update it or create a new one; do not create a duplicate silently.',
        }),
      };
    }
    remember(draft);
    return {
      handled: false,
      context: fallbackContext({
        reason: 'plan_rejected',
        draft,
        missing,
        ranking,
        categories: categoryList && !categoryList.error ? categoryList.categories : [],
        duplicate: draft.duplicate,
        detail: validated.message,
      }),
    };
  }

  /* The confirmation card must show what the local checker rebound, so the
     operator sees "price 3000 -> 3200" before committing. */
  if (Array.isArray(draft.corrections) && draft.corrections.length) {
    validated.plan.corrections = draft.corrections.slice(0, 8);
  }
  log(`[AI local] prepared product plan ${validated.plan.id}`);
  return { handled: true, kind: 'plan', plan: validated.plan, draft };
}

module.exports = {
  fallbackContext,
  runLocalProductFlow,
};
