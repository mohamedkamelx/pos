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

const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS = 4;
const MAX_LABEL_CHARS = 80;
const MAX_VALUE_CHARS = 160;
const MAX_PENDING_CHARS = 500;
const MAX_MISSING = 8;

const CATEGORY_PHRASE_RE = /(?:^|\s)(?:في|فى|داخل|ضمن|in|under)\s+(?:فئة|قسم|category)\s+([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/i;
const CATEGORY_WORD_RE = /(?:فئة|تصنيف|قسم|category)/i;
const CATEGORY_CHOICE_RE = /(?:أنشئ|إنشاء|انشئ|انشاء|أترك|اترك|بدون\s+(?:تصنيف|فئة)|من\s+غير\s+(?:تصنيف|فئة)|leave\s+(?:it\s+)?uncategorized|create\s+(?:a\s+)?(?:suitable\s+)?category|without\s+(?:a\s+)?category)/i;
const IMAGE_WORD_RE = /(?:صورة|صور|image|photo|picture)/i;
const PRODUCT_DRAFT_RE = /(?:selling[_ ]?price|cost[_ ]?price|opening[_ ]?stock|سعر\s+البيع|سعر\s+التكلفة|الكمية\s+(?:المبدئية|المتوفرة))/i;
const CREATE_DRAFT_RE = /(?:أضيف|اضيف|أضف|اضف|ضيف|إضافة|اضافة|إنشاء|انشاء|new product|add product|create product|add item|new item)/i;
const PRODUCT_CONTEXT_RE = /(?:منتج|صنف|برودكت|product|item)/i;
const CREATE_CATEGORY_EN_RE = /^create\s+(?:a\s+)?(?:new\s+)?category\s*[:\-]?\s*(.*)$/i;
const LEAVE_UNCATEGORIZED_EN_RE = /^leave\s+(?:it\s+)?uncategorized\.?$/i;
const ARABIC_RE = /[\u0600-\u06FF]/;

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
const CATEGORY_STOP_WORDS = new Set([
  'و', 'أو', 'او', 'ثم', 'بس', 'بسعر', 'سعر', 'السعر', 'وكمية', 'كمية',
  'الكمية', 'وتكلفة', 'تكلفة', 'التكلفة', 'ووصف', 'وصف', 'الوصف', 'وخلي',
  'خلي', 'خلى', 'ويكون', 'يكون', 'علشان', 'عشان', 'مع', 'في', 'فى', 'من',
  'الى', 'إلى', 'على', 'والتكلفة', 'والكمية', 'والوصف', 'جديدة', 'جديد',
  'new', 'and', 'with', 'for', 'price', 'cost', 'stock', 'quantity',
  'description',
]);

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

function askUser(input, {
  pendingText = '',
  pendingNote = '',
  answered = [],
  currentCategory = null,
} = {}) {
  const question = text(input && input.question, MAX_QUESTION_CHARS);
  if (!question) {
    return {
      kind: 'error',
      code: 'missing_question',
      message: 'A clarification question needs text.',
    };
  }
  const arabic = ARABIC_RE.test(question);

  const rawOptions = Array.isArray(input && input.options) ? input.options : [];
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

  const missing = (Array.isArray(input && input.missing) ? input.missing : [])
    .map((item) => text(item, 60))
    .filter(Boolean)
    .slice(0, MAX_MISSING);

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
};

