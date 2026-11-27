/*
 * Local product draft.
 *
 * A product request arrives as one sentence that mixes a name, specs, price,
 * cost, stock and sometimes a category. This module turns that sentence into
 * the same small draft the assistant would otherwise spend model turns
 * collecting. It only extracts what the user actually wrote; it never fills a
 * price, cost or stock with a guessed value.
 *
 * The draft is local working state. It is not a shop record, not a plan and
 * not synced. The confirmed plan still goes through validatePlan and the
 * normal item routes with the user's own token and branch.
 */

'use strict';

const {
  correctCommonSpelling,
  editDistance,
  isHowToQuestion,
  normalizeName,
  scoreNameMatch,
} = require('../text-match');
const { namedCategory } = require('../tools/ask-user');
const {
  CATEGORY_STOP_WORDS,
  CATEGORY_STOP,
  CATEGORY_TOKEN,
  CATEGORY_PHRASE_RE,
} = require('../category-terms');

const REQUIRED_FIELDS = ['selling_price', 'cost_price', 'opening_stock'];
const MAX_NAME_CHARS = 200;
const MAX_CATEGORY_CHARS = 160;
const MAX_QUESTION_CHARS = 300;

const FIELD_PROPERTY = {
  name: 'name',
  selling_price: 'sellingPrice',
  cost_price: 'costPrice',
  opening_stock: 'openingStock',
};

const FIELD_LABELS = {
  name: { ar: 'اسم المنتج', en: 'product name' },
  selling_price: { ar: 'سعر البيع', en: 'selling price' },
  cost_price: { ar: 'سعر التكلفة', en: 'cost price' },
  opening_stock: { ar: 'الكمية', en: 'opening stock' },
  category: { ar: 'الفئة', en: 'category' },
};

/* Words that describe the request, not the product. They are filler at the
   start or end of a sentence ("add a new product"), and they must never
   become the product name or a category. The list is deliberately small; the
   matcher also accepts a one-letter slip so "جديدي" is still "جديد". */
const FILLER_WORDS = new Set([
  'منتج', 'منتجات', 'منتاجات', 'منتاج', 'صنف', 'اصناف', 'أصناف', 'برودكت', 'بضاعة', 'بضاعه',
  'product', 'products', 'item', 'items',
  'جديد', 'جديدة', 'جديده', 'جدد', 'تاني', 'تانية', 'آخر', 'اخر',
  'new', 'another', 'next', 'only', 'also', 'بس', 'كمان', 'please', 'pls',
  'ممكن', 'لو', 'سمحت', 'فضلك', 'عايز', 'عاوز', 'أريد', 'اريد', 'أحتاج',
  'احتاج', 'add', 'create',
]);
const NORMALIZED_FILLER_WORDS = new Set(
  [...FILLER_WORDS].map((word) => normalizeName(word)).filter(Boolean),
);

function isFillerToken(token) {
  const normalized = normalizeName(token);
  if (!normalized || normalized.includes(' ')) return false;
  if (NORMALIZED_FILLER_WORDS.has(normalized)) return true;
  /* Short words stay exact; a longer word may differ by one letter. This is
     what turns "جديدي" and "جديدى" into "جديد" without turning every short
     word into a fuzzy match. */
  if (normalized.length < 4) return false;
  for (const filler of NORMALIZED_FILLER_WORDS) {
    if (filler.length < 4 || filler[0] !== normalized[0]) continue;
    if (Math.abs(filler.length - normalized.length) > 1) continue;
    if (editDistance(normalized, filler) <= 1) return true;
  }
  return false;
}

function isFillerName(value) {
  const tokens = normalizeName(value).split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every(isFillerToken);
}

