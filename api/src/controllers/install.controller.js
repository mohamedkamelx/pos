// src/controllers/install.controller.js
const BaseController = require('./base.controller');
const InstallService = require('../services/install.service');
const { validationResult } = require('express-validator');
const { HTTP_STATUS, ERROR_MESSAGES } = require('../constants/install.constants');

/**
 * Turn express-validator's array into field/message pairs the setup screen can
 * put beside the input that needs attention.
 */
function validationDetails(errors) {
  const fields = [];
  const seen = new Set();
  for (const error of errors) {
    const field = error.path || error.param || error.location || 'form';
    const message = String(error.msg || error.message || 'Please check this field.');
    const key = `${field}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({ field, message });
  }
  return {
    errors,
    fields,
    readable: fields.map(({ field, message }) => `${field}: ${message}`).join(', '),
  };
}

/**
 * Install Controller
 * Handles HTTP requests for installation operations
 * Uses service layer for business logic
 */
class InstallController extends BaseController {
  constructor() {
    super();
    this.service = new InstallService();
  }

  /**
   * Add/Install new Posnic account
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async add(req, res) {
    try {
      res.set('Cache-Control', 'no-store');
      console.log('🎯 Controller received req.body:', {
        db_username: req.body.db_username,
        db_password: req.body.db_password ? '[REDACTED]' : undefined,
      });

      // Validate request (validation middleware should have run)
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return this.sendError(
          res,
          ERROR_MESSAGES.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST,
          validationDetails(errors.array())
        );
      }

      // Call service to process installation
      const response = await this.service.processInstallation(req.body);

      if (response.status === true) {
        return this.sendResponse(res, response.data, response.message, HTTP_STATUS.OK);
      } else {
        return this.sendError(res, response.message, HTTP_STATUS.BAD_REQUEST, response.data);
      }
    } catch (error) {
      console.error('Error in InstallController.add:', error);
      return this.sendError(res, 'Internal server error', HTTP_STATUS.INTERNAL_ERROR, null);
    }
  }

  /**
   * Cleanup all data by license ID
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async cleanup(req, res) {
    try {
      // Validate request (validation middleware should have run)
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return this.sendError(
          res,
          ERROR_MESSAGES.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST,
          validationDetails(errors.array())
        );
      }

      const { license_id } = req.body;

      // Call service to cleanup data
      const response = await this.service.cleanupByLicense(license_id);

      if (response.status === true) {
        return this.sendResponse(res, response.data, response.message, HTTP_STATUS.OK);
      } else {
        return this.sendError(res, response.message, HTTP_STATUS.BAD_REQUEST, response.data);
      }
    } catch (error) {
      console.error('Error in InstallController.cleanup:', error);
      return this.sendError(res, 'Internal server error', HTTP_STATUS.INTERNAL_ERROR, null);
    }
  }
}

module.exports = new InstallController();
