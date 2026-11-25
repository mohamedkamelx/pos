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

function askUser(input, { pendingText = '' } = {}) {
  const question = text(input && input.question, MAX_QUESTION_CHARS);
  if (!question) {
    return {
      kind: 'error',
      code: 'missing_question',
      message: 'A clarification question needs text.',
    };
  }

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

  const missing = (Array.isArray(input && input.missing) ? input.missing : [])
    .map((item) => text(item, 60))
    .filter(Boolean)
    .slice(0, MAX_MISSING);

  const asksForCategory = missing.includes('category') ||
    (/(?:فئة|قسم|category)/i.test(question) &&
      options.some((option) => /(?:فئة|قسم|category)/i.test(option.label)));
  const category = namedCategory(pendingText);
  if (asksForCategory && category) {
    const remaining = missing.filter((item) => !/(?:category|فئة|قسم)/i.test(item));
    const next = remaining.length
      ? ` Ask only for: ${remaining.join(', ')}.`
      : ' Propose the plan now with the closest active category.';
    return {
      kind: 'error',
      code: 'category_already_given',
      internal: true,
      message: `The unfinished request already names the category "${category}". Use the closest active category from posnic_list_categories; do not ask the user for a category again.${next}`,
    };
  }

  return {
    kind: 'clarify',
    question,
    options,
    pending: text(input && input.pending, MAX_PENDING_CHARS),
    missing,
  };
}

function formatForModel(result) {
  if (!result) return 'The clarification question was not shown.';
  if (result.kind === 'error') {
    return `The clarification question could not be shown: ${result.message}`;
  }
  const choices = result.options.length
    ? result.options.map((option) => `- ${option.label}`).join('\n')
    : 'The user will type the missing detail.';
  const lines = [
    'The question below is already visible to the user. Do not repeat it or list the choices again.',
    result.question,
    choices,
    'End your turn and wait for the user to choose.',
  ];
  if (result.pending) {
    lines.push(`The unfinished request is recorded as: ${result.pending}. Continue it after the answer; do not start a search.`);
  }
  if (result.missing && result.missing.length) {
    lines.push(`Still missing: ${result.missing.join(', ')}. Ask once for all missing values, then continue the same request.`);
  }
  return lines.join('\n');
}

module.exports = {
  MAX_LABEL_CHARS,
  MAX_OPTIONS,
  MAX_PENDING_CHARS,
  MAX_QUESTION_CHARS,
  askUser,
  formatForModel,
};

