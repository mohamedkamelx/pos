'use strict';

/*
 * Shared smart search for every Posnic search box.
 *
 * A cashier types what they remember: a product name with a letter swapped,
 * an Egyptian plural, a brand in Latin letters or an English word for an
 * Arabic product. The API item search, category lookup, sale-screen search
 * and the assistant's record lookup all need the same answer, so the rules
 * live here once instead of drifting between four copies.
 *
 * The module is deliberately dependency-free. It is used by the API runtime
 * and by the desktop assistant's plan validation, which is why it must not
 * import a model, a repository or anything that expects a request context.
 */

const MIN_QUERY_CHARS = 2;
const FUZZY_MIN_SCORE = 0.45;
const MAX_QUERY_FORMS = 48;
const MAX_QUERY_PHRASES = 12;
const MAX_CONTEXT_FORMS = 24;
const MAX_PHONETICS = 32;
const MAX_QUERY_NGRAMS = 96;

const ARABIC_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;

/* Arabic-Indic and Persian-Indic digits are the same number to a cashier.
   They are folded only for matching; stored text keeps what was written. */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function foldDigits(value) {
  return String(value == null ? '' : value).replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = ARABIC_DIGITS.indexOf(digit);
    if (arabic >= 0) return String(arabic);
    const persian = PERSIAN_DIGITS.indexOf(digit);
    return persian >= 0 ? String(persian) : digit;
  });
}

/* Kept identical to the item index's long-standing normalisation. The item
   search index, category fallback and assistant must fold the same letters,
   or a word is indexed one way and searched another. */
function normalizeSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeSearchText(value) {
  const text = normalizeSearchText(value);
  return text ? text.split(' ') : [];
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function ngramsForToken(token) {
  const chars = Array.from(String(token || ''));
  if (chars.length < 2) return [];
  if (chars.length === 2) return [String(token)];
  const grams = [];
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= chars.length - size; index += 1) {
      grams.push(chars.slice(index, index + size).join(''));
    }
  }
  return grams;
}

