// src/db/migrations/index.js
//
// The migration registry, in the order they run. See ../migrations.js for the
// contract (forward-only, idempotent up(db), ledger in schema_migrations).
//
// Naming: NNN-kebab-summary, zero-padded so lexical order = run order.
// Add new entries at the END; never edit or remove a shipped one - a database
// that already applied it will simply skip it, and one that has not will run
// exactly what every other database ran.
//
// When you add a migration, bump API_SCHEMA_VERSION in
// constants/runtime.constants.js in the same commit.

module.exports = [
  {
    id: '001-business-cloud-daily-indexes',
    description: 'Bound Business daily sales and historical-sale refund reads by branch and date',
    up: require('../../services/business-cloud-reports').ensureCloudReportingIndexes,
  },
  {
    id: '003-universal-search-indexes',
    description: 'Index shop record identifiers and name prefixes for header search',
    up: require('./universal-search'),
  },
  {
    id: '004-employee-search-indexes',
    description: 'Index employee names and sign-in details for main search',
    up: (db) =>
      require('./universal-search')(
        db,
        require('../../services/search-providers').providers.filter((p) => p.route === 'users')
      ),
  },
  {
    id: '005-remove-demo-records',
    description: 'Delete records created by the retired demo data packs',
    up: require('./remove-demo-records'),
  },
  {
    id: '006-sale-line-cost-total',
    description: 'Store each sale line cost as the full quantity cost, not one unit',
    up: require('./sale-line-cost-total'),
  },
  {
    id: '007-arabic-default-party-names',
    description: 'Rename the default walk-in customer and general supplier to their Arabic names',
    up: require('./arabic-default-party-names'),
  },
  {
    id: '008-item-search-index',
    description: 'Build the normalized, typo-tolerant item search index and its indexes',
    up: require('./008-item-search-index'),
  },
  {
    id: '009-item-search-smart-index',
    description: 'Rebuild the item search index with phonetic keys for sound-alike search',
    up: require('./009-item-search-smart-index'),
  },
];
