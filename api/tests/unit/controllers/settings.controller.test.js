'use strict';

// =============================================================================
// fs mock (must be first)
// =============================================================================
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    promises: { access: jest.fn(), readFile: jest.fn() },
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => '[]'),
  };
});

// =============================================================================
// Shared mock model instance
// =============================================================================
const mockModel = {
  setContext: jest.fn(),
  getDefaultCustomer: jest.fn(),
  getDefaultSupplier: jest.fn(),
  getDefaultCustomerSupplier: jest.fn(),
  getBackupTable: jest.fn(),
  restoreBackup: jest.fn(),
  getForgotUserDetails: jest.fn(),
  getDasboardSalesCountModel: jest.fn(),
  getSettingTableRow: jest.fn(),
  getTaxAllModel: jest.fn(),
  getUnitAllModel: jest.fn(),
  getTaxGroupModel: jest.fn(),
  getSelectTaxAjaxList: jest.fn(),
  getSelectUnitAjaxList: jest.fn(),
  autoSuggestionRecycleBinTableField: jest.fn(),
  getAllCollectionTotal: jest.fn(),
  storedImageModel: jest.fn(),
  branchImageDeleteModel: jest.fn(),
  emailSettingModel: jest.fn(),
  kioskAccountSettingsModel: jest.fn(),
  kioskPrinterSettingsModel: jest.fn(),
  kioskPaymentModel: jest.fn(),
  phonepePaymentKeyModel: jest.fn(),
  kioskUpdateInfoModel: jest.fn(),
  addTableOrderFiledModel: jest.fn(),
  getTableOrderAllModel: jest.fn(),
  editTableOrderFiledModel: jest.fn(),
  getThemeSettings: jest.fn(),
  editThemeSettings: jest.fn(),
  addUnitModel: jest.fn(),
  editUnitModel: jest.fn(),
  addTaxGroupModel: jest.fn(),
  editTaxGroupModel: jest.fn(),
  editDenomFiledModel: jest.fn(),
  getPaymentAllModel: jest.fn(),
  addPaymentFiledModel: jest.fn(),
  editPaymentFiledModel: jest.fn(),
  updateWay2SmsSettingModel: jest.fn(),
  updateTextLocalSmsSettingModel: jest.fn(),
  updateOfflineSettingModel: jest.fn(),
  updateBranchLogoModel: jest.fn(),
  updateKioskImagesModel: jest.fn(),
  updateCommonCustomerSettings: jest.fn(),
  updateCommonSupplierSettings: jest.fn(),
  changePasswordModel: jest.fn(),
  paymentKeyModel: jest.fn(),
  deleteStoreCollection: jest.fn(),
  deleteAllSelectedCollection: jest.fn(),
  branchId: 'br001',
  licenseId: 'lic001',
};

jest.mock('../../../src/models/setting.model', () => jest.fn(() => mockModel));

jest.mock('../../../src/services/setting.service', () => ({
  setModel: jest.fn(),
  updateGeneralSetting: jest.fn(),
  updateCommonSettings: jest.fn(),
  addTax: jest.fn(),
  editTax: jest.fn(),
  deleteTax: jest.fn(),
  deleteTaxGroup: jest.fn(),
  addDenomForm: jest.fn(),
  getDenomAll: jest.fn(),
  deleteDenom: jest.fn(),
  addDenomData: jest.fn(),
  deleteTableOrder: jest.fn(),
  deleteUnit: jest.fn(),
  deletePayment: jest.fn(),
}));

jest.mock('../../../src/services/base.service', () => ({
  getReportAutoSuggestions: jest.fn(),
  getAutoSuggestions: jest.fn(),
  getDefaultSuggestions: jest.fn(),
}));

jest.mock('../../../src/models/base.model', () => {
  function M() {}
  M.currentBranch = null;
  M.license = null;
  M.loggedUser = null;
  M.loggedUserName = '';
  return M;
});

jest.mock('../../../src/models/user.model', () => ({ findById: jest.fn() }));
jest.mock('../../../src/models/branch.model', () => ({ findById: jest.fn() }));

jest.mock('mongodb', () => ({
  ObjectId: Object.assign(
    jest.fn((id) => ({ id, toString: () => String(id) })),
    { isValid: jest.fn(() => true) }
  ),
}));

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

// =============================================================================
// Imports
// =============================================================================
const fs = require('fs');
const settingsService = require('../../../src/services/setting.service');
const User = require('../../../src/models/user.model');
const Branch = require('../../../src/models/branch.model');
const ctrl = require('../../../src/controllers/settings.controller');

// =============================================================================
// Fixtures
// =============================================================================
const adminUser = {
  _id: 'user001',
  role: 'admin',
  license: 'lic001',
  branch_id: 'br001',
  access: { plan: { read: true } },
};

const planBlockedUser = {
  _id: 'user002',
  role: 'cashier',
  branch_id: 'br001',
  access: { plan: { read: false } },
};

const mockRes = () => {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  return r;
};

const mockReq = (o = {}) => ({
  body: {},
  params: {},
  query: {},
  headers: {},
  session: {},
  file: undefined,
  files: undefined,
  user: adminUser,
  ...o,
});

const ok = (data = {}, message = 'OK') => ({ status: true, message, data });
const err = (message = 'Not found') => ({ status: false, message, data: null });

beforeEach(() => {
  jest.clearAllMocks();
  fs.promises.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  fs.promises.readFile.mockResolvedValue('{}');
});

