'use strict';

/**
 * Business rules for the Debts page. The repository moves documents; this
 * service decides what is allowed, what a statement says and which parties
 * still owe money.
 */

jest.mock('../../../src/repositories/debt.repository', () => jest.fn());

jest.mock('../../../src/models/base.model', () => {
  class MockBaseModel {
    constructor(collectionName) {
      this.collectionName = collectionName;
    }
  }
  MockBaseModel.license = null;
  MockBaseModel.currentBranch = null;
  MockBaseModel.currentBranchName = '';
  MockBaseModel.loggedUser = null;
  MockBaseModel.loggedUserName = '';
  return MockBaseModel;
});

jest.mock('mongodb', () => {
  const ObjectId = jest.fn((id) => ({
    _id: String(id),
    toString: () => String(id),
    toHexString: () => String(id),
    equals: (other) => String(id) === String(other),
  }));
  ObjectId.isValid = jest.fn(() => true);
  return { ObjectId };
});

const { ObjectId } = require('mongodb');
const DebtRepository = require('../../../src/repositories/debt.repository');
const BaseModel = require('../../../src/models/base.model');
const DebtService = require('../../../src/services/debt.service');

const LICENSE = '64f9a1c2e3b4d5e6f7000001';
const BRANCH = '64f9a1c2e3b4d5e6f7000002';
const CUSTOMER = '64f9a1c2e3b4d5e6f7000003';
const SUPPLIER = '64f9a1c2e3b4d5e6f7000004';

const invoice = (overrides = {}) => ({
  _id: 'sale-1',
  customer_id: CUSTOMER,
  customer_name: 'Acme',
  customer_phone: '01000000000',
  customer_email: 'acme@example.com',
  number: 'S-1',
  date: new Date('2024-01-10T00:00:00.000Z'),
  total: 100,
  paid: 40,
  balance: 60,
  payment_status: 'Partialy Paid',
  ...overrides,
});

const purchase = (overrides = {}) => ({
  _id: 'recv-1',
  supplier_id: SUPPLIER,
  supplier_name: 'Supplier Co',
  supplier_phone: '02000000000',
  number: 'R-1',
  date: new Date('2024-01-10T00:00:00.000Z'),
  total: 100,
  paid: 40,
  balance: 60,
  payment_status: 'partial',
  ...overrides,
});

const payment = (overrides = {}) => ({
  _id: 'pay-1',
  party_type: 'customer',
  party_id: CUSTOMER,
  date: new Date('2024-02-01T00:00:00.000Z'),
  amount: 10,
  unapplied_amount: 0,
  allocations: [
    {
      record_id: 'sale-1',
      record_type: 'sale',
      amount: 10,
      document_number: 'S-1',
    },
  ],
  note: 'cash',
  created_by_name: 'Owner',
  is_deleted: false,
  ...overrides,
});

