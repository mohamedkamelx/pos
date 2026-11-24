'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mock external dependencies BEFORE any require()
// ─────────────────────────────────────────────────────────────────────────────
jest.mock('dotenv', () => ({ config: jest.fn() }));

class MockObjectId {
  constructor(val) {
    if (val === undefined || val === null || val === '') {
      throw new Error('Invalid ObjectId: ' + val);
    }
    this._val = String(val);
  }
  toString() {
    return this._val;
  }
  static isValid(val) {
    return !!val;
  }
}

jest.mock('mongodb', () => ({
  ObjectId: MockObjectId,
  MongoClient: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('[]'),
}));

jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/')),
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Requires (after mocks)
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const bcrypt = require('bcryptjs');
const SettingModel = require('../../../src/models/setting.model');
const BaseModel = require('../../../src/models/base.model');

// ─────────────────────────────────────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────────────────────────────────────
const BRANCH_ID = '507f1f77bcf86cd799439011';
const LICENSE_ID = '507f1f77bcf86cd799439022';
const USER_ID = '507f1f77bcf86cd799439033';
const TAX_ID = '507f1f77bcf86cd799439044';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeMockCollection(overrides = {}) {
  const cursorBase = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    createIndex: jest.fn().mockResolvedValue('table-identity'),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue({ ...cursorBase }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new MockObjectId(TAX_ID) }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    replaceOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...overrides,
  };
}

function makeModel() {
  BaseModel.mongoClient = { db: jest.fn() };
  const m = new SettingModel();
  m.setContext({
    branchId: BRANCH_ID,
    licenseId: LICENSE_ID,
    user: { _id: USER_ID, username: 'testuser', access: {} },
  });
  return m;
}

let consoleErrorSpy;
let consoleLogSpy;
let consoleWarnSpy;

