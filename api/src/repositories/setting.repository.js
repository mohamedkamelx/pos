/**
 * Settings Repository
 * Data access layer for settings operations
 */

require('../constants/settings.constants');

class SettingsRepository {
  constructor() {
    this.settingModel = null; // Will be injected by service
  }

  /**
   * Get theme settings
   */
  async getThemeSettings() {
    return await this.settingModel.getThemeSettings();
  }

  /**
   * Update theme settings
   */
  async updateThemeSettings(data) {
    return await this.settingModel.editThemeSettings(data);
  }

  /**
   * Get default customer
   */
  async getDefaultCustomer(id) {
    return await this.settingModel.getDefaultCustomerModel(id);
  }

  /**
   * Get default supplier
   */
  async getDefaultSupplier(id) {
    return await this.settingModel.getDefaultSupplierModel(id);
  }

  /**
   * Get default customer and supplier
   */
  async getDefaultCustomerSupplier(customerId, supplierId) {
    return await this.settingModel.getDefaultCustomerSupplierModel(customerId, supplierId);
  }

  /**
   * Backup table
   */
  async backupTable(limit, page, filter, dateRange) {
    return await this.settingModel.backupTableModel(limit, page, filter, dateRange);
  }

  setModel(settingModel) {
    this.settingModel = settingModel;
  }

  async getDenomAll() {
    return await this.settingModel.getDenomAllModel();
  }

  /**
   * Add denomination form
   */

  async addDenomForm(data) {
    return await this.settingModel.addDenomModel(data);
  }

  /**
   * Add denomination data
   */

  async addDenomData(data) {
    return await this.settingModel.addDenomDataModel(data);
  }

  /**
   * Edit denomination form
   */

  async deleteDenom(id) {
    return await this.settingModel.deleteDenomFiledModel(id);
  }

  /**
   * Delete a unit
   */

  async deleteUnit(id) {
    return await this.settingModel.deleteUnitModel(id);
  }

  /**
   * Get all denominations
   */

  async updateCustomerSettings(id) {
    return await this.settingModel.updateCommonCustomerSettings(id);
  }

  /**
   * Update supplier settings
   */

  async updateSupplierSettings(id) {
    return await this.settingModel.updateCommonSupplierSettings(id);
  }

  /**
   * Change password
   */

  async changePassword(data) {
    return await this.settingModel.changePasswordModel(data);
  }

  /**
   * Suggestions for the recycle-bin table field
   */

  async autoSuggestionRecycleBinTableField(query) {
    return await this.settingModel.autoSuggestionRecycleBinTableFieldModel(query);
  }

  /**
   * Get all collection total
   */

  async getAllCollectionTotal() {
    return await this.settingModel.getAllCollectionTotalModel();
  }

  /**
   * Email setting
   */

  async restoreBackup(data) {
    return await this.settingModel.restoreBackupModel(data);
  }

  /**
   * Get dashboard sales count
   */

  async updateGeneralSetting(data) {
    return await this.settingModel.editGeneralSetting(data);
  }

  async updateStarterLocale(data) {
    return await this.settingModel.updateStarterLocale(data);
  }

  /**
   * Update common settings
   */

  async updateCommonSettings(data) {
    return await this.settingModel.updateCommonSettings(data);
  }

  /**
   * Update offline setting
   */
}

module.exports = new SettingsRepository();
