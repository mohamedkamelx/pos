'use strict';

/**
 * Debt is derived from sale and purchase documents. These tests pin the two
 * rules that keep it honest: a collection moves the document's own paid and
 * balance fields, and allocation always starts with the oldest open document.
 */

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

jest.mock('../../../src/models/base.model', () => {
  class MockBaseModel {
    constructor(collectionName) {
      this.collectionName = collectionName;
    }
  }
  MockBaseModel.license = null;
  MockBaseModel.currentBranch = null;
  MockBaseModel.loggedUser = null;
  MockBaseModel.loggedUserName = '';
  return MockBaseModel;
});

const DebtRepository = require('../../../src/repositories/debt.repository');
const BaseModel = require('../../../src/models/base.model');

const LICENSE = '64f9a1c2e3b4d5e6f7000001';
const BRANCH_A = '64f9a1c2e3b4d5e6f7000002';
const BRANCH_B = '64f9a1c2e3b4d5e6f7000003';

const chain = (rows) => ({
  sort: jest.fn().mockReturnThis(),
  toArray: jest.fn().mockResolvedValue(rows),
});

describe('DebtRepository', () => {
  let repo;
  let salesCol;
  let receivingsCol;
  let transactionsCol;
  let paymentsCol;

  beforeEach(() => {
    jest.clearAllMocks();
    BaseModel.license = LICENSE;

    salesCol = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      find: jest.fn().mockReturnValue(chain([])),
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    receivingsCol = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      find: jest.fn().mockReturnValue(chain([])),
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    transactionsCol = {
      find: jest.fn().mockReturnValue(chain([])),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    paymentsCol = {
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      find: jest.fn().mockReturnValue(chain([])),
      findOne: jest.fn().mockResolvedValue(null),
      insertOne: jest.fn().mockResolvedValue({ insertedId: 'payment-1' }),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    };

    repo = new DebtRepository();
    repo.getCollection = jest.fn().mockImplementation((name) => {
      if (name === 'sales') return Promise.resolve(salesCol);
      if (name === 'receivings') return Promise.resolve(receivingsCol);
      if (name === 'transaction') return Promise.resolve(transactionsCol);
      return Promise.resolve(paymentsCol);
    });
  });

  describe('customer sale balance', () => {
    test('treats a missing paid_amount as missing, not as zero', async () => {
      salesCol.findOne.mockResolvedValue({
        _id: 'sale-1',
        total: 100,
        paid_amount: null,
        partial_balance: 40,
        payment_pending: 60,
        balance: 60,
        payment_status: 'Partialy Paid',
      });

      const result = await repo.updateCustomerSale('sale-1', 10);

      expect(result).toEqual({ amount: 10, before: 60, after: 50 });
      const set = salesCol.updateOne.mock.calls[0][1].$set;
      expect(set.paid_amount).toBe(50);
      expect(set.partial_balance).toBe(50);
      expect(set.payment_pending).toBe(50);
      expect(set.balance).toBe(50);
      expect(set.payment_status).toBe('Partialy Paid');
    });

    test('never applies more than the open balance and closes the sale', async () => {
      salesCol.findOne.mockResolvedValue({
        _id: 'sale-1',
        total: 100,
        paid_amount: 40,
        partial_balance: 40,
        payment_pending: 60,
        balance: 60,
        payment_status: 'Partialy Paid',
      });

      const result = await repo.updateCustomerSale('sale-1', 999);

      expect(result.amount).toBe(60);
      const set = salesCol.updateOne.mock.calls[0][1].$set;
      expect(set.paid_amount).toBe(100);
      expect(set.balance).toBe(0);
      expect(set.payment_pending).toBe(0);
      expect(set.payment_status).toBe('Paid');
    });

    test('reads sales_total, the field a real sale actually stores', async () => {
      salesCol.findOne.mockResolvedValue({
        _id: 'sale-1',
        sales_total: 100,
        payment_pending: 100,
        payment_status: 'Unpaid',
      });

      const result = await repo.updateCustomerSale('sale-1', 25);

      expect(result).toEqual({ amount: 25, before: 100, after: 75 });
      const set = salesCol.updateOne.mock.calls[0][1].$set;
      expect(set.paid_amount).toBe(25);
      expect(set.balance).toBe(75);
    });

    test('the customer invoice pipeline projects sales_total into its total', () => {
      const stages = repo.customerInvoiceAggregation([BRANCH_A], true);
      expect(JSON.stringify(stages[1].$project.total)).toContain('"$sales_total"');
    });

    test('moves the matching customer transaction pending down with the sale', async () => {
      salesCol.findOne.mockResolvedValue({
        _id: 'sale-1',
        total: 100,
        paid_amount: 0,
        payment_pending: 100,
        balance: 100,
        payment_status: 'Unpaid',
      });
      const transaction = { _id: 'tx-1', sale_id: 'sale-1', pending: 100 };
      transactionsCol.find.mockReturnValue(chain([transaction]));

      await repo.updateCustomerSale('sale-1', 25);

      expect(transactionsCol.updateOne).toHaveBeenCalledWith(
        { _id: 'tx-1' },
        expect.objectContaining({
          $set: expect.objectContaining({ pending: 75 }),
        })
      );
    });
  });

  describe('supplier purchase balance', () => {
    test('does not hide an old unpaid purchase behind a default zero balance', async () => {
      receivingsCol.findOne.mockResolvedValue({
        _id: 'recv-1',
        total_amount: 100,
        balance: 0,
        payment_status: 'pending',
      });

      const result = await repo.updateSupplierReceiving('recv-1', 40);

      expect(result).toEqual({ amount: 40, before: 100, after: 60 });
      const set = receivingsCol.updateOne.mock.calls[0][1].$set;
      expect(set.paid_amount).toBe(40);
      expect(set.balance).toBe(60);
      expect(set.payment_status).toBe('partial');
    });

    test('uses advance_amount when paid_amount is absent', async () => {
      receivingsCol.findOne.mockResolvedValue({
        _id: 'recv-1',
        total_amount: 100,
        advance_amount: 25,
        payment_status: 'partial',
      });

      const result = await repo.updateSupplierReceiving('recv-1', 50);

      expect(result.amount).toBe(50);
      const set = receivingsCol.updateOne.mock.calls[0][1].$set;
      expect(set.paid_amount).toBe(75);
      expect(set.balance).toBe(25);
    });

    test('does nothing when the purchase is already settled', async () => {
      receivingsCol.findOne.mockResolvedValue({
        _id: 'recv-1',
        total_amount: 100,
        payment_status: 'paid',
      });

      const result = await repo.updateSupplierReceiving('recv-1', 10);

      expect(result).toEqual({ amount: 0, before: 0, after: 0 });
      expect(receivingsCol.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('allocation order', () => {
    test('pays the oldest customer sale first', async () => {
      const oldest = {
        _id: 'sale-old',
        sales_id: 'S-1',
        total: 100,
        payment_pending: 30,
        balance: 30,
        payment_status: 'Partialy Paid',
      };
      const newest = {
        _id: 'sale-new',
        sales_id: 'S-2',
        total: 100,
        payment_pending: 50,
        balance: 50,
        payment_status: 'Partialy Paid',
      };
      jest.spyOn(repo, 'rawCustomerSales').mockResolvedValue([oldest, newest]);
      jest.spyOn(repo, 'updateCustomerSale').mockImplementation(async (id, amount) => ({
        amount,
        before: amount,
        after: 0,
      }));

      const result = await repo.allocateCustomerPayment('customer-1', 60);

      expect(result.allocations).toEqual([
        expect.objectContaining({
          record_id: 'sale-old',
          record_type: 'sale',
          amount: 30,
          document_number: 'S-1',
        }),
        expect.objectContaining({
          record_id: 'sale-new',
          record_type: 'sale',
          amount: 30,
          document_number: 'S-2',
        }),
      ]);
      expect(result.unapplied).toBe(0);
    });

    test('applies a party-wide collection to every open bill', async () => {
      const oldest = {
        _id: 'sale-old',
        sales_id: 'S-1',
        total: 100,
        payment_pending: 100,
        balance: 100,
        payment_status: 'Unpaid',
      };
      const newest = {
        _id: 'sale-new',
        sales_id: 'S-2',
        total: 200,
        payment_pending: 200,
        balance: 200,
        payment_status: 'Unpaid',
      };
      jest.spyOn(repo, 'rawCustomerSales').mockResolvedValue([oldest, newest]);
      jest.spyOn(repo, 'updateCustomerSale').mockImplementation(async (id, amount) => ({
        amount,
        before: amount,
        after: 0,
      }));

      const result = await repo.allocateCustomerPayment('customer-1', 300);

      expect(result.allocations).toEqual([
        expect.objectContaining({ record_id: 'sale-old', amount: 100 }),
        expect.objectContaining({ record_id: 'sale-new', amount: 200 }),
      ]);
      expect(result.unapplied).toBe(0);
    });

    test('settles the oldest bill first when the collection is smaller', async () => {
      jest.spyOn(repo, 'rawCustomerSales').mockResolvedValue([
        {
          _id: 'sale-old',
          sales_id: 'S-1',
          total: 100,
          payment_pending: 100,
          balance: 100,
          payment_status: 'Unpaid',
        },
        {
          _id: 'sale-new',
          sales_id: 'S-2',
          total: 200,
          payment_pending: 200,
          balance: 200,
          payment_status: 'Unpaid',
        },
      ]);
      jest.spyOn(repo, 'updateCustomerSale').mockImplementation(async (id, amount) => ({
        amount,
        before: amount,
        after: 0,
      }));

      const result = await repo.allocateCustomerPayment('customer-1', 50);

      expect(result.allocations).toEqual([
        expect.objectContaining({ record_id: 'sale-old', amount: 50 }),
      ]);
      expect(result.unapplied).toBe(0);
    });

    test('keeps a remainder as unapplied credit', async () => {
      jest.spyOn(repo, 'rawCustomerSales').mockResolvedValue([
        {
          _id: 'sale-1',
          total: 100,
          payment_pending: 20,
          balance: 20,
          payment_status: 'Partialy Paid',
        },
      ]);
      jest.spyOn(repo, 'updateCustomerSale').mockResolvedValue({
        amount: 20,
        before: 20,
        after: 0,
      });

      const result = await repo.allocateCustomerPayment('customer-1', 25);

      expect(result.allocations).toHaveLength(1);
      expect(result.unapplied).toBe(5);
    });

    test('pays only the chosen bill for a targeted settlement', async () => {
      const oldest = {
        _id: 'sale-old',
        sales_id: 'S-1',
        total: 100,
        payment_pending: 60,
        balance: 60,
        payment_status: 'Partialy Paid',
      };
      const newest = {
        _id: 'sale-new',
        sales_id: 'S-2',
        total: 200,
        payment_pending: 200,
        balance: 200,
        payment_status: 'Unpaid',
      };
      jest.spyOn(repo, 'rawCustomerSales').mockResolvedValue([oldest, newest]);
      jest.spyOn(repo, 'updateCustomerSale').mockImplementation(async (id, amount) => ({
        amount,
        before: amount,
        after: 0,
      }));

      const result = await repo.allocateCustomerPayment(
        'customer-1',
        60,
        [],
        new Date(),
        'sale-old'
      );

      expect(result.allocations).toEqual([
        expect.objectContaining({
          record_id: 'sale-old',
          amount: 60,
        }),
      ]);
      expect(result.allocations).toHaveLength(1);
      expect(result.unapplied).toBe(0);
    });

    test('pays the oldest purchase first', async () => {
      jest.spyOn(repo, 'rawSupplierReceivings').mockResolvedValue([
        {
          _id: 'recv-old',
          receiving_id: 'R-1',
          total_amount: 40,
          balance: 40,
          payment_status: 'partial',
        },
        {
          _id: 'recv-new',
          receiving_id: 'R-2',
          total_amount: 40,
          balance: 40,
          payment_status: 'pending',
        },
      ]);
      jest.spyOn(repo, 'updateSupplierReceiving').mockImplementation(async (id, amount) => ({
        amount,
        before: amount,
        after: 0,
      }));

      const result = await repo.allocateSupplierPayment('supplier-1', 50);

      expect(result.allocations.map((row) => row.document_number)).toEqual(['R-1', 'R-2']);
      expect(result.allocations.map((row) => row.amount)).toEqual([40, 10]);
      expect(result.unapplied).toBe(0);
    });
  });

  describe('reversal', () => {
    test('restores every document type recorded on the payment', async () => {
      jest.spyOn(repo, 'restoreCustomerSale').mockResolvedValue({});
      jest.spyOn(repo, 'restoreSupplierReceiving').mockResolvedValue({});

      await repo.restorePaymentAllocations({
        allocations: [
          { record_type: 'sale', record_id: 'sale-1', amount: 10 },
          { record_type: 'receiving', record_id: 'recv-1', amount: 20 },
        ],
      });

      expect(repo.restoreCustomerSale).toHaveBeenCalledWith('sale-1', 10, expect.any(Date));
      expect(repo.restoreSupplierReceiving).toHaveBeenCalledWith('recv-1', 20, expect.any(Date));
    });
  });

  describe('branch scope', () => {
    test('keeps legacy rows without a branch visible to permitted readers', () => {
      const match = repo.baseMatch([BRANCH_A, BRANCH_B]);

      expect(match.license.$in).toContain(LICENSE);
      expect(match.license.$in.some((value) => value && value.toString() === LICENSE)).toBe(true);
      expect(match.$and[0].$or).toEqual(
        expect.arrayContaining([{ branch_id: { $exists: false } }, { branch_id: null }])
      );
    });

    test('accepts both object-id and string branch values', () => {
      const condition = repo.branchCondition([BRANCH_A]);
      const branchIds = condition.$or[0].branch_id.$in;

      expect(branchIds).toHaveLength(2);
      expect(branchIds[1]).toBe(BRANCH_A);
    });

    test('does not reveal a party master row from another branch', async () => {
      const customersCol = {
        findOne: jest.fn().mockResolvedValue(null),
      };
      repo.getCollection.mockImplementation((name) =>
        Promise.resolve(name === 'customers' ? customersCol : paymentsCol)
      );

      const result = await repo.findParty('customer', 'customer-1', [BRANCH_A]);

      expect(result).toBeNull();
      const query = customersCol.findOne.mock.calls[0][0];
      expect(query.license.$in).toContain(LICENSE);
      expect(query.$and[0].$or).toEqual(
        expect.arrayContaining([
          { branch_id: { $in: expect.any(Array) } },
          { branch_id: null },
          { branch_id: { $exists: false } },
        ])
      );
    });
  });
});
