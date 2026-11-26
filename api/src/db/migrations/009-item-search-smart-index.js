'use strict';

/*
 * Rebuild the item search index for the smart-search fields.
 *
 * Migration 008 was already recorded on existing shops, so bumping the index
 * version inside it would only affect databases created after this release.
 * This migration runs the same idempotent backfill again: it finds documents
 * whose stored index version is not the current one (including every document
 * built before phonetic keys existed), rebuilds them in batches and ensures
 * the search indexes exist. A fresh database runs 008 and then this, which
 * finds nothing left to do.
 */

module.exports = require('./008-item-search-index');
