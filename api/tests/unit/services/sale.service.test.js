jest.mock('../../../src/services/desktop-submission', () => ({
  prepare: jest.fn(async () => null),
  lookup: jest.fn(async () => null),
}));
// ─── Mocks (must be declared before requires) ─────────────────────────────────

const mockItemRepositoryInstance = {
  findItemById: jest.fn(),
  updateStock: jest.fn(),
  deductStockIfAvailable: jest.fn(),
};
jest.mock('../../../src/repositories/item.repository', () =>
  jest.fn(() => mockItemRepositoryInstance)
);

const mockCustomerRepositoryInstance = { findById: jest.fn() };
jest.mock('../../../src/repositories/customer.repository', () =>
  jest.fn(() => mockCustomerRepositoryInstance)
);

const mockRegisterRepositoryInstance = {
  addSaleRegisterEntry: jest.fn(),
  updateSaleRegisterEntry: jest.fn(),
  validateSessionOwner: jest.fn(),
};
jest.mock('../../../src/repositories/register.repository', () =>
  jest.fn(() => mockRegisterRepositoryInstance)
);

const mockStockLogsRepositoryInstance = { createStockLog: jest.fn() };
jest.mock('../../../src/repositories/stock-log.repository', () =>
  jest.fn(() => mockStockLogsRepositoryInstance)
);

jest.mock('../../../src/repositories/branch.repository', () => ({
  findById: jest.fn(),
}));

// Billing outlets imports this repository even for ordinary counter sales.
// Keep it isolated from the BaseModel stub used by this service suite.
jest.mock('../../../src/repositories/settings.repository', () => jest.fn());

jest.mock('../../../src/repositories/sale.repository', () => ({
  create: jest.fn(),
  createSaleUnique: jest.fn(),
  buildSalesId: jest.fn(),
  buildDocNumber: jest.fn(),
  generateSalesIdForBranch: jest.fn(),
  deviceTag: jest.fn(),
  getById: jest.fn(),
  save: jest.fn(),
  aggregate: jest.fn(),
  find: jest.fn(),
  paginate: jest.fn(),
  getLegacyDetails: jest.fn(),
  deleteSales: jest.fn(),
  getLastSaleForBranch: jest.fn(),
  nextSalesNumberForBranch: jest.fn(),
  updateWalletAmount: jest.fn(),
}));

jest.mock('../../../src/models/base.model', () => ({
  getDb: jest.fn(),
  currentBranch: null,
  license: null,
  loggedUser: null,
}));

jest.mock('../../../src/models/sale.model', () => function FakeSale() {});

// ─── Requires ─────────────────────────────────────────────────────────────────

const salesRepository = require('../../../src/repositories/sale.repository');
const branchesRepository = require('../../../src/repositories/branch.repository');
const BaseModel = require('../../../src/models/base.model');
const salesService = require('../../../src/services/sale.service');

test('day-end report reads the discount fields the source selects', async () => {
  salesRepository.aggregate.mockResolvedValue([]);
  salesRepository.find.mockImplementation(async (_match, projection) => {
    const row = {
      extra_discount: 10,
      sale_extra_discount: 5,
      extra_discount_type: 'price',
    };
    return [
      Object.fromEntries(
        Object.entries(row).filter(([key]) =>
          typeof projection === 'string' ? projection.split(' ').includes(key) : projection[key]
        )
      ),
    ];
  });
  const result = await salesService.getDailySalesReportAggregates({
    match: {},
    cancellationMatch: {},
  });
  expect(result.salesPayments[0]).toEqual({
    extra_discount: 10,
    sale_extra_discount: 5,
    extra_discount_type: 'price',
  });
});
const { ERROR_MESSAGES } = require('../../../src/constants/sales.constants');
const { NotFoundError, BadRequestError } = require('../../../src/utils/appError');
const { PAYMENT_STATUS, SALE_STATUS } = require('../../../src/constants');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BRANCH_ID = '64f8f2f4c2b9c0a1e4b12345';
const LICENSE_ID = '64f8f2f4c2b9c0a1e4b67890';
const USER_ID = '64f8f2f4c2b9c0a1e4b99999';
const ITEM_ID = '64f8f2f4c2b9c0a1e4b11111';

const makeContext = (overrides = {}) => ({
  branchId: BRANCH_ID,
  licenseId: LICENSE_ID,
  userId: USER_ID,
  userName: 'tester',
  salesPrefix: 'INV',
  stockManagement: true,
  branchSettings: {},
  ...overrides,
});

const makeItemDoc = (overrides = {}) => ({
  _id: { toString: () => ITEM_ID },
  name: 'Test Item',
  itemid: 'SKU001',
  selling_price: 100,
  available_quantity: 50,
  track_inventory: true,
  negative_stock: false,
  tax: 0,
  discount_amount: 0,
  discount_percentage: 0,
  ...overrides,
});

const makeItemPayload = (overrides = {}) => ({
  item_id: ITEM_ID,
  item_quantity: '2',
  item_price_total: '100',
  ...overrides,
});

