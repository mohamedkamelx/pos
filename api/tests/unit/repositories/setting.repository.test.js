'use strict';

/**
 * Unit tests for src/repositories/settings.repository.js
 * SINGLETON export — module.exports = new SettingsRepository()
 * 442 lines, 57+ methods, pure delegation to injected settingModel
 */

const settingsRepository = require('../../../src/repositories/setting.repository');

const FAKE_ID = '64f9a1c2e3b4d5e6f7000001';

// ══════════════════════════════════════════════════════════════════════════════
describe('SettingsRepository', () => {
  let mockModel;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a mock model with all methods that the repository delegates to
    const modelMethods = [
      'getTaxAllModel',
      'getTaxAjaxListModel',
      'getTaxGroupModel',
      'addTaxModel',
      'editTaxModel',
      'deleteTaxModel',
      'addTaxGroupModel',
      'editTaxGroupModel',
      'deleteTaxGroupModel',
      'getUnitAllModel',
      'getUnitAjaxListModel',
      'addUnitModel',
      'editUnitModel',
      'deleteUnitModel',
      'getDenomAllModel',
      'addDenomModel',
      'addDenomDataModel',
      'editDenomFiledModel',
      'deleteDenomFiledModel',
      'getPaymentAllModel',
      'addPaymentModel',
      'editPaymentFiledModel',
      'deletePaymentFiledModel',
      'getTableOrderAllModel',
      'addTableOrderModel',
      'editTableOrderFiledModel',
      'deleteTableOrderFiledModel',
      'editGeneralSetting',
      'updateCommonSettings',
      'updateWay2SmsSetting',
      'updateTextLocalSmsSetting',
      'updateBranchLogoModel',
      'updateKioskImagesModel',
      'storedImageDataModel',
      'branchImageDeleteModel',
      'updateCommonCustomerSettings',
      'updateCommonSupplierSettings',
      'changePasswordModel',
      'paymentKeyModel',
      'phonepePaymentKeyModel',
      'deleteCollectionModel',
      'deleteAllSelectedCollectionModel',
      'restoreBackupModel',
      'getDasboardSalesCountModel',
      'getRecycleBinModel',
      'autoSuggestionRecycleBinTableFieldModel',
      'getAllCollectionTotalModel',
      'emailSettingModel',
      'kioskAccountSettingsModel',
      'kioskPrinterSettingsModel',
      'kioskPaymentModel',
      'kioskupdateInfoModel',
      'getThemeSettings',
      'editThemeSettings',
      'getDefaultCustomerModel',
      'getDefaultSupplierModel',
      'getDefaultCustomerSupplierModel',
      'backupTableModel',
    ];

    mockModel = {};
    modelMethods.forEach((method) => {
      mockModel[method] = jest.fn().mockResolvedValue({ status: true, data: null });
    });

    settingsRepository.setModel(mockModel);
  });

  // ── setModel ────────────────────────────────────────────────────────────────

  describe('setModel', () => {
    test('injects the model instance', () => {
      expect(settingsRepository.settingModel).toBe(mockModel);
    });
  });

  // ── Tax ─────────────────────────────────────────────────────────────────────

  // ── Unit ─────────────────────────────────────────────────────────────────────

  // ── Denomination ────────────────────────────────────────────────────────────

  // ── Payment ──────────────────────────────────────────────────────────────────

  // ── Table Order ──────────────────────────────────────────────────────────────

  // ── General / Common Settings ────────────────────────────────────────────────

  // ── File / Image ─────────────────────────────────────────────────────────────

  // ── Customer / Supplier ──────────────────────────────────────────────────────

  describe('Customer/Supplier settings', () => {
    test('updateCustomerSettings delegates to model.updateCommonCustomerSettings', async () => {
      await settingsRepository.updateCustomerSettings(FAKE_ID);
      expect(mockModel.updateCommonCustomerSettings).toHaveBeenCalledWith(FAKE_ID);
    });

    test('updateSupplierSettings delegates to model.updateCommonSupplierSettings', async () => {
      await settingsRepository.updateSupplierSettings(FAKE_ID);
      expect(mockModel.updateCommonSupplierSettings).toHaveBeenCalledWith(FAKE_ID);
    });

    test('getDefaultCustomer delegates to model.getDefaultCustomerModel', async () => {
      await settingsRepository.getDefaultCustomer(FAKE_ID);
      expect(mockModel.getDefaultCustomerModel).toHaveBeenCalledWith(FAKE_ID);
    });

    test('getDefaultSupplier delegates to model.getDefaultSupplierModel', async () => {
      await settingsRepository.getDefaultSupplier(FAKE_ID);
      expect(mockModel.getDefaultSupplierModel).toHaveBeenCalledWith(FAKE_ID);
    });

    test('getDefaultCustomerSupplier delegates to model.getDefaultCustomerSupplierModel', async () => {
      const customerId = 'cust1';
      const supplierId = 'supp1';
      await settingsRepository.getDefaultCustomerSupplier(customerId, supplierId);
      expect(mockModel.getDefaultCustomerSupplierModel).toHaveBeenCalledWith(
        customerId,
        supplierId
      );
    });
  });

  // ── Password / SMS ─────────────────────────────────────────────────────────

  // ── Payment Keys ─────────────────────────────────────────────────────────────

  // ── Collection / Backup / Recycle Bin ────────────────────────────────────────

  // ── Email / Kiosk ────────────────────────────────────────────────────────────

  // ── Theme ────────────────────────────────────────────────────────────────────

  describe('Theme methods', () => {
    test('getThemeSettings delegates to model.getThemeSettings', async () => {
      await settingsRepository.getThemeSettings();
      expect(mockModel.getThemeSettings).toHaveBeenCalledTimes(1);
    });

    test('updateThemeSettings delegates to model.editThemeSettings', async () => {
      const data = { color: 'blue' };
      await settingsRepository.updateThemeSettings(data);
      expect(mockModel.editThemeSettings).toHaveBeenCalledWith(data);
    });
  });

  // ── Error propagation ──────────────────────────────────────────────────────────

  // ── Method existence ───────────────────────────────────────────────────────────
});
