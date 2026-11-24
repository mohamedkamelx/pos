'use strict';

/**
 * The debts API must keep report readers read-only, collections behind party
 * write access, and every branch request inside the user's branch scope.
 */

const mockSvc = {
  summary: jest.fn(),
  listParties: jest.fn(),
  partyStatement: jest.fn(),
  recordPayment: jest.fn(),
  settleInvoice: jest.fn(),
  deletePayment: jest.fn(),
  repository: {
    findPaymentById: jest.fn(),
  },
};

jest.mock('express-async-handler', () => (fn) => fn);

jest.mock('../../../src/services/debt.service', () => jest.fn().mockImplementation(() => mockSvc));

jest.mock('../../../src/models/base.model', () => {
  const state = {};
  class MockBaseModel {
    static get currentBranch() {
      return state.currentBranch;
    }
    static set currentBranch(value) {
      state.currentBranch = value;
    }
    static get currentBranchName() {
      return state.currentBranchName;
    }
    static set currentBranchName(value) {
      state.currentBranchName = value;
    }
    static get license() {
      return state.license;
    }
    static set license(value) {
      state.license = value;
    }
    static get loggedUser() {
      return state.loggedUser;
    }
    static set loggedUser(value) {
      state.loggedUser = value;
    }
    static get loggedUserName() {
      return state.loggedUserName;
    }
    static set loggedUserName(value) {
      state.loggedUserName = value;
    }
  }
  return MockBaseModel;
});

jest.mock('mongodb', () => ({
  ObjectId: Object.assign(
    jest.fn((id) => ({ id, toString: () => String(id) })),
    { isValid: jest.fn(() => true) }
  ),
}));

const controller = require('../../../src/controllers/debts.controller');
const { ObjectId } = require('mongodb');

const LICENSE = '64f9a1c2e3b4d5e6f7000001';
const BRANCH_A = '64f9a1c2e3b4d5e6f7000002';
const BRANCH_B = '64f9a1c2e3b4d5e6f7000003';
const CUSTOMER = '64f9a1c2e3b4d5e6f7000004';
const SUPPLIER = '64f9a1c2e3b4d5e6f7000005';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const req = (overrides = {}) => ({
  body: {},
  params: {},
  query: {},
  headers: {},
  session: {},
  ...overrides,
});

