'use strict';

const {
  DEFAULTS,
  INSTALL_STATUS,
  USER_TYPES,
  REGISTER_STATUS,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  HTTP_STATUS,
  RESPONSE_TYPES,
  FIELD_LIMITS,
  DEFAULT_ACCESS,
  CLEANUP_COLLECTIONS,
} = require('../../../src/constants/install.constants');

describe('install.constants', () => {
  test('exports default values and enums', () => {
    expect(DEFAULTS).toEqual({
      USER_TYPE: 'super_admin',
      IMAGE: 'user.svg',
      LOGO: 'store.png',
      PLAN_NAME: 'premium',
      MAX_SALES: 'unlimited',
      PLAN_DURATION_YEARS: 1,
      CURRENCY: '$',
      CURRENCY_TEXT: 'جنية / EGP or $',
      CURRENCY_TYPE: '$',
      TIME_ZONE: 'Africa/Cairo',
      SALES_PREFIX: 'S',
      RECEIVING_PREFIX: 'RID',
      PRINT_TYPE: 'standard',
      PRINTING_SIZE: 'receipt_medium',
      PRINT_CHARACTER: 'default',
      HEADER_PRINT: 'default',
      FOOTER_PRINT: 'Thank you for shopping...!',
      CLIENT_DATEFORMAT: 'dd/mm/yyyy',
      SERVER_DATEFORMAT: 'd/m/Y',
      DATEFORMAT_TEXT: '01/01/2018 -- dd/mm/yyyy',
      NOTIFICATION_RANGE: '10',
      THEME: 'blue',
    });

    expect(INSTALL_STATUS).toEqual({
      SUCCESS: 'success',
      FAILED: 'failed',
      PENDING: 'pending',
    });

    expect(USER_TYPES).toEqual({
      SUPER_ADMIN: 'super_admin',
      ADMIN: 'admin',
      USER: 'user',
    });

    expect(REGISTER_STATUS).toEqual({
      OPEN: 'Open',
      CLOSED: 'Closed',
    });
  });

  test('exports messages, status codes, and limits', () => {
    expect(ERROR_MESSAGES).toMatchObject({
      UNAUTHORIZED: 'Unauthorized',
      VALIDATION_ERROR: 'Please check the highlighted fields and try again.',
      COMPANY_NAME_REQUIRED: 'Enter your shop name.',
      COMPANY_NAME_LENGTH: 'Shop name must be between 3 and 160 characters.',
      USERNAME_REQUIRED: 'Enter a username.',
      USERNAME_LENGTH: 'Username must be between 3 and 50 characters.',
      EMAIL_REQUIRED: 'Enter your email address.',
      VALID_EMAIL_REQUIRED: 'Enter a valid email address, for example name@example.com.',
      EMAIL_LENGTH: 'Email must be 100 characters or fewer.',
      PHONE_LENGTH: 'Phone number must be 20 characters or fewer.',
      PASSWORD_REQUIRED: 'Enter a password.',
      PASSWORD_LENGTH: 'Password must be at least 6 characters.',
      PASSWORD_HASH_INVALID: 'The password could not be read. Restart setup and try again.',
      SETUP_KEY_REQUIRED: 'The setup key is missing. Restart setup and try again.',
      SETUP_KEY_INVALID: 'The setup key is invalid. Restart setup and try again.',
      LICENSE_ID_REQUIRED: 'The cleanup key is missing. Restart setup and try again.',
      DUPLICATE_USERNAME: 'This username is already in use. Use a different one.',
      DUPLICATE_EMAIL: 'This email address is already in use. Use a different one.',
      DUPLICATE_LICENSE: 'This setup key is already in use. Use a different one.',
      INSTALLATION_FAILED: 'Setup could not be completed. Please try again.',
      CLEANUP_FAILED: 'The cleanup could not be completed. Please try again.',
      INVALID_KEY_SECRET: 'Invalid installation key or secret',
      BRANCH_LICENSE_REQUIRED: 'Branch and license context required',
      DEFAULT_DATA_LOAD_FAILED: 'Failed to load default data',
    });

    expect(SUCCESS_MESSAGES).toEqual({
      ACCOUNT_CREATED: 'Account created',
      CLEANUP_SUCCESS: 'Deleted records across all collections',
      INSTALLATION_COMPLETE: 'Installation completed',
      DEFAULT_DATA_LOADED: 'Default data loaded',
    });

    expect(HTTP_STATUS).toMatchObject({
      OK: 200,
      CREATED: 201,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INTERNAL_ERROR: 500,
    });

    expect(RESPONSE_TYPES).toEqual({
      SUCCESS: 'success',
      ERROR: 'error',
      EXIST: 'exist',
    });

    expect(FIELD_LIMITS).toEqual({
      COMPANY_NAME_MIN: 3,
      COMPANY_NAME_MAX: 160,
      PHONE_MAX: 20,
      USERNAME_MIN: 3,
      USERNAME_MAX: 50,
      EMAIL_MAX: 100,
    });
  });

  test('exports access and cleanup structures', () => {
    expect(DEFAULT_ACCESS).toHaveProperty('dashboard.read', true);
    expect(DEFAULT_ACCESS).toHaveProperty('sales.write', true);
    expect(DEFAULT_ACCESS).toHaveProperty('plan.read', true);
    expect(CLEANUP_COLLECTIONS).toEqual([
      'users',
      'branches',
      'customers',
      'suppliers',
      'categories',
      'items',
      'unit',
      'sales',
      'receivings',
      'stocklogs',
      'payments',
      'reports',
      'notifications',
      'settings',
    ]);
  });
});