describe('DebtService', () => {
  let repo;
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    ObjectId.isValid.mockReturnValue(true);
    BaseModel.license = LICENSE;
    BaseModel.currentBranch = BRANCH;
    BaseModel.currentBranchName = 'Main';
    BaseModel.loggedUser = 'user-1';
    BaseModel.loggedUserName = 'Owner';

    repo = {
      customerInvoices: jest.fn().mockResolvedValue([]),
      supplierInvoices: jest.fn().mockResolvedValue([]),
      paymentTotals: jest.fn().mockResolvedValue(new Map()),
      paymentsForParty: jest.fn().mockResolvedValue([]),
      findParty: jest.fn().mockResolvedValue(null),
      findPaymentByRequestId: jest.fn().mockResolvedValue(null),
      findPaymentById: jest.fn().mockResolvedValue(null),
      createPayment: jest.fn(),
      softDeletePayment: jest.fn(),
      restorePaymentAllocations: jest.fn().mockResolvedValue(undefined),
      allocateCustomerPayment: jest.fn(),
      allocateSupplierPayment: jest.fn(),
      licenseValues: jest.fn().mockReturnValue([LICENSE]),
    };
    DebtRepository.mockImplementation(() => repo);
    service = new DebtService();
  });

  describe('party listing', () => {
    test('only lists parties that still owe money and counts open invoices', async () => {
      repo.customerInvoices.mockResolvedValue([
        invoice(),
        invoice({
          _id: 'sale-old-settled',
          number: 'S-0',
          date: new Date('2023-01-01T00:00:00.000Z'),
          total: 200,
          paid: 200,
          balance: 0,
          payment_status: 'Paid',
        }),
        invoice({
          _id: 'sale-2',
          customer_id: 'another-customer',
          customer_name: 'Settled',
          number: 'S-2',
          total: 50,
          paid: 50,
          balance: 0,
          payment_status: 'Paid',
        }),
      ]);
      repo.paymentTotals.mockResolvedValue(
        new Map([
          [
            CUSTOMER,
            {
              amount: 10,
              allocated: 10,
              unapplied: 0,
              count: 1,
              last_payment: new Date('2024-02-01T00:00:00.000Z'),
            },
          ],
        ])
      );

      const result = await service.listParties('customer', { branchIds: [BRANCH] });

      expect(result.total).toBe(1);
      expect(result.data[0]).toMatchObject({
        id: CUSTOMER,
        name: 'Acme',
        outstanding: 60,
        invoice_count: 1,
        collected: 10,
      });
      // The settled 2023 bill must not become the oldest due date.
      expect(result.data[0].oldest_due).toBe('2024-01-10T00:00:00.000Z');
      expect(result.totals.outstanding).toBe(60);
    });

    test('searches names and invoice numbers beyond the first page', async () => {
      const rows = Array.from({ length: 25 }, (_, index) =>
        invoice({
          _id: 'sale-' + index,
          customer_id: 'customer-' + index,
          customer_name: 'Customer ' + String(index).padStart(2, '0'),
          number: 'S-' + index,
          total: 10,
          paid: 0,
          balance: 10,
        })
      );
      repo.customerInvoices.mockResolvedValue(rows);

      const result = await service.listParties('customer', {
        branchIds: [BRANCH],
        page: 2,
        limit: 10,
        search: 'S-21',
      });

      expect(result.total).toBe(1);
      expect(result.data[0].references).toContain('S-21');
    });

    test('computes receivables, payables and the net position', async () => {
      repo.customerInvoices.mockResolvedValue([invoice()]);
      repo.supplierInvoices.mockResolvedValue([purchase({ total: 80, paid: 30, balance: 50 })]);

      const result = await service.summary([BRANCH]);

      expect(result).toMatchObject({
        receivables: 60,
        payables: 50,
        net: 10,
        customers: 1,
        suppliers: 1,
      });
    });
  });

  describe('statement', () => {
    test('separates paid at sale from money collected later', async () => {
      repo.customerInvoices.mockResolvedValue([
        invoice({
          paid: 50,
          balance: 50,
        }),
        invoice({
          _id: 'sale-2',
          number: 'S-2',
          total: 200,
          paid: 200,
          balance: 0,
          payment_status: 'Paid',
        }),
      ]);
      repo.paymentsForParty.mockResolvedValue([payment()]);
      repo.findParty.mockResolvedValue({
        _id: CUSTOMER,
        name: 'Acme',
        phone: '01000000000',
        address: 'Cairo',
      });

      const result = await service.partyStatement('customer', CUSTOMER, [BRANCH]);

      expect(result.status).toBe(true);
      expect(result.data.summary).toMatchObject({
        invoiced: 300,
        paid_at_sale: 240,
        collected: 10,
        outstanding: 50,
        invoice_count: 2,
        payment_count: 1,
      });
      expect(result.data.invoices[0]).toMatchObject({
        number: 'S-1',
        total: 100,
        paid_at_sale: 40,
        paid_later: 10,
        remaining: 50,
      });
      expect(result.data.invoices[1]).toMatchObject({
        number: 'S-2',
        paid_at_sale: 200,
        paid_later: 0,
        remaining: 0,
      });
      expect(repo.findParty).toHaveBeenCalledWith('customer', CUSTOMER, [BRANCH]);
    });

    test('turns an unapplied collection into customer credit', async () => {
      repo.customerInvoices.mockResolvedValue([invoice({ paid: 100, balance: 0 })]);
      repo.paymentsForParty.mockResolvedValue([
        payment({
          amount: 20,
          allocations: [
            {
              record_id: 'sale-1',
              record_type: 'sale',
              amount: 5,
              document_number: 'S-1',
            },
          ],
          unapplied_amount: 15,
        }),
      ]);

      const result = await service.partyStatement('customer', CUSTOMER, [BRANCH]);

      expect(result.data.summary.outstanding).toBe(0);
      expect(result.data.summary.credit).toBe(15);
    });

    test('returns supplier wording through the same statement shape', async () => {
      repo.supplierInvoices.mockResolvedValue([purchase({ paid: 50, balance: 50 })]);
      repo.paymentsForParty.mockResolvedValue([
        payment({
          party_type: 'supplier',
          party_id: SUPPLIER,
          allocations: [
            {
              record_id: 'recv-1',
              record_type: 'receiving',
              amount: 10,
              document_number: 'R-1',
            },
          ],
        }),
      ]);
      repo.findParty.mockResolvedValue({ _id: SUPPLIER, name: 'Supplier Co' });

      const result = await service.partyStatement('supplier', SUPPLIER, [BRANCH]);

      expect(result.data.party.type).toBe('supplier');
      expect(result.data.invoices[0]).toMatchObject({
        kind: 'purchase',
        paid_at_sale: 40,
        paid_later: 10,
        remaining: 50,
      });
    });

    test('rejects an invalid party id before reading invoices', async () => {
      ObjectId.isValid.mockReturnValueOnce(false);

      const result = await service.partyStatement('customer', 'not-an-id', [BRANCH]);

      expect(result.status).toBe(false);
      expect(repo.customerInvoices).not.toHaveBeenCalled();
    });
  });

  describe('recording a payment', () => {
    const successfulDebt = (outstanding = 100) => ({
      status: true,
      data: {
        id: CUSTOMER,
        name: 'Acme',
        phone: '01000000000',
        outstanding,
        credit: 0,
      },
    });

    beforeEach(() => {
      repo.allocateCustomerPayment.mockResolvedValue({
        allocations: [
          {
            record_id: 'sale-1',
            record_type: 'sale',
            amount: 25,
            document_number: 'S-1',
          },
        ],
        unapplied: 0,
      });
      repo.createPayment.mockImplementation(async (document) => ({
        ...document,
        _id: 'pay-1',
      }));
    });

    test('records one amount, allocates oldest-first and stores an audit row', async () => {
      jest
        .spyOn(service, 'partyDebt')
        .mockResolvedValueOnce(successfulDebt(100))
        .mockResolvedValueOnce(successfulDebt(75));

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        date: '2024-02-01',
        note: 'received',
        requestId: 'request-1',
        branchId: BRANCH,
        branchIds: [BRANCH],
      });

      expect(result.status).toBe(true);
      expect(repo.allocateCustomerPayment).toHaveBeenCalledWith(
        CUSTOMER,
        25,
        [BRANCH],
        expect.any(Date)
      );
      expect(repo.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          party_type: 'customer',
          amount: 25,
          note: 'received',
          request_id: 'request-1',
          source: 'debt',
          allocations: [expect.objectContaining({ record_type: 'sale', amount: 25 })],
          unapplied_amount: 0,
        })
      );
      expect(result.data.payment.id).toBe('pay-1');
      expect(result.data.party.outstanding).toBe(75);
    });

    test('refuses a payment above the outstanding balance', async () => {
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(100));

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 100.01,
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({
        status: false,
        code: 'AMOUNT_EXCEEDS_BALANCE',
      });
      expect(repo.allocateCustomerPayment).not.toHaveBeenCalled();
    });

    test('requires exactly one branch for a collection', async () => {
      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        branchIds: [BRANCH, '64f9a1c2e3b4d5e6f7000005'],
      });

      expect(result).toMatchObject({ status: false, code: 'BRANCH_REQUIRED' });
      expect(repo.allocateCustomerPayment).not.toHaveBeenCalled();
    });

    test('refuses a branch outside the permitted scope', async () => {
      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        branchId: '64f9a1c2e3b4d5e6f7000005',
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({ status: false, code: 'BRANCH_FORBIDDEN' });
      expect(repo.allocateCustomerPayment).not.toHaveBeenCalled();
    });

    test('limits a collection to the selected branch when more are visible', async () => {
      const otherBranch = '64f9a1c2e3b4d5e6f7000005';
      jest
        .spyOn(service, 'partyDebt')
        .mockResolvedValueOnce(successfulDebt(100))
        .mockResolvedValueOnce(successfulDebt(75));

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        branchId: BRANCH,
        branchIds: [BRANCH, otherBranch],
      });

      expect(result.status).toBe(true);
      expect(repo.allocateCustomerPayment).toHaveBeenCalledWith(
        CUSTOMER,
        25,
        [BRANCH],
        expect.any(Date)
      );
      const document = repo.createPayment.mock.calls[0][0];
      expect(String(document.branch_id)).toBe(BRANCH);
    });

    test('refuses a party with nothing outstanding', async () => {
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(0));

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 10,
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({ status: false, code: 'NOTHING_OUTSTANDING' });
      expect(repo.createPayment).not.toHaveBeenCalled();
    });

    test('returns the original payment when the same request is retried', async () => {
      repo.findPaymentByRequestId.mockResolvedValue(
        payment({ request_id: 'request-1', party_type: 'customer', party_id: CUSTOMER })
      );
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(75));

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        requestId: 'request-1',
        branchIds: [BRANCH],
      });

      expect(result.status).toBe(true);
      expect(result.duplicate).toBe(true);
      expect(result.data.payment.id).toBe('pay-1');
      expect(repo.allocateCustomerPayment).not.toHaveBeenCalled();
      expect(repo.createPayment).not.toHaveBeenCalled();
    });

    test('refuses a request id already used for another party', async () => {
      repo.findPaymentByRequestId.mockResolvedValue(
        payment({ request_id: 'request-1', party_id: 'another-customer' })
      );

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        requestId: 'request-1',
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({ status: false, code: 'IDEMPOTENCY_CONFLICT' });
      expect(repo.allocateCustomerPayment).not.toHaveBeenCalled();
    });

    test('puts allocated balances back if the ledger row cannot be written', async () => {
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(100));
      repo.createPayment.mockRejectedValue(new Error('write failed'));

      await expect(
        service.recordPayment({
          partyType: 'customer',
          partyId: CUSTOMER,
          amount: 25,
          branchIds: [BRANCH],
        })
      ).rejects.toThrow('write failed');

      expect(repo.restorePaymentAllocations).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 25, allocations: expect.any(Array) }),
        expect.any(Date)
      );
    });

    test('validates amount, party and date before touching documents', async () => {
      await expect(
        service.recordPayment({ partyType: 'customer', partyId: CUSTOMER, amount: 0 })
      ).resolves.toMatchObject({ code: 'INVALID_AMOUNT' });
      ObjectId.isValid.mockReturnValueOnce(false);
      await expect(
        service.recordPayment({ partyType: 'customer', partyId: 'bad', amount: 10 })
      ).resolves.toMatchObject({ code: 'INVALID_PARTY' });
      ObjectId.isValid.mockReturnValue(true);
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(100));
      await expect(
        service.recordPayment({
          partyType: 'customer',
          partyId: CUSTOMER,
          amount: 10,
          date: 'not-a-date',
          branchIds: [BRANCH],
        })
      ).resolves.toMatchObject({ code: 'INVALID_DATE' });
      expect(repo.allocateCustomerPayment).not.toHaveBeenCalled();
    });

    test('passes the chosen bill to a targeted allocation', async () => {
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(100));

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 25,
        recordId: 'sale-1',
        branchId: BRANCH,
        branchIds: [BRANCH],
      });

      expect(result.status).toBe(true);
      expect(repo.allocateCustomerPayment).toHaveBeenCalledWith(
        CUSTOMER,
        25,
        [BRANCH],
        expect.any(Date),
        'sale-1'
      );
    });

    test('puts a targeted allocation back if the bill changed underneath it', async () => {
      jest.spyOn(service, 'partyDebt').mockResolvedValue(successfulDebt(100));
      repo.allocateCustomerPayment.mockResolvedValue({
        allocations: [
          {
            record_id: 'sale-1',
            record_type: 'sale',
            amount: 50,
            document_number: 'S-1',
          },
        ],
        unapplied: 5,
      });

      const result = await service.recordPayment({
        partyType: 'customer',
        partyId: CUSTOMER,
        amount: 55,
        recordId: 'sale-1',
        branchId: BRANCH,
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({ status: false, code: 'RECORD_CHANGED' });
      expect(repo.createPayment).not.toHaveBeenCalled();
      expect(repo.restorePaymentAllocations).toHaveBeenCalledWith(
        expect.objectContaining({ allocations: expect.any(Array) }),
        expect.any(Date)
      );
    });
  });

  describe('settling one bill', () => {
    test('records the whole outstanding amount without asking for it again', async () => {
      jest.spyOn(service, 'partyStatement').mockResolvedValue({
        status: true,
        data: {
          invoices: [{ id: 'sale-1', number: 'S-1', remaining: 61.25 }],
          outstanding: 161.25,
          party: { id: CUSTOMER, name: 'Acme' },
        },
      });
      const recorded = {
        status: true,
        data: { payment: { id: 'pay-1' }, party: { outstanding: 100 } },
      };
      jest.spyOn(service, 'recordPayment').mockResolvedValue(recorded);

      const result = await service.settleInvoice({
        partyType: 'customer',
        partyId: CUSTOMER,
        recordId: 'sale-1',
        branchId: BRANCH,
        branchIds: [BRANCH],
      });

      expect(result).toBe(recorded);
      expect(service.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          partyType: 'customer',
          partyId: CUSTOMER,
          amount: 61.25,
          recordId: 'sale-1',
          branchId: BRANCH,
          reference: 'S-1',
        })
      );
      expect(service.partyStatement).toHaveBeenCalledWith('customer', CUSTOMER, [BRANCH]);
    });

    test('does nothing for a bill that is already settled', async () => {
      jest.spyOn(service, 'partyStatement').mockResolvedValue({
        status: true,
        data: {
          invoices: [{ id: 'sale-1', number: 'S-1', remaining: 0 }],
          outstanding: 100,
          party: { id: CUSTOMER, name: 'Acme' },
        },
      });
      jest.spyOn(service, 'recordPayment');

      const result = await service.settleInvoice({
        partyType: 'customer',
        partyId: CUSTOMER,
        recordId: 'sale-1',
        branchId: BRANCH,
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({ status: false, code: 'NOTHING_OUTSTANDING' });
      expect(service.recordPayment).not.toHaveBeenCalled();
    });

    test('will not settle a bill from a branch the caller cannot see', async () => {
      const otherBranch = '64f9a1c2e3b4d5e6f7000005';
      jest.spyOn(service, 'partyStatement');

      const result = await service.settleInvoice({
        partyType: 'customer',
        partyId: CUSTOMER,
        recordId: 'sale-1',
        branchId: otherBranch,
        branchIds: [BRANCH],
      });

      expect(result).toMatchObject({ status: false, code: 'BRANCH_FORBIDDEN' });
      expect(service.partyStatement).not.toHaveBeenCalled();
    });
  });

  describe('removing a payment', () => {
    test('restores allocations, soft-deletes the row and returns the new debt', async () => {
      const existing = payment({
        allocations: [{ record_type: 'sale', record_id: 'sale-1', amount: 10 }],
      });
      repo.findPaymentById.mockResolvedValue(existing);
      repo.softDeletePayment.mockResolvedValue({ ...existing, is_deleted: true });
      jest.spyOn(service, 'partyDebt').mockResolvedValue({
        status: true,
        data: { id: CUSTOMER, outstanding: 60, credit: 0 },
      });

      const result = await service.deletePayment('pay-1', { branchIds: [BRANCH] });

      expect(result.status).toBe(true);
      expect(repo.restorePaymentAllocations).toHaveBeenCalledWith(existing, expect.any(Date));
      expect(repo.softDeletePayment).toHaveBeenCalledWith(
        'pay-1',
        expect.objectContaining({ by: 'user-1', byName: 'Owner' }),
        [BRANCH]
      );
      expect(result.data.party.outstanding).toBe(60);
    });

    test('does not restore a payment outside the current branch', async () => {
      repo.findPaymentById.mockResolvedValue(null);

      const result = await service.deletePayment('pay-1', { branchIds: [BRANCH] });

      expect(result).toMatchObject({ status: false, code: 'PAYMENT_NOT_FOUND' });
      expect(repo.restorePaymentAllocations).not.toHaveBeenCalled();
    });
  });
});
