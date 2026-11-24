'use strict';

const {
  DEFAULTS,
  CUSTOMER_STATUS,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  HTTP_STATUS,
  RESPONSE_TYPES,
  FIELD_LIMITS,
  VALIDATION_PATTERNS,
} = require('../../../src/constants/customers.constants');

describe('customers.constants', () => {
  test('exports default values and status enums', () => {
    expect(DEFAULTS).toEqual({
      COUNTRY: 'Egypt',
      BALANCE: 0,
      PARTIAL_BALANCE: false,
    });

    expect(CUSTOMER_STATUS).toEqual({
      ACTIVE: 'active',
      INACTIVE: 'inactive',
      BLOCKED: 'blocked',
    });
  });

  test('exports response metadata', () => {
    expect(RESPONSE_TYPES).toEqual({
      SUCCESS: 'success',
      ERROR: 'error',
      EXIST: 'exist',
      NONE: 'none',
    });

    expect(HTTP_STATUS).toMatchObject({
      OK: 200,
      CREATED: 201,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      NOT_ACCEPTABLE: 406,
      CONFLICT: 409,
      INTERNAL_ERROR: 500,
    });
  });

  test('exports messages and validation rules', () => {
    expect(ERROR_MESSAGES).toMatchObject({
      CUSTOMER_NOT_FOUND: 'Customer not found',
      CUSTOMER_NAME_REQUIRED: 'Customer name is required',
      EMAIL_EXISTS: 'Customer with this email already exists',
      PHONE_EXISTS: 'Customer with this phone number already exists',
      INVALID_EMAIL: 'Invalid email address',
      INVALID_PHONE: 'Invalid phone number',
      VALIDATION_ERROR: 'Validation Error',
      BRANCH_REQUIRED: 'Branch ID is required',
      DELETE_FAILED: 'Failed to delete customer',
      UPDATE_FAILED: 'Failed to update customer',
      CREATE_FAILED: 'Failed to create customer',
      PARTIAL_BALANCE_DISABLED: 'Partial balance is not enabled for this customer',
    });

    expect(SUCCESS_MESSAGES).toMatchObject({
      CUSTOMER_CREATED: 'Customer added',
      CUSTOMER_UPDATED: 'Customer updated',
      CUSTOMER_DELETED: 'Customer deleted',
      CUSTOMERS_DELETED: 'Customers deleted',
      CUSTOMERS_RETRIEVED: 'Customers retrieved',
      CUSTOMER_RETRIEVED: 'Customer retrieved',
      PREFERENCES_UPDATED: 'Customer preferences updated',
      CUSTOMERS_IMPORTED: 'Customers imported',
      CUSTOMERS_EXPORTED: 'Customers exported',
    });

    expect(FIELD_LIMITS).toEqual({
      NAME_MIN: 1,
      NAME_MAX: 100,
      EMAIL_MAX: 250,
      PHONE_MIN: 10,
      PHONE_MAX: 15,
      ADDRESS_MAX: 500,
      NOTES_MAX: 1000,
      PINCODE_LENGTH: 6,
    });

    expect(VALIDATION_PATTERNS.EMAIL).toBeInstanceOf(RegExp);
    expect(VALIDATION_PATTERNS.PHONE).toBeInstanceOf(RegExp);
    expect(VALIDATION_PATTERNS.PINCODE).toBeInstanceOf(RegExp);
  });
});
