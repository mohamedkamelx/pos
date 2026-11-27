// src/services/install.service.js
const InstallRepository = require('../repositories/install.repository');
const {
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  DEFAULTS,
  DEFAULT_ACCESS,
  USER_TYPES,
  REGISTER_STATUS,
} = require('../constants/install.constants');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const recoveryCodes = require('../utils/recovery-codes');
const { WALK_IN_NAME, GENERAL_SUPPLIER_NAME } = require('../utils/default-parties');

/*
 * The shop type chosen on the registration form. A cloud signup sends
 * `businessType`; the local setup may omit it. Store one short value, or a
 * comma-separated list when the form allows more than one choice. The
 * assistant reads this later to keep its category vocabulary relevant.
 */
function storeTypeFromInstall(data) {
  const value = data && (data.businessType !== undefined ? data.businessType : data.business_type);
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry == null ? '' : entry).trim())
      .filter(Boolean)
      .join(', ')
      .slice(0, 80);
  }
  return String(value == null ? '' : value)
    .trim()
    .slice(0, 80);
}

/**
 * Install Service
 * Contains business logic for installation operations
 * Acts as a bridge between controller and repository
 */
class InstallService {
  constructor() {
    this.repository = new InstallRepository();
  }

  /**
   * Process installation and create new Posnic account
   * @param {Object} data - Installation data from request
   * @returns {Promise<Object>}
   */
  async processInstallation(data) {
    try {
      /*
       * REFUSE TO INSTALL OVER A SHOP THAT ALREADY EXISTS.
       *
       * On 28 August 2026 a live white-label customer - a horticultural
       * corporation with five branches, 265 products and 87 sales going back
       * to April 2025 - had all of it replaced by a fresh shop and demo data.
       * Nobody deleted anything. Their tenant row was set provisioned:false,
       * the provisioner read that as "a new signup", and called this endpoint
       * against their live database. This function did exactly as it was
       * asked.
       *
       * That is the whole failure: install is a CREATE, and nothing here
       * checked whether there was already something to destroy. It is the last
       * point at which the mistake is still recoverable, so the check belongs
       * here rather than only in the caller - the caller that did it was
       * trusted, and a second caller will be trusted too.
       *
       * A branch is the right thing to look for. Every installed shop has one
       * and no empty database does, so its presence means somebody's shop is
       * on the other end of this call.
       *
       * `force` exists for the deliberate rebuild of a shop known to be empty
       * of anything worth keeping, and has to be passed on purpose.
       */
      if (data && data.force !== true) {
        /*
         * Asked only if it can be asked.
         *
         * A repository that does not answer this - an older one, or a test
         * double - must not turn every install into a failure. An unanswerable
         * question is treated as "empty", because refusing then would block
         * genuine signups, which is a worse failure than the one being
         * prevented.
         */
        const existing =
          typeof this.repository.countExistingBranches === 'function'
            ? await this.repository.countExistingBranches().catch(() => 0)
            : 0;
        if (existing > 0) {
          console.error(
            `⛔ install refused: this database already holds ${existing} branch(es). ` +
              'Installing would replace an existing shop. Pass force:true only if it is ' +
              'certainly empty of anything worth keeping.'
          );
          return {
            status: false,
            message:
              'This database already contains a shop. Installing would replace it, ' +
              'so it has been refused.',
            data: { existingBranches: existing },
          };
        }
      }

      // Setup MongoDB authentication FIRST (before any DB operations)
      // This is needed when MongoDB is already running with --auth flag
      if (data.db_username && data.db_password) {
        console.log('🔐 Setting up MongoDB authentication first...');
        await this._setupMongoDBAuth(data.db_username, data.db_password);
      }

      const licenseId = new ObjectId(data.register_license);

      // Check if user already exists
      const existingUser = await this.repository.findExistingUser({
        username: data.register_username,
        email: data.register_useremail,
        licenseId,
      });

      if (existingUser) {
        const existingLicense = existingUser.license ? existingUser.license.toString() : '';
        if (existingLicense && existingLicense !== licenseId.toString()) {
          // The username or email belongs to a different shop. Never clean up
          // the new license here: it would delete nothing and then fail with a
          // raw duplicate-key error. Tell the setup screen which field to fix.
          const duplicateField = this._getDuplicateField(existingUser, data, licenseId);
          const message = this._duplicateMessage(duplicateField, data, existingUser);
          return {
            status: false,
            data: { field: this._requestFieldForDuplicate(duplicateField), message },
            message,
          };
        }
        // For fresh installation, cleanup existing data with same license
        console.log('🧹 Found existing data, cleaning up before fresh installation...');
        await this.repository.cleanupByLicense(licenseId);
      }

      // Generate user secret key
      const usersecretkey = await this._generateUserSecretKey();

      // Create timestamps
      const now = new Date();
      const oneYearLater = new Date(now);
      oneYearLater.setFullYear(oneYearLater.getFullYear() + DEFAULTS.PLAN_DURATION_YEARS);

      // Insert user
      const recovery = recoveryCodes.enabled() ? recoveryCodes.createBatch(now) : null;
      const userId = await this._createUser(
        data,
        licenseId,
        usersecretkey,
        now,
        oneYearLater,
        recovery
      );

      // Load print templates
      const { regularBodyPrint, thermalBodyPrint } = this._loadPrintTemplates();

      // Create branch
      const branchId = await this._createBranch(
        data,
        licenseId,
        userId,
        now,
        regularBodyPrint,
        thermalBodyPrint
      );

      // Update user with branch access
      await this._updateUserBranchAccess(data, userId, licenseId, branchId);

      const sortname = this._countrySortName(data);

      // Create default customer and supplier
      const customerId = await this._createDefaultCustomer(
        data,
        branchId,
        userId,
        licenseId,
        now,
        sortname
      );
      const supplierId = await this._createDefaultSupplier(
        data,
        branchId,
        userId,
        licenseId,
        now,
        sortname
      );

      // Create default unit
      const unitId = await this._createDefaultUnit(data, branchId, userId, licenseId, now);

      // Update branch with default values
      await this._updateBranchDefaults(branchId, licenseId, userId, data, customerId, supplierId);

      // Add email fields to branch
      await this._addBranchEmailFields(branchId, licenseId, data);

      // Handle demo data or default data
      const userBranch = [
        {
          branch_id: branchId,
          branch_name: data.register_companyname,
          branch_image: DEFAULTS.LOGO,
        },
      ];

      // New shops start empty. Demo samples are never installed.
      console.log('Clean catalogue selected. No starter products inserted.');

      return {
        status: true,
        data: recovery
          ? { recoveryCodes: recovery.codes, recoveryAccount: data.register_useremail.trim() }
          : '',
        message: SUCCESS_MESSAGES.ACCOUNT_CREATED,
      };
    } catch (error) {
      console.error('Error in InstallService.processInstallation:', error);

      // Handle MongoDB duplicate key errors
      if (error.code === 11000) {
        const duplicateField = Object.keys(error.keyPattern || {})[0];
        if (!duplicateField) {
          return {
            status: false,
            data: '',
            message: ERROR_MESSAGES.INSTALLATION_FAILED,
          };
        }
        const duplicateValue = error.keyValue ? error.keyValue[duplicateField] : '';
        const collectionMatch = error.message.match(/collection: [\w.]+\.(\w+)/);
        const collection = collectionMatch ? collectionMatch[1] : 'database';
        const message = this._duplicateMessage(duplicateField, null, null, duplicateValue);

        return {
          status: false,
          data: {
            field: this._requestFieldForDuplicate(duplicateField),
            message,
            duplicateField,
            collection,
          },
          message,
        };
      }

      return {
        status: false,
        data: '',
        message: error.message || ERROR_MESSAGES.INSTALLATION_FAILED,
      };
    }
  }