// =============================================================================
// createModelWithContext — branch / license resolution
// =============================================================================
// QR image generation is a real encoder path. Allow for a loaded machine.
jest.setTimeout(20000);

describe('createModelWithContext — branch resolution', () => {
  test('resolves branchId from session.selectedBranchId first', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok());
    const req = mockReq({
      session: { selectedBranchId: 'ses_br' },
      user: { ...adminUser, branch_id: 'user_br' },
    });
    await ctrl.getDasboardSalesCount(req, mockRes());
    expect(mockModel.setContext).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'ses_br' })
    );
  });

  test('falls back to session.branch_id when selectedBranchId absent', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok());
    const req = mockReq({
      session: { branch_id: 'ses_bid' },
      user: { ...adminUser, branch_id: 'user_br', branch_access: undefined },
    });
    await ctrl.getDasboardSalesCount(req, mockRes());
    expect(mockModel.setContext).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'ses_bid' })
    );
  });

  test('falls back to branch_access[0].branch_id', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok());
    const req = mockReq({
      session: {},
      user: { ...adminUser, branch_id: undefined, branch_access: [{ branch_id: 'access_br' }] },
    });
    await ctrl.getDasboardSalesCount(req, mockRes());
    expect(mockModel.setContext).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'access_br' })
    );
  });

  test('falls back to user.branch_id when branch_access is empty', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok());
    const req = mockReq({
      session: {},
      user: { ...adminUser, branch_access: [], branch_id: 'direct_br' },
    });
    await ctrl.getDasboardSalesCount(req, mockRes());
    expect(mockModel.setContext).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'direct_br' })
    );
  });

  test('resolves licenseId from user.license', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok());
    const req = mockReq({ user: { ...adminUser, license: 'lic_abc' } });
    await ctrl.getDasboardSalesCount(req, mockRes());
    expect(mockModel.setContext).toHaveBeenCalledWith(
      expect.objectContaining({ licenseId: 'lic_abc' })
    );
  });

  test('falls back to session.license when user.license absent', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok());
    const req = mockReq({
      session: { license: 'ses_lic' },
      user: { ...adminUser, license: undefined },
    });
    await ctrl.getDasboardSalesCount(req, mockRes());
    expect(mockModel.setContext).toHaveBeenCalledWith(
      expect.objectContaining({ licenseId: 'ses_lic' })
    );
  });
});

