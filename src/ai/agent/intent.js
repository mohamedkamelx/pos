/*
 * Deterministic intent extraction for the assistant.
 *
 * The model still decides how to answer an unusual request. This module only
 * recognises the shapes that must never be misread: a stock question, an
 * update of a named field, a stock adjustment and a multi-action sentence.
 * It is deliberately conservative. When the words are ambiguous the action is
 * "unknown" and the normal model flow handles the turn.
 *
 * The result is structured input for the task kernel and the plan compiler.
 * It is not a dialogue script and it never invents a value the user did not
 * type.
 */

'use strict';

const {
  extractCategory,
  isProductCreateRequest,
  missingProductFields,
  parseProductDraft,
  parseAmount,
} = require('../local/product-request');
const { isHowToQuestion, normalizeName } = require('../text-match');
const { isAnalyticAsk, queryIsShortEnough } = require('./read-shape');

const ARABIC_RE = /[\u0600-\u06FF]/;

const CREATE_VERB = String.raw`(?:أضيف|اضيف|أضف|اضف|ضيف|ضيفلي|ضيفلى|ضيفي|إضافة|اضافة|إنشاء|انشاء|أنشئ|انشئ|سجل|اعمل|add|create)`;
const UPDATE_VERB = String.raw`(?:عدل|عدّل|تعديل|غير|غيّر|تغيير|حدث|حدّث|edit|update|change|modify|rename|set|fix|correct)`;
const ADJUST_VERB = String.raw`(?:اخصم|أخصم|خصم|اطرح|أطرح|انقص|أنقص|نقص|قلل|أقلل|زود|أزود|زيد|أزيد|زيادة|increase|decrease|subtract|deduct|adjust)`;

