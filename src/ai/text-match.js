'use strict';

/*
 * Smart name matching for the assistant's record lookup.
 *
 * The API ranks categories and products the same way. The assistant keeps a
 * local copy because it must verify the branch-scoped rows it receives before
 * a plan writes anything. Keep the normalization in step with
 * api/src/utils/smart-name-search.js and the item search index.
 */

const MIN_QUERY_CHARS = 2;
const FUZZY_MIN_SCORE = 0.45;

function normalizeName(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stripDefiniteArticle(text) {
  return text.replace(/^ال(?=.{2,})/, '');
}

/* Only ordinary colour adjectives with a clear standard spelling. Names and
   brands are left alone; a product can still be named "حمرى" deliberately. */
const SPELLING_VARIANTS = new Map([
  ['حمري', 'حمراء'],
  ['حمرا', 'حمراء'],
  ['زرقي', 'زرقاء'],
  ['زرقا', 'زرقاء'],
  ['صفرا', 'صفراء'],
  ['صفري', 'صفراء'],
  ['سودي', 'سوداء'],
  ['سودا', 'سوداء'],
  ['بيضي', 'بيضاء'],
  ['بيضا', 'بيضاء'],
  ['خضري', 'خضراء'],
  ['خضرا', 'خضراء'],
]);

function correctCommonSpelling(value) {
  const source = String(value == null ? '' : value);
  return source.replace(/[\p{L}\p{N}]+/gu, (token) => {
    const key = normalizeName(token);
    return SPELLING_VARIANTS.get(key) || token;
  });
}

function editDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
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
  const a = Array.from(left);
  const b = Array.from(right);
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

function nameSimilarity(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
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

function scoreNameMatch(query, candidate) {
  const wanted = normalizeName(query);
  const offered = normalizeName(candidate);
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
  return nameSimilarity(wanted, offered);
}

function rankNameMatches(query, items, getName, options = {}) {
  const wanted = normalizeName(query);
  const minimum = options.minScore === undefined ? FUZZY_MIN_SCORE : options.minScore;
  const limit = Number.isFinite(options.limit) ? options.limit : 25;
  if (Array.from(wanted).length < MIN_QUERY_CHARS || !Array.isArray(items)) return [];

  const numericQuery = /^\d+$/.test(wanted);
  return items
    .map((item) => ({
      item,
      name: String((typeof getName === 'function' ? getName(item) : item && item.name) || ''),
      score: scoreNameMatch(wanted, typeof getName === 'function' ? getName(item) : item && item.name),
    }))
    .filter((entry) => {
      if (!entry.name || entry.score < minimum) return false;
      return !numericQuery || entry.score === 1;
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

module.exports = {
  FUZZY_MIN_SCORE,
  MIN_QUERY_CHARS,
  bigramSimilarity,
  correctCommonSpelling,
  editDistance,
  nameSimilarity,
  normalizeName,
  rankNameMatches,
  scoreNameMatch,
  stripDefiniteArticle,
};
