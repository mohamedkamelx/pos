'use strict';

const {
  HTTP_STATUS,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  VALIDATION_RULES,
  COLLECTIONS,
  DEFAULTS,
  FILE_PATHS,
} = require('../../../src/constants/settings.constants');

describe('settings.constants', () => {
  test('exports status, defaults, and paths', () => {
    expect(HTTP_STATUS).toEqual({
      OK: 200,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      NOT_FOUND: 404,
      INTERNAL_ERROR: 500,
    });

    expect(DEFAULTS).toEqual({
      COUNTRY_ID: '64',
      COUNTRY_SORTNAME: 'EG',
      LIMIT: 5,
      PAGE: 1,
    });

    expect(FILE_PATHS).toEqual({
      JSON_COUNTRIES: 'countries.json',
      JSON_CURRENCY: 'currency.json',
      JSON_TIMEZONE: 'timezone.json',
      STATE_PREFIX: 'state_',
    });
  });

  test('exports message maps', () => {
    expect(ERROR_MESSAGES).toMatchObject({
      NOT_FOUND: 'Setting not found',
      INVALID_DATA: 'The data provided is not valid',
      UNAUTHORIZED: 'Unauthorized',
      UPDATE_FAILED: 'Failed to update setting',
      DELETE_FAILED: 'Failed to delete setting',
      UNIT_NOT_FOUND: 'Unit not found',
      UNIT_ADD_FAILED: 'Failed to add unit',
      UNIT_UPDATE_FAILED: 'Failed to update unit',
      UNIT_DELETE_FAILED: 'Failed to delete unit',
      DENOM_NOT_FOUND: 'Denomination not found',
      DENOM_ADD_FAILED: 'Failed to add denomination',
      DENOM_UPDATE_FAILED: 'Failed to update denomination',
      DENOM_DELETE_FAILED: 'Failed to delete denomination',
      FILE_NOT_FOUND: 'File not found',
      FILE_UPLOAD_FAILED: 'File upload failed',
      INVALID_FILE_NAME: 'Invalid file name',
      IMAGE_DELETE_FAILED: 'Failed to delete image',
      PASSWORD_CHANGE_FAILED: 'Failed to change password',
      OLD_PASSWORD_INCORRECT: 'Your current password is incorrect',
      COLLECTION_DELETE_FAILED: 'Failed to delete collection',
      CUSTOMER_SETTINGS_FAILED: 'Failed to update customer settings',
      SUPPLIER_SETTINGS_FAILED: 'Failed to update supplier settings',
      THEME_SETTINGS_FAILED: 'Failed to update theme settings',
      THEME_NOT_FOUND: 'No theme settings found',
      REQUIRED_FIELDS_MISSING: 'Required fields are missing',
      ID_REQUIRED: 'ID is required',
      INVALID_ID_FORMAT: 'Invalid ID format',
      BACKUP_FAILED: 'Backup operation failed',
      RESTORE_FAILED: 'Restore operation failed',
    });

    expect(SUCCESS_MESSAGES).toMatchObject({
      UPDATED: 'Setting updated',
      DELETED: 'Setting deleted',
      RETRIEVED: 'Setting retrieved',
      UNIT_ADDED: 'Unit added',
      UNIT_UPDATED: 'Unit updated',
      UNIT_DELETED: 'Unit deleted',
      UNIT_RETRIEVED: 'Unit retrieved',
      DENOM_ADDED: 'Denomination added',
      DENOM_UPDATED: 'Denomination updated',
      DENOM_DELETED: 'Denomination deleted',
      DENOM_RETRIEVED: 'Denomination retrieved',
      GENERAL_SETTING_UPDATED: 'General Setting updated',
      COMMON_SETTINGS_UPDATED: 'Common settings updated',
      OFFLINE_SETTING_UPDATED: 'Offline setting updated',
      LOGO_UPDATED: 'Branch logo updated',
      IMAGE_STORED: 'Image data stored',
      IMAGE_DELETED: 'Image deleted',
      PASSWORD_CHANGED: 'Password changed',
      CUSTOMER_SETTINGS_UPDATED: 'Customer settings updated',
      SUPPLIER_SETTINGS_UPDATED: 'Supplier settings updated',
      THEME_SETTINGS_UPDATED: 'Theme settings updated',
      THEME_SETTINGS_RETRIEVED: 'Theme settings retrieved',
      COLLECTION_DELETED: 'Collection deleted',
      BACKUP_CREATED: 'Backup created',
      RESTORE_COMPLETED: 'Restore completed',
    });
  });

  test('exports validation and collection structures', () => {
    expect(VALIDATION_RULES).toMatchObject({
      STORE_NAME: { MIN: 3, MAX: 250 },
      STORE_EMAIL: { MAX: 50 },
      STORE_TELEPHONE: { MIN: 3, MAX: 20 },
      STORE_ADDRESS: { MIN: 3, MAX: 500 },
      PRINTING_ADDRESS: { MIN: 3, MAX: 500 },
      WEBSITE: { MIN: 3, MAX: 50 },
      CITY: { MAX: 50 },
      PINCODE: { MAX: 15 },
      UNIT_NAME: { MIN: 1, MAX: 20 },
      UNIT_VALUE: { MIN: 1, MAX: 6 },
      DENOM_VALUE: { MIN: 1, MAX: 5 },
      DEFAULT_CUSTOMER: { MIN: 3, MAX: 100 },
      DEFAULT_SUPPLIER: { MIN: 3, MAX: 100 },
      PASSWORD: { MIN: 5, MAX: 20 },
    });

    expect(COLLECTIONS).toEqual({
      BRANCHES: 'branches',
      UNIT: 'unit',
      DENOMINATION: 'denomination',
      RECYCLE_BIN: 'recycle_bin',
    });
  });
});