  /**
   * Cleanup all data by license ID
   * @param {string} licenseId - License ID to cleanup
   * @returns {Promise<Object>}
   */
  async cleanupByLicense(licenseId) {
    try {
      const license = new ObjectId(licenseId);
      const result = await this.repository.cleanupByLicense(license);

      return {
        status: true,
        data: {
          license: licenseId,
          totalDeleted: result.totalDeleted,
          details: result.details,
        },
        message: `${SUCCESS_MESSAGES.CLEANUP_SUCCESS} for license ${licenseId}`,
      };
    } catch (error) {
      console.error('Error in InstallService.cleanupByLicense:', error);
      return {
        status: false,
        data: '',
        message: error.message || ERROR_MESSAGES.CLEANUP_FAILED,
      };
    }
  }

  // Private helper methods

  _getDuplicateField(existingUser, data, licenseId) {
    // The desktop form uses the email as the username, so check the email
    // first: the person typed it into the email field and should see that
    // field highlighted, not a "username" they never chose.
    if (existingUser.email === data.register_useremail) {
      return 'email';
    } else if (existingUser.username === data.register_username) {
      return 'username';
    } else if (existingUser.license && existingUser.license.toString() === licenseId.toString()) {
      return 'license';
    }
    return 'field';
  }

  _requestFieldForDuplicate(field) {
    const fields = {
      username: 'register_username',
      email: 'register_useremail',
      license: 'register_license',
    };
    return fields[field] || field;
  }