const CREATE_RE = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${CREATE_VERB}(?:[\s،,:]|$)`, 'iu');
const UPDATE_RE = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${UPDATE_VERB}(?:[\s،,:]|$)`, 'iu');
const ADJUST_RE = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${ADJUST_VERB}(?:[\s،,:]|$)`, 'iu');
const ADD_STOCK_RE = /(?:^|[^\p{L}\p{N}])(?:أضف|اضف|ضيف|زود|زيد|add|increase)(?=\s|$)[^.!?]{0,40}(?:مخزون|stock|كمية|quantity|الكمية)/iu;
const ADD_STOCK_VERB_RE = /(?:^|[^\p{L}\p{N}])(?:أضف|اضف|ضيف|زود|زيد|add|increase)(?=\s|$)/iu;
const STOCK_CONTEXT_RE = /(?:مخزون|stock|كمية|quantity|رصيد|منهم|منه|منها|فيهم|فيها)/iu;
const PROFIT_RE = /(?:أكتر|أكثر|اعلى|أعلى|احسن|أحسن)\s+(?:منتج|صنف)?[^.!?]{0,30}(?:مكسب|ربح|بيكسب|بتربح|هامش)|(?:most|highest|best)\s+(?:profitable|profit|margin)|profit\s+margin|highest\s+margin|best\s+margin/iu;
const PRICE_RE = /(?:بكام|بكم|كام\s+(?:سعر|سعره)|(?:^|[^\p{L}\p{N}])سعر(?:[\s،,:]|$)|price|how\s+much|what(?:'s|\s+is)\s+the\s+price)/iu;
const STOCK_RE = /(?:كام|كم|how\s+many|stock|مخزون|الكمية|quantity|موجود|متوفر|available|عندنا|عندك|do\s+(?:we|i)\s+have)/iu;
const COUNT_RE = /(?:عدد\s+(?:ال)?(?:منتجات|أصناف|اصناف|منتج|صنف)|(?:كام|كم)\s+(?:منتج|منتجات|صنف|أصناف|اصناف)|how\s+many\s+(?:products|items)|total\s+(?:products|items))/iu;
const LIST_RE = /(?:^|[^\p{L}\p{N}])(?:list|show|اعرض|عرض|كل|all)[^.!?]{0,30}(?:منتجات|أصناف|اصناف|products|items|catalog|كتالوج)/iu;
const NEW_CATEGORY_RE = /(?:^|[^\p{L}\p{N}])(?:ب|في|فى|within|in|with)?\s*(?:فئة|قسم|تصنيف|category)\s+(?:جديدة|جديد|new)(?![\p{L}\p{N}])/iu;
const SAME_CATEGORY_RE = /(?:^|[^\p{L}\p{N}])(?:(?:same|نفس)\s+(?:ال)?(?:فئة|قسم|تصنيف|category)|(?:تبع|على|في|فى|in)\s+(?:نفس\s+)?ال(?:فئة|قسم|تصنيف|category)|(?:تبع|على|في|فى|in)\s+(?:فئة|قسم|تصنيف|category)\s*(?:[،,.!?]|$))/iu;
/* Counts are written as digits or as ordinary Arabic number words. Egyptian
   shop speech says "عشر منتاجات", not "10 منتجات", and the product plural can
   be "منتاجات". Both must reach the bulk flow instead of becoming a product
   named "عشر". */
const ARABIC_BULK_NUMBER = String.raw`(?:عشرين|عشر(?:ة|ه)?|خمسين|خمس(?:ة|ه)?|ستين|ست(?:ة|ه)?|سبعين|سبع(?:ة|ه)?|ثمانين|تمنين|ثمان(?:ية|يه)?|تمن(?:ية|يه|ة|ه)?|تسعين|تسع(?:ة|ه)?|أربعين|اربعين|أربع(?:ة|ه)?|اربع(?:ة|ه)?|ثلاثين|تلاتين|ثلاث(?:ة|ه)?|تلات(?:ة|ه)?|اثنين|اتنين|اثنان|اتنان|واحد(?:ة|ه)?)`;
const BULK_RE = new RegExp(
  String.raw`(\d[\d.,]*|[٠-٩]+|${ARABIC_BULK_NUMBER})\s+(?:منتاجات|منتاج|منتجات|منتج|صنف|أصناف|اصناف|items?|products?)`,
  'iu',
);
const ARABIC_BULK_COUNTS = new Map([
  ['واحد', 1], ['واحده', 1],
  ['اثنين', 2], ['اتنين', 2], ['اثنان', 2], ['اتنان', 2],
  ['ثلاث', 3], ['ثلاثه', 3], ['تلات', 3], ['تلاته', 3],
  ['اربع', 4], ['اربعه', 4],
  ['خمس', 5], ['خمسه', 5],
  ['ست', 6], ['سته', 6],
  ['سبع', 7], ['سبعه', 7],
  ['تمن', 8], ['تمنه', 8], ['تمنيه', 8], ['ثمان', 8], ['ثمانيه', 8],
  ['تسع', 9], ['تسعه', 9],
  ['عشر', 10], ['عشره', 10],
  ['عشرين', 20],
  ['ثلاثين', 30], ['تلاتين', 30],
  ['اربعين', 40],
  ['خمسين', 50],
  ['ستين', 60],
  ['سبعين', 70],
  ['ثمانين', 80], ['تمنين', 80],
  ['تسعين', 90],
]);

function bulkCountKey(value) {
  return String(value || '')
    .trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/\s+/g, ' ');
}

function bulkCount(value) {
  const numeric = parseAmount(value);
  if (numeric !== null) return numeric;
  return ARABIC_BULK_COUNTS.get(bulkCountKey(value)) || null;
}
const IMAGE_RE = /(?:صورة|صور|image|photo|picture)/iu;
const NAME_FIELD_RE = /(?:^|[^\p{L}\p{N}])(?:اسم|name)(?:[\s،,:]|$)/iu;
const SET_VERB_RE = /(?:^|[^\p{L}\p{N}])(?:خلي|خليه|خليها|خليهم|خلى|اجعله|اجعلها|حدد|set|make)(?=\s|$)/iu;

/* The parser is only allowed to take the short, unmistakable path. Anything
   that names another record type, asks for something this parser does not do,
   or carries a second request must go to the model with the whole sentence. */
const OTHER_TARGET_RE = /(?:^|[\s،,])(?:(?:ال)?(?:عميل|فاتورة|مورد|مصروف|موظف|فرع|مستخدم|إعداد|اعداد|إعدادات|اعدادات|تقرير|وردية|كاشير|مرتجع)|customer|invoice|supplier|expense|employee|branch|user|setting|settings|report|shift|cashier|return)(?:[\s،,.:]|$)/iu;
const OTHER_ACTION_RE = /(?:^|[\s،,])(?:احذف|امسح|اطبع|ابعث|ابعت|ارسل|اطلب|ادفع|استرجع|راجع|نبه|كلم|اتصل|احجز|حول|delete|remove|print|send|order|pay|refund|notify|call|email)(?:[\s،,.:]|$)/iu;
const EXTRA_REQUEST_RE = /(?:^|[\s،,])(?:وكمان|كمان|وقولي|قولي|قلي|وأيضاً|وأيضا|ايضا|أيضا|also|and\s+also|then|بعدين|هل|what|how|why|when|where)(?:[\s،,.:]|$)/iu;
const MIXED_JOIN_RE = /(?:^|[\s،,])(?:و|and)\s*(?:اعرض|وريني|قولي|قلي|ابعت|اطلب|احسب|سجل|راجع|اطبع)(?:[\s،,.:]|$)/iu;

const SEGMENT_SPLIT_RE = new RegExp(
  String.raw`(?:[،,;]\s*|\s+)(?:و|and|then|بعدين|كمان|وكمان)\s*` +
  String.raw`(?=(?:${CREATE_VERB}|${UPDATE_VERB}|${ADJUST_VERB})(?:[\s،,:]|$))`,
  'giu',
);

const GENERIC_TARGET_RE = /^(?:(?:ال)?(?:منتج|صنف|برودكت|product|item|حاجة|حاجه|شيء|شي|ده|دي|دا|this|that|the|it|one|another|تاني|تانية|آخر|اخر|اخرى|أخرى|الجديد|الجديدة|new)(?:\s+|$))*$/iu;

const LEADING_NOISE_RE = /^(?:(?:شوفلي|شوف|قولي|قول|اعرف|أعرف|احسب|أحسب|الأول|اول|أولا|اولا|إحنا|احنا|إحنى|عندنا|عندك|هل|هو|هي|لو\s+سمحت|من\s+فضلك|please|can\s+you|could\s+you|tell\s+me|show\s+me|i\s+just\s+want\s+to|i\s+want\s+to|i\s+would\s+like\s+to|i'd\s+like\s+to|i\s+need\s+to|want\s+to|would\s+like\s+to|need\s+to|do|we|i|have|the|a|an|just)\s+)+/giu;

const TRAILING_NOISE_RE = /(?:^|\s+)(?:عندنا|عندك|النهاردة|النهارده|دلوقتي|دلوقت|حالياً|حاليا|now|today|please|من\s+فضلك|بتاعنا|بتاعنا|اللي\s+عندنا|in\s+stock|on\s+hand|available)\s*$/giu;

const FUNCTION_WORDS = new Set([
  'i', 'just', 'want', 'to', 'would', 'like', 'need', 'please', 'the',
  'a', 'an', 'for', 'me', 'it', 'that', 'this', 'product', 'item', 'one',
  'another', 'new', 'of', 'about', 'from', 'and', 'my', 'our',
  'منتج', 'الصنف', 'صنف', 'برودكت', 'حاجه', 'حاجة', 'شي', 'ده', 'دي',
  'دا', 'تاني', 'تانية', 'الجديد', 'الجديدة', 'من', 'في', 'فى', 'على',
  'عن', 'ال', 'هو', 'هي',
]);

const AMOUNT_RE = String.raw`(\d[\d.,]*)\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?`;
/* A single-letter Arabic connector only counts as a word of its own. Without
   that boundary the final letter of a name ("كاتل") is eaten as "ل". */
const STRONG_VALUE_RE = String.raw`(?:(?:^|[\s،,:])(?:ل|ب)|لـ|بـ|إلى|الى|بقيمة|هو|هيكون|يكون|\bto\b|\bat\b|\bfor\b|=|:)\s*` + AMOUNT_RE;

/* An amount belongs to the field label closest before it. "عدل سعر كاتل
   وخلي المخزون 20" must not turn 20 into the new price. */
const OTHER_FIELD_GAP_RE = {
  selling_price: /(?:المخزون|مخزون|الكمية|كمية|stock|quantity|التكلفة|تكلفة|cost)/iu,
  cost_price: /(?:المخزون|مخزون|الكمية|كمية|stock|quantity|selling|سعر\s*البيع)/iu,
  stock: /(?:سعر|السعر|تكلفة|price|cost)/iu,
};

function foldDigits(value) {
  return String(value == null ? '' : value).replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
    if (arabic >= 0) return String(arabic);
    const persian = '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit);
    return persian >= 0 ? String(persian) : digit;
  });
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isEmptyCategory(category) {
  return !category || !category.name;
}

function amountsIn(value) {
  const values = [];
  const regex = /(\d[\d.,]*)\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?/giu;
  for (const match of foldDigits(value).matchAll(regex)) {
    const amount = parseAmount(match[1], match[2]);
    if (amount !== null) values.push(amount);
  }
  return values;
}

function lastAmount(value) {
  const values = amountsIn(value);
  return values.length ? values[values.length - 1] : null;
}

function firstAmount(value) {
  const values = amountsIn(value);
  return values.length ? values[0] : null;
}

function amountAfterStrongConnector(value) {
  const match = String(value || '').match(new RegExp(STRONG_VALUE_RE, 'iu'));
  return match ? parseAmount(match[1], match[2]) : null;
}

function cleanTarget(value) {
  let target = textOf(value)
    .replace(/[?؟!.,،;:]+/g, ' ')
    .replace(LEADING_NOISE_RE, '')
    .replace(TRAILING_NOISE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  target = target.replace(/^(?:من|from|of|about|عن)\s+/iu, '').trim();
  target = target.replace(/\s+(?:من|from|of)$/iu, '').trim();
  return target;
}

function genericTarget(value) {
  const target = cleanTarget(value);
  if (!target) return true;
  if (GENERIC_TARGET_RE.test(target)) return true;
  const forms = normalizeName(target).split(' ').filter(Boolean);
  if (!forms.length) return true;
  /* "منتج تاني" and "that product" are references to a product, not a name.
     They must trigger "which product?" rather than a search for the word
     "product". */
  return forms.every((word) => GENERIC_TARGET_RE.test(word) || FUNCTION_WORDS.has(word));
}

function stripCategoryClauses(value) {
  return String(value || '')
    .replace(/(?:^|[^\p{L}\p{N}])(?:فئة|قسم|تصنيف|category)\s+(?:جديدة|جديد|new)\s+(?:اسمها|اسمه|باسم|called|named)\s+([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu, ' ')
    .replace(NEW_CATEGORY_RE, ' ')
    .replace(SAME_CATEGORY_RE, ' ')
    .replace(/(?:^|[^\p{L}\p{N}])(?:في|فى|داخل|ضمن|in|under)\s+(?:فئة|قسم|تصنيف|category)\s+([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu, ' ')
    .replace(/(?:^|[^\p{L}\p{N}])(?:فئة|قسم|تصنيف|category)\s*[:=]\s*([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu, ' ')
    .trim();
}

function categoryFor(value) {
  const found = extractCategory(String(value || ''));
  if (!found) return null;
  if (found.choice === 'create') {
    return { name: found.name || '', create: true };
  }
  if (found.choice === 'named' && found.name) {
    return { name: found.name, create: false };
  }
  if (found.choice === 'uncategorized') return { name: '', uncategorized: true };
  return null;
}

function stripActionAndFields(value, { action = '' } = {}) {
  let out = String(value || '');
  if (action === 'update_product') {
    out = out
      .replace(new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${UPDATE_VERB}(?:[\s،,:]|$)`, 'giu'), ' ')
      .replace(/(?:سعره|سعر\s*(?:البيع|البيع\s*فقط)?|selling\s*price|sale\s*price|price|السعر)/giu, ' ')
      .replace(/(?:سعر\s*(?:الشراء|الشرا|التكلفة)|cost\s*price|purchase\s*price|التكلفة|تكلفته|تكلفة|cost)/giu, ' ')
      .replace(/(?:المخزون|مخزون|الكمية|كمية|stock|quantity)/giu, ' ')
      .replace(IMAGE_RE, ' ')
      .replace(NAME_FIELD_RE, ' ')
      /* "خليه 30" / "set it to 30" describes the new value, not the product. */
      .replace(/(?:^|\s)(?:و)?(?:خلي|خليه|خليها|خليهم|خليهم|خلى|اجعله|اجعلها|حدد|set|make)(?=\s|$)/giu, ' ')
      .replace(new RegExp(STRONG_VALUE_RE, 'giu'), ' ');
  } else if (action === 'adjust_stock') {
    out = out
      .replace(new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${ADJUST_VERB}(?:[\s،,:]|$)`, 'giu'), ' ')
      .replace(ADD_STOCK_VERB_RE, ' ')
      .replace(SET_VERB_RE, ' ')
      .replace(/(?:مخزون|stock|الكمية|كمية|quantity|رصيد)/giu, ' ')
      .replace(/(?:منهم|منه|منها|فيهم|فيها|من|from)/giu, ' ')
      .replace(new RegExp(AMOUNT_RE, 'giu'), ' ')
      .replace(/(?:اتباعوا|اتباعت|اتباع|بيعت|sold|sale|تالف|broken|damaged|جرد|count)/giu, ' ');
  }
  return out;
}

function requestedFields(value) {
  const fields = [];
  if (/(?:سعر\s*(?:البيع|البيع\s*فقط)?|selling\s*price|sale\s*price|price|السعر|سعره)/iu.test(value)) {
    fields.push('selling_price');
  }
  if (/(?:سعر\s*(?:الشراء|الشرا|التكلفة)|cost\s*price|purchase\s*price|التكلفة|تكلفته|تكلفة|cost)/iu.test(value)) {
    fields.push('cost_price');
  }
  if (/(?:المخزون|مخزون|الكمية|كمية|stock|quantity)/iu.test(value)) {
    fields.push('stock');
  }
  if (IMAGE_RE.test(value)) fields.push('image');
  if (NAME_FIELD_RE.test(value)) fields.push('name');
  return Array.from(new Set(fields));
}

function updateValue(value, field) {
  const source = foldDigits(value);
  const labels = field === 'selling_price'
    ? [String.raw`سعر\s*(?:البيع|البيع\s*فقط)?`, String.raw`selling\s*price`, String.raw`sale\s*price`, String.raw`price`, String.raw`السعر`, String.raw`سعره`]
    : field === 'cost_price'
      ? [String.raw`سعر\s*(?:الشراء|الشرا|التكلفة)`, String.raw`cost\s*price`, String.raw`purchase\s*price`, String.raw`التكلفة`, String.raw`تكلفته`, String.raw`تكلفة`, String.raw`cost`]
      : field === 'stock'
        ? [String.raw`المخزون`, String.raw`مخزون`, String.raw`الكمية`, String.raw`كمية`, String.raw`stock`, String.raw`quantity`]
        : [];
  if (!labels.length) return null;
  const label = `(?:${labels.join('|')})`;
  const strong = source.match(new RegExp(`${label}[^\\d٠-٩]{0,24}${STRONG_VALUE_RE}`, 'iu'));
  if (strong) return parseAmount(strong[1], strong[2]);
  const after = source.match(new RegExp(`${label}([^\\d٠-٩]{0,24})${AMOUNT_RE}`, 'iu'));
  if (after) {
    const otherField = OTHER_FIELD_GAP_RE[field];
    if (!otherField || !otherField.test(after[1] || '')) {
      return parseAmount(after[2], after[3]);
    }
  }
  /* "change it to 100" after the user already named the field in the previous
     turn. The caller decides whether that is safe. */
  return amountAfterStrongConnector(source);
}

function stockChange(value) {
  const source = foldDigits(value);
  const modeMatch = source.match(new RegExp(ADJUST_VERB, 'iu'));
  let mode = '';
  if (/(?:اخصم|أخصم|خصم|اطرح|أطرح|انقص|أنقص|نقص|قلل|أقلل|subtract|deduct|decrease|remove)/iu.test(source)) {
    mode = 'subtract';
  } else if (/(?:زود|أزود|زيد|أزيد|زيادة|increase|add\b)/iu.test(source)) {
    mode = 'add';
  } else if (/(?:خلي|خليه|اجعله|حدد|set|make)/iu.test(source)) {
    mode = 'set';
  }
  const quantity = firstAmount(source);
  let reason = '';
  if (/(?:اتباع|اتباعت|بيعت|sold|sale)/iu.test(source)) reason = 'Sale';
  else if (/(?:تالف|broken|damaged|damage)/iu.test(source)) reason = 'Damage';
  else if (mode === 'set') reason = 'Inventory count';
  else if (mode === 'add') reason = 'Stock found';
  else if (mode === 'subtract') reason = 'Loss';
  return {
    mode,
    quantity,
    reason,
    verb: modeMatch ? modeMatch[0] : '',
  };
}

function profitIntent(value) {
  const category = categoryFor(value);
  const topMatch = value.match(/(?:أكتر|أكثر|اعلى|أعلى|احسن|أحسن|top|most|highest|best)/iu);
  return {
    action: 'read_profit',
    category,
    top: !!topMatch,
    query: '',
  };
}

function readIntent(value, action) {
  let query = String(value || '');
  query = stripCategoryClauses(query);
  if (action === 'read_price') {
    query = query
      .replace(/(?:بكام|بكم|كام\s+(?:سعر|سعره))/giu, ' ')
      .replace(/(?:what(?:'s|\s+is)\s+the\s+price\s+of|how\s+much\s+(?:is|does|do)|price\s+of|the\s+price\s+of)/giu, ' ')
      .replace(/(?:سعر|سعره|price)/giu, ' ');
  } else if (action === 'read_stock') {
    query = query
      .replace(/(?:كام|كم|how\s+many)/giu, ' ')
      .replace(/(?:do|does|did)\s+(?:we|i|you)\s+have/giu, ' ')
      .replace(/(?:we|i)\s+(?:have|got)/giu, ' ')
      .replace(/(?:is|are)\s+there/giu, ' ')
      .replace(/(?:فيه|فيها|في\s+المخزون|في\s+المخزن|على\s+المخزون|in\s+stock|on\s+hand|available|stock|مخزون)/giu, ' ');
  } else if (action === 'read_count') {
    query = query
      .replace(COUNT_RE, ' ')
      .replace(/(?:عدد|كم|how\s+many|total)/giu, ' ');
  }
  query = cleanTarget(query);
  return {
    action,
    query: genericTarget(query) ? '' : query,
    category: categoryFor(value),
  };
}

function updateIntent(value) {
  const fields = requestedFields(value);
  const targetText = stripActionAndFields(value, { action: 'update_product' });
  /* The amount itself is not part of the name. */
  const target = cleanTarget(
    targetText
      .replace(/(?:اللي|اللى|التي|that|which)\s+/giu, ' ')
      .replace(/[0-9٠-٩][0-9٠-٩.,]*/g, ' '),
  );
  const values = {};
  if (fields.includes('selling_price')) {
    const amount = updateValue(value, 'selling_price');
    if (amount !== null) values.selling_price = amount;
  }
  if (fields.includes('cost_price')) {
    const amount = updateValue(value, 'cost_price');
    if (amount !== null) values.cost_price = amount;
  }
  if (fields.includes('stock')) {
    const amount = updateValue(value, 'stock');
    if (amount !== null) values.stock = amount;
  }
  if (fields.includes('name')) {
    const nameMatch = String(value).match(/(?:اسم|name)\s*(?:جديد|new)?\s*(?:لـ|ل|إلى|الى|to|:|=)?\s*([^\d،,.!?]{2,80})/iu);
    if (nameMatch) values.name = nameMatch[1].trim();
  }
  return {
    action: 'update_product',
    query: genericTarget(target) ? '' : target,
    requestedFields: fields,
    values,
    imageOnly: fields.length === 1 && fields[0] === 'image',
  };
}

function adjustIntent(value) {
  const stock = stockChange(value);
  let targetText = stripActionAndFields(value, { action: 'adjust_stock' });
  targetText = targetText
    .replace(/(?:النهاردة|النهارده|دلوقتي|today|now|اتباعوا|اتباعت|اتباع)\s*/giu, ' ')
    .replace(/(?:على|إلى|الى|في|فى|to|into|on)\s+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const target = cleanTarget(targetText);
  return {
    action: 'adjust_stock',
    query: genericTarget(target) ? '' : target,
    stock,
  };
}

function createStep(value) {
  const draft = parseProductDraft(value, null);
  const category = categoryFor(value);
  const bulkMatch = value.match(BULK_RE);
  const bulk = bulkMatch ? bulkCount(bulkMatch[1]) : null;
  return {
    action: 'create_product',
    query: bulk && bulk > 1 ? '' : (draft.name || ''),
    category,
    draft,
    bulk: bulk && bulk > 1 ? bulk : null,
    newCategory: NEW_CATEGORY_RE.test(value),
    sameCategory: SAME_CATEGORY_RE.test(value),
  };
}

function parseSegment(value) {
  const text = textOf(value);
  if (!text) return { action: 'unknown' };

  if (PROFIT_RE.test(text)) return profitIntent(text);

  /* A stock verb is unambiguous even when the request also says "add". */
  if (ADJUST_RE.test(text) && (STOCK_CONTEXT_RE.test(text) ||
      /(?:اخصم|أخصم|خصم|اطرح|أطرح|انقص|أنقص|نقص|قلل|أقلل|subtract|deduct|decrease)/iu.test(text) ||
      (/(?:زود|أزود|زيد|أزيد|increase)/iu.test(text) && amountsIn(text).length > 0))) {
    return adjustIntent(text);
  }
  if (ADD_STOCK_RE.test(text)) return adjustIntent(text);

  if (SET_VERB_RE.test(text) && !isProductCreateRequest(text, { pending: null })) {
    const fields = requestedFields(text);
    if (fields.length) {
      const stockOnly = fields.every((field) => field === 'stock');
      return stockOnly ? adjustIntent(text) : updateIntent(text);
    }
  }

  if (UPDATE_RE.test(text) && !isProductCreateRequest(text, { pending: null })) {
    return updateIntent(text);
  }

  if (isProductCreateRequest(text, { pending: null })) {
    const step = createStep(text);
    if (step.bulk) {
      /* The count is the request; the parser's leftover name ("عشر") is not
         a product. Keep the bulk intent free of a misleading draft. */
      return { ...step, action: 'bulk_create', query: '', draft: null };
    }
    if (step.newCategory && !step.category) {
      return { ...step, category: { name: '', create: true } };
    }
    return step;
  }

  if (COUNT_RE.test(text)) return readIntent(text, 'read_count');
  if (PRICE_RE.test(text)) return readIntent(text, 'read_price');
  if (STOCK_RE.test(text)) return readIntent(text, 'read_stock');
  if (LIST_RE.test(text)) return { action: 'list_products', query: '', category: categoryFor(text) };
  return { action: 'unknown' };
}

function splitSegments(value) {
  const text = textOf(value);
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(SEGMENT_SPLIT_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(last, start).trim();
    if (before) parts.push(before);
    last = end;
  }
  const tail = text.slice(last).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [text];
}

function questionState(value) {
  const marks = [...String(value || '').matchAll(/[؟?]/g)];
  if (!marks.length) return 'none';
  if (marks.length > 1) return 'mixed';
  const after = String(value).slice(marks[0].index + 1).replace(/[\s.!،,؛;:]+/gu, '');
  return after ? 'mixed' : 'trailing';
}

const WORD_LEFT = String.raw`(?:^|[^\p{L}\p{N}])`;
const WORD_RIGHT = String.raw`(?=[^\p{L}\p{N}]|$)`;

/* A live read is allowed only when the leftover text is just a record name.
   A second question word, a leftover conjunction or another instruction means
   the sentence carries more than this module can answer. */
function queryIsSafe(query) {
  const text = String(query || '').trim();
  if (!text) return true;
  /* A lookup carries a record name, not a story. */
  if (!queryIsShortEnough(text)) return false;
  if (/[؟?]/.test(text)) return false;
  if (new RegExp(`${WORD_LEFT}(?:و|and)${WORD_RIGHT}`, 'iu').test(text)) return false;
  const readWords = new RegExp(
    `${WORD_LEFT}(?:كام|كم|بكام|سعر|السعر|مخزون|الكمية|price|cost|stock|quantity|how|what|why|هل)${WORD_RIGHT}`,
    'iu',
  );
  if (readWords.test(text)) return false;
  if (/(?:وكمان|كمان|also|then|بعدين|قولي|قلي|ابعت|اطلب|اعرض|وريني)/iu.test(text)) return false;
  return true;
}

function multiStepIsComplete(step) {
  if (!step) return false;
  if (step.action === 'adjust_stock') {
    return !!step.query && !!step.stock && !!step.stock.mode &&
      step.stock.quantity !== null && step.stock.quantity !== undefined;
  }
  if (step.action === 'create_product') {
    return !!step.draft && missingProductFields(step.draft).length === 0;
  }
  if (step.action === 'update_product') {
    const fields = (step.requestedFields || []).filter((field) => field !== 'image');
    if (!step.query || !fields.length) return false;
    /* update_product cannot change stock; that is adjust_stock. A mixed
       request belongs to the model. */
    if (fields.includes('stock')) return false;
    return fields.every((field) =>
      step.values && step.values[field] !== undefined && step.values[field] !== null);
  }
  if (step.action === 'create_category') {
    return !!(step.category && step.category.name);
  }
  return false;
}

function simpleSingleStep(step, text) {
  if (!step) return false;
  switch (step.action) {
    case 'read_stock':
    case 'read_price':
      return !!step.query && queryIsSafe(step.query);
    case 'read_profit':
      return !step.query || queryIsSafe(step.query);
    case 'read_count':
    case 'list_products':
      return queryIsSafe(step.query);
    case 'create_product':
      if (step.draft && (step.draft.confidence === 'low' ||
          (Array.isArray(step.draft.issues) && step.draft.issues.length) ||
          (Array.isArray(step.draft.vetoes) && step.draft.vetoes.length))) {
        return false;
      }
      return !EXTRA_REQUEST_RE.test(text);
    case 'bulk_create':
      return !EXTRA_REQUEST_RE.test(text);
    case 'update_product': {
      const fields = (step.requestedFields || []).filter((field) => field !== 'image');
      if (fields.includes('stock')) return false;
      if (!queryIsSafe(step.query)) return false;
      return !EXTRA_REQUEST_RE.test(text);
    }
    case 'adjust_stock':
      if (!step.stock || !step.stock.mode) return false;
      if (!step.query && !SET_VERB_RE.test(text) && !ADD_STOCK_RE.test(text)) return false;
      /* "خصم 10 من سعر كاتل" is a price request, not stock. */
      if (!STOCK_CONTEXT_RE.test(text) && !ADD_STOCK_RE.test(text) && PRICE_RE.test(text)) {
        return false;
      }
      return !EXTRA_REQUEST_RE.test(text);
    case 'create_category':
      return true;
    default:
      return false;
  }
}

function unknownResult(text, arabic, reason) {
  return {
    text,
    arabic,
    action: 'unknown',
    steps: [],
    query: '',
    live: false,
    confidence: 'low',
    reason,
  };
}

function extractIntent(message, { pending = null } = {}) {
  const text = textOf(message);
  const arabic = ARABIC_RE.test(text);
  if (!text) {
    return { text, arabic, action: 'unknown', steps: [], live: false, confidence: 'low' };
  }
  if (isHowToQuestion(text)) {
    return { text, arabic, action: 'help', steps: [], live: false, confidence: 'high' };
  }

  /* More than one question, or an action the assistant does not take through
     this path, is not a short single request. Send the whole sentence to the
     model instead of answering only the part that matched. */
  if (OTHER_ACTION_RE.test(text) || OTHER_TARGET_RE.test(text) ||
      MIXED_JOIN_RE.test(text)) {
    return unknownResult(text, arabic, 'other_request');
  }
  if (questionState(text) === 'mixed') {
    return unknownResult(text, arabic, 'mixed_question');
  }

  const segments = splitSegments(text);
  const parsed = segments.map((segment) => parseSegment(segment));

  /* Every clause must be understood. Dropping an unknown clause would answer
     half of what the user asked. */
  if (parsed.some((step) => !step || step.action === 'unknown')) {
    return unknownResult(text, arabic, 'unclear_clause');
  }

  if (parsed.length > 1) {
    if (EXTRA_REQUEST_RE.test(text) || !parsed.every(multiStepIsComplete)) {
      return unknownResult(text, arabic, 'incomplete_multi');
    }
    return {
      text,
      arabic,
      action: 'multi',
      steps: parsed,
      query: '',
      category: categoryFor(text),
      live: false,
      confidence: 'high',
    };
  }

  const step = parsed[0];
  /* Arithmetic, averages and monthly targets are not lookups: the live path
     can only quote rows, so it would answer them with an unrelated product
     card. The model gets the sentence instead. */
  if (isLiveAction(step.action) && isAnalyticAsk(text, step.action)) {
    return unknownResult(text, arabic, 'analytic_ask');
  }
  if (!simpleSingleStep(step, text)) {
    return unknownResult(text, arabic, 'needs_model');
  }
  return {
    text,
    arabic,
    ...step,
    steps: [step],
    live: String(step.action).startsWith('read_'),
    confidence: 'high',
    pendingTarget: pending && pending.draft && pending.draft.name
      ? pending.draft.name
      : '',
  };
}

function isLiveAction(action) {
  return /^read_|^list_/.test(String(action || ''));
}

module.exports = {
  extractIntent,
  isLiveAction,
  // Exposed for tests and the compiler.
  splitSegments,
  requestedFields,
  stockChange,
  updateValue,
};
