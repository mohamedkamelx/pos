// src/models/customer.model.js
const BaseModel = require('./base.model');
require('mongodb');

/**
 * Customer Model
 * Schema-only model for customer data structure and validation
 * All business logic moved to CustomerService
 * All database operations moved to CustomerRepository
 */
class CustomerModel extends BaseModel {
  constructor() {
    super('customers');

    // Field definitions and validation rules
    this.fields = {
      _id: { type: 'ObjectId', select: true, name: 'id' },

      // Branch Information
      branch_id: { type: 'ObjectId', select: true },
      branch_name: { type: 'String', select: true },
      /* S7 (D5): the account-level relation, mirroring items. Seeded with the
         owning branch so nothing moves; sharing a customer between shops is a
         deliberate grant, never a migration side effect. select:false keeps it
         out of list payloads, exactly as items do. */
      branch_access: { type: 'Array', select: false },

      // Basic Information
      name: { type: 'String', select: true, required: true },
      category_id: { type: 'ObjectId', select: true },
      category_name: { type: 'String', select: true },
      referrer_id: { type: 'ObjectId', select: true },
      referrer_name: { type: 'String', select: true },
      email: {
        type: 'String',
        select: true,
        unique: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email'],
      },
      phone: {
        type: 'String',
        select: true,
        required: true,
      },
      allow_shared_phone: { type: 'Boolean', select: true, default: false },
      alternatePhone: { type: 'String', select: true },

      // Address Information
      address: { type: 'String', select: true },
      city: { type: 'String', select: true },
      state: { type: 'String', select: true },
      country: { type: 'String', select: true, default: 'Egypt' },
      pincode: { type: 'String', select: true },

      // Multiple Addresses
      addresses: [
        {
          type: {
            type: String,
            enum: ['billing', 'shipping', 'both'],
            default: 'both',
          },
          street: String,
          city: String,
          state: String,
          country: { type: String, default: 'Egypt' },
          pincode: String,
          isDefault: Boolean,
          _id: false,
        },
      ],

      /*
       * The registered business the invoice should be made out to.
       *
       * The business name printed on a document when it differs from the
       * customer's own name. Optional; an empty value leaves the customer
       * name on its own.
       */
      company_name: {
        type: 'String',
        trim: true,
        select: true,
      },

      // Customer Preferences
      preferences: {
        emailNotifications: { type: Boolean, default: true },
        _id: false,
      },

      // Statistics (updated by sales transactions)
      totalPurchases: { type: Number, default: 0, min: 0 },
      totalSpent: { type: Number, default: 0, min: 0 },
      lastPurchaseDate: { type: Date },
      averageOrderValue: { type: Number, default: 0, min: 0 },

      // Status
      status: {
        type: 'String',
        enum: ['active', 'inactive', 'blocked'],
        default: 'active',
        select: true,
      },

      // Notes and Tags
      notes: { type: 'String', select: true },
      tags: [{ type: String }],

      // Metadata
      license: { type: 'ObjectId', select: true, required: true },
      created_date: { type: 'Date', select: true, default: Date.now },
      updated_date: { type: 'Date', select: true, default: Date.now },
      created_by: { type: 'String', select: true },
      created_by_id: { type: 'ObjectId', select: true },
      updated_by: { type: 'String', select: true },
      updated_by_id: { type: 'ObjectId', select: true },
      is_deleted: { type: 'Boolean', select: true, default: false },
      deleted_date: { type: 'Date', select: true },
    };
  }

  /**
   * Validate customer data
   * @param {Object} data - Customer data to validate
   * @returns {Object} - { valid: boolean, errors: array }
   */
  validate(data) {
    const errors = [];

    // Required fields
    if (!data.name) {
      errors.push({ field: 'name', message: 'Customer name is required' });
    }

    if (!data.phone) {
      errors.push({ field: 'phone', message: 'Phone number is required' });
    }

    // Email validation
    if (data.email) {
      const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
      if (!emailRegex.test(data.email)) {
        errors.push({ field: 'email', message: 'Invalid email format' });
      }
    }

    // Phone number basic validation
    if (data.phone && data.phone.length < 10) {
      errors.push({ field: 'phone', message: 'Phone number must be at least 10 digits' });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get default customer data structure
   * @returns {Object} - Default customer object
   */
  getDefaultData() {
    return {
      name: '',
      category_id: null,
      category_name: '',
      referrer_id: null,
      referrer_name: '',
      email: '',
      phone: '',
      alternatePhone: '',
      address: '',
      city: '',
      state: '',
      country: 'Egypt',
      pincode: '',
      company_name: '',
      preferences: {
        emailNotifications: true,
      },
      totalPurchases: 0,
      totalSpent: 0,
      status: 'active',
      notes: '',
      tags: [],
      is_deleted: false,
    };
  }

  /**
   * Sanitize customer data before saving
   * @param {Object} data - Customer data
   * @returns {Object} - Sanitized data
   */
  sanitize(data) {
    const sanitized = { ...data };

    // Trim string fields
    if (sanitized.name) sanitized.name = sanitized.name.trim();
    if (sanitized.email) sanitized.email = sanitized.email.trim().toLowerCase();
    if (sanitized.phone) sanitized.phone = sanitized.phone.trim();
    if (sanitized.address) sanitized.address = sanitized.address.trim();
    if (sanitized.city) sanitized.city = sanitized.city.trim();
    if (sanitized.state) sanitized.state = sanitized.state.trim();

    return sanitized;
  }
}

module.exports = CustomerModel;