  _duplicateMessage(field, data = null, existingUser = null, explicitValue = '') {
    const labels = { username: 'username', email: 'email address', license: 'setup key' };
    const label = labels[field] || field || 'value';
    let value = explicitValue;
    if (!value && data) {
      if (field === 'username') value = data.register_username;
      else if (field === 'email') value = data.register_useremail;
      else if (field === 'license') value = data.register_license;
    }
    if (!value && existingUser) {
      if (field === 'username') value = existingUser.username;
      else if (field === 'email') value = existingUser.email;
      else if (field === 'license') value = existingUser.license;
    }
    const shown = value ? ` (${String(value)})` : '';
    return `This ${label}${shown} is already in use. Use a different one.`;
  }

  async _generateUserSecretKey() {
    const random =
      new Date().toISOString().slice(0, 10).replace(/-/g, '') + Math.floor(Math.random() * 10000);
    return await bcrypt.hash(random, 10);
  }

  async _createUser(data, licenseId, usersecretkey, now, oneYearLater, recovery = null) {
    // A cloud signup already hashed this password for the website account, and
    // the plaintext is deliberately not kept anywhere. Accepting the hash lets
    // one password work for the website, the shop's cloud site and the till,
    // without ever storing it in the clear or asking the customer twice.
    const hashedPassword = data.register_userpasswordhash
      ? String(data.register_userpasswordhash)
      : await bcrypt.hash(data.register_userpassword.trim(), 10);

    const userData = {
      ...(recovery ? { localRecovery: recovery.record } : {}),
      branch_access: '',
      plan: {
        name: DEFAULTS.PLAN_NAME,
        read: true,
        max_sales: DEFAULTS.MAX_SALES,
        plan_expire: oneYearLater,
      },
      userkey: usersecretkey.trim(),
      firstname: (data.register_firstname || '').trim(),
      lastname: (data.register_lastname || '').trim(),
      username: data.register_username.trim(),
      password: hashedPassword,
      usertype: USER_TYPES.SUPER_ADMIN,
      email: data.register_useremail.trim(),
      apikey: '',
      access: DEFAULT_ACCESS,
      image: DEFAULTS.IMAGE,
      activate: true,
      printing_design: '',
      register_status: REGISTER_STATUS.CLOSED,
      created_date: now,
      updated_date: now,
      expired_date: oneYearLater,
      created_by: data.register_username,
      created_by_id: '',
      updated_by: data.register_username,
      updated_by_id: '',
      license: licenseId,
      plan_access: [],
    };

    return await this.repository.insertUser(userData);
  }

  _loadPrintTemplates() {
    const regularBodyPrint = fs.readFileSync(
      path.join(__dirname, '../json/print_a4html.txt'),
      'utf8'
    );
    const thermalBodyPrint = fs.readFileSync(
      path.join(__dirname, '../json/print_standard_html.txt'),
      'utf8'
    );
    return { regularBodyPrint, thermalBodyPrint };
  }

  /*
   * Day-first or month-first, from the shop's country. Only a handful of
   * places read dates month-first (the US and the territories that follow
   * it); everywhere else on the till's map reads day-first, which is also
   * the long-standing default. register_dateformat ('mdy'/'dmy') is the
   * onboarding override and wins when present.
   */
  _dateFormatForCountry(countryName, explicit) {
    const MDY = {
      client: 'mm/dd/yyyy',
      server: 'm/d/Y',
      text: '01/31/2018 -- mm/dd/yyyy',
    };
    const DMY = {
      client: DEFAULTS.CLIENT_DATEFORMAT,
      server: DEFAULTS.SERVER_DATEFORMAT,
      text: DEFAULTS.DATEFORMAT_TEXT,
    };
    const choice = String(explicit || '')
      .trim()
      .toLowerCase();
    if (choice === 'mdy') return MDY;
    if (choice === 'dmy') return DMY;
    const MDY_COUNTRIES = ['US', 'PH', 'FM', 'MH', 'PW', 'GU', 'AS', 'VI', 'PR', 'UM'];
    try {
      const name = String(countryName || '')
        .trim()
        .toLowerCase();
      if (!name) return DMY;
      const countries =
        JSON.parse(fs.readFileSync(path.join(__dirname, '../json/countries.json'), 'utf8'))
          .countries || [];
      const country = countries.find(
        (c) =>
          String(c.value || '')
            .trim()
            .toLowerCase() === name
      );
      if (country && MDY_COUNTRIES.includes(String(country.sortname).toUpperCase())) return MDY;
    } catch (e) {
      /* unknown stays day-first */
    }
    return DMY;
  }

