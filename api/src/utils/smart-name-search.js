'use strict';

/*
 * Smart name matching for the shop's search boxes.
 *
 * A cashier types a name from memory, often with an Arabic spelling slip
 * (احزايا for احذية) or a Latin typo (pepse for Pepsi). Exact substring search
 * misses those. This module normalises the same letter variants the item index
 * uses, then ranks a bounded set of names with edit distance and bigram
 * similarity. It is deliberately small and dependency-free.
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

/* The definate article is not part of a name for matching purposes. */
function stripDefiniteArticle(text) {
  return text.replace(/^ال(?=.{2,})/, '');
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

/*
 * Broad relevance for a search result. Containment scores high so a query
 * "shoes" still finds "Shoes for children"; nameSimilarity stays strict and is
 * used where a record is about to be changed.
 */
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
  editDistance,
  nameSimilarity,
  normalizeName,
  rankNameMatches,
  scoreNameMatch,
  stripDefiniteArticle,
};
