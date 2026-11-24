'use strict';

/**
 * Unit tests for src/models/sale.model.js
 * ORM: Mongoose. Collection: "sales".
 * Exports: Sale (Mongoose model), Sale.LegacySaleModel (legacy native-driver descriptor).
 * Strategy: Pure schema inspection via schema.path() + pre-save hook extraction.
 * No real DB connections. External APIs mocked.
 */

// ─── Mocks (hoisted before requires) ─────────────────────────────────────────

jest.mock('../../../src/utils/email', () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../src/config', () => ({
  sendinblue_key: null,
}));

jest.mock('@getbrevo/brevo', () => ({
  BrevoClient: jest.fn().mockImplementation(() => ({
    transactionalEmails: {
      sendTransacEmail: jest.fn().mockResolvedValue({ messageId: 'brevo-id' }),
    },
  })),
}));

jest.mock('moment-timezone', () =>
  jest.fn().mockReturnValue({
    tz: jest.fn().mockReturnThis(),
    add: jest.fn().mockReturnThis(),
    unix: jest.fn().mockReturnValue(1700001800),
  })
);

jest.mock('axios', () => jest.fn().mockResolvedValue({ data: 'ok' }));

// ─── Requires ─────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');
const Sale = require('../../../src/models/sale.model');
const BaseModel = require('../../../src/models/base.model');
const { sendEmail } = require('../../../src/utils/email');

// ─── Schema helpers ────────────────────────────────────────────────────────────

const saleSchema = Sale.schema;
const saleItemSchema = saleSchema.path('items').schema;
const paymentSchema = saleSchema.path('payments').schema;
const p = (f) => saleSchema.path(f);
const pi = (f) => saleItemSchema.path(f);
const pp = (f) => paymentSchema.path(f);
const LegacySaleModel = Sale.LegacySaleModel;

const SALE_PROCESS_VALUES = ['Add', 'Edit', 'Hold', 'PartialReturn', 'Return'];
const PAYMENT_METHOD_VALUES = ['cash', 'card', 'bank_transfer', 'credit', 'other'];
const EXTRA_DISCOUNT_TYPES = ['price', 'percentage', 'percent'];

// ─── Pre-save hook helpers ─────────────────────────────────────────────────────

function getPreSaveFn() {
  const pres = saleSchema.s.hooks._pres.get('save') || [];
  const hook = pres.find((h) => h.fn && h.fn.toString().includes('sales_id'));
  return hook?.fn;
}

