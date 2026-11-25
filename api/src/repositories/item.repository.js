const itemCreationOrigin = require('../utils/item-creation-origin');
const sellingPriceHold = require('../utils/selling-price-hold');
const itemText = require('../utils/item-localization');
const gtin = require('../utils/gtin');
const { searchPattern } = require('../utils/safe-search');
const {
  buildSearchIndex,
  compareSearchCandidates,
  escapeSearchRegex,
  ngramsForToken,
  normalizeSearchText,
  scoreSearchCandidate,
  stripSearchIndex,
  tokenizeSearchText,
  unique,
  withSearchIndex,
} = require('../utils/item-search-index');
const { ensureIndexOnce } = require('../db/ensure-index');
// src/repositories/item.repository.js
const BaseModel = require('../models/base.model');
const Item = require('../models/item.model');
const Branch = require('../models/branch.model');
const itemBarcodes = require('../utils/item-barcodes');

const {
  DEFAULTS,
  ITEM_STATUS,
  SUCCESS_MESSAGES,
  ERROR_MESSAGES,
} = require('../constants/items.constants');

/* One definition of "not deleted", shared by every item query. It used to
   live inside a single method, which is how the purchase picker ended up
   without it. */
const NOT_DELETED = Object.freeze({ del_status: { $nin: [1, '1', true] } });

/* Fields from retired features can still exist in stored documents. Stored
   data is left alone, but none of it belongs in an item response any more, so
   it is stripped at the read boundary instead of being rewritten in the
   database. */
const REMOVED_ITEM_FIELDS = [
  'hsncode',
  'hsndescription',
  'hsn_code',
  'hsn_description',
  'tax',
  'tax_type',
  'tax_name',
  'tax_id',
  'tax_fields',
  'tax_method',
  'gst',
  'gst_type',
  'gst_number',
  'gstin',
  'ecommerce',
  'isAvailable',
  'show_on_menu',
  'channel_off',
  'channel_hours',
  'diet',
  'icon',
  'daypart_ids',
  'prep_note',
  'prep_minutes',
  'nutrition',
  'nutrition_source',
  'spice_choice',
  'food_tags',
  'menu_marks',
];
const stripRemovedItemFields = (row) => {
  if (!row || typeof row !== 'object') return row;
  for (const field of REMOVED_ITEM_FIELDS) delete row[field];
  return row;
};

const { ObjectId } = require('mongodb');
const { formatDate } = require('../utils/helpers');
const StockLogsRepository = require('./stock-log.repository');

// Use the legacy BaseModel-based implementation for field metadata and helpers
const LegacyItemModel = Item.LegacyItemModel;

/*
 * The item fields worth keeping a history of, and how to read each one.
 *
 * This is the whole of the "what changed" story for an item, in one list, so
 * the change log stays one honest thing rather than a pile of special cases.
 * It is deliberately a curated set, not every field:
 *
 *   - available_quantity is left out. It moves on every single sale, and its
 *     real record already lives in stocklogs; putting it here would bury the
 *     handful of edits a person actually made under a wall of stock movement.
 *   - updated_date, images and behaviour flags are left out too - machine
 *     churn and toggles, not the business facts a shopkeeper asks "who changed
 *     this?" about.
 *
 * Prices are in this list, not a list of their own: a price change is a field
 * change like any other, and keeping them together is what lets one History
 * tab tell the whole story instead of two tabs telling half of it each.
 *
 * type decides how a value is compared and shown: 'money' and 'percent' are
 * numeric, 'text' is a trimmed string.
 */
const TRACKED_FIELDS = [
  { field: 'name', label: 'Name', type: 'text' },
  { field: 'category_name', label: 'Category', type: 'text' },
  { field: 'supplier_name', label: 'Supplier', type: 'text' },
  { field: 'itemid', label: 'Item code', type: 'text' },
  { field: 'barcode_id', label: 'Barcode', type: 'text' },
  { field: 'unit', label: 'Unit', type: 'text' },
  { field: 'discount_amount', label: 'Discount amount', type: 'money' },
  { field: 'discount_percentage', label: 'Discount', type: 'percent' },
  { field: 'mrp_price', label: 'Retail price', type: 'money' },
  { field: 'company_price', label: 'Company price', type: 'money' },
  { field: 'selling_price', label: 'Selling price', type: 'money' },
];

const SEARCH_CANDIDATE_LIMIT = 300;
const SEARCH_CANDIDATE_PROJECTION = {
  name: 1,
  category_name: 1,
  description: 1,
  brand: 1,
  tags: 1,
  stock_locations: 1,
  translations: 1,
  sku: 1,
  barcode_id: 1,
  itemid: 1,
  plu_code: 1,
  gtin: 1,
  gtin14: 1,
  barcodes: 1,
  variant_parent_name: 1,
  variant_value: 1,
  search_tokens: 1,
  search_ngrams: 1,
  updated_date: 1,
};

/**
 * Item Repository
 * Handles all database operations for items
 * Separates data access logic from business logic
 */

class ItemRepository extends BaseModel {
  constructor() {
    super('items');
  }

  /*
   * Every read through this repository excludes tombstoned items, in one
   * place. Deletes stopped being hard deletes the day sync arrived: a row
   * that vanishes locally cannot tell the other side it is gone, which is
   * how items deleted on the web kept living on every till and the other
   * way round. A delete now writes del_status and rides sync like any other
   * change, and this wrapper keeps the tombstones out of every list,
   * search, count and lookup without thirty hand-edited queries.
   *
   * Writes pass through untouched, and other collections this repository
   * borrows (branches) are not filtered - only items carry this lifecycle.
   */
  async getCollection(collectionName = null) {
    const coll = await super.getCollection(collectionName);
    const target = collectionName || this.collectionName;
    if (target !== this.collectionName) return coll;
    return ItemRepository.withoutTombstones(coll);
  }