  /*
   * The shop's own money, not ours: the installer used to open every shop in
   * one hardcoded currency whatever country was chosen. Resolution is now by
   * ISO CODE, not by name. The first fix here matched currency.json entries by
   * country-name prefix, and an audit against the full country list showed 73
   * of 246 countries fell straight through to the fallback - "United Arab
   * Emirates" had no matching entry at all, so a Dubai signup opened in the
   * wrong currency. Now: the country's ISO code (countries.json sortname)
   * looks up its ISO-4217 code in country_currency.json, and currency.json
   * supplies that code's symbol. The old name-prefix match stays as the second
   * attempt so any country missing from the ISO table behaves exactly as
   * before, and no match at all still keeps the EGP default.
   *
   * explicitCode (register_currency) wins over everything: it is the shop
   * owner's own onboarding choice, e.g. a USD-priced shop in the Emirates.
   */
  _currencyForCountry(countryName, explicitCode) {
    const fallback = {
      currency: DEFAULTS.CURRENCY,
      currency_text: DEFAULTS.CURRENCY_TEXT,
      currency_type: DEFAULTS.CURRENCY_TYPE,
      currency_value: [{ currency_text: 'EGP', currency_sign: '$' }],
    };
    const name = String(countryName || '')
      .trim()
      .toLowerCase();
    try {
      const raw = fs.readFileSync(path.join(__dirname, '../json/currency.json'), 'utf8');
      const list = (JSON.parse(raw).currency || []).filter((c) => c && c.value);
      const asResult = (hit) => ({
        currency: hit.symbol,
        currency_text: hit.value.trim(),
        currency_type: hit.symbol,
        currency_value: [{ currency_text: hit.text, currency_sign: hit.symbol }],
      });

      const wanted = String(explicitCode || '')
        .trim()
        .toUpperCase();
      if (wanted) {
        const chosen = list.find((c) => c.text === wanted && c.symbol);
        if (chosen) return asResult(chosen);
      }
      if (!name) return fallback;

      const countries =
        JSON.parse(fs.readFileSync(path.join(__dirname, '../json/countries.json'), 'utf8'))
          .countries || [];
      const country = countries.find(
        (c) =>
          String(c.value || '')
            .trim()
            .toLowerCase() === name
      );
      if (country && country.sortname) {
        const codes = JSON.parse(
          fs.readFileSync(path.join(__dirname, '../json/country_currency.json'), 'utf8')
        );
        const code = codes[String(country.sortname).toUpperCase()];
        const hit = code && list.find((c) => c.text === code && c.symbol);
        if (hit) return asResult(hit);
      }

      const prefixHit = list.find((c) =>
        c.value
          .trim()
          .toLowerCase()
          .startsWith(name + ' ')
      );
      if (!prefixHit || !prefixHit.symbol || !prefixHit.text) return fallback;
      return asResult(prefixHit);
    } catch (e) {
      return fallback;
    }
  }

  async _createBranch(data, licenseId, userId, now, regularBodyPrint, thermalBodyPrint) {
    const money = this._currencyForCountry(data.register_country, data.register_currency);
    const dateFmt = this._dateFormatForCountry(data.register_country, data.register_dateformat);
    const branchData = {
      theme: DEFAULTS.THEME,
      branch_name: data.register_companyname.trim(),
      business_type: storeTypeFromInstall(data),
      store_address: (data.register_address || '').trim(),
      store_email: data.register_useremail.trim(),
      store_telephone: (data.register_fullnumber || '').trim(),
      country: (data.register_country || '').trim(),
      country_id: data.register_countryid || '',
      state: (data.register_state || '').trim(),
      city: (data.register_city || '').trim(),
      pincode: '',
      website: '',
      logo: DEFAULTS.LOGO,
      languge: 'ar',
      currency: money.currency,
      currency_text: money.currency_text,
      currency_type: money.currency_type,
      currency_value: money.currency_value,
      time_zone: (data.register_timezone || '').trim() || 'Africa/Cairo',
      register: [],
      cashdenom_fields: [],
      printing_address: (data.register_address || '').trim(),
      notification_range: DEFAULTS.NOTIFICATION_RANGE,
      discount: '',
      discount_amount: '0',
      discount_percentage: '0.00',
      sales_prefix: DEFAULTS.SALES_PREFIX,
      receiving_prefix: DEFAULTS.RECEIVING_PREFIX,
      enable_notification_reminders: false,
      enable_email_reminders: false,
      roundOff: false,
      stock_management: true,
      stock_management_log: true,
      printall: false,
      keyboard_view: false,
      balance_view: true,
      offlineprocess: true,
      sales_mail: false,
      customer_print: true,
      print_logoimg: false,
      print_sale_notes: false,
      customer_checkbox: true,
      supplier_checkbox: true,
      print_type: DEFAULTS.PRINT_TYPE,
      printing_size: DEFAULTS.PRINTING_SIZE,
      print_character: DEFAULTS.PRINT_CHARACTER,
      header_print: DEFAULTS.HEADER_PRINT,
      footer_print: DEFAULTS.FOOTER_PRINT,
      regular_body_print: regularBodyPrint,
      thermal_body_print: thermalBodyPrint,
      print_controls: {
        receiving_title:
          '<span style="font-size: 14px !important;font-weight: 900;">PURCHASE INVOICE</span>',
        receiving_return_title:
          '<span style="font-size: 14px !important;font-weight: 900;">PURCHASE RETURN INVOICE</span>',
        sale_title:
          '<span style="font-size: 14px !important;font-weight: 900;">SALES RECEIPT</span>',
        sale_return_title:
          '<span style="font-size: 14px !important;font-weight: 900;">SALES RETURN RECEIPT</span>',
        a4: {
          lineitem_price: 'on',
          lineitem_qty: 'on',
          lineitem_disc: 'on',
          lineitem_total: 'on',
          print_qty: 'on',
          print_roundoff: 'on',
        },
      },
      sale_inline_editor: false,
      client_dateformat: dateFmt.client,
      time_format: 'enable',
      server_dateformat: dateFmt.server,
      dateformat_text: dateFmt.text,
      default_customer: '',
      default_supplier: '',
      created_date: now,
      updated_date: now,
      created_by: '',
      created_by_id: '',
      updated_by: '',
      updated_by_id: '',
      // register is set above, identically; the duplicate is removed.
      payment_gateway: [],
      settings: {
        offline: {
          sales_action: true,
          receivings_action: true,
          items_action: true,
          suppliers_action: true,
          customers_action: true,
          users_action: true,
          branches_action: true,
          settings_action: true,
          sales_cache: true,
          receivings_cache: true,
          items_cache: true,
          suppliers_cache: true,
          customers_cache: true,
          users_cache: true,
          branches_cache: true,
          setting_cache: true,
        },
      },
      license: licenseId,
    };

    return await this.repository.insertBranch(branchData);
  }