const user = (overrides = {}) => ({
  _id: 'user-1',
  username: 'owner',
  usertype: 'cashier',
  license: LICENSE,
  branch_id: BRANCH_A,
  branch_access: [
    { branch_id: BRANCH_A, branch_name: 'Main' },
    { branch_id: BRANCH_B, branch_name: 'Second' },
  ],
  access: {
    report: { read: true },
    customer: { read: true, write: true, delete: true },
    supplier: { read: true, write: true, delete: true },
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  ObjectId.isValid.mockReturnValue(true);
  mockSvc.listParties.mockResolvedValue({
    data: [],
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 0,
    totals: { outstanding: 0 },
  });
  mockSvc.recordPayment.mockResolvedValue({
    status: true,
    data: { payment: { id: 'pay-1' } },
    message: 'Payment recorded',
  });
  mockSvc.settleInvoice.mockResolvedValue({
    status: true,
    data: { payment: { id: 'pay-1' } },
    message: 'Payment recorded',
  });
  mockSvc.deletePayment.mockResolvedValue({
    status: true,
    data: { payment: { id: 'pay-1' } },
    message: 'Payment removed',
  });
});

describe('DebtsController branch scope', () => {
  test('keeps a restricted user inside their assigned branches', () => {
    const branches = controller.branchIds(req({ user: user() }));

    expect(branches).toEqual([BRANCH_A, BRANCH_B]);
  });

  test('refuses a branch the user cannot access', () => {
    const outsider = '64f9a1c2e3b4d5e6f7000099';

    expect(() => controller.branchIds(req({ user: user(), query: { branch: outsider } }))).toThrow(
      'You do not have access to one of the selected branches'
    );
  });

  test('refuses a malformed branch id', () => {
    ObjectId.isValid.mockReturnValueOnce(false);

    expect(() =>
      controller.branchIds(req({ user: user(), query: { branch: 'not-an-id' } }))
    ).toThrow('Invalid branch ID');
  });

  test('lets an admin use the current branch when none is selected', () => {
    const admin = user({ usertype: 'owner', branch_access: [] });

    expect(controller.branchIds(req({ user: admin }))).toEqual([]);
  });
});

describe('DebtsController permissions', () => {
  test('refuses debt lists without report read access', async () => {
    const res = mockRes();
    const restricted = user({ access: { report: { read: false } } });

    await controller.getCustomers(req({ user: restricted }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSvc.listParties).not.toHaveBeenCalled();
  });

  test('allows a report reader to see the list', async () => {
    const res = mockRes();

    await controller.getCustomers(req({ user: user() }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSvc.listParties).toHaveBeenCalledWith(
      'customer',
      expect.objectContaining({ branchIds: [BRANCH_A, BRANCH_B] })
    );
  });

  test('requires customer write access to collect money', async () => {
    const res = mockRes();
    const restricted = user({
      access: {
        report: { read: true },
        customer: { read: true, write: false },
        supplier: { read: true, write: true },
      },
    });

    await controller.recordPayment(
      req({
        user: restricted,
        body: { party_type: 'customer', party_id: CUSTOMER, amount: 10 },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSvc.recordPayment).not.toHaveBeenCalled();
  });

  test('passes the selected branch to a supplier payment', async () => {
    const res = mockRes();

    await controller.recordPayment(
      req({
        user: user(),
        body: {
          party_type: 'supplier',
          party_id: SUPPLIER,
          amount: 25,
          branch_id: BRANCH_B,
          branch: [BRANCH_B],
        },
      }),
      res
    );

    expect(mockSvc.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        partyType: 'supplier',
        partyId: SUPPLIER,
        amount: 25,
        branchId: BRANCH_B,
        branchIds: [BRANCH_B],
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('passes the chosen bill to a direct settlement', async () => {
    const res = mockRes();

    await controller.settleInvoice(
      req({
        user: user(),
        body: {
          party_type: 'customer',
          party_id: CUSTOMER,
          record_id: 'sale-1',
          branch_id: BRANCH_A,
          branch: [BRANCH_A],
        },
      }),
      res
    );

    expect(mockSvc.settleInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        partyType: 'customer',
        partyId: CUSTOMER,
        recordId: 'sale-1',
        branchId: BRANCH_A,
        branchIds: [BRANCH_A],
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('requires customer write access to settle a bill', async () => {
    const res = mockRes();
    const restricted = user({
      access: {
        report: { read: true },
        customer: { read: true, write: false },
        supplier: { read: true, write: true },
      },
    });

    await controller.settleInvoice(
      req({
        user: restricted,
        body: {
          party_type: 'customer',
          party_id: CUSTOMER,
          record_id: 'sale-1',
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSvc.settleInvoice).not.toHaveBeenCalled();
  });

  test('checks the payment party before allowing a reversal', async () => {
    const res = mockRes();
    mockSvc.repository.findPaymentById.mockResolvedValue({
      _id: 'pay-1',
      party_type: 'supplier',
    });
    const restricted = user({
      access: {
        report: { read: true },
        customer: { read: true, write: true },
        supplier: { read: true, write: false },
      },
    });

    await controller.deletePayment(req({ user: restricted, params: { id: 'pay-1' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSvc.deletePayment).not.toHaveBeenCalled();
  });

  test('removes a payment when the party write permission is present', async () => {
    const res = mockRes();
    mockSvc.repository.findPaymentById.mockResolvedValue({
      _id: 'pay-1',
      party_type: 'customer',
    });

    await controller.deletePayment(req({ user: user(), params: { id: 'pay-1' } }), res);

    expect(mockSvc.deletePayment).toHaveBeenCalledWith('pay-1', {
      branchIds: [BRANCH_A, BRANCH_B],
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