  static withoutTombstones(coll) {
    const merge = (f) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) return { ...NOT_DELETED };
      /* A filter already using $or at the top level (the branch filters do)
         must compose through $and, or the tombstone condition would be one
         more alternative instead of a requirement. */
      if (f.$or || f.$and) return { $and: [f, NOT_DELETED] };
      return { ...f, ...NOT_DELETED };
    };
    return new Proxy(coll, {
      get(t, prop) {
        if (prop === 'find' || prop === 'findOne' || prop === 'countDocuments') {
          return (filter, ...rest) => t[prop](merge(filter), ...rest);
        }
        if (prop === 'aggregate') {
          return (pipeline = [], ...rest) =>
            t.aggregate([{ $match: { ...NOT_DELETED } }, ...pipeline], ...rest);
        }
        const v = t[prop];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }

  /**
   * The collection and the authoritative filter for one branch's item list.
   *
   * Shared by the flat list and the grouped one. Two copies of this would be
   * two places to forget that client-supplied scope must be stripped - and the
   * failure mode of forgetting is not an error, it is a query that quietly
   * returns the wrong shop's items or none at all.
   *
   * @param {Object} params
   * @param {string|ObjectId} params.branchId - Branch context
   * @param {string|ObjectId} params.licenseId - License context
   * @param {Object} [params.filters] - Client-supplied business filters
   * @returns {Promise<{collection: Object, filter: Object}>}
   */
  async listScope({ branchId, licenseId, filters = {} } = {}) {
    const collection = await this.getCollection(this.collectionName);

    const branchObjectId = this.toObjectId(branchId);
    const licenseObjectId = this.toObjectId(licenseId);

    const branch = await Branch.findOne({
      _id: branchObjectId,
      license: licenseObjectId,
    })
      .select('branch_name notification_range')
      .lean();
    if (!branch) {
      throw new Error('Active branch does not belong to the current license');
    }

    const clientFilters = this.assignFilterObjects({ ...filters }, LegacyItemModel.fields);
    const quantity = {
      $convert: { input: '$available_quantity', to: 'double', onNull: null, onError: null },
    };
    const threshold = {
      $convert: {
        input: { $ifNull: ['$reorder_point', Number(branch.notification_range) || 0] },
        to: 'double',
        onNull: 0,
        onError: 0,
      },
    };
    const tracked = {
      $and: [{ $in: ['$track_inventory', [true, 'true']] }, { $ne: [quantity, null] }],
    };
    const stock = {
      out: { $and: [tracked, { $lte: [quantity, 0] }] },
      low: { $and: [tracked, { $gt: [quantity, 0] }, { $lte: [quantity, threshold] }] },
      in: { $and: [tracked, { $gt: [quantity, 0] }] },
    };
    if (clientFilters.stockLevel) {
      const level = clientFilters.stockLevel;
      delete clientFilters.stockLevel;
      if (!Object.hasOwn(stock, level)) throw new Error('Invalid stock level');
      clientFilters.$and = [...(clientFilters.$and || []), { $expr: stock[level] }];
    }
    if (Object.hasOwn(clientFilters, 'saleItems')) {
      const ids = clientFilters.saleItems;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !ObjectId.isValid(id)))
        throw new Error('Invalid item identifiers');
      delete clientFilters.saleItems;
      clientFilters._id = { $in: ids.map((id) => new ObjectId(id)) };
    }
    // Client-supplied scope is never part of the business filter. Leaving a
    // stale branch_name/branch_id alongside the authoritative scope can turn
    // a valid live query into an empty result.
    for (const key of [
      'branch_id',
      'branchId',
      'branch_name',
      'branch_access',
      'branch_access.branch_id',
      'license',
      'license_id',
      'licenseId',
    ]) {
      delete clientFilters[key];
    }

    const filter = {
      // branch_access is the canonical item-to-branch relation. branch_id and
      // branch_name are denormalized legacy fields and can be absent or stale
      // in production data after a branch rename.
      ...clientFilters,
      'branch_access.branch_id': branchObjectId,
      license: licenseObjectId,
    };

    return { collection, filter, stock };
  }

  /**
   * Find items with pagination and filters (equivalent to itemPage)
   *
   * @param {Object} params
   * @param {string|ObjectId} params.branchId - Branch context
   * @param {string|ObjectId} params.licenseId - License context
   * @param {Object} [params.filters] - Additional filters
   * @param {number} [params.page] - Page number (1-based)
   * @param {number} [params.limit] - Page size
   * @param {Object} [params.sort] - Sort object
   */
  async findPage({
    branchId,
    licenseId,
    filters = {},
    page = 1,
    limit = 5,
    sort = { _id: -1 },
    includeSummary = false,
  } = {}) {
    const { collection, filter, stock } = await this.listScope({ branchId, licenseId, filters });

    const effectiveLimit = parseInt(limit, 10) || 5;
    const effectivePage = parseInt(page, 10) || 1;
    const skip = (effectivePage - 1) * effectiveLimit;

    /*
     * Margin is COMPUTED (selling vs cost), so it cannot ride a find().sort()
     * - the special { $margin: 1|-1 } marker switches to an aggregation that
     * derives it per item. Items missing a selling price sort LAST in either
     * direction: an uncomputable margin is not a low one, and surfacing it
     * first would read as "these are your worst items" when nothing is known.
     */
    const marginDir = sort && sort.$margin;
    let itemsPromise;
    if (marginDir === 1 || marginDir === -1) {
      itemsPromise = collection
        .aggregate([
          { $match: filter },
          {
            $addFields: {
              _margin: {
                $cond: [
                  { $gt: [{ $ifNull: ['$selling_price', 0] }, 0] },
                  {
                    $divide: [
                      {
                        $subtract: ['$selling_price', { $ifNull: ['$company_price', 0] }],
                      },
                      '$selling_price',
                    ],
                  },
                  marginDir === 1 ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER,
                ],
              },
            },
          },
          { $sort: { _margin: marginDir, _id: -1 } },
          { $skip: skip },
          { $limit: effectiveLimit },
          { $project: BaseModel.getSelectFields(LegacyItemModel.fields) },
        ])
        .toArray();
    } else {
      itemsPromise = collection
        .find(filter, {
          projection: BaseModel.getSelectFields(LegacyItemModel.fields),
        })
        .sort(sort)
        .skip(skip)
        .limit(effectiveLimit)
        .toArray();
    }

    const count = includeSummary
      ? collection
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                inactive: {
                  $sum: { $cond: [{ $in: ['$is_active', [false, 0, 'false', '0']] }, 1, 0] },
                },
                out: { $sum: { $cond: [stock.out, 1, 0] } },
                low: { $sum: { $cond: [stock.low, 1, 0] } },
              },
            },
            { $project: { _id: 0 } },
          ])
          .next()
      : collection.countDocuments(filter);
    const [stats, items] = await Promise.all([count, itemsPromise]);
    const summary = includeSummary ? stats || { total: 0, inactive: 0, out: 0, low: 0 } : null;
    const total = includeSummary ? summary.total : stats;

    const list = items.map((doc) => BaseModel.simplifyFields(doc));

    return {
      items: list,
      ...(includeSummary ? { summary } : {}),
      total,
      page: effectivePage,
      limit: effectiveLimit,
      totalPages: Math.ceil(total / effectiveLimit) || 1,
    };
  }

  /**
   * Insert or update an item
   *
   * @param {Object} data - Raw item payload
   * @param {string} [id] - Optional existing item ID for update
   * @param {Object} context - Request context
   * @param {string|ObjectId} context.branchId
   * @param {string|ObjectId} context.licenseId
   * @param {string} [context.loggedUserName]
   * @param {string|ObjectId} [context.loggedUserId]
   */
  /*
   * A unique itemid for a branch. A non-empty SKU that clashes with nothing
   * else in the branch is kept as given; anything empty or colliding becomes
   * one past the highest numeric itemid the branch has. Not a global counter,
   * but per branch and enough to stop the form's default "1" from stacking up.
   */
  async resolveUniqueItemId(collection, branchId, provided, selfId) {
    const filter = { branch_id: branchId };
    if (provided) {
      const clash = { ...filter, itemid: provided };
      if (selfId && ObjectId.isValid(String(selfId)))
        clash._id = { $ne: new ObjectId(String(selfId)) };
      const exists = await collection.findOne(clash, { projection: { _id: 1 } });
      if (!exists) return provided; // genuinely unique - honour it
    }
    const rows = await collection.find(filter, { projection: { itemid: 1 } }).toArray();
    let max = 0;
    for (const r of rows) {
      const n = Number(r && r.itemid);
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
    return String(max + 1);
  }

  /*
   * Record price changes to the price_history collection, one row per price
   * field that actually changed. Powers the per-item Price history tab and the
   * price-changes report. Only the three item-level prices exist to track:
   * mrp_price, company_price, selling_price. Best effort by design - a logging
   * failure must never fail the save it is describing.
   */
  /*
   * Record which of an item's tracked fields actually changed.
   *
   * One choke point for the whole change log: a single edit, a re-import or the
   * bulk price tool all pass through here, so nothing that changes a price or a
   * name can forget to write its history. Only fields that really moved are
   * written - an edit that re-saves the same values leaves no rows - and it is
   * best-effort by design: the history must never be the reason a save fails.
   *
   * Rows still land in the price_history collection. The name is now a slight
   * misnomer - it holds every tracked change, not only prices - but it is an
   * already-syncing collection, and renaming it would strand the rows written
   * before this change and force a new build onto every till for nothing a
   * user would see. The label and value_type on each row are what the History
   * view reads.
   */
  async logItemChanges(itemRef, oldDoc = {}, newDoc = {}, context = {}, process = 'Edit') {
    await require('../services/catalogue-sharing').automatic([itemRef._id]);
    const textVal = (v) => (v === undefined || v === null ? '' : String(v).trim());
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

    const changes = [];
    for (const { field, label, type } of TRACKED_FIELDS) {
      if (newDoc[field] === undefined) continue; // not being set - not a change
      if (type === 'text') {
        const oldV = textVal(oldDoc[field]);
        const newV = textVal(newDoc[field]);
        if (oldV !== newV) changes.push({ field, label, type, old_value: oldV, new_value: newV });
      } else {
        const oldV = num(oldDoc[field]);
        const newV = num(newDoc[field]);
        if (oldV !== newV) changes.push({ field, label, type, old_value: oldV, new_value: newV });
      }
    }
    if (!changes.length) return 0;

    const db = await BaseModel.getDb();
    const now = new Date();
    const rows = changes.map((c) => ({
      item_id: itemRef._id,
      item_name: itemRef.name || oldDoc.name || newDoc.name || '',
      branch_id: itemRef.branch_id || oldDoc.branch_id || null,
      field: c.field,
      label: c.label,
      value_type: c.type, // 'money' | 'percent' | 'text'
      old_value: c.old_value,
      new_value: c.new_value,
      process, // 'Edit' | 'Bulk' | 'Import'
      changed_by: context.userName || context.loggedUserName || '',
      changed_by_id: context.userId || context.loggedUserId || null,
      date: now,
      created_date: now,
      updated_date: now,
      license: BaseModel.license || null,
    }));
    await db.collection('price_history').insertMany(rows);
    return rows.length;
  }

  /** Recent tracked changes for one item, newest first. */
  async getPriceHistory(itemId, { limit = 200 } = {}) {
    try {
      const db = await BaseModel.getDb();
      const filter = { item_id: this.toObjectId(itemId) };
      if (BaseModel.license) filter.license = BaseModel.license;
      const rows = await db
        .collection('price_history')
        .find(filter)
        .sort({ date: -1 })
        .limit(Math.min(1000, Number(limit) || 200))
        .toArray();
      return { status: true, data: rows };
    } catch (error) {
      return { status: false, data: [], message: error.message };
    }
  }

  /** Recent bulk price runs, newest first, paginated - the pricing tab's audit
   *  list of who raised or lowered what, when, and on how many items. */
  async getBulkPriceUpdates({ limit = 20, skip = 0 } = {}) {
    try {
      const db = await BaseModel.getDb();
      const filter = {};
      if (BaseModel.license) filter.license = BaseModel.license;
      const col = db.collection('bulk_price_updates');
      const lim = Math.min(100, Math.max(1, Number(limit) || 20));
      const sk = Math.max(0, Number(skip) || 0);
      const [rows, total] = await Promise.all([
        col.find(filter).sort({ date: -1 }).skip(sk).limit(lim).toArray(),
        col.countDocuments(filter),
      ]);
      return { status: true, data: rows, total };
    } catch (error) {
      return { status: false, data: [], total: 0, message: error.message };
    }
  }

  /*
   * Raise or lower prices across many items at once - all items, or one
   * category - by a percentage or a flat amount, on any one price field. Every
   * item that actually changes is written to price_history with process
   * 'Bulk', so the change is auditable exactly like a single edit. Prices are
   * clamped at zero and rounded to two decimals.
   */
  /*
   * The price rules a bulk change must not quietly break.
   *
   * After a proposed change sets `field` to `newV`, the selling price must not
   * end up ABOVE the MRP (an increase gone too far) nor BELOW the company/cost
   * price (a decrease that sells at a loss). Each is only judged when the
   * reference price is actually set - an item with no MRP or no cost recorded
   * is not a violation, just unconfigured. Returns the broken rule, or null.
   */
  _priceRuleViolation(item, field, newV) {
    let sell = Number(item.selling_price) || 0;
    let mrp = Number(item.mrp_price) || 0;
    let cost = Number(item.company_price) || 0;
    if (field === 'selling_price') sell = newV;
    else if (field === 'mrp_price') mrp = newV;
    else if (field === 'company_price') cost = newV;
    if (mrp > 0 && sell > mrp) return { rule: 'exceeds_mrp', selling: sell, limit: mrp };
    if (cost > 0 && sell < cost) return { rule: 'below_cost', selling: sell, limit: cost };
    return null;
  }

  // Validate + normalise a bulk-price request. Returns { error } or the parts.
  _bulkPriceParams({ field, op, value, direction }) {
    const allowedFields = ['mrp_price', 'company_price', 'selling_price'];
    if (!allowedFields.includes(field)) return { error: 'Unknown price field' };
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return { error: 'Enter a valid amount' };
    if (op !== 'percent' && op !== 'amount') return { error: 'Choose percent or amount' };
    const sign = direction === 'decrease' ? -1 : 1;
    const compute = (oldV) => {
      const delta = op === 'percent' ? (oldV * amount) / 100 : amount;
      return Math.max(0, Math.round((oldV + sign * delta) * 100) / 100);
    };
    return { amount, sign, compute };
  }

  _bulkPriceFilter({ scope, categoryId }, context) {
    const filter = {};
    if (BaseModel.license) filter.license = BaseModel.license;
    if (context.branchId) {
      const b = this.toObjectId(context.branchId);
      filter.$or = [{ 'branch_access.branch_id': b }, { branch_id: b }];
    }
    if (scope === 'category') {
      if (!categoryId) return { error: 'Choose a category' };
      filter.category_id = this.toObjectId(categoryId);
    }
    return { filter };
  }

  /*
   * Dry-run a bulk price change: compute what it would do WITHOUT writing, and
   * report how many items would change and which would break a price rule
   * (selling above MRP, or selling below cost). This is the "check feasible"
   * step - the shop sees the damage before it happens, including on a decrease
   * that would sell below cost, not just an increase past MRP.
   */
  async previewBulkUpdatePrices(
    { scope, categoryId, field, op, value, direction } = {},
    context = {}
  ) {
    const parts = this._bulkPriceParams({ field, op, value, direction });
    if (parts.error) return { status: false, message: parts.error };
    const built = this._bulkPriceFilter({ scope, categoryId }, context);
    if (built.error) return { status: false, message: built.error };

    const collection = await this.getCollection(this.collectionName);
    const items = await collection
      .find(built.filter, {
        projection: { name: 1, mrp_price: 1, company_price: 1, selling_price: 1 },
      })
      .toArray();

    let willChange = 0;
    const exceedsMrp = [];
    const belowCost = [];
    for (const it of items) {
      const oldV = Number(it[field]) || 0;
      const newV = parts.compute(oldV);
      if (newV !== oldV) willChange += 1;
      const v = this._priceRuleViolation(it, field, newV);
      if (!v) continue;
      const row = { name: it.name || '', old_value: oldV, new_value: newV, limit: v.limit };
      if (v.rule === 'exceeds_mrp' && exceedsMrp.length < 100) exceedsMrp.push(row);
      if (v.rule === 'below_cost' && belowCost.length < 100) belowCost.push(row);
    }

    return {
      status: true,
      data: {
        total: items.length,
        willChange,
        exceedsMrpCount: exceedsMrp.length,
        belowCostCount: belowCost.length,
        exceedsMrp,
        belowCost,
      },
      message: 'Preview ready',
    };
  }

  async bulkUpdatePrices(
    { scope, categoryId, field, op, value, direction, skipViolations } = {},
    context = {}
  ) {
    const parts = this._bulkPriceParams({ field, op, value, direction });
    if (parts.error) return { status: false, message: parts.error };
    const built = this._bulkPriceFilter({ scope, categoryId }, context);
    if (built.error) return { status: false, message: built.error };

    const collection = await this.getCollection(this.collectionName);
    const filter = built.filter;

    const items = await collection
      .find(filter, {
        projection: {
          [field]: 1,
          name: 1,
          branch_id: 1,
          mrp_price: 1,
          company_price: 1,
          selling_price: 1,
        },
      })
      .toArray();
    if (!items.length)
      return {
        status: true,
        data: { updated: 0, total: 0, skipped: 0 },
        message: 'No items matched',
      };

    const now = new Date();
    const db = await BaseModel.getDb();
    // One id for this whole run: stamped on every item row it writes and on the
    // batch record below, so the run and the items it touched link both ways.
    const batchId = new ObjectId();
    // Same label/value_type the single-edit path writes, so the History view
    // renders a bulk change identically to a hand edit.
    const fieldMeta = TRACKED_FIELDS.find((f) => f.field === field) || {
      label: field,
      type: 'money',
    };
    const priceRows = [];
    let updated = 0;
    let skipped = 0;
    for (const it of items) {
      const oldV = Number(it[field]) || 0;
      const newV = parts.compute(oldV);
      if (newV === oldV) continue;
      // When asked, leave alone any item this change would push over MRP or
      // under cost, and count it, rather than writing a price that breaks a rule.
      if (skipViolations && this._priceRuleViolation(it, field, newV)) {
        skipped += 1;
        continue;
      }
      const priceResult = await collection.updateOne(
        { _id: it._id, ...(field === 'selling_price' ? sellingPriceHold.writable(newV, now) : {}) },
        {
          $set: {
            [field]: newV,
            updated_date: now,
            updated_by: context.userName || '',
            updated_by_id: context.userId || null,
          },
        }
      );
      if (!priceResult.modifiedCount) {
        skipped += 1;
        continue;
      }
      updated += 1;
      priceRows.push({
        item_id: it._id,
        item_name: it.name || '',
        branch_id: it.branch_id || null,
        field,
        label: fieldMeta.label,
        value_type: fieldMeta.type,
        old_value: oldV,
        new_value: newV,
        process: 'Bulk',
        batch_id: batchId, // links this item row to the bulk run below
        changed_by: context.userName || '',
        changed_by_id: context.userId || null,
        date: now,
        created_date: now,
        updated_date: now,
        license: BaseModel.license || null,
      });
    }
    if (priceRows.length) {
      await db
        .collection('price_history')
        .insertMany(priceRows)
        .catch(() => {});
    }
    // Batch-level audit: one row per bulk run, so "who changed what, when, to how
    // many items" reads as a single event rather than being reconstructed from
    // the item rows. Only written when something actually changed.
    if (updated > 0) {
      await db
        .collection('bulk_price_updates')
        .insertOne({
          _id: batchId,
          field,
          label: fieldMeta.label,
          scope: scope === 'category' ? 'category' : 'all',
          category_id: scope === 'category' ? this.toObjectId(categoryId) : null,
          op, // 'percent' | 'amount'
          direction, // 'increase' | 'decrease'
          value: Number(value) || 0,
          items_changed: updated,
          items_matched: items.length,
          items_skipped: skipped,
          changed_by: context.userName || '',
          changed_by_id: context.userId || null,
          date: now,
          created_date: now,
          license: BaseModel.license || null,
        })
        .catch(() => {});
    }
    return {
      status: true,
      data: { updated, total: items.length, skipped, batch_id: batchId },
      message:
        `Updated ${updated} of ${items.length} item(s)` +
        (skipped
          ? `, skipped ${skipped} due to price rules or a selling-price hold. Review held prices in Edit prices.`
          : ''),
    };
  }

  /** Recent bulk stock runs, newest first, paginated - the audit list of who
   *  added or removed stock, when, and on how many items. Mirrors
   *  getBulkPriceUpdates but reads the bulk_stock_updates collection. */
  async getBulkStockUpdates({ limit = 20, skip = 0 } = {}) {
    try {
      const db = await BaseModel.getDb();
      const filter = {};
      if (BaseModel.license) filter.license = BaseModel.license;
      const col = db.collection('bulk_stock_updates');
      const lim = Math.min(100, Math.max(1, Number(limit) || 20));
      const sk = Math.max(0, Number(skip) || 0);
      const [rows, total] = await Promise.all([
        col.find(filter).sort({ date: -1 }).skip(sk).limit(lim).toArray(),
        col.countDocuments(filter),
      ]);
      return { status: true, data: rows, total };
    } catch (error) {
      return { status: false, data: [], total: 0, message: error.message };
    }
  }

  // Validate + normalise a bulk-stock request. Stock has a single field
  // (available_quantity), so unlike price there is nothing to choose. Returns
  // { error } or { amount, sign, compute }. Stock is clamped at zero and rounded
  // to two decimals - weight-priced items can carry fractional quantity.
  _bulkStockParams({ op, value, direction }) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return { error: 'Enter a valid quantity' };
    if (op !== 'percent' && op !== 'amount') return { error: 'Choose percent or amount' };
    const sign = direction === 'decrease' ? -1 : 1;
    const compute = (oldV) => {
      const delta = op === 'percent' ? (oldV * amount) / 100 : amount;
      return Math.max(0, Math.round((oldV + sign * delta) * 100) / 100);
    };
    return { amount, sign, compute };
  }

  /*
   * Dry-run a bulk stock change: compute what it would do WITHOUT writing, and
   * report how many items would change, with a small sample. The "check" step
   * so the shop sees the effect before committing.
   */
  async previewBulkUpdateStock({ scope, categoryId, op, value, direction } = {}, context = {}) {
    const parts = this._bulkStockParams({ op, value, direction });
    if (parts.error) return { status: false, message: parts.error };
    const built = this._bulkPriceFilter({ scope, categoryId }, context);
    if (built.error) return { status: false, message: built.error };

    const collection = await this.getCollection(this.collectionName);
    const items = await collection
      .find(built.filter, {
        projection: { name: 1, available_quantity: 1 },
      })
      .toArray();

    let willChange = 0;
    const sample = [];
    for (const it of items) {
      const oldV = Number(it.available_quantity) || 0;
      const newV = parts.compute(oldV);
      if (newV === oldV) continue;
      willChange += 1;
      if (sample.length < 100)
        sample.push({ name: it.name || '', old_value: oldV, new_value: newV });
    }

    return {
      status: true,
      data: { total: items.length, willChange, sample },
      message: 'Preview ready',
    };
  }

  /*
   * Add to or remove from available stock across many items at once - all items,
   * or one category - by a flat quantity or a percentage. Every item that
   * actually changes AND is inventory-tracked is written to stocklogs with
   * process 'Bulk Stock', so the movement is auditable exactly like a single
   * hand edit. Stock is clamped at zero.
   */
  async bulkUpdateStock({ scope, categoryId, op, value, direction, note } = {}, context = {}) {
    const parts = this._bulkStockParams({ op, value, direction });
    if (parts.error) return { status: false, message: parts.error };
    const built = this._bulkPriceFilter({ scope, categoryId }, context);
    if (built.error) return { status: false, message: built.error };
    // A free-text reason the shopkeeper can attach to the run ("new delivery",
    // "stock take correction"), carried onto every stock-log row and the batch
    // record so later readers see why the numbers moved. Capped so it cannot
    // bloat the audit.
    const cleanNote = String(note || '')
      .trim()
      .slice(0, 500);

    const collection = await this.getCollection(this.collectionName);
    const items = await collection
      .find(built.filter, {
        projection: {
          available_quantity: 1,
          name: 1,
          branch_id: 1,
          barcode_id: 1,
          track_inventory: 1,
        },
      })
      .toArray();
    if (!items.length)
      return {
        status: true,
        data: { updated: 0, total: 0, skipped: 0 },
        message: 'No items matched',
      };

    const now = new Date();
    const db = await BaseModel.getDb();
    // One id for the whole run: stamped on the batch record so the run reads as
    // a single event.
    const batchId = new ObjectId();

    // Stock logs record real opening/closing balances unless the branch turned
    // that off (then they read 'N/A'); the log row itself is still written.
    const branchObjectId = context.branchId ? this.toObjectId(context.branchId) : null;
    let stockLogStatus = true;
    if (branchObjectId) {
      const branchesCollection = await this.getCollection('branches');
      const branchDoc = await branchesCollection.findOne({ _id: branchObjectId });
      stockLogStatus = branchDoc?.stock_management_log !== false;
    }
    const stockLogsRepository = new StockLogsRepository();

    let updated = 0;
    for (const it of items) {
      const oldV = Number(it.available_quantity) || 0;
      const newV = parts.compute(oldV);
      if (newV === oldV) continue;
      await collection.updateOne(
        { _id: it._id },
        {
          $set: {
            available_quantity: newV,
            updated_date: now,
            updated_by: context.userName || '',
            updated_by_id: context.userId || null,
          },
        }
      );
      updated += 1;

      // Audit each changed, inventory-tracked item to stocklogs, exactly as the
      // single-edit path does. Same count convention: old - new, negated when
      // stock went up.
      if (it.track_inventory === true) {
        const diff = oldV - newV;
        const count = diff < 0 ? String(Math.abs(diff)) : '-' + String(diff);
        await stockLogsRepository
          .createStockLog({
            stocklog: stockLogStatus,
            branch_id: branchObjectId || it.branch_id || null,
            view_item_id: it._id,
            item_barcode_id: it.barcode_id,
            item_name: it.name,
            item_quantity: String(newV),
            process: 'Bulk Stock',
            reference: it.barcode_id,
            note: cleanNote,
            date: now,
            action: 'Add',
            opening_balance: String(oldV),
            closing_balance: String(newV),
            count: count,
            changed_by_userid: context.userId,
            changed_by: context.userName,
          })
          .catch(() => {});
      }
    }

    // Batch-level audit: one row per bulk run, so "who added how much stock to
    // how many items, when" reads as a single event. Only when something changed.
    if (updated > 0) {
      await db
        .collection('bulk_stock_updates')
        .insertOne({
          _id: batchId,
          field: 'available_quantity',
          label: 'Stock',
          scope: scope === 'category' ? 'category' : 'all',
          category_id: scope === 'category' ? this.toObjectId(categoryId) : null,
          op, // 'percent' | 'amount'
          direction, // 'increase' | 'decrease'
          value: Number(value) || 0,
          note: cleanNote,
          items_changed: updated,
          items_matched: items.length,
          items_skipped: 0,
          changed_by: context.userName || '',
          changed_by_id: context.userId || null,
          date: now,
          created_date: now,
          license: BaseModel.license || null,
        })
        .catch(() => {});
    }

    return {
      status: true,
      data: { updated, total: items.length, skipped: 0, batch_id: batchId },
      message: `Updated stock for ${updated} of ${items.length} item(s)`,
    };
  }

  /*
   * Set the selling price from a target margin in one move - the "40% margin"
   * button. For each item the new selling price is worked out FROM its cost
   * (company price), not nudged from an unknown base:
   *   margin mode  selling = cost / (1 - margin/100)   (margin is % OF selling)
   *   markup mode  selling = cost * (1 + margin/100)   (margin is % ON cost)
   * An item with no cost is left alone - there is nothing to base a margin on.
   */
  _marginCompute(mode, marginPct) {
    const m = Number(marginPct);
    return (cost) => {
      const c = Number(cost) || 0;
      if (c <= 0) return null; // no cost -> no basis for a margin
      const val = mode === 'markup' ? c * (1 + m / 100) : c / (1 - m / 100);
      return Math.round(val * 100) / 100;
    };
  }

  _validMargin(marginPct, mode) {
    const m = Number(marginPct);
    if (!Number.isFinite(m) || m < 0) return 'Enter a valid margin percentage';
    if (mode === 'margin' && m >= 100) return 'A margin of 100% or more is not possible';
    return null;
  }

  // Dry-run a margin change: what it would do, how many have no cost to base it
  // on, and how many would price above MRP - all without writing.
  async previewSetMargin({ scope, categoryId, margin, mode = 'margin' } = {}, context = {}) {
    const err = this._validMargin(margin, mode);
    if (err) return { status: false, message: err };
    const built = this._bulkPriceFilter({ scope, categoryId }, context);
    if (built.error) return { status: false, message: built.error };
    const collection = await this.getCollection(this.collectionName);
    const items = await collection
      .find(built.filter, {
        projection: { name: 1, mrp_price: 1, company_price: 1, selling_price: 1 },
      })
      .toArray();
    const compute = this._marginCompute(mode, margin);
    let willChange = 0;
    let noCost = 0;
    const exceedsMrp = [];
    for (const it of items) {
      const newV = compute(it.company_price);
      if (newV == null) {
        noCost += 1;
        continue;
      }
      if (newV === (Number(it.selling_price) || 0)) continue;
      willChange += 1;
      const v = this._priceRuleViolation(it, 'selling_price', newV);
      if (v && v.rule === 'exceeds_mrp') {
        exceedsMrp.push({ name: it.name || '', selling: newV, limit: v.limit });
      }
    }
    return {
      status: true,
      data: {
        total: items.length,
        willChange,
        noCost,
        exceedsMrpCount: exceedsMrp.length,
        exceedsMrp: exceedsMrp.slice(0, 50),
      },
      message: 'preview',
    };
  }

  // Apply a target margin across all items or one category. Same guards, history
  // logging and batch-audit record as a bulk +/-, so a margin run is auditable
  // exactly like a hand edit.
  async bulkSetMargin(
    { scope, categoryId, margin, mode = 'margin', skipViolations } = {},
    context = {}
  ) {
    const err = this._validMargin(margin, mode);
    if (err) return { status: false, message: err };
    const built = this._bulkPriceFilter({ scope, categoryId }, context);
    if (built.error) return { status: false, message: built.error };
    const collection = await this.getCollection(this.collectionName);
    const items = await collection
      .find(built.filter, {
        projection: { name: 1, branch_id: 1, mrp_price: 1, company_price: 1, selling_price: 1 },
      })
      .toArray();
    if (!items.length)
      return {
        status: true,
        data: { updated: 0, total: 0, skipped: 0 },
        message: 'No items matched',
      };

    const now = new Date();
    const db = await BaseModel.getDb();
    const batchId = new ObjectId();
    const compute = this._marginCompute(mode, margin);
    const fieldMeta = TRACKED_FIELDS.find((f) => f.field === 'selling_price') || {
      label: 'Selling price',
      type: 'money',
    };
    const priceRows = [];
    let updated = 0;
    let skipped = 0;
    let noCost = 0;
    for (const it of items) {
      const oldV = Number(it.selling_price) || 0;
      const newV = compute(it.company_price);
      if (newV == null) {
        noCost += 1;
        continue;
      }
      if (newV === oldV) continue;
      if (skipViolations && this._priceRuleViolation(it, 'selling_price', newV)) {
        skipped += 1;
        continue;
      }
      const priceResult = await collection.updateOne(
        { _id: it._id, ...sellingPriceHold.writable(newV, now) },
        {
          $set: {
            selling_price: newV,
            updated_date: now,
            updated_by: context.userName || '',
            updated_by_id: context.userId || null,
          },
        }
      );
      if (!priceResult.modifiedCount) {
        skipped += 1;
        continue;
      }
      updated += 1;
      priceRows.push({
        item_id: it._id,
        item_name: it.name || '',
        branch_id: it.branch_id || null,
        field: 'selling_price',
        label: fieldMeta.label,
        value_type: fieldMeta.type,
        old_value: oldV,
        new_value: newV,
        process: 'Bulk',
        batch_id: batchId,
        changed_by: context.userName || '',
        changed_by_id: context.userId || null,
        date: now,
        created_date: now,
        updated_date: now,
        license: BaseModel.license || null,
      });
    }
    if (priceRows.length) {
      await db
        .collection('price_history')
        .insertMany(priceRows)
        .catch(() => {});
    }
    if (updated > 0) {
      await db
        .collection('bulk_price_updates')
        .insertOne({
          _id: batchId,
          field: 'selling_price',
          label: fieldMeta.label,
          scope: scope === 'category' ? 'category' : 'all',
          category_id: scope === 'category' ? this.toObjectId(categoryId) : null,
          op: mode === 'markup' ? 'markup' : 'margin',
          direction: 'margin',
          value: Number(margin) || 0,
          items_changed: updated,
          items_matched: items.length,
          items_skipped: skipped,
          changed_by: context.userName || '',
          changed_by_id: context.userId || null,
          date: now,
          created_date: now,
          license: BaseModel.license || null,
        })
        .catch(() => {});
    }
    return {
      status: true,
      data: { updated, total: items.length, skipped, noCost, batch_id: batchId },
      message:
        `Set ${mode === 'markup' ? 'markup' : 'margin'} ${margin}% on ${updated} of ${items.length} item(s)` +
        (skipped
          ? `, skipped ${skipped} due to price rules or a selling-price hold. Review held prices in Edit prices.`
          : '') +
        (noCost ? `, ${noCost} have no cost price` : ''),
    };
  }

  /*
   * Rollback for a half-created variant family (V1): these rows were never
   * visible to anyone, so this is a hard delete - no recycle_bin tombstone
   * (a tombstone would SYNC the non-event fleet-wide) - and their freshly
   * written 'Add Item' stock logs go with them.
   */
  /*
   * Remove the demo data for good, and refuse to remove anything real.
   *
   * The switch hides; this destroys. So the whole value of it is in what it
   * declines to touch:
   *
   *   SOLD. A demo item exists to be rung up - that is how somebody finds out
   *   whether the till suits them - and a sale line stores item_id. Delete the
   *   item and the sale becomes a purchase of a product that does not exist.
   *   The sale is real even though the product was not, so nothing can put
   *   that right afterwards.
   *
   *   RECEIVED. Same argument for a purchase or a stock receipt.
   *
   *   EDITED. Changing the price on a sample and putting it on the shelf is
   *   how a small shop starts its real catalogue. By the time they press this
   *   button that row is THEIRS, whatever tag it still carries.
   *
   * What survives is reported by name, not counted. "Removed 128, kept 6"
   * invites the question this function already knows the answer to, and a
   * silent partial delete is worse than no delete at all.
   *
   * Soft, not hard: del_status is what the Recycle Bin reads, so this is still
   * undoable by the shop that asked for it. A hard delete here would make
   * "permanent" mean permanent in a way nobody asked for.
   */
  /**
   * How many samples this shop still has, kind by kind.
   *
   * A shopkeeper asking "how do I get rid of the demo data" is really asking
   * two things: where the button is, and how much of what they are looking at
   * is not theirs. A screen that can answer the second is worth far more than
   * one that only offers the first, so the counts are read here and said on
   * the dashboard.
   *
   * Never throws: a count that cannot be taken is zero for that kind, and a
   * dashboard that cannot read the meter is not a broken dashboard.
   *
   * @returns {Promise<{counts: Object, total: number}>}
   */
  async hardDeleteItems(ids, { licenseId } = {}) {
    const objectIds = (ids || [])
      .map((v) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null))
      .filter(Boolean);
    if (!objectIds.length) return { deleted: 0 };
    const filter = { _id: { $in: objectIds } };
    if (licenseId && ObjectId.isValid(String(licenseId))) {
      filter.license = new ObjectId(String(licenseId));
    }
    const collection = await this.getCollection(this.collectionName);
    const r = await collection.deleteMany(filter);
    try {
      const logs = await this.getCollection('stocklogs');
      await logs.deleteMany({ view_item_id: { $in: objectIds } });
    } catch (e) {
      /* debris, not data - never fail the rollback over it */
    }
    return { deleted: r.deletedCount || 0 };
  }

  /** Every member of one variant family, for the edit page's strip (V1). */
  async getFamily(groupId, context = {}) {
    if (!groupId || !ObjectId.isValid(String(groupId))) {
      return { status: false, data: null, message: 'Not a valid family id' };
    }
    const filter = { variant_group_id: new ObjectId(String(groupId)) };
    if (context.licenseId && ObjectId.isValid(String(context.licenseId))) {
      filter.license = new ObjectId(String(context.licenseId));
    }
    const collection = await this.getCollection(this.collectionName);
    const rows = await collection
      .find(filter, {
        projection: {
          name: 1,
          variant_value: 1,
          variant_axis: 1,
          variant_parent_name: 1,
          selling_price: 1,
          available_quantity: 1,
          track_inventory: 1,
          barcode_id: 1,
        },
      })
      .sort({ variant_value: 1 })
      .toArray();
    return {
      status: true,
      data: rows.map((r) => ({
        id: String(r._id),
        name: r.name || '',
        variant_value: r.variant_value || '',
        variant_axis: r.variant_axis || '',
        variant_parent_name: r.variant_parent_name || '',
        selling_price: r.selling_price || 0,
        available_quantity: r.available_quantity || 0,
        track_inventory: r.track_inventory === true,
        barcode_id: r.barcode_id || '',
      })),
      message: 'success',
    };
  }

  async upsertItem(data, id = '', context = {}) {
    return itemBarcodes.withWriteLock(context, () => this._upsertItem(data, id, context));
  }

  async _upsertItem(data, id = '', context = {}) {
    try {
      const collection = await this.getCollection(this.collectionName);

      const branchId = context.branchId;
      const licenseId = context.licenseId;

      if (!branchId || !licenseId) {
        return {
          status: false,
          message: 'Branch and license context required',
          data: null,
        };
      }

      const branchObjectId =
        branchId && ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId =
        licenseId && ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;

      const branch = await Branch.findOne({
        _id: branchObjectId,
        license: licenseObjectId,
      })
        .select('branch_name item_stock_default')
        .lean();
      if (!branch) {
        return {
          status: false,
          message: 'Active branch does not belong to the current license',
          data: null,
        };
      }

      // Check for existing item with same details
      const existingFilter = {
        'branch_access.branch_id': branchObjectId,
        license: licenseObjectId,
        name: data.name,
        barcode_id: data.barcode_id,
        mrp_price: parseFloat(data.mrp_price),
        company_price: parseFloat(data.company_price),
        selling_price: parseFloat(data.selling_price),
      };

      const existing = await collection.findOne(existingFilter);
      if (existing && existing._id.toString() !== id) {
        const duplicateCode = itemBarcodes
          .codes(data)
          .find((code) => itemBarcodes.codes(existing).includes(code));
        if (duplicateCode)
          return {
            status: 'exist',
            message: itemBarcodes.conflictMessage(duplicateCode, existing),
            data: null,
          };
        return {
          status: 'exist',
          message: 'This item details already exist in our system',
          data: null,
        };
      }

      /*
       * Barcode uniqueness, per branch. Two items answering one scan corrupts
       * scan-to-sell - the till adds whichever the index returns first. The
       * check covers the primary barcode and the V3 alternates on BOTH sides
       * (this item's codes vs existing primaries and alternates). Blank
       * barcodes are exempt: most quick-entry items have none.
       */
      const candidateCodes = itemBarcodes.codes(data);
      const clash = await itemBarcodes.findConflict(collection, candidateCodes, {
        branchId: branchObjectId,
        licenseId: licenseObjectId,
        selfId: id ? new ObjectId(id) : null,
      });
      if (clash) {
        return {
          status: 'exist',
          message: clash.message,
          data: { barcode: clash.barcode, itemId: String(clash.item._id) },
        };
      }

      // Process multi images
      const multiImage = Array.isArray(data.image)
        ? data.image.map((item) => ({
            name: item.name,
            size: parseInt(item.size, 10) || 0,
            cover: item.cover,
          }))
        : [];

      const now = new Date();
      const branchName = (branch.branch_name || '').trim();

      const loggedUserName = context.loggedUserName || context.loggedUser || 'System';
      const loggedUserId = context.loggedUserId !== undefined ? context.loggedUserId : null;

      /* Give the item a unique itemid within its branch. The form defaults the
         SKU to "1", so left alone every new item collided with the first one -
         which is what kept raising the duplicate-id health warning. A SKU the
         user genuinely made unique is kept; an empty or colliding one becomes
         the next free number for that branch. */
      const resolvedItemId = await this.resolveUniqueItemId(
        collection,
        branchObjectId,
        (data.sku_id || '').trim(),
        id
      );

      const updateData = {
        branch_id: branchObjectId,
        branch_name: branchName,
        branch_access: [{ branch_id: branchObjectId, branch_name: branchName }],
        name: (data.name || '').trim(),
        ...(Object.prototype.hasOwnProperty.call(data, 'translations')
          ? { translations: itemText.normalize(data.translations) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(data, 'default_language')
          ? {
              default_language: itemText.locale(data.default_language),
            }
          : {}),
        date: now,
        itemid: resolvedItemId,
        barcode_id: itemBarcodes.normalize(data.barcode_id),
        supplier_name: (data.supplier_name || '').trim(),
        supplier_id:
          data.supplier_id && ObjectId.isValid(data.supplier_id)
            ? new ObjectId(data.supplier_id)
            : '',
        category_name: (data.category_name || '').trim(),
        category_id:
          data.category_id && ObjectId.isValid(data.category_id)
            ? new ObjectId(data.category_id)
            : '',
        discount_amount: parseFloat(data.discount_amount) || 0,
        discount_percentage: parseFloat(data.discount_percentage) || 0,
        mrp_price: parseFloat(data.mrp_price) || 0,
        company_price: parseFloat(data.company_price) || 0,
        selling_price: parseFloat(data.selling_price) || 0,
        available_quantity: parseFloat(data.available_quantity) || 0,
        image: (data.cover_image || '').trim(),
        multi_image: multiImage,
        sort_order: parseInt(data.position, 10) || 0,
        description: (data.description || '').trim(),
        track_inventory:
          !id && ['always_available', 'track_quantities'].includes(branch.item_stock_default)
            ? branch.item_stock_default === 'track_quantities'
            : Boolean(data.inventory),
        negative_stock: Boolean(data.negative_stock),
        item_weight_machine_based: Boolean(data.item_weight_machine_based),
        items_mfg_date: data.items_mfg_date || null,
        items_expiry_date: data.items_expiry_date || null,
        updated_date: now,
        updated_by: loggedUserName || 'System',
        updated_by_id: loggedUserId || null,
        license: licenseObjectId,
        unit: data.unit || 'qty',
        unit_id: data.unit_id || '',
      };

      /*
       * Open price (IC1): the deliberate ask-at-the-till state. Presence-
       * gated - clients that predate the checkbox omit the key and never
       * clear a stored flag.
       */
      if (Object.prototype.hasOwnProperty.call(data, 'parcel_details')) {
        updateData.parcel_details = require('../utils/parcel-details').product(data.parcel_details);
      }

      if (data.open_price !== undefined) {
        updateData.open_price = data.open_price === true || data.open_price === 'true';
      }

      /*
       * Tile colour (Loyverse study L2): how a no-image item looks on the
       * sale grid. Presence-gated; only a hex colour or empty (= letter
       * tile) ever writes - garbage never does.
       */
      if (data.tile_color !== undefined) {
        const tileColor = String(data.tile_color || '').trim();
        updateData.tile_color = /^#[0-9a-fA-F]{6}$/.test(tileColor) ? tileColor : '';
      }

      // Omitted identifiers preserve existing values; explicit input is validated.
      if (Object.prototype.hasOwnProperty.call(data, 'gtin')) {
        const parsed = gtin.parse(data.gtin);
        updateData.gtin = parsed ? parsed.gtin : '';
        updateData.gtin14 = parsed ? parsed.gtin14 : '';
      }

      // Quick code (owner ask): digits only, up to 6, or empty clears.
      if (data.plu_code !== undefined) {
        const plu = String(data.plu_code || '').trim();
        updateData.plu_code = /^\d{1,6}$/.test(plu) ? plu : '';
      }

      // The tile's shape rides the same rules: a known shape or empty.
      if (data.tile_shape !== undefined) {
        const tileShape = String(data.tile_shape || '').trim();
        updateData.tile_shape = [
          'square',
          'rounded',
          'circle',
          'diamond',
          'triangle',
          'pentagon',
          'hexagon',
          'star',
          'octagon',
        ].includes(tileShape)
          ? tileShape
          : '';
      }

      /*
       * Lightspeed study LS1 trio, all presence-gated: brand (a name, for
       * filtering and the future community catalog), tags (free keywords),
       * reorder_point (this item's own low-stock threshold - overrides the
       * shop-wide notification range where set; empty clears it).
       */
      if (data.brand !== undefined) {
        updateData.brand = String(data.brand || '')
          .trim()
          .slice(0, 100);
      }
      if (data.tags !== undefined) {
        updateData.tags = (Array.isArray(data.tags) ? data.tags : [])
          .map((t) => String(t || '').trim())
          .filter(Boolean)
          .slice(0, 20);
      }
      if (data.reorder_point !== undefined) {
        const rp = Number(data.reorder_point);
        updateData.reorder_point = Number.isFinite(rp) && rp >= 0 ? rp : null;
      }

      /*
       * Services (Square study Q3): a second sellable kind. A service holds
       * no stock - track_inventory is forced off at write time so no code
       * path ever counts it - and prices fixed, per hour or per day (the
       * quantity column carries the hours/days, the engine sees an ordinary
       * line). Presence-gated; absent = product, forever untouched.
       */
      if (data.item_kind !== undefined) {
        const kind = data.item_kind === 'service' ? 'service' : 'product';
        updateData.item_kind = kind;
        if (kind === 'service') {
          updateData.track_inventory = false;
          const unit = String(data.service_unit || 'fixed');
          updateData.service_unit = ['fixed', 'hour', 'day'].includes(unit) ? unit : 'fixed';
        }
      }

      /*
       * Variant family link (VARIANT_SYSTEM_RESEARCH V1): four presence-
       * gated fields that turn the "name generator" into a real family.
       * Absent = plain item, and absent NEVER clears an existing link -
       * every legacy edit path omits them, and an edit that silently
       * orphaned an item from its family would be the old bug reborn.
       */
      if (data.variant_group_id && ObjectId.isValid(String(data.variant_group_id))) {
        updateData.variant_group_id = new ObjectId(String(data.variant_group_id));
        updateData.variant_axis = String(data.variant_axis || '').trim();
        updateData.variant_value = String(data.variant_value || '').trim();
        updateData.variant_parent_name = String(data.variant_parent_name || '').trim();
      }

      /* Unit conversion (V3): how many base units one purchase unit holds
         (box of 24 -> 24). STOCK STAYS IN BASE UNITS - the factor only
         powers the receiving screen's entry assist; nothing in stock or
         reservation math reads it. Presence-gated. */
      if (data.purchase_unit !== undefined) {
        updateData.purchase_unit = String(data.purchase_unit || '').trim();
      }
      if (data.stock_locations !== undefined) {
        updateData.stock_locations = require('../helpers/stock-locations').normalize(
          data.stock_locations
        );
      }
      if (data.selling_units !== undefined) {
        updateData.selling_units = require('../helpers/selling-units').normalize(
          data.selling_units,
          updateData.unit
        );
      }
      if (data.conversion_factor !== undefined) {
        const cf = Number(data.conversion_factor);
        updateData.conversion_factor = Number.isFinite(cf) && cf > 0 ? cf : 0;
      }

      /* Alternate barcodes (V3): manufacturer + internal codes beside the
         primary. Lookup checks both; labels keep printing the primary.
         Presence-gated: sent (even empty) sets, omitted changes nothing. */
      if (Array.isArray(data.barcodes)) {
        updateData.barcodes = [
          ...new Set(
            data.barcodes
              .map((v) => String(v || '').trim())
              .filter((v) => v && v !== updateData.barcode_id)
          ),
        ];
      }

      /* Modifier groups (V2): which option sets this item offers at sale
         time. Presence-gated like the variant link - a payload that sends
         the key (even empty) sets it; one that omits it changes nothing. */
      if (Array.isArray(data.modifier_group_ids)) {
        updateData.modifier_group_ids = data.modifier_group_ids
          .filter((v) => ObjectId.isValid(String(v)))
          .map((v) => new ObjectId(String(v)));
      }

      if (!id) {
        // Insert new item
        const insertData = withSearchIndex({
          ...updateData,
          created_date: now,
          created_by: loggedUserName || 'System',
          created_by_id: loggedUserId || null,
          creation_origin: itemCreationOrigin.record('add_item', context, now),
          item_status: ITEM_STATUS.REGULAR,
        });

        const result = await collection.insertOne(insertData);
        const insertedId = result.insertedId;

        // Get branch to check stock_management setting (PHP line 256)
        const branchesCollection = await this.getCollection('branches');
        const branchDoc = await branchesCollection.findOne({
          _id: branchObjectId,
        });

        const stockLogStatus = branchDoc?.stock_management_log !== false;

        console.log('[ITEM CREATE DEBUG] Stock log context:', {
          stockLogStatus: stockLogStatus,
          track_inventory: insertData.track_inventory,
        });

        // Create stock log for ADD Item (mirrors PHP item_model.php: always
        // log when track_inventory is true; stock_management_log only controls
        // whether opening/closing balances are numeric vs 'N/A'. Do not gate
        // on branch stock_management here.
        if (insertData.track_inventory === true) {
          const stockLogsRepository = new StockLogsRepository();
          const count = 0;

          console.log(
            '[ITEM CREATE DEBUG] Creating stock log for new item:',
            insertedId.toString()
          );

          await stockLogsRepository.createStockLog({
            stocklog: stockLogStatus,
            branch_id: branchObjectId,
            view_item_id: insertedId,
            item_barcode_id: insertData.barcode_id,
            item_name: insertData.name,
            item_quantity: String(insertData.available_quantity),
            process: 'Add Item',
            reference: insertData.barcode_id,
            date: now,
            action: 'Add',
            opening_balance: String(insertData.available_quantity),
            closing_balance: String(insertData.available_quantity),
            count: String(count),
            changed_by_userid: loggedUserId,
            changed_by: loggedUserName,
          });

          console.log('[ITEM CREATE] Stock log created successfully');
        } else {
          console.log(
            '[ITEM CREATE DEBUG] Skipping stock log because track_inventory flag is not enabled as expected.'
          );
        }

        try {
          require('../sync/nudge').nudgeSyncAgent();
        } catch (e) {
          /* latency hint only */
        }
        return {
          status: true,
          data: {
            id: result.insertedId.toString(),
            ...updateData,
            branchSharing: await require('../services/catalogue-sharing').automatic([
              result.insertedId,
            ]),
          },
          message: SUCCESS_MESSAGES.ITEM_CREATED,
        };
      }

      // Additional details must not reset stock that may have changed since creation.
      const writesQuantity = Object.prototype.hasOwnProperty.call(data, 'available_quantity');
      if (!writesQuantity) delete updateData.available_quantity;

      // Update existing item
      const itemObjectId = new ObjectId(id);

      // Get existing item for stock log calculation (mirrors PHP line 260-268)
      const existingItem = await collection.findOne({
        _id: itemObjectId,
        license: licenseObjectId,
      });
      if (sellingPriceHold.active(existingItem, updateData.selling_price))
        return { status: false, message: sellingPriceHold.message };

      // Omitted alternate codes are retained. Check them as well if the item
      // is being saved into a different branch or repairing old duplicates.
      if (!Array.isArray(data.barcodes) && existingItem?.barcodes?.length) {
        const retainedClash = await itemBarcodes.findConflict(
          collection,
          itemBarcodes.codes({ barcodes: existingItem.barcodes }),
          {
            branchId: branchObjectId,
            licenseId: licenseObjectId,
            selfId: itemObjectId,
          }
        );
        if (retainedClash) return { status: 'exist', message: retainedClash.message, data: null };
      }

      /* The search index is derived from the merged document, not only from
         this edit's fields, so a name-only change keeps the old description
         searchable and a description-only change keeps the old name. */
      Object.assign(updateData, buildSearchIndex({ ...existingItem, ...updateData }));

      const itemWrite = await collection.updateOne(
        {
          _id: itemObjectId,
          license: licenseObjectId,
          ...sellingPriceHold.writable(updateData.selling_price),
        },
        { $set: updateData }
      );
      if (!itemWrite.matchedCount) return { status: false, message: sellingPriceHold.message };

      // Record any tracked change against the item's history. Best effort.
      await this.logItemChanges(
        { _id: itemObjectId, name: updateData.name, branch_id: branchObjectId },
        existingItem || {},
        updateData,
        context,
        'Edit'
      ).catch(() => {});

      // Get branch to check stock_management setting (PHP line 268)
      const branchesCollection = await this.getCollection('branches');
      const branchDoc = await branchesCollection.findOne({
        _id: branchObjectId,
      });

      const stockLogStatus = branchDoc?.stock_management_log !== false;

      console.log('[ITEM UPDATE DEBUG] Stock log context:', {
        stockLogStatus: stockLogStatus,
        track_inventory: existingItem?.track_inventory,
      });

      // Create stock log for EDIT Item (mirrors PHP item_model.php: always log
      // when track_inventory is true; do not gate on branch stock_management).
      if (writesQuantity && existingItem && existingItem.track_inventory === true) {
        const stockLogsRepository = new StockLogsRepository();
        const openingBalance = existingItem.available_quantity || 0;
        const newBalance = updateData.available_quantity || 0;
        // PHP line 265-266: $available_quantity = $old - $new; count = ($available_quantity < 0) ? abs($available_quantity) : ('-') . $available_quantity
        const diff = openingBalance - newBalance;
        const count = diff < 0 ? String(Math.abs(diff)) : '-' + String(diff);

        console.log('[ITEM UPDATE DEBUG] Creating stock log for item:', id);

        await stockLogsRepository.createStockLog({
          stocklog: stockLogStatus,
          branch_id: branchObjectId,
          view_item_id: itemObjectId,
          item_barcode_id: updateData.barcode_id,
          item_name: updateData.name,
          item_quantity: String(updateData.available_quantity),
          process: 'Edit Item',
          reference: updateData.barcode_id,
          date: now,
          action: 'Add',
          opening_balance: String(openingBalance),
          closing_balance: String(newBalance),
          count: count,
          changed_by_userid: loggedUserId,
          changed_by: loggedUserName,
        });

        console.log('[ITEM UPDATE] Stock log created successfully');
      } else {
        console.log(
          '[ITEM UPDATE DEBUG] Skipping stock log because track_inventory flag is not enabled as expected.'
        );
      }

      // Update item name in stock logs if name changed (mirrors PHP line 275)
      if (existingItem && existingItem.name !== updateData.name) {
        const stockLogsRepository = new StockLogsRepository();
        await stockLogsRepository.updateItemNameInStockLogs(id, updateData.name);
      }

      try {
        require('../sync/nudge').nudgeSyncAgent();
      } catch (e) {
        /* latency hint only */
      }
      return {
        status: true,
        data: { id, ...updateData },
        message: SUCCESS_MESSAGES.ITEM_UPDATED,
      };
    } catch (error) {
      console.error('Error in ItemRepository.upsertItem:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  /**
   * Delete multiple items by IDs (delegates to legacy deleteItemCollectionData)
   *
   * @param {string[]} ids - Array of item IDs
   * @param {Object} context
   * @param {string|ObjectId} [context.licenseId]
   * @param {string|ObjectId} [context.branchId]
   * @param {string|ObjectId} [context.loggedUserId]
   * @param {string} [context.loggedUserName]
   */
  async deleteItems(ids, context = {}) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { status: false, data: null, message: 'No IDs provided' };
      }

      const collection = await this.getCollection(this.collectionName);

      const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

      const filter = { _id: { $in: objectIds } };

      const licenseId = context.licenseId || null;
      if (licenseId) {
        filter.license = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;
      }

      const branchId = context.branchId || null;
      const branchObjectId =
        branchId && ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;

      const loggedUserId = context.loggedUserId || null;
      const loggedUserName = context.loggedUserName || 'System';

      // Get branch to check stock_management setting (PHP line 852)
      const branchesCollection = await this.getCollection('branches');
      const branchDoc = await branchesCollection.findOne({
        _id: branchObjectId,
      });

      const stockLogStatus = branchDoc?.stock_management_log !== false;

      console.log('[ITEM DELETE DEBUG] Stock log context:', {
        stockLogStatus: stockLogStatus,
      });

      // Backup items before deletion, mirroring legacy behaviour
      const items = await collection.find(filter).toArray();
      const stockLogsRepository = new StockLogsRepository();
      const now = new Date();

      for (const item of items) {
        await BaseModel.deletedDocumentBackup(this.collectionName, item);

        // Create stock log for DELETE Item (mirrors PHP item_model.php: always
        // log when track_inventory is true; do not gate on branch
        // stock_management).
        if (item.track_inventory === true) {
          console.log('[ITEM DELETE DEBUG] Creating stock log for item:', item._id.toString());

          await stockLogsRepository.createStockLog({
            stocklog: stockLogStatus,
            branch_id: branchObjectId,
            view_item_id: item._id,
            item_barcode_id: item.barcode_id || '',
            item_name: item.name || '',
            ...itemText.snapshot(item),
            item_quantity: '0',
            process: 'Delete Item',
            reference: item.barcode_id || '',
            date: now,
            action: 'Subtract',
            opening_balance: String(item.available_quantity || 0),
            closing_balance: '0',
            count: '-' + String(item.available_quantity || 0),
            changed_by_userid: loggedUserId,
            changed_by: loggedUserName,
          });

          console.log('[ITEM DELETE] Stock log created successfully');
        } else {
          console.log(
            '[ITEM DELETE DEBUG] Skipping stock log because track_inventory flag is not enabled as expected.'
          );
        }
      }

      /* A tombstone, not a removal: the flag rides sync to every device,
         which a vanished row never can. updated_date is what makes the
         scanner carry it. */
      const deletedAt = new Date();
      const result = await collection.updateMany(filter, {
        $set: { del_status: 1, deleted_date: deletedAt, updated_date: deletedAt },
      });
      return { status: true, data: result.modifiedCount, message: 'success' };
    } catch (error) {
      console.error('Error in ItemRepository.deleteItems:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getItemsByCategory(categoryId) {
    const collection = await this.getCollection(this.collectionName);
    const categoryObjectId = this.toObjectId(categoryId);

    const items = await collection.find({ category_id: categoryObjectId }).toArray();

    return items.map((doc) => stripRemovedItemFields(BaseModel.simplifyFields(doc)));
  }

  /**
   * Items matching what somebody typed: part of a name, or a barcode.
   *
   * `context` is optional and additive, so the existing one-argument form keeps
   * working. Both of the things it adds matter once a real till uses this:
   *
   *   scope   without a branch and licence filter a cashier at one outlet is
   *           shown every outlet's stock. One shop here has 250 items across 8
   *           branches with 126 in the admin branch and none in six of the
   *           sale centres, so unscoped results are not a rounding error -
   *           they are mostly items that cashier cannot sell.
   *
   *   limit   an unbounded regex is a full catalogue in one response. A query
   *           of "a" against the largest shop here returns 4,732 items, built
   *           into an array and serialised, for a search box that shows ten.
   *
   * @param {string} query
   * @param {object} [context]
   * @param {string|ObjectId} [context.branchId]
   * @param {string|ObjectId} [context.licenseId]
   * @param {number} [context.limit]
   */
  async searchItems(query, context = {}) {
    const collection = await this.getCollection(this.collectionName);
    const raw = String(query == null ? '' : query).trim();
    if (!raw) return [];

    const normalized = normalizeSearchText(raw);
    const queryTokens = unique(tokenizeSearchText(normalized)).slice(0, 8);
    if (!queryTokens.length) return [];

    const requestedLimit = parseInt(context.limit, 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 20;

    const { branchId, licenseId } = context;
    const scope = [];
    if (branchId) {
      const branchObjectId = ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      scope.push({
        $or: [{ 'branch_access.branch_id': branchObjectId }, { branch_id: branchObjectId }],
      });
    }
    if (licenseId) {
      scope.push({ license: ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId });
    }
    const scopeFilter = scope.length === 0 ? {} : scope.length === 1 ? scope[0] : { $and: scope };

    /* Databases created before the migration still need these indexes for the
       first search; ensureIndexOnce is a no-op after the first success. */
    await Promise.all([
      ensureIndexOnce(
        collection,
        { license: 1, branch_id: 1, search_tokens: 1 },
        { name: 'item_search_tokens' }
      ),
      ensureIndexOnce(
        collection,
        { license: 1, branch_id: 1, search_ngrams: 1 },
        { name: 'item_search_ngrams' }
      ),
    ]).catch(() => {});

    const queryNgrams = unique(queryTokens.flatMap(ngramsForToken)).slice(0, 64);

    /* Barcodes and SKUs are exact identifiers. They stay exact so a scan does
       not rank a partial code above the real product. */
    const codeValues = unique([raw, raw.toLowerCase(), raw.toUpperCase(), normalized]);
    const codeClauses = [];
    for (const value of codeValues) {
      codeClauses.push(
        { barcode_id: value },
        { itemid: value },
        { sku: value },
        { plu_code: value },
        { gtin: value },
        { gtin14: value },
        { barcodes: value }
      );
    }

    const tokenMust = queryTokens.map((token) => ({
      search_tokens: { $regex: '^' + escapeSearchRegex(token) },
    }));
    const exactOr = [...codeClauses];
    if (tokenMust.length) exactOr.push({ $and: tokenMust });
    const exactFilter = { $and: [scopeFilter, { $or: exactOr }] };

    const [exactDocs, ngramDocs] = await Promise.all([
      collection
        .find(exactFilter, { projection: SEARCH_CANDIDATE_PROJECTION })
        .limit(SEARCH_CANDIDATE_LIMIT)
        .toArray(),
      queryNgrams.length
        ? collection
            .find(
              { $and: [scopeFilter, { search_ngrams: { $in: queryNgrams } }] },
              { projection: SEARCH_CANDIDATE_PROJECTION }
            )
            .limit(SEARCH_CANDIDATE_LIMIT)
            .toArray()
        : Promise.resolve([]),
    ]);

    const candidates = new Map();
    for (const doc of [...exactDocs, ...ngramDocs]) {
      if (doc && doc._id != null) candidates.set(String(doc._id), doc);
    }

    const scored = [...candidates.values()]
      .map((doc) => ({
        doc,
        score: scoreSearchCandidate(doc, normalized, queryTokens, queryNgrams),
      }))
      .filter((entry) => entry.score > 0)
      .sort(compareSearchCandidates)
      .slice(0, limit);

    if (scored.length) {
      const ids = scored.map((entry) => entry.doc._id);
      const fullDocs = await collection.find({ _id: { $in: ids } }).toArray();
      const byId = new Map(fullDocs.map((doc) => [String(doc._id), doc]));
      return scored
        .map((entry) => byId.get(String(entry.doc._id)))
        .filter(Boolean)
        .map((doc) => stripRemovedItemFields(stripSearchIndex(BaseModel.simplifyFields(doc))));
    }

    /* Legacy fallback: a database that has not run the backfill yet still
       answers the old exact/substring query. The next write or the migration
       puts the item on the new index. */
    const legacyClauses = [
      {
        $or: [
          { name: { $regex: searchPattern(raw), $options: 'i' } },
          { stock_locations: { $regex: searchPattern(raw), $options: 'i' } },
          { 'translations.name': { $regex: searchPattern(raw), $options: 'i' } },
          { barcode_id: raw },
          { barcodes: raw },
        ],
      },
      ...scope,
    ];
    const legacyQuery = legacyClauses.length === 1 ? legacyClauses[0] : { $and: legacyClauses };
    let cursor = collection.find(legacyQuery);
    cursor = cursor.limit(Math.min(limit, 100));
    const items = await cursor.toArray();
    return items.map((doc) =>
      stripRemovedItemFields(stripSearchIndex(BaseModel.simplifyFields(doc)))
    );
  }
  async getItemTableRow(id, context = {}) {
    try {
      if (!id || !ObjectId.isValid(id)) {
        return {
          status: false,
          data: null,
          message: ERROR_MESSAGES.ITEM_NOT_FOUND,
        };
      }

      const collection = await this.getCollection(this.collectionName);

      const filter = { _id: new ObjectId(id) };

      const licenseId = context.licenseId || null;
      if (licenseId) {
        filter.license = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;
      }

      const branchId = context.branchId || null;
      if (branchId && ObjectId.isValid(String(branchId))) {
        const branchObjectId = new ObjectId(String(branchId));
        filter.$or = [{ 'branch_access.branch_id': branchObjectId }, { branch_id: branchObjectId }];
      }

      const item = await collection.findOne(filter);
      if (!item) {
        return {
          status: false,
          data: null,
          message: ERROR_MESSAGES.ITEM_NOT_FOUND,
        };
      }

      // Ensure branch_access entries carry branch_name like legacy PHP
      if (Array.isArray(item.branch_access) && item.branch_access.length > 0) {
        try {
          const branchesNeedingName = [];
          const branchIdStrings = [];

          item.branch_access.forEach((entry) => {
            if (!entry || !entry.branch_id) return;
            const hasName =
              typeof entry.branch_name === 'string' && entry.branch_name.trim() !== '';
            if (hasName) return;

            let idString;
            if (entry.branch_id instanceof ObjectId) {
              idString = entry.branch_id.toHexString();
            } else {
              idString = String(entry.branch_id);
            }

            if (ObjectId.isValid(idString)) {
              branchesNeedingName.push(entry);
              branchIdStrings.push(idString);
            }
          });

          if (branchIdStrings.length > 0) {
            const branchCollection = await this.getCollection('branches');
            const cursor = await branchCollection
              .find({ _id: { $in: branchIdStrings.map((b) => new ObjectId(b)) } })
              .toArray();

            const nameMap = new Map();
            cursor.forEach((b) => {
              if (b && b._id) {
                nameMap.set(b._id.toString(), b.branch_name || '');
              }
            });

            branchesNeedingName.forEach((entry) => {
              let idString;
              if (entry.branch_id instanceof ObjectId) {
                idString = entry.branch_id.toHexString();
              } else {
                idString = String(entry.branch_id);
              }
              const name = nameMap.get(idString);
              if (name) {
                entry.branch_name = name;
              }
            });
          }
        } catch (e) {
          // Non-fatal: log and continue with whatever data we have
          console.error('Error enriching item.branch_access with branch_name:', e.message || e);
        }
      }

      // Default flags/fields expected by legacy frontend views
      item.negative_stock = item.negative_stock || false;

      if (item.items_mfg_date === undefined || item.items_mfg_date === null) {
        item.items_mfg_date = '';
      }
      if (item.items_expiry_date === undefined || item.items_expiry_date === null) {
        item.items_expiry_date = '';
      }

      const simplified = stripRemovedItemFields(BaseModel.simplifyFields(item));
      if (simplified && typeof simplified === 'object') {
        // Match legacy PHP: branch_access[*].branch_id should be an object with "$oid" key
        if (Array.isArray(simplified.branch_access)) {
          simplified.branch_access = simplified.branch_access.map((entry) => {
            if (!entry) return entry;

            const cloned = { ...entry };

            // Existing data may already be { $oid: ... } or a plain string/ObjectId string
            let rawId = null;
            if (cloned.branch_id && typeof cloned.branch_id === 'object' && cloned.branch_id.$oid) {
              rawId = cloned.branch_id.$oid;
            } else if (cloned.branch_id) {
              rawId = String(cloned.branch_id);
            }

            if (rawId) {
              cloned.branch_id = { $oid: String(rawId) };
            }

            return cloned;
          });
        }
      }

      return {
        status: true,
        data: simplified,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in ItemRepository.getItemTableRow:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getLowStockItems(params = {}, context = {}) {
    try {
      const {
        branchId = null,
        notificationRange = null,
        page = 1,
        limit = 10,
        filters = {},
      } = params || {};

      const collection = await this.getCollection(this.collectionName);

      const parsedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 10;
      const parsedPage = Number.isFinite(Number(page)) && Number(page) > 0 ? Number(page) : 1;
      const skip = (parsedPage - 1) * parsedLimit;

      const conditions = [];

      const parsedNotification =
        notificationRange !== undefined && notificationRange !== null
          ? parseInt(notificationRange, 10)
          : null;

      if (!Number.isNaN(parsedNotification)) {
        /* LS1: an item's own reorder point overrides the shop-wide
           notification range where set; absent falls back as before. */
        conditions.push({
          $expr: {
            $lte: [
              { $convert: { input: '$available_quantity', to: 'double', onError: 0, onNull: 0 } },
              { $ifNull: ['$reorder_point', parsedNotification] },
            ],
          },
        });
      }

      conditions.push({ item_status: { $ne: 'instant' }, track_inventory: true });

      const resolvedBranch =
        branchId || filters.branch_id || filters.branchId || context.branchId || null;

      // Only filter by branch if branch context is available
      if (resolvedBranch && ObjectId.isValid(String(resolvedBranch))) {
        const branchObjectId = new ObjectId(String(resolvedBranch));
        conditions.push({
          $or: [{ 'branch_access.branch_id': branchObjectId }, { branch_id: branchObjectId }],
        });
      }

      const resolvedLicense = context.licenseId || filters.license_id || null;
      // Only filter by license if license context is available
      if (resolvedLicense && ObjectId.isValid(String(resolvedLicense))) {
        conditions.push({ license: new ObjectId(String(resolvedLicense)) });
      }

      const isString = (v) => typeof v === 'string' && v.trim().length > 0;
      const searchTerm =
        (isString(filters.search) && filters.search) ||
        (isString(filters.query) && filters.query) ||
        null;

      if (searchTerm) {
        const regex = new RegExp(String(searchTerm), 'i');
        conditions.push({
          $or: [
            { name: regex },
            { stock_locations: regex },
            { 'translations.name': regex },
            { itemid: regex },
            { barcode_id: regex },
            { sku: regex },
          ],
        });
      }

      if (filters && typeof filters === 'object') {
        const excludedKeys = new Set([
          'search',
          'query',
          'branch_id',
          'branchId',
          'license',
          'license_id',
        ]);

        Object.entries(filters).forEach(([key, value]) => {
          if (excludedKeys.has(key)) return;
          if (value === undefined || value === null) return;

          // Handle date fields with $gte/$lte operators
          if (key === 'updated_date' || key === 'created_date') {
            if (typeof value === 'object' && value !== null) {
              const dateCondition = {};
              if (value.$gte) {
                const gteDate = new Date(value.$gte.trim());
                if (!isNaN(gteDate.getTime())) {
                  dateCondition.$gte = gteDate;
                }
              }
              if (value.$lte) {
                const lteDate = new Date(value.$lte.trim());
                if (!isNaN(lteDate.getTime())) {
                  dateCondition.$lte = lteDate;
                }
              }
              if (Object.keys(dateCondition).length > 0) {
                if (key === 'created_date') {
                  conditions.push({
                    $or: [
                      { created_date: dateCondition },
                      { created_date: null, createdAt: dateCondition },
                    ],
                  });
                } else {
                  conditions.push({ [key]: dateCondition });
                }
              }
              return;
            }
          }

          conditions.push({ [key]: value });
        });
      }

      const match = conditions.length > 1 ? { $and: conditions } : conditions[0] || {};

      const [total, items] = await Promise.all([
        collection.countDocuments(match),
        collection
          .find(match)
          .sort({ available_quantity: 1, name: 1 })
          .skip(skip)
          .limit(parsedLimit)
          .toArray(),
      ]);

      const list = items.map((item) => {
        const simplified = BaseModel.simplifyFields(item);
        if (!simplified._id) {
          simplified._id = item._id?.toString?.() || simplified.id;
        }
        if (!simplified.image) {
          simplified.image = item.image || DEFAULTS.IMAGE;
        }
        return simplified;
      });

      return {
        status: true,
        data: {
          total,
          total_pages: parsedLimit ? Math.ceil(total / parsedLimit) : 0,
          current_page: parsedPage,
          per_page: parsedLimit,
          list,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in ItemRepository.getLowStockItems:', error);
      return {
        status: false,
        data: null,
        message: error.message || 'Failed to fetch low stock items',
      };
    }
  }

  async getOnlineItemsAjaxList(params = {}, context = {}) {
    try {
      const { type = 'normal' } = params || {};
      if (params.query != null && typeof params.query !== 'string')
        throw new Error('Invalid item search');
      const query = String(params.query || '')
        .trim()
        .slice(0, 80);
      const limit = Math.min(50, Math.max(1, parseInt(params.limit, 10) || 20));
      const categoryId = params.categoryId;
      if (categoryId && (typeof categoryId !== 'string' || !ObjectId.isValid(categoryId))) {
        throw new Error('Invalid category');
      }

      const branchId = context.branchId;
      if (!branchId) {
        return { status: false, message: 'Branch context is required' };
      }

      const licenseId = context.licenseId || null;

      const collection = await this.getCollection(this.collectionName);
      const branchObjectId = ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId =
        licenseId && ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId || null;

      const regex = query ? new RegExp(searchPattern(query), 'i') : null;
      const SettingsRepository = require('./settings.repository');
      const preferences = await new SettingsRepository().resolveGroup('preferences', {
        branchId,
        licenseId,
      });
      if (!preferences.status) throw new Error('Could not load sales search preferences');
      const searchPreferences = preferences.data.values || {};
      let searchConditions = [];

      // PHP Line 1377-1387: Handle type='id' separately to fetch by ObjectId
      if (type === 'id' && query && ObjectId.isValid(query)) {
        searchConditions = [{ _id: new ObjectId(query) }];
      } else if (regex && type === 'barcode') {
        searchConditions = [
          { barcode_id: itemBarcodes.normalize(query) },
          { barcodes: itemBarcodes.normalize(query) },
        ];
      } else if (
        regex &&
        /^\d+$/.test(query) &&
        searchPreferences.sales_exact_numeric_codes === true
      ) {
        searchConditions = require('../helpers/sales-search-fields').exactNumericCodes(
          query,
          searchPreferences.sales_search_fields
        );
        if (!searchConditions.length) return { status: true, data: [], message: 'success' };
      } else if (regex && Array.isArray(searchPreferences.sales_search_fields)) {
        searchConditions = require('../helpers/sales-search-fields').conditions(
          searchPreferences.sales_search_fields,
          query,
          regex
        );
        if (!searchConditions.length) return { status: true, data: [], message: 'success' };
      } else if (regex) {
        searchConditions = [
          { name: regex },
          { 'translations.name': regex },
          { itemid: regex },
          { short_code: regex },
          { item_code: regex },
          { barcode_id: regex },
          { barcodes: regex },
        ];
        const tokens = query.split(/\s+/).filter(Boolean).slice(0, 6);
        if (tokens.length > 1)
          searchConditions.push({
            $and: tokens.map((token) => ({ name: new RegExp(searchPattern(token), 'i') })),
          });
        if (/^[a-z]{2,6}$/i.test(query))
          searchConditions.push({
            name: new RegExp(
              '^' + query.split('').map(searchPattern).join('\\S*\\s+') + '\\S*',
              'i'
            ),
          });
        // An all-digits query is how quick codes are typed.
        if (/^\d{1,6}$/.test(String(query))) {
          searchConditions.push({ plu_code: String(query) });
        }
      }

      // Catalogue visibility is separate from permission to sell. Keep sold-out
      // products searchable; add-to-cart and sale validation enforce quantity.

      const match = {
        $and: [
          searchConditions.length ? { $or: searchConditions } : null,
          { del_status: { $nin: [1, '1', true] } },
          { 'branch_access.branch_id': branchObjectId },
          { item_status: { $ne: 'instant' } },
          { available_for_sale: { $ne: false } },
          ...(categoryId ? [{ category_id: new ObjectId(categoryId) }] : []),
          ...(licenseObjectId ? [{ license: licenseObjectId }] : []),
        ].filter(Boolean),
      };

      const data = await collection
        .aggregate([
          { $match: match },
          {
            $addFields: {
              _searchRank: {
                $switch: {
                  branches: [
                    {
                      case: {
                        $or: ['plu_code', 'itemid', 'barcode_id', 'short_code', 'item_code'].map(
                          (field) => ({
                            $eq: [
                              {
                                $toLower: {
                                  $convert: {
                                    input: '$' + field,
                                    to: 'string',
                                    onError: '',
                                    onNull: '',
                                  },
                                },
                              },
                              query.toLowerCase(),
                            ],
                          })
                        ),
                      },
                      then: 5,
                    },
                    { case: { $eq: [{ $toLower: '$name' }, query.toLowerCase()] }, then: 4 },
                    {
                      case: {
                        $regexMatch: {
                          input: { $ifNull: ['$name', ''] },
                          regex: '^' + searchPattern(query),
                          options: 'i',
                        },
                      },
                      then: 3,
                    },
                  ],
                  default: 1,
                },
              },
            },
          },
          { $sort: { _searchRank: -1, name: 1, _id: 1 } },
          ...(type === 'barcode'
            ? [{ $sort: { name: 1, itemid: 1, _id: 1 } }]
            : [{ $limit: limit }]),
          {
            $project: {
              _id: 1,
              name: 1,
              default_language: 1,
              translations: 1,
              selling_price: 1,
              open_price: 1,
              mrp_price: 1,
              itemid: 1,
              unit: 1,
              selling_units: 1,
              stock_locations: 1,
              short_code: 1,
              item_code: 1,
              barcodes: 1,
              available_quantity: 1,
              company_price: 1,
              discount_amount: 1,
              discount_percentage: 1,
              category_id: 1,
              category_name: 1,
              image: 1,
              supplier_id: 1,
              supplier_name: 1,
              track_inventory: 1,
              negative_stock: 1,
              barcode_id: 1,
              items_expiry_date: 1,
              item_kind: 1,
              tile_color: 1,
              tile_shape: 1,
              plu_code: 1,
            },
          },
        ])
        .toArray();

      const suggestions = data.map((item) => ({
        sales_search_display_fields: searchPreferences.sales_search_display_fields || null,
        item_id: item._id?.toString?.() || '',
        item_name: item.name || '',
        ...itemText.snapshot(item),
        selling_price: item.selling_price || 0,
        open_price: item.open_price === true,
        mrp_price: item.mrp_price || 0,
        itemid: item.itemid || '',
        unit: item.unit || '',
        selling_units: item.selling_units || [],
        stock_locations: require('../helpers/stock-locations').read(item),
        short_code: item.short_code || '',
        item_code: item.item_code || '',
        barcodes: item.barcodes || [],
        available_quantity: item.available_quantity || 0,
        company_price: item.company_price || 0,
        discount_amount: item.discount_amount || 0,
        discount_percentage: item.discount_percentage || 0,
        category_id: item.category_id?.toString?.() || '',
        category_name: item.category_name || '',
        image: item.image || DEFAULTS.IMAGE,
        supplier_id: item.supplier_id?.toString?.() || '',
        supplier_name: item.supplier_name || '',
        track_inventory: item.track_inventory !== false,
        negative_stock: item.negative_stock === true,
        barcode_id: item.barcode_id || '',
        items_expiry_date: item.items_expiry_date != null ? String(item.items_expiry_date) : '',
        item_kind: item.item_kind || 'product',
        tile_color: item.tile_color || '',
        tile_shape: item.tile_shape || '',
        plu_code: item.plu_code || '',
      }));

      // Exact quick-code hits lead the list - Enter carts them instantly.
      if (/^\d{1,6}$/.test(String(query))) {
        suggestions.sort(
          (a, b) => (b.plu_code === String(query) ? 1 : 0) - (a.plu_code === String(query) ? 1 : 0)
        );
      }

      return {
        status: true,
        data: suggestions,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in ItemRepository.getOnlineItemsAjaxList:', error);
      return {
        status: false,
        data: null,
        message: error.message || 'Failed to load items',
      };
    }
  }

  /**
   * The sale screen's shelf: one page of tiles at a time.
   *
   * Variant families are grouped so a page never splits a family across two
   * requests, and sold-out or expired products stay off the shelf. The full
   * catalogue remains reachable through getOnlineItemsAjaxList for barcode
   * and name search.
   */
  async getOnlineSalesItems(params = {}, context = {}) {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(params.limit, 10) || 100));
      const offset = Math.max(0, parseInt(params.offset, 10) || 0);

      const branchId = context.branchId;
      if (!branchId) {
        return { status: false, message: 'Branch context is required' };
      }

      const licenseId = context.licenseId || null;

      const collection = await this.getCollection(this.collectionName);
      const branchObjectId = ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId =
        licenseId && ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId || null;

      const match = {
        $and: [
          { del_status: { $nin: [1, '1', true] } },
          { 'branch_access.branch_id': branchObjectId },
          { item_status: { $ne: 'instant' } },
          { available_for_sale: { $ne: false } },
          ...(licenseObjectId ? [{ license: licenseObjectId }] : []),
        ],
      };

      let items, nextOffset;
      if (params.tilePage) {
        if (params.categoryId) {
          if (typeof params.categoryId !== 'string' || !ObjectId.isValid(params.categoryId)) {
            throw new Error('Invalid category');
          }
          match.$and.push({ category_id: new ObjectId(params.categoryId) });
        }
        // Zero stock must not make an imported catalogue look empty.
        // Expiry can be an epoch string or an ISO date. Missing/invalid dates
        // remain available, matching the billing search's expiry semantics.
        const expiry = {
          $convert: {
            input: {
              $ifNull: [
                {
                  $convert: {
                    input: '$items_expiry_date',
                    to: 'double',
                    onError: null,
                    onNull: null,
                  },
                },
                '$items_expiry_date',
              ],
            },
            to: 'date',
            onError: null,
            onNull: null,
          },
        };
        match.$and.push({
          $expr: { $or: [{ $eq: [expiry, null] }, { $gte: [expiry, new Date()] }] },
        });
        const size = Math.min(limit, 48);
        const groups = await collection
          .aggregate([
            { $match: match },
            ...require('../utils/catalogue-order').stages(),
            {
              $group: {
                _id: {
                  $cond: [
                    { $in: [{ $ifNull: ['$variant_group_id', ''] }, ['', null]] },
                    { item: '$_id' },
                    { family: '$variant_group_id' },
                  ],
                },
                _categoryOrder: { $first: '$_categoryOrder' },
                _categoryName: { $first: '$_categoryName' },
                _skuNumber: { $first: '$_skuNumber' },
                _skuText: { $first: '$_skuText' },
                name: { $first: '$name' },
                first_id: { $first: '$_id' },
                items: { $push: '$$ROOT' },
              },
            },
            {
              $sort: {
                _categoryOrder: 1,
                _categoryName: 1,
                _skuNumber: 1,
                _skuText: 1,
                name: 1,
                first_id: 1,
              },
            },
            { $skip: offset },
            { $limit: size + 1 },
          ])
          .toArray();
        nextOffset = groups.length > size ? offset + size : null;
        items = groups.slice(0, size).flatMap((group) => group.items);
      } else {
        const pipeline = [
          { $match: match },
          ...require('../utils/catalogue-order').stages(),
          ...(offset ? [{ $skip: offset }] : []),
          { $limit: limit },
        ];
        items = await collection.aggregate(pipeline).toArray();
        nextOffset = items.length === limit ? offset + limit : null;
      }

      const list = items.map((item) => ({
        id: item._id?.toString?.() || '',
        name: item.name || '',
        item_name: item.name || '',
        item_id: item._id?.toString?.() || '',
        plu_code: item.plu_code || '',
        barcode_id: item.barcode_id || '',
        barcodes: item.barcodes || [],
        short_code: item.short_code || '',
        item_code: item.item_code || '',
        track_inventory: item.track_inventory === true,
        negative_stock: item.negative_stock === true,
        item_kind: item.item_kind || 'product',
        unit: item.unit || '',
        selling_units: item.selling_units || [],
        stock_locations: require('../helpers/stock-locations').read(item),
        ...itemText.snapshot(item),
        selling_price: item.selling_price || 0,
        itemid: item.itemid || '',
        available_quantity: String(item.available_quantity || 0),
        company_price: item.company_price || 0,
        discount_amount: item.discount_amount || 0,
        discount_percentage: item.discount_percentage || 0,
        category_id: item.category_id?.toString?.() || '',
        category_name: item.category_name || '',
        image: item.image || DEFAULTS.IMAGE,
        supplier: item.supplier_name || '',
        // Match PHP: expose items_expiry_date for frontend expiry checks
        items_expiry_date: item.items_expiry_date != null ? String(item.items_expiry_date) : '',
        // Variant family link (V1): lets the sale grid collapse a family
        // into one tile with a picker. Empty strings for plain items.
        variant_group_id: item.variant_group_id ? String(item.variant_group_id) : '',
        variant_value: item.variant_value || '',
        variant_parent_name: item.variant_parent_name || '',
        // Tile colour (Loyverse study L2): the no-image tile's look.
        tile_color: item.tile_color || '',
        tile_shape: item.tile_shape || '',
      }));

      return {
        status: true,
        data: list,
        next_offset: nextOffset,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in ItemRepository.getOnlineSalesItems:', error);
      return {
        status: false,
        data: null,
        message: error.message || 'Failed to load items',
      };
    }
  }

  async createInstantItem(data = {}, context = {}) {
    try {
      const branchId = context.branchId;
      if (!branchId) {
        return { status: false, message: 'Branch context is required' };
      }

      const licenseId = context.licenseId || BaseModel.license;
      if (!licenseId) {
        return { status: false, message: 'License context is required' };
      }

      const branchObjectId = ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;

      let branchDoc = null;
      try {
        branchDoc = await Branch.findById(branchObjectId).lean();
      } catch (error) {
        console.warn('Unable to load branch for instant item:', error.message);
      }

      const branchName =
        (branchDoc && branchDoc.branch_name) || context.branchName || 'Primary Branch';

      let supplierId = null;
      let supplierName = '';
      if (branchDoc && branchDoc.default_supplier) {
        const supplierCollection = await this.getCollection('suppliers');
        try {
          const supplierDoc = await supplierCollection.findOne({
            _id: new ObjectId(branchDoc.default_supplier),
            license: licenseObjectId,
          });
          if (supplierDoc) {
            supplierId = supplierDoc._id;
            supplierName = supplierDoc.name || '';
          }
        } catch (error) {
          console.warn('Unable to load default supplier for instant item:', error.message);
        }
      }

      const now = new Date();
      const sku = (data.items_sku || '').trim() || `INST-${Date.now()}`;
      const categoryId =
        data.items_category_id && ObjectId.isValid(data.items_category_id)
          ? new ObjectId(data.items_category_id)
          : null;

      const document = withSearchIndex({
        license: licenseObjectId,
        branch_access: [
          {
            branch_id: branchObjectId,
            branch_name: branchName,
          },
        ],
        created_date: now,
        created_by: context.userName || 'System',
        creation_origin: itemCreationOrigin.record('quick_item', context, now),
        created_by_id:
          (context.userId && ObjectId.isValid(context.userId)
            ? new ObjectId(context.userId)
            : context.userId) || null,
        updated_date: now,
        updated_by: context.userName || 'System',
        updated_by_id:
          (context.userId && ObjectId.isValid(context.userId)
            ? new ObjectId(context.userId)
            : context.userId) || null,
        name: (data.items_name || '').trim(),
        date: now,
        itemid: sku,
        barcode_id: sku,
        supplier_name: supplierName,
        ...(supplierId ? { supplier_id: supplierId } : {}),
        category_name: (data.items_category_name || '').trim(),
        ...(categoryId ? { category_id: categoryId } : {}),
        discount_amount: parseFloat(data.items_discount_amount) || 0,
        discount_percentage: parseFloat(data.items_discount_percentage) || 0,
        mrp_price: parseFloat(data.items_mrp_price) || 0,
        company_price: parseFloat(data.items_company_price) || 0,
        selling_price: parseFloat(data.items_selling_price) || 0,
        available_quantity: parseInt(data.items_quantity, 10) || 0,
        image: DEFAULTS.IMAGE,
        sort_order: 0,
        track_inventory: false,
        // Instant lines sell any quantity - stock never blocks them.
        negative_stock: true,
        item_status: ITEM_STATUS.INSTANT,
      });

      const collection = await this.getCollection(this.collectionName);
      document.createdAt = now;
      document.updatedAt = now;
      const insertResult = await collection.insertOne(document);
      const inserted = { ...document, _id: insertResult.insertedId };
      const simplified = BaseModel.simplifyFields(inserted);
      simplified.branchSharing = await require('../services/catalogue-sharing').automatic([
        insertResult.insertedId,
      ]);

      return {
        status: true,
        data: simplified,
        message: SUCCESS_MESSAGES.ITEM_CREATED,
      };
    } catch (error) {
      console.error('Error in ItemRepository.createInstantItem:', error);
      return {
        status: false,
        data: null,
        message: error.message || 'Failed to create instant item',
      };
    }
  }

  async deleteInstantItem(id, context = {}) {
    try {
      if (!id || !ObjectId.isValid(id)) {
        return { status: false, message: 'Valid item id is required' };
      }

      const collection = await this.getCollection(this.collectionName);

      const filter = { _id: new ObjectId(id) };

      const branchId = context.branchId || null;
      if (branchId) {
        const branchObjectId = this.toObjectId(branchId);
        filter.$or = [{ branch_id: branchObjectId }, { 'branch_access.branch_id': branchObjectId }];
      }

      const licenseId = context.licenseId || null;
      if (licenseId) {
        filter.license = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;
      }

      const existing = await collection.findOne(filter);
      if (!existing) {
        return { status: false, message: ERROR_MESSAGES.ITEM_NOT_FOUND };
      }

      /* Tombstoned, not removed - see deleteItems above. */
      const now = new Date();
      const deleteResult = await collection.updateOne(filter, {
        $set: { del_status: 1, deleted_date: now, updated_date: now },
      });

      return {
        status: true,
        data: deleteResult.modifiedCount,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in ItemRepository.deleteInstantItem:', error);
      return {
        status: false,
        data: null,
        message: error.message || 'Failed to delete instant item',
      };
    }
  }

  async getReceivingItemsAjaxList(params = {}, context = {}) {
    try {
      const { type, query } = params || {};

      const branchId = context.branchId;
      const licenseId = context.licenseId;
      const limit = parseInt(context.limit, 10) || 10; // Default limit for autocomplete

      const collection = await this.getCollection(this.collectionName);

      if (!branchId) {
        console.error('getReceivingItemsAjaxList: branchId is not set');
        return { status: false, data: null, message: 'Branch ID not found' };
      }

      // Ensure branchId is converted to ObjectId for proper MongoDB comparison
      let branchObjectId;
      if (branchId instanceof ObjectId) {
        branchObjectId = branchId;
      } else if (typeof branchId === 'string' && ObjectId.isValid(branchId)) {
        branchObjectId = new ObjectId(branchId);
      } else if (branchId && branchId._bsontype === 'ObjectId') {
        branchObjectId = new ObjectId(branchId.toString());
      } else {
        branchObjectId = branchId;
      }

      let licenseObjectId;
      if (licenseId instanceof ObjectId) {
        licenseObjectId = licenseId;
      } else if (typeof licenseId === 'string' && ObjectId.isValid(licenseId)) {
        licenseObjectId = new ObjectId(licenseId);
      } else if (licenseId && licenseId._bsontype === 'ObjectId') {
        licenseObjectId = new ObjectId(licenseId.toString());
      } else {
        licenseObjectId = licenseId;
      }

      const regex = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

      const searchConditions =
        type === 'barcode'
          ? [{ barcode_id: regex }, { barcodes: regex }]
          : [
              { name: regex },
              { stock_locations: regex },
              { 'translations.name': regex },
              { itemid: regex },
              { barcode_id: regex },
              { barcodes: regex },
            ];

      // Build the filter matching PHP logic exactly
      const whereConditions = [
        { 'branch_access.branch_id': branchObjectId },
        { item_status: { $ne: ITEM_STATUS.INSTANT } },
      ];

      if (licenseObjectId) {
        whereConditions.push({ license: licenseObjectId });
      }

      if (type === 'id') {
        if (!ObjectId.isValid(query)) return { status: false, message: 'Invalid item' };
        whereConditions.push({ _id: new ObjectId(query) });
      } else if (regex) {
        whereConditions.push({ $or: searchConditions });
      }
      const filter = { $and: whereConditions };

      const items = await collection.find(filter).limit(limit).toArray();

      const list = items.map((item) => ({
        item_id: item._id?.toString() || '',
        item_name: item.name || '',
        ...itemText.snapshot(item),
        selling_price: item.selling_price || 0,
        item_code: item.itemid || '',
        item_unit: item.unit || 'qty',
        // Unit conversion (V3): the receiving screen's box->base assist.
        purchase_unit: item.purchase_unit || '',
        stock_locations: require('../helpers/stock-locations').read(item),
        conversion_factor: Number(item.conversion_factor) || 0,
        company_price: item.company_price || 0,
        discount_amount: item.discount_amount || 0,
        discount_percentage: item.discount_percentage || 0,
        category_id: item.category_id?.toString() || '',
        category_name: item.category_name || '',
        image: item.image || DEFAULTS.IMAGE,
        supplier_id: item.supplier_id?.toString() || '',
        supplier_name: item.supplier_name || '',
        // Additive: the stock-adjustment search shows current stock.
        available_quantity: item.available_quantity || 0,
        // Additive: the redesigned typeahead rows show stock state.
        track_inventory: item.track_inventory !== false,
        item_kind: item.item_kind || 'product',
        tile_color: item.tile_color || '',
        tile_shape: item.tile_shape || '',
      }));

      return { status: true, data: list, message: 'success' };
    } catch (error) {
      console.error('Error in ItemRepository.getReceivingItemsAjaxList:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  /*
   * Every item a supplier supplies, optionally only the ones running low
   * (Loyverse study L2: the receiving screen's "all items from supplier /
   * low-stock items from supplier" autofill). Same row shape as the
   * receiving autocomplete so the client's add-line path is reused as-is.
   * Low stock uses the caller's notification range - the same number the
   * low-stock dashboard runs on - and only counts tracked items.
   */
  async getItemsBySupplier(params = {}, context = {}) {
    try {
      const { supplierId, lowStockOnly, notificationRange } = params || {};
      const branchId = context.branchId;
      const licenseId = context.licenseId;

      if (!branchId) return { status: false, data: null, message: 'Branch ID not found' };
      if (!supplierId || !ObjectId.isValid(String(supplierId))) {
        return { status: false, data: null, message: 'A valid supplier is required' };
      }

      const collection = await this.getCollection(this.collectionName);
      const conditions = [
        { 'branch_access.branch_id': new ObjectId(String(branchId)) },
        { item_status: { $ne: ITEM_STATUS.INSTANT } },
        { supplier_id: new ObjectId(String(supplierId)) },
        /* A deleted product is not purchasable. Every other item query
           carries NOT_DELETED; this one did not, so the purchase picker
           happily offered items the catalogue had already removed - the
           owner found it as "item list not showing but purchase shows
           all items", which is the same fact seen from both ends. */
        NOT_DELETED,
      ];
      if (licenseId && ObjectId.isValid(String(licenseId))) {
        conditions.push({ license: new ObjectId(String(licenseId)) });
      }
      if (lowStockOnly) {
        const range = parseInt(notificationRange, 10);
        const fallback = Number.isFinite(range) ? range : 10;
        conditions.push({ track_inventory: true });
        // The item's own reorder point wins where set (LS1).
        conditions.push({
          $expr: {
            $lte: [
              { $convert: { input: '$available_quantity', to: 'double', onError: 0, onNull: 0 } },
              { $ifNull: ['$reorder_point', fallback] },
            ],
          },
        });
      }

      const items = await collection.find({ $and: conditions }).limit(500).toArray();

      const list = items.map((item) => ({
        item_id: item._id?.toString() || '',
        item_name: item.name || '',
        ...itemText.snapshot(item),
        selling_price: item.selling_price || 0,
        item_code: item.itemid || '',
        item_unit: item.unit || 'qty',
        purchase_unit: item.purchase_unit || '',
        stock_locations: require('../helpers/stock-locations').read(item),
        conversion_factor: Number(item.conversion_factor) || 0,
        company_price: item.company_price || 0,
        discount_amount: item.discount_amount || 0,
        discount_percentage: item.discount_percentage || 0,
        category_id: item.category_id?.toString() || '',
        category_name: item.category_name || '',
        image: item.image || DEFAULTS.IMAGE,
        supplier_id: item.supplier_id?.toString() || '',
        supplier_name: item.supplier_name || '',
        available_quantity: item.available_quantity || 0,
      }));

      /* Incoming (PO step 3): what is already on an open order, so a shop
         does not double-order it. Display-only, fail-safe to zero. */
      const { incomingByItem } = require('../services/incoming-stock');
      const incoming = await incomingByItem(
        { branchId, licenseId },
        list.map((row) => row.item_id)
      );
      for (const row of list) {
        row.incoming = incoming[row.item_id] || 0;
      }

      return { status: true, data: list, message: 'success' };
    } catch (error) {
      console.error('Error in ItemRepository.getItemsBySupplier:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  /*
   * Reasoned per-item stock adjustment (Loyverse study L2). Three reasons,
   * two behaviours: an Inventory count SETS stock to what was counted; Loss
   * and Damage SUBTRACT what disappeared (clamped at zero). Every change is
   * a stock-log row with the reason as its process - an adjustment is a
   * movement with an audit trail, never a silent overwrite. Receiving stock
   * is deliberately not a reason here: that is the receiving screen's job.
   */
  async stockAdjustment(params = {}, context = {}) {
    const { reason, note, rows } = params;
    /* The item row and its audit log are one change. If the log cannot be
       written, or a later row throws, every row already written by this call
       is restored and its fresh log is removed. The bundled MongoDB runs as a
       standalone server, so this is an all-or-compensate write rather than a
       server transaction. */
    const applied = [];
    const createdLogIds = [];
    let collection = null;
    let stockLogsCollection = null;
    let now = null;
    let updated = 0;
    let skipped = 0;

    const rollbackApplied = async () => {
      let failures = 0;
      for (let index = applied.length - 1; index >= 0; index -= 1) {
        const change = applied[index];
        try {
          const restored = await collection.updateOne(
            {
              _id: change.itemId,
              $or: [
                { available_quantity: change.newV },
                { available_quantity: String(change.newV) },
              ],
            },
            {
              $set: {
                available_quantity: change.oldV,
                updated_date: now,
                updated_by: context.userName || '',
                updated_by_id: context.userId || null,
              },
            }
          );
          if (!restored || restored.modifiedCount !== 1) failures += 1;
        } catch (error) {
          failures += 1;
        }
      }
      if (createdLogIds.length) {
        try {
          await stockLogsCollection.deleteMany({ _id: { $in: createdLogIds.slice() } });
        } catch (error) {
          failures += 1;
        }
      }
      return failures;
    };

    try {
      /*
       * LS1: reasons are configurable text now, each with an explicit
       * direction. The three originals keep their implied modes so older
       * clients stay correct; anything else must SAY its direction - a
       * custom reason with no mode is refused, never guessed.
       */
      const SEED_REASONS = {
        'Inventory count': 'set',
        Loss: 'subtract',
        Damage: 'subtract',
        'Stock found': 'add',
      };
      const cleanReason = String(reason || '')
        .trim()
        .slice(0, 60);
      const requestedMode = params && params.mode;
      const mode = ['set', 'subtract', 'add'].includes(requestedMode)
        ? requestedMode
        : SEED_REASONS[cleanReason];
      if (!cleanReason || !mode) {
        return {
          status: false,
          data: null,
          message: 'Pick a reason and its direction (count sets, loss/damage subtract, found adds)',
        };
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return { status: false, data: null, message: 'Add at least one item to adjust' };
      }
      if (rows.length > 200) {
        return { status: false, data: null, message: 'At most 200 items per adjustment' };
      }
      const branchId = context.branchId;
      if (!branchId) return { status: false, data: null, message: 'Branch ID not found' };
      const branchObjectId = new ObjectId(String(branchId));
      const licenseObjectId =
        context.licenseId && ObjectId.isValid(String(context.licenseId))
          ? new ObjectId(String(context.licenseId))
          : null;

      collection = await this.getCollection(this.collectionName);
      stockLogsCollection = await this.getCollection('stocklogs');
      const branchesCollection = await this.getCollection('branches');
      const branchDoc = await branchesCollection.findOne({ _id: branchObjectId });
      const stockLogStatus = branchDoc?.stock_management_log !== false;
      const stockLogsRepository = new StockLogsRepository();
      const cleanNote = String(note || '')
        .trim()
        .slice(0, 500);
      now = new Date();

      const updatedItemIds = [];
      for (const row of rows) {
        const qty = Number(row && row.qty);
        if (!row || !ObjectId.isValid(String(row.item_id)) || !Number.isFinite(qty) || qty < 0) {
          skipped += 1;
          continue;
        }
        const filter = {
          _id: new ObjectId(String(row.item_id)),
          'branch_access.branch_id': branchObjectId,
        };
        if (licenseObjectId) filter.license = licenseObjectId;
        const item = await collection.findOne(filter, {
          projection: {
            available_quantity: 1,
            name: 1,
            barcode_id: 1,
            track_inventory: 1,
            branch_id: 1,
          },
        });
        if (!item) {
          skipped += 1;
          continue;
        }
        const oldV = Number(item.available_quantity) || 0;
        const newV = mode === 'set' ? qty : mode === 'add' ? oldV + qty : Math.max(0, oldV - qty);
        if (newV === oldV) {
          skipped += 1;
          continue;
        }
        /* Compare-and-set: a concurrent sale that moved this item between the
           read and the write must not be overwritten by a stale count. */
        const write = await collection.updateOne(
          {
            _id: item._id,
            $or: [{ available_quantity: oldV }, { available_quantity: String(oldV) }],
          },
          {
            $set: {
              available_quantity: newV,
              updated_date: now,
              updated_by: context.userName || '',
              updated_by_id: context.userId || null,
            },
          }
        );
        if (!write || write.modifiedCount !== 1) {
          skipped += 1;
          continue;
        }
        applied.push({ itemId: item._id, oldV, newV });
        updated += 1;
        updatedItemIds.push(String(item._id));

        if (item.track_inventory === true) {
          // Same count convention as every other stock writer: old - new,
          // negated when stock went up.
          const diff = oldV - newV;
          const count = diff < 0 ? String(Math.abs(diff)) : '-' + String(diff);
          const logResult = await stockLogsRepository.createStockLog({
            stocklog: stockLogStatus,
            branch_id: branchObjectId || item.branch_id || null,
            view_item_id: item._id,
            item_barcode_id: item.barcode_id,
            item_name: item.name,
            item_quantity: String(newV),
            process: cleanReason,
            reference: item.barcode_id,
            note: cleanNote,
            date: now,
            action: 'Add',
            opening_balance: String(oldV),
            closing_balance: String(newV),
            count: count,
            changed_by_userid: context.userId,
            changed_by: context.userName,
          });
          if (logResult && logResult.status === false) {
            const rollbackFailures = await rollbackApplied();
            applied.length = 0;
            createdLogIds.length = 0;
            return {
              status: false,
              data: {
                updated: 0,
                skipped,
                ...(rollbackFailures ? { rollback_failures: rollbackFailures } : {}),
              },
              message: rollbackFailures
                ? 'The stock change could not be undone completely. Check the affected items before retrying.'
                : 'The stock change was not saved because its stock log could not be written.',
            };
          }
          const logId = logResult && logResult.data && logResult.data._id;
          if (logId) createdLogIds.push(logId);
        }
      }

      return {
        status: true,
        data: { updated, skipped, updatedItemIds },
        message:
          updated > 0 ? `Adjusted ${updated} item(s)` : 'Nothing changed - stock already matched',
      };
    } catch (error) {
      let rollbackFailures = 0;
      if (collection && (applied.length || createdLogIds.length)) {
        rollbackFailures = await rollbackApplied();
      }
      console.error('Error in ItemRepository.stockAdjustment:', error);
      return {
        status: false,
        data: rollbackFailures ? { rollback_failures: rollbackFailures } : null,
        message: rollbackFailures
          ? 'The stock change could not be undone completely. Check the affected items before retrying.'
          : error.message,
      };
    }
  }

  async getItemsByCategoryId(categoryId, context = {}) {
    try {
      if (!categoryId) {
        return { status: false, data: null, message: 'Category ID required' };
      }

      const collection = await this.getCollection(this.collectionName);

      const branchId = context.branchId || null;
      const licenseId = context.licenseId || null;

      const branchObjectId =
        branchId && ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const categoryObjectId = this.toObjectId(categoryId);
      const licenseObjectId =
        licenseId && ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;

      const conditions = [
        { del_status: { $nin: [1, '1', true] } },
        { item_status: { $ne: ITEM_STATUS.INSTANT } },
        { available_for_sale: { $ne: false } },
        {
          $or: [{ available_quantity: { $gt: 0 } }, { negative_stock: true }],
        },
        { category_id: categoryObjectId },
      ];

      if (branchObjectId) {
        conditions.unshift({ 'branch_access.branch_id': branchObjectId });
      }

      if (licenseObjectId) {
        conditions.push({ license: licenseObjectId });
      }

      const filter = { $and: conditions };

      const items = await collection.find(filter).toArray();
      const list = items
        .filter(
          (item) =>
            item.track_inventory === false ||
            item.negative_stock === true ||
            item.available_quantity > 0
        )
        .map((item) => ({
          item_id: item._id?.toString() || '',
          item_name: item.name || '',
          ...itemText.snapshot(item),
          selling_price: item.selling_price || 0,
          itemid: item.itemid || '',
          available_quantity: String(item.available_quantity || 0),
          items_expiry_date: item.items_expiry_date ? String(item.items_expiry_date) : '',
          company_price: item.company_price || 0,
          discount_amount: item.discount_amount || 0,
          discount_percentage: item.discount_percentage || 0,
          category_id: item.category_id?.toString() || '',
          category_name: item.category_name || '',
          image: item.image || DEFAULTS.IMAGE,
          supplier: item.supplier_name || '',
          negative_stock: item.negative_stock || false,
        }));

      return { status: true, data: list, message: 'success' };
    } catch (error) {
      console.error('Error in ItemRepository.getItemsByCategoryId:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async itemSearchPage(params = {}, context = {}) {
    try {
      const collection = await this.getCollection(this.collectionName);

      const branchId = context.branchId || null;
      const licenseId = context.licenseId || null;

      const branchObjectId =
        branchId && ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId =
        licenseId && ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;

      const startingPrice = params.startingPrice;
      const endingPrice = params.endingPrice;
      const filterValue = params.filterValue;
      const options = params.options || {};

      const limit = parseInt(options.limit, 10) || 52;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const filter = {
        $and: [
          { 'branch_access.branch_id': branchObjectId },
          { item_status: { $ne: 'instant' } },
          { available_for_sale: { $ne: false } },
          {
            selling_price: {
              $gte: parseInt(startingPrice, 10) || 0,
              $lte: parseInt(endingPrice, 10) || 999999,
            },
          },
          { license: licenseObjectId }, // Required like PHP (line 1901)
        ],
      };

      /*
       * The catalog screen is a shop window, not a report: typing a name,
       * barcode or category narrows the shelf itself. Escape the term so a
       * customer's search text can never become a query operator.
       */
      const search = String(params.search || '').trim();
      if (search) {
        const term = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$and.push({
          $or: [
            { name: { $regex: term, $options: 'i' } },
            { item_name: { $regex: term, $options: 'i' } },
            { barcode_id: { $regex: term, $options: 'i' } },
            { item_id: { $regex: term, $options: 'i' } },
            { sku: { $regex: term, $options: 'i' } },
            { category_name: { $regex: term, $options: 'i' } },
          ],
        });
      }

      // Match PHP sort logic (item_model.php lines 1907-1912)
      let sort = { name: 1 };
      if (filterValue === 'new') {
        sort = { _id: -1 }; // Sort by ObjectId descending = newest first
      } else if (filterValue === 'low') {
        sort = { selling_price: 1 };
      } else if (filterValue === 'high') {
        sort = { selling_price: -1 };
      }

      const [total, items] = await Promise.all([
        collection.countDocuments(filter),
        collection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      ]);

      const list = items.map((item) => ({
        _id: item._id?.toString() || '',
        item_name: item.name || '',
        ...itemText.snapshot(item),
        discount_amount: item.discount_amount || 0,
        discount_percentage: item.discount_percentage || 0,
        selling_price: item.selling_price || 0,
        category_name: item.category_name || '',
        image: item.image || DEFAULTS.IMAGE,
      }));

      return {
        status: true,
        total,
        current_page: page,
        total_pages: Math.ceil(total / limit),
        per_page: limit,
        list,
      };
    } catch (error) {
      console.error('Error in ItemRepository.itemSearchPage:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async quickPatch(id, fields, context) {
    try {
      const collection = await this.getCollection(this.collectionName);
      const objectId = ObjectId.isValid(id) ? new ObjectId(id) : id;
      const set = {};
      if (fields.selling_price !== undefined) {
        const v = parseFloat(fields.selling_price);
        if (Number.isFinite(v) && v >= 0) set.selling_price = Math.round(v * 100) / 100;
      }
      if (fields.discount_percentage !== undefined) {
        const v = parseFloat(fields.discount_percentage);
        if (Number.isFinite(v) && v >= 0 && v <= 100) {
          set.discount_percentage = v;
          set.discount_amount = 0;
        }
      }
      if (fields.discount_amount !== undefined) {
        const v = parseFloat(fields.discount_amount);
        if (Number.isFinite(v) && v >= 0) {
          set.discount_amount = Math.round(v * 100) / 100;
          set.discount_percentage = 0;
        }
      }
      if (!Object.keys(set).length) {
        return { status: false, message: 'Nothing to update' };
      }
      set.updated_date = new Date();
      const result = await collection.updateOne(
        {
          _id: objectId,
          ...require('../utils/record-scope').scope(context),
          ...(set.selling_price !== undefined ? sellingPriceHold.writable(set.selling_price) : {}),
        },
        { $set: set }
      );
      if (!result.matchedCount)
        return {
          status: false,
          message: 'Item not found or selling price is held. Review it in Edit prices.',
        };
      return { status: true, message: 'Item updated' };
    } catch (error) {
      console.error('Error in ItemRepository.quickPatch:', error);
      throw error;
    }
  }

  async updateItemQuantity(id, value, context) {
    try {
      const collection = await this.getCollection(this.collectionName);
      const objectId = ObjectId.isValid(id) ? new ObjectId(id) : id;

      const quantity = Number(value);
      if (value === '' || value === null || !Number.isFinite(quantity))
        throw new Error('Invalid quantity');
      const result = await collection.updateOne(
        { _id: objectId, ...require('../utils/record-scope').scope(context) },
        { $set: { available_quantity: quantity } }
      );
      if (!result.matchedCount) return { status: false, message: 'Item not found' };

      return { status: true, message: 'Quantity updated' };
    } catch (error) {
      console.error('Error in ItemRepository.updateItemQuantity:', error);
      throw error;
    }
  }

  async categoryProductDetails(data = {}, context = {}) {
    try {
      const collection = await this.getCollection(this.collectionName);
      const categoryId = data.category_id;
      const branchIds = Array.isArray(data.branchid) ? data.branchid : [data.branchid];

      const branchObjectIds = branchIds
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      const categoryObjectId = ObjectId.isValid(categoryId) ? new ObjectId(categoryId) : categoryId;

      const options = context.options || {};
      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const filter = {
        'branch_access.branch_id': { $in: branchObjectIds },
        category_id: categoryObjectId,
      };

      const licenseId = context.licenseId || null;
      if (licenseId) {
        filter.license = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;
      }

      const [total, items, aggregation] = await Promise.all([
        collection.countDocuments(filter),
        collection.find(filter).skip(skip).limit(limit).toArray(),
        collection
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: {
                  category_id: '$category_id',
                  category_name: '$category_name',
                },
                selling_price: { $sum: '$selling_price' },
                item_count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
      ]);

      const totalData = aggregation[0] || {};
      return {
        status: true,
        data: {
          table: {
            data: {
              total,
              current_page: page,
              total_pages: Math.ceil(total / limit),
              per_page: limit,
              list: items.map((i) => {
                const simplified = stripRemovedItemFields(BaseModel.simplifyFields(i));

                // Attach string_date for frontend Product history table.
                // Prefer updated_date, then created_date, then the generic
                // date field we set during item updates.
                const rawDate =
                  i.updated_date ||
                  i.created_date ||
                  i.date ||
                  simplified.updated_date ||
                  simplified.created_date ||
                  simplified.date ||
                  null;

                return {
                  ...simplified,
                  string_date: rawDate ? formatDate(rawDate) : '',
                };
              }),
            },
          },
          total: {
            total: Math.round((totalData.selling_price || 0) * 100) / 100,
            count: totalData.item_count || 0,
            name: totalData._id?.supplier_name || '',
          },
        },
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in ItemRepository.categoryProductDetails:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async supplierProductDetails(data = {}, context = {}) {
    try {
      const collection = await this.getCollection(this.collectionName);
      const supplierId = data.supplier_id;
      const branchIds = Array.isArray(data.branchid) ? data.branchid : [data.branchid];

      const branchObjectIds = branchIds
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      const supplierObjectId = ObjectId.isValid(supplierId) ? new ObjectId(supplierId) : supplierId;

      const options = context.options || {};
      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const filter = {
        'branch_access.branch_id': { $in: branchObjectIds },
        supplier_id: supplierObjectId,
      };

      const licenseId = context.licenseId || null;
      if (licenseId) {
        filter.license = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;
      }

      const [total, items, aggregation] = await Promise.all([
        collection.countDocuments(filter),
        collection.find(filter).skip(skip).limit(limit).toArray(),
        collection
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: {
                  supplier_id: '$supplier_id',
                  supplier_name: '$supplier_name',
                },
                selling_price: { $sum: '$selling_price' },
                item_count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
      ]);

      const totalData = aggregation[0] || {};
      return {
        status: true,
        data: {
          table: {
            data: {
              total,
              current_page: page,
              total_pages: Math.ceil(total / limit),
              per_page: limit,
              list: items.map((i) => {
                const simplified = stripRemovedItemFields(BaseModel.simplifyFields(i));

                // Attach string_date for Supplier Based Product -> Product history.
                // Prefer updated_date, then created_date, then the legacy date field.
                const rawDate =
                  i.updated_date ||
                  i.created_date ||
                  i.date ||
                  simplified.updated_date ||
                  simplified.created_date ||
                  simplified.date ||
                  null;

                return {
                  ...simplified,
                  string_date: rawDate ? formatDate(rawDate) : '',
                };
              }),
            },
          },
          total: {
            total: Math.round((totalData.selling_price || 0) * 100) / 100,
            count: totalData.item_count || 0,
            name: totalData._id?.supplier_name || '',
          },
        },
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in ItemRepository.supplierProductDetails:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getCustomerSearchItems(query, context = {}) {
    try {
      const collection = await this.getCollection(this.collectionName);

      const branchId = context.branchId || null;
      const licenseId = context.licenseId || null;

      const rawLimit = context.limit;
      const limit =
        Number.isFinite(Number(rawLimit)) && Number(rawLimit) > 0 ? Number(rawLimit) : 5;

      const branchObjectId =
        branchId && ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId =
        licenseId && ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;

      const regex = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

      const filter = {
        $and: [
          regex
            ? {
                $or: [
                  { name: regex },
                  { stock_locations: regex },
                  { 'translations.name': regex },
                  { itemid: regex },
                  { barcode_id: regex },
                ],
              }
            : {},
          { 'branch_access.branch_id': branchObjectId },
          { item_status: { $ne: ITEM_STATUS.INSTANT } },
          { available_for_sale: { $ne: false } },
          ...(licenseObjectId ? [{ license: licenseObjectId }] : []),
        ].filter((f) => Object.keys(f).length > 0),
      };

      const items = await collection.find(filter).limit(5).toArray();

      const list = items.map((item) => ({
        item_id: item._id?.toString() || '',
        item_name: item.name || '',
        ...itemText.snapshot(item),
        selling_price: item.selling_price || 0,
        itemid: item.itemid || '',
        available_quantity: String(item.available_quantity || 0),
        category_id: item.category_id?.toString() || '',
        category_name: item.category_name || '',
        image: item.image || DEFAULTS.IMAGE,
      }));

      return { status: true, data: list, message: 'success' };
    } catch (error) {
      console.error('Error in ItemRepository.getCustomerSearchItems:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async itemStockReportTable(data = {}, context = {}) {
    try {
      console.log('-----------------------------------------------------------------------------');

      // Apply session filtering if dates are provided
      if (data.starting_date || data.ending_date) {
        // Note: This is a stock report showing current inventory,
        // but applying session filter as requested
        const startDate = data.starting_date ? new Date(data.starting_date) : null;
        const endDate = data.ending_date ? new Date(data.ending_date) : null;

        // For stock reports, we could filter by items that were last updated/modified within the date range
        // but stock reports typically show current inventory regardless of date
      }

      const collection = await this.getCollection(this.collectionName);

      const branchIds = Array.isArray(data.branchid) ? data.branchid : [data.branchid];

      console.log('\ud83d\udd0d itemStockReportTable - Input branchIds:', branchIds);

      const branchObjectIds = branchIds
        .filter((id) => id && ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      console.log('\ud83d\udd0d itemStockReportTable - Converted ObjectIds:', branchObjectIds);

      const options = context.options || {};
      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const filter = {
        'branch_access.branch_id': { $in: branchObjectIds },
        track_inventory: true,
      };

      const licenseId = context.licenseId;
      if (licenseId) {
        filter.license = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;
      }

      // Catalogue writes use created_date; older imported records can use
      // createdAt. Apply the existing report range to either representation.
      if (data.starting_date || data.ending_date) {
        const created = { $ifNull: ['$created_date', '$createdAt'] };
        const dateConditions = [];
        if (data.starting_date) {
          dateConditions.push({ $gte: [created, new Date(data.starting_date)] });
        }
        if (data.ending_date) {
          dateConditions.push({ $lte: [created, new Date(data.ending_date)] });
        }
        filter.$expr = { $and: dateConditions };
      }

      console.log('\ud83d\udd0d itemStockReportTable - Filter:', JSON.stringify(filter, null, 2));

      const [total, items, allItemsForTotals] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter, {
            projection: {
              name: 1,
              itemid: 1,
              available_quantity: 1,
              selling_price: 1,
              company_price: 1,
              category_name: 1,
            },
          })
          .sort({ available_quantity: 1, name: 1, _id: 1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        // Fetch all items to calculate grand totals
        collection
          .find(filter, {
            projection: {
              available_quantity: 1,
              selling_price: 1,
              company_price: 1,
            },
          })
          .toArray(),
      ]);

      // Calculate grand totals from ALL items
      let sellingTotal = 0;
      let companyTotal = 0;

      allItemsForTotals.forEach((item) => {
        const availableQty = item.available_quantity || 0;
        const sellingPrice = item.selling_price || 0;
        const companyPrice = item.company_price || 0;

        sellingTotal += Math.round(sellingPrice * availableQty * 100) / 100;
        companyTotal += Math.round(companyPrice * availableQty * 100) / 100;
      });

      const list = items.map((item) => {
        const availableQty = item.available_quantity || 0;
        const sellingPrice = item.selling_price || 0;
        const companyPrice = item.company_price || 0;

        const itemSellingTotal = Math.round(sellingPrice * availableQty * 100) / 100;
        const itemCompanyTotal = Math.round(companyPrice * availableQty * 100) / 100;

        const simplified = BaseModel.simplifyFields(item);

        return {
          _id: simplified._id || simplified.id,
          name: simplified.name || item.name,
          itemid: simplified.itemid || item.itemid,
          category_name: simplified.category_name || item.category_name,
          selling_price: Math.round(sellingPrice * 100) / 100,
          available_quantity: availableQty,
          company_price: Math.round(companyPrice * 100) / 100,
          company_total: itemCompanyTotal,
          selling_total: itemSellingTotal,
          id: simplified.id || simplified._id,
        };
      });

      return {
        status: true,
        total,
        current_page: page,
        total_pages: Math.ceil(total / limit),
        per_page: limit,
        list,
        selling_total: sellingTotal,
        company_total: companyTotal,
      };
    } catch (error) {
      console.error('Error in ItemRepository.itemStockReportTable:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getQuantityCount(match = {}) {
    const collection = await this.getCollection(this.collectionName);

    const [count, listDocs] = await Promise.all([
      collection.countDocuments(match),
      collection
        .find(match, {
          projection: {
            name: 1,
            created_date: 1,
            available_quantity: 1,
          },
        })
        .sort({ available_quantity: 1, name: 1 })
        .limit(5)
        .toArray(),
    ]);

    return { count, listDocs };
  }

  async categoryItemsReportTable({ countPipeline = [], paginatedPipeline = [] } = {}) {
    // Check if pipeline contains date filtering (session filter applied)
    const hasDateFilter = paginatedPipeline.some(
      (stage) =>
        stage.$match &&
        stage.$match.updated_date &&
        (stage.$match.updated_date.$gte || stage.$match.updated_date.$lte)
    );

    if (hasDateFilter) {
      const dateMatchStage = paginatedPipeline.find(
        (stage) => stage.$match && stage.$match.updated_date
      );
    }

    const collection = await this.getCollection(this.collectionName);

    const countResult = await collection.aggregate(countPipeline).toArray();
    const total = countResult.length;

    const results = await collection.aggregate(paginatedPipeline).toArray();

    return { total, results };
  }

  async supplierItemsReportTable({ pipeline = [], countPipeline = [] } = {}) {
    // Check if pipeline contains date filtering (session filter applied)
    const hasDateFilter = pipeline.some(
      (stage) =>
        stage.$match &&
        stage.$match.updated_date &&
        (stage.$match.updated_date.$gte || stage.$match.updated_date.$lte)
    );

    if (hasDateFilter) {
      const dateMatchStage = pipeline.find((stage) => stage.$match && stage.$match.updated_date);
    }

    const collection = await this.getCollection(this.collectionName);

    const results = await collection.aggregate(pipeline).toArray();
    const countResults = await collection.aggregate(countPipeline).toArray();
    const total = countResults.length;

    return { total, results };
  }

  async itemReportTable({ filter = {}, skip = 0, limit = 5 } = {}) {
    const collection = await this.getCollection(this.collectionName);

    const items = await collection.find(filter).sort({ name: 1 }).skip(skip).limit(limit).toArray();

    const total = await collection.countDocuments(filter);

    return { items, total };
  }

  async priceGrid(query = {}, context = {}) {
    const filter = this.priceGridScope(context);
    filter.branch_id = {
      $in: require('../services/price-scope')
        .selected(context, query.branches)
        .map((v) => new ObjectId(v)),
    };
    const search = String(query.search || '')
      .trim()
      .slice(0, 100);
    if (search) {
      const literal = searchPattern(search);
      filter.$or = [
        { name: { $regex: literal, $options: 'i' } },
        { stock_locations: { $regex: literal, $options: 'i' } },
        { itemid: { $regex: literal, $options: 'i' } },
      ];
    }
    const categories = await require('../services/price-scope').categoryFilter(
      context,
      query.category,
      require('../services/price-scope').selected(context, query.branches)
    );
    if (categories) filter.category_id = categories;
    const page = Math.max(1, Math.min(100000, Math.floor(Number(query.page) || 1)));
    const pageSize = [10, 25, 50, 100].includes(Number(query.pageSize))
      ? Number(query.pageSize)
      : 50;
    const collection = await this.getCollection(this.collectionName);
    const [total, items] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .aggregate([
          { $match: filter },
          ...require('../utils/catalogue-order').stages(),
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          {
            $project: {
              name: 1,
              itemid: 1,
              unit: 1,
              selling_units: 1,
              stock_locations: 1,
              selling_price: 1,
              company_price: 1,
              mrp_price: 1,
              branch_id: 1,
              selling_price_hold_until: 1,
            },
          },
        ])
        .toArray(),
    ]);
    return { total, items, page, pageSize };
  }

  priceGridScope(context) {
    if (!ObjectId.isValid(context.branchId) || !ObjectId.isValid(context.licenseId)) {
      throw new Error('Branch and license are required');
    }
    return {
      branch_id: this.toObjectId(context.branchId),
      license: this.toObjectId(context.licenseId),
      ...NOT_DELETED,
    };
  }

  async savePriceGrid(rows, context = {}, allowZero = false) {
    const scope = this.priceGridScope(context);
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000)
      throw new Error('Provide 1 to 2000 price changes');
    const seen = new Set();
    for (const row of rows) {
      if (
        !row ||
        !ObjectId.isValid(row.id) ||
        seen.has(String(row.id)) ||
        typeof row.price !== 'number' ||
        !Number.isFinite(row.price) ||
        row.price < 0 ||
        row.price > 1000000000 ||
        (Math.round(row.price * 100) === 0 && !allowZero) ||
        typeof row.oldPrice !== 'number' ||
        !Number.isFinite(row.oldPrice)
      ) {
        throw new Error('Invalid or duplicate price change');
      }
      seen.add(String(row.id));
    }
    const collection = await this.getCollection(this.collectionName);
    const db = await BaseModel.getDb();
    const saved = [],
      conflicts = [];
    const batchId = new ObjectId();
    for (const row of rows) {
      const filter = { ...scope, _id: this.toObjectId(row.id), selling_price: row.oldPrice };
      const item = await collection.findOne(filter);
      if (!item) {
        conflicts.push(row.id);
        continue;
      }
      const price = Math.round(row.price * 100) / 100;
      if (price === 0 && !allowZero) throw new Error('Zero prices require confirmation');
      if (price === row.oldPrice) {
        saved.push(row.id);
        continue;
      }
      const now = new Date();
      const result = await collection.updateOne(
        { ...filter, ...sellingPriceHold.writable(price, now) },
        {
          $set: {
            selling_price: price,
            updated_date: now,
            updated_by: context.userName || '',
            updated_by_id: context.userId || null,
          },
        }
      );
      if (!result.modifiedCount) {
        conflicts.push(row.id);
        continue;
      }
      await db.collection('price_history').insertOne({
        item_id: item._id,
        item_name: item.name,
        branch_id: item.branch_id,
        license: scope.license,
        field: 'selling_price',
        label: 'Selling price',
        value_type: 'money',
        old_value: row.oldPrice,
        new_value: price,
        process: 'Bulk',
        batch_id: batchId,
        changed_by: context.userName || '',
        changed_by_id: context.userId || null,
        date: now,
        created_date: now,
        updated_date: now,
      });
      saved.push(row.id);
    }
    if (saved.length) {
      const now = new Date();
      await db.collection('bulk_price_updates').insertOne({
        _id: batchId,
        branch_id: scope.branch_id,
        license: scope.license,
        field: 'selling_price',
        label: 'Selling price',
        op: 'individual',
        scope: 'selected',
        items_changed: saved.length,
        items_skipped: conflicts.length,
        changed_by: context.userName || '',
        changed_by_id: context.userId || null,
        date: now,
        created_date: now,
        updated_date: now,
      });
    }
    return { saved, conflicts };
  }

  async importItems(data, context = {}) {
    return itemBarcodes.withWriteLock(context, () => this._importItems(data, context));
  }

  async _importItems(data, context = {}) {
    context = { ...context, creationBatchId: require('node:crypto').randomUUID() };
    const insertedIds = [],
      updatedIds = [];
    try {
      if (!Array.isArray(data) || data.length === 0) {
        return { status: false, data: null, message: 'No items to import' };
      }

      const collection = await this.getCollection(this.collectionName);

      const branchId = context.branchId || null;
      const licenseId = context.licenseId || null;

      if (!branchId || !licenseId) {
        return {
          status: false,
          data: null,
          message: 'Branch and license context required',
        };
      }

      const branchObjectId = ObjectId.isValid(branchId) ? new ObjectId(branchId) : branchId;
      const licenseObjectId = ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId;

      // Respect plan limits similar to PHP parent::checkPlan(self::$collectionName, 'import')
      const maxImport = await this.checkPlan(this.collectionName, 'import', context.user || null);
      const limitCount =
        typeof maxImport === 'number' && maxImport > 0
          ? Math.min(maxImport, data.length)
          : data.length;

      if (limitCount < data.length)
        return {
          status: false,
          data: null,
          message: `This import allows ${limitCount} rows. Split the file before importing; nothing was imported.`,
        };
      const limitedRows = data.slice(0, limitCount);

      // Step 1: Filter unique records from CSV data based on 'name' and 'itemid'
      const uniqueCSVRecords = new Map();
      const rowNumbers = new Map();
      for (const [index, raw] of limitedRows.entries()) {
        const item = { ...(raw || {}) };
        item.name = String(item.name ?? '').trim();
        item.itemid = String(item.itemid ?? '').trim();
        item.barcode_id = itemBarcodes.normalize(item.barcode_id);
        const key = JSON.stringify([item.name, item.itemid]);
        if (
          uniqueCSVRecords.has(key) &&
          JSON.stringify(uniqueCSVRecords.get(key)) !== JSON.stringify(item)
        ) {
          return {
            status: false,
            data: [
              {
                row: index + 2,
                name: item.name,
                status: 'Conflicting rows for the same item name and item ID.',
              },
            ],
            message: 'Conflicting duplicate items in CSV. Nothing was imported.',
          };
        }
        if (!uniqueCSVRecords.has(key)) {
          uniqueCSVRecords.set(key, item);
          rowNumbers.set(item, index + 2); // header occupies the first CSV row
        }
      }

      // Step 2: Validate CSV data (mirror PHP rules)
      const validationErrors = [];
      const requiredFields = [
        'name',
        'category_name',
        'discount_amount',
        'discount_percentage',
        'mrp_price',
        'company_price',
        'selling_price',
        'available_quantity',
        'unit',
        'sort_order',
      ];
      const numericFields = [
        'discount_amount',
        'discount_percentage',
        'mrp_price',
        'company_price',
        'selling_price',
        'available_quantity',
        'sort_order',
      ];

      const toNumberFromCsv = require('../helpers/import-values').importNumber;

      for (const item of uniqueCSVRecords.values()) {
        const errorFields = [];

        for (const field of requiredFields) {
          const value = item[field];
          const isEmpty = value === undefined || value === null || String(value).trim() === '';
          if (isEmpty && value !== '0' && value !== 0) {
            errorFields.push(field);
          }

          if (numericFields.includes(field)) {
            const num = toNumberFromCsv(value);
            if (
              !isEmpty &&
              (!Number.isFinite(num) ||
                (field !== 'available_quantity' && num < 0) ||
                (field === 'discount_percentage' && num > 100))
            ) {
              errorFields.push(
                `${field}: invalid, ambiguous or out-of-range number. Use 1234 for a whole number; 1234.56 or 1234,56 for decimals. For three decimal places, add a trailing zero (1.2340 or 1,2340).`
              );
            }
            item[field] = num;
          }
        }

        if (errorFields.length > 0) {
          validationErrors.push({
            ...item,
            row: rowNumbers.get(item),
            status: errorFields.join(', '),
          });
        }
      }

      if (validationErrors.length > 0) {
        return {
          status: false,
          type: 'error',
          data: validationErrors,
          message:
            'CSV validation failed. Correct the listed required fields and numbers; nothing was imported.',
        };
      }

      // Step 3: Check for existing items in DB (name + itemid + branch + license)
      const alreadyData = [];
      const documentsToInsert = [];
      /* A matched row is UPDATED, not skipped, so a re-import that changed only
         prices actually changes them. The matched document is remembered so the
         update below can touch just the columns the CSV carries and leave the
         image and everything else the CSV omits exactly as it was - which is
         what the export/re-import round trip used to destroy. */
      const existingByRow = new Map();

      for (const item of uniqueCSVRecords.values()) {
        const name = item.name || '';
        const itemId = item.itemid || '';

        const existing = await collection.findOne({
          $and: [
            { name },
            { itemid: itemId },
            {
              $or: [{ 'branch_access.branch_id': branchObjectId }, { branch_id: branchObjectId }],
            },
            { license: licenseObjectId },
          ],
        });

        if (existing) {
          alreadyData.push({ name, itemid: itemId });
          existingByRow.set(item, existing);
        }
        // Matched and new rows alike go through the resolution loop below;
        // matched ones update in place, new ones insert.
        documentsToInsert.push(item);
      }

      if (!documentsToInsert.length) {
        return {
          status: false,
          data: null,
          message: 'No rows to import',
        };
      }

      // Validate the entire accepted file before writing items or creating any
      // supplier/category/unit records. Re-imports may keep their own code.
      const barcodeErrors = [];
      const seenCodes = new Map();
      for (const item of documentsToInsert) {
        const matched = existingByRow.get(item);
        const candidateCodes = itemBarcodes.codes({
          ...matched,
          ...item,
          barcodes: matched?.barcodes,
        }); // the CSV does not replace alternates
        const row = rowNumbers.get(item);
        const addError = (message) =>
          barcodeErrors.push({
            row,
            name: item.name,
            barcode_id: item.barcode_id,
            status: message,
          });
        for (const code of candidateCodes) {
          const other = seenCodes.get(code);
          if (other) {
            addError(
              `CSV rows ${rowNumbers.get(other)} and ${row}: barcode "${itemBarcodes.display(code)}" is used by "${itemBarcodes.display(itemBarcodes.label(other))}" and "${itemBarcodes.display(itemBarcodes.label(item))}". Each item or variant needs a different barcode.`
            );
          } else seenCodes.set(code, item);
        }
        const clash = await itemBarcodes.findConflict(collection, candidateCodes, {
          branchId: branchObjectId,
          licenseId: licenseObjectId,
          selfId: matched?._id,
        });
        if (clash)
          addError(`CSV row ${row} ("${itemBarcodes.display(item.name)}"): ${clash.message}`);
      }
      if (barcodeErrors.length) {
        return {
          status: false,
          data: barcodeErrors,
          message: `${barcodeErrors[0].status} Nothing was imported. Correct the listed barcodes and try again.`,
        };
      }

      const now = new Date();
      const branchName = context.branchName || '';
      const userName = context.userName || 'System';
      const userId = context.userId || null;

      const supplierCollection = await this.getCollection('suppliers');
      const categoryCollection = await this.getCollection('categories');
      const unitCollection = await this.getCollection('unit');

      /* What the file said that could not be used, in the shop's words. A
         cell that vanishes quietly is how somebody spends an afternoon
         typing into a column nothing reads. */
      const importNotes = [];

      for (const items of documentsToInsert) {
        const availableQuantity = items.available_quantity ? Number(items.available_quantity) : 0;
        const barcodeId = (items.barcode_id || '').trim();
        const mrpPrice = items.mrp_price ? Number(items.mrp_price) : 0;
        const companyPrice = items.company_price ? Number(items.company_price) : 0;
        const sellingPrice = items.selling_price ? Number(items.selling_price) : 0;

        // Supplier collection
        let supplierDocument = null;
        if (items.supplier_name && String(items.supplier_name).trim() !== '') {
          supplierDocument = await supplierCollection.findOne({
            name: items.supplier_name,
            license: licenseObjectId,
            branch_id: branchObjectId,
          });

          if (!supplierDocument) {
            const insertSupplierData = {
              name: String(items.supplier_name).trim(),
              email: '',
              phone: '',
              address: '',
              country: '',
              state: '',
              city: '',
              branch_id: branchObjectId,
              branch_name: branchName,
              created_date: now,
              created_by: userName,
              created_by_id: userId,
              updated_date: now,
              updated_by: userName,
              updated_by_id: userId,
              license: licenseObjectId,
            };
            const insertSupplierResult = await supplierCollection.insertOne(insertSupplierData);
            supplierDocument = await supplierCollection.findOne({
              _id: insertSupplierResult.insertedId,
              license: licenseObjectId,
              branch_id: branchObjectId,
            });
          }
        }

        const supplierName =
          (supplierDocument && supplierDocument.name) || (items.supplier_name || '').trim();
        const supplierId = supplierDocument ? supplierDocument._id : null;

        // Category collection
        let categoryDocument = null;
        if (items.category_name && String(items.category_name).trim() !== '') {
          categoryDocument = await categoryCollection.findOne({
            name: items.category_name,
            license: licenseObjectId,
            branch_id: branchObjectId,
          });

          if (!categoryDocument) {
            const insertCategoryData = {
              name: String(items.category_name).trim(),
              discount_amount:
                items.discount_amount !== undefined && items.discount_amount !== null
                  ? String(items.discount_amount).trim()
                  : '0',
              discount_percentage: 0,
              description: '',
              image: 'category.svg',
              branch_id: branchObjectId,
              branch_name: branchName,
              created_date: now,
              created_by: userName,
              created_by_id: userId,
              updated_date: now,
              updated_by: userName,
              updated_by_id: userId,
              license: licenseObjectId,
            };
            const insertCategoryResult = await categoryCollection.insertOne(insertCategoryData);
            categoryDocument = await categoryCollection.findOne({
              _id: insertCategoryResult.insertedId,
              license: licenseObjectId,
              branch_id: branchObjectId,
            });
          }
        }

        const categoryName =
          (categoryDocument && categoryDocument.name) || (items.category_name || '').trim();
        const categoryId = categoryDocument ? categoryDocument._id : null;

        // Unit collection
        let unitDocument = null;
        if (items.unit && String(items.unit).trim() !== '') {
          unitDocument = await unitCollection.findOne({
            value: items.unit,
            license: licenseObjectId,
            branch_id: branchObjectId,
          });

          if (!unitDocument) {
            const insertUnitData = {
              name: String(items.unit).trim(),
              value: String(items.unit).trim(),
              branch_id: branchObjectId,
              branch_name: branchName,
              created_date: now,
              created_by: userName,
              created_by_id: userId,
              updated_date: now,
              updated_by: userName,
              updated_by_id: userId,
              license: licenseObjectId,
            };
            const insertUnitResult = await unitCollection.insertOne(insertUnitData);
            unitDocument = await unitCollection.findOne({
              _id: insertUnitResult.insertedId,
              license: licenseObjectId,
              branch_id: branchObjectId,
            });
          }
        }

        const unitId = unitDocument ? unitDocument._id : '';
        const unitName = unitDocument ? unitDocument.value : items.unit || 'qty';

        const insertData = {
          branch_id: branchObjectId,
          license: licenseObjectId,
          branch_name: branchName,
          date: now,
          created_date: now,
          created_by: userName,
          created_by_id: userId,
          creation_origin: itemCreationOrigin.record('item_import', context, now),
        };

        const updateData = {
          branch_access: [
            {
              branch_id: branchObjectId,
              branch_name: branchName,
            },
          ],
          name: String(items.name || '').trim(),
          itemid: String(items.itemid || '').trim(),
          barcode_id: barcodeId,
          supplier_name: supplierName,
          ...(supplierId ? { supplier_id: supplierId } : {}),
          category_name: categoryName,
          ...(categoryId ? { category_id: categoryId } : {}),
          discount_amount:
            items.discount_amount !== undefined && items.discount_amount !== null
              ? Number(items.discount_amount)
              : 0,
          discount_percentage:
            items.discount_percentage !== undefined && items.discount_percentage !== null
              ? Number(items.discount_percentage)
              : 0,
          mrp_price: mrpPrice,
          company_price: companyPrice,
          selling_price: sellingPrice,
          available_quantity: availableQuantity,
          image: DEFAULTS.IMAGE,
          multi_image: [],
          item_status: ITEM_STATUS.REGULAR,
          sort_order:
            items.sort_order !== undefined && items.sort_order !== ''
              ? Number(items.sort_order)
              : 999999,
          description: '',
          track_inventory: true,
          negative_stock: false,
          updated_date: now,
          updated_by: userName,
          updated_by_id: userId,
          license: licenseObjectId,
          unit_id: unitId,
          unit: unitName,
        };

        const matched = existingByRow.get(items);

        let writtenId = null;
        if (matched) {
          /* Update only the columns the CSV carries. Deliberately excluded:
             image/multi_image (the export has no image column, so a CSV can
             never carry one - overwriting them is exactly the bug), the
             created_* provenance, and the behaviour flags (track_inventory,
             item_status, negative_stock) which the CSV does not include and
             must not be reset to their insert-time defaults. */
          const setFields = {
            name: updateData.name,
            itemid: updateData.itemid,
            barcode_id: updateData.barcode_id,
            supplier_name: updateData.supplier_name,
            ...(updateData.supplier_id ? { supplier_id: updateData.supplier_id } : {}),
            category_name: updateData.category_name,
            ...(updateData.category_id ? { category_id: updateData.category_id } : {}),
            discount_amount: updateData.discount_amount,
            discount_percentage: updateData.discount_percentage,
            mrp_price: updateData.mrp_price,
            company_price: updateData.company_price,
            selling_price: updateData.selling_price,
            available_quantity: updateData.available_quantity,
            sort_order: updateData.sort_order,
            unit_id: updateData.unit_id,
            unit: updateData.unit,
            updated_date: now,
            updated_by: userName,
            updated_by_id: userId,
          };
          Object.assign(setFields, buildSearchIndex({ ...matched, ...setFields }));
          const itemWrite = await collection.updateOne(
            { _id: matched._id, ...sellingPriceHold.writable(setFields.selling_price) },
            { $set: setFields }
          );
          if (!itemWrite.matchedCount) {
            importNotes.push(`${updateData.name}: ${sellingPriceHold.message}`);
            continue;
          }
          updatedIds.push(matched._id);
          writtenId = matched._id;
          // A re-import that changed any tracked field is history like any other.
          await this.logItemChanges(
            { _id: matched._id, name: setFields.name, branch_id: branchObjectId },
            matched,
            setFields,
            { userName, userId },
            'Import'
          ).catch(() => {});
        } else {
          const itemDocument = withSearchIndex({ ...insertData, ...updateData });
          const insertOneResult = await collection.insertOne(itemDocument);
          insertedIds.push(insertOneResult.insertedId);
          writtenId = insertOneResult.insertedId;
        }
      }

      if (insertedIds.length > 0 || updatedIds.length > 0) {
        await require('../services/catalogue-sharing').automatic([...insertedIds, ...updatedIds]);
        const touched = await collection
          .find({ _id: { $in: [...insertedIds, ...updatedIds] }, license: licenseObjectId })
          .toArray();
        const parts = [];
        if (insertedIds.length) parts.push(`${insertedIds.length} added`);
        if (updatedIds.length) parts.push(`${updatedIds.length} updated`);
        return {
          status: true,
          data: touched.map((i) => stripRemovedItemFields(BaseModel.simplifyFields(i))),
          message: `Import complete: ${parts.join(', ')}${this._importNotesSuffix(importNotes)}`,
        };
      }

      return {
        status: false,
        data: null,
        message: 'No rows to import',
      };
    } catch (error) {
      console.error('Error in ItemRepository.importItems:', error);
      const progress =
        insertedIds.length || updatedIds.length
          ? `${insertedIds.length} items added and ${updatedIds.length} updated before the failure. Review these items before retrying. `
          : '';
      return { status: false, data: null, message: progress + error.message };
    }
  }

  /**
   * What the import could not use, said at the end of the message it already
   * shows.
   *
   * In the message rather than beside it because the import result is an array
   * of rows the screen renders as a table, and a second shape reaching a
   * screen that does not read it is the same as saying nothing. Three, then a
   * count: a shop that mistyped one column produces one note per row, and a
   * hundred of them is not a message, it is a wall.
   *
   * @param {string[]} notes
   * @returns {string} a suffix, or the empty string
   */
  _importNotesSuffix(notes) {
    const said = Array.isArray(notes) ? notes.filter(Boolean) : [];
    if (!said.length) return '';
    const shown = said.slice(0, 3).join('; ');
    const rest = said.length - 3;
    return rest > 0 ? `. ${shown}; and ${rest} more` : `. ${shown}`;
  }

  /**
   * Build the Mongo filter for an export.
   *
   * `selection` is either the legacy array of selected row ids, or an options
   * object. When `{ all: true }` is passed we export every item the caller can
   * see - the same branch + licence scope the item list itself uses - honouring
   * an optional category and search so "select all N" matches exactly what the
   * filtered list showed, not just the 100 rows on the current page.
   */
  /*
   * Every item in the catalogue, grouped into families, without holding the
   * catalogue in memory.
   *
   * The export has to group variants together, and the obvious way to do that
   * is to read everything and bucket it. This repository has already paid for
   * that once: the catalogue copy called .toArray() and then built a second
   * full array of the same rows, so two copies of a shop's entire item list
   * were resident at once, on a process shared with every other shop.
   *
   * Sorting by variant_group_id means a family arrives contiguously, so the
   * grouping can be done as the cursor advances - one family resident at a
   * time. The caller gets each family as it completes and decides what to do
   * with it.
   *
   * The sort is the load-bearing part. Without it a family is scattered
   * through the stream and the "flush when the id changes" rule silently emits
   * the same family several times, each with some of its variants.
   */
  async streamCatalogue({ branchId, licenseId }, onGroup) {
    const collection = await this.getCollection(this.collectionName);

    const filter = {
      'branch_access.branch_id': this.toObjectId(branchId),
      license: this.toObjectId(licenseId),
    };

    const cursor = collection.find(filter).sort({ variant_group_id: 1, _id: 1 });

    let current = null;
    let pending = [];
    let count = 0;

    const flush = async () => {
      if (!pending.length) return;
      await onGroup(pending);
      count += pending.length;
      pending = [];
    };

    for await (const row of cursor) {
      const gid = row.variant_group_id ? String(row.variant_group_id) : '';
      /* Items with no family are each their own group, so an empty id must not
         collapse them all into one enormous "family". */
      if (!gid || gid !== current) {
        await flush();
        current = gid || null;
      }
      pending.push(stripRemovedItemFields(row));
      if (!gid) await flush();
    }
    await flush();

    return count;
  }

  _buildExportFilter(selection, context = {}) {
    const licenseId = context.licenseId || null;
    const licenseClause = licenseId
      ? { license: ObjectId.isValid(licenseId) ? new ObjectId(licenseId) : licenseId }
      : null;

    const opts = Array.isArray(selection) ? { ids: selection } : selection || {};

    if (!opts.all) {
      const ids = Array.isArray(opts.ids) ? opts.ids : [];
      if (ids.length === 0) return null;
      const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
      const filter = { _id: { $in: objectIds } };
      if (licenseClause) Object.assign(filter, licenseClause);
      return filter;
    }

    // "Select all N" mirrors the item list exactly: the client sends the same
    // `filters` object the list uses, we run it through the same sanitiser and
    // force the same branch + licence scope, so the export is precisely the set
    // of rows the filtered list was showing - no more, no less.
    const clientFilters = this.assignFilterObjects(
      { ...(opts.filters || {}) },
      LegacyItemModel.fields
    );
    for (const key of [
      'branch_id',
      'branchId',
      'branch_name',
      'branch_access',
      'branch_access.branch_id',
      'license',
      'license_id',
      'licenseId',
    ]) {
      delete clientFilters[key];
    }

    // A category picked in the export dialog, when the list itself was not
    // already filtered by one.
    if (opts.categoryId && ObjectId.isValid(opts.categoryId) && !clientFilters.category_id) {
      clientFilters.category_id = new ObjectId(opts.categoryId);
    }

    const filter = { ...clientFilters };

    const branchId = context.branchId || null;
    if (branchId && ObjectId.isValid(branchId)) {
      filter['branch_access.branch_id'] = new ObjectId(branchId);
    }
    if (licenseClause) filter.license = licenseClause.license;

    return filter;
  }

  _normalizeExportRow(i) {
    return stripRemovedItemFields(BaseModel.simplifyFields(i));
  }

  async exportItems(selection, context = {}) {
    try {
      const filter = this._buildExportFilter(selection, context);
      if (!filter) {
        return { status: false, data: null, message: 'No IDs provided' };
      }

      const collection = await this.getCollection(this.collectionName);

      const items = await collection
        .find(filter, {
          projection: {
            _id: 0,
            name: 1,
            itemid: 1,
            barcode_id: 1,
            category_name: 1,
            supplier_name: 1,
            discount_amount: 1,
            discount_percentage: 1,
            mrp_price: 1,
            company_price: 1,
            selling_price: 1,
            available_quantity: 1,
            unit: 1,
            selling_units: 1,
            stock_locations: 1,
            sort_order: 1,
          },
        })
        .sort({ _id: -1 })
        .toArray();

      return {
        status: true,
        data: items.map((i) => this._normalizeExportRow(i)),
        message: 'Item Data Exported',
      };
    } catch (error) {
      console.error('Error in ItemRepository.exportItems:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getDataChanges(module, from) {
    // Mirror ItemModel.getDataChanges: delegate to BaseModel.getAllDataChanges
    // for the items collection using the legacy field metadata.
    return BaseModel.getAllDataChanges(
      Item.LegacyItemModel.collectionName,
      module,
      from,
      BaseModel.getSelectFields(LegacyItemModel.fields, true)
    );
  }

  /**
   * Get category items report
   * PHP: item_model.php -> categoryItemsReportPage()
   */
  async getCategoryItemsReport(params) {
    try {
      const { branchIds, startingDate, endingDate, categoryId, page = 1, limit = 5 } = params;

      const itemsCollection = await this.getCollection(this.collectionName);

      // Parse dates using BaseModel helper methods
      const fromDate = BaseModel.startingDate(startingDate, BaseModel.currentTimeZone);
      const toDate = BaseModel.endingDate(endingDate, BaseModel.currentTimeZone);

      // Convert branch IDs to ObjectIds
      const branchObjectIds = branchIds.map((id) => new ObjectId(id));

      // Build filters
      const filters = {
        $and: [
          { 'branch_access.branch_id': { $in: branchObjectIds } },
          { updated_date: { $gte: fromDate, $lte: toDate } },
        ],
      };

      // Only filter by license if it's available
      if (BaseModel.license) {
        filters.$and[1].license = BaseModel.license;
      }

      // Add category filter if provided
      if (categoryId && categoryId !== '') {
        filters.category_id = new ObjectId(categoryId);
      }

      // Calculate skip for pagination
      const skip = Math.max(0, (page - 1) * limit);

      // Aggregate items by category
      const salesList = await itemsCollection
        .aggregate([
          { $match: filters },
          {
            $group: {
              _id: { category_id: '$category_id', category_name: '$category_name' },
              selling_price: { $sum: '$selling_price' },
              item_count: { $sum: 1 },
            },
          },
          { $sort: { selling_price: -1 } },
          { $skip: skip },
          { $limit: limit },
        ])
        .toArray();

      // Count total documents with same filters
      const salesCountList = await itemsCollection
        .aggregate([
          { $match: filters },
          {
            $group: {
              _id: { category_id: '$category_id', category_name: '$category_name' },
              selling_price: { $sum: '$selling_price' },
              item_count: { $sum: 1 },
            },
          },
        ])
        .toArray();

      const total = salesCountList.length;

      // Format sales data
      const salesValues = salesList.map((doc) => ({
        category_id: doc._id.category_id?.toString() || '',
        category_name: doc._id.category_name || '',
        selling_price: doc.selling_price || 0,
        item_count: doc.item_count || 0,
      }));

      return {
        status: true,
        data: {
          total,
          current_page: page,
          total_pages: Math.ceil(total / limit),
          per_page: limit,
          list: salesValues,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in ItemRepository.getCategoryItemsReport:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  /**
   * Update available stock quantity for a single item
   * Delegates to legacy updateStock on ItemModel to keep business
   * behaviour identical while routing access through the repository.
   *
   * @param {string|ObjectId} itemId
   * @param {number} quantityChange - Positive or negative delta
   */
  /**
   * @param {string|ObjectId} itemId
   * @param {number} quantityChange
   * @param {object} [options]
   * @param {string} [options.reason] why the stock moved - see sync/outbox REASONS
   */
  async updateStock(itemId, quantityChange, options = {}) {
    const collection = await this.getCollection(this.collectionName);
    const objectId = this.toObjectId(itemId);

    const result = await collection.updateOne(
      { _id: objectId },
      { $inc: { available_quantity: quantityChange } }
    );

    /*
     * Mark the row for priority sync, after the write and never before.
     *
     * Every stock-changing path in the product - sale, return, cancellation,
     * receiving, adjustment - reaches this method or deductStockIfAvailable
     * below, which is what makes two hooks enough to cover all of them.
     *
     * Awaited but never able to throw: the outbox swallows its own errors, so a
     * shop can still trade if it is unwritable. The periodic scan remains the
     * mechanism of record; this only makes the change arrive sooner.
     */
    await require('../sync/outbox').enqueueInventory(objectId, options.reason);

    return result;
  }

  /**
   * Atomically deduct stock only when the requested quantity is available.
   * This prevents two billing counters from both passing a stale read check.
   */
  async deductStockIfAvailable(itemId, quantity) {
    const collection = await this.getCollection(this.collectionName);
    const objectId = this.toObjectId(itemId);
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;

    const result = await collection.findOneAndUpdate(
      {
        _id: objectId,
        available_quantity: { $gte: qty },
        track_inventory: { $in: [true, 'true'] },
        negative_stock: { $ne: true },
      },
      { $inc: { available_quantity: -qty } },
      { returnDocument: 'after' }
    );

    const deducted = result?.value || result || null;
    /* Only when stock actually moved. The filter above can match nothing -
       insufficient stock, or an item that does not track it - and marking a row
       that did not change would push an unchanged document for no reason. */
    if (deducted) {
      await require('../sync/outbox').enqueueInventory(objectId, 'sale_inventory');
    }
    return deducted;
  }

  /**
   * Update the primary quantity field for a single item.
   *
   * This is used by Node-native Sale flows that rely on the
   * Mongoose Sale.items[] structure and the SALE_STATUS flag,
   * mirroring the direct Item.findByIdAndUpdate($inc: { quantity })
   * call that previously lived inside the Sale post-save hook.
   *
   * @param {string|ObjectId} itemId
   * @param {number} quantityChange - Positive or negative delta
   */
  async updateQuantity(itemId, quantityChange) {
    const collection = await this.getCollection(this.collectionName);
    const objectId = this.toObjectId(itemId);

    const delta = typeof quantityChange === 'number' ? quantityChange : Number(quantityChange) || 0;

    return collection.updateOne({ _id: objectId }, { $inc: { quantity: delta } });
  }

  /**
   * Find a single item by its ID using the legacy BaseModel helpers so
   * license scoping remains consistent with other legacy calls.
   *
   * @param {string|ObjectId} id
   */
  async findItemById(id) {
    return this.findOne({ _id: this.toObjectId(id) });
  }
}

module.exports = ItemRepository;
