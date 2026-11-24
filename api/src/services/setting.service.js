/**
 * Settings Service
 * Business logic layer for settings operations
 */

const settingsRepository = require('../repositories/setting.repository');
const { ERROR_MESSAGES } = require('../constants/settings.constants');

class SettingsService {
  constructor() {
    this.repository = settingsRepository;
  }

  /**
   * Change password
   */
  async changePassword(data) {
    try {
      const result = await this.repository.changePassword(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.PASSWORD_CHANGE_FAILED,
        data: null,
      };
    }
  }

  /**
   * Update customer settings
   */
  async updateCustomerSettings(id) {
    try {
      if (!id) {
        return {
          status: false,
          message: ERROR_MESSAGES.ID_REQUIRED,
          data: null,
        };
      }
      const result = await this.repository.updateCustomerSettings(id);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.CUSTOMER_SETTINGS_FAILED,
        data: null,
      };
    }
  }

  /**
   * Update supplier settings
   */
  async updateSupplierSettings(id) {
    try {
      if (!id) {
        return {
          status: false,
          message: ERROR_MESSAGES.ID_REQUIRED,
          data: null,
        };
      }
      const result = await this.repository.updateSupplierSettings(id);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.SUPPLIER_SETTINGS_FAILED,
        data: null,
      };
    }
  }

  /**
   * Get theme settings
   */
  async getThemeSettings() {
    try {
      const result = await this.repository.getThemeSettings();
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.THEME_NOT_FOUND,
        data: null,
      };
    }
  }

  /**
   * Update theme settings
   */
  async updateThemeSettings(data) {
    try {
      const result = await this.repository.updateThemeSettings(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.THEME_SETTINGS_FAILED,
        data: null,
      };
    }
  }

  setModel(settingModel) {
    this.repository.setModel(settingModel);
  }

  async getDenomAll() {
    try {
      const result = await this.repository.getDenomAll();
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.DENOM_NOT_FOUND,
        data: null,
      };
    }
  }

  /**
   * Add denomination form
   */

  async addDenomForm(data) {
    try {
      const result = await this.repository.addDenomForm(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.DENOM_ADD_FAILED,
        data: null,
      };
    }
  }

  /**
   * Add denomination data
   */

  async addDenomData(data) {
    try {
      const result = await this.repository.addDenomData(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.DENOM_ADD_FAILED,
        data: null,
      };
    }
  }

  /**
   * Edit denomination form
   */

  async deleteDenom(id) {
    try {
      if (!id) {
        return {
          status: false,
          message: ERROR_MESSAGES.ID_REQUIRED,
          data: null,
        };
      }
      const result = await this.repository.deleteDenom(id);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.DENOM_DELETE_FAILED,
        data: null,
      };
    }
  }

  /**
   * Delete a unit
   */

  async deleteUnit(id) {
    try {
      if (!id) {
        return {
          status: false,
          message: ERROR_MESSAGES.ID_REQUIRED,
          data: null,
        };
      }
      const result = await this.repository.deleteUnit(id);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.UNIT_DELETE_FAILED,
        data: null,
      };
    }
  }

  /**
   * Get all denominations
   */

  async updateGeneralSetting(data) {
    try {
      const result = await this.repository.updateGeneralSetting(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.UPDATE_FAILED,
        data: null,
      };
    }
  }

  async updateStarterLocale(data) {
    try {
      const result = await this.repository.updateStarterLocale(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.UPDATE_FAILED,
        data: null,
      };
    }
  }

  /**
   * Update common settings
   */

  async updateCommonSettings(data) {
    try {
      const result = await this.repository.updateCommonSettings(data);
      return result;
    } catch (error) {
      return {
        status: false,
        message: error.message || ERROR_MESSAGES.UPDATE_FAILED,
        data: null,
      };
    }
  }

  /**
   * Update offline setting
   */
}

module.exports = new SettingsService();
