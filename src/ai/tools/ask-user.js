/*
 * A structured clarification question.
 *
 * When the assistant genuinely needs a choice, it calls this tool instead of
 * writing a list of options into prose. The page renders the question with
 * clickable buttons, so the user answers with one tap and the same answer is
 * sent back as their next message.
 */

'use strict';

const { text } = require('./values');
const { isHowToQuestion } = require('../text-match');
const { CATEGORY_STOP_WORDS, CATEGORY_PHRASE_RE } = require('../category-terms');

const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS = 4;
const MAX_LABEL_CHARS = 80;
const MAX_VALUE_CHARS = 160;
const MAX_PENDING_CHARS = 500;
const MAX_MISSING = 8;

/* CATEGORY_PHRASE_RE and CATEGORY_STOP_WORDS come from ../category-terms:
   the parser reads the same category value with the same stop rules. */
const CATEGORY_WORD_RE = /(?:فئة|تصنيف|قسم|category)/i;
const CATEGORY_CHOICE_RE = /(?:أنشئ|إنشاء|انشئ|انشاء|أترك|اترك|بدون\s+(?:تصنيف|فئة)|من\s+غير\s+(?:تصنيف|فئة)|leave\s+(?:it\s+)?uncategorized|create\s+(?:a\s+)?(?:suitable\s+)?category|without\s+(?:a\s+)?category)/i;
const IMAGE_WORD_RE = /(?:صورة|صور|image|photo|picture)/i;
const PRODUCT_DRAFT_RE = /(?:selling[_ ]?price|cost[_ ]?price|opening[_ ]?stock|سعر\s+البيع|سعر\s+التكلفة|الكمية\s+(?:المبدئية|المتوفرة))/i;
const CREATE_DRAFT_RE = /(?:أضيف|اضيف|أضف|اضف|ضيف|إضافة|اضافة|إنشاء|انشاء|new product|add product|create product|add item|new item)/i;
const PRODUCT_CONTEXT_RE = /(?:منتج|صنف|برودكت|product|item)/i;
const CREATE_CATEGORY_EN_RE = /^create\s+(?:a\s+)?(?:new\s+)?category\s*[:\-]?\s*(.*)$/i;
const LEAVE_UNCATEGORIZED_EN_RE = /^leave\s+(?:it\s+)?uncategorized\.?$/i;
const ARABIC_RE = /[\u0600-\u06FF]/;
/* A yes/no permission question ("shall I enter the details?") spends a whole
   turn without collecting a value. When fields are missing, rewrite it into
   the question that asks for those fields. Image/category questions are
   genuine choices, so they are left alone. */
const PERMISSION_ONLY_RE = new RegExp([
  '(?:^|\\s)(?:هل\\s+)?(?:تريد|تحب|عايز|عاوز|تود)\\s+(?:أن\\s+|ان\\s+)?(?:أدخل|ادخل|إدخال|ادخال|أكمل|اكمل|نكمل|أتابع|اتابع|أبدأ|ابدا|أضيف|اضيف|إضافة|اضافة|المتابعة|الاستمرار|استمرار)\\b',
  '(?:^|\\s)(?:أكمل|اكمل|نكمل|أتابع|اتابع)\\s*[؟?]?\\s*$',
  '^(?:do you want|would you like|shall i|should i|can i|may i)\\s+(?:me\\s+)?(?:to\\s+)?(?:add|enter|continue|proceed|save|create|go ahead)\\b',
].join('|'), 'i');

const UPDATE_REQUEST_RE = /(?:^|\s)(?:edit|update|change|modify|rename|adjust|set|fix|correct|تعديل|عدل|عدّل|غير|غيّر|حدث|حدّث|تغيير|تعدل)(?:\s|$)/i;
const ATTACHMENT_ID_RE = /(?:attachment|file|image)\s*(?:id|identifier)\b|(?:id|identifier)\s*(?:for|of)?\s*(?:the\s+)?(?:attachment|file|image)\b|معرّف\s*(?:المرفق|مرفق|الصورة)|معرف\s*(?:المرفق|مرفق|الصورة)|attachment_id/i;
const RECORD_ID_RE = /(?:product|item|record|category)\s*(?:id|identifier)\b|(?:id|identifier)\s*(?:for|of)?\s*(?:the\s+)?(?:product|item|record|category)\b|معرّف\s*(?:المنتج|منتج|السجل|سجل|الفئة|فئة|الصنف|صنف)|معرف\s*(?:المنتج|منتج|السجل|سجل|الفئة|فئة|الصنف|صنف)|(?:product|item|record|category)_id/i;
const GENERIC_ID_RE = /(?:^|\s)(?:the\s+)?id(?:\s|$)|(?:^|\s)(?:آي|اي)\s*دي(?:\s|$)/i;
const UPDATE_SCOPE_FIELDS = [
  ['selling_price', /(?:selling|sale|sell|price|سعر|بيع|بسعر)/i],
  ['cost_price', /(?:cost|purchase|company|تكلفة|التكلفة|شراء)/i],
  ['opening_stock', /(?:stock|quantity|qty|مخزون|كمية|الكمية|المخزون)/i],
  ['image', /(?:image|photo|picture|صورة|صور)/i],
];