function stripTrailingFiller(value) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length && isFillerToken(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

const AMOUNT = String.raw`(\d[\d.,]*)\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?`;
const CURRENCY = String.raw`\s*(?:جنيه|جنية|جنيها|ج\.م|egp|le|ريال|درهم|دينار|\$|£|€)?`;
const SEP = String.raw`\s*(?:هو|هي|بقى|بقت|يكون|:|=|بـ|ب|لـ|ل|إلى|الى|to)?\s*`;
const LABEL_PREFIX = String.raw`(?:^|[^\p{L}\p{N}])`;
const CONNECTOR = String.raw`(?:(?:و|and|ثم)\s*)?`;

const SELLING_LABEL = [
  'بسعر',
  'السعر\\s*(?:البيع|البيع\\s*فقط)?',
  'سعر\\s*(?:البيع|البيع\\s*فقط)?',
  'سعره',
  'البيع',
  'بيع',
  'selling\\s*price',
  'sale\\s*price',
  'price',
].join('|');

const COST_LABEL = [
  'سعر\\s*الشراء',
  'سعر\\s*الشرا',
  'سعر\\s*التكلفة',
  'التكلفة',
  'تكلفته',
  'تكلفة',
  'شراء',
  'cost\\s*price',
  'purchase\\s*price',
  'cost',
].join('|');

const STOCK_LABEL = [
  'الكمية\\s*(?:المبدئية|المتوفرة|الحالية|المتاح|الافتتاحية)?',
  'كمية\\s*(?:المبدئية|المتوفرة|الحالية|المتاح|الافتتاحية)?',
  'كميته',
  'العدد\\s*(?:القطع|الوحدات)?',
  'عدد\\s*(?:القطع|الوحدات)?',
  'المخزون',
  'مخزون',
  'الافتتاحي',
  'opening\\s*stock',
  'quantity',
  'stock',
  'qty',
  'count',
].join('|');

const BARCODE_LABEL = [
  'الباركود',
  'باركود\\s*المنتج',
  'باركود',
  'barcode',
  'sku',
].join('|');

/* A category name ends where the next field or clause begins. Shared with
   the ask-user tool through ../category-terms: CATEGORY_STOP,
   CATEGORY_TOKEN and CATEGORY_PHRASE_RE are imported there. */
const CATEGORY_CREATE_RE = /(?:^|[^\p{L}\p{N}])(?:و|and|ثم)?\s*(?:أنشئ|انشئ|إنشاء|انشاء|اعمل|أضف|اضف|create|add)\s+(?:فئة|قسم|تصنيف|category)\s+(?:جديدة|جديد|new\s+)?([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu;
/* "a new category called أدوية" names the shelf even though no create-category
   verb was used. Keep it separate from CATEGORY_CREATE_RE so the clause can be
   stripped before the product name is read. */
const CATEGORY_NAMED_CREATE_RE = /(?:^|[^\p{L}\p{N}])(?:فئة|قسم|تصنيف|category)\s+(?:جديدة|جديد|new)\s+(?:اسمها|اسمه|باسم|called|named)\s+([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu;
const CATEGORY_LABEL_RE = /(?:^|[^\p{L}\p{N}])(?:فئة|قسم|تصنيف|category)\s*[:=]\s*([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu;
const CATEGORY_PLAIN_RE = /(?:^|[،,.!?]\s*)(?:فئة|قسم|تصنيف|category)\s+([^\s،,.!?]+(?:\s+[^\s،,.!?]+){0,2})/iu;
/* "وحطها في الأدوات الكهربائية": a placement verb plus a preposition names
   the shelf without the word فئة. The capture stops before the next field's
   connector so "وحطها في الأدوات الكهربائية والكمية 7" never swallows the
   quantity clause. */
const CATEGORY_PLACE_RE = new RegExp(
  String.raw`(?:^|[\s،,])و?(?:حط|حطو|حطها|حطهم|حطه|حطني|اضيفها|اضيفهم|أضفها|أضفهم|ضيف|ضيفها|ضع|ضعها|خلي|خليها|خليهم|خليه|put|place|move)(?:\s+(?:it|them))?` +
    String.raw`\s+(?:ف[يى]|تحت|in|under|into)\s+` +
    String.raw`(${CATEGORY_TOKEN}(?:\s+${CATEGORY_STOP}${CATEGORY_TOKEN}){0,2})`,
  'iu',
);
const CREATE_CATEGORY_ONLY_RE = /(?:^|[^\p{L}\p{N}])(?:و|and|ثم)?\s*(?:أنشئ|انشئ|إنشاء|انشاء|اعمل|create)\s+(?:فئة|قسم|تصنيف|category)(?:\s+(?:جديدة|جديد|new))?\s*[.!?]*$/iu;
const UNCATEGORIZED_RE = /(?:بدون\s+(?:تصنيف|فئة)|من\s+غير\s+(?:تصنيف|فئة)|leave\s+(?:it\s+)?uncategorized|without\s+(?:a\s+)?category|no\s+category)/iu;
const OTHER_CATEGORY_RE = /(?:^|[^\p{L}\p{N}])(?:فئة|قسم|تصنيف)\s+(?:أخرى|اخرى|تانية|ثانية)|another\s+category|different\s+category|other\s+category/iu;
const SAME_CATEGORY_RE = /(?:^|[^\p{L}\p{N}])(?:(?:same|نفس)\s+(?:ال)?(?:فئة|قسم|تصنيف|category)|(?:تبع|على|في|فى|in)\s+(?:نفس\s+)?ال(?:فئة|قسم|تصنيف|category)|(?:تبع|على|في|فى|in)\s+(?:فئة|قسم|تصنيف|category)\s*(?:[،,.!?]|$))/iu;
const NEW_CATEGORY_ONLY_RE = /(?:^|[^\p{L}\p{N}])(?:ب|في|فى|within|in|with)?\s*(?:فئة|قسم|تصنيف|category)\s+(?:جديدة|جديد|new)(?![\p{L}\p{N}])/iu;

const ACTION_PREFIX_RE = /^(?:please|pls|من\s+فضلك|لو\s+سمحت|ممكن|عايز|عاوز|أريد|اريد|أحتاج|احتاج|i\s+just\s+want\s+to|i\s+want\s+to|i\s+need\s+to|i\s+would\s+like\s+to|i'd\s+like\s+to|can\s+you|could\s+you|would\s+you|help\s+me)\s+/iu;
const CREATE_PREFIX_RE = /^(?:أضيف|اضيف|أضف|اضف|ضيف|ضيفي|أضفلي|اضفلي|ضيفلي|ضيفها|ضيفه|ضيفهم|أضفها|اضفها|أضفه|اضفه|أضيفها|اضيفها|أضيفه|اضيفه|إضافة|اضافة|إنشاء|انشاء|أنشئ|انشئ|سجل|سجلي|اعمل|اعملي|add|create)\s+/iu;
const NEW_PRODUCT_PREFIX_RE = /^(?:new\s+product|new\s+item)\s+/iu;
const PRODUCT_WORD_RE = /^(?:المنتاجات|المنتاج|المنتج|الصنف|البرودكت|البضاعة|منتاجات|منتاج|منتج|صنف|برودكت|بضاعة|product|item)\s+/iu;
const ARTICLE_RE = /^(?:a|an|the)\s+/iu;
/* English "new" is only filler before "product/item" or at the end; a brand
   such as "New Balance" keeps its first word. Arabic "جديد" before a name is
   an adjective ("new iPhone") and is safely removed. */
const NEW_WORD_RE = /^(?:(?:جديد|جديدة|جديده)(?:\s*[:،,.]?\s+|\s*$)|new\s+(?:product|item)\b|new\s*$)/iu;
/* A labelled name: "الاسم: قهوة سادة", "سمّيها X", "called X". The label is
   what tells a rename apart from an instruction, so the punctuation form has
   to match too - "الاسم: X" never matched before and the rename was ignored. */
const CALLED_RE = /^(?:اسمه|اسمها|الاسم|اسم|سمّيها|سميها|سمّيه|سميه|غيّر\s+الاسم|غيّر\s+اسم|rename|change\s+the\s+name|call\s+it|called|named|name\s+is|name)(?:\s*[:：\-–]\s*|\s+)/iu;

/* An instruction is never a name. "لا خليه موبايل سامسونج" is a rename and
   "حط السعر ٥٠" is a field: taking either as the product's name is how a
   command became a field value. The labelled and quoted forms are handled
   above; this catches the rest. */
const IMPERATIVE_NAME_RE = /^(?:لا|ممنوع|منفعش|مش|متحطش|حط|خلي|خلّي|سيب|امسح|لغي|ألغي|الغي|عدّل|غيّر|أغير|أعمل|اسأل|جرب)\s+/iu;
const QUOTED_NAME_RE = /["“”«»']([^"“”«»']{2,120})["“”«»']/u;
/* "for 15000", "at 15000" and "ب 15000" are weak price labels. They are
   accepted only when another amount field proves this is a price sentence. */
const FOR_PRICE_RE = /(?:^|(?<=[\s،,]))(?:for|at|بـ|ب)\s*(\d[\d.,]*)\b\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?(?!\s*(?:inch|in|بوصة|سم|mm|cm|kg|كجم|جم|gram|gb|mb|ram|tb|لتر|liter|ml))/iu;
const LEADING_CONNECTOR_RE = /^(?:و|and|ثم|then)\s+/iu;
const TRAILING_FILLER_RE = /(?:\s+(?:بس|only|كمان|also|جديد|جديدة|جديده|new|تاني|تانية|آخر|اخر|another|next|تقريباً|تقريبا|حوالي|حوالى|approx|about|around|roughly|ربما|maybe))+\s*$/iu;
/* A product name hint should not swallow a later instruction ("... واعمل خصم
   10%"). The clause still reaches the model in the raw message; this only
   keeps the search hint clean. */
const TRAILING_LOGIC_RE = /\s+(?:و|ثم|بعدين|and|then)\s*(?:كمان\s*|also\s*)?(?:احسب|احسبلي|اعمل|طبق|apply|خصم|تخفيض|ضيف|أضف|اضف|قولي|قللي|اخبرني|tell|show|report|حدد|set)(?![\p{L}\p{N}])[\s\S]*$/iu;
const TRAILING_ASK_RE = /(?:^|[\s،,])(?:(?:و|ثم|and|then)\s*(?:اعمل|أعمل|سوي|سوّي|جهز|حضر|make|do)|وكمان|كمان|هل|عايز\s+أعرف|عاوز\s+أعرف|أعرف|اعرف|قولي|قللي|اخبرني|also|and\s+also|then|what|how|why|when|where|tell\s+me|show\s+me|report|عشان|علشان|لأن|لان|because|since|تقريب|حوالي|حوالى|approx|about|around|roughly|ربما|maybe)(?![\p{L}\p{N}])[\s\S]*$/iu;
const TRAILING_RANGE_RE = /\s+(?:(?:من|from)\s*)?(?:أو|او|or|إلى|الى|لـ|to|و)\s*\d[\d.,]*\s*$/iu;
const TRAILING_RANGE_START_RE = /\s+(?:من|from)\s*\d[\d.,]*\s*$/iu;
const CURRENCY_WORD_RE = /\s*(?:جنيه|جنية|جنيها|ج\.م|egp|le|ريال|درهم|دينار)\s*/giu;
const PUNCT_EDGE_RE = /^[\s.,;:!?،؛\-–—]+|[\s.,;:!?،؛\-–—]+$/g;

const ACK_RE = /^(?:تمام|تم|ماشي|حاضر|اوك|أوك|اوكي|أوكي|ok|okay|sure|yes|نعم|موافق)[!.?]*$/iu;
const REJECT_RE = /^(?:لا|لأ|لأه|no|nope|مش دي|مش ده|مش هي|not this|not that)[!.?]*$/iu;
const CHOOSE_FOR_ME_RE = /^(?:اختار\s+إنت|اختار\s+انت|أنت\s+اختار|انت\s+اختار|choose\s+for\s+me|you\s+choose|أي\s+حاجة|اي\s+حاجة)[!.?]*$/iu;
const NOT_IMPORTANT_RE = /^(?:مش\s+مهم(?:ة|ه)?|لا\s+يهم|مهمش|مش\s+ضروري|مش\s+ضرورى|whatever|doesn'?t\s+matter|not\s+important|skip)[!.?]*$/iu;
const UNSURE_RE = /^(?:مش\s+عارف(?:ة|ه)?|مش\s+متأكد(?:ة|ه)?|مش\s+متاكد(?:ة|ه)?|معرفش|ما\s+اعرفش|don'?t\s+know|not\s+sure|no\s+idea)[!.?]*$/iu;
const UNSURE_ANY_RE = /(?:مش\s+عارف|مش\s+متأكد|مش\s+متاكد|معرفش|ما\s+اعرفش|don'?t\s+know|not\s+sure|no\s+idea)/iu;
const NOT_IMPORTANT_ANY_RE = /(?:مش\s+مهم|لا\s+يهم|مهمش|مش\s+ضروري|مش\s+ضرورى|whatever|doesn'?t\s+matter|not\s+important)/iu;
const SAME_PRICE_RE = /(?:same\s+(?:as\s+)?(?:the\s+)?(?:selling\s+)?price|نفس\s+(?:سعر\s+)?البيع|نفس\s+السعر|زي\s+السعر|زى\s+السعر|بنفس\s+السعر)/iu;
const NO_STOCK_RE = /(?:no\s+stock|zero\s+stock|out\s+of\s+stock|مفيش\s+(?:مخزون|كمية)|مش\s+فيه\s+(?:مخزون|كمية)|بدون\s+(?:مخزون|كمية)|(?:الكمية|المخزون)\s+(?:صفر|٠)|(?:الكمية|المخزون)\s+مش\s+مهم(?:ة|ه)?)/iu;
/* "Free" alone is also a product name ("Free Fire"), so only an explicit
   free-price phrase counts. */
const FREE_RE = /(?:^|[\s،,])(?:ببلاش|مجانا|مجاناً|مجاني)(?:[\s،,.:]|$)|\bfor\s+free\b|\bit'?s\s+free\b|\bprice\s*(?:is|:)?\s*0\b/iu;
const UPDATE_DUPLICATE_RE = /(?:تعديل\s+(?:السعر|التكلفة|المخزون)|edit\s+(?:price|cost|stock))/iu;
const CANCEL_RE = /^(?:إلغاء|الغاء|cancel|بلاش|لا\s+شكرا|no\s+thanks)[!.?]*$/iu;
const NEW_PRODUCT_RE = /(?:^|\s)(?:منتج\s+جديد|صنف\s+جديد|new\s+product|new\s+item)(?:\s|$)/iu;

/* A create verb can carry its object as an attached pronoun ("ضيفها",
   "أضفهم"). Without these forms the sentence looks like a search and the
   assistant lists products instead of adding the one the user described. */
const CREATE_PRONOUN_RE = /(?:^|[\s،,.])(?:ضيفها|ضيفه|ضيفهم|ضيفهما|أضفها|اضفها|أضفه|اضفه|أضيفها|اضيفها|أضيفه|اضيفه|ضيفيها|ضيفيهم|سجلها|سجله|اعملها|اعمله|add\s+(?:it|them)|create\s+(?:it|them))(?=[\s،,.:!?]|$)/giu;
const CREATE_PRONOUN_ANY_RE = /(?:ضيفها|ضيفه|ضيفهم|ضيفهما|أضفها|اضفها|أضفه|اضفه|أضيفها|اضيفها|أضيفه|اضيفه|ضيفيها|ضيفيهم|سجلها|سجله|اعملها|اعمله|add\s+(?:it|them)|create\s+(?:it|them))/iu;

/* A shopkeeper often describes stock arriving in a pack: the pack count, the
   units inside it, what the whole pack cost and the per-unit selling price.
   These phrases are ordinary commerce, not a fixed script, so they are parsed
   as values and the arithmetic is shown in the preview. */
const PACK_NOUN = String.raw`(?:(?:كرتون|كارتون)(?:ة|ه)?|كراتين|كارتونات|صندوق|صناديق|علب(?:ة|ه)?|علب|باكو|باكيت(?:ات)?|شد|ربط(?:ة|ه)?|دست(?:ة|ه)?|case|carton|box|pack|packet|dozen)`;
const UNIT_NOUN = String.raw`(?:لمب(?:ة|ه)?|وحد(?:ة|ه)?|قطعة|قطعه|حبة|حبه|كيس|زجاج(?:ة|ه)?|عبو(?:ة|ه)?|عدد|piece|unit|item|pcs?|pieces?)`;
/* Count nouns that may follow a stock value in speech, including the bare
   plural "قطع" that pack phrases do not cover. */
const COUNT_UNIT = String.raw`قطعة|قطعه|قطعتين|قطع|وحدة|وحدات|لمبات|لمبة|لمب|حبات|حبة|أكياس|كيس|زجاجات|زجاجة|عبوات|عبوة|عبو|عدد|piece|pieces|unit|units|pcs?|items?`;

/* Typed picture answers ("use the attached image", "بلا صورة") settle the
   image slot; they are not product names. Exact normalized tokens only, no
   edit distance, and a phrase blocks the name only when every word is
   picture vocabulary with at least one picture noun — "Pepsi" and
   "برواز صورة" still parse as names. cover/غلاف stay out on purpose: a
   phone-cover shop sells cover as a real product word. */
const IMAGE_ANSWER_NOUNS = new Set([
  'صوره', 'الصوره', 'صور', 'الصور', 'image', 'photo', 'picture', 'pic',
  'attachment', 'attached', 'مرفقه', 'المرفقه', 'مرفق', 'ارفقت', 'اترفقت',
]);
const IMAGE_ANSWER_WORDS = new Set([
  ...IMAGE_ANSWER_NOUNS,
  'استخدم', 'استعمل', 'خد', 'حط', 'خلي', 'ارفق', 'شيل', 'امسح', 'اعتمد',
  'use', 'using',
  'ده', 'دي', 'هي', 'the', 'this', 'my', 'with', 'من', 'غير', 'بدون', 'بلا',
  'no', 'without',
]);

function isImageAnswerPhrase(value) {
  const tokens = normalizeName(value).split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let hasNoun = false;
  for (const token of tokens) {
    if (!IMAGE_ANSWER_WORDS.has(token)) return false;
    if (IMAGE_ANSWER_NOUNS.has(token)) hasNoun = true;
  }
  return hasNoun;
}
const SPEC_UNIT = String.raw`(?:وات|واط|watt|فولت|volt|أمبير|امبير|amp|لتر|liter|litre|ml|مل|سم|مم|cm|mm|متر|meter|بوصة|بوصه|inch|كجم|كيلو|جم|جرام|gram|kg|جيجا|gb|mb|tb|رام|ram|هرتز|hz|بكسل|mp)`;
const PACK_CONTAIN = String.raw`(?:فيها|فيه|منها|منه|تحتوي\s*(?:على)?|contains?|holding|with)`;
const STOCK_IN_VERB = String.raw`(?:دخل|دخلت|وصل|وصلت|جاني|جات|جت|استلمت|جبت|جاب|شرينا|اشتريت|اشترينا|عندي|معايا|وارد|received|got|bought|arrived)`;
const STOCK_IN_RE = new RegExp(String.raw`(?:^|[\s،,])${STOCK_IN_VERB}(?=[\s،,.:]|$)`, 'iu');
const NARRATIVE_LEAD_RE = new RegExp(
  String.raw`(?:^|[\s،,.])(?:${STOCK_IN_VERB})\s+(?:(?:ال)?(?:مخزن|مخزون|محل|شغل|warehouse|store|shop)\s*)?`,
  'giu',
);
const COST_TOTAL_MARKER_RE = /(?:كلها|كله|بالكامل|الإجمالي|الاجمالي|total|altogether|in\s+total|الفاتورة|invoice|الشحنة|الطلب|(?:ال)?كرتون(?:ة|ه)?|(?:ال)?صندوق|(?:ال)?باكو)/iu;
const COST_VERB_RE = /(?:وقفت|وقّفت|كلفت|كلّفت|تكلفت|طلعت|جت|cost|costs|cost\s+us|stood\s+(?:us\s+)?at)/iu;
const PER_UNIT_RE = /(?:الواحدة|الوحدة|القطعة|القطعه|الحبة|الحبه|للواحدة|للقطعة|للحبة|each|per\s+(?:unit|piece|item))/iu;
/* A narrative selling phrase uses a verb ("أبيع الواحدة") or "each"; the
   plain label "سعر البيع" is already handled by the labeled field parser. */
const SELL_VERB_RE = /(?:أبيع|ابيع|ببيع|نبيع|تبيع|sell|selling)/iu;
const MONEY_RE = /(?:جنيه|جنية|جنيها|ج\.م|egp|le|ريال|درهم|دينار|\$|£|€)/iu;
const CLAUSE_SPLIT_RE = /[،,;.!?\n]+/u;

function clausesOf(value) {
  return String(value || '')
    .split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/* A spoken self-correction restarts one value: "لأ استنى خليها 3200". The
   marker must start its own clause and end at a non-letter — JS \b does not
   work for Arabic, so "لا" must never match the start of "لاب توب". Every
   marker, verb, filler and number word below carries the same ending. */
const CORRECTION_END = String.raw`(?=$|[^\p{L}\p{N}])`;
const CORRECTION_MARKER_RE = new RegExp(
  String.raw`^(?:لأ+|لا+|بس\s+لا|استنى|استني|غلطت|قصدي|بل|wait|actually|i\s+mean)` +
    CORRECTION_END,
  'iu',
);
const REASSIGN_VERB_RE = new RegExp(
  String.raw`(?:خليها|خليهم|خليه|خليني|خليكم|خلي|خلّي|خلى|بدلها|بدلهم|بدل|غيّر|غيرها|غيرهم|غير|حطها|حطه|حط|set|make|change)` +
    CORRECTION_END,
  'iu',
);
const AR_NUMBER_WORD_RE = new RegExp(
  String.raw`(?:واحدة|واحد|اثنين|اتنين|ثلاثة|ثلاثه|تلاتة|تلاته|أربعة|اربعة|اربعه|أربعه|خمسة|خمسه|ستة|سته|سبعة|سبعه|ثمانية|تمنية|تسعة|تسعه|عشرة|عشره|عشر|ألفين|ألف|الفين|الف|مليونين|مليون)` +
    CORRECTION_END,
  'iu',
);
const CORRECTION_FILLER_RE = new RegExp(
  String.raw`(?:استنى|استني|يعني|بقى|خلاص|طيب|أهو|اهو)` + CORRECTION_END,
  'iu',
);
/* Bare "لا" is deliberately absent from the name list: it protects names
   like "ماوس لا سلكي" from ever being read as a correction word. */
const CORRECTION_NAME_RE = /(?:^|\s)(?:لأ+|استنى|استني|غلطت|wait|actually|i\s+mean)(?:\s|$)/iu;
/* A bare 4-6 digit amount with no unit and not glued to letters reads as
   money ("مكنسة 5000"); "iPhone 15" and "256" storage do not. */
const MONEY_SHAPE_RE = /(?:^|[^\p{L}\p{N}])(?:\d{4,6})(?![\p{L}\p{N}])/u;
/* Clause split for corrections only. A comma or dot between digits belongs to
   the number ("3,200", "2.5 ألف") and must never cut a value in half; the
   shared CLAUSE_SPLIT_RE stays untouched for the narrative parser. */
const CORRECTION_SPLIT_RE = /(?:[،;!?]|\n)+|(?<!\d)[.,]|[.,](?!\d)/gu;

function withGlobal(regex) {
  return new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
}

function numberTokens(text) {
  const values = [];
  const regex = /(\d[\d.,]*)\b\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?/giu;
  for (const match of String(text || '').matchAll(regex)) {
    const value = parseAmount(match[1], match[2]);
    if (value === null) continue;
    values.push({
      value,
      start: match.index,
      end: match[2] ? match.index + match[0].length : match.index + match[1].length,
    });
  }
  return values;
}

/* An explicit field label only; the currency fallback exists for display,
   never for binding ("لأ التكلفة 2500" must seek a cost clause, not any
   number that happens to be nearby). */
function clauseFieldLabel(text) {
  const value = String(text || '');
  if (fieldRegex(COST_LABEL).test(value)) return 'costPrice';
  if (fieldRegex(STOCK_LABEL).test(value)) return 'openingStock';
  if (fieldRegex(SELLING_LABEL).test(value)) return 'sellingPrice';
  return '';
}

function clauseValueLabel(text) {
  const explicit = clauseFieldLabel(text);
  if (explicit) return explicit;
  if (/(?:جنيه|جنية|ج\.م|egp|\$|£|€|بـ|بسعر|سعر)/iu.test(String(text || ''))) {
    return 'sellingPrice';
  }
  return 'value';
}

/* Fail closed: once the marker, verbs, pronoun suffixes, fillers, number
   words, digits, labels, currency and units are removed, nothing of the
   correction clause may remain. "لأ خليها 4K" keeps K and "لأ خليه iPhone 16"
   keeps iPhone, so neither is ever bound as a price. Digits are removed
   WITHOUT their multiplier on purpose: 4K must not become 4000. */
function correctionClauseIsConsumed(text) {
  let rest = String(text || '');
  rest = rest.replace(CORRECTION_MARKER_RE, ' ');
  rest = rest.replace(withGlobal(REASSIGN_VERB_RE), ' ');
  rest = rest.replace(withGlobal(CORRECTION_FILLER_RE), ' ');
  rest = rest.replace(withGlobal(AR_NUMBER_WORD_RE), ' ');
  /* Field labels before the digits: fieldRegex needs its amount, so a label
     stripped after the digits would never match and every labeled correction
     ("لأ التكلفة 2500") would fail as unconsumed, blocking the -2 path. */
  rest = rest.replace(withGlobal(fieldRegex(SELLING_LABEL)), ' ');
  rest = rest.replace(withGlobal(fieldRegex(COST_LABEL)), ' ');
  rest = rest.replace(withGlobal(fieldRegex(STOCK_LABEL)), ' ');
  rest = rest.replace(/\d[\d.,]*/g, ' ');
  rest = rest.replace(withGlobal(MONEY_RE), ' ');
  /* No SPEC_UNIT strip here on purpose: "لأ خليها 55 بوصة" is a spec
     correction, not a value correction. It must fail as unconsumed (goes to
     unresolved) instead of binding 55 as a price the pool then skips. */
  rest = rest.replace(/[\s،,.!?؛:ـ\-–—]+/gu, ' ').trim();
  return rest === '';
}

/* Where a correction binds. Returns the clause index, -1 when the value
   cannot be bound safely (the model decides), or -2 when a labeled
   correction has no earlier clause with that label — strip the marker and
   let the normal labeled extraction read it. */
function bindTarget(clauses, index, label) {
  for (let back = index - 1; back >= 0; back -= 1) {
    const clause = clauses[back];
    if (clause.dropped) continue;
    const found = numberTokens(clause.text);
    if (label) {
      if (clauseFieldLabel(clause.text) === label) {
        return found.length === 1 ? back : -1;
      }
      continue;
    }
    if (!found.length) continue;
    return found.length === 1 ? back : -1;
  }
  return label ? -2 : -1;
}

/* Rewrite a sentence that corrects itself. A correction clause ends at the
   first clause boundary, not at the next marker, and its value replaces the
   number of the clause it corrects — never a value from elsewhere in the
   trail. The name then comes from the sentence before any marker. Anything
   that cannot be bound is marked unresolved so the draft reaches the model
   instead of carrying a stale number. */
function resolveCorrections(source) {
  const text = String(source || '');
  const clauses = [];
  let cursor = 0;
  const push = (start, end) => {
    const raw = text.slice(start, end);
    const body = raw.trim();
    if (!body) return;
    const lead = raw.length - raw.trimStart().length;
    clauses.push({
      start: start + lead,
      end: start + lead + body.length,
      text: body,
      dropped: false,
    });
  };
  for (const match of text.matchAll(CORRECTION_SPLIT_RE)) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);

  const corrections = [];
  let resolvedCount = 0;
  let unresolved = false;
  let changed = false;

  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index];
    if (clause.dropped) continue;
    if (!CORRECTION_MARKER_RE.test(clause.text)) continue;
    const hasNumber = /\d/.test(clause.text) || AR_NUMBER_WORD_RE.test(clause.text);
    const hasVerb = REASSIGN_VERB_RE.test(clause.text);
    if (!hasNumber && !hasVerb) continue;
    const label = clauseFieldLabel(clause.text);
    const incoming = numberTokens(clause.text);
    if (incoming.length !== 1 || !/\d/.test(clause.text) ||
        !correctionClauseIsConsumed(clause.text)) {
      unresolved = true;
      continue;
    }
    const targetIndex = bindTarget(clauses, index, label);
    if (targetIndex === -1) {
      unresolved = true;
      continue;
    }
    if (targetIndex === -2) {
      clause.text = clause.text.replace(CORRECTION_MARKER_RE, '').trim();
      changed = true;
      continue;
    }
    const target = clauses[targetIndex];
    const previousValue = numberTokens(target.text)[0];
    const nextValue = incoming[0];
    /* An unlabeled correction binds by adjacency, so a wild jump reads as a
       mis-bind, not an edit: "الكمية 5، لأ خليها 3200" would set stock six
       hundred times over. Real self-corrections sit far under 20x
       (3000 -> 3200, 5 -> 7); anything at or above it stays unresolved so
       the model reads the sentence instead of a silently wrong value. */
    if (!label) {
      const low = Math.min(Math.abs(previousValue.value), Math.abs(nextValue.value));
      const high = Math.max(Math.abs(previousValue.value), Math.abs(nextValue.value));
      if ((low === 0 && high > 0) || (low > 0 && high / low >= 20)) {
        unresolved = true;
        continue;
      }
    }
    /* Money evidence must never land on stock: "لأ خليها 3200 جنيه" is a
       price and "لأ بـ 3200" is the price idiom, so binding either to the
       quantity would write money as a count. The target clause decides the
       field; a 16x jump under the magnitude guard still reads as money. */
    if (clauseValueLabel(target.text) === 'openingStock' &&
        (MONEY_RE.test(clause.text) || /(?:^|[^\p{L}\p{N}])ب(?=\s*\d|ـ)/u.test(clause.text))) {
      unresolved = true;
      continue;
    }
    if (previousValue.value !== nextValue.value) {
      /* Applied immediately: a chained correction sees the updated clause,
         and two edits can never land on the same span. */
      target.text = target.text.slice(0, previousValue.start) +
        String(nextValue.value) + target.text.slice(previousValue.end);
      changed = true;
    }
    corrections.push({
      field: clauseValueLabel(target.text),
      from: previousValue.value,
      to: nextValue.value,
    });
    clause.dropped = true;
    changed = true;
    resolvedCount += 1;
  }

  /* Any marker still standing means the sentence was not fully understood:
     a name correction ("لأ مش مكنسة") or a value nothing could bind. A bare
     marker ("لأ،") is dropped only when another correction resolved.
     Bare means nothing is left once the marker is gone — "لأ مش مكنسة"
     keeps its words, so a name objection can never be discarded as bare. */
  for (const clause of clauses) {
    if (clause.dropped) continue;
    if (!CORRECTION_MARKER_RE.test(clause.text)) continue;
    const bare = clause.text
      .replace(withGlobal(CORRECTION_MARKER_RE), ' ')
      .replace(/[\s،,.!?؛:ـ\-–—]+/gu, '') === '';
    if (bare && resolvedCount > 0) {
      clause.dropped = true;
      changed = true;
      continue;
    }
    unresolved = true;
  }

  if (!changed) return { text, corrections: [], unresolved };

  let result = '';
  let position = 0;
  for (const clause of clauses) {
    if (clause.dropped) {
      /* Drop the separator before the clause along with it; keep the one
         after, so the rebuilt sentence reads naturally. */
      position = clause.end;
      continue;
    }
    result += text.slice(position, clause.start) + clause.text;
    position = clause.end;
  }
  result += text.slice(position);

  /* Chained corrections on one field collapse to the first old value and
     the last new value ("3000... 3200... 3300" reads as 3000 -> 3300). */
  const collapsed = [];
  for (const item of corrections) {
    const existing = item.field === 'value'
      ? null
      : collapsed.find((entry) => entry.field === item.field);
    if (existing) {
      existing.to = item.to;
      continue;
    }
    collapsed.push({ ...item });
  }

  return {
    text: result.replace(/\s{2,}/g, ' ').trim(),
    corrections: collapsed,
    unresolved,
  };
}

/* Every number in the sentence must land somewhere: a parsed field, a
   whitelisted name number, a rate ("خصم 10%"), a barcode/SKU the user typed,
   or a name the user quoted themselves. Anything left means the sentence
   carries a value nothing claimed, so the draft reaches the model instead of
   silently dropping it. */
function unclaimedNumbers(source, draft) {
  const text = String(source || '');
  const pool = [];
  for (const span of numberTokens(text)) {
    const after = text.slice(span.end, span.end + 12);
    if (/^\s*(?:%|٪|بالمية|في\s*المية)/.test(after)) continue;
    /* A spec descriptor ("12 وات", "55 بوصة") is never money or a count, so
       it cannot be a value that went missing — skip it even when the name
       extraction dropped it. */
    if (new RegExp(String.raw`^\s*${SPEC_UNIT}(?![\p{L}\p{N}])`, 'iu').test(after)) continue;
    pool.push(span.value);
  }
  if (!pool.length) return [];
  const claimed = [];
  const claim = (value) => {
    const number = Number(value);
    if (Number.isFinite(number)) claimed.push(number);
  };
  const claimDigits = (value) => {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (digits) claim(parseAmount(digits, ''));
  };
  if (draft.sellingPrice !== undefined && !draft.sellingDerived) claim(draft.sellingPrice);
  if (draft.costPrice !== undefined && !draft.costDerived) claim(draft.costPrice);
  if (draft.openingStock !== undefined) claim(draft.openingStock);
  if (draft.costTotal !== undefined) claim(draft.costTotal);
  if (draft.sellingTotal !== undefined) claim(draft.sellingTotal);
  if (draft.unitsPerPack !== undefined) claim(draft.unitsPerPack);
  if (draft.packCount !== undefined) claim(draft.packCount);
  claimDigits(draft.barcode);
  claimDigits(draft.sku);
  if (draft.categoryName) {
    for (const value of extractAmounts(draft.categoryName)) claim(value);
  }
  /* A number the user wrapped in quotes is theirs: "لابتوب 17 إنش" is a
     name, not an unclaimed 17. */
  const quoted = text.match(QUOTED_NAME_RE);
  if (quoted) {
    for (const span of numberTokens(quoted[0])) claim(span.value);
  }
  for (const value of claimed) {
    const at = pool.indexOf(value);
    if (at >= 0) pool.splice(at, 1);
  }
  for (const span of nameNumberSpans(draft.name)) {
    if (whitelistedNameNumber(draft.name, span)) {
      const at = pool.indexOf(span.value);
      if (at >= 0) pool.splice(at, 1);
    }
  }
  return pool.length ? ['unclaimed_number'] : [];
}

function nameNumberSpans(name) {
  const spans = [];
  for (const match of String(name || '').matchAll(/(\d[\d.,]*)/gu)) {
    const value = parseAmount(match[1], '');
    if (value !== null) {
      spans.push({ value, start: match.index, end: match.index + match[1].length });
    }
  }
  return spans;
}

/* A number inside the name only reads as part of the name when it is glued
   to letters ("3M", "32GB"), followed by a spec unit ("12 وات"), or behind a
   short Latin token ("iPhone 15", "iPhone 15 8 RAM", "Pro Max 256"). The
   token check ignores digits and spaces between it and the number, so
   "iPhone 15 8" still counts — but a long number ("Samsung 25000") is money,
   not a model number. */
function whitelistedNameNumber(name, span) {
  const text = String(name || '');
  const before = text.slice(Math.max(0, span.start - 12), span.start);
  const after = text.slice(span.end, span.end + 12);
  if (/\p{L}$/u.test(before)) return true;
  if (/^\p{L}/u.test(after)) return true;
  if (new RegExp(String.raw`^\s*${SPEC_UNIT}(?![\p{L}\p{N}])`, 'iu').test(after)) return true;
  const latinBefore = before.replace(/[\d\s]+$/u, '');
  if (/(?:^|\s)[A-Za-z][A-Za-z0-9./+-]*$/u.test(latinBefore) && span.end - span.start <= 3) {
    return true;
  }
  return false;
}

/* Plain values for the model's suspect-field context: the local checker
   refused the draft, so every number in the sentence stays visible. */
function sentenceNumbers(text) {
  return numberTokens(text).map((span) => span.value);
}

function roundMoney(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}

/* Amounts that are product specs ("12 وات") or pack contents ("20 لمبة") are
   not money. A currency word wins; otherwise the last remaining amount is the
   value the clause is talking about. */
function clauseMoneyAmount(clause) {
  const text = String(clause || '');
  const values = [];
  const regex = /(\d[\d.,]*)\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?\s*(جنيه|جنية|جنيها|ج\.م|egp|le|ريال|درهم|دينار|\$|£|€)?/giu;
  for (const match of text.matchAll(regex)) {
    const after = text.slice(match.index + match[0].length);
    if (new RegExp(String.raw`^\s*${SPEC_UNIT}(?![\p{L}\p{N}])`, 'iu').test(after)) continue;
    if (new RegExp(String.raw`^\s*${UNIT_NOUN}(?![\p{L}\p{N}])`, 'iu').test(after)) continue;
    const value = parseAmount(match[1], match[2]);
    if (value !== null) values.push({ value, currency: !!match[3] });
  }
  if (!values.length) return null;
  const withCurrency = values.filter((item) => item.currency);
  return withCurrency.length
    ? withCurrency[withCurrency.length - 1].value
    : values[values.length - 1].value;
}

function cleanProductPhrase(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.split(/(?:[،,;.!?\n]|\s+(?:بسعر|سعر|تكلفة|بـ|ب|عايز|عاوز|أريد|اريد|أبيع|ابيع|ضيف|ضيفها|في\s+قسم|في\s+فئة)(?=[\s،,.:!?]|$))/u)[0];
  text = text.replace(CREATE_PRONOUN_RE, ' ');
  text = text.replace(NARRATIVE_LEAD_RE, ' ');
  text = text.replace(CURRENCY_WORD_RE, ' ');
  text = text.replace(/(?:^|\s)(?:و|and)(?=\s|$)/giu, ' ');
  text = text.replace(PUNCT_EDGE_RE, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_NAME_CHARS);
}

/* Returns how many units arrived and, when the sentence names it, the product
   phrase that followed the count ("20 لمبة ليد 12 وات" -> "لمبة ليد 12 وات"). */
function extractPackQuantity(source) {
  const text = String(source || '');
  let unitsPerPack = null;
  let packCount = null;
  let productPhrase = '';
  let phrase = '';

  const captureProduct = String.raw`((?:${UNIT_NOUN})?\s*[^.!?،,;\n]{0,100})`;
  const insideRe = new RegExp(
    String.raw`${PACK_NOUN}[^.!?،,;\n]{0,24}?${PACK_CONTAIN}\s*(\d[\d.,]*)\s*${captureProduct}`,
    'iu',
  );
  let match = text.match(insideRe);
  if (match) {
    const amount = parseAmount(match[1]);
    if (amount !== null && amount > 0) {
      unitsPerPack = amount;
      productPhrase = match[2] || '';
      phrase = match[0];
    }
  }

  if (unitsPerPack === null) {
    const containRe = new RegExp(
      String.raw`${PACK_CONTAIN}\s*(\d[\d.,]*)\s*${captureProduct}`,
      'iu',
    );
    match = text.match(containRe);
    if (match) {
      const amount = parseAmount(match[1]);
      if (amount !== null && amount > 0) {
        unitsPerPack = amount;
        productPhrase = match[2] || '';
        phrase = match[0];
      }
    }
  }

  if (unitsPerPack === null && STOCK_IN_RE.test(text)) {
    const countedRe = new RegExp(
      String.raw`(?:^|[\s،,])(\d[\d.,]*)\s+((?:${UNIT_NOUN})(?![\p{L}\p{N}])\s*[^.!?،,;\n]{0,100})`,
      'iu',
    );
    match = text.match(countedRe);
    if (match) {
      const amount = parseAmount(match[1]);
      if (amount !== null && amount > 0) {
        unitsPerPack = amount;
        productPhrase = match[2] || '';
        phrase = match[0];
      }
    }
  }

  const packCountRe = new RegExp(
    String.raw`(?:^|[\s،,])(\d[\d.,]*)\s*${PACK_NOUN}(?![\p{L}\p{N}])`,
    'iu',
  );
  match = text.match(packCountRe);
  if (match) {
    const amount = parseAmount(match[1]);
    if (amount !== null && amount > 1) packCount = amount;
  }
  if (packCount === null && /(?:كرتونتين|كارتونتين|علبتين|صندوقين)/iu.test(text)) {
    packCount = 2;
  }

  if (unitsPerPack === null && packCount === null) return null;
  const units = unitsPerPack !== null && packCount !== null
    ? unitsPerPack * packCount
    : unitsPerPack;
  return {
    units,
    unitsPerPack,
    packCount,
    productPhrase: cleanProductPhrase(productPhrase),
    phrase,
  };
}

function extractTotalCost(source) {
  for (const clause of clausesOf(source)) {
    if (PER_UNIT_RE.test(clause)) continue;
    const marker = COST_TOTAL_MARKER_RE.test(clause);
    const verb = COST_VERB_RE.test(clause);
    if (!marker && !verb) continue;
    const amount = clauseMoneyAmount(clause);
    if (amount === null) continue;
    if (!verb && !MONEY_RE.test(clause) && !/(?:بـ|ب|:|=)\s*\d/iu.test(clause)) continue;
    return { total: amount, phrase: clause, explicit: marker };
  }
  return null;
}

/* "وقفت علينا 600" without a pack word is a total when the sentence already
   says how many units arrived; otherwise it is the unit cost. */
function extractLooseCost(source) {
  for (const clause of clausesOf(source)) {
    if (!COST_VERB_RE.test(clause)) continue;
    if (COST_TOTAL_MARKER_RE.test(clause) || PER_UNIT_RE.test(clause)) continue;
    const amount = clauseMoneyAmount(clause);
    if (amount !== null) return { amount, phrase: clause };
  }
  return null;
}

function extractSelling(source) {
  for (const clause of clausesOf(source)) {
    if (COST_TOTAL_MARKER_RE.test(clause) && !PER_UNIT_RE.test(clause)) continue;
    const sell = SELL_VERB_RE.test(clause);
    const perUnit = PER_UNIT_RE.test(clause);
    if (!sell && !perUnit) continue;
    /* "selling price 50000" is the labeled parser's job, not a narrative. */
    if (!perUnit && /(?:سعر\s*البيع|selling\s*price|sale\s*price)/iu.test(clause)) {
      continue;
    }
    const amount = clauseMoneyAmount(clause);
    if (amount === null) continue;
    if (perUnit) return { unit: amount, phrase: clause };
    if (sell && new RegExp(PACK_NOUN, 'iu').test(clause)) {
      return { total: amount, phrase: clause };
    }
    if (sell) return { unit: amount, phrase: clause };
  }
  return null;
}

function parseNarrativeCommerce(source) {
  const text = String(source || '');
  const pack = extractPackQuantity(text);
  const totalCost = extractTotalCost(text);
  const looseCost = totalCost ? null : extractLooseCost(text);
  const selling = extractSelling(text);
  if (!pack && !totalCost && !looseCost && !selling) return null;
  return { pack, totalCost, looseCost, selling, detected: true };
}

function stripNarrativeClauses(value, narrative) {
  let text = String(value || '');
  const phrases = [
    narrative && narrative.pack && narrative.pack.phrase,
    narrative && narrative.totalCost && narrative.totalCost.phrase,
    narrative && narrative.looseCost && narrative.looseCost.phrase,
    narrative && narrative.selling && narrative.selling.phrase,
  ].filter(Boolean);
  for (const phrase of phrases) text = text.replace(phrase, ' ');
  text = text.replace(CREATE_PRONOUN_RE, ' ');
  text = text.replace(NARRATIVE_LEAD_RE, ' ');
  text = text.replace(
    new RegExp(String.raw`${PACK_NOUN}[^.!?،,;\n]{0,16}?${PACK_CONTAIN}?\s*\d[\d.,]*`, 'giu'),
    ' ',
  );
  text = text.replace(new RegExp(String.raw`${PACK_CONTAIN}\s*\d[\d.,]*`, 'giu'), ' ');
  text = text.replace(new RegExp(String.raw`\d[\d.,]*\s*${PACK_NOUN}`, 'giu'), ' ');
  text = text.replace(COST_TOTAL_MARKER_RE, ' ');
  text = text.replace(COST_VERB_RE, ' ');
  text = text.replace(SELL_VERB_RE, ' ');
  text = text.replace(PER_UNIT_RE, ' ');
  return text;
}

function looksLikeNarrativeName(value) {
  const text = normalizeName(value);
  if (!text) return false;
  if (/(?:المخزن|كرتونة|كرتون|وقفت|كلفت|عايز|عاوز|أبيع|ابيع|ضيفها|ضيفه|فاتورة|الواحدة)/u.test(text)) {
    return true;
  }
  return text.split(' ').length > 12;
}

/* The deterministic path is for a form-shaped request: a name and labeled
   values. Anything that reads like a story, a calculation, a discount, a
   pack, a percentage or a sentence with several clauses needs reasoning, so
   it is forwarded to the model with a resolution plan instead of being
   squeezed into the local form parser. When in doubt, forward. */
const REASONING_RE = /(?:احسب|حساب|نسبة|بالمية|في\s*المية|%|خصم|تخفيض|ضريبة|باقي|الباقي|إجمالي|اجمالي|متوسط|كل\s+واحدة|الواحدة|للقطعة|للوحدة|جملة|نصف|نص|ربع|تلت|ثلث|ضاعف|ضعف|وزع|حوّل|حول|على\s+حساب|total|average|discount|tax|percent|split|half|quarter|double|per\s+(?:unit|piece)|pack|carton|box|wholesale)/iu;
/* A create sentence with a second ask ("وكمان قولي الربح", "هل ده صح؟")
   is not a form. Forward it instead of guessing which clause is the name. */
const EXTRA_ASK_RE = /(?:^|[\s،,])(?:وكمان|كمان|وقولي|قولي|قلي|وأيضاً|وأيضا|ايضا|أيضا|also|and\s+also|then|بعدين|هل|what|how|why|when|where|عايز\s+أعرف|عاوز\s+أعرف|أعرف|اعرف|tell\s+me|show\s+me|report)(?:[\s،,.:]|$)/iu;
/* General reasoning signals, not a phrase list for one dialect. */
const UNCERTAIN_RE = /(?:تقريب|حوالي|حوالى|approx|about|around|roughly|ربما|maybe)/iu;
const RANGE_RE = /\d+\s*(?:أو|او|or|إلى|الى|لـ|to|و)\s*\d+/iu;
const BETWEEN_RE = /(?:بين|between)\s*\d+[\s\S]{0,12}\d+/iu;
const REASON_RE = /(?:^|[\s،,])(?:عشان|علشان|لأن|لان|because|since)(?:[\s،,.:]|$)/iu;
const EXTRA_ACTION_RE = /(?:^|[\s،,])(?:و|ثم|and|then)\s*(?:اعمل|أعمل|سوي|سوّي|جهز|حضر|make|do)(?![\p{L}\p{N}])/iu;

function looksLikeExtraAsk(source) {
  const text = String(source || '');
  return EXTRA_ASK_RE.test(text) || /[?؟]/.test(text);
}

function looksLikeReasoningRequest(source, draft = null) {
  const text = String(source || '');
  if (!text) return false;
  if (draft && (draft.narrative || draft.costTotal !== undefined ||
      draft.sellingTotal !== undefined || draft.unitsPerPack !== undefined ||
      draft.packCount !== undefined || draft.priceAmbiguous)) {
    return true;
  }
  if (REASONING_RE.test(text)) return true;
  if (looksLikeExtraAsk(text)) return true;
  if (UNCERTAIN_RE.test(text)) return true;
  if (RANGE_RE.test(text) || BETWEEN_RE.test(text)) return true;
  if (REASON_RE.test(text)) return true;
  if (EXTRA_ACTION_RE.test(text)) return true;
  if (STOCK_IN_RE.test(text)) return true;
  /* "20 لمبة ..." is a quantity story, not a product whose name starts with
     a number. A real model number ("3M tape") is rare enough to forward. */
  if (/^\s*(?:(?:أضيف|اضف|ضيف|add|create)\s+)?\d+\s+[\p{L}]/iu.test(text)) return true;
  if (text.split(/\s+/).filter(Boolean).length > 25) return true;
  return false;
}

/* CATEGORY_STOP_WORDS is shared with the ask-user tool: ../category-terms */

function fieldRegex(label) {
  return new RegExp(
    `${LABEL_PREFIX}${CONNECTOR}(?:${label})${SEP}${AMOUNT}${CURRENCY}`,
    'giu',
  );
}

function foldDigits(value) {
  return String(value == null ? '' : value)
    /* Arabic separators are the digits' own punctuation: ٣٬٢٠٠ must fold to
       3,200, not to a number the field regex stops reading at ٬. */
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
    if (arabic >= 0) return String(arabic);
    const persian = '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit);
    return persian >= 0 ? String(persian) : digit;
  });
}

function parseAmount(raw, multiplier) {
  let text = foldDigits(raw).replace(/\s+/g, '');
  if (!text) return null;
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(text)) {
    text = text.replace(/[.,]/g, '');
  } else {
    text = text.replace(/,/g, '');
    const parts = text.split('.');
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
      text = parts.join('');
    }
  }
  let value = Number(text);
  if (!Number.isFinite(value)) return null;
  const unit = String(multiplier || '').trim().toLowerCase();
  if (/ألف|الف|آلاف|الاف|thousand|^k$/.test(unit)) value *= 1000;
  else if (/مليون|million/.test(unit)) value *= 1000000;
  return Number.isFinite(value) ? value : null;
}

function extractField(text, label) {
  const regex = fieldRegex(label);
  let found = null;
  for (const match of String(text || '').matchAll(regex)) {
    const value = parseAmount(match[1], match[2]);
    if (value !== null) found = value;
  }
  return found;
}

function extractFieldValues(text, label) {
  const regex = fieldRegex(label);
  const values = [];
  for (const match of String(text || '').matchAll(regex)) {
    const value = parseAmount(match[1], match[2]);
    if (value !== null && !values.includes(value)) values.push(value);
  }
  return values;
}

function stripField(text, label, unit = '') {
  /* An optional count noun after the value belongs to the field, not to the
     name: "والكمية 7 قطع" must not leave "قطع" behind. The whitespace is
     optional because AMOUNT's own trailing \s* has already consumed it, and
     the word must end at a boundary so "لمبات" is never half-eaten as
     "لمب" (an unmatched plural then stays whole in the name). */
  const suffix = unit ? String.raw`(?:\s*(?:${unit})(?![\p{L}\p{N}]))?` : '';
  return String(text || '').replace(
    new RegExp(`${LABEL_PREFIX}${CONNECTOR}(?:${label})${SEP}${AMOUNT}${CURRENCY}${suffix}`, 'giu'),
    ' ',
  );
}

/* Some answers carry meaning without a number: "cost is the same as price",
   "no stock". They update the draft, and they must not leak into the name. */
function stripExplicitPhrases(text) {
  let value = String(text || '');
  value = value.replace(
    /(?:^|[\s،,])(?:و\s*)?(?:ال)?(?:تكلفة|سعر\s+التكلفة|cost(?:\s+price)?)\s*(?:هو|هي|بقى|:|=)?\s*(?:نفس\s+(?:سعر\s+)?البيع|نفس\s+السعر|زي\s+السعر|زى\s+السعر|بنفس\s+السعر|same\s+(?:as\s+)?(?:the\s+)?(?:selling\s+)?price)(?![\p{L}\p{N}])/giu,
    ' ',
  );
  value = value.replace(
    /(?:^|[\s،,])(?:و\s*)?(?:مفيش|مش\s+فيه|بدون|no|zero|out\s+of)\s*(?:مخزون|كمية|stock)(?![\p{L}\p{N}])/giu,
    ' ',
  );
  value = value.replace(
    /(?:^|[\s،,])(?:و\s*)?(?:الكمية|المخزون)\s*(?:صفر|٠)(?![\p{L}\p{N}])/giu,
    ' ',
  );
  value = value.replace(
    /(?:^|[\s،,])(?:و\s*)?(?:ببلاش|مجانا|مجاناً|مجاني)(?![\p{L}\p{N}])|\bfor\s+free\b|\bit'?s\s+free\b/giu,
    ' ',
  );
  return value;
}

function cleanCategoryName(value) {
  const words = String(value || '')
    .trim()
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const kept = [];
  for (const word of words) {
    const key = word.toLowerCase().replace(/[.!?،,؛;:؟…]+$/u, '');
    if (CATEGORY_STOP_WORDS.has(key) || isFillerToken(word)) break;
    if (key.startsWith('و') && key.length > 2 && CATEGORY_STOP_WORDS.has(key.slice(1))) break;
    kept.push(word);
    if (kept.length >= 3) break;
  }
  return kept
    .join(' ')
    .replace(/[.!?،,؛;:؟…]+$/u, '')
    .trim()
    .slice(0, MAX_CATEGORY_CHARS);
}

function extractCategory(text) {
  const source = String(text || '');
  if (UNCATEGORIZED_RE.test(source)) return { choice: 'uncategorized' };
  if (SAME_CATEGORY_RE.test(source)) return { choice: 'same' };
  if (OTHER_CATEGORY_RE.test(source)) return { choice: 'other' };
  const namedCreate = source.match(CATEGORY_NAMED_CREATE_RE);
  if (namedCreate) {
    return { choice: 'create', create: true, name: cleanCategoryName(namedCreate[1]) };
  }
  if (NEW_CATEGORY_ONLY_RE.test(source)) return { choice: 'create', create: true, name: '' };
  const create = source.match(CATEGORY_CREATE_RE);
  if (create) {
    return { choice: 'create', create: true, name: cleanCategoryName(create[1]) };
  }
  if (CREATE_CATEGORY_ONLY_RE.test(source)) {
    return { choice: 'create', create: true, name: '' };
  }
  const phrase = namedCategory(source);
  if (phrase) return { choice: 'named', name: cleanCategoryName(phrase) };
  const label = source.match(CATEGORY_LABEL_RE);
  if (label) return { choice: 'named', name: cleanCategoryName(label[1]) };
  const place = source.match(CATEGORY_PLACE_RE);
  if (place) return { choice: 'named', name: cleanCategoryName(place[1]) };
  const plain = source.trim().match(CATEGORY_PLAIN_RE);
  if (plain) return { choice: 'named', name: cleanCategoryName(plain[1]) };
  return null;
}

function stripPrefixes(value) {
  let text = String(value || '').trim();
  let changed = true;
  const prefixes = [
    ACTION_PREFIX_RE,
    CREATE_PREFIX_RE,
    NEW_PRODUCT_PREFIX_RE,
    PRODUCT_WORD_RE,
    ARTICLE_RE,
    NEW_WORD_RE,
    CALLED_RE,
    LEADING_CONNECTOR_RE,
  ];
  while (changed) {
    changed = false;
    const cleaned = text.replace(/^[\s:،,.;\-–—]+/, '').trim();
    if (cleaned !== text) {
      text = cleaned;
      changed = true;
    }
    for (const regex of prefixes) {
      if (regex.test(text)) {
        text = text.replace(regex, '').trim();
        changed = true;
      }
    }
    /* A typo in an Arabic filler word ("جديدي" for "جديد") should not become
       the product name. Only strip it when a real name follows, so a product
       literally called "جديد" is still possible after the all-filler check. */
    const leading = text.match(/^(\S+)\s+(.+)$/u);
    if (leading && /[\u0600-\u06FF]/.test(leading[1]) && isFillerToken(leading[1])) {
      text = leading[2].trim();
      changed = true;
    }
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Category clauses can contain the first word of the next field
   ("في فئة أجهزة منزلية بسعر 22 ألف"). Remove only the category itself so
   the price clause survives for the field parser. */
function removeCategoryMatch(value, regex) {
  const match = value.match(regex);
  if (!match) return value;
  const clause = match[0];
  const start = value.indexOf(clause);
  if (start < 0) return value;
  const name = cleanCategoryName(match[1]);
  if (!name) return value.slice(0, start) + ' ' + value.slice(start + clause.length);
  const nameIndex = clause.indexOf(name);
  const end = nameIndex >= 0 ? nameIndex + name.length : clause.length;
  return value.slice(0, start) + ' ' + value.slice(start + end);
}

function stripCategoryClauses(value) {
  let text = String(value || '');
  text = removeCategoryMatch(text, CATEGORY_NAMED_CREATE_RE);
  text = removeCategoryMatch(text, CATEGORY_CREATE_RE);
  text = removeCategoryMatch(text, CATEGORY_PHRASE_RE);
  text = removeCategoryMatch(text, CATEGORY_LABEL_RE);
  text = removeCategoryMatch(text, CATEGORY_PLACE_RE);
  text = removeCategoryMatch(text, CATEGORY_PLAIN_RE);
  text = text.replace(CREATE_CATEGORY_ONLY_RE, ' ');
  text = text.replace(UNCATEGORIZED_RE, ' ');
  text = text.replace(OTHER_CATEGORY_RE, ' ');
  text = text.replace(SAME_CATEGORY_RE, ' ');
  text = text.replace(NEW_CATEGORY_ONLY_RE, ' ');
  return text;
}

function extractAmounts(text) {
  const values = [];
  const regex = /(\d[\d.,]*)\b\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?/giu;
  for (const match of String(text || '').matchAll(regex)) {
    const value = parseAmount(match[1], match[2]);
    if (value !== null) values.push(value);
  }
  return values;
}

/* Bare amounts beside a labeled cost or stock can be the price, but a number
   followed by a size or capacity unit is a product spec, not money. */
const BARE_AMOUNT_RE = /(\d[\d.,]*)\b\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?(?!\s*(?:inch|in|بوصة|بوصه|سم|مم|mm|cm|kg|كجم|كيلو|جم|جرام|gram|gb|mb|tb|ram|رام|جيجا|جيجابايت|ميجا|تيرا|لتر|liter|ml|مل))/giu;

function extractBareAmounts(text) {
  const values = [];
  for (const match of String(text || '').matchAll(BARE_AMOUNT_RE)) {
    const value = parseAmount(match[1], match[2]);
    if (value !== null) values.push(value);
  }
  return values;
}

function stripSizeClauses(text) {
  return String(text || '').replace(
    /(?:مقاس|مقاسه|مقاسها|size)\s*\d[\d.,]*\s*(?:سم|مم|mm|cm|inch|in|بوصة|بوصه)?/giu,
    ' ',
  );
}

function extractForPrice(text) {
  const regex = new RegExp(FOR_PRICE_RE.source, 'giu');
  const values = [];
  for (const match of String(text || '').matchAll(regex)) {
    const value = parseAmount(match[1], match[2]);
    if (value !== null) values.push(value);
  }
  return values.length === 1 ? values[0] : null;
}

function stripAmountValue(text, value) {
  const regex = /(?:^|(?<=[\s،,]))(?:for|at|بـ|ب)?\s*(\d[\d.,]*)\b\s*(ألف|الف|آلاف|الاف|k|thousand|مليون|million)?/giu;
  let result = String(text || '');
  for (const match of result.matchAll(regex)) {
    if (parseAmount(match[1], match[2]) === value) {
      return result.replace(match[0], ' ');
    }
  }
  return result;
}

function looksNumericOnly(value) {
  let text = String(value || '');
  if (!text.trim()) return false;
  text = text.replace(/\d[\d.,]*\s*(?:ألف|الف|آلاف|الاف|k|thousand|مليون|million)?/giu, ' ');
  text = text.replace(/(?:جنيه|جنية|جنيها|ج\.م|egp|le|ريال|درهم|دينار|\$|£|€)/giu, ' ');
  text = text.replace(/[،,.;:+\-–—\s]+/g, ' ');
  text = text.replace(/(?:^|\s)(?:و|and)(?=\s|$)/giu, ' ');
  return !/[\p{L}\p{N}]/u.test(text);
}

function extractName(text, { stripPrice = null, narrative = null } = {}) {
  const source = String(text || '');
  const trimmed = source.trim();
  if (ACK_RE.test(trimmed) || REJECT_RE.test(trimmed) || CHOOSE_FOR_ME_RE.test(trimmed) ||
      NOT_IMPORTANT_RE.test(trimmed) || UNSURE_RE.test(trimmed) ||
      NOT_IMPORTANT_ANY_RE.test(trimmed) || UNSURE_ANY_RE.test(trimmed)) {
    return '';
  }
  const quoted = source.match(QUOTED_NAME_RE);
  if (quoted) {
    const before = source.slice(0, quoted.index);
    if (!/(?:فئة|قسم|تصنيف|category)\s*[:=]?\s*$/iu.test(before)) {
      return quoted[1].trim().slice(0, MAX_NAME_CHARS);
    }
  }
  let value = stripCategoryClauses(source);
  value = value.replace(CREATE_PRONOUN_RE, ' ');
  if (narrative) value = stripNarrativeClauses(value, narrative);
  value = stripField(value, SELLING_LABEL);
  value = stripField(value, COST_LABEL);
  value = stripField(value, STOCK_LABEL, COUNT_UNIT);
  value = stripField(value, BARCODE_LABEL);
  value = stripExplicitPhrases(value);
  if (stripPrice !== null && stripPrice !== undefined) {
    value = stripAmountValue(value, stripPrice);
  }
  value = stripPrefixes(value);
  value = value.replace(TRAILING_LOGIC_RE, ' ');
  value = value.replace(TRAILING_ASK_RE, ' ');
  value = value.replace(TRAILING_RANGE_RE, ' ');
  value = value.replace(TRAILING_RANGE_START_RE, ' ');
  value = stripTrailingFiller(value);
  value = value.replace(TRAILING_FILLER_RE, '').trim();
  value = value.replace(CURRENCY_WORD_RE, ' ');
  value = value.replace(/(?:^|\s)[،,;:]+(?=\s|$)/g, ' ');
  value = value.replace(PUNCT_EDGE_RE, '');
  value = value.replace(/\s+/g, ' ').trim();
  if (!value || isFillerName(value)) return '';
  if (looksNumericOnly(value)) return '';
  if (/^\d+(?:[.,]\d+)?$/.test(value)) return '';
  if (IMPERATIVE_NAME_RE.test(value)) return '';
  if (/^(?:منتج|صنف|برودكت|product|item|جديد|جديدة|جديده|new|تاني|تانية|آخر|اخر|another|next)$/iu.test(value)) {
    return '';
  }
  if (/^(?:حاجة|حاجه|شيء|شي|أي\s+حاجة|اي\s+حاجة|something|anything)$/iu.test(value)) {
    return '';
  }
  return value.slice(0, MAX_NAME_CHARS);
}

function looksLikeCategoryAnswer(source, draft) {
  const text = String(source || '').trim();
  if (!text || text.length > 60) return false;
  if (ACK_RE.test(text) || REJECT_RE.test(text) || CHOOSE_FOR_ME_RE.test(text)) return false;
  if (NOT_IMPORTANT_ANY_RE.test(text) || UNSURE_ANY_RE.test(text)) return false;
  if (isFillerName(text)) return false;
  if (extractCategory(text)) return false;
  if (extractField(text, SELLING_LABEL) !== null) return false;
  if (extractField(text, COST_LABEL) !== null) return false;
  if (extractField(text, STOCK_LABEL) !== null) return false;
  if (/[?؟]/.test(text)) return false;
  if (/(?:أضيف|اضيف|أضف|اضف|ضيف|add|create|new\s+product|منتج|product|item)/iu.test(text)) return false;
  if (!/[\p{L}]/u.test(text)) return false;
  if (/\d/.test(text)) return false;
  const candidates = Array.isArray(draft && draft.categoryCandidates) ? draft.categoryCandidates : [];
  if (candidates.length) {
    const wanted = normalizeName(text);
    return candidates.some((candidate) =>
      normalizeName(candidate && candidate.name) === wanted ||
      scoreNameMatch(text, candidate && candidate.name) >= 0.7);
  }
  return true;
}

function missingProductFields(draft) {
  const missing = [];
  if (!draft || !draft.name) missing.push('name');
  for (const key of REQUIRED_FIELDS) {
    const value = draft && draft[FIELD_PROPERTY[key]];
    if (value === undefined || value === null || value === '') missing.push(key);
  }
  return missing;
}

const CREATE_INTENT_RE = /(?:^|[\s،,])(?:أضيف|اضيف|أضف|اضف|ضيف|ضيفي|ضيفلي|ضيفلى|أضفلي|اضفلي|ضيفها|ضيفه|ضيفهم|ضيفهما|أضفها|اضفها|أضفه|اضفه|أضيفها|اضيفها|أضيفه|اضيفه|إضافة|اضافة|إنشاء|انشاء|أنشئ|انشئ|سجل|اعمل|add|create|new\s+product|new\s+item|منتج\s+جديد|صنف\s+جديد)(?:[\s،,.:]|$)/iu;
/* Only a create verb aimed at a category makes the request a category
   request. A location phrase ("add it in the lighting section") must not stop
   the product parser from seeing the product. */
const CATEGORY_CREATE_OBJECT_RE = /(?:^|[\s،,])(?:أنشئ|انشئ|إنشاء|انشاء|اعمل|أضف|اضف|create|add)\s+(?:فئة|قسم|تصنيف|category)(?:[\s،,.:]|$)/iu;
const NON_PRODUCT_CREATE_RE = /(?:^|[\s،,])(?:عميل|customer|فاتورة|invoice|مورد|supplier|مصروف|expense|موظف|employee|فرع|branch|مستخدم|user)(?:[\s،,.:]|$)/iu;
const PRODUCT_WORD_ANY_RE = /(?:^|[\s،,])(?:منتاجات|منتاج|منتج|منتجات|صنف|أصناف|اصناف|برودكت|بضاعة|product|products|item|items)(?:[\s،,.:]|$)/iu;
const COMPLEX_CREATE_RE = /(?:وكمان|وأيضاً|و\s*كذلك|also|and\s+also|then|بعدين)\s+(?:أضيف|اضيف|أضف|اضف|ضيف|add|create|عدل|عدّل|غير|غيّر|احذف|امسح|edit|update|delete|remove)/iu;
const OTHER_ACTION_RE = /(?:^|[\s،,])(?:عدل|عدّل|غير|غيّر|احذف|امسح|edit|update|delete|remove)(?:[\s،,.:]|$)/iu;

function isCreateIntent(message) {
  return CREATE_INTENT_RE.test(String(message || ''));
}

function isProductCreateRequest(message, { pending = null } = {}) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (pending && pending.kind === 'create_product') return true;
  if (isHowToQuestion(text)) return false;
  if (CATEGORY_CREATE_OBJECT_RE.test(text)) return false;
  if (NON_PRODUCT_CREATE_RE.test(text) && !PRODUCT_WORD_ANY_RE.test(text)) return false;
  return isCreateIntent(text);
}

function isComplexCreate(message) {
  const text = String(message || '');
  const createMatches = text.match(new RegExp(CREATE_INTENT_RE.source, 'giu')) || [];
  if (createMatches.length > 1) return true;
  if (createMatches.length && COMPLEX_CREATE_RE.test(text)) return true;
  if (createMatches.length && OTHER_ACTION_RE.test(text)) return true;
  return false;
}

function missingLabels(missing, arabic) {
  return missing.map((key) => {
    const labels = FIELD_LABELS[key];
    return labels ? labels[arabic ? 'ar' : 'en'] : key;
  });
}

function productDraftNote(draft) {
  const parts = [];
  if (draft && draft.name) parts.push(`name=${draft.name}`);
  if (draft && draft.sellingPrice !== undefined) parts.push(`selling_price=${draft.sellingPrice}`);
  if (draft && draft.costPrice !== undefined) parts.push(`cost_price=${draft.costPrice}`);
  if (draft && draft.openingStock !== undefined) parts.push(`opening_stock=${draft.openingStock}`);
  if (draft && draft.costTotal !== undefined) {
    parts.push(`cost_total=${draft.costTotal}${draft.costDerived ? ' (derived)' : ''}`);
  }
  if (draft && draft.sellingTotal !== undefined) {
    parts.push(`selling_total=${draft.sellingTotal}${draft.sellingDerived ? ' (derived)' : ''}`);
  }
  if (draft && draft.unitsPerPack !== undefined) parts.push(`units_per_pack=${draft.unitsPerPack}`);
  if (draft && draft.packCount !== undefined) parts.push(`pack_count=${draft.packCount}`);
  if (draft && draft.categoryName) {
    parts.push(`category=${draft.categoryName}${draft.categoryCreate ? ' (create)' : ''}`);
  } else if (draft && draft.categoryChoice === 'uncategorized') {
    parts.push('category=(none)');
  }
  if (draft && draft.conflicts && Object.keys(draft.conflicts).length) {
    const conflicts = Object.entries(draft.conflicts)
      .map(([key, values]) => `${key}:${values.join('|')}`)
      .join(',');
    parts.push(`conflicts=${conflicts}`);
  }
  if (draft && Array.isArray(draft.unlabeledAmounts) && draft.unlabeledAmounts.length) {
    parts.push(`unlabeled_amounts=${draft.unlabeledAmounts.join('|')}`);
  }
  const missing = missingProductFields(draft);
  if (missing.length) parts.push(`missing=${missing.join(',')}`);
  return parts.join('; ').slice(0, 500);
}

function parseProductDraft(message, previous = null, { pending = null } = {}) {
  const folded = foldDigits(String(message || ''));
  /* A fresh request resolves its own self-corrections. A follow-up turn is an
     answer to the open draft: its values are extracted directly and anything
     still unclaimed is refused below, so a stale draft value can never be
     reported as the user's latest word. */
  const resolved = previous
    ? { text: folded, corrections: [], unresolved: false }
    : resolveCorrections(folded);
  const source = resolved.text;
  const draft = previous && typeof previous === 'object' ? { ...previous } : {};
  draft.kind = 'create_product';
  if (resolved.corrections.length) draft.corrections = resolved.corrections;
  else delete draft.corrections;

  const sellingValues = extractFieldValues(source, SELLING_LABEL);
  const costValues = extractFieldValues(source, COST_LABEL);
  const stockValues = extractFieldValues(source, STOCK_LABEL);
  const conflicts = {};
  if (sellingValues.length > 1) conflicts.selling_price = sellingValues;
  if (costValues.length > 1) conflicts.cost_price = costValues;
  if (stockValues.length > 1) conflicts.opening_stock = stockValues;
  if (Object.keys(conflicts).length) {
    draft.conflicts = { ...(draft.conflicts || {}), ...conflicts };
  }
  if (sellingValues.length === 1) {
    draft.sellingPrice = sellingValues[0];
    delete draft.sellingTotal;
    delete draft.sellingDerived;
  }
  if (costValues.length === 1) {
    draft.costPrice = costValues[0];
    delete draft.costTotal;
    delete draft.costDerived;
    delete draft.costTotalAmbiguous;
  }
  if (stockValues.length === 1) draft.openingStock = stockValues[0];

  /* The barcode the user typed is a value, not a name word: record it so
     the conservation check can claim its digits and the plan can carry it.
     Plain digits only — a [\d.,] class would swallow an adjacent price
     ("باركود 6291041500012345,3000") into one silent run. */
  const barcodeMatch = source.match(
    new RegExp(String.raw`(?:^|[\s،,])${CONNECTOR}(?:${BARCODE_LABEL})${SEP}(\d{6,})(?!\d)`, 'iu'),
  );
  if (barcodeMatch) draft.barcode = barcodeMatch[1];

  /* Explicit, common answers that would otherwise look like a missing value.
     These are the user's own words, not a guessed default. */
  if (SAME_PRICE_RE.test(source) && costValues.length === 0 &&
      draft.sellingPrice !== undefined) {
    draft.costPrice = draft.sellingPrice;
  }
  if (NO_STOCK_RE.test(source) && stockValues.length === 0) {
    draft.openingStock = 0;
  }
  if (FREE_RE.test(source) && sellingValues.length === 0) {
    draft.sellingPrice = 0;
  }

  /* A stock-in sentence carries the values as a story, not as labels:
     "a carton of 20 cost 600, sell each for 45". Parse the pack size, the
     total cost and the per-unit price, then derive the unit cost. The
     arithmetic is kept on the draft so the preview and the model can see it. */
  const narrative = parseNarrativeCommerce(source);
  if (narrative) {
    draft.narrative = true;
    if (narrative.pack && narrative.pack.units !== null &&
        stockValues.length === 0) {
      draft.openingStock = narrative.pack.units;
      draft.stockFromPack = true;
      if (narrative.pack.packCount) draft.packCount = narrative.pack.packCount;
      if (narrative.pack.unitsPerPack) draft.unitsPerPack = narrative.pack.unitsPerPack;
    }
    const units = Number(draft.openingStock);
    if (narrative.totalCost && costValues.length === 0) {
      draft.costTotal = narrative.totalCost.total;
      if (Number.isFinite(units) && units > 0) {
        const allPacks = /(?:الإجمالي|الاجمالي|كلها|كله|total|الفاتورة|invoice)/iu
          .test(narrative.totalCost.phrase);
        if (narrative.pack && narrative.pack.packCount > 1 && !allPacks) {
          /* "3 cartons, the carton is 600" can mean 600 each or 600 for all.
             Do not guess; the model asks which one. */
          draft.costTotalAmbiguous = true;
        } else {
          draft.costPrice = roundMoney(narrative.totalCost.total / units);
          draft.costDerived = true;
        }
      }
    }
    if (narrative.looseCost && costValues.length === 0 &&
        draft.costPrice === undefined) {
      if (Number.isFinite(units) && units > 1) {
        draft.costTotal = narrative.looseCost.amount;
        draft.costPrice = roundMoney(narrative.looseCost.amount / units);
        draft.costDerived = true;
      } else {
        draft.costPrice = narrative.looseCost.amount;
      }
    }
    if (narrative.selling && sellingValues.length === 0 &&
        draft.sellingPrice === undefined) {
      if (narrative.selling.unit !== undefined) {
        draft.sellingPrice = narrative.selling.unit;
      } else if (narrative.selling.total !== undefined) {
        draft.sellingTotal = narrative.selling.total;
        if (Number.isFinite(units) && units > 0) {
          draft.sellingPrice = roundMoney(narrative.selling.total / units);
          draft.sellingDerived = true;
        }
      }
    }
  }

  /* A total that was already recorded stays the source of truth when a later
     answer supplies the pack size. An explicit unit value clears it above. */
  if (draft.costTotal !== undefined && draft.costDerived &&
      Number(draft.openingStock) > 0) {
    draft.costPrice = roundMoney(draft.costTotal / Number(draft.openingStock));
  }
  if (draft.sellingTotal !== undefined && draft.sellingDerived &&
      Number(draft.openingStock) > 0) {
    draft.sellingPrice = roundMoney(draft.sellingTotal / Number(draft.openingStock));
  }

  /* "for 15000", "at 15000" and "ب 15000" are weak labels. Accept one when
     another amount field or a currency makes the meaning clear, or when the
     amount is large enough to be money rather than a model number. This keeps
     "case for iPhone 15" a name while "iPhone 15 بـ 50000" gets its price. */
  let priceFromConnector = null;
  if (sellingValues.length === 0 && draft.sellingPrice === undefined) {
    const connectorPrice = extractForPrice(source);
    const connectorCurrency = /(?:for|at|بـ|ب)\s*\d[\d.,]*\s*(?:جنيه|جنية|جنيها|ج\.م|egp|le|ريال|درهم|دينار|\$|£|€)/iu.test(source);
    const arabicConnector = /(?:^|[\s،,])(?:بـ|ب)\s*\d[\d.,]*/iu.test(source);
    const strongConnector = costValues.length === 1 || stockValues.length === 1 ||
      QUOTED_NAME_RE.test(source) || connectorCurrency || arabicConnector ||
      (connectorPrice !== null && connectorPrice >= 1000);
    if (strongConnector && connectorPrice !== null) {
      priceFromConnector = connectorPrice;
      draft.sellingPrice = connectorPrice;
    }
  }

  /* One bare amount beside a labeled cost or stock is the price
     ("Samsung TV 50000, cost 12000"). Two bare amounts are ambiguous
     ("iPhone 15 50000"), so the model decides instead of a guess. */
  let priceFromUnlabeled = null;
  if (draft.sellingPrice === undefined &&
      (costValues.length === 1 || stockValues.length === 1)) {
    const withoutFields = stripSizeClauses(stripField(
      stripField(stripField(stripCategoryClauses(source), SELLING_LABEL), COST_LABEL),
      STOCK_LABEL,
    ));
    const amounts = [...new Set(extractBareAmounts(withoutFields))];
    if (amounts.length === 1 && extractName(source)) {
      draft.sellingPrice = amounts[0];
      priceFromUnlabeled = amounts[0];
    } else if (amounts.length > 1) {
      draft.unlabeledAmounts = amounts;
      draft.priceAmbiguous = true;
    }
  }

  /* A numeric-only answer to a missing-values question maps in the order the
     question asked: selling price, cost, stock. It never maps when the count
     is different, because a partial list would put values in the wrong field. */
  if (previous && previous.name && draft.sellingPrice === undefined) {
    const values = extractAmounts(source);
    const missingValues = missingProductFields(draft).filter((key) => key !== 'name');
    if (looksNumericOnly(source) && values.length === missingValues.length && values.length > 0) {
      missingValues.forEach((key, index) => {
        draft[FIELD_PROPERTY[key]] = values[index];
      });
      draft.positional = true;
    }
  }

  const trimmed = source.trim();
  let skipName = false;
  let followupNameConflict = false;
  /* A short "not important" or "I don't know" after a category question is an
     answer about the category, not a category name. Leaving it uncategorized
     is reversible; trapping the user in the same question is not. */
  const categorySkip = !!(pending && pending.categoryAsked &&
    (NOT_IMPORTANT_ANY_RE.test(trimmed) || UNSURE_ANY_RE.test(trimmed)));
  if (categorySkip) {
    draft.categoryChoice = 'uncategorized';
    draft.categoryName = '';
    draft.categoryId = '';
    draft.categoryCreate = false;
    draft.suggestedCategory = null;
    draft.categoryCandidates = [];
    draft.categoryAsked = false;
    skipName = true;
  }

  /* A typed picture answer settles the image slot; it is not a product
     name. Only an existing name is protected, and only when every word is
     picture vocabulary with at least one picture noun. */
  if (previous && previous.name && isImageAnswerPhrase(source)) {
    skipName = true;
  }

  const category = categorySkip ? null : extractCategory(source);
  if (category) {
    if (category.choice === 'same') {
      /* "same category" is a reference to the shelf this conversation is
         already working in, not a category named "same". */
      draft.categoryChoice = 'same';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
      draft.categoryCandidates = [];
      draft.categoryAsked = false;
    } else if (category.choice === 'uncategorized') {
      draft.categoryChoice = 'uncategorized';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
      draft.categoryCandidates = [];
      draft.categoryAsked = false;
    } else if (category.choice === 'other') {
      draft.categoryChoice = 'other';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
      draft.categoryAsked = true;
    } else if (category.choice === 'create') {
      draft.categoryChoice = 'create';
      draft.categoryCreate = true;
      draft.categoryName = category.name || '';
      draft.categoryId = '';
      draft.suggestedCategory = null;
      draft.categoryAsked = !category.name;
    } else {
      draft.categoryChoice = 'named';
      draft.categoryCreate = false;
      draft.categoryName = category.name || '';
      draft.categoryId = '';
      draft.suggestedCategory = null;
      draft.categoryAsked = false;
    }
  }

  const acknowledgement = ACK_RE.test(trimmed);
  const rejection = REJECT_RE.test(trimmed);
  const chooseForMe = CHOOSE_FOR_ME_RE.test(trimmed);
  if (acknowledgement && draft.suggestedCategory && !draft.categoryName) {
    draft.categoryChoice = 'accepted';
    draft.categoryName = draft.suggestedCategory.name;
    draft.categoryId = draft.suggestedCategory.id;
    draft.categoryCreate = false;
    draft.suggestedCategory = null;
  } else if (acknowledgement && !draft.categoryName &&
             Array.isArray(draft.categoryCandidates) && draft.categoryCandidates.length) {
    /* "تمام" after a list of suggestions means the first one, not silence. */
    const top = draft.categoryCandidates[0];
    draft.categoryChoice = 'accepted';
    draft.categoryName = top.name;
    draft.categoryId = top.id;
    draft.categoryCreate = false;
    draft.suggestedCategory = null;
  }
  if (rejection && draft.suggestedCategory) {
    draft.categoryChoice = 'rejected';
    draft.suggestedCategory = null;
    draft.categoryCandidates = [];
    draft.categoryAsked = true;
  }
  if (chooseForMe) {
    if (Array.isArray(draft.categoryCandidates) && draft.categoryCandidates.length) {
      const top = draft.categoryCandidates[0];
      draft.categoryChoice = 'accepted';
      draft.categoryName = top.name;
      draft.categoryId = top.id;
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
    } else if (draft.suggestedCategory) {
      draft.categoryChoice = 'accepted';
      draft.categoryName = draft.suggestedCategory.name;
      draft.categoryId = draft.suggestedCategory.id;
      draft.categoryCreate = false;
      draft.suggestedCategory = null;
    } else if (draft.suggestedName) {
      /* The user asked us to choose; creating the named suggestion is still a
         preview step, so the confirmation stays explicit. */
      draft.categoryChoice = 'create';
      draft.categoryName = draft.suggestedName;
      draft.categoryCreate = true;
      draft.categoryAsked = false;
    } else {
      draft.categoryChoice = 'uncategorized';
      draft.categoryName = '';
      draft.categoryId = '';
      draft.categoryCreate = false;
      draft.categoryAsked = false;
    }
  }

  if (!category && pending && pending.categoryAsked &&
      looksLikeCategoryAnswer(source, draft)) {
    draft.categoryChoice = 'named';
    draft.categoryName = cleanCategoryName(source);
    draft.categoryId = '';
    draft.categoryCreate = false;
    draft.suggestedCategory = null;
    draft.categoryAsked = false;
    skipName = true;
  }

  /* A follow-up turn answers the open draft; it does not rename it. The
     sentence the page sends with an image ("استخدم الصورة المرفقة.") is a
     whole imperative phrase, so extractName takes it for the product and the
     recorded name is silently replaced - which is why the assistant asked for
     the name a second time after attaching a picture. A recorded name still
     changes when the message really is about the name: a create request, an
     explicit "الاسم …", or a quoted name.
     Fail closed: if the follow-up still yields a real name that differs from
     the recorded one ("خليه Samsung"), a rename must not vanish silently.
     Keep the recorded name and veto followup_text_unclaimed so the raw
     sentence reaches the model, which can perform the rename. Normal value
     follow-ups and ACKs yield no name here and stay local; picture phrases
     are handled by the vocabulary gate above. */
  if (previous && previous.name && !isCreateIntent(source) &&
      !CALLED_RE.test(String(source || '').trim()) && !QUOTED_NAME_RE.test(source)) {
    /* An earlier gate already claimed this message — a category answer
       ("موبايلات"), a category skip ("مش مهم") or a picture phrase. Those are
       not names, so the conflict check must not run: extractName would return
       the answer itself, differ from the recorded name and veto every category
       reply to the model. */
    if (!skipName) {
      const stripPriceFollowup = priceFromConnector ?? priceFromUnlabeled ?? null;
      let followupName = narrative && narrative.pack ? narrative.pack.productPhrase : '';
      if (!followupName) followupName = extractName(source, { stripPrice: stripPriceFollowup, narrative });
      if (followupName && !isImageAnswerPhrase(followupName) &&
          normalizeName(followupName) !== normalizeName(previous.name)) {
        followupNameConflict = true;
      }
    }
    skipName = true;
  }

  if (!skipName) {
    const stripPrice = priceFromConnector ?? priceFromUnlabeled ?? null;
    /* The noun after the pack count is the product phrase. It is much more
       reliable than cleaning the whole story sentence. */
    let name = narrative && narrative.pack ? narrative.pack.productPhrase : '';
    if (!name) {
      name = extractName(source, { stripPrice, narrative });
    }
    if (name) draft.name = correctCommonSpelling(name);
  }

  if (draft.duplicate) {
    if (UPDATE_DUPLICATE_RE.test(source)) {
      draft.duplicateAction = 'update';
    } else if (CANCEL_RE.test(source)) {
      draft.duplicateAction = 'cancel';
    } else if (NEW_PRODUCT_RE.test(source)) {
      draft.duplicateAction = 'new';
      draft.allowDuplicate = true;
      /* An exact duplicate needs a different name. A close spelling is already
         different, so keep the name the user just typed. */
      if (!draft.duplicate.near) draft.name = '';
      draft.duplicate = null;
    }
  }

  const issues = [];
  if (Object.keys(draft.conflicts || {}).length) issues.push('field_conflict');
  if (draft.priceAmbiguous) issues.push('price_ambiguous');
  if (draft.costTotalAmbiguous) issues.push('cost_total_ambiguous');
  if (draft.name) {
    if (/(?:سعر|تكلفة|كمية|مخزون|price|cost|stock|quantity|فئة|قسم|category)/iu.test(draft.name)) {
      issues.push('name_contains_field');
    }
    if (draft.narrative && looksLikeNarrativeName(draft.name)) {
      issues.push('name_uncertain');
    }
    if (/[?؟]/.test(draft.name)) issues.push('name_is_question');
    if (draft.name.length > 120) issues.push('name_too_long');
  }
  draft.issues = issues;
  draft.confidence = issues.length ? 'low' : 'high';

  /* The vetoes are structural refusals the local checker is sure about: a
     fully accounted parse produces a plan, anything else reaches the model
     with the raw sentence (the flow's unverified_parse gate reads this).
     Computed only while the issues list is empty so the existing issue
     reasons never drift into unverified_parse. */
  const vetoes = [];
  if (!issues.length) {
    if (resolved.unresolved) vetoes.push('unresolved_correction');
    /* A follow-up that really names something else: the recorded name was
       kept, and the sentence is the model's to act on. */
    if (followupNameConflict) vetoes.push('followup_text_unclaimed');
    if (draft.name) {
      if (/(?:\.{2,}|…)/.test(draft.name)) vetoes.push('name_has_ellipsis');
      if (CORRECTION_NAME_RE.test(draft.name)) vetoes.push('name_has_correction');
      /* A bare 4-6 digit run in a name reads as money the name swallowed;
         256 storage and "iPhone 15" are not money-shaped. */
      if (MONEY_SHAPE_RE.test(draft.name)) vetoes.push('name_has_money_number');
      const nameNumbers = extractAmounts(draft.name);
      const tokens = draft.name.split(/\s+/).filter(Boolean);
      if (tokens.length > 10 ||
          (tokens.length > 7 && (nameNumbers.length > 0 || /\.{2,}|…/.test(draft.name)))) {
        vetoes.push('name_too_many_tokens');
      }
    }
    /* Conservation: nothing in the sentence may be left unclaimed once the
       name's own numbers, the barcode/SKU digits and a quoted name are
       accounted for. Skipped when a correction is already unresolved — the
       model reads that sentence either way. */
    if (!resolved.unresolved) {
      for (const item of unclaimedNumbers(source, draft)) vetoes.push(item);
    }
  }
  if (vetoes.length) draft.vetoes = vetoes;
  else delete draft.vetoes;

  draft.awaitingValues = missingProductFields(draft).length > 0;
  /* "I don't know" and "not important" are answers, but they are not values.
     The local flow hands these to the model so it can explain the trade-off
     instead of repeating the same question. A category-only "not important"
     was already resolved above and leaves no required field missing. */
  if (draft.awaitingValues &&
      (UNSURE_ANY_RE.test(trimmed) || NOT_IMPORTANT_ANY_RE.test(trimmed))) {
    draft.unsure = true;
  } else {
    delete draft.unsure;
  }
  return draft;
}

function buildDuplicateQuestion(item, arabic = true) {
  const name = String((item && item.name) || '').trim().slice(0, 120);
  const values = [];
  if (Number.isFinite(Number(item && item.sellingPrice))) {
    values.push(`${arabic ? 'السعر' : 'price'} ${item.sellingPrice}`);
  }
  if (Number.isFinite(Number(item && item.costPrice))) {
    values.push(`${arabic ? 'التكلفة' : 'cost'} ${item.costPrice}`);
  }
  if (Number.isFinite(Number(item && item.stock))) {
    values.push(`${arabic ? 'المخزون' : 'stock'} ${item.stock}`);
  }
  const detail = values.length ? ` (${values.join(arabic ? '، ' : ', ')})` : '';
  const near = !!(item && item.near);
  if (arabic) {
    return {
      question: near
        ? `لقيت منتج قريب من الاسم اللي كتبته: «${name}»${detail}. هو هو ولا منتج جديد؟`
        : `المنتج «${name}» موجود بالفعل${detail}. تحب تعدله ولا تضيف منتج جديد؟`,
      options: [
        { label: 'تعديل السعر', value: 'تعديل السعر' },
        { label: 'تعديل التكلفة', value: 'تعديل التكلفة' },
        { label: 'تعديل المخزون', value: 'تعديل المخزون' },
        { label: 'منتج جديد', value: 'منتج جديد' },
      ],
      pending: `${near ? 'منتج قريب' : 'المنتج الموجود'}: ${name}${detail}`,
      missing: [],
    };
  }
  return {
    question: near
      ? `I found a product with a close name: "${name}"${detail}. Is it the same one, or a new product?`
      : `The product "${name}" already exists${detail}. Do you want to edit it or add a new product?`,
    options: [
      { label: 'Edit price', value: 'Edit price' },
      { label: 'Edit cost', value: 'Edit cost' },
      { label: 'Edit stock', value: 'Edit stock' },
      { label: 'New product', value: 'New product' },
    ],
    pending: `${near ? 'Close product' : 'Existing product'}: ${name}${detail}`,
    missing: [],
  };
}

function buildNameQuestion(draft, arabic = true) {
  return {
    question: arabic ? 'تمام، اسم المنتج إيه؟' : 'What is the product name?',
    options: [],
    missing: ['name'],
    pending: productDraftNote(draft),
  };
}

function buildProductQuestion(draft, {
  candidates = [],
  duplicate = null,
  arabic = true,
  suggestedName = '',
  categoryMissingName = '',
} = {}) {
  if (duplicate) return buildDuplicateQuestion(duplicate, arabic);
  const missing = missingProductFields(draft);
  const name = draft && draft.name ? draft.name : '';
  const parts = [];
  const options = [];
  let categoryQuestion = '';

  if (categoryMissingName) {
    categoryQuestion = arabic
      ? `فئة «${categoryMissingName}» مش موجودة. تحب أنشئها ولا أضيفه بدون تصنيف؟`
      : `The category "${categoryMissingName}" does not exist. Should I create it or leave the product uncategorized?`;
    options.push({
      label: arabic ? `أنشئ فئة ${categoryMissingName}` : `Create ${categoryMissingName}`,
      value: arabic ? `أنشئ فئة ${categoryMissingName}` : `create category ${categoryMissingName}`,
    });
    options.push({
      label: arabic ? 'بدون تصنيف' : 'No category',
      value: arabic ? 'بدون تصنيف' : 'no category',
    });
    options.push({
      label: arabic ? 'فئة أخرى' : 'Another category',
      value: arabic ? 'فئة أخرى' : 'another category',
    });
  } else if (draft.categoryChoice === 'create' && !draft.categoryName) {
    categoryQuestion = arabic
      ? 'اسم الفئة الجديدة إيه؟'
      : 'What should the new category be called?';
  } else if (draft.categoryChoice === 'other') {
    categoryQuestion = arabic
      ? 'اسم الفئة اللي تحب تضيفه فيها إيه؟'
      : 'Which category should it go in?';
  } else if (draft.categoryChoice !== 'uncategorized' &&
             draft.categoryChoice !== 'accepted' &&
             draft.categoryChoice !== 'create' &&
             !draft.categoryName) {
    if (candidates.length === 1) {
      categoryQuestion = arabic
        ? `لقيت فئة «${candidates[0].name}» مناسبة${name ? ` لـ «${name}»` : ''}. أضيفه فيها؟`
        : `I found a matching category, "${candidates[0].name}"${name ? ` for "${name}"` : ''}. Add it there?`;
    } else if (candidates.length > 1) {
      const names = candidates.slice(0, 2).map((candidate) => `«${candidate.name}»`).join(arabic ? '، ' : ', ');
      categoryQuestion = arabic
        ? `في أكتر من فئة قريبة: ${names}. أنهي واحدة؟`
        : `A few categories are close: ${names}. Which one?`;
    } else {
      categoryQuestion = arabic
        ? `مش لاقي فئة مناسبة${name ? ` لـ «${name}»` : ''}. تحب أنشئ فئة${suggestedName ? ` «${suggestedName}»` : ' جديدة'} ولا أضيفه بدون تصنيف؟`
        : `I could not find a suitable category${name ? ` for "${name}"` : ''}. Should I create ${suggestedName ? `"${suggestedName}"` : 'a new category'} or leave it uncategorized?`;
    }
  }

  if (categoryQuestion) {
    parts.push(categoryQuestion);
    if (candidates.length) {
      for (const candidate of candidates.slice(0, 2)) {
        options.push({
          label: arabic ? `فئة ${candidate.name}` : `Category ${candidate.name}`,
          value: arabic ? `فئة ${candidate.name}` : `category ${candidate.name}`,
        });
      }
      options.push({
        label: arabic ? 'فئة أخرى' : 'Another category',
        value: arabic ? 'فئة أخرى' : 'another category',
      });
      options.push({
        label: arabic ? 'بدون تصنيف' : 'No category',
        value: arabic ? 'بدون تصنيف' : 'no category',
      });
    } else if (draft.categoryChoice !== 'create' && !categoryMissingName) {
      options.push({
        label: arabic ? 'أنشئ فئة جديدة' : 'Create a new category',
        value: arabic ? 'أنشئ فئة جديدة' : 'create a new category',
      });
      options.push({
        label: arabic ? 'بدون تصنيف' : 'No category',
        value: arabic ? 'بدون تصنيف' : 'no category',
      });
    }
  }

  if (missing.length) {
    const labels = missingLabels(missing, arabic);
    if (missing.includes('name')) {
      parts.push(arabic ? 'اسم المنتج إيه؟' : 'What is the product name?');
      const rest = missing.filter((key) => key !== 'name');
      if (rest.length) {
        parts.push(arabic
          ? `ومحتاج كمان: ${missingLabels(rest, true).join('، ')}.`
          : `I also need: ${missingLabels(rest, false).join(', ')}.`);
      }
    } else {
      parts.push(arabic
        ? `${categoryQuestion ? 'ومحتاج كمان' : 'محتاج'}: ${labels.join('، ')}.`
        : `${categoryQuestion ? 'I also need' : 'I need'}: ${labels.join(', ')}.`);
    }
  }

  return {
    question: parts.join(' ').slice(0, MAX_QUESTION_CHARS),
    options: options.slice(0, 4),
    missing,
    pending: productDraftNote(draft),
  };
}

/* The images this draft is allowed to carry into a plan. Only an explicit
   `attached` status produces a list: a question that was never answered, or
   one the operator declined, stays empty, so a plan never carries a picture
   nobody chose. The first image is the cover. */
function draftImages(draft) {
  const image = draft && draft.image;
  if (!image || image.status !== 'attached') return [];
  const ids = Array.isArray(image.attachmentIds) ? image.attachmentIds : [];
  return ids
    .map((id) => (typeof id === 'string' ? id.trim().slice(0, 80) : ''))
    .filter(Boolean)
    .slice(0, 8)
    .map((attachmentId, index) => ({ attachmentId, cover: index === 0 }));
}

function buildProductPlanInput(draft, {
  images = [],
  category = null,
  arabic = true,
} = {}) {
  if (!draft || !draft.name) return null;
  if (missingProductFields(draft).length) return null;
  const steps = [];
  if (category && category.create && category.name) {
    steps.push({
      id: 'cat1',
      action: 'create_category',
      fields: { name: category.name },
    });
  }
  const fields = {
    name: draft.name,
    selling_price: draft.sellingPrice,
    cost_price: draft.costPrice,
    opening_stock: draft.openingStock,
    category_id: category && category.create
      ? { step: 'cat1', field: 'id' }
      : (category && category.id) || '',
    category_name: category && category.create
      ? { step: 'cat1', field: 'name' }
      : (category && category.name) || '',
    barcode: draft.barcode || '',
    sku: draft.sku || '',
    description: draft.description || '',
  };
  const step = { id: 'p1', action: 'create_product', fields };
  if (images.length) step.images = images;
  steps.push(step);
  const title = arabic ? `إنشاء منتج ${draft.name}` : `Create product ${draft.name}`;
  /* Show the arithmetic when the unit cost came from a pack total, so the
     preview never looks like the assistant guessed 30 from a 600 carton. */
  const costNote = draft.costDerived && draft.costTotal !== undefined
    ? (arabic
      ? ` (${draft.costTotal} ÷ ${draft.openingStock})`
      : ` (${draft.costTotal} / ${draft.openingStock})`)
    : '';
  const sellingNote = draft.sellingDerived && draft.sellingTotal !== undefined
    ? (arabic
      ? ` (${draft.sellingTotal} ÷ ${draft.openingStock})`
      : ` (${draft.sellingTotal} / ${draft.openingStock})`)
    : '';
  /* The user corrected a value mid-sentence; the preview states both sides
     so "3000 -> 3200" is visible before anything is written. */
  const correctionKeys = {
    sellingPrice: 'selling_price',
    costPrice: 'cost_price',
    openingStock: 'opening_stock',
  };
  let correctionNote = '';
  if (Array.isArray(draft.corrections) && draft.corrections.length) {
    const parts = draft.corrections.map((item) => {
      const key = correctionKeys[item.field];
      const label = key
        ? FIELD_LABELS[key][arabic ? 'ar' : 'en']
        : (arabic ? 'قيمة' : 'value');
      return `${label} ${item.to} ${arabic ? 'بدل' : 'instead of'} ${item.from}`;
    });
    correctionNote = arabic
      ? `، وتعديل: ${parts.join('، ')}`
      : `, corrected: ${parts.join(', ')}`;
  }
  const summary = arabic
    ? `إضافة «${draft.name}» بسعر بيع ${draft.sellingPrice}${sellingNote}، وتكلفة ${draft.costPrice}${costNote}، وكمية ${draft.openingStock}${correctionNote}.`
    : `Add "${draft.name}" with selling price ${draft.sellingPrice}${sellingNote}, cost ${draft.costPrice}${costNote} and opening stock ${draft.openingStock}${correctionNote}.`;
  return { title, summary, steps };
}

module.exports = {
  ACK_RE,
  REQUIRED_FIELDS,
  buildDuplicateQuestion,
  buildNameQuestion,
  buildProductPlanInput,
  buildProductQuestion,
  cleanCategoryName,
  draftImages,
  extractCategory,
  extractField,
  extractFieldValues,
  extractForPrice,
  extractName,
  extractPackQuantity,
  parseNarrativeCommerce,
  isComplexCreate,
  isCreateIntent,
  isProductCreateRequest,
  looksLikeCategoryAnswer,
  looksLikeExtraAsk,
  looksLikeReasoningRequest,
  missingProductFields,
  parseAmount,
  parseProductDraft,
  productDraftNote,
  resolveCorrections,
  sentenceNumbers,
  SELLING_LABEL,
  COST_LABEL,
  STOCK_LABEL,
};
