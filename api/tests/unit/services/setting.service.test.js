'use strict';

/**
 * Unit tests for src/services/settings.service.js
 *
 * File        : src/services/settings.service.js (674 lines, class singleton export)
 * Export type : SINGLETON — `module.exports = new SettingsService()`
 * Base class  : None — does NOT extend base.service.js
 *
 * Dependency  : settingsRepository (singleton, required at module top)
 *               Constructor assigns: this.repository = settingsRepository
 *
 * Methods (38):
 *   setModel(model)                          — sets model on repository
 *   ─── Tax ──────────────────────────────────────────────────────────
 *   getTaxAll(taxGroup)                      — delegates, no guard
 *   getTaxAjaxList(query)                    — delegates, no guard
 *   getTaxGroup()                            — delegates, no guard
 *   addTax(data)                             — delegates, no guard
 *   editTax(data)                            — delegates, no guard
 *   deleteTax(id)                            — ID guard + delegates
 *   addTaxGroup(data)                        — delegates, no guard
 *   editTaxGroup(data)                       — delegates, no guard
 *   deleteTaxGroup(id)                       — ID guard + delegates
 *   ─── Unit ─────────────────────────────────────────────────────────
 *   getUnitAll()                             — delegates, no guard
 *   getUnitAjaxList(query)                   — delegates, no guard
 *   addUnit(data)                            — delegates, no guard
 *   editUnit(data)                           — delegates, no guard
 *   deleteUnit(id)                           — ID guard + delegates
 *   ─── Denomination ─────────────────────────────────────────────────
 *   getDenomAll()                            — delegates, no guard
 *   addDenomForm(data)                       — delegates, no guard
 *   addDenomData(data)                       — delegates, no guard
 *   editDenomForm(data)                      — delegates, no guard
 *   deleteDenom(id)                          — ID guard + delegates
 *   ─── Payment ──────────────────────────────────────────────────────
 *   getPaymentAll()                          — delegates, no guard
 *   addPaymentData(data)                     — delegates, no guard
 *   editPaymentForm(data)                    — delegates, no guard
 *   deletePayment(id)                        — ID guard + delegates
 *   ─── Table Order ──────────────────────────────────────────────────
 *   getTableOrderAll()                       — delegates, no guard
 *   addTableOrderData(data)                  — delegates, no guard
 *   editTableOrderForm(data)                 — delegates, no guard
 *   deleteTableOrder(id)                     — ID guard + delegates
 *   ─── Settings ─────────────────────────────────────────────────────
 *   updateGeneralSetting(data)               — delegates, no guard
 *   updateCommonSettings(data)               — delegates, no guard
 *   updateOfflineSetting(data)               — delegates, no guard
 *   updateWay2SmsSetting(data)               — delegates, no guard
 *   updateTextLocalSmsSetting(data)          — delegates, no guard
 *   changePassword(data)                     — delegates, no guard
 *   updateCustomerSettings(id)              — ID guard + delegates
 *   updateSupplierSettings(id)              — ID guard + delegates
 *   ─── Theme ────────────────────────────────────────────────────────
 *   getThemeSettings()                       — delegates, no guard
 *   updateThemeSettings(data)                — delegates, no guard
 *
 * Mocked dependencies:
 *   settingsRepository — singleton, all 38 methods mocked
 */

// ─── Mock settingsRepository singleton ────────────────────────────────────────

jest.mock('../../../src/repositories/setting.repository', () => ({
  setModel: jest.fn(),
  getTaxAll: jest.fn(),
  getTaxAjaxList: jest.fn(),
  getTaxGroup: jest.fn(),
  addTax: jest.fn(),
  editTax: jest.fn(),
  deleteTax: jest.fn(),
  addTaxGroup: jest.fn(),
  editTaxGroup: jest.fn(),
  deleteTaxGroup: jest.fn(),
  getUnitAll: jest.fn(),
  getUnitAjaxList: jest.fn(),
  addUnit: jest.fn(),
  editUnit: jest.fn(),
  deleteUnit: jest.fn(),
  getDenomAll: jest.fn(),
  addDenomForm: jest.fn(),
  addDenomData: jest.fn(),
  editDenomForm: jest.fn(),
  deleteDenom: jest.fn(),
  getPaymentAll: jest.fn(),
  addPaymentData: jest.fn(),
  editPaymentForm: jest.fn(),
  deletePayment: jest.fn(),
  getTableOrderAll: jest.fn(),
  addTableOrderData: jest.fn(),
  editTableOrderForm: jest.fn(),
  deleteTableOrder: jest.fn(),
  updateGeneralSetting: jest.fn(),
  updateCommonSettings: jest.fn(),
  updateOfflineSetting: jest.fn(),
  updateWay2SmsSetting: jest.fn(),
  updateTextLocalSmsSetting: jest.fn(),
  changePassword: jest.fn(),
  updateCustomerSettings: jest.fn(),
  updateSupplierSettings: jest.fn(),
  getThemeSettings: jest.fn(),
  updateThemeSettings: jest.fn(),
}));