function normalisedField(value) {
  return String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function fieldsInMissing(missing) {
  const fields = new Set();
  for (const item of missing) {
    const key = normalisedField(item);
    for (const [field, pattern] of UPDATE_SCOPE_FIELDS) {
      if (key === field || pattern.test(key)) fields.add(field);
    }
  }
  return fields;
}

function fieldsInUserWords(value) {
  const fields = new Set();
  for (const [field, pattern] of UPDATE_SCOPE_FIELDS) {
    if (pattern.test(value)) fields.add(field);
  }
  return fields;
}

function localizeCategoryOption(option) {
  const create = String(option.label || '').match(CREATE_CATEGORY_EN_RE);
  if (create) {
    const name = String(create[1] || '').trim();
    const label = name ? `إنشاء فئة ${name}` : 'إنشاء فئة';
    return { label, value: label };
  }
  if (LEAVE_UNCATEGORIZED_EN_RE.test(String(option.label || ''))) {
    const label = 'ترك غير مصنفة';
    return { label, value: label };
  }
  return option;
}
/* CATEGORY_STOP_WORDS comes from ../category-terms — one set for the
   parser's cleanCategoryName and this tool's namedCategory. */

/* Return the category the user already named after "في فئة ...". A short
   answer or a different question must not make the assistant ask which
   category it is; the name is already in the request. */
function namedCategory(value) {
  const match = String(value || '').match(CATEGORY_PHRASE_RE);
  if (!match) return '';
  const kept = [];
  for (const word of match[1].split(/\s+/).filter(Boolean)) {
    const key = word.toLowerCase().replace(/[.!?،,]+$/, '');
    if (CATEGORY_STOP_WORDS.has(key)) break;
    if (key.startsWith('و') && key.length > 2 && CATEGORY_STOP_WORDS.has(key.slice(1))) break;
    kept.push(word);
    if (kept.length >= 3) break;
  }
  return kept.join(' ').trim();
}

function normaliseQuestion(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Models sometimes send only the missing field labels. Compose a readable
   question from them instead of failing the turn on a missing question. */
const MISSING_LABELS = new Map([
  ['name', ['اسم المنتج', 'product name']],
  ['product_name', ['اسم المنتج', 'product name']],
  ['selling_price', ['سعر البيع', 'selling price']],
  ['price', ['سعر البيع', 'selling price']],
  ['cost_price', ['سعر التكلفة', 'cost price']],
  ['cost', ['سعر التكلفة', 'cost price']],
  ['opening_stock', ['كمية الافتتاح', 'opening stock']],
  ['stock', ['الكمية', 'quantity']],
  ['quantity', ['الكمية', 'quantity']],
  ['image', ['صورة المنتج', 'product image']],
  ['product_image', ['صورة المنتج', 'product image']],
  ['category', ['التصنيف', 'category']],
]);

function missingLabel(value, arabic) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const labels = MISSING_LABELS.get(key);
  return labels ? labels[arabic ? 0 : 1] : raw;
}

function missingQuestion(missing, { arabic: forceArabic } = {}) {
  const arabic = typeof forceArabic === 'boolean'
    ? forceArabic
    : missing.some((item) => ARABIC_RE.test(item));
  const labels = [];
  for (const item of missing) {
    const label = missingLabel(item, arabic);
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (!labels.length) return '';
  const prefix = arabic ? 'أحتاج: ' : 'I need: ';
  return text(`${prefix}${labels.join(arabic ? '، ' : ', ')}.`, MAX_QUESTION_CHARS);
}

function askUser(input, {
  pendingText = '',
  pendingNote = '',
  answered = [],
  currentCategory = null,
} = {}) {
  const missing = (Array.isArray(input && input.missing) ? input.missing : [])
    .map((item) => text(item, 60))
    .filter(Boolean)
    .slice(0, MAX_MISSING);

  let question = text(input && input.question, MAX_QUESTION_CHARS) ||
    missingQuestion(missing);
  if (!question) {
    return {
      kind: 'error',
      code: 'missing_question',
      message: 'A clarification question needs text.',
    };
  }
  /* "Do you want to enter the details?" is not a useful question when the
     details are already known to be missing. Ask for the values instead of
     spending another turn on a yes/no answer. */
  const permissionOnly = missing.length > 0 &&
    PERMISSION_ONLY_RE.test(question) &&
    !IMAGE_WORD_RE.test(question) &&
    !CATEGORY_WORD_RE.test(question);
  if (permissionOnly) {
    const rewritten = missingQuestion(missing, { arabic: ARABIC_RE.test(question) });
    if (rewritten) question = rewritten;
  }
  const arabic = ARABIC_RE.test(question);

  /* The user must never be asked for an internal identifier. When the model
     tries to ask for one, return an internal correction it can act on instead
     of showing the question. This is a safety net, not the main workflow. */
  const missingKeys = missing.map(normalisedField);
  const attachmentIdQuestion = ATTACHMENT_ID_RE.test(question) ||
    missingKeys.some((key) => key === 'attachment_id' || key === 'image_attachment_id');
  if (attachmentIdQuestion) {
    return {
      kind: 'error',
      code: 'internal_attachment_id',
      internal: true,
      message: 'Do not ask for an attachment id. Ask the user to attach the image in the chat. When it arrives, use the attachment id from the attachment notice automatically.',
    };
  }
  const recordIdQuestion = RECORD_ID_RE.test(question) ||
    missingKeys.some((key) => ['product_id', 'item_id', 'record_id', 'category_id'].includes(key));
  if (recordIdQuestion) {
    return {
      kind: 'error',
      code: 'internal_record_id',
      internal: true,
      message: 'Do not ask for a record id. Ask for the product name or a short description, call posnic_search_products, show the matching names as choices, and use the selected name as the plan target.',
    };
  }
  if (GENERIC_ID_RE.test(question)) {
    return {
      kind: 'error',
      code: 'internal_id_question',
      internal: true,
      message: 'Do not ask for an internal id. For a product, ask for its name or a short description and search. For an image, ask the user to attach it in the chat.',
    };
  }

  /* An update only asks for the change the user requested. Asking for price,
     cost, stock or an image after "edit that product" is the exact failure
     this guard prevents. Create requests are left alone. */
  const updateRequest = UPDATE_REQUEST_RE.test(pendingText) &&
    !CREATE_DRAFT_RE.test(pendingText) &&
    !isHowToQuestion(pendingText);
  if (updateRequest) {
    const answers = Array.isArray(answered) ? answered : [];
    const userWords = [
      pendingText,
      ...answers.map((item) => item && item.answer).filter(Boolean),
    ].join(' ');
    const userFields = fieldsInUserWords(userWords);
    const requestedFields = fieldsInMissing(missing);
    const extraFields = [...requestedFields].filter((field) => !userFields.has(field));
    if (extraFields.length) {
      const allowed = [...userFields].filter((field) => requestedFields.has(field));
      const message = allowed.length
        ? `This is an update. The user asked to change: ${allowed.join(', ')}. Ask only for those values; do not ask for ${extraFields.join(', ')}.`
        : 'This is an update, not a new product. Do not ask for selling price, cost price, stock or an image unless the user asked to change them. If the product is not identified, ask for its name or a short description and search. Then ask what they want to change.';
      return {
        kind: 'error',
        code: 'update_scope_question',
        internal: true,
        message,
      };
    }
  }

  const rawOptions = !permissionOnly && Array.isArray(input && input.options)
    ? input.options
    : [];
  if (rawOptions.length > MAX_OPTIONS) {
    return {
      kind: 'error',
      code: 'too_many_options',
      message: `Ask with at most ${MAX_OPTIONS} options.`,
    };
  }

  const options = [];
  for (const raw of rawOptions) {
    const label = text(typeof raw === 'string' ? raw : raw && raw.label, MAX_LABEL_CHARS);
    if (!label) continue;
    const value = text(typeof raw === 'string' ? raw : raw && raw.value, MAX_VALUE_CHARS) || label;
    options.push({ label, value });
  }
  if (arabic) {
    for (let index = 0; index < options.length; index += 1) {
      options[index] = localizeCategoryOption(options[index]);
    }
  }

  const settled = (Array.isArray(answered) ? answered : [])
    .filter((item) => item && item.question && item.answer)
    .slice(-6);
  const alreadyCategory = settled.find((item) => CATEGORY_WORD_RE.test(item.question));
  const givenCategory = namedCategory(pendingText);
  const knownCategory = alreadyCategory && alreadyCategory.answer
    ? alreadyCategory.answer
    : (currentCategory && currentCategory.name) || '';

  const mentionsCategory = CATEGORY_WORD_RE.test(question);
  const asksForCategory = missing.includes('category') || mentionsCategory;
  const category = givenCategory || knownCategory;
  if (asksForCategory && category) {
    const remaining = missing.filter((item) => !/(?:category|فئة|قسم)/i.test(item));
    const next = remaining.length
      ? ` Ask only for: ${remaining.join(', ')}.`
      : ' Propose the plan now with the closest active category.';
    return {
      kind: 'error',
      code: 'category_already_given',
      internal: true,
      message: `The category is already settled as "${category}". Use it; do not ask the user for a category again.${next}`,
    };
  }

  /* The same question, word for word, was already answered. A model that
     loops on its clarification must be stopped here rather than in front of
     the user; the answer is already in memory. */
  const askedKey = normaliseQuestion(question);
  const repeated = settled.find(
    (item) => askedKey && normaliseQuestion(item.question) === askedKey
  );
  if (repeated) {
    return {
      kind: 'error',
      code: 'question_already_answered',
      internal: true,
      message: `That question was already answered: ${repeated.question} -> ${repeated.answer}. Continue with that answer; do not ask it again.`,
    };
  }

  const suffixes = [];
  const notes = [];
  const draftText = `${pendingText} ${(input && input.pending) || ''}`;
  const productContext =
    (CREATE_DRAFT_RE.test(draftText) && PRODUCT_CONTEXT_RE.test(draftText)) ||
    missing.some((item) => /opening[_ ]?stock|الكمية\s+المبدئية/i.test(item));
  const productDraft = productContext &&
    (missing.some((item) => PRODUCT_DRAFT_RE.test(item)) || missing.includes('category'));
  const hasCategoryOption = options.some((option) => CATEGORY_WORD_RE.test(option.label));
  /* A product question must offer the category decision, not only ask
     whether the user wants a category. The model sometimes omits the
     create-or-leave choice; make the question actionable without another
     model round trip. */
  if (productDraft && mentionsCategory && !hasCategoryOption && !CATEGORY_CHOICE_RE.test(question)) {
    suffixes.push(arabic
      ? ' وبالنسبة للفئة: أنشئ تصنيفًا مناسبًا أم اترك المنتج بدون تصنيف؟'
      : ' For the category: create a suitable category or leave the product uncategorized?');
    notes.push(arabic
      ? 'اسأل أيضًا: أنشئ تصنيفًا مناسبًا أم اترك المنتج بدون تصنيف؟'
      : 'Also ask: create a suitable category or leave the product uncategorized?');
  }
  /* The optional image belongs to the same question. Asking it in a later
     turn annoys the user and hides that it was never required. */
  const imageMentioned = IMAGE_WORD_RE.test(question) || IMAGE_WORD_RE.test(pendingText);
  const imageAlreadyAsked = /(?:optional image|صورة اختيارية)/i.test(pendingNote) ||
    settled.some((item) => IMAGE_WORD_RE.test(item.question));
  if (productDraft && !imageMentioned && !imageAlreadyAsked) {
    suffixes.push(arabic
      ? ' أرفق صورة إن وجدت.'
      : ' Attach an image if you have one.');
    notes.push(arabic
      ? 'صورة اختيارية: اسأل عنها الآن ولا تسأل مرة أخرى إذا لم تُرفق.'
      : 'Optional image: ask now; do not ask again if it is not attached.');
  }

  let finalQuestion = question;
  let pending = text(input && input.pending, MAX_PENDING_CHARS);
  if (suffixes.length) {
    const suffix = suffixes.join('');
    const room = Math.max(0, MAX_QUESTION_CHARS - suffix.length);
    finalQuestion = `${question.slice(0, room).trim()}${suffix}`;
    pending = text(`${pending} ${notes.join(' ')}`.trim(), MAX_PENDING_CHARS);
  }

  return {
    kind: 'clarify',
    question: finalQuestion,
    options,
    pending,
    missing,
  };
}

function formatForModel(result) {
  if (!result) return 'The clarification question was not shown.';
  if (result.kind === 'error') {
    return `The clarification question could not be shown: ${result.message}`;
  }
  /* The tool call arguments and the page card already hold the question and
     choices. Repeating them in the result wastes context on every step. */
  return 'The clarification question is already visible to the user. End your turn and wait for the answer; do not repeat it, list choices or start a new search. The next answer continues the same unfinished request.';
}

module.exports = {
  MAX_LABEL_CHARS,
  MAX_OPTIONS,
  MAX_PENDING_CHARS,
  MAX_QUESTION_CHARS,
  askUser,
  formatForModel,
  missingLabel,
  missingQuestion,
  namedCategory,
};