function editDistance(left, right) {
  const a = Array.from(String(left || ''));
  const b = Array.from(String(right || ''));
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function bigramSimilarity(left, right) {
  const a = Array.from(String(left || ''));
  const b = Array.from(String(right || ''));
  if (a.length < 2 || b.length < 2) return 0;

  const counts = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a[index] + a[index + 1];
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let hits = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b[index] + b[index + 1];
    const count = counts.get(gram) || 0;
    if (count) {
      hits += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

function trigramSimilarity(left, right) {
  const a = Array.from(String(left || ''));
  const b = Array.from(String(right || ''));
  if (a.length < 3 || b.length < 3) return 0;

  const counts = new Map();
  for (let index = 0; index < a.length - 2; index += 1) {
    const gram = a[index] + a[index + 1] + a[index + 2];
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let hits = 0;
  for (let index = 0; index < b.length - 2; index += 1) {
    const gram = b[index] + b[index + 1] + b[index + 2];
    const count = counts.get(gram) || 0;
    if (count) {
      hits += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 4);
}

function stripDefiniteArticle(text) {
  return String(text || '').replace(/^ال(?=.{2,})/, '');
}

/* Arabic plurals and the taa marbuta are spelling, not meaning. The stem is
   deliberately conservative: it removes only common endings, then the root
   key drops long vowels for the حذف/غسالة/غسالات family. Both forms are kept
   as candidates; the original word always scores highest. */
function stemToken(token) {
  let word = foldDigits(token).toLowerCase();
  if (!word) return '';
  if (word.length > 3 && word.startsWith('ال')) word = word.slice(2);

  if (/^[a-z0-9]+$/.test(word)) {
    if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith('ers')) return word.slice(0, -1);
    if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }

  if (word.length > 4) {
    for (const suffix of ['يات', 'ات', 'ين', 'ون', 'ها', 'هم', 'هما', 'كم', 'نا']) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        word = word.slice(0, -suffix.length);
        break;
      }
    }
  }
  /* The taa marbuta was normalised to haa. Drop it only when a real stem
     remains, so short words such as "وجه" keep their final letter. */
  if (word.length > 3 && word.endsWith('ه')) word = word.slice(0, -1);
  return word;
}

function rootKey(token) {
  const stem = stemToken(token);
  if (!stem || stem.length < 3) return stem;
  let root = stem.replace(/[اوي]/g, '');
  root = root.replace(/(.)\1+/g, '$1');
  return root.length >= 2 ? root : stem;
}

/* Arabic number words are how tills are told quantities on the shop floor. */
const NUMBER_WORDS = new Map([
  ['صفر', '0'],
  ['زيرو', '0'],
  ['zero', '0'],
  ['واحد', '1'],
  ['واحده', '1'],
  ['one', '1'],
  ['اتنين', '2'],
  ['اثنين', '2'],
  ['تنين', '2'],
  ['two', '2'],
  ['تلاته', '3'],
  ['ثلاثه', '3'],
  ['تلات', '3'],
  ['three', '3'],
  ['اربعه', '4'],
  ['four', '4'],
  ['خمسه', '5'],
  ['five', '5'],
  ['سته', '6'],
  ['six', '6'],
  ['سبعه', '7'],
  ['seven', '7'],
  ['تمانيه', '8'],
  ['ثمانيه', '8'],
  ['eight', '8'],
  ['تسعه', '9'],
  ['nine', '9'],
  ['عشره', '10'],
  ['ten', '10'],
  ['ميه', '100'],
  ['مية', '100'],
  ['مئه', '100'],
  ['hundred', '100'],
  ['الف', '1000'],
  ['thousand', '1000'],
  ['مليون', '1000000'],
  ['million', '1000000'],
]);

function canonicalNumberToken(token) {
  const word = normalizeSearchText(token);
  if (!word) return '';
  const folded = foldDigits(word);
  if (/^[0-9]+$/.test(folded)) return folded;
  return NUMBER_WORDS.get(folded) || '';
}

/* -------------------------------------------------------------------------
 * Curated synonyms and sound-alikes.
 *
 * This is intentionally a static list: it ships with the app, needs no shop
 * record, and has no sync decision. It covers the common retail vocabulary
 * and the Egyptian/English mix a cashier actually speaks. Add a group only
 * when every term means the same thing in this context; a wrong synonym is
 * worse than no synonym.
 * ---------------------------------------------------------------------- */
const SYNONYM_GROUPS = [
  ['بيبسي', 'ببسي', 'pepsi'],
  ['كولا', 'كوكاكولا', 'كوكا', 'cola', 'coke', 'coca cola'],
  ['مياه', 'ماء', 'water'],
  ['شاي', 'tea'],
  ['قهوه', 'coffee'],
  ['عصير', 'juice'],
  ['لبن', 'حليب', 'milk'],
  ['زبادي', 'يوغرت', 'yogurt', 'yoghurt'],
  ['جبن', 'جبنه', 'cheese'],
  ['زبده', 'butter'],
  ['بيض', 'eggs', 'egg'],
  ['فراخ', 'دجاج', 'chicken'],
  ['لحمه', 'لحم', 'لحوم', 'meat', 'beef'],
  ['سمك', 'اسماك', 'fish'],
  ['ارز', 'رز', 'rice'],
  ['مكرونه', 'معكرونه', 'pasta', 'macaroni'],
  ['دقيق', 'طحين', 'flour'],
  ['سكر', 'sugar'],
  ['ملح', 'salt'],
  ['زيت', 'oil'],
  ['خبز', 'عيش', 'bread'],
  ['توابل', 'بهارات', 'spices', 'spice'],
  ['شوكولاته', 'شكولاته', 'chocolate'],
  ['بسكويت', 'كوكيز', 'biscuit', 'cookies', 'cookie'],
  ['شيبسي', 'شيبس', 'chips'],
  ['مكسرات', 'nuts'],
  ['فاكهه', 'فواكه', 'fruit', 'fruits'],
  ['خضار', 'خضروات', 'vegetables', 'vegetable'],
  ['موز', 'banana', 'bananas'],
  ['تفاح', 'apple', 'apples'],
  ['برتقال', 'orange', 'oranges'],
  ['ليمون', 'lemon', 'lemons'],
  ['بطاطس', 'بطاطا', 'potato', 'potatoes'],
  ['طماطم', 'بندوره', 'tomato', 'tomatoes'],
  ['بصل', 'onion', 'onions'],
  ['ثوم', 'garlic'],
  ['جزر', 'carrot', 'carrots'],
  ['خيار', 'cucumber'],
  ['غساله', 'غسالات', 'غسلات', 'washing machine', 'washer', 'washing machines'],
  ['ثلاجه', 'تلاجه', 'ثلاجات', 'refrigerator', 'fridge', 'refrigerators'],
  ['تكييف', 'مكيف', 'تكييفات', 'air conditioner', 'air conditioning', 'ac'],
  ['تلفزيون', 'تليفزيون', 'تلفزيونات', 'tv', 'television'],
  ['موبايل', 'محمول', 'هاتف', 'تليفون', 'phone', 'mobile', 'cellphone'],
  ['لابتوب', 'كمبيوتر', 'computer', 'laptop'],
  ['مروحه', 'مراوح', 'fan', 'fans'],
  ['مكواه', 'iron'],
  ['خلاط', 'blender'],
  ['فرن', 'oven'],
  ['بوتاجاز', 'موقد', 'stove', 'cooker'],
  ['سخان', 'heater', 'water heater'],
  ['بطاريه', 'بطاريات', 'battery', 'batteries'],
  ['شاحن', 'charger'],
  ['كابل', 'وصله', 'cable'],
  ['لمبه', 'مصباح', 'لمبات', 'lamp', 'bulb', 'light'],
  ['ساعه', 'watch', 'clock'],
  ['نظاره', 'glasses', 'eyeglasses'],
  ['حقيبه', 'شنطه', 'bag', 'handbag'],
  ['جزمه', 'حذاء', 'احذيه', 'shoes', 'shoe'],
  ['قميص', 'shirt'],
  ['بنطلون', 'pants', 'trousers'],
  ['جاكيت', 'jacket'],
  ['فستان', 'dress'],
  ['عبايه', 'abaya'],
  ['عطر', 'perfume'],
  ['كريم', 'cream'],
  ['صابون', 'soap'],
  ['منظف', 'منظفات', 'detergent', 'cleaner'],
  ['شامبو', 'shampoo'],
  ['معجون اسنان', 'معجون', 'toothpaste'],
  ['حفاضات', 'حفاظات', 'diapers', 'nappies'],
  ['مناديل', 'tissues'],
  ['ورق', 'paper'],
  ['قلم', 'اقلام', 'pen', 'pens'],
  ['دفتر', 'كشكول', 'notebook'],
];

const SYNONYM_MAP = new Map();
for (const group of SYNONYM_GROUPS) {
  const terms = unique(group.map((term) => normalizeSearchText(term)));
  for (const term of terms) {
    const set = SYNONYM_MAP.get(term) || new Set();
    for (const other of terms) {
      if (other !== term) set.add(other);
    }
    SYNONYM_MAP.set(term, set);
  }
}

function synonymsFor(term) {
  const wanted = normalizeSearchText(term);
  if (!wanted) return [];
  const direct = SYNONYM_MAP.get(wanted);
  if (direct) return [...direct];

  /* A multi-word term can still match by its individual words. "washing
     machine" is in the group as a whole; a query of "washing" should not
     suddenly mean every washer, so only whole terms are expanded here. */
  return [];
}

/* Egyptian sound mapping. The goal is a consonant skeleton: شرب and sharp
   both become shrb, Pepsi and بيبسي both become bbs. Short skeletons are
   ignored as evidence; "soap" and "soup" both reduce to sb and must not
   become a match on sound alone. */
const ARABIC_PHONETIC_MAP = new Map([
  ['ا', 'a'],
  ['أ', 'a'],
  ['إ', 'a'],
  ['آ', 'a'],
  ['ٱ', 'a'],
  ['ب', 'b'],
  ['ت', 't'],
  ['ث', 's'],
  ['ج', 'g'],
  ['ح', 'h'],
  ['خ', 'kh'],
  ['د', 'd'],
  ['ذ', 'z'],
  ['ر', 'r'],
  ['ز', 'z'],
  ['س', 's'],
  ['ش', 'sh'],
  ['ص', 's'],
  ['ض', 'd'],
  ['ط', 't'],
  ['ظ', 'z'],
  ['ع', 'a'],
  ['غ', 'gh'],
  ['ف', 'f'],
  ['ق', 'k'],
  ['ك', 'k'],
  ['ل', 'l'],
  ['م', 'm'],
  ['ن', 'n'],
  ['ه', 'h'],
  ['و', 'w'],
  ['ي', 'y'],
  ['ى', 'y'],
  ['ة', 'h'],
  ['ء', ''],
  ['ئ', ''],
  ['ؤ', ''],
  ['چ', 'ch'],
  ['پ', 'b'],
  ['ڤ', 'f'],
  ['گ', 'g'],
  ['ژ', 'zh'],
]);

function latinSkeleton(value) {
  return String(value || '')
    .replace(/ph/g, 'f')
    .replace(/sh/g, '\uE000')
    .replace(/ch/g, '\uE001')
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/q/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/v/g, 'f')
    .replace(/p/g, 'b')
    .replace(/j/g, 'g')
    .replace(/[^a-z0-9\uE000\uE001]/g, '')
    .replace(/[aeiouy]/g, '')
    .replace(/\uE000/g, 'sh')
    .replace(/\uE001/g, 'ch')
    .replace(/(.)\1+/g, '$1');
}

function phoneticKey(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return '';
  const keys = [];
  for (const token of normalized.split(' ')) {
    const number = canonicalNumberToken(token);
    if (number) {
      keys.push(number);
      continue;
    }
    let mapped = '';
    for (const char of Array.from(token)) {
      if (/[a-z0-9]/.test(char)) mapped += char;
      else mapped += ARABIC_PHONETIC_MAP.get(char) || '';
    }
    const skeleton = latinSkeleton(mapped);
    if (skeleton) keys.push(skeleton);
  }
  return keys.join('');
}

function tokenMatchForms(value) {
  const forms = new Set();
  for (const token of tokenizeSearchText(value)) {
    if (!token) continue;
    forms.add(token);
    const stem = stemToken(token);
    if (stem) forms.add(stem);
    const root = rootKey(token);
    if (root) forms.add(root);
  }
  return forms;
}

function shareStrongForm(left, right) {
  const a = tokenMatchForms(left);
  const b = tokenMatchForms(right);
  for (const form of a) {
    if (form.length < 3 || !b.has(form)) continue;
    if (/^[0-9]+$/.test(form)) continue;
    return true;
  }
  return false;
}

function shareSynonym(left, right) {
  const wanted = normalizeSearchText(left);
  const offered = normalizeSearchText(right);
  if (!wanted || !offered) return false;

  const direct = SYNONYM_MAP.get(wanted);
  if (direct && direct.has(offered)) return true;

  for (const token of wanted.split(' ')) {
    const options = SYNONYM_MAP.get(token);
    if (!options) continue;
    if (options.has(offered)) return true;
    if ([...options].some((option) => offered.includes(option))) return true;
  }
  return false;
}

function nameSimilarity(left, right) {
  const a = normalizeSearchText(left);
  const b = normalizeSearchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const strippedA = stripDefiniteArticle(a);
  const strippedB = stripDefiniteArticle(b);
  if (strippedA === strippedB) return 0.98;

  const maxLength = Math.max(Array.from(strippedA).length, Array.from(strippedB).length);
  const distance = editDistance(strippedA, strippedB);
  const lev = maxLength ? 1 - distance / maxLength : 0;
  return Math.round(Math.max(lev, bigramSimilarity(strippedA, strippedB)) * 1000) / 1000;
}

/*
 * Broad relevance for a search result. Containment scores high so a query
 * "shoes" still finds "Shoes for children"; nameSimilarity stays strict and
 * is used where a record is about to be changed.
 */
function scoreNameMatch(query, candidate) {
  const wanted = normalizeSearchText(query);
  const offered = normalizeSearchText(candidate);
  if (!wanted || !offered) return 0;
  if (wanted === offered) return 1;

  const wantedStripped = stripDefiniteArticle(wanted);
  const offeredStripped = stripDefiniteArticle(offered);
  if (wantedStripped === offeredStripped) return 0.98;

  if (offeredStripped.startsWith(wantedStripped) || wantedStripped.startsWith(offeredStripped)) {
    return Math.max(0.9, nameSimilarity(wanted, offered));
  }
  if (offeredStripped.includes(wantedStripped) || wantedStripped.includes(offeredStripped)) {
    return Math.max(0.85, nameSimilarity(wanted, offered));
  }
  if (shareStrongForm(wanted, offered)) return 0.84;
  if (shareSynonym(wanted, offered)) return 0.8;

  const wantedSound = phoneticKey(wanted);
  const offeredSound = phoneticKey(offered);
  if (wantedSound && wantedSound === offeredSound && wantedSound.length >= 3) return 0.72;

  return nameSimilarity(wanted, offered);
}

function rankNameMatches(query, items, getName, options = {}) {
  const wanted = normalizeSearchText(query);
  const minimum = options.minScore === undefined ? FUZZY_MIN_SCORE : options.minScore;
  const limit = Number.isFinite(options.limit) ? options.limit : 25;
  if (Array.from(wanted).length < MIN_QUERY_CHARS || !Array.isArray(items)) return [];

  const numericQuery = /^\d+$/.test(wanted);
  return items
    .map((item) => {
      const name = String(typeof getName === 'function' ? getName(item) : item && item.name);
      return { item, name, score: scoreNameMatch(wanted, name) };
    })
    .filter((entry) => {
      if (!entry.name || entry.score < minimum) return false;
      return !numericQuery || entry.score === 1;
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function addTokenForms(set, value) {
  for (const token of tokenizeSearchText(value)) {
    if (!token) continue;
    if (token.length < 2 && !/^[0-9]+$/.test(token)) continue;
    set.add(token);
    const stem = stemToken(token);
    if (stem && stem.length >= 2) set.add(stem);
    const root = rootKey(token);
    if (root && root.length >= 2 && root !== stem) set.add(root);
    const number = canonicalNumberToken(token);
    if (number) set.add(number);
  }
}

/*
 * Expand one typed query into every spelling the index or database should be
 * asked for: the words themselves, Arabic stems/roots, number words and the
 * curated synonyms. Context terms are kept separate so they can rank results
 * without turning a category into a required keyword.
 */
function expandQuery(value, options = {}) {
  const raw = String(value == null ? '' : value).trim();
  const normalized = normalizeSearchText(raw);
  const tokens = unique(tokenizeSearchText(normalized));
  const forms = new Set();
  const phrases = new Set();

  for (const token of tokens) addTokenForms(forms, token);
  const wholeSynonyms = synonymsFor(normalized);
  for (const term of wholeSynonyms) {
    addTokenForms(forms, term);
    const text = normalizeSearchText(term);
    if (text.includes(' ')) phrases.add(text);
  }
  for (const token of tokens) {
    for (const term of synonymsFor(token)) {
      addTokenForms(forms, term);
      const text = normalizeSearchText(term);
      if (text.includes(' ')) phrases.add(text);
    }
  }

  const contextForms = new Set();
  const contextTerms = [
    ...(Array.isArray(options.contextTerms) ? options.contextTerms : []),
    options.category,
  ];
  for (const term of contextTerms) {
    if (!term) continue;
    addTokenForms(contextForms, term);
    for (const synonym of synonymsFor(term)) addTokenForms(contextForms, synonym);
  }

  const tokenForms = [...forms].filter((form) => !form.includes(' '));
  const phonetics = unique([...tokens.map(phoneticKey), ...tokenForms.map(phoneticKey)])
    .filter((key) => key.length >= 3 && !/^[0-9]+$/.test(key))
    .slice(0, MAX_PHONETICS);
  const ngrams = unique(tokenForms.flatMap(ngramsForToken)).slice(0, MAX_QUERY_NGRAMS);

  return {
    raw,
    normalized,
    tokens,
    forms: tokenForms.slice(0, MAX_QUERY_FORMS),
    phrases: [...phrases].slice(0, MAX_QUERY_PHRASES),
    contextForms: [...contextForms].slice(0, MAX_CONTEXT_FORMS),
    phonetics,
    ngrams,
  };
}

/* Build a regex that matches the same word with the letter variants a person
   may type or a product may store: أحمد/احمد, على/علي, غسالة/غساله, with or
   without vowel marks. Only field-specific callers use this; index queries use
   the normalised tokens instead. */
const ARABIC_CLASSES = new Map([
  ['ا', '[اأإآٱ]'],
  ['ي', '[يى]'],
  ['ه', '[هة]'],
  ['ة', '[ةه]'],
  ['و', '[وؤ]'],
  ['ؤ', '[ؤو]'],
  ['ى', '[ىي]'],
  ['ئ', '[ئ]'],
]);

function escapeRegexChar(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function smartRegexPattern(value) {
  const text = normalizeSearchText(value);
  if (!text) return '(?!)';
  const parts = [];
  for (const char of Array.from(text)) {
    if (char === ' ') {
      parts.push('\\s+');
      continue;
    }
    const base = ARABIC_CLASSES.get(char) || escapeRegexChar(char);
    parts.push(`${base}[\\u064B-\\u0652\\u0670\\u0640]*`);
  }
  return parts.join('');
}

module.exports = {
  FUZZY_MIN_SCORE,
  MIN_QUERY_CHARS,
  SYNONYM_GROUPS,
  bigramSimilarity,
  canonicalNumberToken,
  editDistance,
  expandQuery,
  foldDigits,
  nameSimilarity,
  ngramsForToken,
  normalizeSearchText,
  phoneticKey,
  rankNameMatches,
  rootKey,
  scoreNameMatch,
  shareStrongForm,
  shareSynonym,
  smartRegexPattern,
  stemToken,
  stripDefiniteArticle,
  synonymsFor,
  tokenMatchForms,
  tokenizeSearchText,
  trigramSimilarity,
  unique,
};