// =============================================================================
// getJSONCountry
// =============================================================================
describe('getJSONCountry', () => {
  test('200 with JSON data when file found', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile.mockResolvedValue(JSON.stringify({ countries: [] }));
    const res = mockRes();
    await ctrl.getJSONCountry(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('uses custom name query param', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile.mockResolvedValue(JSON.stringify([]));
    const res = mockRes();
    await ctrl.getJSONCountry(mockReq({ query: { name: 'states' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('400 for invalid file name with path traversal characters', async () => {
    const res = mockRes();
    await ctrl.getJSONCountry(mockReq({ query: { name: '../etc/passwd' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 for name with special characters', async () => {
    const res = mockRes();
    await ctrl.getJSONCountry(mockReq({ query: { name: 'file<script>' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when JSON file does not exist', async () => {
    const res = mockRes();
    await ctrl.getJSONCountry(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].type).toBe('error');
  });

  test('404 when file read throws error without a specific code (defaults to ENOENT path)', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile.mockRejectedValue(new Error('Disk failure'));
    const res = mockRes();
    await ctrl.getJSONCountry(mockReq(), res);
    // readJsonFromDirectories re-throws with code = lastError.code || 'ENOENT'
    // A codeless error therefore defaults to ENOENT → sendJsonResponse returns 404
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// =============================================================================
// getJSONCurrency / getJSONTimeZone / getJSONGstState
// =============================================================================
describe('getJSONCurrency', () => {
  test('200 when currency.json exists', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile.mockResolvedValue(JSON.stringify({ currencies: [] }));
    const res = mockRes();
    await ctrl.getJSONCurrency(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('404 when currency.json missing', async () => {
    const res = mockRes();
    await ctrl.getJSONCurrency(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('getJSONTimeZone', () => {
  test('200 when timezone.json exists', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile.mockResolvedValue(JSON.stringify([]));
    const res = mockRes();
    await ctrl.getJSONTimeZone(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when timezone.json missing', async () => {
    const res = mockRes();
    await ctrl.getJSONTimeZone(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// =============================================================================
// getJSONState
// =============================================================================
describe('getJSONState', () => {
  test('defaults to id=101 when query.id absent', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile
      .mockResolvedValueOnce(JSON.stringify([{ id: 1, name: 'Delhi' }]))
      .mockResolvedValueOnce(JSON.stringify({ countries: [{ id: 101, sortname: 'IN' }] }));
    const res = mockRes();
    await ctrl.getJSONState(mockReq({ query: {} }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(Array.isArray(res.json.mock.calls[0][0].data.stateJsonArray)).toBe(true);
  });

  test('treats id="undefined" string as missing', async () => {
    fs.promises.access.mockResolvedValue(undefined);
    fs.promises.readFile.mockResolvedValue(JSON.stringify([]));
    const res = mockRes();
    await ctrl.getJSONState(mockReq({ query: { id: 'undefined' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('500 when state file cannot be loaded', async () => {
    const res = mockRes();
    await ctrl.getJSONState(mockReq({ query: { id: '101' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getDefaultCustomer
// =============================================================================
describe('getDefaultCustomer', () => {
  test('200 with customer data on success', async () => {
    mockModel.getDefaultCustomer.mockResolvedValue(ok({ customer_id: 'c1' }));
    const res = mockRes();
    await ctrl.getDefaultCustomer(mockReq({ query: { customer: 'c1' } }), res);
    expect(mockModel.getDefaultCustomer).toHaveBeenCalledWith('c1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('reads customer from nested data.customer param', async () => {
    mockModel.getDefaultCustomer.mockResolvedValue(ok({ customer_id: 'c2' }));
    await ctrl.getDefaultCustomer(mockReq({ query: { data: { customer: 'c2' } } }), mockRes());
    expect(mockModel.getDefaultCustomer).toHaveBeenCalledWith('c2');
  });

  test('missing customer ID passes through - the model heals or refuses', async () => {
    const res = mockRes();
    await ctrl.getDefaultCustomer(mockReq({ query: {} }), res);
    expect(mockModel.getDefaultCustomer).toHaveBeenCalledWith(undefined);
  });

  test('404 when customer not found', async () => {
    mockModel.getDefaultCustomer.mockResolvedValue(err('Customer not found'));
    const res = mockRes();
    await ctrl.getDefaultCustomer(mockReq({ query: { customer: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getDefaultCustomer.mockRejectedValue(new Error('DB crash'));
    const res = mockRes();
    await ctrl.getDefaultCustomer(mockReq({ query: { customer: 'c1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getDefaultSupplier
// =============================================================================
describe('getDefaultSupplier', () => {
  test('200 with supplier data on success', async () => {
    mockModel.getDefaultSupplier.mockResolvedValue(ok({ supplier_id: 's1' }));
    const res = mockRes();
    await ctrl.getDefaultSupplier(mockReq({ query: { supplier: 's1' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('missing supplier ID passes through - the model heals or refuses', async () => {
    const res = mockRes();
    await ctrl.getDefaultSupplier(mockReq({ query: {} }), res);
    expect(mockModel.getDefaultSupplier).toHaveBeenCalledWith(undefined);
  });

  test('404 when supplier not found', async () => {
    mockModel.getDefaultSupplier.mockResolvedValue(err('Supplier not found'));
    const res = mockRes();
    await ctrl.getDefaultSupplier(mockReq({ query: { supplier: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getDefaultSupplier.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getDefaultSupplier(mockReq({ query: { supplier: 's1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getDefaultCustomerSupplier
// =============================================================================
describe('getDefaultCustomerSupplier', () => {
  test('200 when both IDs provided and found', async () => {
    mockModel.getDefaultCustomerSupplier.mockResolvedValue(ok({ customer: {}, supplier: {} }));
    const res = mockRes();
    await ctrl.getDefaultCustomerSupplier(
      mockReq({ query: { customer: 'c1', supplier: 's1' } }),
      res
    );
    expect(mockModel.getDefaultCustomerSupplier).toHaveBeenCalledWith('c1', 's1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('missing customer ID passes through - the model heals both defaults', async () => {
    const res = mockRes();
    await ctrl.getDefaultCustomerSupplier(mockReq({ query: { supplier: 's1' } }), res);
    expect(mockModel.getDefaultCustomerSupplier).toHaveBeenCalledWith(undefined, 's1');
  });

  test('missing supplier ID passes through - the model heals both defaults', async () => {
    const res = mockRes();
    await ctrl.getDefaultCustomerSupplier(mockReq({ query: { customer: 'c1' } }), res);
    expect(mockModel.getDefaultCustomerSupplier).toHaveBeenCalledWith('c1', undefined);
  });

  test('404 when model returns "Not found" message', async () => {
    mockModel.getDefaultCustomerSupplier.mockResolvedValue(err('Not found'));
    const res = mockRes();
    await ctrl.getDefaultCustomerSupplier(
      mockReq({ query: { customer: 'c1', supplier: 's1' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('400 for other failure messages', async () => {
    mockModel.getDefaultCustomerSupplier.mockResolvedValue(err('Some other error'));
    const res = mockRes();
    await ctrl.getDefaultCustomerSupplier(
      mockReq({ query: { customer: 'c1', supplier: 's1' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('500 when model throws', async () => {
    mockModel.getDefaultCustomerSupplier.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getDefaultCustomerSupplier(
      mockReq({ query: { customer: 'c1', supplier: 's1' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// backupTable
// =============================================================================
describe('backupTable', () => {
  const validReq = () => mockReq({ query: { table: 'sales', limit: '10', page: '1' } });

  test('200 with backup records on success', async () => {
    mockModel.getBackupTable.mockResolvedValue(ok({ list: [], total: 0 }));
    const res = mockRes();
    await ctrl.backupTable(validReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('400 when table param missing', async () => {
    const res = mockRes();
    await ctrl.backupTable(mockReq({ query: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toBe('Table parameter is required');
    expect(mockModel.getBackupTable).not.toHaveBeenCalled();
  });

  test('defaults limit=5 and page=1 for invalid values', async () => {
    mockModel.getBackupTable.mockResolvedValue(ok({ list: [] }));
    await ctrl.backupTable(
      mockReq({ query: { table: 'sales', limit: 'abc', page: '-1' } }),
      mockRes()
    );
    const [, opts] = mockModel.getBackupTable.mock.calls[0];
    expect(opts.limit).toBe(5);
    expect(opts.page).toBe(1);
  });

  test('accepts branch[] array from query string', async () => {
    mockModel.getBackupTable.mockResolvedValue(ok({ list: [] }));
    await ctrl.backupTable(
      mockReq({ query: { table: 'sales', 'branch[]': ['br1', 'br2'] } }),
      mockRes()
    );
    const [params] = mockModel.getBackupTable.mock.calls[0];
    expect(params.branchIds).toEqual(['br1', 'br2']);
  });

  test('400 when model returns status:false', async () => {
    mockModel.getBackupTable.mockResolvedValue(err('Unable to load'));
    const res = mockRes();
    await ctrl.backupTable(validReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('500 when model throws', async () => {
    mockModel.getBackupTable.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.backupTable(validReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// updateGeneralSetting
// =============================================================================
describe('updateGeneralSetting', () => {
  test('200 on successful update', async () => {
    settingsService.updateGeneralSetting.mockResolvedValue(ok({ updated: true }));
    const req = mockReq({ body: { company_name: 'POSNIC' } });
    const res = mockRes();
    await ctrl.updateGeneralSetting(req, res);
    expect(settingsService.setModel).toHaveBeenCalled();
    expect(settingsService.updateGeneralSetting).toHaveBeenCalledWith({ company_name: 'POSNIC' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      type: 'success',
      message: 'General Setting updated',
    });
  });

  test('404 when service returns status:false', async () => {
    settingsService.updateGeneralSetting.mockResolvedValue(err('Not updated'));
    const res = mockRes();
    await ctrl.updateGeneralSetting(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when service throws', async () => {
    settingsService.updateGeneralSetting.mockRejectedValue(new Error('DB error'));
    const res = mockRes();
    await ctrl.updateGeneralSetting(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// updateCommonSettings
// =============================================================================
describe('updateCommonSettings', () => {
  test.each([true, false])('accepts exact numeric search set to %s', async (enabled) => {
    settingsService.updateCommonSettings.mockResolvedValue(ok());
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: { sales_exact_numeric_codes: enabled } }), res);
    expect(settingsService.updateCommonSettings).toHaveBeenCalledWith({
      sales_exact_numeric_codes: enabled,
    });
  });

  test('rejects a string boolean instead of silently enabling exact search', async () => {
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: { sales_exact_numeric_codes: 'false' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsService.updateCommonSettings).not.toHaveBeenCalled();
  });
  const validBody = { receiving_prefix: 'REC', notification_value: 10 };

  test('rejects an invalid receipt design before calling the settings writer', async () => {
    const res = mockRes();
    await ctrl.updateCommonSettings(
      mockReq({ body: { receipt_designs: { version: 1, defaultFormat: 'invalid' } } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsService.updateCommonSettings).not.toHaveBeenCalled();
  });

  test('QR preview encodes text without saving any setting', async () => {
    const res = mockRes();
    await ctrl.previewReceiptQr(
      mockReq({ body: { text: 'https://www.customerwebsite.com' } }),
      res
    );
    expect(res.json.mock.calls[0][0].data.src).toMatch(/^data:image\/png;base64,/);
    expect(settingsService.updateCommonSettings).not.toHaveBeenCalled();
  });

  test('QR preview rejects blank and oversized content', async () => {
    for (const text of ['', 'x'.repeat(1001)]) {
      const res = mockRes();
      await ctrl.previewReceiptQr(mockReq({ body: { text } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  test('200 on successful update', async () => {
    settingsService.updateCommonSettings.mockResolvedValue(ok());
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('400 when sales_prefix exceeds 6 chars - short ones are fine now', async () => {
    // The old exactly-3 rule rejected the form's own default ('S') and
    // silently reset every save; 1-6 characters are all valid.
    const res = mockRes();
    await ctrl.updateCommonSettings(
      mockReq({ body: { ...validBody, sales_prefix: 'TOOLONGX' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/sales_prefix/);
    expect(settingsService.updateCommonSettings).not.toHaveBeenCalled();
  });

  test('missing receiving_prefix passes - absent means keep', async () => {
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: { notification_value: 10 } }), res);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  test('400 when receiving_prefix exceeds 6 chars', async () => {
    const res = mockRes();
    await ctrl.updateCommonSettings(
      mockReq({ body: { receiving_prefix: 'TOOLONGX', notification_value: 10 } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('empty notification_value passes - shops with no range configured must save', async () => {
    // Requiring it broke every Features save and the signature save on
    // shops that simply never set a notification range.
    settingsService.updateCommonSettings.mockResolvedValue(ok());
    const res = mockRes();
    await ctrl.updateCommonSettings(
      mockReq({ body: { receiving_prefix: 'REC', notification_value: '' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('omitted notification_value passes - partial payloads are legal', async () => {
    settingsService.updateCommonSettings.mockResolvedValue(ok());
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: { receiving_prefix: 'REC' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when service returns status:false', async () => {
    settingsService.updateCommonSettings.mockResolvedValue(err('Not updated'));
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when service throws', async () => {
    settingsService.updateCommonSettings.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.updateCommonSettings(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// addTax / editTax / deleteTax / deleteTaxGroup
// =============================================================================

// =============================================================================
// Denomination methods
// =============================================================================
describe('addDenomForm', () => {
  test('200 on success', async () => {
    settingsService.addDenomForm.mockResolvedValue(ok({ _id: 'd1' }, 'Added'));
    const res = mockRes();
    await ctrl.addDenomForm(mockReq({ body: { denomination: 100 } }), res);
    expect(settingsService.addDenomForm).toHaveBeenCalledWith({ denomination: 100 });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when service returns status:false', async () => {
    settingsService.addDenomForm.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.addDenomForm(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when service throws', async () => {
    settingsService.addDenomForm.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.addDenomForm(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getDenomAll', () => {
  test('200 with denomination list', async () => {
    settingsService.getDenomAll.mockResolvedValue(ok([{ _id: 'd1', denomination: 100 }], 'OK'));
    const res = mockRes();
    await ctrl.getDenomAll(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('404 when service returns status:false', async () => {
    settingsService.getDenomAll.mockResolvedValue(err('None'));
    const res = mockRes();
    await ctrl.getDenomAll(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when service throws', async () => {
    settingsService.getDenomAll.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getDenomAll(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteDenom', () => {
  test('200 on success and prefers query.id', async () => {
    settingsService.deleteDenom.mockResolvedValue(ok(null, 'Deleted'));
    const res = mockRes();
    await ctrl.deleteDenom(mockReq({ query: { id: 'd1' }, params: { id: 'p_id' } }), res);
    expect(settingsService.deleteDenom).toHaveBeenCalledWith('d1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('500 when service throws', async () => {
    settingsService.deleteDenom.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.deleteDenom(mockReq({ query: { id: 'd1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('addDenomData', () => {
  test('200 on success', async () => {
    settingsService.addDenomData.mockResolvedValue(ok({ _id: 'd2' }, 'OK'));
    const res = mockRes();
    await ctrl.addDenomData(mockReq({ body: { denomination: 50 } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('500 when service throws', async () => {
    settingsService.addDenomData.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.addDenomData(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('editDenomForm', () => {
  test('200 on success', async () => {
    mockModel.editDenomFiledModel.mockResolvedValue(ok({}, 'Updated'));
    const res = mockRes();
    await ctrl.editDenomForm(mockReq({ body: { _id: 'd1', denomination: 200 } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('500 when model throws', async () => {
    mockModel.editDenomFiledModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.editDenomForm(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// restoreBackup
// =============================================================================
describe('restoreBackup', () => {
  test('200 on success', async () => {
    mockModel.restoreBackup.mockResolvedValue(ok({}, 'Restored'));
    const req = mockReq({ body: { data: { collection: 'sales', ids: ['id1'] } } });
    const res = mockRes();
    await ctrl.restoreBackup(req, res);
    expect(mockModel.restoreBackup).toHaveBeenCalledWith({ collection: 'sales', ids: ['id1'] });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('403 when user plan.read is explicitly false', async () => {
    const res = mockRes();
    await ctrl.restoreBackup(mockReq({ user: planBlockedUser }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toBe('Unauthorized');
    expect(mockModel.restoreBackup).not.toHaveBeenCalled();
  });

  test('allows when user has no plan access object', async () => {
    mockModel.restoreBackup.mockResolvedValue(ok({}, 'Restored'));
    const req = mockReq({ user: { ...adminUser, access: {} }, body: { data: {} } });
    const res = mockRes();
    await ctrl.restoreBackup(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when model returns status:false', async () => {
    mockModel.restoreBackup.mockResolvedValue(err('Restore failed'));
    const res = mockRes();
    await ctrl.restoreBackup(mockReq({ body: { data: {} } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.restoreBackup.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.restoreBackup(mockReq({ body: { data: {} } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// forgotPassword
// =============================================================================
describe('forgotPassword', () => {
  test('200 with user details when email valid and found', async () => {
    mockModel.getForgotUserDetails.mockResolvedValue(ok({ email: 'a@b.com' }, 'Found'));
    const res = mockRes();
    await ctrl.forgotPassword(mockReq({ body: { email: 'a@b.com' } }), res);
    /* The request is passed too: the reset link must be built from the host
       this shop was actually reached on, not from a hardcoded address. It used
       to be hardcoded, and every hosted shop was mailed a link to
       http://localhost:3000 as a result. */
    expect(mockModel.getForgotUserDetails).toHaveBeenCalledWith(
      'a@b.com',
      expect.objectContaining({ body: { email: 'a@b.com' } })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('400 when email missing', async () => {
    const res = mockRes();
    await ctrl.forgotPassword(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toBe('Valid email required');
    expect(mockModel.getForgotUserDetails).not.toHaveBeenCalled();
  });

  test('400 for invalid email format', async () => {
    const res = mockRes();
    await ctrl.forgotPassword(mockReq({ body: { email: 'not-an-email' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 for email without TLD', async () => {
    const res = mockRes();
    await ctrl.forgotPassword(mockReq({ body: { email: 'user@' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when user not found', async () => {
    mockModel.getForgotUserDetails.mockResolvedValue(err('User not found'));
    const res = mockRes();
    await ctrl.forgotPassword(mockReq({ body: { email: 'a@b.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getForgotUserDetails.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.forgotPassword(mockReq({ body: { email: 'a@b.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getDasboardSalesCount
// =============================================================================
describe('getDasboardSalesCount', () => {
  test('200 with sales count on success', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(ok({ total: 42 }));
    const res = mockRes();
    await ctrl.getDasboardSalesCount(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].type).toBe('success');
  });

  test('404 when model returns status:false', async () => {
    mockModel.getDasboardSalesCountModel.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.getDasboardSalesCount(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getDasboardSalesCountModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getDasboardSalesCount(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getRecycleBin
// =============================================================================
describe('getRecycleBin', () => {
  test('200 with row data on success', async () => {
    mockModel.getSettingTableRow.mockResolvedValue(ok({ _id: 'rb1' }));
    const res = mockRes();
    await ctrl.getRecycleBin(mockReq({ query: { id: 'rb1' } }), res);
    expect(mockModel.getSettingTableRow).toHaveBeenCalledWith('rb1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('403 when user plan.read is explicitly false', async () => {
    const res = mockRes();
    await ctrl.getRecycleBin(mockReq({ user: planBlockedUser, query: { id: 'rb1' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockModel.getSettingTableRow).not.toHaveBeenCalled();
  });

  test('400 when id query param missing', async () => {
    const res = mockRes();
    await ctrl.getRecycleBin(mockReq({ query: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toBe('Id is Required');
  });

  test('allows access when user has no plan ACL', async () => {
    mockModel.getSettingTableRow.mockResolvedValue(ok({ _id: 'rb1' }));
    const req = mockReq({ user: { ...adminUser, access: {} }, query: { id: 'rb1' } });
    const res = mockRes();
    await ctrl.getRecycleBin(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when record not found', async () => {
    mockModel.getSettingTableRow.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.getRecycleBin(mockReq({ query: { id: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getSettingTableRow.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getRecycleBin(mockReq({ query: { id: 'rb1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getTaxAll / getUnitAll / getTaxGroup
// =============================================================================

describe('getUnitAll', () => {
  test('200 with unit list on success', async () => {
    mockModel.getUnitAllModel.mockResolvedValue(ok([{ unit_name: 'Kg' }], 'OK'));
    const res = mockRes();
    await ctrl.getUnitAll(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when model returns status:false', async () => {
    mockModel.getUnitAllModel.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.getUnitAll(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getUnitAllModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getUnitAll(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getTaxAjaxList / getUnitAjaxList
// =============================================================================

describe('getUnitAjaxList', () => {
  test('200 with suggestions on success', async () => {
    mockModel.getSelectUnitAjaxList.mockResolvedValue(ok([{ value: 'Kg' }], 'OK'));
    const res = mockRes();
    await ctrl.getUnitAjaxList(mockReq({ query: { query: 'K' } }), res);
    expect(mockModel.getSelectUnitAjaxList).toHaveBeenCalledWith('K');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].suggestions).toBeDefined();
  });

  test('500 when model throws', async () => {
    mockModel.getSelectUnitAjaxList.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getUnitAjaxList(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// autoSuggestionRecycleBinTableField
// =============================================================================
describe('autoSuggestionRecycleBinTableField', () => {
  test('200 with suggestions on success', async () => {
    mockModel.autoSuggestionRecycleBinTableField.mockResolvedValue(ok(['item1'], 'OK'));
    const req = mockReq({ query: { query: 'sa', field: 'name', module: 'sales' } });
    const res = mockRes();
    await ctrl.autoSuggestionRecycleBinTableField(req, res);
    expect(mockModel.autoSuggestionRecycleBinTableField).toHaveBeenCalledWith(
      'name',
      'sales',
      'sa'
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].query).toBe('sa');
  });

  test('404 when model returns status:false', async () => {
    mockModel.autoSuggestionRecycleBinTableField.mockResolvedValue(err('Not Found'));
    const res = mockRes();
    await ctrl.autoSuggestionRecycleBinTableField(
      mockReq({ query: { query: 'x', field: 'f', module: 'm' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.autoSuggestionRecycleBinTableField.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.autoSuggestionRecycleBinTableField(mockReq({ query: {} }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// getAllCollectionTotal
// =============================================================================
describe('getAllCollectionTotal', () => {
  test('200 when plan.read is true', async () => {
    mockModel.getAllCollectionTotal.mockResolvedValue(ok({ sales: 100 }, 'OK'));
    const res = mockRes();
    await ctrl.getAllCollectionTotal(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('403 when plan.read is false', async () => {
    const res = mockRes();
    await ctrl.getAllCollectionTotal(mockReq({ user: planBlockedUser }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockModel.getAllCollectionTotal).not.toHaveBeenCalled();
  });

  test('403 when user has no plan ACL at all', async () => {
    const res = mockRes();
    await ctrl.getAllCollectionTotal(mockReq({ user: { ...adminUser, access: {} } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('404 when model returns status:false', async () => {
    mockModel.getAllCollectionTotal.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.getAllCollectionTotal(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.getAllCollectionTotal.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getAllCollectionTotal(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// storedImageData / branchImageDelete
// =============================================================================
describe('storedImageData', () => {
  test('200 on success', async () => {
    mockModel.storedImageModel.mockResolvedValue(
      ok({ filename: 'logo.png' }, 'Image update successfully')
    );
    const res = mockRes();
    await ctrl.storedImageData(mockReq({ body: { image: 'base64data' } }), res);
    expect(mockModel.storedImageModel).toHaveBeenCalledWith({ image: 'base64data' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toBe('Image update successfully');
  });

  test('404 when model returns status:false', async () => {
    mockModel.storedImageModel.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.storedImageData(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].message).toBe('Image update unsuccessfully');
  });

  test('500 when model throws', async () => {
    mockModel.storedImageModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.storedImageData(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('branchImageDelete', () => {
  test('200 on success', async () => {
    mockModel.branchImageDeleteModel.mockResolvedValue(ok({}, 'Image was deleted'));
    const res = mockRes();
    await ctrl.branchImageDelete(mockReq({ body: { data: { filename: 'logo.png' } } }), res);
    expect(mockModel.branchImageDeleteModel).toHaveBeenCalledWith({ filename: 'logo.png' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toBe('Image was deleted');
  });

  test('404 when model returns status:false', async () => {
    mockModel.branchImageDeleteModel.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.branchImageDelete(mockReq({ body: { data: {} } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].message).toBe('There was not deleted');
  });

  test('500 when model throws', async () => {
    mockModel.branchImageDeleteModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.branchImageDelete(mockReq({ body: { data: {} } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// emailSetting
// =============================================================================

// =============================================================================
// Kiosk settings group
// =============================================================================

describe('getThemeSettings', () => {
  test('200 on success', async () => {
    mockModel.getThemeSettings.mockResolvedValue(ok({ primary_color: '#000' }));
    const res = mockRes();
    await ctrl.getThemeSettings(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toBe('Theme settings retrieved');
  });

  test('404 when model returns status:false', async () => {
    mockModel.getThemeSettings.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.getThemeSettings(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].message).toBe('No theme settings found');
  });

  test('500 when model throws', async () => {
    mockModel.getThemeSettings.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.getThemeSettings(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('updateThemeSettings', () => {
  const theme = { primary_color: '#123456', font_size: '14px' };

  test('200 on success', async () => {
    mockModel.editThemeSettings.mockResolvedValue(ok(theme, 'Updated'));
    const res = mockRes();
    await ctrl.updateThemeSettings(mockReq({ body: { theme_settings: theme } }), res);
    expect(mockModel.editThemeSettings).toHaveBeenCalledWith(theme);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toBe('Theme settings updated');
  });

  test('400 when theme_settings missing', async () => {
    const res = mockRes();
    await ctrl.updateThemeSettings(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toBe('Invalid theme settings data');
    expect(mockModel.editThemeSettings).not.toHaveBeenCalled();
  });

  test('400 when theme_settings is a string', async () => {
    const res = mockRes();
    await ctrl.updateThemeSettings(mockReq({ body: { theme_settings: 'invalid' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 when theme_settings is null', async () => {
    const res = mockRes();
    await ctrl.updateThemeSettings(mockReq({ body: { theme_settings: null } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when model returns status:false', async () => {
    mockModel.editThemeSettings.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.updateThemeSettings(mockReq({ body: { theme_settings: theme } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].message).toBe('Theme settings not updated');
  });

  test('500 when model throws', async () => {
    mockModel.editThemeSettings.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.updateThemeSettings(mockReq({ body: { theme_settings: theme } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// Unit Management
// =============================================================================
describe('addUnit', () => {
  const validBody = { unit_name: 'Kilogram', unit_value: 'kg' };

  test('200 on success', async () => {
    mockModel.addUnitModel.mockResolvedValue(ok({ _id: 'u1' }, 'Added'));
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: validBody }), res);
    expect(mockModel.addUnitModel).toHaveBeenCalledWith(validBody);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('400 when unit_name missing', async () => {
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: { unit_value: 'kg' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/unit_name/);
    expect(mockModel.addUnitModel).not.toHaveBeenCalled();
  });

  test('400 when unit_name exceeds 20 chars', async () => {
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: { unit_name: 'A'.repeat(21), unit_value: 'kg' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 when unit_value missing', async () => {
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: { unit_name: 'Kilogram' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/unit_value/);
  });

  test('400 when unit_value exceeds 6 chars', async () => {
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: { unit_name: 'Kilogram', unit_value: 'TOOLONG' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when model returns status:false', async () => {
    mockModel.addUnitModel.mockResolvedValue(err('Duplicate'));
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.addUnitModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.addUnit(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('editUnit', () => {
  const validBody = { _id: 'u1', unit_name: 'Gram', unit_value: 'gr' };

  test('200 on success', async () => {
    mockModel.editUnitModel.mockResolvedValue(ok({}, 'Updated'));
    const res = mockRes();
    await ctrl.editUnit(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('400 when unit_name missing', async () => {
    const res = mockRes();
    await ctrl.editUnit(mockReq({ body: { _id: 'u1', unit_value: 'gr' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 when unit_value missing', async () => {
    const res = mockRes();
    await ctrl.editUnit(mockReq({ body: { _id: 'u1', unit_name: 'Gram' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('500 when model throws', async () => {
    mockModel.editUnitModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.editUnit(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteUnit', () => {
  test('200 on success', async () => {
    settingsService.deleteUnit.mockResolvedValue(ok(null, 'Deleted'));
    const res = mockRes();
    await ctrl.deleteUnit(mockReq({ query: { id: 'u1' } }), res);
    expect(settingsService.deleteUnit).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when service returns status:false', async () => {
    settingsService.deleteUnit.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.deleteUnit(mockReq({ query: { id: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when service throws', async () => {
    settingsService.deleteUnit.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.deleteUnit(mockReq({ query: { id: 'u1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// Tax Group Management
// =============================================================================

// =============================================================================
// Payment Management
// =============================================================================
describe('updateBranchLogo', () => {
  const mockFile = {
    fieldname: 'logo',
    originalname: 'logo.png',
    mimetype: 'image/png',
    size: 1024,
    filename: 'mock-logo.png',
    path: '/mock/path/logo.png',
  };

  test('200 when logo updated successfully', async () => {
    mockModel.updateBranchLogoModel.mockResolvedValue(ok({ filename: 'mock-logo.png' }, 'Updated'));
    const req = mockReq({ file: mockFile });
    const res = mockRes();
    await ctrl.updateBranchLogo(req, res);
    expect(mockModel.updateBranchLogoModel).toHaveBeenCalledWith(mockFile, adminUser.branch_id);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('passes undefined file when no file uploaded', async () => {
    mockModel.updateBranchLogoModel.mockResolvedValue(err('No file'));
    const req = mockReq({ file: undefined });
    const res = mockRes();
    await ctrl.updateBranchLogo(req, res);
    expect(mockModel.updateBranchLogoModel).toHaveBeenCalledWith(undefined, adminUser.branch_id);
  });

  test('404 when model returns status:false', async () => {
    mockModel.updateBranchLogoModel.mockResolvedValue(err('Update failed'));
    const res = mockRes();
    await ctrl.updateBranchLogo(mockReq({ file: mockFile }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws (storage failure)', async () => {
    mockModel.updateBranchLogoModel.mockRejectedValue(new Error('Storage failure'));
    const res = mockRes();
    await ctrl.updateBranchLogo(mockReq({ file: mockFile }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// Customer / Supplier Settings
// =============================================================================
describe('updateCustomerSettings', () => {
  test('200 using query.id', async () => {
    mockModel.updateCommonCustomerSettings.mockResolvedValue(ok({}, 'Updated'));
    const res = mockRes();
    await ctrl.updateCustomerSettings(mockReq({ query: { id: 'c1' } }), res);
    expect(mockModel.updateCommonCustomerSettings).toHaveBeenCalledWith('c1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('uses params.id when query.id absent', async () => {
    mockModel.updateCommonCustomerSettings.mockResolvedValue(ok({}, 'Updated'));
    await ctrl.updateCustomerSettings(mockReq({ query: {}, params: { id: 'c2' } }), mockRes());
    expect(mockModel.updateCommonCustomerSettings).toHaveBeenCalledWith('c2');
  });

  test('404 when model returns status:false', async () => {
    mockModel.updateCommonCustomerSettings.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.updateCustomerSettings(mockReq({ query: { id: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.updateCommonCustomerSettings.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.updateCustomerSettings(mockReq({ query: { id: 'c1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('updateSupplierSettings', () => {
  test('200 on success', async () => {
    mockModel.updateCommonSupplierSettings.mockResolvedValue(ok({}, 'Updated'));
    const res = mockRes();
    await ctrl.updateSupplierSettings(mockReq({ query: { id: 's1' } }), res);
    expect(mockModel.updateCommonSupplierSettings).toHaveBeenCalledWith('s1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when model returns status:false', async () => {
    mockModel.updateCommonSupplierSettings.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.updateSupplierSettings(mockReq({ query: { id: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.updateCommonSupplierSettings.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.updateSupplierSettings(mockReq({ query: { id: 's1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// changePassword
// =============================================================================
describe('changePassword', () => {
  test('200 on success', async () => {
    mockModel.changePasswordModel.mockResolvedValue(ok({}, 'Changed'));
    const res = mockRes();
    await ctrl.changePassword(mockReq({ body: { old_password: 'old', new_password: 'new' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('passwords not echoed in response', async () => {
    mockModel.changePasswordModel.mockResolvedValue(ok({}, 'OK'));
    const res = mockRes();
    await ctrl.changePassword(
      mockReq({ body: { old_password: 'SECRET_OLD', new_password: 'SECRET_NEW' } }),
      res
    );
    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toContain('SECRET_OLD');
    expect(body).not.toContain('SECRET_NEW');
  });

  test('404 when model returns status:false', async () => {
    mockModel.changePasswordModel.mockResolvedValue(err('Old password incorrect'));
    const res = mockRes();
    await ctrl.changePassword(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.changePasswordModel.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.changePassword(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =============================================================================
// deleteCollection
// =============================================================================
describe('deleteCollection', () => {
  test('200 on success using query.collection', async () => {
    mockModel.deleteStoreCollection.mockResolvedValue(ok({}, 'Deleted'));
    const res = mockRes();
    await ctrl.deleteCollection(mockReq({ query: { collection: 'sales' } }), res);
    expect(mockModel.deleteStoreCollection).toHaveBeenCalledWith('sales');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('uses body.collection when query.collection absent', async () => {
    mockModel.deleteStoreCollection.mockResolvedValue(ok({}, 'Deleted'));
    const res = mockRes();
    await ctrl.deleteCollection(mockReq({ query: {}, body: { collection: 'expenses' } }), res);
    expect(mockModel.deleteStoreCollection).toHaveBeenCalledWith('expenses');
  });

  test('404 when model returns status:false', async () => {
    mockModel.deleteStoreCollection.mockResolvedValue(err('Not found'));
    const res = mockRes();
    await ctrl.deleteCollection(mockReq({ query: { collection: 'bad' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.deleteStoreCollection.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.deleteCollection(mockReq({ query: { collection: 'sales' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteAllSelectedCollection', () => {
  test('200 on success', async () => {
    mockModel.deleteAllSelectedCollection.mockResolvedValue(ok({}, 'Deleted'));
    const req = mockReq({ body: { collections: ['sales', 'expenses'] } });
    const res = mockRes();
    await ctrl.deleteAllSelectedCollection(req, res);
    expect(mockModel.deleteAllSelectedCollection).toHaveBeenCalledWith({
      collections: ['sales', 'expenses'],
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404 when model returns status:false', async () => {
    mockModel.deleteAllSelectedCollection.mockResolvedValue(err());
    const res = mockRes();
    await ctrl.deleteAllSelectedCollection(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 when model throws', async () => {
    mockModel.deleteAllSelectedCollection.mockRejectedValue(new Error('crash'));
    const res = mockRes();
    await ctrl.deleteAllSelectedCollection(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