// ─── Requires ─────────────────────────────────────────────────────────────────

const settingsRepository = require('../../../src/repositories/setting.repository');
const settingsService = require('../../../src/services/setting.service');
const { ERROR_MESSAGES } = require('../../../src/constants/settings.constants');

// ─── Shared helpers ───────────────────────────────────────────────────────────

const OK = (data) => ({ status: true, data });
const FAIL = (msg) => ({ status: false, data: null, message: msg });
const FAKE_ID = '64f8f2f4c2b9c0a1e4b12345';

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('SettingsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── setModel ────────────────────────────────────────────────────────────────

  describe('setModel', () => {
    test('calls repository.setModel with the provided model', () => {
      const fakeModel = { name: 'SettingModel' };
      settingsService.setModel(fakeModel);
      expect(settingsRepository.setModel).toHaveBeenCalledTimes(1);
      expect(settingsRepository.setModel).toHaveBeenCalledWith(fakeModel);
    });
  });

  // ── Tax ─────────────────────────────────────────────────────────────────────

  // ── Unit ─────────────────────────────────────────────────────────────────────

  describe('deleteUnit', () => {
    test('returns ID_REQUIRED when id is falsy', async () => {
      expect((await settingsService.deleteUnit(null)).message).toBe(ERROR_MESSAGES.ID_REQUIRED);
      expect((await settingsService.deleteUnit('')).message).toBe(ERROR_MESSAGES.ID_REQUIRED);
      expect(settingsRepository.deleteUnit).not.toHaveBeenCalled();
    });

    test('delegates to repository.deleteUnit when id provided', async () => {
      settingsRepository.deleteUnit.mockResolvedValue(OK({ deletedCount: 1 }));
      await settingsService.deleteUnit(FAKE_ID);
      expect(settingsRepository.deleteUnit).toHaveBeenCalledWith(FAKE_ID);
    });

    test('falls back to UNIT_DELETE_FAILED on throw', async () => {
      settingsRepository.deleteUnit.mockRejectedValue({});
      expect((await settingsService.deleteUnit(FAKE_ID)).message).toBe(
        ERROR_MESSAGES.UNIT_DELETE_FAILED
      );
    });
  });

  // ── Denomination ─────────────────────────────────────────────────────────────

  describe('getDenomAll', () => {
    test('delegates to repository.getDenomAll', async () => {
      const mockResult = OK([{ value: 500 }]);
      settingsRepository.getDenomAll.mockResolvedValue(mockResult);
      expect(await settingsService.getDenomAll()).toBe(mockResult);
    });

    test('falls back to DENOM_NOT_FOUND on error without message', async () => {
      settingsRepository.getDenomAll.mockRejectedValue({});
      expect((await settingsService.getDenomAll()).message).toBe(ERROR_MESSAGES.DENOM_NOT_FOUND);
    });
  });

  describe('addDenomForm', () => {
    test('delegates to repository.addDenomForm', async () => {
      const data = { denom_value: '500', denom_type: 'note' };
      settingsRepository.addDenomForm.mockResolvedValue(OK(data));
      await settingsService.addDenomForm(data);
      expect(settingsRepository.addDenomForm).toHaveBeenCalledWith(data);
    });

    test('falls back to DENOM_ADD_FAILED on error without message', async () => {
      settingsRepository.addDenomForm.mockRejectedValue({});
      expect((await settingsService.addDenomForm({})).message).toBe(
        ERROR_MESSAGES.DENOM_ADD_FAILED
      );
    });
  });

  describe('addDenomData', () => {
    test('delegates to repository.addDenomData', async () => {
      const data = { count: 5, denom_id: 'd1' };
      settingsRepository.addDenomData.mockResolvedValue(OK(data));
      await settingsService.addDenomData(data);
      expect(settingsRepository.addDenomData).toHaveBeenCalledWith(data);
    });

    test('falls back to DENOM_ADD_FAILED on error without message', async () => {
      settingsRepository.addDenomData.mockRejectedValue({});
      expect((await settingsService.addDenomData({})).message).toBe(
        ERROR_MESSAGES.DENOM_ADD_FAILED
      );
    });
  });

  describe('deleteDenom', () => {
    test('returns ID_REQUIRED when id is falsy', async () => {
      expect((await settingsService.deleteDenom(null)).message).toBe(ERROR_MESSAGES.ID_REQUIRED);
      expect((await settingsService.deleteDenom('')).message).toBe(ERROR_MESSAGES.ID_REQUIRED);
      expect(settingsRepository.deleteDenom).not.toHaveBeenCalled();
    });

    test('delegates to repository.deleteDenom when id provided', async () => {
      settingsRepository.deleteDenom.mockResolvedValue(OK({ deletedCount: 1 }));
      await settingsService.deleteDenom(FAKE_ID);
      expect(settingsRepository.deleteDenom).toHaveBeenCalledWith(FAKE_ID);
    });

    test('falls back to DENOM_DELETE_FAILED on throw', async () => {
      settingsRepository.deleteDenom.mockRejectedValue({});
      expect((await settingsService.deleteDenom(FAKE_ID)).message).toBe(
        ERROR_MESSAGES.DENOM_DELETE_FAILED
      );
    });
  });

  // ── Payment ───────────────────────────────────────────────────────────────────

  describe('updateGeneralSetting', () => {
    test('delegates to repository.updateGeneralSetting', async () => {
      const data = { store_name: 'My Shop', store_email: 'shop@test.com' };
      const mockResult = OK({ updated: true });
      settingsRepository.updateGeneralSetting.mockResolvedValue(mockResult);

      expect(await settingsService.updateGeneralSetting(data)).toBe(mockResult);
      expect(settingsRepository.updateGeneralSetting).toHaveBeenCalledWith(data);
    });

    test('returns error with UPDATE_FAILED fallback on throw', async () => {
      settingsRepository.updateGeneralSetting.mockRejectedValue({});
      expect((await settingsService.updateGeneralSetting({})).message).toBe(
        ERROR_MESSAGES.UPDATE_FAILED
      );
    });
  });

  describe('updateCommonSettings', () => {
    test('delegates to repository.updateCommonSettings', async () => {
      const data = { default_customer: 'Walk-in', currency: 'INR' };
      settingsRepository.updateCommonSettings.mockResolvedValue(OK({ updated: true }));
      await settingsService.updateCommonSettings(data);
      expect(settingsRepository.updateCommonSettings).toHaveBeenCalledWith(data);
    });

    test('returns UPDATE_FAILED fallback on error without message', async () => {
      settingsRepository.updateCommonSettings.mockRejectedValue({});
      expect((await settingsService.updateCommonSettings({})).message).toBe(
        ERROR_MESSAGES.UPDATE_FAILED
      );
    });
  });

  // ── Password ─────────────────────────────────────────────────────────────────

  describe('changePassword', () => {
    test('delegates to repository.changePassword', async () => {
      const data = { old_password: 'TEST_FAKE_OLD', new_password: 'TEST_FAKE_NEW' };
      const mockResult = OK({ changed: true });
      settingsRepository.changePassword.mockResolvedValue(mockResult);

      expect(await settingsService.changePassword(data)).toBe(mockResult);
      expect(settingsRepository.changePassword).toHaveBeenCalledWith(data);
    });

    test('returns PASSWORD_CHANGE_FAILED fallback on error without message', async () => {
      settingsRepository.changePassword.mockRejectedValue({});
      expect((await settingsService.changePassword({})).message).toBe(
        ERROR_MESSAGES.PASSWORD_CHANGE_FAILED
      );
    });

    test('returns error.message when repository throws with message', async () => {
      settingsRepository.changePassword.mockRejectedValue(
        new Error(ERROR_MESSAGES.OLD_PASSWORD_INCORRECT)
      );
      const result = await settingsService.changePassword({ old_password: 'wrong' });
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.OLD_PASSWORD_INCORRECT);
    });
  });

  // ── Customer / Supplier Settings ─────────────────────────────────────────────

  describe('updateCustomerSettings', () => {
    test('returns ID_REQUIRED when id is falsy', async () => {
      expect((await settingsService.updateCustomerSettings(null)).message).toBe(
        ERROR_MESSAGES.ID_REQUIRED
      );
      expect((await settingsService.updateCustomerSettings('')).message).toBe(
        ERROR_MESSAGES.ID_REQUIRED
      );
      expect(settingsRepository.updateCustomerSettings).not.toHaveBeenCalled();
    });

    test('delegates to repository.updateCustomerSettings when id provided', async () => {
      settingsRepository.updateCustomerSettings.mockResolvedValue(OK({ updated: true }));
      await settingsService.updateCustomerSettings(FAKE_ID);
      expect(settingsRepository.updateCustomerSettings).toHaveBeenCalledWith(FAKE_ID);
    });

    test('returns CUSTOMER_SETTINGS_FAILED fallback on throw', async () => {
      settingsRepository.updateCustomerSettings.mockRejectedValue({});
      expect((await settingsService.updateCustomerSettings(FAKE_ID)).message).toBe(
        ERROR_MESSAGES.CUSTOMER_SETTINGS_FAILED
      );
    });
  });

  describe('updateSupplierSettings', () => {
    test('returns ID_REQUIRED when id is falsy', async () => {
      expect((await settingsService.updateSupplierSettings(null)).message).toBe(
        ERROR_MESSAGES.ID_REQUIRED
      );
      expect((await settingsService.updateSupplierSettings('')).message).toBe(
        ERROR_MESSAGES.ID_REQUIRED
      );
      expect(settingsRepository.updateSupplierSettings).not.toHaveBeenCalled();
    });

    test('delegates to repository.updateSupplierSettings when id provided', async () => {
      settingsRepository.updateSupplierSettings.mockResolvedValue(OK({ updated: true }));
      await settingsService.updateSupplierSettings(FAKE_ID);
      expect(settingsRepository.updateSupplierSettings).toHaveBeenCalledWith(FAKE_ID);
    });

    test('returns SUPPLIER_SETTINGS_FAILED fallback on throw', async () => {
      settingsRepository.updateSupplierSettings.mockRejectedValue({});
      expect((await settingsService.updateSupplierSettings(FAKE_ID)).message).toBe(
        ERROR_MESSAGES.SUPPLIER_SETTINGS_FAILED
      );
    });
  });

  // ── Theme ─────────────────────────────────────────────────────────────────────

  describe('getThemeSettings', () => {
    test('delegates to repository.getThemeSettings', async () => {
      const mockResult = OK({ primary_color: '#FF5722', font: 'Roboto' });
      settingsRepository.getThemeSettings.mockResolvedValue(mockResult);
      expect(await settingsService.getThemeSettings()).toBe(mockResult);
      expect(settingsRepository.getThemeSettings).toHaveBeenCalledTimes(1);
    });

    test('returns error with THEME_NOT_FOUND fallback on error without message', async () => {
      settingsRepository.getThemeSettings.mockRejectedValue({});
      const result = await settingsService.getThemeSettings();
      expect(result.status).toBe(false);
      expect(result.message).toBe(ERROR_MESSAGES.THEME_NOT_FOUND);
      expect(result.data).toBeNull();
    });

    test('returns error.message on error with message', async () => {
      settingsRepository.getThemeSettings.mockRejectedValue(new Error('Collection missing'));
      const result = await settingsService.getThemeSettings();
      expect(result.message).toBe('Collection missing');
    });
  });

  describe('updateThemeSettings', () => {
    test('delegates to repository.updateThemeSettings', async () => {
      const data = { primary_color: '#2196F3', logo_url: '/images/logo.png' };
      const mockResult = OK({ updated: true });
      settingsRepository.updateThemeSettings.mockResolvedValue(mockResult);

      expect(await settingsService.updateThemeSettings(data)).toBe(mockResult);
      expect(settingsRepository.updateThemeSettings).toHaveBeenCalledWith(data);
    });

    test('returns THEME_SETTINGS_FAILED fallback on error without message', async () => {
      settingsRepository.updateThemeSettings.mockRejectedValue({});
      const result = await settingsService.updateThemeSettings({});
      expect(result.message).toBe(ERROR_MESSAGES.THEME_SETTINGS_FAILED);
    });
  });

  // ── Shared error-handling pattern ─────────────────────────────────────────────

  // ── Edge cases ────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('repository returns null — service passes null through', async () => {
      settingsRepository.getThemeSettings.mockResolvedValue(null);
      expect(await settingsService.getThemeSettings()).toBeNull();
    });

    test('updateGeneralSetting with empty payload delegates without guard', async () => {
      settingsRepository.updateGeneralSetting.mockResolvedValue(OK({ updated: true }));
      await settingsService.updateGeneralSetting({});
      expect(settingsRepository.updateGeneralSetting).toHaveBeenCalledWith({});
    });

    test('updateCommonSettings with boolean-false values delegates unchanged', async () => {
      const data = { stock_management: false, round_off: false };
      settingsRepository.updateCommonSettings.mockResolvedValue(OK({ updated: true }));
      await settingsService.updateCommonSettings(data);
      expect(settingsRepository.updateCommonSettings).toHaveBeenCalledWith(data);
    });

    test('updateCommonSettings with numeric-zero values delegates unchanged', async () => {
      const data = { tax_percentage: 0, discount: 0 };
      settingsRepository.updateCommonSettings.mockResolvedValue(OK({ updated: true }));
      await settingsService.updateCommonSettings(data);
      expect(settingsRepository.updateCommonSettings).toHaveBeenCalledWith(data);
    });

    test('updateCustomerSettings with false treated as falsy — returns ID_REQUIRED', async () => {
      const result = await settingsService.updateCustomerSettings(false);
      expect(result.message).toBe(ERROR_MESSAGES.ID_REQUIRED);
    });
  });
});