beforeEach(() => {
  jest.clearAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Re-apply defaults cleared by clearAllMocks
  BaseModel.mongoClient = { db: jest.fn() };
  BaseModel.database = null;
  BaseModel.license = null;
  BaseModel.currentBranch = null;
  BaseModel.currentBranchName = null;
  BaseModel.currentBranchCountry = null;
  BaseModel.loggedUser = null;
  BaseModel.loggedUserDetails = null;
  BaseModel.currentTimeZone = null;
  BaseModel.limit = 10;
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Class identity & constructor
// ─────────────────────────────────────────────────────────────────────────────
// QR image generation is a real DB + encoder path. Allow for a loaded machine.
jest.setTimeout(20000);

describe('SettingModel — class identity', () => {
  test('is a function (class)', () => expect(typeof SettingModel).toBe('function'));

  test('extends BaseModel', () => {
    BaseModel.mongoClient = { db: jest.fn() };
    expect(new SettingModel()).toBeInstanceOf(BaseModel);
  });

  test('collectionName is "branches"', () => {
    BaseModel.mongoClient = { db: jest.fn() };
    expect(new SettingModel().collectionName).toBe('branches');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. setContext
// ─────────────────────────────────────────────────────────────────────────────
describe('setContext', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test('sets branchId, licenseId, user', () => {
    m.setContext({ branchId: 'B1', licenseId: 'L1', user: { _id: 'U1' } });
    expect(m.branchId).toBe('B1');
    expect(m.licenseId).toBe('L1');
    expect(m.user).toEqual({ _id: 'U1' });
  });

  test('defaults all to null when called with empty object', () => {
    m.setContext({});
    expect(m.branchId).toBeNull();
    expect(m.licenseId).toBeNull();
    expect(m.user).toBeNull();
  });

  test('resets branchName to null on every call', () => {
    m.branchName = 'CachedName';
    m.setContext({ branchId: 'B2' });
    expect(m.branchName).toBeNull();
  });

  test('called without arguments leaves all null', () => {
    m.setContext();
    expect(m.branchId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. normalizeId
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeId', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test('returns MockObjectId instance for valid string', () => {
    const result = m.normalizeId(BRANCH_ID);
    expect(result).toBeInstanceOf(MockObjectId);
    expect(result.toString()).toBe(BRANCH_ID);
  });

  test('returns null for null', () => expect(m.normalizeId(null)).toBeNull());

  test('returns undefined for undefined', () => expect(m.normalizeId(undefined)).toBeUndefined());

  test('returns 0 for 0 (falsy)', () => expect(m.normalizeId(0)).toBe(0));

  test('returns false for false (falsy)', () => expect(m.normalizeId(false)).toBe(false));

  test('passes string to ObjectId constructor', () => {
    const result = m.normalizeId('abc123xyz000');
    expect(result).toBeInstanceOf(MockObjectId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildFilter
// ─────────────────────────────────────────────────────────────────────────────
describe('buildFilter', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test('includes branch_id and license when both are set', () => {
    const f = m.buildFilter();
    expect(f).toHaveProperty('branch_id');
    expect(f).toHaveProperty('license');
  });

  test('merges extra properties into filter', () => {
    const f = m.buildFilter({ name: 'GST', rate: 18 });
    expect(f.name).toBe('GST');
    expect(f.rate).toBe(18);
  });

  test('omits branch_id when branchId is null', () => {
    m.branchId = null;
    expect(m.buildFilter()).not.toHaveProperty('branch_id');
  });

  test('omits license when licenseId is null', () => {
    m.licenseId = null;
    expect(m.buildFilter()).not.toHaveProperty('license');
  });

  test('returns only extra when both context ids are null', () => {
    m.branchId = null;
    m.licenseId = null;
    expect(m.buildFilter({ x: 1 })).toEqual({ x: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. toBoolean
// ─────────────────────────────────────────────────────────────────────────────
describe('toBoolean', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test.each([
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['yes', true],
    ['no', false],
    ['on', true],
    ['off', false],
    ['TRUE', true],
    ['FALSE', false],
    ['YES', true],
    [1, true],
    [0, false],
    [null, false],
    [undefined, false],
    ['', false],
  ])('toBoolean(%p) === %p', (input, expected) => {
    expect(m.toBoolean(input)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. toNumber
// ─────────────────────────────────────────────────────────────────────────────
describe('toNumber', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test('parses numeric string', () => expect(m.toNumber('42')).toBe(42));
  test('returns float', () => expect(m.toNumber(3.14)).toBe(3.14));
  test('returns 0 for null', () => expect(m.toNumber(null)).toBe(0));
  test('returns 0 for undefined', () => expect(m.toNumber(undefined)).toBe(0));
  test('returns 0 for ""', () => expect(m.toNumber('')).toBe(0));
  test('returns custom fallback for NaN string', () => expect(m.toNumber('abc', 99)).toBe(99));
  test('returns default 0 for NaN string', () => expect(m.toNumber('xyz')).toBe(0));
  test('returns negative numbers correctly', () => expect(m.toNumber('-5')).toBe(-5));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. formatTaxDocument
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 8. loadFallbackTaxData
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 9. getFallbackTaxList
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 10. getBranchName
// ─────────────────────────────────────────────────────────────────────────────
describe('getBranchName', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns cached branchName without DB call', async () => {
    m.branchName = 'Cached Branch';
    const r = await m.getBranchName();
    expect(r).toBe('Cached Branch');
    expect(m.getCollection).not.toHaveBeenCalled();
  });

  test('returns "" when no branchId', async () => {
    m.branchId = null;
    expect(await m.getBranchName()).toBe('');
  });

  test('fetches from DB and caches branch_name', async () => {
    col.findOne.mockResolvedValue({ branch_name: 'My Store' });
    const r = await m.getBranchName();
    expect(r).toBe('My Store');
    expect(m.branchName).toBe('My Store');
  });

  test('returns "" when DB returns null', async () => {
    col.findOne.mockResolvedValue(null);
    expect(await m.getBranchName()).toBe('');
  });

  test('returns "" on DB error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('DB fail'));
    expect(await m.getBranchName()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. getDefaultCustomer
// ─────────────────────────────────────────────────────────────────────────────
describe('getDefaultCustomer', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when no customerId and no branch context', async () => {
    // With a branch context a missing id self-heals to the branch's
    // Walk-in; only the truly contextless call still refuses.
    m.branchId = null;
    const r = await m.getDefaultCustomer(null);
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/required/i);
  });

  test('returns status:false when customer not found', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.getDefaultCustomer(BRANCH_ID);
    expect(r.status).toBe(false);
    expect(r.message).toBe('Customer not found');
  });

  test('returns status:true with nested customer data when found', async () => {
    col.findOne.mockResolvedValue({
      _id: { toString: () => 'cid1' },
      name: 'John Doe',
      phone: '9999999999',
      email: 'john@test.com',
      address: '123 Main St',
      balance: 250,
    });
    const r = await m.getDefaultCustomer(BRANCH_ID);
    expect(r.status).toBe(true);
    expect(r.data.customer_name).toBe('John Doe');
    expect(r.data.customer.customer_balance).toBe(250);
    expect(r.data.customer.customer_phone).toBe('9999999999');
  });

  test('returns status:false on DB error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('DB error'));
    const r = await m.getDefaultCustomer(BRANCH_ID);
    expect(r.status).toBe(false);
    expect(r.message).toBe('DB error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. getDefaultSupplier
// ─────────────────────────────────────────────────────────────────────────────
describe('getDefaultSupplier', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when no supplierId', async () => {
    // With a branch context the supplier self-heals; only contextless refuses.
    m.branchId = null;
    const r = await m.getDefaultSupplier(null);
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/required/i);
  });

  test('returns status:false when supplier not found', async () => {
    const r = await m.getDefaultSupplier(BRANCH_ID);
    expect(r.status).toBe(false);
    expect(r.message).toBe('Supplier not found');
  });

  test('returns status:true with nested supplier data', async () => {
    col.findOne.mockResolvedValue({
      _id: { toString: () => 'sid1' },
      name: 'Supplier A',
      phone: '8888888888',
      address: 'Warehouse 1',
    });
    const r = await m.getDefaultSupplier(BRANCH_ID);
    expect(r.status).toBe(true);
    expect(r.data.supplier_name).toBe('Supplier A');
    expect(r.data.supplier.supplier_phone).toBe('8888888888');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. getDefaultCustomerSupplier
// ─────────────────────────────────────────────────────────────────────────────
describe('getDefaultCustomerSupplier', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when either id is missing', async () => {
    expect((await m.getDefaultCustomerSupplier(null, BRANCH_ID)).status).toBe(false);
    expect((await m.getDefaultCustomerSupplier(BRANCH_ID, null)).status).toBe(false);
    expect((await m.getDefaultCustomerSupplier(null, null)).status).toBe(false);
  });

  test('returns status:false when either record is not found', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.getDefaultCustomerSupplier(BRANCH_ID, TAX_ID);
    expect(r.status).toBe(false);
    expect(r.message).toBe('Not found');
  });

  test('returns status:true with both customer and supplier', async () => {
    col.findOne
      .mockResolvedValueOnce({ _id: { toString: () => 'c1' }, name: 'Cust' })
      .mockResolvedValueOnce({ _id: { toString: () => 's1' }, name: 'Supp' });
    const r = await m.getDefaultCustomerSupplier(BRANCH_ID, TAX_ID);
    expect(r.status).toBe(true);
    expect(r.data.customer_name).toBe('Cust');
    expect(r.data.supplier_name).toBe('Supp');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. getThemeSettings
// ─────────────────────────────────────────────────────────────────────────────
describe('getThemeSettings', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when branchId or licenseId is null', async () => {
    m.branchId = null;
    const r = await m.getThemeSettings();
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/context required/i);
  });

  test('returns status:true with theme_settings when found', async () => {
    col.findOne.mockResolvedValue({ theme_settings: { preset: 'dark', primaryColor: '#000' } });
    const r = await m.getThemeSettings();
    expect(r.status).toBe(true);
    expect(r.data.theme_settings.preset).toBe('dark');
  });

  test('returns status:false when doc has no theme_settings', async () => {
    col.findOne.mockResolvedValue({ branch_name: 'Test' });
    const r = await m.getThemeSettings();
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/no theme settings/i);
  });

  test('returns status:false when doc is null', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.getThemeSettings();
    expect(r.status).toBe(false);
  });

  test('returns status:false on DB error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('fail'));
    const r = await m.getThemeSettings();
    expect(r.status).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. editGeneralSetting
// ─────────────────────────────────────────────────────────────────────────────
describe('editGeneralSetting', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
    jest.spyOn(m, 'updateBranchNameInCollections').mockResolvedValue(true);
  });

  test('saves receipt contact details to the requested branch with tenant scope and a sync timestamp', async () => {
    col.updateOne.mockResolvedValue({ matchedCount: 1 });
    const target = '507f1f77bcf86cd799439099';
    const r = await m.editGeneralSetting({
      target_branch_id: target,
      store_name: 'Sales Centre',
      store_address: ' Office address ',
      printing_address: ' Receipt address ',
      store_email: 'shop+centre@example.com',
      store_telephone: '+919008427482',
    });
    expect(r.status).toBe(true);
    const [filter, update] = col.updateOne.mock.calls[0];
    expect(String(filter._id)).toBe(target);
    expect(String(filter.license)).toBe(LICENSE_ID);
    expect(update.$set).toMatchObject({
      store_address: 'Office address',
      printing_address: 'Receipt address',
      store_email: 'shop+centre@example.com',
      store_telephone: '+919008427482',
    });
    expect(update.$set.updated_date).toBeInstanceOf(Date);
    expect(r.data.printing_address).toBe('Receipt address');
  });

  test('returns status:true on matched update', async () => {
    col.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const r = await m.editGeneralSetting({ store_name: 'My Shop', setting_country: 'IN' });
    expect(r.status).toBe(true);
    expect(r.data).toHaveProperty('branch_name');
  });

  test('returns status:false when no branch matched (matchedCount 0)', async () => {
    col.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const r = await m.editGeneralSetting({ store_name: 'Unknown' });
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/not found/i);
  });

  test('strips GMT offset from time_zone', async () => {
    col.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const r = await m.editGeneralSetting({ store_name: 'S', time_zone: 'Asia/Kolkata (GMT+5:30)' });
    expect(r.status).toBe(true);
    expect(r.data.time_zone).toBe('Asia/Kolkata');
  });

  test('hardware_weight_machine_enable is converted to boolean', async () => {
    col.updateOne.mockResolvedValue({ matchedCount: 1 });
    await m.editGeneralSetting({ hardware_weight_machine_enable: 'true' });
    const [, upd] = col.updateOne.mock.calls[0];
    expect(upd.$set.hardware_weight_machine_enable).toBe(true);
  });

  test('staff_shifts_enable stays on unless explicitly disabled', async () => {
    /*
     * Shipped live: an old client that does not send the field must not
     * switch the clock-in system off. Since the branch-modules work the
     * guarantee is presence-gating - an unsent toggle is left OUT of the
     * $set entirely (the stored value survives untouched), instead of being
     * rewritten to its default. Sent values still parse with the opt-out
     * polarity.
     */
    col.updateOne.mockResolvedValue({ matchedCount: 1 });
    await m.editGeneralSetting({ store_name: 'S' });
    expect('staff_shifts_enable' in col.updateOne.mock.calls[0][1].$set).toBe(false);

    col.updateOne.mockClear();
    await m.editGeneralSetting({ store_name: 'S', staff_shifts_enable: 'false' });
    expect(col.updateOne.mock.calls[0][1].$set.staff_shifts_enable).toBe(false);

    col.updateOne.mockClear();
    await m.editGeneralSetting({ store_name: 'S', staff_shifts_enable: 'true' });
    expect(col.updateOne.mock.calls[0][1].$set.staff_shifts_enable).toBe(true);
  });

  test('tips (opt-in) and roster (opt-out) polarities, unsent toggles untouched', async () => {
    // Unsent: presence-gated out of the $set - the stored values survive.
    col.updateOne.mockResolvedValue({ matchedCount: 1 });
    await m.editGeneralSetting({ store_name: 'S' });
    let set = col.updateOne.mock.calls[0][1].$set;
    expect('staff_tips_enable' in set).toBe(false);
    expect('staff_roster_enable' in set).toBe(false);

    col.updateOne.mockClear();
    await m.editGeneralSetting({
      store_name: 'S',
      staff_tips_enable: 'true',
      staff_roster_enable: 'false',
    });
    set = col.updateOne.mock.calls[0][1].$set;
    expect(set.staff_tips_enable).toBe(true);
    expect(set.staff_roster_enable).toBe(false);

    // Polarity check: an unrecognized value falls to each toggle's default -
    // tips opt-in (garbage means off), roster opt-out (garbage means on).
    col.updateOne.mockClear();
    await m.editGeneralSetting({
      store_name: 'S',
      staff_tips_enable: 'maybe',
      staff_roster_enable: 'maybe',
    });
    set = col.updateOne.mock.calls[0][1].$set;
    expect(set.staff_tips_enable).toBe(false);
    expect(set.staff_roster_enable).toBe(true);
  });

  test('returns status:false on DB error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('crash'));
    const r = await m.editGeneralSetting({ store_name: 'S' });
    expect(r.status).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. updateCommonSettings
// ─────────────────────────────────────────────────────────────────────────────
describe('updateCommonSettings', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test.each([0, '0', 6, 300, undefined])(
    'redirect delay persists without resetting an omitted value: %s',
    async (value) => {
      const r = await m.updateCommonSettings(
        value === undefined ? {} : { sale_redirect_seconds: value }
      );
      expect(r.status).toBe(true);
      const [filter, update] = col.updateOne.mock.calls.at(-1);
      expect(String(filter.license)).toBe(LICENSE_ID);
      expect(String(filter._id)).toBe(BRANCH_ID);
      if (value === undefined) expect(update.$set).not.toHaveProperty('sale_redirect_seconds');
      else expect(update.$set.sale_redirect_seconds).toBe(Number(value));
      expect(update.$set.updated_date).toBeInstanceOf(Date);
    }
  );

  test.each([-1, 301, 1.5, '', 'abc', null, true])(
    'rejects invalid redirect delay before writing: %s',
    async (value) => {
      const r = await m.updateCommonSettings({ sale_redirect_seconds: value });
      expect(r.status).toBe(false);
      expect(r.message).toMatch(/whole number from 0 to 300/);
      expect(col.updateOne).not.toHaveBeenCalled();
    }
  );

  test('returns status:false when context is missing', async () => {
    m.branchId = null;
    const r = await m.updateCommonSettings({});
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/context is required/i);
  });

  test.each([true, false, 'true', 'false', undefined])(
    'hard-delete setting saves explicit values and preserves omitted values: %s',
    async (value) => {
      m.user.usertype = 'super_admin';
      await m.updateCommonSettings(value === undefined ? {} : { allow_sale_hard_delete: value });
      const update = col.updateOne.mock.calls[col.updateOne.mock.calls.length - 1][1].$set;
      if (value === undefined) expect(update).not.toHaveProperty('allow_sale_hard_delete');
      else expect(update.allow_sale_hard_delete).toBe(value === true || value === 'true');
    }
  );

  test.each(['admin', 'owner', 'manager'])(
    'rejects hard-delete setting changes by %s',
    async (role) => {
      m.user.usertype = role;
      const result = await m.updateCommonSettings({ allow_sale_hard_delete: true });
      expect(result.status).toBe(false);
      expect(col.updateOne).not.toHaveBeenCalled();
    }
  );

  test('returns status:true on success', async () => {
    m.user.access = { plan: { read: true } };
    const r = await m.updateCommonSettings({ print_url: 'true', sales_mail: 'false' });
    expect(r.status).toBe(true);
    expect(r.data).toHaveProperty('url');
  });

  test('does NOT include enable_notification_reminders when plan access is false', async () => {
    m.user.access = { plan: { read: false } };
    await m.updateCommonSettings({ enable_notification_reminders: 'true' });
    const branchUpdateCall = col.updateOne.mock.calls[col.updateOne.mock.calls.length - 1];
    expect(branchUpdateCall[1].$set).not.toHaveProperty('enable_notification_reminders');
  });

  test('includes enable_notification_reminders when plan access is truthy', async () => {
    m.user.access = { plan: { read: true } };
    await m.updateCommonSettings({ enable_notification_reminders: 'true' });
    const branchUpdateCall = col.updateOne.mock.calls[col.updateOne.mock.calls.length - 1];
    expect(branchUpdateCall[1].$set).toHaveProperty('enable_notification_reminders', true);
  });

  /*
   * Partial-save safety. This endpoint takes small PATCH-style payloads
   * (the quotation-defaults card, the signature upload) as well as the whole
   * settings form. It used to build ONE $set from the entire form, so a
   * payload carrying four keys wrote undefined/false over every control it
   * never showed - a signature upload could wipe printing, receipts,
   * reminders and business defaults in one go. The rule: a field whose
   * SOURCE key was not sent must not appear in the $set at all.
   */
  const setOf = (col) => {
    const calls = col.updateOne.mock.calls;
    return calls[calls.length - 1][1].$set;
  };

  test('receipt designs persist together and unrelated saves leave them intact', async () => {
    const contract = require('../../../src/helpers/receipt-design');
    const designs = { version: 1, defaultFormat: 'letter', layouts: {} };
    for (const format of Object.keys(contract.formats)) {
      designs.layouts[format] = {
        fontSize: 12,
        blocks: contract.required.map((type) => ({ id: type, type, align: 'left' })),
      };
    }
    const result = await m.updateCommonSettings({ receipt_designs: designs });
    expect(result.status).toBe(true);
    expect(setOf(col).receipt_designs.defaultFormat).toBe('letter');
    expect(Object.keys(setOf(col))).toEqual(
      expect.arrayContaining(['receipt_designs', 'updated_date'])
    );
    expect(setOf(col)).not.toHaveProperty('print_logoimg');
    expect(result.data.receipt_designs).toEqual(designs);
    await m.updateCommonSettings({ printall: 'true' });
    expect(setOf(col)).not.toHaveProperty('receipt_designs');
  });

  test('an uploaded QR survives repeated settings saves and still reaches the bill', async () => {
    const { buildBillPayload } = require('../../../src/helpers/bill-payload');
    const branch = {};
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    col.findOne.mockImplementation(async () => ({ ...branch }));
    col.updateOne.mockImplementation(async (_filter, update) => {
      Object.assign(branch, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    });
    const saved = await m.updateCommonSettings({ footer_image: png, footer_qr_url: '' });
    expect(saved.status).toBe(true);
    expect(branch.footer_image).toBe(png);
    expect(saved.data.footer_image).toBe(png);

    for (let count = 0; count < 3; count++) {
      // Reopening loads the saved address. The form sends no unchanged image.
      const reopened = await col.findOne();
      const result = await m.updateCommonSettings({
        footer_qr_url: reopened.footer_qr_url,
        footer_image_caption: 'Scan our shop',
      });
      expect(result.status).toBe(true);
      expect(result.data.footer_image).toBe(png);
      expect(result.data.footer_image_caption).toBe('Scan our shop');
      expect(setOf(col)).not.toHaveProperty('footer_image');
      expect(buildBillPayload({}, branch).footerImage).toEqual({ src: png });
      expect(buildBillPayload({}, branch).footerImageCaption).toBe('Scan our shop');
    }

    const removed = await m.updateCommonSettings({ footer_image: '', footer_qr_url: '' });
    expect(removed.status).toBe(true);
    expect(removed.data.footer_image).toBe('');
    expect(removed.data.footer_qr_url).toBe('');
    expect(buildBillPayload({}, branch).footerImage).toBeNull();
  });

  test('leaving a footer unchanged preserves both its picture and the QR source', async () => {
    const current = {
      footer_image: 'data:image/png;base64,AAAA',
      footer_qr_url: 'https://example.com/shop',
    };
    col.findOne.mockResolvedValue(current);
    await m.updateCommonSettings({ footer_qr_url: current.footer_qr_url });
    expect(setOf(col)).not.toHaveProperty('footer_image');
    expect(setOf(col)).not.toHaveProperty('footer_qr_url');
    await m.updateCommonSettings({ footer_qr_url: '' });
    expect(setOf(col)).not.toHaveProperty('footer_image');
    expect(setOf(col)).not.toHaveProperty('footer_qr_url');
  });

  test('saving a new QR address returns the generated picture immediately', async () => {
    const result = await m.updateCommonSettings({
      footer_qr_url: 'https://example.com/shop',
      footer_image_caption: 'Scan here',
    });
    expect(result.status).toBe(true);
    expect(result.data.footer_image).toMatch(/^data:image\/png;base64,/);
    expect(result.data.footer_image).toBe(setOf(col).footer_image);
    expect(result.data.footer_qr_url).toBe('https://example.com/shop');
    expect(result.data.footer_image_caption).toBe('Scan here');
  });

  test('failed QR generation cannot replace the stored source while keeping the old picture', async () => {
    const resolver = jest
      .spyOn(require('../../../src/helpers/footer-qr'), 'resolveFooterImage')
      .mockResolvedValueOnce(null);
    try {
      await m.updateCommonSettings({ footer_qr_url: 'https://example.com/changed' });
      expect(setOf(col)).not.toHaveProperty('footer_image');
      expect(setOf(col)).not.toHaveProperty('footer_qr_url');
    } finally {
      resolver.mockRestore();
    }
  });

  test('a full settings form still writes its whole surface', async () => {
    m.user.access = { plan: { read: true } };
    await m.updateCommonSettings({
      default_customer: '6a6a538091a0321d0198ff51',
      default_supplier: '6a867545f869a9e82c420d59',
      notification_value: '5',
      sales_prefix: 'S',
      print_type: 'standard',
      print_size: 'receipt_medium',
      receipt_barcode: 'true',
      roundOff: 'false',
    });
    const $set = setOf(col);
    for (const written of [
      'sales_prefix',
      'printing_size',
      'print_type',
      'receipt_barcode',
      'roundOff',
      'notification_range',
    ]) {
      expect($set).toHaveProperty(written);
    }
  });

  test('a key sent EMPTY is still written - absent means keep, empty means clear', async () => {
    m.user.access = { plan: { read: true } };
    await m.updateCommonSettings({ header_print: '', footer_print: '' });
    const $set = setOf(col);
    expect($set).toHaveProperty('header_print', '');
    expect($set).toHaveProperty('footer_print', '');
  });

  test('a payload with no printing fields does not touch the user printing_design', async () => {
    // getCollection is mocked to one collection, so a skipped users-write
    // shows up as one updateOne call instead of two.
    m.user.access = { plan: { read: true } };
    await m.updateCommonSettings({ quote_default_signature: 'data:image/png;base64,AAA' });
    expect(col.updateOne).toHaveBeenCalledTimes(1);
  });

  test('returns status:false on error (missing user._id)', async () => {
    m.user._id = null;
    const r = await m.updateCommonSettings({});
    expect(r.status).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. addTaxModel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 18. editTaxModel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 19. deleteTaxModel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 20. addTaxGroupModel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 21. deleteTaxGroupModel (alias)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 22. paymentKeyModel
// ─────────────────────────────────────────────────────────────────────────────
describe('changePasswordModel', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
    bcrypt.compare.mockReset();
    bcrypt.hash.mockReset();
  });

  test('returns status:false when passwords do not match', async () => {
    const r = await m.changePasswordModel({
      new_password: 'abc',
      confirm_password: 'xyz',
      old_password: 'old',
    });
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/do not match/i);
  });

  test('returns status:false when user not found', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.changePasswordModel({
      new_password: 'x',
      confirm_password: 'x',
      old_password: 'y',
    });
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/not found/i);
  });

  test('returns status:false when user has no password set', async () => {
    col.findOne.mockResolvedValue({ _id: USER_ID });
    const r = await m.changePasswordModel({
      new_password: 'x',
      confirm_password: 'x',
      old_password: 'y',
    });
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/not set/i);
  });

  test('returns status:false when old password is incorrect', async () => {
    col.findOne.mockResolvedValue({ _id: USER_ID, password: 'hashed' });
    bcrypt.compare.mockResolvedValue(false);
    const r = await m.changePasswordModel({
      new_password: 'newpass',
      confirm_password: 'newpass',
      old_password: 'wrong',
    });
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/incorrect/i);
  });

  test('returns status:true and updates password on success', async () => {
    col.findOne.mockResolvedValue({ _id: USER_ID, password: 'hashed' });
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('new_hashed');
    col.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const r = await m.changePasswordModel({
      new_password: 'newpass',
      confirm_password: 'newpass',
      old_password: 'oldpass',
    });
    expect(r.status).toBe(true);
    expect(r.message).toMatch(/updated/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27. deleteStoreCollection
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteStoreCollection', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when no collectionName', async () => {
    const r = await m.deleteStoreCollection(null);
    expect(r.status).toBe(false);
  });

  test('returns status:false for disallowed collection (users)', async () => {
    const r = await m.deleteStoreCollection('users');
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/not allowed/i);
  });

  test('returns status:false for disallowed collection (branches)', async () => {
    expect((await m.deleteStoreCollection('branches')).status).toBe(false);
  });

  test.each(['customers', 'suppliers', 'items', 'sales', 'receivings'])(
    'allows deletion of "%s"',
    async (collectionName) => {
      col.deleteMany.mockResolvedValue({ deletedCount: 3 });
      const r = await m.deleteStoreCollection(collectionName);
      expect(r.status).toBe(true);
      expect(r.data).toBe(3);
    }
  );

  test('returns status:false on DB error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('fail'));
    const r = await m.deleteStoreCollection('sales');
    expect(r.status).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 28. deleteAllSelectedCollection
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteAllSelectedCollection', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test('returns status:true with results map', async () => {
    jest
      .spyOn(m, 'deleteStoreCollection')
      .mockResolvedValueOnce({ status: true })
      .mockResolvedValueOnce({ status: false });
    const r = await m.deleteAllSelectedCollection({ collections: ['sales', 'users'] });
    expect(r.status).toBe(true);
    expect(r.data.sales).toBe('Deleted');
    expect(r.data.users).toBe('Failed');
  });

  test('returns status:true with empty results for empty array', async () => {
    const r = await m.deleteAllSelectedCollection({ collections: [] });
    expect(r.status).toBe(true);
    expect(r.data).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 29. addPaymentFiledModel
// ─────────────────────────────────────────────────────────────────────────────
describe('addDenomFiledModel', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
    jest.spyOn(m, 'getBranchName').mockResolvedValue('Branch');
  });

  test('returns status:false when duplicate denom exists', async () => {
    col.findOne.mockResolvedValue({ _id: 'existing' });
    const r = await m.addDenomFiledModel({ denom_value: 100 });
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/already exist/i);
  });

  test('stores branch_id as string in denom collection', async () => {
    col.findOne.mockResolvedValue(null);
    await m.addDenomFiledModel({ denom_value: 100 });
    const [insertArg] = col.insertOne.mock.calls[0];
    expect(typeof insertArg.branch_id).toBe('string');
  });

  test('returns status:true with inserted ID', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.addDenomFiledModel({ denom_value: '50' });
    expect(r.status).toBe(true);
    expect(r.message).toBe('Field Added Successfully');
  });

  test('stores denom_value and cash_field as float', async () => {
    col.findOne.mockResolvedValue(null);
    await m.addDenomFiledModel({ denom_value: '100.50' });
    const [insertArg] = col.insertOne.mock.calls[0];
    expect(insertArg.denom_value).toBe(100.5);
    expect(insertArg.cash_field).toBe(100.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 33. deleteDenomFiledModel
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteDenomFiledModel', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when no id', async () => {
    const r = await m.deleteDenomFiledModel(null);
    expect(r.status).toBe(false);
  });

  test('returns status:false when not found', async () => {
    col.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const r = await m.deleteDenomFiledModel(BRANCH_ID);
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/not found/i);
  });

  test('returns status:true on success', async () => {
    col.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const r = await m.deleteDenomFiledModel(BRANCH_ID);
    expect(r.status).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 34. addTableOrderFiledModel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 35. addUnitModel
// ─────────────────────────────────────────────────────────────────────────────
describe('addUnitModel', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:"error" when duplicate unit exists', async () => {
    col.findOne.mockResolvedValue({ _id: 'existing' });
    const r = await m.addUnitModel({ unit_name: 'kg', unit_value: 'kg' });
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/already exist/i);
  });

  test('returns status:true on successful add', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.addUnitModel({ unit_name: 'kg', unit_value: 'kg' });
    expect(r.status).toBe(true);
    expect(r.message).toBe('Unit Added Successfully');
  });

  test('trims unit_name and unit_value before insert', async () => {
    col.findOne.mockResolvedValue(null);
    await m.addUnitModel({ unit_name: '  kg  ', unit_value: '  Kilogram  ' });
    const [insertArg] = col.insertOne.mock.calls[0];
    expect(insertArg.name).toBe('kg');
    expect(insertArg.value).toBe('Kilogram');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 36. deleteUnitModel
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteUnitModel', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when no id', async () => {
    const r = await m.deleteUnitModel(null);
    expect(r.status).toBe(false);
  });

  test('returns status:false when not found', async () => {
    col.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const r = await m.deleteUnitModel(BRANCH_ID);
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/not found/i);
  });

  test('returns status:true on success', async () => {
    col.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const r = await m.deleteUnitModel(BRANCH_ID);
    expect(r.status).toBe(true);
    expect(r.message).toBe('Unit deleted successfully');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 37. getStoreDetails
// ─────────────────────────────────────────────────────────────────────────────
describe('getSystemSettings', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:true with empty object when nothing found', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.getSystemSettings();
    expect(r.status).toBe(true);
    expect(r.data).toEqual({});
  });

  test('returns status:true with settings when found', async () => {
    col.findOne.mockResolvedValue({ smstype: 'way2sms', email: { host: 'smtp.test.com' } });
    const r = await m.getSystemSettings();
    expect(r.status).toBe(true);
    expect(r.data.smstype).toBe('way2sms');
  });

  test('returns status:false on error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('fail'));
    const r = await m.getSystemSettings();
    expect(r.status).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 40. editThemeSettings
// ─────────────────────────────────────────────────────────────────────────────
describe('editThemeSettings', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:true with theme_settings on success', async () => {
    const r = await m.editThemeSettings({ preset: 'dark', primaryColor: '#000000' });
    expect(r.status).toBe(true);
    expect(r.data.preset).toBe('dark');
    expect(r.data.primaryColor).toBe('#000000');
  });

  test('uses defaults when no data provided', async () => {
    const r = await m.editThemeSettings({});
    expect(r.status).toBe(true);
    expect(r.data.preset).toBe('default');
    expect(r.data.primaryColor).toBe('#5a8dee');
    expect(r.data.fontFamily).toBe("'Mukta Vaani', sans-serif");
  });

  test('calls updateOne with $set theme_settings', async () => {
    await m.editThemeSettings({ preset: 'light' });
    const [, upd] = col.updateOne.mock.calls[0];
    expect(upd.$set).toHaveProperty('theme_settings');
    expect(upd.$set.theme_settings.preset).toBe('light');
  });

  test('returns status:false on error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('fail'));
    const r = await m.editThemeSettings({ preset: 'dark' });
    expect(r.status).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 41. updateBranchLogoModel
// ─────────────────────────────────────────────────────────────────────────────
describe('updateBranchLogoModel', () => {
  let m;
  beforeEach(() => {
    m = makeModel();
  });

  test('returns status:true with "store.png" when no file uploaded', async () => {
    const r = await m.updateBranchLogoModel(null);
    expect(r.status).toBe(true);
    expect(r.data).toBe('store.png');
    expect(r.message).toBe('Image uploaded successfully');
  });

  test('returns /uploads/{filename} path when file provided', async () => {
    const r = await m.updateBranchLogoModel({ filename: 'logo_abc123.png' });
    expect(r.status).toBe(true);
    expect(r.data).toBe('/uploads/logo_abc123.png');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 42. getDasboardSalesCountModel
// ─────────────────────────────────────────────────────────────────────────────
describe('getDasboardSalesCountModel', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false when branch not found', async () => {
    col.findOne.mockResolvedValue(null);
    const r = await m.getDasboardSalesCountModel();
    expect(r.status).toBe(false);
    expect(r.data).toBe(0);
  });

  test('returns status:false when no created_date on branch doc', async () => {
    col.findOne.mockResolvedValue({ branch_name: 'Test' });
    const r = await m.getDasboardSalesCountModel();
    expect(r.status).toBe(false);
  });

  test('returns status:true with number of days since creation', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    col.findOne.mockResolvedValue({ created_date: tenDaysAgo });
    const r = await m.getDasboardSalesCountModel();
    expect(r.status).toBe(true);
    expect(r.data).toBeGreaterThanOrEqual(9);
    expect(r.data).toBeLessThanOrEqual(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 43. restoreBackup
// ─────────────────────────────────────────────────────────────────────────────
describe('restoreBackup', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:false for empty ids array', async () => {
    const r = await m.restoreBackup([]);
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/no ids/i);
  });

  test('returns status:false when no docs found in backup', async () => {
    col.find.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    const r = await m.restoreBackup([BRANCH_ID]);
    expect(r.status).toBe(false);
    expect(r.message).toMatch(/no documents found/i);
  });

  test('restores docs and returns status:true', async () => {
    col.find.mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([
          { _id: new MockObjectId(BRANCH_ID), document_name: 'sales', branch_id: BRANCH_ID },
        ]),
    });
    col.findOne.mockResolvedValue(null);
    const r = await m.restoreBackup([BRANCH_ID]);
    expect(r.status).toBe(true);
    expect(r.message).toBe('Document Restored successfully');
  });

  test('replaces existing doc when already present in target', async () => {
    col.find.mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([
          { _id: new MockObjectId(BRANCH_ID), document_name: 'sales', branch_id: BRANCH_ID },
        ]),
    });
    col.findOne.mockResolvedValue({ _id: new MockObjectId(BRANCH_ID) }); // exists in target
    const r = await m.restoreBackup([BRANCH_ID]);
    expect(r.status).toBe(true);
    expect(col.replaceOne).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 44. kioskUpdateInfoModel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 45. updateBranchNameInCollections
// ─────────────────────────────────────────────────────────────────────────────
describe('updateBranchNameInCollections', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('calls updateMany for all listed collections and returns true', async () => {
    const r = await m.updateBranchNameInCollections({ id: BRANCH_ID, branch_name: 'New Name' });
    expect(r).toBe(true);
    expect(col.updateMany).toHaveBeenCalled();
  });

  test('still returns true even if some collection updates fail', async () => {
    col.updateMany.mockRejectedValueOnce(new Error('fail once'));
    col.updateMany.mockResolvedValue({ modifiedCount: 1 });
    const r = await m.updateBranchNameInCollections({ id: BRANCH_ID, branch_name: 'Name' });
    expect(r).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 46. getSelectUnitAjaxList
// ─────────────────────────────────────────────────────────────────────────────
describe('getSelectUnitAjaxList', () => {
  let m, col;
  beforeEach(() => {
    m = makeModel();
    col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
  });

  test('returns status:true with empty array when no units', async () => {
    const r = await m.getSelectUnitAjaxList();
    expect(r.status).toBe(true);
    expect(r.data).toEqual([]);
  });

  test('maps unit docs to unit_id, unit_name, unit_value shape', async () => {
    col.find.mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([{ _id: { toString: () => 'uid1' }, name: 'Kilogram', value: 'kg' }]),
    });
    const r = await m.getSelectUnitAjaxList();
    expect(r.status).toBe(true);
    expect(r.data[0].unit_id).toBe('uid1');
    expect(r.data[0].unit_name).toBe('Kilogram');
  });

  test('adds regex filter when query provided', async () => {
    col.find.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    await m.getSelectUnitAjaxList('kg');
    const [filterArg] = col.find.mock.calls[0];
    expect(filterArg.name).toHaveProperty('$regex');
  });

  test('returns status:false on error', async () => {
    jest.spyOn(m, 'getCollection').mockRejectedValue(new Error('fail'));
    const r = await m.getSelectUnitAjaxList();
    expect(r.status).toBe(false);
  });
});

describe('recoverable recycle-bin records', () => {
  test('uses the same recoverable filter for list and count', async () => {
    const m = makeModel(),
      col = makeMockCollection();
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
    const result = await m.getBackupTable(
      { table: 'sales', branchIds: [BRANCH_ID] },
      { page: 1, limit: 50 }
    );
    expect(result.status).toBe(true);
    const filter = col.find.mock.calls[0][0];
    expect(filter.$and).toContainEqual({ body_discarded: { $ne: true } });
    expect(col.countDocuments).toHaveBeenCalledWith(filter);
    expect(col.find.mock.calls[0][1].sort).toEqual({ document_backup_date: -1, _id: -1 });
  });
  test('does not show or restore a sync-only deletion marker', async () => {
    const m = makeModel(),
      marker = { _id: BRANCH_ID, document_name: 'sales', body_discarded: true };
    const col = makeMockCollection({
      findOne: jest.fn().mockResolvedValue(marker),
      find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([marker]) }),
    });
    jest.spyOn(m, 'getCollection').mockResolvedValue(col);
    expect((await m.getSettingTableRow(BRANCH_ID)).status).toBe(false);
    expect((await m.restoreBackup([BRANCH_ID])).status).toBe(false);
    expect(col.insertOne).not.toHaveBeenCalled();
    expect(col.replaceOne).not.toHaveBeenCalled();
    expect(col.deleteMany).not.toHaveBeenCalled();
  });
});
