'use strict';

/**
 * Real express-validator checks for the installation payload.
 *
 * The neighbouring install.validation.test.js mocks the validator chain to
 * inspect wiring. This file runs the actual chain, because the signup form was
 * rejected for a missing `license_id` that the form never sends.
 */

const { validationResult } = require('express-validator');
const { validateInstallation } = require('../../../src/middleware/install.validation');

async function runValidation(body) {
  const req = { body: { ...body } };
  for (const validator of validateInstallation) {
    await validator.run(req);
  }
  return { req, errors: validationResult(req).array() };
}

const validPayload = () => ({
  register_companyname: 'Test Shop',
  register_username: 'admin@example.com',
  register_useremail: 'admin@example.com',
  register_userpassword: 'StrongPass123!',
  register_license: '64a1b2c3d4e5f6a7b8c9d001',
});

describe('install payload validation', () => {
  test('accepts the payload the setup wizard actually sends, without license_id', async () => {
    const { errors } = await runValidation(validPayload());
    expect(errors).toEqual([]);
  });

  test('does not report license_id when register_license is present', async () => {
    const { errors } = await runValidation(validPayload());
    expect(errors.find((error) => (error.path || error.param) === 'license_id')).toBeUndefined();
  });

  test('still requires the setup key', async () => {
    const payload = validPayload();
    delete payload.register_license;
    const { errors } = await runValidation(payload);
    expect(errors.map((error) => error.path || error.param)).toContain('register_license');
  });

  test('returns one friendly message per invalid field', async () => {
    const { errors } = await runValidation({
      ...validPayload(),
      register_companyname: '',
      register_useremail: 'not-an-email',
      register_userpassword: '',
    });
    const byField = new Map(errors.map((error) => [error.path || error.param, error.msg]));
    expect(byField.get('register_companyname')).toBe('Enter your shop name.');
    expect(byField.get('register_useremail')).toMatch(/valid email address/i);
    expect(byField.get('register_userpassword')).toBe('Enter a password.');
  });
});
