const itemText = require('../utils/item-localization');
// src/models/sale_model.js
const mongoose = require('mongoose');
const { defineModel } = require('../db/model-registry');
const { currentConnection } = require('../db/tenant-context');
const { toJSON, paginate } = require('./plugins');
const { PAYMENT_STATUS } = require('../constants');
const { SALE_PROCESS_VALUES } = require('../constants/sales.constants');
const BaseModel = require('./base.model');
const { sendEmail } = require('../utils/email');

// Helper to match legacy PHP round() behavior

// Helper to safely coerce discount/amount fields that may be null, empty
// strings, or legacy string values like "null" into numeric zeros. This is
// used across sales detail views and returnSalesOrder to prevent NaN from
// leaking into stored documents or frontend calculations.

// Register Item model before using it in references
require('./item.model');

// Repository singletons used by Mongoose hooks. These are intentionally
// lightweight and rely on BaseModel's static context (license, branch, etc.).

const saleItemSchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Item',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    barcode: String,
    sku: String,
    quantity: {
      type: Number,
      required: true,
      /*
       * A gram, not a unit.
       *
       * This was 1, which is a whole kilo for anything sold by weight: a 300g
       * sale was refused outright with "less than minimum allowed value (1)"
       * after the till had already taken payment. Three decimals is what the
       * scale reports, so 0.001 is the smallest quantity that can mean anything.
       */
      min: 0.001,
    },
    unit_price: {
      type: Number,
      required: true,
      min: 0,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    total: {
      type: Number,
      min: 0,
    },

    default_language: { type: String, default: undefined },
    translations: { type: [{ _id: false, locale: String, name: String }], default: undefined },

    // PHP-compatible item-level mirror fields (from Api/src/model/sales_model.php::$itemsale)
    sale_inline_item_price: {
      type: Number,
      default: 0,
      min: 0,
    },
    sale_inline_discount_value: {
      type: Number,
      default: 0,
      min: 0,
    },
    sale_inline_discount_pervalue: {
      type: Number,
      default: 0,
      min: 0,
    },
    item_status: {
      type: String,
      trim: true,
    },
    return: {
      type: Boolean,
      default: false,
    },
    item_sku: {
      type: String,
      trim: true,
    },
    item_discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    item_discount_percentage: {
      type: Number,
      default: 0,
      min: 0,
    },
    item_available_quantity: {
      type: Number,
      default: 0,
      /*
       * No `min`. This is a SNAPSHOT of the item's stock at sale time, not
       * a quantity being sold - and stock legitimately goes negative on
       * items whose `negative_stock` flag allows overselling. With min: 0
       * the whole sale was refused ("Path `item_available_quantity` (-1) is
       * less than minimum allowed value (0)"), so one item already in the
       * red blocked the cashier from taking money for the entire basket.
       * A record of what stock WAS must never be able to fail validation.
       */
    },
    item_id: {
      type: String,
      trim: true,
    },
    item_unit: {
      type: String,
      trim: true,
    },
    total_amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    barcode_id: {
      type: String,
      trim: true,
    },
    company_price_total: {
      type: Number,
      default: 0,
      min: 0,
    },
    /*
     * The unit cost this line was priced from. The line total above is what
     * reports use; this lets an edit reopen the bill without guessing whether
     * the stored value was one unit or the whole quantity.
     */
    unit_company_price: {
      type: Number,
      default: 0,
      min: 0,
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
    },
    category_name: {
      type: String,
      trim: true,
    },
    supplier_id: {
      type: mongoose.Schema.Types.ObjectId,
    },
    supplier_name: {
      type: String,
      trim: true,
    },
    track_inventory: {
      type: Boolean,
      default: true,
    },
    negative_stock: {
      type: Boolean,
      default: false,
    },
    item_description: {
      type: String,
      trim: true,
    },
    /*
     * Structured modifiers (V2): what the customer picked from the item's
     * option sets, each with the price delta already inside the line price
     * the client sent. Stored for the receipt and for honesty - the
     * free-text item_description above stays for genuine comments.
     */
    modifiers: {
      type: [
        {
          group: { type: String, trim: true },
          name: { type: String, trim: true },
          price_delta: { type: Number, default: 0 },
        },
      ],
      default: undefined,
    },
  },
  { _id: false, strict: false }
);

const paymentSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    method: {
      type: String,
      enum: ['cash', 'card', 'bank_transfer', 'credit', 'other'],
      required: true,
    },
    reference: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    paper_order: { type: mongoose.Schema.Types.Mixed },
    order_photos: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    origin: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    // ---- PHP-compatible legacy fields (mirroring Api/src/model/sales_model.php::$fields) ----

    receipt_quote: { type: mongoose.Schema.Types.Mixed },

    // Branch & document identity
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
    },
    branch_name: {
      type: String,
      trim: true,
    },
    printing_address: {
      type: String,
      trim: true,
    },
    sales_id: {
      type: String,
      trim: true,
      index: true,
    },
    billing_transaction_id: {
      type: String,
      trim: true,
    },
    business_decision_receipt: {
      type: new mongoose.Schema(
        {
          version: { type: Number, enum: [1], required: true, immutable: true },
          decisionId: { type: String, match: /^[a-f\d]{24}$/, required: true, immutable: true },
          revisionHash: { type: String, match: /^[a-f\d]{64}$/, required: true, immutable: true },
          executionId: { type: String, required: true, immutable: true },
          operationId: { type: String, required: true, immutable: true },
          approverId: { type: String, match: /^[a-f\d]{24}$/, required: true, immutable: true },
          requesterId: { type: String, match: /^[a-f\d]{24}$/, required: true, immutable: true },
          deviceId: { type: String, required: true, immutable: true },
          recordedAt: { type: Date, required: true, immutable: true },
          currency: { type: String, match: /^[A-Z]{3}$/, required: true, immutable: true },
          currencyDigits: { type: Number, enum: [2], required: true, immutable: true },
          payableMinor: { type: Number, required: true, immutable: true },
          discountMinor: { type: Number, required: true, immutable: true },
        },
        { _id: false, strict: 'throw' }
      ),
      default: undefined,
      immutable: true,
    },
    wallet_amount: {
      type: Number,
      default: 0,
    },

    created_date: {
      type: Date,
    },
    // PHP stores username/email in created_by. We mirror that here and
    // keep the actual User ObjectId in created_by_id.
    created_by: {
      type: String,
      trim: true,
    },
    created_by_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    license: {
      type: mongoose.Schema.Types.Mixed,
    },

    // Core sales fields
    order_date: { type: Date },
    settled_at: { type: Date },
    date: {
      type: Date,
      default: Date.now,
    },
    idempotency_key: { type: String },
    submission_payload_hash: { type: String },
    extension_stock_operation: { type: String },
    extension_id: { type: String },
    sale_process: {
      type: String,
      enum: SALE_PROCESS_VALUES,
      default: 'Add',
      trim: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    user_name: {
      type: String,
      trim: true,
    },

    category_id: {
      type: String,
      trim: true,
    },
    category_name: {
      type: String,
      trim: true,
    },
    referrer_id: {
      type: String,
      trim: true,
    },
    referrer_name: {
      type: String,
      trim: true,
    },

    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
    },
    customer_name: {
      type: String,
      trim: true,
    },
    customer_address: {
      type: String,
      trim: true,
    },
    customer_city: {
      type: String,
      trim: true,
    },
    customer_phone: String,
    customer_creation_pending: { type: Boolean, default: false },
    customer_email: {
      type: String,
      trim: true,
    },
    customer_state: {
      type: String,
      trim: true,
    },
    customer_country: {
      type: String,
      trim: true,
    },
    country_sort: {
      type: String,
      trim: true,
    },
    customer_balance: {
      type: Number,
      default: 0,
    },

    // Partial / payment status
    // Mirrors legacy PHP partial_check flag; can be stored as boolean or
    // string "true"/"false" depending on source.
    partial_check: {
      type: mongoose.Schema.Types.Mixed,
      default: false,
    },
    partial_balance: {
      type: Number,
      default: 0,
    },
    payment_status: {
      type: String,
      default: PAYMENT_STATUS.COMPLETED,
    },
    payment_pending: {
      type: Number,
      default: 0,
    },
    payment_mode: {
      type: String,
      default: 'Cash',
      trim: true,
    },

    // PHP-style payment/sales descriptions
    payment_description: {
      type: String,
      trim: true,
    },
    sales_description: {
      type: String,
      trim: true,
    },
    discount_description: {
      type: String,
      trim: true,
    },

    // Normalized by sale-charges before checkout. Keep the exact breakdown
    // alongside the payable so reopening/printing never loses these amounts.
    charges: {
      type: [mongoose.Schema.Types.Mixed],
      default: undefined,
    },

    // Totals and aggregates
    sales_total: {
      type: Number,
      default: 0,
    },
    sales_round_off: {
      type: Number,
      default: 0,
    },
    round_off: {
      type: Number,
      default: 0,
    },
    sales_sub_total: {
      type: Number,
      default: 0,
    },
    items_total: {
      type: Number,
      default: 0,
    },
    items_return_total: {
      type: Number,
      default: 0,
    },
    return_round_off: {
      type: Number,
      default: 0,
    },
    items_subtotal: {
      type: Number,
      default: 0,
    },
    items_return_subtotal: {
      type: Number,
      default: 0,
    },
    total_companyprice: {
      type: Number,
      default: 0,
    },
    /* Marks sale rows whose line costs are full quantity totals. */
    company_cost_basis: {
      type: String,
      trim: true,
    },

    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    return_discount: {
      type: Number,
      default: 0,
    },
    number_of_items_return: {
      type: Number,
      default: 0,
    },

    updated_date: {
      type: Date,
    },
    // PHP stores username/email in updated_by. We mirror that here and
    // keep the actual User ObjectId in updated_by_id.
    updated_by: {
      type: String,
      trim: true,
    },
    updated_by_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    number_of_items: {
      type: Number,
      default: 0,
    },

    items: [saleItemSchema],
    // Changes array for tracking cancellations and modifications
    changes: {
      type: Array,
      default: [],
    },
    // Return / aggregate fields
    items_return: {
      type: Array,
      default: [],
    },
    cashregister_id: {
      type: String,
      trim: true,
    },

    // Extra discount fields
    extra_discount: {
      type: Number,
      default: 0,
    },
    sale_extra_discount: {
      type: Number,
      default: 0,
    },
    extra_discount_type: {
      type: String,
      enum: ['price', 'percentage', 'percent'],
      default: 'price',
      trim: true,
    },
    return_extra_discount: {
      type: Number,
      default: 0,
    },
    // Multi-payment support
    multi_payment: {
      type: mongoose.Schema.Types.Mixed, // Object with payment methods as keys
    },

    /* Legacy PHP sales are tagged Live-Order. Keep the marker so their
     * audited document shape and pre-save parity rules still apply. */
    sale_method: {
      type: String,
      trim: true,
    },

    payment_correction_pending: { type: mongoose.Schema.Types.Mixed },
    payment_corrections: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    paid_bill_corrections: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    denomination_values: {
      type: mongoose.Schema.Types.Mixed,
    },
    // ---- Node-only / extended fields (no strict PHP order) ----
    wording_snapshot: { type: mongoose.Schema.Types.Mixed, immutable: true },

    // Keep branch as an optional reference only; PHP documents only store branch_id.
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
    },
    logo: {
      type: String,
      trim: true,
    },
    // For strict PHP parity we do not require subtotal/total on the document;
    // they may be omitted entirely when saving via the legacy sales service.
    subtotal: {
      type: Number,
      min: 0,
    },
    // For PHP 1:1 parity, do not require a Node-only 'total' field; it may
    // be omitted entirely when using the legacy sales.service processSale.
    total: {
      type: Number,
      min: 0,
    },
    payments: [paymentSchema],
    // Do not auto-create paid_amount/balance for PHP-mirrored documents;
    // they will be present only when explicitly set by non-legacy flows.
    paid_amount: {
      type: Number,
      min: 0,
    },
    balance: {
      type: Number,
    },
    notes: {
      type: String,
      trim: true,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      // Keep as raw ObjectId; this codebase uses a legacy CustomerModel (not a registered Mongoose model).
    },
  },
  {
    timestamps: false,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Add plugins
saleSchema.plugin(toJSON);
saleSchema.plugin(paginate);

// Pre-save hook: Generate sales_id and sync fields
saleSchema.pre('save', async function () {
  const isLegacyPhpSale = this.sale_method === 'Live-Order';

  // STEP 1: Generate sales_id for new sales (PHP-style)
  if (this.isNew && !this.sales_id) {
    if (!this.branch && this.branch_id && !isLegacyPhpSale) {
      this.branch = this.branch_id;
    }

    // Fallback, non-DB-based sales_id generation for flows that do not
    // provide an explicit sales_id (service layer remains the primary
    // source of truth for sequential/prefixed IDs).
    if (!this.sales_id) {
      const fallbackId = `SID${Date.now()}`;
      this.sales_id = fallbackId;
    }
  }

  // STEP 2: Sync branch_id with branch
  if (this.branch && (!this.branch_id || this.isNew || this.isModified('branch'))) {
    this.branch_id = this.branch;
  }
  if (this.isNew && this.license && this.branch_id && this.constructor.db?.db) {
    // Never trust a caller-supplied snapshot for a new sale.
    this.wording_snapshot = await require('../services/document-wording-snapshot').capture(
      this.constructor.db.db.collection('settings'),
      this.license,
      this.branch_id
    );
  }

  const items = Array.isArray(this.items) ? this.items : [];
  let itemsTotal = 0;
  let itemsSubtotal = 0;
  let itemCount = 0;

  for (const item of items) {
    const qty = typeof item.quantity === 'number' ? item.quantity : Number(item.quantity) || 0;
    const lineTotal = typeof item.total === 'number' ? item.total : Number(item.total) || 0;
    itemsTotal += lineTotal;
    itemsSubtotal += lineTotal;
    itemCount += qty;
  }

  if (this.subtotal != null) {
    this.items_subtotal = this.subtotal;
  } else if (!this.items_subtotal) {
    this.items_subtotal = itemsSubtotal;
  }

  if (this.total != null) {
    this.items_total = this.total;
  } else if (!this.items_total) {
    this.items_total = itemsTotal;
  }

  if (!this.number_of_items || this.isNew || this.isModified('items')) {
    // PHP stores number_of_items as the number of item lines (sizeof($itemsale)),
    // not the total quantity. For legacy Live-Order sales, mirror that exactly.
    if (isLegacyPhpSale) {
      this.number_of_items = items.length;
    } else {
      this.number_of_items = itemCount;
    }
  }

  const totalAmount = typeof this.total === 'number' ? this.total : Number(this.total) || 0;
  const paidAmount =
    typeof this.paid_amount === 'number' ? this.paid_amount : Number(this.paid_amount) || 0;
  let balance = typeof this.balance === 'number' ? this.balance : Number(this.balance) || 0;

  // If legacy/ PHP-style flows (processSale) have already provided
  // explicit partial_balance and payment_pending, do not overwrite them
  // here. Only recompute when they are missing.
  const hasIncomingPartial =
    typeof this.partial_balance === 'number' && !Number.isNaN(this.partial_balance);
  const hasIncomingPending =
    typeof this.payment_pending === 'number' && !Number.isNaN(this.payment_pending);

  if (!hasIncomingPartial && !hasIncomingPending) {
    if (!balance && totalAmount && paidAmount <= totalAmount) {
      balance = totalAmount - paidAmount;
    }

    this.partial_balance = paidAmount;
    this.payment_pending = balance > 0 ? balance : 0;
  }

  // Sync PHP-style created_date/updated_date audit fields
  if (this.isModified('date') || !this.updated_date) {
    const baseDate = this.date || this.updated_date || this.created_date || new Date();
    this.updated_date = baseDate;
    if (!this.created_date) {
      this.created_date = baseDate;
    }
  } else if (!this.created_date) {
    this.created_date = this.date || this.updated_date || new Date();
  }

  // Sync PHP-style user/audit identifiers from created_by/updated_by when available
  // For legacy documents where created_by/updated_by were stored as ObjectIds,
  // keep backward compatibility by deriving *_id and user_id. For new
  // PHP-parity sales, created_by/updated_by are plain strings (username/email),
  // so these guards will safely skip.
  if (this.created_by && !this.created_by_id && mongoose.Types.ObjectId.isValid(this.created_by)) {
    this.created_by_id = this.created_by;
  }
  if (this.updated_by && !this.updated_by_id && mongoose.Types.ObjectId.isValid(this.updated_by)) {
    this.updated_by_id = this.updated_by;
  }
  if (!this.user_id && this.created_by && mongoose.Types.ObjectId.isValid(this.created_by)) {
    this.user_id = this.created_by;
  }

  if (!this.license && BaseModel && BaseModel.license) {
    this.license = BaseModel.license;
  }

  // For legacy PHP-style "Live-Order" sales, strip Node-only fields that
  // do not exist in the original PHP sales collection so that new
  // documents in Mongo are 1:1 replicas of PHP add-sale documents.
  if (isLegacyPhpSale) {
    // These fields are useful for extended Node flows but are not part of
    // the legacy PHP schema; remove them for Live-Order parity.
    this.set('customer_balance', undefined);
    this.set('number_of_items_return', undefined);
    this.set('payments', undefined);

    // Ensure optional PHP header fields are always present, even if blank.
    if (this.category_id === undefined || this.category_id === null) {
      this.set('category_id', '');
    }
    if (this.category_name === undefined || this.category_name === null) {
      this.set('category_name', '');
    }
    if (this.referrer_id === undefined || this.referrer_id === null) {
      this.set('referrer_id', '');
    }
    if (this.referrer_name === undefined || this.referrer_name === null) {
      this.set('referrer_name', '');
    }
    if (this.customer_email === undefined || this.customer_email === null) {
      this.set('customer_email', '');
    }

    // For Live-Order parity, rewrite each items[] entry to only contain
    // the PHP $itemsale structure fields, dropping all Node-only keys.
    const currentItems = Array.isArray(this.items) ? this.items : [];
    const phpItems = currentItems.map((item) => {
      const src = item && typeof item.toObject === 'function' ? item.toObject() : item || {};

      return {
        ...(src.unit_conversion ? { unit_conversion: src.unit_conversion } : {}),
        ...(src.pricing
          ? {
              pricing: src.pricing,
              unit_price: src.unit_price,
              item_base_price: src.item_base_price,
            }
          : {}),
        sale_inline_item_price: src.sale_inline_item_price != null ? src.sale_inline_item_price : 0,
        sale_inline_discount_value:
          src.sale_inline_discount_value != null ? src.sale_inline_discount_value : 0,
        sale_inline_discount_pervalue:
          src.sale_inline_discount_pervalue != null ? src.sale_inline_discount_pervalue : 0,
        item_status: src.item_status != null ? src.item_status : '',
        return: src.return === true,
        item_name: src.item_name != null ? src.item_name : '',
        ...itemText.snapshot(src),
        item_sku: src.item_sku != null ? src.item_sku : '',
        item_price: src.item_price != null ? src.item_price : 0,
        item_discount: src.item_discount != null ? src.item_discount : 0,
        item_discount_percentage:
          src.item_discount_percentage != null ? src.item_discount_percentage : 0,
        item_quantity: src.item_quantity != null ? src.item_quantity : 0,
        item_available_quantity:
          src.item_available_quantity != null ? src.item_available_quantity : 0,
        item_id: src.item_id != null ? src.item_id : '',
        item_unit: src.item_unit != null ? src.item_unit : 'qty',
        total_amount: src.total_amount != null ? src.total_amount : 0,
        barcode_id: src.barcode_id != null ? src.barcode_id : '',
        company_price_total: src.company_price_total != null ? src.company_price_total : 0,
        ...(src.unit_company_price != null ? { unit_company_price: src.unit_company_price } : {}),
        category_id: src.category_id != null ? src.category_id : undefined,
        category_name: src.category_name != null ? src.category_name : '',
        supplier_id: src.supplier_id != null ? src.supplier_id : undefined,
        supplier_name: src.supplier_name != null ? src.supplier_name : '',
        item_description: src.item_description != null ? src.item_description : '',
        modifiers: Array.isArray(src.modifiers) && src.modifiers.length ? src.modifiers : undefined,
        track_inventory: src.track_inventory === true,
        negative_stock: src.negative_stock === true,
      };
    });

    this.set('items', phpItems);

    const normalizedItems = Array.isArray(this.items) ? this.items : [];
    for (const itemDoc of normalizedItems) {
      if (itemDoc && typeof itemDoc.set === 'function') {
        itemDoc.set('discount', undefined);
      }
    }
  }

  const changesArr = Array.isArray(this.changes) ? this.changes : [];
  if (changesArr.length) {
    const itemSkuMap = new Map();
    const itemsForMap = Array.isArray(this.items) ? this.items : [];

    for (const it of itemsForMap) {
      if (!it) continue;
      const src = it && typeof it.toObject === 'function' ? it.toObject() : it || {};

      const key = src && src.item_id != null ? String(src.item_id) : '';
      if (!key) continue;
      if (!itemSkuMap.has(key)) {
        const sku =
          src.item_sku != null ? src.item_sku : src.item_code != null ? src.item_code : '';
        itemSkuMap.set(key, sku);
      }
    }

    for (const change of changesArr) {
      const changeItems = Array.isArray(change && change.items) ? change.items : [];
      for (const changeItem of changeItems) {
        if (!changeItem) continue;
        if (changeItem.item_code === undefined || changeItem.item_code === null) {
          const id = changeItem.item_id != null ? String(changeItem.item_id) : '';
          let code = '';
          if (id && itemSkuMap.has(id)) {
            code = itemSkuMap.get(id) || '';
          }
          changeItem.item_code = code;
        }
      }
    }

    this.set('changes', changesArr);
  }
});

// PHP: getSaleQtyDetailModel
// Validate that the original sale quantities are still available in stock
// for the given sale id. Mirrors Api/src/model/sales_model.php::getSaleQtyDetailModel.
// Static method for exporting sales data (ported from PHP exportSalesOrder)
/*
 * Sales History's whitelisted sorts (bill total, item count, business date)
 * each walk one of these; created_date already rides the default listing.
 */
saleSchema.index({ license: 1, branch_id: 1, sales_total: -1 });
saleSchema.index({ license: 1, branch_id: 1, number_of_items: -1 });
saleSchema.index({ license: 1, branch_id: 1, date: -1 });

saleSchema.index(
  { license: 1, billing_transaction_id: 1 },
  {
    unique: true,
    partialFilterExpression: { billing_transaction_id: { $type: 'string' } },
    name: 'unique_billing_transaction_per_license',
  }
);

const Sale = defineModel('Sale', saleSchema);

class LegacySaleModel {
  static collectionName = 'sales';

  static fields = {
    _id: { type: 'ObjectId', select: true, name: 'id' },
    branch_id: { type: 'ObjectId', select: true },
    logo: { type: 'String', select: true },
    branch_name: { type: 'String', select: true },
    paper_order: { type: 'Object', select: true },
    order_photos: { type: 'Array', select: true },
    origin: { type: 'Object', select: true },
    client: { type: 'Object', select: true },
    user_id: { type: 'String', select: true },
    user_name: { type: 'String', select: true },
    sales_id: { type: 'String', select: true },
    date: { type: 'Date', select: true },
    items: { type: 'Array', select: true },
    items_return: { type: 'Array', select: true },
    sale_process: { type: 'String', select: true },
    customer_id: { type: 'ObjectId', select: true },
    customer_name: { type: 'String', select: true },
    customer_address: { type: 'String', select: true },
    customer_phone: { type: 'String', select: true },
    customer_email: { type: 'String', select: true },
    customer_country: { type: 'String', select: true },
    payment_pending: { type: 'String', select: true },
    payment_mode: { type: 'String', select: true },
    partial_balance: { type: 'String', select: true },
    partial_check: { type: 'String', select: true },
    payment_description: { type: 'String', select: true },
    printing_address: { type: 'String', select: true },
    payment_status: { type: 'String', select: true },
    sales_description: { type: 'String', select: true },
    sales_total: { type: 'Number', select: true },
    sales_round_off: { type: 'Number', select: true },
    round_off: { type: 'Number', select: true },
    return_round_off: { type: 'Number', select: true },
    sales_sub_total: { type: 'Number', select: true },
    items_total: { type: 'Number', select: true },
    items_return_total: { type: 'Number', select: true },
    items_subtotal: { type: 'Number', select: true },
    items_return_subtotal: { type: 'Number', select: true },
    total_companyprice: { type: 'Number', select: true },
    discount: { type: 'Number', select: true },
    return_discount: { type: 'Number', select: true },
    number_of_items: { type: 'Number', select: true },
    number_of_items_return: { type: 'Number', select: true },
    created_date: { type: 'Date', select: true },
    updated_date: { type: 'Date', select: true },
    created_by_id: { type: 'ObjectId', select: false },
    created_by: { type: 'String', select: true },
    updated_by_id: { type: 'ObjectId', select: false },
    updated_by: { type: 'String', select: true },
    license: { type: 'ObjectId', select: false },
    wallet_amount: { type: 'Number', select: true },
    sale_extra_discount: { type: 'Number', select: true },
    extra_discount: { type: 'Number', select: true },
    tip_amount: { type: 'Number', select: true },
    tip_in_total: { type: 'Boolean', select: true },
    charges: { type: 'Mixed', select: true },
    discount_description: { type: 'String', select: true },
    return_extra_discount: { type: 'Number', select: true },
    extra_discount_type: { type: 'String', select: true },
    sale_method: { type: 'String', select: true },
    multi_payment: { type: 'Array', select: true },
    denomination_values: { type: 'Array', select: true },
  };
}

Sale.LegacySaleModel = LegacySaleModel;

/**
 * Close sales payment
 * PHP: salesPaymentCloseModel()
 */

/**
 * PHP: sendDailySalesMail()
 * Send daily sales report email. Prefer Brevo when configured, otherwise
 * fall back to the generic email utility so the feature still works when
 * Sendinblue/Brevo is not set up.
 * @param {Object} input - { email, data: { product_details, payment_details, branch_details, extra_discount } }
 * @returns {Promise<Object>}
 */
Sale.sendDailySalesMail = async function (input, shopTransport = null) {
  try {
    const { BrevoClient } = require('@getbrevo/brevo');
    const config = require('../config');

    // Currency sign from the shop's branch details, with the shop default.
    const currency =
      input.data?.branch_details?.currency_type ||
      input.data?.branch_details?.currency_symbol ||
      'EGP';

    // Totals + product rows
    const product_values = [];
    let qty_total = 0;
    let price_total = 0; // subtotal sum
    let amount_total = 0; // grand total
    let profit_total = 0;

    if (input.data?.product_details && Array.isArray(input.data.product_details)) {
      input.data.product_details.forEach((val, idx) => {
        const pQty = parseFloat(val.product_qty || 0);
        const pSubtotal = parseFloat(val.product_subtotal || 0);
        const pTotal = parseFloat(val.product_total || 0);
        const pProfit = parseFloat(val.product_profit || 0);
        const pDiscount = parseFloat(val.product_discount || 0);

        qty_total += pQty;
        price_total += pSubtotal;
        amount_total += pTotal;
        profit_total += pProfit;

        product_values[idx] = {
          product_name: val.product_name || '',
          product_sku: val.product_sku || '',
          product_qty: pQty,
          product_total: `${currency} ${pTotal.toFixed(2)}`,
          product_price: `${currency} ${pSubtotal.toFixed(2)}`,
          product_profit: `${currency} ${pProfit.toFixed(2)}`,
          product_discount: `-${currency} ${pDiscount.toFixed(2)}`,
        };
      });
    }

    // Payment rows + tender total
    const payment_values = [];
    let tender_total = 0;

    if (input.data?.payment_details && Array.isArray(input.data.payment_details)) {
      input.data.payment_details.forEach((c, i) => {
        const sale_payment = parseFloat(c.sale_payment || 0);
        tender_total += sale_payment;

        payment_values[i] = {
          sale_payment: `${currency} ${sale_payment.toFixed(2)}`,
        };
      });
    }

    // Branch details
    const branch = input.data?.branch_details || {};
    const from_date = branch.from_date || '';
    const to_date = branch.to_date || '';
    const sales_type = branch.sales_type || 'Daily';

    // Brevo / Sendinblue setup
    const apiKey =
      config.sendinblue_key || process.env.SENDINBLUE_KEY || process.env.BREVO_API_KEY || '';

    /* Owner rule: a shop that configured its own SMTP sends through it -
       before Brevo, before the platform chain. */
    if (shopTransport && shopTransport.shopOwned) {
      const subject = ((sales_type ? sales_type + ' ' : '') + 'sales report').trim();
      /* The layout every mail wears now - a report over shop SMTP was the
         last plain-text straggler. */
      const { brandFor, renderEmail, kvBlock } = require('../utils/email-layout');
      const brand = brandFor(shopTransport.branch || { branch_name: branch.branch_name });
      await shopTransport.transporter.sendMail({
        from: `${branch.branch_name || 'Posnic POS'} <${shopTransport.from}>`,
        to: input.email,
        subject,
        html: renderEmail({
          brand,
          title: subject.charAt(0).toUpperCase() + subject.slice(1),
          preheader: `Sales from ${from_date || '-'} to ${to_date || '-'}`,
          bodyHtml: kvBlock([
            ['Period', `${from_date || '-'} to ${to_date || '-'}`],
            ['Total quantity', qty_total],
            ['Subtotal', `${currency} ${price_total.toFixed(2)}`],
            ['Grand total', `${currency} ${amount_total.toFixed(2)}`],
            ['Profit', `${currency} ${profit_total.toFixed(2)}`],
            ['Payments received', `${currency} ${tender_total.toFixed(2)}`],
          ]),
        }),
      });
      return { status: true, data: { sent: true }, message: 'Mail sent successfully' };
    }

    if (apiKey) {
      // Preferred path: use Brevo transactional template
      const client = new BrevoClient({ apiKey });

      const emailData = {
        to: [{ email: input.email || '' }],
        templateId: 6, // Brevo template ID
        params: {
          fromdate: from_date,
          todate: to_date,
          heading: (sales_type ? sales_type + ' ' : '') + 'sales report',

          qty_total: qty_total,
          price_total: `${currency} ${price_total.toFixed(2)}`,
          amount_total: `${currency} ${amount_total.toFixed(2)}`,
          profit_total: `${currency} ${profit_total.toFixed(2)}`,
          payments_received: `${currency} ${tender_total.toFixed(2)}`,

          store: branch,
          product: product_values,
          tender: payment_values,
          extra_discount: `${currency} ${parseFloat(
            input.data?.extra_discount?.total_sale_extra_discount || 0
          ).toFixed(2)}`,
        },
        headers: {
          'X-Mailin-custom': 'custom_header_1:custom_value_1|custom_header_2:custom_value_2',
        },
      };

      const result = await client.transactionalEmails.sendTransacEmail(emailData);
      return {
        status: true,
        data: result,
        message: 'Mail sent successfully',
      };
    }

    // Fallback: no Brevo key configured. Use the generic email helper which
    // itself falls back to a safe transport in development when SMTP is
    // missing, so we do not block the Quick Sale report feature.
    const subject = ((sales_type ? sales_type + ' ' : '') + 'sales report').trim();
    const messageLines = [
      `Sales report from ${from_date || '-'} to ${to_date || '-'}`,
      '',
      `Total quantity: ${qty_total}`,
      `Subtotal: ${currency} ${price_total.toFixed(2)}`,
      `Grand total: ${currency} ${amount_total.toFixed(2)}`,
      `Profit: ${currency} ${profit_total.toFixed(2)}`,
      `Payments received: ${currency} ${tender_total.toFixed(2)}`,
    ];

    await sendEmail({
      email: input.email,
      subject,
      message: messageLines.join('\n'),
    });

    return {
      status: true,
      data: null,
      message: 'Mail sent successfully',
    };
  } catch (error) {
    console.error('Error in sendDailySalesMail:', error);
    return {
      status: false,
      data: null,
      message: error.message || 'Mail failed',
    };
  }
};

module.exports = Sale;
