'use strict';

/*
 * Smart name matching for the assistant's record lookup.
 *
 * The rules live in the API's shared search module so a product the sale
 * screen finds is the same product the assistant can name, and a category
 * searched from the assistant follows the same plural and sound-alike rules.
 * The assistant still verifies the branch-scoped rows it receives before a
 * plan writes anything; this file is the one place that proof is calculated.
 *
 * `correctCommonSpelling` is assistant-only: it fixes the few colour and shoe
 * size slips that are common in dictation before they become a stored name.
 */

/*
 * The API directory is shipped as an extra resource, not inside app.asar.
 * A plain relative require works in the checkout and tests but not in the
 * packaged app, so resolve the same single source from resources there. The
 * API build keeps this one file as JavaScript (see API_KEEP_JS) so it can be
 * loaded by both processes.
 */
const fs = require('fs');
const path = require('path');

function resolveSmartSearch() {
  const local = path.join(__dirname, '..', '..', 'api', 'src', 'utils', 'smart-search.js');
  if (fs.existsSync(local)) return local;
  const resources = process.resourcesPath
    ? path.join(process.resourcesPath, 'api', 'src', 'utils', 'smart-search.js')
    : '';
  if (resources && fs.existsSync(resources)) return resources;
  throw new Error('The shared smart-search module is missing from this installation.');
}

const smart = require(resolveSmartSearch());

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
  /* "14 أدم" is a common slip for "14 قدم" (feet). Only correct it after a
     number so a product or brand actually named Adam is left untouched. */
  const sized = source.replace(
    /([0-9٠-٩]+)\s*(?:أدم|ادم|آدم)(?![\p{L}\p{N}])/gu,
    '$1 قدم'
  );
  return sized.replace(/[\p{L}\p{N}]+/gu, (token) => {
    const key = smart.normalizeSearchText(token);
    return SPELLING_VARIANTS.get(key) || token;
  });
}

module.exports = {
  FUZZY_MIN_SCORE: smart.FUZZY_MIN_SCORE,
  MIN_QUERY_CHARS: smart.MIN_QUERY_CHARS,
  bigramSimilarity: smart.bigramSimilarity,
  canonicalNumberToken: smart.canonicalNumberToken,
  correctCommonSpelling,
  editDistance: smart.editDistance,
  expandQuery: smart.expandQuery,
  nameSimilarity: smart.nameSimilarity,
  normalizeName: smart.normalizeSearchText,
  phoneticKey: smart.phoneticKey,
  rankNameMatches: smart.rankNameMatches,
  scoreNameMatch: smart.scoreNameMatch,
  stripDefiniteArticle: smart.stripDefiniteArticle,
  synonymsFor: smart.synonymsFor,
};