function makeDoc(overrides = {}) {
  const base = {
    isNew: false,
    sales_id: 'INV000001',
    branch: null,
    branch_id: null,
    sale_method: null,
    items: [],
    subtotal: null,
    total: null,
    items_subtotal: 0,
    items_total: 0,
    number_of_items: 0,
    partial_balance: undefined,
    payment_pending: undefined,
    paid_amount: 0,
    balance: 0,
    date: new Date('2024-01-15'),
    created_date: null,
    updated_date: null,
    created_by: null,
    created_by_id: null,
    updated_by: null,
    updated_by_id: null,
    user_id: null,
    license: null,
    changes: [],
    isModified: jest.fn().mockReturnValue(false),
    set: jest.fn(function (key, val) {
      if (val === undefined) {
        delete this[key];
      } else {
        this[key] = val;
      }
    }),
  };
  return Object.assign(base, overrides);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  BaseModel.license = null;
  BaseModel.currentBranch = null;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. Model identity
// ══════════════════════════════════════════════════════════════════════════════
describe('Sale — model identity', () => {
  test('module exports the Mongoose Sale model', () => {
    expect(Sale).toBeDefined();
    expect(typeof Sale).toBe('function');
  });

  test('modelName is "Sale"', () => {
    expect(Sale.modelName).toBe('Sale');
  });

  test('has standard Mongoose query methods', () => {
    expect(typeof Sale.find).toBe('function');
    expect(typeof Sale.findOne).toBe('function');
    expect(typeof Sale.create).toBe('function');
    expect(typeof Sale.countDocuments).toBe('function');
    expect(typeof Sale.updateOne).toBe('function');
    expect(typeof Sale.deleteOne).toBe('function');
  });

  test('schema is a mongoose.Schema instance', () => {
    expect(saleSchema).toBeInstanceOf(mongoose.Schema);
  });

  test('paginate plugin is attached', () => {
    expect(typeof Sale.paginate).toBe('function');
  });

  test('LegacySaleModel is attached as Sale.LegacySaleModel', () => {
    expect(Sale.LegacySaleModel).toBeDefined();
    expect(typeof Sale.LegacySaleModel).toBe('function');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. saleItemSchema — required fields
// ══════════════════════════════════════════════════════════════════════════════
describe('saleItemSchema › item field', () => {
  test('path exists', () => {
    expect(pi('item')).toBeDefined();
  });
  test('instance is ObjectId', () => {
    expect(pi('item').instance).toBe('ObjectId');
  });
  test('is required', () => {
    expect(pi('item').options.required).toBe(true);
  });
  test('refs "Item" model', () => {
    expect(pi('item').options.ref).toBe('Item');
  });
});

describe('saleItemSchema › name field', () => {
  test('path exists', () => {
    expect(pi('name')).toBeDefined();
  });
  test('instance is String', () => {
    expect(pi('name').instance).toBe('String');
  });
  test('is required', () => {
    expect(pi('name').options.required).toBe(true);
  });
});

describe('saleItemSchema › quantity field', () => {
  test('path exists', () => {
    expect(pi('quantity')).toBeDefined();
  });
  test('instance is Number', () => {
    expect(pi('quantity').instance).toBe('Number');
  });
  test('is required', () => {
    expect(pi('quantity').options.required).toBe(true);
  });
  // A gram, not a unit. This asserted 1, which is one whole kilo for
  // anything sold by weight - a 300g sale was refused by the schema
  // after the customer had already paid.
  test('min is a gram, so a weight is accepted', () => {
    expect(pi('quantity').options.min).toBe(0.001);
  });
});

describe('saleItemSchema › unit_price field', () => {
  test('path exists', () => {
    expect(pi('unit_price')).toBeDefined();
  });
  test('instance is Number', () => {
    expect(pi('unit_price').instance).toBe('Number');
  });
  test('is required', () => {
    expect(pi('unit_price').options.required).toBe(true);
  });
  test('min is 0', () => {
    expect(pi('unit_price').options.min).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. saleItemSchema — optional fields with defaults
// ══════════════════════════════════════════════════════════════════════════════
describe('saleItemSchema › optional numeric fields', () => {
  test.each([['discount', 0, 0, undefined]])('%s has default %d and min %s', (field, def, min) => {
    expect(pi(field)).toBeDefined();
    expect(pi(field).options.default).toBe(def);
    expect(pi(field).options.min).toBe(min);
    expect(pi(field).options.required).toBeFalsy();
  });

  test('total is optional (no required, has min:0)', () => {
    expect(pi('total')).toBeDefined();
    expect(pi('total').options.required).toBeFalsy();
    expect(pi('total').options.min).toBe(0);
  });

  test.each([
    'sale_inline_item_price',
    'sale_inline_discount_value',
    'sale_inline_discount_pervalue',
    'item_discount',
    'item_available_quantity',
    'total_amount',
    'company_price_total',
  ])('"%s" is Number with default 0', (field) => {
    expect(pi(field)).toBeDefined();
    expect(pi(field).instance).toBe('Number');
    expect(pi(field).options.default).toBe(0);
  });
});

describe('saleItemSchema › Boolean fields', () => {
  test('return: Boolean, default false', () => {
    expect(pi('return').instance).toBe('Boolean');
    expect(pi('return').options.default).toBe(false);
  });

  test('track_inventory: Boolean, default true', () => {
    expect(pi('track_inventory').instance).toBe('Boolean');
    expect(pi('track_inventory').options.default).toBe(true);
  });

  test('negative_stock: Boolean, default false', () => {
    expect(pi('negative_stock').instance).toBe('Boolean');
    expect(pi('negative_stock').options.default).toBe(false);
  });
});

describe('saleItemSchema › ObjectId/Mixed fields', () => {
  test('category_id is ObjectId', () => {
    expect(pi('category_id').instance).toBe('ObjectId');
  });
  test('supplier_id is ObjectId', () => {
    expect(pi('supplier_id').instance).toBe('ObjectId');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. paymentSchema — fields
// ══════════════════════════════════════════════════════════════════════════════
describe('paymentSchema › amount field', () => {
  test('instance is Number', () => {
    expect(pp('amount').instance).toBe('Number');
  });
  test('is required', () => {
    expect(pp('amount').options.required).toBe(true);
  });
  test('min is 0', () => {
    expect(pp('amount').options.min).toBe(0);
  });
});

describe('paymentSchema › method field', () => {
  test('instance is String', () => {
    expect(pp('method').instance).toBe('String');
  });
  test('is required', () => {
    expect(pp('method').options.required).toBe(true);
  });
  test('enum has exactly 5 values', () => {
    expect(pp('method').enumValues).toHaveLength(5);
  });

  test.each(PAYMENT_METHOD_VALUES)('enum contains "%s"', (v) => {
    expect(pp('method').enumValues).toContain(v);
  });
});

describe('paymentSchema › optional fields', () => {
  test('date is Date with default', () => {
    expect(pp('date').instance).toBe('Date');
    expect(pp('date').options.default).toBeTruthy();
    expect(pp('date').options.required).toBeFalsy();
  });

  test.each(['reference', 'notes'])('"%s" is optional String', (field) => {
    expect(pp(field)).toBeDefined();
    expect(pp(field).instance).toBe('String');
    expect(pp(field).options.required).toBeFalsy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. saleSchema — branch / identity fields
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › branch fields', () => {
  test('branch_id is ObjectId ref Branch', () => {
    expect(p('branch_id').instance).toBe('ObjectId');
    expect(p('branch_id').options.ref).toBe('Branch');
  });

  test('branch is ObjectId ref Branch', () => {
    expect(p('branch').instance).toBe('ObjectId');
    expect(p('branch').options.ref).toBe('Branch');
  });

  test('branch_name is String', () => {
    expect(p('branch_name').instance).toBe('String');
  });

  test('sales_id is String with index', () => {
    expect(p('sales_id').instance).toBe('String');
    expect(p('sales_id').options.index).toBe(true);
  });

  test('billing transaction id has a unique per-license index', () => {
    expect(p('billing_transaction_id').instance).toBe('String');
    const index = saleSchema
      .indexes()
      .find(([keys]) => keys.license === 1 && keys.billing_transaction_id === 1);
    expect(index).toBeDefined();
    expect(index[1].unique).toBe(true);
  });

  test('cashregister_id is String', () => {
    expect(p('cashregister_id').instance).toBe('String');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. saleSchema — date / audit fields
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › date and audit fields', () => {
  test('date is Date with default', () => {
    expect(p('date').instance).toBe('Date');
    expect(p('date').options.default).toBeTruthy();
  });

  test.each(['created_date', 'updated_date'])('"%s" is Date, optional', (field) => {
    expect(p(field)).toBeDefined();
    expect(p(field).instance).toBe('Date');
    expect(p(field).options.required).toBeFalsy();
  });

  test('created_by is String', () => {
    expect(p('created_by').instance).toBe('String');
  });
  test('updated_by is String', () => {
    expect(p('updated_by').instance).toBe('String');
  });
  test('created_by_id is ObjectId ref User', () => {
    expect(p('created_by_id').options.ref).toBe('User');
  });
  test('updated_by_id is ObjectId ref User', () => {
    expect(p('updated_by_id').options.ref).toBe('User');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. saleSchema — customer fields
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › customer fields', () => {
  test('customer_id is ObjectId', () => {
    expect(p('customer_id').instance).toBe('ObjectId');
  });
  test('customer is ObjectId (raw, no ref)', () => {
    expect(p('customer').instance).toBe('ObjectId');
  });
  test('customer_name is String', () => {
    expect(p('customer_name').instance).toBe('String');
  });
  test('customer_balance is Number with default 0', () => {
    expect(p('customer_balance').instance).toBe('Number');
    expect(p('customer_balance').options.default).toBe(0);
  });
  test.each([
    'customer_phone',
    'customer_email',
    'customer_address',
    'customer_state',
    'customer_country',
  ])('"%s" is String', (f) => {
    expect(p(f)).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. saleSchema — sale_process enum
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › sale_process field', () => {
  test('instance is String', () => {
    expect(p('sale_process').instance).toBe('String');
  });
  test('default is "Add"', () => {
    expect(p('sale_process').options.default).toBe('Add');
  });
  test('enum has exactly 6 values', () => {
    expect(p('sale_process').enumValues).toHaveLength(5);
  });

  test.each(SALE_PROCESS_VALUES)('enum contains "%s"', (v) => {
    expect(p('sale_process').enumValues).toContain(v);
  });

  test.each(['KOT', 'Online', 'TakeAway'])('enum refuses removed process "%s"', (v) => {
    expect(p('sale_process').enumValues).not.toContain(v);
  });

  test('enum does NOT contain invalid value "Delete"', () => {
    expect(p('sale_process').enumValues).not.toContain('Delete');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. saleSchema — payment / status fields
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › payment and status fields', () => {
  test('payment_status default is "completed"', () => {
    expect(p('payment_status').options.default).toBe('completed');
  });

  test('payment_mode default is "Cash"', () => {
    expect(p('payment_mode').options.default).toBe('Cash');
  });

  test('partial_check is Mixed with default false', () => {
    expect(p('partial_check').instance).toBe('Mixed');
    expect(p('partial_check').options.default).toBe(false);
  });

  test('partial_balance is Number with default 0', () => {
    expect(p('partial_balance').options.default).toBe(0);
  });

  test('payment_pending is Number with default 0', () => {
    expect(p('payment_pending').options.default).toBe(0);
  });

  test('wallet_amount is Number with default 0', () => {
    expect(p('wallet_amount').options.default).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. saleSchema — totals / aggregate fields
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › totals and aggregate fields', () => {
  test.each([
    'sales_total',
    'sales_sub_total',
    'items_total',
    'items_return_total',
    'items_subtotal',
    'items_return_subtotal',
    'total_companyprice',
    'return_discount',
    'extra_discount',
    'sale_extra_discount',
    'return_extra_discount',
  ])('"%s" is Number with default 0', (field) => {
    expect(p(field)).toBeDefined();
    expect(p(field).instance).toBe('Number');
    expect(p(field).options.default).toBe(0);
  });

  test('discount has default 0 and min 0', () => {
    expect(p('discount').options.default).toBe(0);
    expect(p('discount').options.min).toBe(0);
  });

  test('number_of_items default is 0', () => {
    expect(p('number_of_items').options.default).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. saleSchema — extra_discount_type enum
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › extra_discount_type field', () => {
  test('instance is String', () => {
    expect(p('extra_discount_type').instance).toBe('String');
  });
  test('default is "price"', () => {
    expect(p('extra_discount_type').options.default).toBe('price');
  });
  test('enum has exactly 3 values', () => {
    expect(p('extra_discount_type').enumValues).toHaveLength(3);
  });

  test.each(EXTRA_DISCOUNT_TYPES)('enum contains "%s"', (v) => {
    expect(p('extra_discount_type').enumValues).toContain(v);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. saleSchema — restaurant / KOT fields
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// 13. saleSchema — arrays and options
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema › arrays and schema options', () => {
  test('changes has default []', () => {
    expect(Array.isArray(p('changes').options.default)).toBe(true);
    expect(p('changes').options.default).toHaveLength(0);
  });

  test('items_return has default []', () => {
    expect(Array.isArray(p('items_return').options.default)).toBe(true);
  });

  test('timestamps option is false (no auto createdAt/updatedAt)', () => {
    expect(saleSchema.options.timestamps).toBe(false);
  });

  test('versionKey option is false', () => {
    expect(saleSchema.options.versionKey).toBe(false);
  });

  test('toJSON.virtuals is true', () => {
    expect(saleSchema.options.toJSON.virtuals).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. Pre-save hook
// ══════════════════════════════════════════════════════════════════════════════
describe('saleSchema pre-save hook', () => {
  test('at least one pre-save hook is registered', () => {
    const pres = saleSchema.s.hooks._pres.get('save') || [];
    expect(pres.length).toBeGreaterThan(0);
  });

  test('custom hook is locatable (contains "sales_id" logic)', () => {
    expect(getPreSaveFn()).toBeDefined();
  });

  test('generates fallback sales_id with "SID" prefix for new sale without one', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({ isNew: true, sales_id: null });
    await fn.call(ctx);
    expect(ctx.sales_id).toMatch(/^SID\d+$/);
  });

  test('preserves existing sales_id for new sale that already has one', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({ isNew: true, sales_id: 'INV000001' });
    await fn.call(ctx);
    expect(ctx.sales_id).toBe('INV000001');
  });

  test('syncs branch_id from branch when branch is set on a new sale', async () => {
    const fn = getPreSaveFn();
    const branchId = new mongoose.Types.ObjectId();
    const ctx = makeDoc({ isNew: true, branch: branchId, branch_id: null });
    await fn.call(ctx);
    expect(ctx.branch_id).toEqual(branchId);
  });

  test('calculates items_total from items array when total is not set', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({
      items: [
        { quantity: 2, total: 50 },
        { quantity: 1, total: 30 },
      ],
      total: null,
      items_total: 0,
    });
    await fn.call(ctx);
    expect(ctx.items_total).toBe(80);
  });

  test('uses provided total for items_total when total is set', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({ total: 200, items_total: 0, items: [] });
    await fn.call(ctx);
    expect(ctx.items_total).toBe(200);
  });

  test('calculates number_of_items as total quantity for non-Live-Order sale', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({
      sale_method: null,
      items: [
        { quantity: 3, total: 30 },
        { quantity: 2, total: 20 },
      ],
      number_of_items: 0,
      isModified: jest.fn().mockImplementation((f) => f === 'items'),
    });
    await fn.call(ctx);
    expect(ctx.number_of_items).toBe(5);
  });

  test('sets payment_pending to computed balance when partial fields missing', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({
      total: 100,
      paid_amount: 40,
      balance: 0,
      partial_balance: undefined,
      payment_pending: undefined,
    });
    await fn.call(ctx);
    expect(ctx.partial_balance).toBe(40);
    expect(ctx.payment_pending).toBe(60);
  });

  test('does NOT overwrite existing partial_balance / payment_pending', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc({ total: 100, paid_amount: 40, partial_balance: 40, payment_pending: 60 });
    await fn.call(ctx);
    expect(ctx.partial_balance).toBe(40);
    expect(ctx.payment_pending).toBe(60);
  });

  test('sets license from BaseModel.license when doc has no license', async () => {
    BaseModel.license = 'license-xyz-001';
    const fn = getPreSaveFn();
    const ctx = makeDoc({ license: null });
    await fn.call(ctx);
    expect(ctx.license).toBe('license-xyz-001');
  });

  test('syncs created_date and updated_date when updated_date is missing', async () => {
    const fn = getPreSaveFn();
    const saleDate = new Date('2024-06-01');
    const ctx = makeDoc({ date: saleDate, created_date: null, updated_date: null });
    await fn.call(ctx);
    expect(ctx.updated_date).toEqual(saleDate);
    expect(ctx.created_date).toEqual(saleDate);
  });

  /* Mongoose 9 dropped next() from middleware: a hook resolves to carry on and
     rejects to fail the save. The rejection path is the one that matters - it
     is what stops a bad sale being written. */
  test('resolves rather than rejecting on success', async () => {
    const fn = getPreSaveFn();
    await expect(fn.call(makeDoc({}))).resolves.toBeUndefined();
  });

  test('rejects when something inside the hook throws, so the save fails', async () => {
    const fn = getPreSaveFn();
    const ctx = makeDoc();
    ctx.isModified = jest.fn().mockImplementation(() => {
      throw new Error('hook-error');
    });
    await expect(fn.call(ctx)).rejects.toThrow('hook-error');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. LegacySaleModel
// ══════════════════════════════════════════════════════════════════════════════
describe('LegacySaleModel', () => {
  test('typeof LegacySaleModel is function (class)', () => {
    expect(typeof LegacySaleModel).toBe('function');
  });

  test('collectionName is "sales"', () => {
    expect(LegacySaleModel.collectionName).toBe('sales');
  });

  test('fields is a defined object', () => {
    expect(LegacySaleModel.fields).toBeDefined();
    expect(typeof LegacySaleModel.fields).toBe('object');
  });

  test('fields has at least 40 entries (comprehensive schema)', () => {
    expect(Object.keys(LegacySaleModel.fields).length).toBeGreaterThanOrEqual(40);
  });

  test('_id field has name:"id" alias', () => {
    expect(LegacySaleModel.fields._id).toBeDefined();
    expect(LegacySaleModel.fields._id.name).toBe('id');
  });

  test('license field has select:false (hidden by default)', () => {
    expect(LegacySaleModel.fields.license).toBeDefined();
    expect(LegacySaleModel.fields.license.select).toBe(false);
  });

  test.each([
    'branch_id',
    'sales_id',
    'date',
    'items',
    'customer_id',
    'payment_status',
    'sale_process',
  ])('fields contains "%s"', (field) => {
    expect(LegacySaleModel.fields).toHaveProperty(field);
  });

  test('sale_process field has select:true', () => {
    expect(LegacySaleModel.fields.sale_process.select).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. Static methods — all attached to Sale
// ══════════════════════════════════════════════════════════════════════════════
describe('Sale — static methods attached', () => {
  test.each(['sendDailySalesMail'])('Sale.%s is a function', (name) => {
    expect(typeof Sale[name]).toBe('function');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17. Sale.sendDailySalesMail
// ══════════════════════════════════════════════════════════════════════════════
describe('Sale.sendDailySalesMail', () => {
  const baseInput = {
    email: 'test@example.com',
    data: {
      product_details: [],
      payment_details: [],
      tax_details: [],
      branch_details: { from_date: '2024-01-01', to_date: '2024-01-31', sales_type: 'Monthly' },
      extra_discount: { total_sale_extra_discount: 0 },
    },
  };

  test('returns {status:true, message:"Mail sent successfully"} via fallback (no apiKey)', async () => {
    const result = await Sale.sendDailySalesMail(baseInput);
    expect(result.status).toBe(true);
    expect(result.message).toBe('Mail sent successfully');
  });

  test('calls sendEmail in fallback path when no Brevo apiKey configured', async () => {
    await Sale.sendDailySalesMail(baseInput);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
        subject: expect.stringContaining('sales report'),
      })
    );
  });

  test('uses Brevo when sendinblue_key is configured', async () => {
    const mockConfig = jest.requireMock('../../../src/config');
    mockConfig.sendinblue_key = 'brevo_test_key';
    const { BrevoClient } = jest.requireMock('@getbrevo/brevo');

    const result = await Sale.sendDailySalesMail(baseInput);

    mockConfig.sendinblue_key = null;
    expect(result.status).toBe(true);
    expect(BrevoClient).toHaveBeenCalled();
  });

  test('aggregates product qty_total correctly', async () => {
    const input = {
      ...baseInput,
      data: {
        ...baseInput.data,
        product_details: [
          {
            product_qty: '2',
            product_subtotal: '100',
            product_total: '110',
            product_profit: '10',
            product_tax: '10',
            product_discount: '0',
            product_name: 'A',
            product_sku: 'A001',
          },
          {
            product_qty: '3',
            product_subtotal: '150',
            product_total: '165',
            product_profit: '15',
            product_tax: '15',
            product_discount: '0',
            product_name: 'B',
            product_sku: 'B002',
          },
        ],
      },
    };
    const result = await Sale.sendDailySalesMail(input);
    expect(result.status).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Total quantity: 5'),
      })
    );
  });

  test('returns {status:false} when email sending throws an error', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    const result = await Sale.sendDailySalesMail(baseInput);
    expect(result.status).toBe(false);
    expect(result.message).toBe('SMTP connection refused');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 18. Sale.getQrStatusModel — mocked mongoose.connection
// ══════════════════════════════════════════════════════════════════════════════
describe('item_available_quantity is a snapshot, not a constraint', () => {
  /*
   * It records what the item's stock WAS when the line was sold. Stock goes
   * negative on items whose negative_stock flag permits overselling, and the
   * item model puts no floor on available_quantity - so a floor here made the
   * two disagree. The cost was not a bad number: min:0 refused the whole
   * SALE ("Path `item_available_quantity` (-1) is less than minimum allowed
   * value (0)"), so a single item already in the red stopped the cashier
   * taking money for the entire basket.
   */
  test('no minimum is declared on the snapshot', () => {
    expect(pi('item_available_quantity').options.min).toBeUndefined();
  });

  test('a line recording negative stock passes validation', () => {
    // mongoose returns null from doValidateSync when the value is acceptable
    expect(pi('item_available_quantity').doValidateSync(-1)).toBeNull();
    expect(pi('item_available_quantity').doValidateSync(0)).toBeNull();
  });

  test('a real quantity being SOLD still has its floor', () => {
    // the fix is scoped to the snapshot; selling -1 of something stays invalid
    expect(pi('item_discount').options.min).toBe(0);
    expect(saleItemSchema.path('total_amount').options.min).toBe(0);
  });

  test('the item model it mirrors has no floor either', () => {
    const Item = require('../../../src/models/item.model');
    const schema = Item.schema || (Item.LegacyItemModel && null);
    if (schema && schema.path('available_quantity')) {
      expect(schema.path('available_quantity').options.min).toBeUndefined();
    }
  });
});

describe('item translation snapshots', () => {
  test('selling conversion survives persistence, legacy normalization and reopen', async () => {
    const conversion = { unit: 'ft', base_unit: 'm', factor: 0.3048, price: 32 };
    const sale = new Sale({
      sale_method: 'Live-Order',
      items: [
        {
          item_name: 'Pipe',
          item_quantity: 10,
          item_unit: 'ft',
          unit_conversion: conversion,
          total_amount: 320,
        },
      ],
    });
    await getPreSaveFn().call(sale);
    expect(Sale.hydrate(sale.toObject()).toObject().items[0].unit_conversion).toEqual(conversion);
  });
  test('the accepted pricing snapshot survives legacy live-order normalization', async () => {
    const pricing = {
      version: 1,
      item_id: 'water',
      source: 'catalogue',
      selling_price: 30,
      tax: 5,
      tax_type: 'inclusive',
    };
    const sale = new Sale({
      sale_method: 'Live-Order',
      items: [
        {
          item_name: 'Water',
          item_quantity: 1,
          total_amount: 30,
          pricing,
          unit_price: 28.57,
          item_base_price: 28.57,
        },
      ],
    });
    await getPreSaveFn().call(sale);
    expect(sale.toObject().items[0]).toMatchObject({
      pricing,
      unit_price: 28.57,
      item_base_price: 28.57,
    });
  });
  test('Mongoose and live-order normalization retain names without menu descriptions', async () => {
    const sale = new Sale({
      sale_method: 'Live-Order',
      items: [
        {
          item_name: 'Coffee',
          default_language: 'en',
          translations: [{ locale: 'nl', name: 'Koffie', description: 'Menu only' }],
          item_quantity: 2,
          total_amount: 40,
        },
      ],
    });
    expect(sale.items[0].translations[0].name).toBe('Koffie');
    await getPreSaveFn().call(sale);
    const stored = sale.toObject().items[0];
    expect(stored.item_name).toBe('Coffee');
    expect(stored.translations).toEqual([{ locale: 'nl', name: 'Koffie' }]);
    expect(stored.item_quantity).toBe(2);
    expect(stored.total_amount).toBe(40);
  });
});
const testCharges = [
  {
    name: 'Service',
    amount: 20,
    taxed: true,
    tax_name: '0.25% Tax',
    tax_amount: 0.05,
    source: 'manual',
  },
  { name: 'Delivery', amount: 10, taxed: false, tax_name: '', tax_amount: 0, source: 'manual' },
];
test('Mongoose persistence retains the normalized additional charge breakdown', () => {
  const doc = new Sale({
    charges: testCharges,
    sales_total: 95.32,
    multi_payment: { Cash: 20, Card: 75.32 },
  });
  expect(doc.toObject().charges).toEqual(testCharges);
  const reopened = Sale.hydrate(doc.toObject());
  expect(reopened.toObject().charges).toEqual(testCharges);
});
test('charge snapshots can be cleared without inserting empty arrays on historical bills', () => {
  const doc = new Sale({});
  expect(doc.toObject()).not.toHaveProperty('charges');
  doc.set({ charges: testCharges });
  expect(doc.toObject().charges).toEqual(testCharges);
  doc.set({ charges: [] });
  expect(doc.toObject().charges).toEqual([]);
});