  async _updateUserBranchAccess(data, userId, licenseId, branchId) {
    const userBranch = [
      {
        branch_id: branchId,
        branch_name: data.register_companyname,
        branch_image: DEFAULTS.LOGO,
      },
    ];

    const printBranch = [
      {
        branch_id: branchId,
        printing_design: DEFAULTS.PRINT_TYPE,
        printing_max_char: DEFAULTS.PRINT_CHARACTER,
        printing_size: DEFAULTS.PRINTING_SIZE,
      },
    ];

    await this.repository.updateUserBranchAccess(userId, licenseId, {
      branch_access: userBranch,
      printing_design: printBranch,
      created_by_id: userId,
      updated_by_id: userId,
    });
  }

  _countrySortName(data) {
    const countriesData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../json/countries.json'), 'utf8')
    );
    const country = countriesData.countries.find((c) => c.value === data.register_country);
    return country ? country.sortname : '';
  }

  async _createDefaultCustomer(data, branchId, userId, licenseId, now, sortname) {
    const customerData = {
      branch_id: branchId,
      branch_name: data.register_companyname.trim(),
      name: WALK_IN_NAME,
      email: '',
      phone: '',
      address: '',
      sortname: sortname,
      country: data.register_country.trim(),
      country_id: data.register_countryid,
      state: data.register_state.trim(),
      city: '',
      date: now,
      partial_balance: false,
      balance: 0.0,
      created_date: now,
      updated_date: now,
      created_by: data.register_username,
      created_by_id: userId,
      updated_by: data.register_username,
      updated_by_id: userId,
      license: licenseId,
    };

    return await this.repository.insertCustomer(customerData);
  }

  async _createDefaultSupplier(data, branchId, userId, licenseId, now, sortname) {
    const supplierData = {
      branch_id: branchId,
      branch_name: data.register_companyname.trim(),
      name: GENERAL_SUPPLIER_NAME,
      email: '',
      phone: '',
      address: '',
      sortname: sortname,
      country: data.register_country.trim(),
      country_id: data.register_countryid,
      state: data.register_state.trim(),
      city: '',
      created_date: now,
      updated_date: now,
      created_by: data.register_username,
      created_by_id: userId,
      updated_by: data.register_username,
      updated_by_id: userId,
      license: licenseId,
    };

    return await this.repository.insertSupplier(supplierData);
  }

  async _createDefaultUnit(data, branchId, userId, licenseId, now) {
    const unitData = {
      branch_id: branchId,
      branch_name: data.register_companyname.trim(),
      name: 'Quantity',
      value: 'qty',
      created_date: now,
      created_by: data.register_username,
      created_by_id: userId,
      updated_date: now,
      updated_by: data.register_username,
      updated_by_id: userId,
      license: licenseId,
    };

    return await this.repository.insertUnit(unitData);
  }

  /*
   * The features a new shop starts with, written down rather than inferred.
   *
   * The client reads `settings[key] !== false`, so an absent key reads as
   * enabled. A brand-new shop therefore needs an explicit decision written
   * for every feature, not a pile of omissions nobody chose. Existing shops
   * keep the old reading so an upgrade cannot silently switch things off.
   */
  static newShopModuleDefaults() {
    return {
      /* The features a shop needs before it has decided anything. */
      module_themes_enable: true,
      quick_sale_enable: false,
      module_recyclebin_enable: false,
      cash_register_enable: false,
      staff_shifts_enable: false,
      staff_roster_enable: false,
    };
  }

  async _updateBranchDefaults(branchId, licenseId, userId, data, customerId, supplierId) {
    await this.repository.updateBranch(branchId, licenseId, {
      default_customer: customerId,
      default_supplier: supplierId,
      ...InstallService.newShopModuleDefaults(),
      created_by: data.register_username,
      created_by_id: userId,
      updated_by: data.register_username,
      updated_by_id: userId,
    });
  }

  async _addBranchEmailFields(branchId, licenseId, data) {
    const emailData = {
      branch_id: branchId,
      email_address: [{ email: data.register_useremail }],
      report_type: 'daily',
      send_mail: 'mail_off',
    };

    await this.repository.addBranchEmailFields(branchId, licenseId, emailData);
  }

  async _setupMongoDBAuth(dbUsername, dbPassword) {
    try {
      console.log('🔐 Starting MongoDB authentication setup...');

      const { MongoClient } = require('mongodb');
      const path = require('path');
      const fs = require('fs');

      const dbName = process.env.DB_NAME || 'PosnicPro';
      let client;
      let adminDb;
      let connected = false;

      // Strategy 1: Try to connect WITH the provided credentials (user already exists)
      const authUri = `mongodb://${dbUsername}:${encodeURIComponent(dbPassword)}@127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}/admin?authSource=admin`;

      try {
        console.log('📡 Strategy 1: Connect with provided credentials...');
        client = new MongoClient(authUri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        adminDb = client.db('admin');
        connected = true;
      } catch (authError) {
        console.log('⚠️ Strategy 1 failed:', authError.message);
      }

      // Strategy 2: If not connected, try unauthenticated (MongoDB without auth)
      if (!connected) {
        try {
          console.log('📡 Strategy 2: Connect without authentication...');
          const unauthUri = `mongodb://127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}`;
          client = new MongoClient(unauthUri, { serverSelectionTimeoutMS: 5000 });
          await client.connect();
          adminDb = client.db('admin');
          // Verify by listing collections (auth check)
          await adminDb.listCollections().toArray();
          connected = true;
        } catch (unauthError) {
          console.log('⚠️ Strategy 2 failed:', unauthError.message);
          if (client) {
            try {
              await client.close();
            } catch (e) {}
          }
        }
      }

      // Strategy 3: If still not connected, try existing credentials from file
      if (!connected) {
        const fs = require('fs');
        const path = require('path');
        const possibleCredFiles = [];

        // Try userData path (for packaged Electron app)
        try {
          const electron = require('electron');
          const electronApp = electron.app || (electron.remote && electron.remote.app);
          if (electronApp) {
            possibleCredFiles.push(
              path.join(electronApp.getPath('userData'), '.mongodb-credentials.json')
            );
          }
        } catch (e) {}

        // Add common locations
        possibleCredFiles.push(path.join(process.cwd(), '.mongodb-credentials.json'));
        possibleCredFiles.push(path.join(process.cwd(), '..', '.mongodb-credentials.json'));

        for (const credFile of possibleCredFiles) {
          if (!fs.existsSync(credFile)) continue;

          try {
            const existingCreds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
            if (!existingCreds.uri) continue;

            console.log('📡 Strategy 3: Connect with existing credentials from:', credFile);
            client = new MongoClient(existingCreds.uri, { serverSelectionTimeoutMS: 5000 });
            await client.connect();
            adminDb = client.db('admin');
            await adminDb.listCollections().toArray();
            connected = true;
            break;
          } catch (e) {
            console.log('⚠️ Failed with credentials from', credFile, ':', e.message);
            if (client) {
              try {
                await client.close();
              } catch (closeErr) {}
            }
          }
        }
      }

      if (!connected) {
        throw new Error(
          'Cannot connect to MongoDB with any credentials. Please reset MongoDB or delete credentials file.'
        );
      }

      // Now create or update the admin user
      try {
        await adminDb.command({
          createUser: dbUsername,
          pwd: dbPassword,
          roles: [
            { role: 'root', db: 'admin' },
            { role: 'dbOwner', db: dbName },
          ],
        });
      } catch (userError) {
        if (userError.message.includes('already exists') || userError.code === 51003) {
          // Update existing user password
          await adminDb.command({
            updateUser: dbUsername,
            pwd: dbPassword,
            roles: [
              { role: 'root', db: 'admin' },
              { role: 'dbOwner', db: dbName },
            ],
          });
          console.log(`📝 Updated MongoDB admin user password: ${dbUsername}`);
        } else {
          throw userError;
        }
      }

      await client.close();

      // Save credentials to .env file
      await this._saveDBCredentialsToEnv(dbUsername, dbPassword);

      // Enable authentication in mongod.cfg (if exists)
      await this._enableMongoDBAuth();

      // Reconnect mongoose with authenticated URI for subsequent operations
      const mongoose = require('mongoose');
      const newUri = `mongodb://${dbUsername}:${encodeURIComponent(dbPassword)}@127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}/PosnicPro?authSource=admin`;

      if (mongoose.connection.readyState !== 0) {
        console.log('🔄 Reconnecting mongoose with authenticated connection...');
        await mongoose.connection.close();
        await mongoose.connect(newUri, {
          maxPoolSize: 10,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 30000,
          connectTimeoutMS: 10000,
        });
      }

      // Also update BaseModel connection (native MongoDB driver)
      const BaseModel = require('../models/base.model');
      if (BaseModel.mongoClient) {
        console.log('🔄 Reconnecting BaseModel with authenticated connection...');
        await BaseModel.mongoClient.close();
        const { MongoClient } = require('mongodb');
        BaseModel.mongoClient = await MongoClient.connect(newUri);
        BaseModel.database = BaseModel.mongoClient.db('PosnicPro');
      }

      return true;
    } catch (error) {
      console.error('❌ Error setting up MongoDB authentication:', error.message);
      // Re-throw error so installation can handle it properly
      throw new Error(`MongoDB authentication setup failed: ${error.message}`, {
        cause: error,
      });
    }
  }

  /**
   * Save database credentials to .env file
   * @param {string} dbUsername - MongoDB admin username
   * @param {string} dbPassword - MongoDB admin password
   * @returns {Promise<boolean>}
   */
  async _saveDBCredentialsToEnv(dbUsername, dbPassword) {
    try {
      const path = require('path');
      const fs = require('fs');

      /*
       * Where the database credentials go, and where they must never go.
       *
       * This searched a list of candidates that began with process.cwd(), and
       * accepted the first whose directory existed - which the current
       * directory always does. So the credentials landed wherever the
       * application happened to be launched from. On Windows that is usually
       * the install folder and nobody noticed; on Linux a shop starting it
       * from a terminal got
       *
       *   /home/sridhar/Downloads/.env
       *   /home/sridhar/Downloads/.mongodb-credentials.json
       *
       * next to the installer they had just downloaded. A folder people share,
       * sync and hand around, holding the credentials to their own database.
       *
       * The user data directory is the only correct answer: it is per-user,
       * outside anything synced by accident, and it is already where the
       * database, the backups and the update config live. The old candidates
       * are kept only as a fallback for running outside Electron - the API
       * suite does that - and cwd is no longer among them.
       */
      let envPath = null;
      try {
        const electron = require('electron');
        const electronApp = electron.app || (electron.remote && electron.remote.app);
        if (electronApp) envPath = path.join(electronApp.getPath('userData'), '.env');
      } catch (e) {
        /* Not running inside Electron - fall through. */
      }

      if (!envPath) {
        /* Beside the API itself, which is inside the installation rather than
           wherever a terminal happened to be pointing. */
        envPath = path.join(__dirname, '../../.env');
      }

      console.log('📝 Saving credentials to:', envPath);

      let envContent = '';

      // Read existing .env if it exists
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        // Remove old DB credentials
        envContent = envContent
          .split('\n')
          .filter((line) => !line.startsWith('MONGODB_URI=') && !line.startsWith('MONGODB_USER='))
          .join('\n');
      }

      /*
       * The password does not go in here.
       *
       * This used to write the whole connection string, password included, into
       * a plain .env alongside the encrypted credentials file - which would have
       * made encrypting the other copy pointless. A secret written twice is only
       * as protected as its weakest copy.
       *
       * What stays is the username and a credential-free URI, so anything
       * reading .env still learns the host, port and database. The password
       * comes from .mongodb-credentials.json through credentials-store, and
       * server.js assigns the real URI to process.env.MONGODB_URI at startup -
       * after dotenv has run, so the assignment wins.
       */
      const host = `127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}`;

      /* The real one. Needed in memory - the running session connects with it,
         and credentials-store keeps its host, port and database while dropping
         the password - but never written to .env. */
      const newUri = `mongodb://${dbUsername}:${encodeURIComponent(dbPassword)}@${host}/PosnicPro?authSource=admin`;

      /* What .env gets: everything except the credentials. */
      const publicUri = `mongodb://${host}/PosnicPro?authSource=admin`;

      envContent += `\n# MongoDB connection (auto-generated during installation)\n`;
      envContent += `# The password is NOT stored here. It lives encrypted in\n`;
      envContent += `# .mongodb-credentials.json and is read at startup.\n`;
      envContent += `MONGODB_URI=${publicUri}\n`;
      envContent += `MONGODB_USER=${dbUsername}\n`;

      fs.writeFileSync(envPath, envContent.trim());

      // Also save to a credentials file for the Electron app to read
      // In packaged Electron app, save to userData folder (writable)
      const credentials = {
        username: dbUsername,
        password: dbPassword,
        uri: newUri,
        created: new Date().toISOString(),
      };

      const savePaths = [];

      // Try to get Electron userData path (preferred for packaged builds)
      try {
        const electron = require('electron');
        const electronApp = electron.app || (electron.remote && electron.remote.app);
        if (electronApp) {
          const userDataPath = electronApp.getPath('userData');
          savePaths.push(path.join(userDataPath, '.mongodb-credentials.json'));
        }
      } catch (e) {
        // Electron not available - running standalone
      }

      // Fallback to envPath directory
      savePaths.push(path.join(path.dirname(envPath), '.mongodb-credentials.json'));

      /*
       * Written through credentials-store, which encrypts the password with a
       * per-install key and leaves the username readable. This used to write
       * the password, and a connection string containing it, as plain text -
       * so `type` showed it and any copy of the folder carried it.
       *
       * The store ships beside the api (resources/ when packaged, src/ in a
       * checkout) because setup-mongodb.js and main.js read it too, and nine
       * call sites each doing their own JSON.parse is how a migration goes
       * wrong in one of them.
       */
      try {
        let store;
        try {
          /* packaged: resources/api/... up to resources/credentials-store.js */
          store = require(path.join(__dirname, '..', '..', '..', 'credentials-store'));
        } catch (resolveErr) {
          /* dev checkout: the desktop shell lives in src/ beside api/ */
          store = require(path.join(__dirname, '..', '..', '..', 'src', 'credentials-store'));
        }
        const keyDir = path.dirname(savePaths[0]);
        const written = store.write(savePaths, credentials, keyDir);
        for (const file of written) console.log('✅ Credentials saved (encrypted) to:', file);
        if (written.length === 0) {
          throw new Error('no credential path was writable');
        }
      } catch (storeErr) {
        /*
         * Falling back to plain text is the wrong trade only if it is silent.
         * A till that cannot save its database password cannot start next
         * time, which is worse than a password on disk that this build already
         * wrote in the clear yesterday. It is loud, and the next successful
         * save encrypts it.
         */
        console.warn('⚠️ Could not save encrypted credentials:', storeErr.message);
        console.warn('⚠️ Falling back to plain text - this will be re-encrypted on the next save');
        for (const credPath of savePaths) {
          try {
            const credDir = path.dirname(credPath);
            if (!fs.existsSync(credDir)) {
              fs.mkdirSync(credDir, { recursive: true });
            }
            fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));
          } catch (writeErr) {
            console.warn('⚠️ Could not write to:', credPath, writeErr.message);
          }
        }
      }

      // Update process.env for current session
      process.env.MONGODB_URI = newUri;
      process.env.MONGODB_USER = dbUsername;

      return true;
    } catch (error) {
      console.error('❌ Error saving credentials:', error.message);
      return false;
    }
  }

  /**
   * Enable authentication in MongoDB config file
   * @returns {Promise<boolean>}
   */
  async _enableMongoDBAuth() {
    try {
      const fs = require('fs');
      const path = require('path');

      // Common MongoDB config file locations
      const possibleConfigPaths = [
        'D:\\installer\\mongodb\\mongod.cfg',
        'C:\\Program Files\\MongoDB\\Server\\mongod.cfg',
        path.join(process.cwd(), 'mongodb', 'mongod.cfg'),
        '/etc/mongod.conf',
        '/usr/local/etc/mongod.conf',
      ];

      let configPath = null;
      for (const p of possibleConfigPaths) {
        if (fs.existsSync(p)) {
          configPath = p;
          break;
        }
      }

      if (!configPath) {
        console.log('⚠️ MongoDB config file not found. Skipping config update.');
        return false;
      }

      console.log('📝 Updating MongoDB config:', configPath);

      let config = fs.readFileSync(configPath, 'utf8');

      // Check if authorization is already enabled
      if (config.includes('authorization: enabled')) {
        return true;
      }

      // Add authorization section
      if (config.includes('security:')) {
        // Update existing security section
        config = config.replace(/security:\s*\n/, 'security:\n  authorization: enabled\n');
      } else {
        // Add new security section
        config += '\n# Security settings - Added by Posnic installation\n';
        config += 'security:\n';
        config += '  authorization: enabled\n';
      }

      fs.writeFileSync(configPath, config);

      return true;
    } catch (error) {
      console.error('❌ Error enabling MongoDB auth in config:', error.message);
      return false;
    }
  }
}

module.exports = InstallService;
