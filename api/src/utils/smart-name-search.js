'use strict';

/*
 * Smart name matching for the shop's search boxes.
 *
 * This module used to hold a second copy of the normalisation and distance
 * rules. It now re-exports the shared smart-search module so the item index,
 * category fallback, sale screen and assistant cannot drift apart.
 */

const smart = require('./smart-search');

module.exports = {
  FUZZY_MIN_SCORE: smart.FUZZY_MIN_SCORE,
  MIN_QUERY_CHARS: smart.MIN_QUERY_CHARS,
  bigramSimilarity: smart.bigramSimilarity,
  editDistance: smart.editDistance,
  editVariants: smart.editVariants,
  expandQuery: smart.expandQuery,
  nameSimilarity: smart.nameSimilarity,
  normalizeName: smart.normalizeSearchText,
  phoneticKey: smart.phoneticKey,
  phoneticVariants: smart.phoneticVariants,
  rankNameMatches: smart.rankNameMatches,
  scoreNameMatch: smart.scoreNameMatch,
  smartRegexPattern: smart.smartRegexPattern,
  stripDefiniteArticle: smart.stripDefiniteArticle,
};