const makeSaleData = (overrides = {}) => ({
  sales_total: '200',
  payment_mode: 'Cash',
  customer_id: '64f8f2f4c2b9c0a1e4b22222',
  customer_name: 'John Doe',
  customer_phone: '9999999999',
  items: [makeItemPayload()],
  ...overrides,
});

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe('SalesService', () => {
  let consoleErrorSpy;
  let consoleLogSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    salesRepository.getLastSaleForBranch.mockResolvedValue(null);
    salesRepository.nextSalesNumberForBranch.mockResolvedValue(1);
    salesRepository.create.mockResolvedValue({ _id: 'newSaleId' });
    // Each till stamps its own code into the bill number; here that code is
    // "TEST". createSaleUnique delegates to create so create-call assertions
    // still hold.
    salesRepository.deviceTag.mockResolvedValue('TEST');
    salesRepository.buildSalesId.mockImplementation(
      async (prefix, n) => `${prefix}-TEST-${String(n).padStart(6, '0')}`
    );
    // No branch/device codes in the unit context, so buildDocNumber returns the
    // till-tagged fallback - the same shape the assertions already expect.
    salesRepository.buildDocNumber.mockImplementation(
      async (type, branchId, n, opts) =>
        `${(opts && opts.fallbackPrefix) || 'INV'}-TEST-${String(n).padStart(6, '0')}`
    );
    /*
     * The service asks for the WHOLE number now, not for a count it then
     * formats itself. The counter and the format have to move together: they
     * are shared with the customer's own ordering page, and a shop numbering
     * by financial year would otherwise have had the year on one and not the
     * other while both drew on one counter. The number still comes from the
     * counter mock, so the assertions below still say what they said.
     */
    salesRepository.generateSalesIdForBranch.mockImplementation(async (branchId, opts) => {
      const n = await salesRepository.nextSalesNumberForBranch(branchId);
      return `${(opts && opts.fallbackPrefix) || 'INV'}-TEST-${String(n).padStart(6, '0')}`;
    });
    salesRepository.createSaleUnique.mockImplementation((data) => salesRepository.create(data));
    salesRepository.save.mockResolvedValue({ _id: 'savedId' });
    mockCustomerRepositoryInstance.findById.mockResolvedValue(null);
    mockItemRepositoryInstance.updateStock.mockResolvedValue({});
    mockItemRepositoryInstance.deductStockIfAvailable.mockImplementation(
      async (itemId, quantity) => ({
        _id: itemId,
        available_quantity: 50 - Number(quantity),
      })
    );
    mockStockLogsRepositoryInstance.createStockLog.mockResolvedValue({ status: true });
    mockRegisterRepositoryInstance.addSaleRegisterEntry.mockResolvedValue({});
    mockRegisterRepositoryInstance.validateSessionOwner.mockResolvedValue({ status: true });
  });

  test('new counter sale saves the configured quote, ignoring client supplied text', async () => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
    const result = await salesService.processSale(
      makeSaleData({
        receipt_quote: { text: 'Client cannot install this' },
        multi_payment: { Cash: 200 },
      }),
      '',
      'Add',
      makeContext({
        branchSettings: {
          receipt_designs: {
            quoteFooter: { source: 'custom', order: 'sequential', quotes: ['First', 'Second'] },
          },
        },
      })
    );
    expect(result.status).toBe(true);
    expect(salesRepository.create.mock.calls[0][0].receipt_quote).toMatchObject({
      source: 'custom',
      text: 'First',
    });
  });

  test('fresh inclusive quick item completes at the entered total without an override permission', async () => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(
      makeItemDoc({
        item_status: 'instant',
        selling_price: 70,
        tax: 5,
        track_inventory: false,
        negative_stock: true,
      })
    );
    const result = await salesService.processSale(
      makeSaleData({
        sales_total: '70',
        multi_payment: { Cash: 70 },
        items: [
          makeItemPayload({
            item_quantity: '1',
            item_price_total: '70',
            sale_inline_item_price: '70',
            tax: 5,
          }),
        ],
      }),
      '',
      'Add',
      makeContext({ allowCounterPriceOverride: false })
    );
    expect(result.status).toBe(true);
    expect(salesRepository.create.mock.calls[0][0].items[0].pricing).toMatchObject({
      source: 'quick_item',
      selling_price: 70,
    });
  });

  test('ten feet prices in feet but atomically reserves 3.048 metres', async () => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(
      makeItemDoc({
        unit: 'm',
        selling_price: 100,
        available_quantity: 4,
        selling_units: [{ unit: 'ft', factor: 0.3048, price: 32 }],
      })
    );
    const result = await salesService.processSale(
      makeSaleData({
        sales_total: '320',
        multi_payment: { Cash: 320 },
        items: [makeItemPayload({ item_quantity: '10', item_price_total: '32', item_unit: 'ft' })],
      }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(true);
    expect(mockItemRepositoryInstance.deductStockIfAvailable.mock.calls[0][1]).toBe(3.048);
    expect(salesRepository.create.mock.calls[0][0].items[0]).toMatchObject({
      item_quantity: 10,
      item_unit: 'ft',
      item_price: 32,
      unit_conversion: { factor: 0.3048, base_unit: 'm', unit: 'ft' },
    });
    expect(mockStockLogsRepositoryInstance.createStockLog.mock.calls[0][0].item_quantity).toBe(
      3.048
    );
  });

  test('one full length and loose feet share one atomic base-stock reservation', async () => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(
      makeItemDoc({
        unit: 'm',
        selling_price: 100,
        available_quantity: 20,
        selling_units: [
          { unit: 'ft', factor: 0.3048, price: 32 },
          { unit: 'length', factor: 6, price: 550 },
        ],
      })
    );
    const result = await salesService.processSale(
      makeSaleData({
        multi_payment: { Cash: 870 },
        items: [
          makeItemPayload({
            line_id: 'pipe-length',
            item_unit: 'length',
            item_quantity: '1',
            item_price_total: '550',
          }),
          makeItemPayload({
            line_id: 'pipe-feet',
            item_unit: 'ft',
            item_quantity: '10',
            item_price_total: '32',
          }),
        ],
      }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(true);
    expect(mockItemRepositoryInstance.deductStockIfAvailable).toHaveBeenCalledTimes(1);
    expect(mockItemRepositoryInstance.deductStockIfAvailable.mock.calls[0][1]).toBeCloseTo(
      9.048,
      9
    );
    const lines = salesRepository.create.mock.calls[0][0].items;
    expect(
      lines.map((line) => [line.line_id, line.item_unit, line.unit_conversion.factor])
    ).toEqual([
      ['pipe-length', 'length', 6],
      ['pipe-feet', 'ft', 0.3048],
    ]);
    const logs = mockStockLogsRepositoryInstance.createStockLog.mock.calls.map(([log]) => log);
    expect(logs).toHaveLength(2);
    expect(logs[0].opening_balance - logs[0].closing_balance).toBeCloseTo(6, 9);
    expect(logs[1].opening_balance).toBeCloseTo(logs[0].closing_balance, 9);
    expect(logs[1].opening_balance - logs[1].closing_balance).toBeCloseTo(3.048, 9);
  });

  test('mixed units without distinct line identities cannot reserve stock', async () => {
    const result = await salesService.processSale(
      makeSaleData({
        items: [makeItemPayload({ item_unit: 'm' }), makeItemPayload({ item_unit: 'ft' })],
      }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(false);
    expect(mockItemRepositoryInstance.deductStockIfAvailable).not.toHaveBeenCalled();
  });

  describe('fixed-price admission', () => {
    test.each([true, false])(
      'sale-only cart price respects host permission (%s)',
      async (allowed) => {
        const item = makeItemDoc();
        mockItemRepositoryInstance.findItemById.mockResolvedValue(item);
        const result = await salesService.processSale(
          makeSaleData({
            items: [makeItemPayload({ sale_inline_item_price: '70' })],
            sales_total: '140',
            allowCounterPriceOverride: true,
          }),
          '',
          'Add',
          makeContext({ allowCounterPriceOverride: allowed })
        );
        expect(result.status).toBe(allowed);
        expect(item.selling_price).toBe(100);
        if (allowed) {
          const saved = salesRepository.create.mock.calls[0][0];
          expect(saved.items[0].pricing).toMatchObject({
            selling_price: 70,
            catalogue_price: 100,
            source: 'counter_override',
          });
        } else {
          expect(salesRepository.create).not.toHaveBeenCalled();
        }
      }
    );

    test.each(['undefined', 'null', '', '  ', null, undefined])(
      'desktop missing inline override %j uses and validates the selling-price field',
      async (inline) => {
        mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
        const result = await salesService.processSale(
          makeSaleData({ items: [makeItemPayload({ sale_inline_item_price: inline })] }),
          '',
          'Add',
          makeContext()
        );
        expect(result.status).toBe(true);
        expect(salesRepository.create.mock.calls[0][0]).toMatchObject({ sales_total: 200 });
        salesRepository.create.mockClear();
        const invalid = await salesService.processSale(
          makeSaleData({
            items: [makeItemPayload({ sale_inline_item_price: inline, item_price_total: '105' })],
          }),
          '',
          'Add',
          makeContext()
        );
        expect(invalid).toMatchObject({ status: false, data: { state: 'item_price_mismatch' } });
        expect(salesRepository.create).not.toHaveBeenCalled();
      }
    );
    test('the four-item inclusive retail checkout accepts the original legacy retry payload', async () => {
      const prices = [65, 85, 35, 38];
      prices.forEach((selling_price) =>
        mockItemRepositoryInstance.findItemById.mockResolvedValueOnce(
          makeItemDoc({ selling_price, tax: 0.25, tax_type: 'inclusive' })
        )
      );
      const result = await salesService.processSale(
        makeSaleData({
          sales_total: '223',
          multi_payment: { Cash: 223 },
          items: prices.map((price) =>
            makeItemPayload({
              item_quantity: '1',
              sale_inline_item_price: 'undefined',
              item_price_total: String(price),
            })
          ),
        }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(true);
      const saved = salesRepository.create.mock.calls[0][0];
      expect(saved.sales_total).toBe(223);
      expect(saved.total).toBe(saved.sales_total);
      expect(saved.subtotal).toBe(saved.sales_sub_total);
      expect(saved.items_total).toBe(saved.sales_total);
      expect(saved.items.map((line) => line.pricing.selling_price)).toEqual(prices);
    });
  });

  test('name-only customers save a bill snapshot without a customer record', async () => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
    const result = await salesService.processSale(
      makeSaleData({ customer_id: '', customer_name: 'Bharat visitor', customer_email: '' }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(true);
    expect(salesRepository.create.mock.calls[0][0]).toMatchObject({
      customer_id: null,
      customer_name: 'Bharat visitor',
      customer_email: '',
    });
    expect(mockCustomerRepositoryInstance.findById).not.toHaveBeenCalled();
  });

  test('auto-create is finalized only after a successful sale write', async () => {
    const helper = require('../../../src/services/sale-customer');
    const id = new (require('mongodb').ObjectId)();
    const plan = jest.spyOn(helper, 'plan').mockResolvedValue({ id, pending: true });
    const finish = jest.spyOn(helper, 'finish').mockResolvedValue();
    try {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
      const result = await salesService.processSale(
        makeSaleData({ customer_id: '', create_customer_on_save: true }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(true);
      expect(salesRepository.create.mock.calls[0][0].customer_creation_pending).toBe(true);
      expect(String(salesRepository.create.mock.calls[0][0].customer_id)).toBe(String(id));
      expect(finish.mock.invocationCallOrder[0]).toBeGreaterThan(
        salesRepository.create.mock.invocationCallOrder[0]
      );
    } finally {
      plan.mockRestore();
      finish.mockRestore();
    }
  });
  test('a rejected sale never materializes the planned customer', async () => {
    const helper = require('../../../src/services/sale-customer');
    const plan = jest
      .spyOn(helper, 'plan')
      .mockResolvedValue({ id: new (require('mongodb').ObjectId)(), pending: true });
    const finish = jest.spyOn(helper, 'finish').mockResolvedValue();
    try {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(null);
      const result = await salesService.processSale(
        makeSaleData({ customer_id: '', create_customer_on_save: true }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(false);
      expect(finish).not.toHaveBeenCalled();
    } finally {
      plan.mockRestore();
      finish.mockRestore();
    }
  });
  test('name-only customers cannot create a credit account implicitly', async () => {
    const result = await salesService.processSale(
      makeSaleData({ customer_id: '', customer_name: 'Visitor', partial_check: 'true' }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(false);
    expect(salesRepository.create).not.toHaveBeenCalled();
  });

  describe('final-payment integrity', () => {
    const taxableSale = (multi_payment, overrides = {}) =>
      makeSaleData({
        sales_total: '250',
        payment_mode: 'Upi',
        multi_payment,
        items: [makeItemPayload({ item_quantity: '1', item_price_total: '250' })],
        ...overrides,
      });
    beforeEach(() => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(
        makeItemDoc({ selling_price: 250, tax: 5, tax_type: 'exclusive' })
      );
    });
    test.each([251, 260, 262, 263])(
      'refuses %s against a 250 bill before any stock or sale write',
      async (amount) => {
        const result = await salesService.processSale(
          taxableSale({ Upi: amount }, { idempotencyKey: 'rejected-payment-request' }),
          '',
          'Add',
          makeContext()
        );
        expect(result.status).toBe(false);
        expect(result.message).toMatch(/Payment total.*250.00/);
        expect(result.data).toEqual({
          submission_outcome: 'not_saved',
          request_id: 'rejected-payment-request',
        });
        expect(salesRepository.create).not.toHaveBeenCalled();
        expect(mockItemRepositoryInstance.deductStockIfAvailable).not.toHaveBeenCalled();
        expect(mockRegisterRepositoryInstance.addSaleRegisterEntry).not.toHaveBeenCalled();
      }
    );
    test.each([{ Upi: 250 }, { Cash: 100, Upi: 150 }, [{ method: 'Upi', amount: 250 }]])(
      'accepts the exact full tender %j',
      async (payments) => {
        const result = await salesService.processSale(
          taxableSale(payments),
          '',
          'Add',
          makeContext()
        );
        expect(result.status).toBe(true);
        expect(salesRepository.create.mock.calls[0][0]).toMatchObject({
          sales_total: 250,
          payment_status: 'Paid',
          multi_payment: payments,
        });
      }
    );
    test('does not convert an explicit partial payment into a full payment', async () => {
      BaseModel.getDb.mockResolvedValue({
        collection: () => ({ insertOne: jest.fn().mockResolvedValue({}) }),
      });
      const result = await salesService.processSale(
        taxableSale({ Upi: 100 }, { partial_check: 'true', partial_balance: '100' }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(true);
      expect(salesRepository.create.mock.calls[0][0]).toMatchObject({
        payment_status: 'Partialy Paid',
        payment_pending: 150,
      });
    });
    test('a partial flag cannot hide an incorrect full tender', async () => {
      const result = await salesService.processSale(
        taxableSale({ Upi: 251 }, { partial_check: 'true', partial_balance: '250' }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(false);
      expect(salesRepository.create).not.toHaveBeenCalled();
    });
    test.each([{ Upi: -1, Cash: 263.5 }, { Upi: 'bad' }, [{ amount: null }]])(
      'rejects malformed full tender %j',
      async (payments) => {
        const result = await salesService.processSale(
          taxableSale(payments),
          '',
          'Add',
          makeContext()
        );
        expect(result.status).toBe(false);
        expect(salesRepository.create).not.toHaveBeenCalled();
      }
    );
    test('includes an add-to-bill tip in the expected tender', async () => {
      const result = await salesService.processSale(
        taxableSale({ Upi: 250 }, { tip_amount: 10, tip_in_total: true }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(false);
      expect(result.message).toMatch(/260.00/);
    });
    test('an unpaid order can carry a provisional payment method', async () => {
      const result = await salesService.processSale(
        taxableSale({ Upi: 250 }, { unpaid: 'true' }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(true);
      expect(salesRepository.create.mock.calls[0][0].payment_status).toBe('Unpaid');
    });
  });

  test.each([
    { sale_inline_discount_value: 101 },
    { sale_inline_discount_pervalue: 101 },
    { sale_inline_discount_value: -1 },
  ])('invalid item discount fails before writes: %j', async (discount) => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
    const result = await salesService.processSale(
      makeSaleData({ items: [makeItemPayload(discount)] }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(false);
    expect(salesRepository.create).not.toHaveBeenCalled();
    expect(mockItemRepositoryInstance.deductStockIfAvailable).not.toHaveBeenCalled();
  });

  describe('Additional charges in ordinary checkout', () => {
    test.each([
      [0, 'price', [{ name: 'Parcel', amount: 20, taxed: false }], 220],
      [10, 'price', [{ name: 'Parcel', amount: 20, taxed: false }], 210],
      [
        10,
        'percent',
        [
          { name: 'Parcel', amount: 20, taxed: false },
          { name: 'Delivery', amount: 10, taxed: false },
        ],
        210,
      ],
    ])(
      'discount %s %s and charges reach preview, tender and saved sale',
      async (extra, type, charges, total) => {
        mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
        mockCustomerRepositoryInstance.findById.mockResolvedValue({ balance: 0 });
        const data = makeSaleData({
          extra_discount: extra,
          extra_discount_type: type,
          charges,
          sales_total: String(total),
          multi_payment: { Cash: 20, Card: total - 20 },
        });
        const preview = await salesService.previewSale(data, makeContext());
        expect(preview.status).toBe(true);
        expect(preview.data.header.salesTotalForDoc).toBe(total);
        await salesService.processSale(data, '', 'Add', makeContext());
        const written = salesRepository.create.mock.calls[0][0];
        expect(written.sales_total).toBe(total);
        expect(written.charges.map((c) => c.amount)).toEqual(charges.map((c) => c.amount));
      }
    );
  });

  describe('Business decision pricing preview', () => {
    test('a rejected pre-commit decision restores reserved stock and never writes the sale', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
      const beforeCommit = jest.fn(async () => {
        throw new Error('bill_changed');
      });
      const result = await salesService.processSale(makeSaleData(), '', 'Add', makeContext(), {
        beforeCommit,
      });
      expect(result.status).toBe(false);
      expect(beforeCommit).toHaveBeenCalledTimes(1);
      expect(mockItemRepositoryInstance.deductStockIfAvailable).toHaveBeenCalled();
      expect(mockItemRepositoryInstance.updateStock).toHaveBeenCalledWith(expect.anything(), 2);
      expect(salesRepository.create).not.toHaveBeenCalled();
    });

    test('a bill-level decision binds the actual checkout preview and explains rounding in exact minor units', async () => {
      const { prepareDiscountIntent } = require('../../../src/services/business-discount-intent');
      mockItemRepositoryInstance.findItemById.mockResolvedValue(
        makeItemDoc({ selling_price: 100.27 })
      );
      const context = makeContext({
        roundOff: true,
        branchSettings: {
          _id: BRANCH_ID,
          branch_name: 'Central',
          currency: 'INR',
          time_zone: 'Asia/Kolkata',
        },
      });
      const data = makeSaleData({
        billing_transaction_id: 'billing-operation-001',
        items: [makeItemPayload({ item_price_total: '100.27' })],
        extra_discount: 10,
        extra_discount_type: 'percent',
        approval_token: 'old-local-proof',
      });
      const prepared = await prepareDiscountIntent(data, context, 'Regular customer');
      expect(prepared.summary).toEqual({
        currency: 'INR',
        currencyDigits: 2,
        beforeDiscountMinor: 20054,
        discountMinor: 2005,
        payableMinor: 18000,
        roundingMinor: -49,
        itemCount: 1,
        reason: 'Regular customer',
      });
      expect(
        (
          await prepareDiscountIntent(
            { ...data, approval_token: 'another-proof' },
            context,
            'Regular customer'
          )
        ).revisionHash
      ).toBe(prepared.revisionHash);
      expect(
        (
          await prepareDiscountIntent(
            { ...data, customer_id: 'different-customer' },
            context,
            'Regular customer'
          )
        ).revisionHash
      ).not.toBe(prepared.revisionHash);
      expect(salesRepository.create).not.toHaveBeenCalled();
      for (const change of [
        { tip_amount: 1 },
        { partial_check: 'true' },
        { unpaid: 'true' },
        { items: [makeItemPayload({ item_discount: 1 })] },
      ])
        await expect(
          prepareDiscountIntent({ ...data, ...change }, context, 'Reason')
        ).rejects.toMatchObject({ code: 'unsupported_discount_combination' });
      await expect(
        prepareDiscountIntent(
          data,
          { ...context, branchSettings: { ...context.branchSettings, currency: 'JPY' } },
          'Reason'
        )
      ).rejects.toMatchObject({ code: 'unsupported_discount_currency' });
    });

    test('uses checkout prices without allocating a bill, locking a register, writing stock or notifying the kitchen', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
      const data = makeSaleData({
        register_id: '64f8f2f4c2b9c0a1e4b33333',
        extra_discount: 10,
        extra_discount_type: 'percent',
      });
      const preview = await salesService.previewSale(data, makeContext());
      expect(preview.status).toBe(true);
      expect(preview.data.items).toHaveLength(1);
      expect(preview.data).not.toHaveProperty('customer_phone');
      expect(mockRegisterRepositoryInstance.validateSessionOwner).toHaveBeenCalledWith(
        data.register_id,
        makeContext().userId,
        makeContext().deviceId,
        { acquire: false }
      );
      expect(salesRepository.generateSalesIdForBranch).not.toHaveBeenCalled();
      expect(salesRepository.create).not.toHaveBeenCalled();
      expect(salesRepository.save).not.toHaveBeenCalled();
      expect(mockItemRepositoryInstance.deductStockIfAvailable).not.toHaveBeenCalled();
      expect(mockRegisterRepositoryInstance.addSaleRegisterEntry).not.toHaveBeenCalled();
      await salesService.processSale(data, '', 'Add', makeContext());
      const written = salesRepository.create.mock.calls[0][0];
      expect(written.sales_total).toBe(preview.data.header.salesTotalForDoc);
      expect(written.sale_extra_discount).toBe(preview.data.header.salesExtraDiscount);
      expect(written.tax).toBe(preview.data.tax);
    });
    test('rejects an unbounded preview before item queries', async () => {
      const result = await salesService.previewSale(
        makeSaleData({ items: Array.from({ length: 101 }, () => makeItemPayload()) }),
        makeContext()
      );
      expect(result.status).toBe(false);
      expect(mockItemRepositoryInstance.findItemById).not.toHaveBeenCalled();
    });
  });

  describe('Business billed-sales reconciliation uses the actual sale writer', () => {
    test.each([
      {
        name: 'coupon, loyalty and extra discount',
        data: { extra_discount: '10', coupon_discount_value: '15', loyalty_redeem_value: '5' },
        expected: 19000,
      },
      {
        name: 'part-paid bill',
        data: { partial_check: 'true', partial_balance: '50' },
        expected: 20000,
      },
      {
        name: 'tip stays outside sales',
        data: { tip_amount: '30', tip_in_total: 'true' },
        expected: 20000,
      },
      {
        name: 'line tax fields do not inflate the payable total',
        item: { tax: 18, tax_type: 'exclusive' },
        expected: 20000,
      },
      {
        name: 'bill rounding is already applied',
        item: { selling_price: 100.24 },
        data: { items: [makeItemPayload({ item_price_total: '100.24' })] },
        context: { roundOff: true },
        expected: 20000,
      },
    ])('$name', async ({ data, item, context, expected }) => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc(item));
      await salesService.processSale(
        makeSaleData({ ...data, date: '2026-09-28T01:00:00.000Z' }),
        '',
        'Add',
        makeContext(context)
      );
      const written = salesRepository.create.mock.calls[0][0];
      const { saleContribution } = require('../../../src/services/business-metrics');
      const result = saleContribution(
        { ...written, _id: 'c'.repeat(24) },
        {
          id: BRANCH_ID,
          license: LICENSE_ID,
          currency: 'INR',
          currencyDigits: 2,
          timezone: 'Asia/Kolkata',
        }
      );
      expect(result.entries).toEqual([
        {
          businessDate: '2026-09-28',
          billedSalesMinor: expected,
          refundsMinor: 0,
          completedSales: 1,
        },
      ]);
    });
  });

  // ── processSale – validation ──────────────────────────────────────────────

  test('a recovered desktop submission returns its sale before stock is deducted again', async () => {
    mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
    require('../../../src/services/desktop-submission').lookup.mockResolvedValueOnce({
      _id: 'saved-sale',
      sales_id: 'INV-SAVED',
    });
    const result = await salesService.processSale(
      makeSaleData({ idempotencyKey: 'saved-request' }),
      '',
      'Add',
      makeContext()
    );
    expect(result.status).toBe(true);
    expect(result.data._id).toBe('saved-sale');
    expect(result.data.duplicate).toBe(true);
    expect(mockItemRepositoryInstance.deductStockIfAvailable).not.toHaveBeenCalled();
    expect(salesRepository.createSaleUnique).not.toHaveBeenCalled();
  });

  describe('processSale – validation', () => {
    test('returns PAY_TOTAL_INVALID when sales_total is negative', async () => {
      const result = await salesService.processSale(
        { sales_total: '-1' },
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.PAY_TOTAL_INVALID);
      expect(result.data).toBeNull();
    });

    test('returns BRANCH_LICENSE_REQUIRED when branchId is null', async () => {
      const result = await salesService.processSale(
        makeSaleData(),
        '',
        'Add',
        makeContext({ branchId: null })
      );
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.BRANCH_LICENSE_REQUIRED);
    });

    test('returns BRANCH_LICENSE_REQUIRED when licenseId is null', async () => {
      const result = await salesService.processSale(
        makeSaleData(),
        '',
        'Add',
        makeContext({ licenseId: null })
      );
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.BRANCH_LICENSE_REQUIRED);
    });

    test('returns ITEM_REMOVED when item not found in DB', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(null);

      const result = await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.ITEM_REMOVED);
    });

    test('returns INVALID_ITEM_ID when document._id does not match item_id', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue({
        ...makeItemDoc(),
        _id: { toString: () => 'differentId' },
      });

      const result = await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.INVALID_ITEM_ID);
    });

    test('returns insufficient items error when tracked item has insufficient stock', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(
        makeItemDoc({ available_quantity: 1, track_inventory: true, negative_stock: false })
      );

      const data = makeSaleData({ items: [makeItemPayload({ item_quantity: '5' })] });
      const result = await salesService.processSale(data, '', 'Add', makeContext());

      expect(result.status).toBe(false);
      expect(result.message).toMatch(/quantity is mismatched/i);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('allows sale when item has negative_stock enabled', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(
        makeItemDoc({ available_quantity: 0, track_inventory: true, negative_stock: true })
      );

      const result = await salesService.processSale(
        makeSaleData({ items: [makeItemPayload({ item_quantity: '5' })] }),
        '',
        'Add',
        makeContext()
      );
      expect(result.status).toBe(true);
    });
  });

  // ── processSale – Add mode (success) ─────────────────────────────────────

  describe('processSale – Add mode', () => {
    beforeEach(() => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
    });

    test('returns status true and sale data on successful create', async () => {
      const result = await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(result.status).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.message).toBe('Sale saved successfully');
    });

    test('calls salesRepository.create with merged insert+update data', async () => {
      await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(salesRepository.create).toHaveBeenCalledTimes(1);
    });

    test('charge tax figures are not persisted; all charges keep their amount', async () => {
      // Tax on a charge (queue #5): tax_name/tax_amount persist ONLY while
      // taxed is true - a flag flipped off can never leave a stale figure.
      const data = makeSaleData({
        charges: [
          { name: 'Parcel', amount: '50', taxed: 'true', tax_name: 'GST 9%', tax_amount: '4.5' },
          { name: 'Service', amount: '20', taxed: false, tax_name: 'GST 9%', tax_amount: '1.8' },
        ],
      });
      BaseModel.getDb.mockResolvedValue({
        collection: () => ({ findOne: async () => ({ rate: 9, name: 'GST 9%' }) }),
      });
      await salesService.processSale(
        data,
        '',
        'Add',
        makeContext({ branchSettings: { default_tax: ITEM_ID } })
      );
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          charges: [
            {
              name: 'Parcel',
              amount: 50,
              source: 'manual',
            },
            {
              name: 'Service',
              amount: 20,
              source: 'manual',
            },
          ],
        })
      );
    });

    test('generates a till-tagged INV sales_id for new sale', async () => {
      salesRepository.nextSalesNumberForBranch.mockResolvedValue(1);
      await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      // The bill number now carries this till's code so two tills in one branch
      // can never mint the same one. Format: <prefix>-<tag>-<number>.
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ sales_id: 'INV-TEST-000001' })
      );
    });

    test('takes its number from the atomic branch counter', async () => {
      // The counter allocated 6, so the bill is INV-TEST-000006 - the service
      // does not read previous sales at all; that read-then-add-one is what
      // used to mint duplicate bill numbers under concurrency and after merges.
      salesRepository.nextSalesNumberForBranch.mockResolvedValue(6);
      await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ sales_id: 'INV-TEST-000006' })
      );
      expect(salesRepository.getLastSaleForBranch).not.toHaveBeenCalled();
    });

    test('payment_status is Paid when the amount entered covers the total', async () => {
      await salesService.processSale(
        makeSaleData({ partial_check: 'true', partial_balance: '200' }),
        '',
        'Add',
        makeContext()
      );
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_status: 'Paid' })
      );
    });

    test('payment_status is Unpaid when the amount entered is zero', async () => {
      await salesService.processSale(
        makeSaleData({ partial_check: 'true', partial_balance: '0' }),
        '',
        'Add',
        makeContext()
      );
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_status: 'Unpaid' })
      );
    });

    test('payment_status is Unpaid when unpaid flag is true', async () => {
      await salesService.processSale(makeSaleData({ unpaid: 'true' }), '', 'Add', makeContext());
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_status: 'Unpaid' })
      );
    });

    test('sets Partialy Paid status for partial_check=true with lower balance', async () => {
      const data = makeSaleData({
        partial_check: 'true',
        partial_balance: '50',
      });
      await salesService.processSale(data, '', 'Add', makeContext());
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_status: 'Partialy Paid' })
      );
    });

    test('atomically deducts stock for tracked items', async () => {
      await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(mockItemRepositoryInstance.deductStockIfAvailable).toHaveBeenCalledWith(
        expect.anything(),
        2
      );
      expect(mockItemRepositoryInstance.updateStock).not.toHaveBeenCalledWith(
        expect.anything(),
        -2
      );
    });

    test('rejects a concurrent stock conflict before creating the sale', async () => {
      mockItemRepositoryInstance.deductStockIfAvailable.mockResolvedValue(null);
      mockItemRepositoryInstance.findItemById
        .mockResolvedValueOnce(makeItemDoc())
        .mockResolvedValueOnce(makeItemDoc())
        .mockResolvedValueOnce(makeItemDoc({ available_quantity: 1 }));

      const result = await salesService.processSale(makeSaleData(), '', 'Add', makeContext());

      expect(result.status).toBe(false);
      expect(result.message).toContain('another billing counter');
      expect(salesRepository.create).not.toHaveBeenCalled();
    });

    test('skips stock update for non-tracked items', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(
        makeItemDoc({ track_inventory: false })
      );
      await salesService.processSale(makeSaleData(), '', 'Add', makeContext());
      expect(mockItemRepositoryInstance.updateStock).not.toHaveBeenCalled();
    });

    test('creates stock log when stockManagement is enabled', async () => {
      await salesService.processSale(
        makeSaleData(),
        '',
        'Add',
        makeContext({ stockManagement: true })
      );
      expect(mockStockLogsRepositoryInstance.createStockLog).toHaveBeenCalledWith(
        expect.objectContaining({ process: 'Add Sale', action: 'subtract' })
      );
    });

    test('skips stock log when stockManagement is disabled', async () => {
      await salesService.processSale(
        makeSaleData(),
        '',
        'Add',
        makeContext({ stockManagement: false })
      );
      expect(mockStockLogsRepositoryInstance.createStockLog).not.toHaveBeenCalled();
    });

    test('adds register entry when register_id provided', async () => {
      await salesService.processSale(
        makeSaleData({ register_id: 'reg001' }),
        '',
        'Add',
        makeContext()
      );
      expect(mockRegisterRepositoryInstance.addSaleRegisterEntry).toHaveBeenCalledWith(
        expect.objectContaining({ registerId: 'reg001' })
      );
    });

    test('skips register update when register_id not provided', async () => {
      await salesService.processSale(
        makeSaleData({ register_id: undefined }),
        '',
        'Add',
        makeContext()
      );
      expect(mockRegisterRepositoryInstance.addSaleRegisterEntry).not.toHaveBeenCalled();
    });

    test('applies extra_discount (flat) to reduce items total', async () => {
      const data = makeSaleData({ extra_discount: '10', extra_discount_type: 'flat' });
      await salesService.processSale(data, '', 'Add', makeContext());
      expect(salesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ extra_discount: 10 })
      );
    });
  });

  // ── processSale – Edit mode ───────────────────────────────────────────────

  describe('processSale – Edit mode', () => {
    const SALE_ID = '64f8f2f4c2b9c0a1e4b55555';

    describe('a payment changed while the edit was repriced', () => {
      let server, connection, Model;
      beforeAll(async () => {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        const mongoose = require('mongoose');
        server = await MongoMemoryServer.create();
        connection = await mongoose
          .createConnection(server.getUri('desktop-edit-fence'))
          .asPromise();
        Model = connection.model(
          'EditFenceSale',
          new mongoose.Schema(
            {
              partial_balance: { type: Number, default: 0 },
            },
            { strict: false }
          ),
          'sales'
        );
      }, 60000);
      afterAll(async () => {
        await connection?.close();
        await server?.stop();
      });

      test('legacy missing payment fields remain editable after Mongoose supplies defaults', async () => {
        await Model.deleteMany({});
        const { ObjectId } = require('mongodb');
        await Model.collection.insertOne({
          _id: new ObjectId(SALE_ID),
          branch_id: BRANCH_ID,
          license: LICENSE_ID,
          sales_id: 'INV-LEGACY',
          payment_status: 'Unpaid',
          payment_pending: 100,
          sale_process: 'KOT',
          items: [],
          changes: [],
        });
        const original = await Model.findById(SALE_ID);
        expect(original.partial_balance).toBe(0);
        expect(original.$isDefault('partial_balance')).toBe(true);
        salesRepository.getById
          .mockResolvedValueOnce(original)
          .mockImplementationOnce(() => Model.findById(SALE_ID));
        salesRepository.save.mockImplementation((doc) => doc.save());
        const result = await salesService.processSale(
          makeSaleData(),
          SALE_ID,
          'Edit',
          makeContext()
        );
        expect(result.status).toBe(true);
        expect(salesRepository.save).toHaveBeenCalledTimes(1);
      });

      test.each(
        [
          ['payment_status', 'Paid'],
          ['paid_amount', 50],
          ['partial_balance', 50],
          ['partial_amounts', 50],
          ['payment_pending', 0],
        ].flatMap(([field, value]) => ['reload', 'save'].map((stage) => [stage, field, value]))
      )('does not overwrite newer state at %s: %s or move stock', async (stage, field, value) => {
        await Model.deleteMany({});
        const original = await Model.create({
          _id: SALE_ID,
          branch_id: BRANCH_ID,
          license: LICENSE_ID,
          sales_id: 'INV-FENCE',
          payment_status: 'Unpaid',
          payment_pending: 100,
          sale_process: 'KOT',
          items: [],
          changes: [],
        });
        salesRepository.getById.mockResolvedValueOnce(original).mockImplementationOnce(async () => {
          if (stage === 'reload')
            await Model.collection.updateOne({ _id: original._id }, { $set: { [field]: value } });
          return Model.findById(original._id);
        });
        salesRepository.save.mockImplementation(async (doc) => {
          if (stage === 'save')
            await Model.collection.updateOne({ _id: original._id }, { $set: { [field]: value } });
          return doc.save();
        });
        const result = await salesService.processSale(
          makeSaleData(),
          SALE_ID,
          'Edit',
          makeContext()
        );
        expect(result.status).toBe(false);
        expect(salesRepository.save).toHaveBeenCalledTimes(1);
        expect(await Model.collection.findOne({ _id: original._id })).toEqual({
          ...original.toObject(),
          [field]: value,
        });
        expect(mockItemRepositoryInstance.updateStock).not.toHaveBeenCalled();
        expect(mockStockLogsRepositoryInstance.createStockLog).not.toHaveBeenCalled();
        expect(mockRegisterRepositoryInstance.updateSaleRegisterEntry).not.toHaveBeenCalled();
      });
    });

    beforeEach(() => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
    });

    test('returns status false when sale not found for edit', async () => {
      salesRepository.getById.mockResolvedValue(null);

      const result = await salesService.processSale(makeSaleData(), SALE_ID, 'Edit', makeContext());
      expect(result.status).toBe(false);
      expect(result.message).toBe('Sale not found for update');
    });

    test('calls salesRepository.save for edit mode', async () => {
      const fakeSaleDoc = {
        items: [
          {
            item_id: ITEM_ID,
            item_quantity: 1,
            item_name: 'Test',
            item_sku: 'SKU001',
            item_status: '',
            item_unit: 'qty',
            item_price: 100,
          },
        ],
        changes: [],
        set: jest.fn(),
        sales_id: 'INV000001',
      };
      salesRepository.getById
        .mockResolvedValueOnce(fakeSaleDoc) // first call: fetch existing
        .mockResolvedValueOnce(fakeSaleDoc); // second call: fetch for update

      const result = await salesService.processSale(makeSaleData(), SALE_ID, 'Edit', makeContext());
      expect(salesRepository.save).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(true);
    });

    test('an edit after a collection stores the new balance when the bill grows', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
      BaseModel.getDb.mockResolvedValue({
        collection: jest.fn(() => ({
          insertOne: jest.fn().mockResolvedValue({}),
          findOne: jest.fn().mockResolvedValue(null),
          updateOne: jest.fn().mockResolvedValue({}),
        })),
      });
      const fakeSaleDoc = {
        items: [
          {
            item_id: ITEM_ID,
            item_quantity: 2,
            item_name: 'Test',
            item_sku: 'SKU001',
            item_status: '',
            item_unit: 'qty',
            item_price: 100,
          },
        ],
        changes: [],
        set: jest.fn(),
        sales_id: 'INV000001',
        sales_total: 200,
        total: 200,
        partial_check: 'true',
        partial_balance: 50,
        payment_status: 'Partialy Paid',
        payment_pending: 150,
        paid_amount: 50,
        balance: 150,
      };
      salesRepository.getById.mockResolvedValueOnce(fakeSaleDoc).mockResolvedValueOnce(fakeSaleDoc);

      const result = await salesService.processSale(
        makeSaleData({
          items: [makeItemPayload({ item_quantity: '3' })],
          partial_check: 'true',
          partial_balance: '50',
        }),
        SALE_ID,
        'Edit',
        makeContext()
      );

      expect(result.status).toBe(true);
      expect(fakeSaleDoc.set).toHaveBeenCalledWith(
        expect.objectContaining({
          paid_amount: 50,
          balance: 250,
          payment_pending: 250,
          payment_status: 'Partialy Paid',
        })
      );
    });

    test('a stale tender cannot reopen a fully collected sale', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
      BaseModel.getDb.mockResolvedValue({
        collection: jest.fn(() => ({
          insertOne: jest.fn().mockResolvedValue({}),
          findOne: jest.fn().mockResolvedValue(null),
          updateOne: jest.fn().mockResolvedValue({}),
        })),
      });
      const fakeSaleDoc = {
        items: [
          {
            item_id: ITEM_ID,
            item_quantity: 2,
            item_name: 'Test',
            item_sku: 'SKU001',
            item_status: '',
            item_unit: 'qty',
            item_price: 100,
          },
        ],
        changes: [],
        set: jest.fn(),
        sales_id: 'INV000001',
        sales_total: 200,
        total: 200,
        payment_status: 'Paid',
        payment_pending: 0,
        paid_amount: 200,
        balance: 0,
        partial_balance: 200,
      };
      salesRepository.getById.mockResolvedValueOnce(fakeSaleDoc).mockResolvedValueOnce(fakeSaleDoc);

      const result = await salesService.processSale(
        makeSaleData({
          partial_check: 'true',
          partial_balance: '0',
        }),
        SALE_ID,
        'Edit',
        makeContext()
      );

      expect(result.status).toBe(true);
      expect(fakeSaleDoc.set).toHaveBeenCalledWith(
        expect.objectContaining({
          paid_amount: 200,
          balance: 0,
          payment_pending: 0,
          payment_status: 'Paid',
        })
      );
    });

    test('refuses to shrink a bill below money already collected', async () => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());
      const fakeSaleDoc = {
        items: [
          {
            item_id: ITEM_ID,
            item_quantity: 2,
            item_name: 'Test',
            item_sku: 'SKU001',
            item_status: '',
            item_unit: 'qty',
            item_price: 100,
          },
        ],
        changes: [],
        set: jest.fn(),
        sales_id: 'INV000001',
        sales_total: 200,
        total: 200,
        payment_status: 'Paid',
        payment_pending: 0,
        paid_amount: 200,
        balance: 0,
      };
      salesRepository.getById.mockResolvedValueOnce(fakeSaleDoc);

      const result = await salesService.processSale(
        makeSaleData({
          items: [makeItemPayload({ item_quantity: '1' })],
          partial_check: 'true',
          partial_balance: '100',
        }),
        SALE_ID,
        'Edit',
        makeContext()
      );

      expect(result.status).toBe(false);
      expect(result.message).toBe('Sale total cannot be less than the amount already paid');
      expect(salesRepository.save).not.toHaveBeenCalled();
    });
  });

  // ── processSale – transaction/partial payment ─────────────────────────────

  describe('processSale – partial payment transaction', () => {
    beforeEach(() => {
      mockItemRepositoryInstance.findItemById.mockResolvedValue(makeItemDoc());

      const mockCollection = {
        insertOne: jest.fn().mockResolvedValue({}),
        findOne: jest.fn().mockResolvedValue(null),
        updateOne: jest.fn().mockResolvedValue({}),
      };
      BaseModel.getDb.mockResolvedValue({ collection: jest.fn(() => mockCollection) });
    });

    test('inserts transaction record when partial_check is true (Add mode)', async () => {
      const data = makeSaleData({
        partial_check: 'true',
        partial_balance: '100',
        payment_mode: 'Cash',
      });
      const result = await salesService.processSale(data, '', 'Add', makeContext());
      expect(result.status).toBe(true);
      expect(BaseModel.getDb).toHaveBeenCalled();
    });

    test('uses wallet when wallet_check=true and balance covers full amount', async () => {
      const data = makeSaleData({
        partial_check: 'true',
        partial_balance: '200',
        payment_mode: 'Cash',
        wallet_check: 'true',
        customer_current_balance: '300',
      });
      const result = await salesService.processSale(data, '', 'Add', makeContext());
      expect(result.status).toBe(true);
      expect(salesRepository.updateWalletAmount).toHaveBeenCalled();
    });
  });

  // ── getSaleById ───────────────────────────────────────────────────────────

  describe('getSaleById', () => {
    test('returns null when id is falsy', async () => {
      const result = await salesService.getSaleById(null);
      expect(result).toBeNull();
      expect(salesRepository.getById).not.toHaveBeenCalled();
    });

    test('delegates to salesRepository.getById', async () => {
      const mockSale = { _id: 'sale1', sales_id: 'INV000001' };
      salesRepository.getById.mockResolvedValue(mockSale);

      const result = await salesService.getSaleById('sale1');
      expect(salesRepository.getById).toHaveBeenCalledWith('sale1', expect.any(Object));
      expect(result).toBe(mockSale);
    });
  });

  // ── updateSaleStatus ──────────────────────────────────────────────────────

  describe('updateSaleStatus', () => {
    test('throws NotFoundError when sale not found', async () => {
      salesRepository.getById.mockResolvedValue(null);
      await expect(salesService.updateSaleStatus({ id: 'x', status: 'completed' })).rejects.toThrow(
        NotFoundError
      );
    });

    test('throws BadRequestError when sale is already cancelled', async () => {
      salesRepository.getById.mockResolvedValue({ status: SALE_STATUS.CANCELLED });
      await expect(salesService.updateSaleStatus({ id: 'x', status: 'completed' })).rejects.toThrow(
        BadRequestError
      );
    });

    test('updates sale status and calls save', async () => {
      const mockSale = { status: SALE_STATUS.PENDING };
      salesRepository.getById.mockResolvedValue(mockSale);
      salesRepository.save.mockResolvedValue(mockSale);

      const result = await salesService.updateSaleStatus({
        id: 'sale1',
        status: SALE_STATUS.COMPLETED,
      });
      expect(mockSale.status).toBe(SALE_STATUS.COMPLETED);
      expect(salesRepository.save).toHaveBeenCalledWith(mockSale);
      expect(result).toBe(mockSale);
    });
  });

  // ── processSalePayment ────────────────────────────────────────────────────

  describe('processSalePayment', () => {
    test('throws NotFoundError when sale not found', async () => {
      salesRepository.getById.mockResolvedValue(null);
      await expect(
        salesService.processSalePayment({ id: 'x', amount: 100, method: 'Cash' })
      ).rejects.toThrow(NotFoundError);
    });

    test('throws BadRequestError when sale is already paid', async () => {
      salesRepository.getById.mockResolvedValue({ payment_status: PAYMENT_STATUS.PAID });
      await expect(
        salesService.processSalePayment({ id: 'x', amount: 50, method: 'Cash' })
      ).rejects.toThrow(BadRequestError);
    });

    test('appends payment and marks Paid when balance cleared', async () => {
      const mockSale = {
        payment_status: 'Partialy Paid',
        payments: [],
        paid_amount: 50,
        total: 100,
        balance: 50,
      };
      salesRepository.getById.mockResolvedValue(mockSale);
      salesRepository.save.mockResolvedValue(mockSale);

      const result = await salesService.processSalePayment({
        id: 'sale1',
        amount: 50,
        method: 'Cash',
      });

      expect(result.payments).toHaveLength(1);
      expect(result.paid_amount).toBe(100);
      expect(result.payment_status).toBe(PAYMENT_STATUS.PAID);
    });

    test('sets PARTIAL status when balance not fully cleared', async () => {
      const mockSale = {
        payment_status: 'Unpaid',
        payments: [],
        paid_amount: 0,
        total: 200,
        balance: 200,
      };
      salesRepository.getById.mockResolvedValue(mockSale);
      salesRepository.save.mockResolvedValue(mockSale);

      const result = await salesService.processSalePayment({
        id: 'sale1',
        amount: 50,
        method: 'Cash',
      });

      expect(result.payment_status).toBe(PAYMENT_STATUS.PARTIAL);
      expect(result.balance).toBe(150);
    });
  });

  // ── getSalesSummary ───────────────────────────────────────────────────────

  describe('getSalesSummary', () => {
    test('returns default summary when aggregate returns empty array', async () => {
      salesRepository.aggregate.mockResolvedValue([]);

      const result = await salesService.getSalesSummary({ branchId: BRANCH_ID });
      expect(result.totalSales).toBe(0);
      expect(result.totalAmount).toBe(0);
    });

    test('returns first aggregate result when present', async () => {
      const summary = { totalSales: 5, totalAmount: 1000, totalPaid: 800, totalBalance: 200 };
      salesRepository.aggregate.mockResolvedValue([summary]);

      const result = await salesService.getSalesSummary({ branchId: BRANCH_ID });
      expect(result).toBe(summary);
    });

    test('filters by startDate and endDate when provided', async () => {
      salesRepository.aggregate.mockResolvedValue([{ totalSales: 2 }]);

      await salesService.getSalesSummary({
        branchId: BRANCH_ID,
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      const pipeline = salesRepository.aggregate.mock.calls[0][0];
      const matchStage = pipeline.find((s) => s.$match);
      expect(matchStage.$match.createdAt).toBeDefined();
    });
  });

  // ── getSalesByProduct ─────────────────────────────────────────────────────

  describe('getSalesByProduct', () => {
    test('returns aggregation result from repository', async () => {
      const products = [{ _id: 'item1', quantitySold: 5, totalRevenue: 500 }];
      salesRepository.aggregate.mockResolvedValue(products);

      const result = await salesService.getSalesByProduct({ branchId: BRANCH_ID });
      expect(result).toBe(products);
    });
  });

  // ── getLatestSales ────────────────────────────────────────────────────────

  describe('getLatestSales', () => {
    test.each([true, false])(
      'cleared holds are filtered before the page limit (%s)',
      async (holdOnly) => {
        salesRepository.aggregate.mockResolvedValue([]);
        await salesService.getLatestSales({ branchId: BRANCH_ID, licenseId: LICENSE_ID, holdOnly });
        const pipeline = salesRepository.aggregate.mock.calls[0][0];
        const lookupAt = pipeline.findIndex((stage) => stage.$lookup);
        expect(pipeline[lookupAt].$lookup.from).toBe('settings');
        expect(lookupAt).toBeLessThan(pipeline.findIndex((stage) => stage.$limit));
        expect(pipeline[0].$match.license).toBe(LICENSE_ID);
      }
    );
    test('returns empty array when repository returns empty array', async () => {
      salesRepository.aggregate.mockResolvedValue([]);
      const result = await salesService.getLatestSales({ branchId: BRANCH_ID });
      expect(result).toEqual([]);
    });

    test('maps sale documents to simplified LatestSale shape', async () => {
      salesRepository.aggregate.mockResolvedValue([
        {
          _id: { toString: () => 'saleId1' },
          sales_id: 'INV000001',
          customer_name: 'Alice',
          sale_process: 'Add',
          number_of_items: 3,
          sales_total: 300,
          payment_status: 'Paid',
        },
      ]);

      const result = await salesService.getLatestSales({ branchId: BRANCH_ID });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        sales_document_id: 'saleId1',
        sales_id: 'INV000001',
        customer_name: 'Alice',
        number_of_items: 3,
        total_amount: 300,
        payment_status: 'Paid',
      });
    });

    test('falls back to items.length when number_of_items is not a number', async () => {
      salesRepository.aggregate.mockResolvedValue([
        {
          _id: { toString: () => 'saleId2' },
          sales_id: 'INV000002',
          items: [{ name: 'A' }, { name: 'B' }],
          sales_total: 100,
        },
      ]);

      const result = await salesService.getLatestSales({ branchId: BRANCH_ID });
      expect(result[0].number_of_items).toBe(2);
    });

    test('limits to licenseId filter when provided', async () => {
      salesRepository.aggregate.mockResolvedValue([]);
      await salesService.getLatestSales({ branchId: BRANCH_ID, licenseId: LICENSE_ID });

      const pipeline = salesRepository.aggregate.mock.calls[0][0];
      const matchStage = pipeline.find((s) => s.$match);
      expect(matchStage.$match.license).toBe(LICENSE_ID);
    });
  });

  // ── getTablesWithActiveOrders ─────────────────────────────────────────────

  // ── enrichSaleContext ─────────────────────────────────────────────────────

  describe('enrichSaleContext', () => {
    test('returns context unchanged when no branchId', async () => {
      const ctx = { licenseId: LICENSE_ID };
      const result = await salesService.enrichSaleContext(ctx);
      expect(result).toEqual(ctx);
      expect(branchesRepository.findById).not.toHaveBeenCalled();
    });

    test('returns context unchanged when branch not found', async () => {
      branchesRepository.findById.mockResolvedValue(null);
      const ctx = { branchId: BRANCH_ID };
      const result = await salesService.enrichSaleContext(ctx);
      expect(result.branchId).toBe(BRANCH_ID);
    });

    test('enriches context with branch settings when branch found', async () => {
      branchesRepository.findById.mockResolvedValue({
        roundOff: true,
        stock_management: true,
        sales_prefix: 'SDS',
        branch_name: 'Main Branch',
        store_state: 'Tamil Nadu',
        printing_address: '123 Street',
      });

      const result = await salesService.enrichSaleContext({ branchId: BRANCH_ID });
      expect(result.roundOff).toBe(true);
      expect(result.stockManagement).toBe(true);
      expect(result.salesPrefix).toBe('SDS');
      expect(result.branchName).toBe('Main Branch');
      expect(result.branchState).toBe('Tamil Nadu');
    });

    test('falls back to INV prefix when branch has no sales_prefix', async () => {
      branchesRepository.findById.mockResolvedValue({
        stock_management: false,
        branch_name: 'Branch',
      });

      const result = await salesService.enrichSaleContext({
        branchId: BRANCH_ID,
        salesPrefix: 'INV',
      });
      expect(result.salesPrefix).toBe('INV');
    });

    test('returns original context when branch lookup throws', async () => {
      branchesRepository.findById.mockRejectedValue(new Error('DB error'));
      const ctx = { branchId: BRANCH_ID, salesPrefix: 'INV' };
      const result = await salesService.enrichSaleContext(ctx);
      expect(result.salesPrefix).toBe('INV');
    });
  });

  // ── getBranchById ─────────────────────────────────────────────────────────

  describe('getBranchById', () => {
    test('returns null when id is falsy', async () => {
      const result = await salesService.getBranchById(null);
      expect(result).toBeNull();
      expect(branchesRepository.findById).not.toHaveBeenCalled();
    });

    test('delegates to branchesRepository.findById', async () => {
      const branch = { _id: BRANCH_ID, branch_name: 'Main' };
      branchesRepository.findById.mockResolvedValue(branch);

      const result = await salesService.getBranchById(BRANCH_ID);
      expect(branchesRepository.findById).toHaveBeenCalledWith(BRANCH_ID, { lean: true });
      expect(result).toBe(branch);
    });

    test('returns null and does not throw when lookup fails', async () => {
      branchesRepository.findById.mockRejectedValue(new Error('Connection refused'));
      const result = await salesService.getBranchById(BRANCH_ID);
      expect(result).toBeNull();
    });
  });

  // ── pass-through delegations ──────────────────────────────────────────────

  describe('createSale', () => {
    test('delegates to repository.create', async () => {
      const data = { total: 100 };
      const SaleModel = function FakeSale() {};
      const created = { _id: '1' };
      salesRepository.create.mockResolvedValue(created);

      const result = await salesService.createSale(data, { SaleModel });
      expect(salesRepository.create).toHaveBeenCalledWith(data, { SaleModel });
      expect(result).toBe(created);
    });
  });

  describe('listSales', () => {
    test('delegates to repository.paginate', async () => {
      const filter = {};
      const options = { page: 1, limit: 10 };
      const SaleModel = function FakeSale() {};
      const paginated = { results: [], total: 0 };
      salesRepository.paginate.mockResolvedValue(paginated);

      const result = await salesService.listSales(filter, options, { SaleModel });
      expect(salesRepository.paginate).toHaveBeenCalledWith(filter, options, { SaleModel });
      expect(result).toBe(paginated);
    });
  });

  describe('getLegacySaleDetails', () => {
    test('delegates to repository.getLegacyDetails', async () => {
      const id = 'sale-id';
      const SaleModel = function FakeSale() {};
      const details = { status: true, data: {} };
      salesRepository.getLegacyDetails.mockResolvedValue(details);

      const result = await salesService.getLegacySaleDetails(id, { SaleModel });
      expect(salesRepository.getLegacyDetails).toHaveBeenCalledWith(id, { SaleModel });
      expect(result).toBe(details);
    });
  });

  describe('deleteSales', () => {
    test('delegates to repository.deleteSales', async () => {
      const ids = ['id1', 'id2'];
      const SaleModel = function FakeSale() {};
      const del = { status: true, data: { deletedCount: 2 } };
      salesRepository.deleteSales.mockResolvedValue(del);

      const result = await salesService.deleteSales(ids, { SaleModel });
      expect(salesRepository.deleteSales).toHaveBeenCalledWith(ids, { SaleModel });
      expect(result).toBe(del);
    });
  });
});
