const { searchPattern } = require('../utils/safe-search');
const BaseModel = require('./base.model');
const { ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { secretUpdate } = require('../services/settings-groups');
const { recordAudit } = require('../utils/audit-trail');
const { publicPageUrl } = require('../utils/public-url');
const {
  WALK_IN_NAME,
  GENERAL_SUPPLIER_NAME,
  WALK_IN_PATTERN,
  GENERAL_SUPPLIER_PATTERN,
} = require('../utils/default-parties');

class SettingModel extends BaseModel {
  constructor() {
    super('branches');
    this.denomCollection = 'denomination';
    this.backupCollection = 'recycle_bin';
    // Collection that stores unit definitions (mirrors PHP self::$unitCollection)
    this.unitCollection = 'unit';
    this.branchId = null;
    this.licenseId = null;
    this.user = null;
  }

  setContext({ branchId = null, licenseId = null, user = null, ip = null, userAgent = null } = {}) {
    this.branchId = branchId;
    this.licenseId = licenseId;
    this.user = user;
    /* Where the request came from. Only the audit trail uses these, and only
       for the handful of events where "from where" is the whole question. */
    this.ip = ip;
    this.userAgent = userAgent;
    this.branchName = null; // Will be loaded lazily when needed
  }

  async getBranchName() {
    if (this.branchName) return this.branchName;
    if (!this.branchId) return '';

    try {
      const branchCollection = await this.getCollection('branches');
      const branch = await branchCollection.findOne(
        { _id: this.normalizeId(this.branchId) },
        { projection: { branch_name: 1 } }
      );
      this.branchName = branch?.branch_name || '';
      return this.branchName;
    } catch (error) {
      console.error('Error fetching branch name:', error);
      return '';
    }
  }

  normalizeId(value) {
    if (!value) return value;
    try {
      return new ObjectId(value);
    } catch (err) {
      return value;
    }
  }

  buildFilter(extra = {}) {
    const filter = { ...extra };
    if (this.branchId) {
      filter.branch_id = this.normalizeId(this.branchId);
    }
    if (this.licenseId) {
      filter.license = this.normalizeId(this.licenseId);
    }
    return filter;
  }

  async getDefaultCustomer(customerId) {
    try {
      /*
       * Self-heal (owner ask): a branch without a configured default
       * customer sells to Walk-In. Asked with no id, find - or create -
       * this branch's Walk-in and repoint the branch doc, instead of
       * failing every till on that branch with "Customer ID is required".
       */
      if (!customerId && this.branchId) {
        const customersHeal = await this.getCollection('customers');
        const healLicense = this.licenseId ? { license: this.normalizeId(this.licenseId) } : {};
        const branchIdNorm = this.normalizeId(this.branchId);
        let walkin = await customersHeal.findOne({
          branch_id: branchIdNorm,
          name: { $regex: WALK_IN_PATTERN },
          ...healLicense,
        });
        if (!walkin) {
          const now = new Date();
          const seed = {
            branch_id: branchIdNorm,
            name: WALK_IN_NAME,
            date: now,
            phone: '',
            // No email key: customers carries a unique sparse index on it.
            address: '',
            sortname: '',
            country: '',
            state: '',
            city: '',
            created_date: now,
            updated_date: now,
          };
          if (this.licenseId) seed.license = this.normalizeId(this.licenseId);
          const ins = await customersHeal.insertOne(seed);
          walkin = { ...seed, _id: ins.insertedId };
        }
        try {
          const branches = await this.getCollection('branches');
          await branches.updateOne(
            { _id: branchIdNorm },
            { $set: { default_customer: walkin._id } }
          );
        } catch (e) {
          /* pointer update is best-effort - the lookup below still answers */
        }
        customerId = walkin._id;
      }

      if (!customerId) {
        return {
          status: false,
          data: null,
          message: 'Customer ID is required',
        };
      }

      const customersCollection = await this.getCollection('customers');
      const licenseFilter = this.licenseId ? { license: this.normalizeId(this.licenseId) } : {};

      const customer = await customersCollection.findOne({
        _id: this.normalizeId(customerId),
        ...licenseFilter,
      });

      if (!customer) {
        return {
          status: false,
          data: null,
          message: 'Customer not found',
        };
      }

      const defaultCustomer = {
        customer_id: customer._id?.toString?.() || customer._id,
        customer_name: customer.name || '',
        customer_address: customer.address || '',
        customer_phone: customer.phone || '',
        customer_email: customer.email || '',
        customer_state: customer.state || '',
        customer_country: customer.country || '',
        customer_partial: customer.partial_balance ?? false,
        customer_balance: customer.balance ?? 0.0,
      };

      return {
        status: true,
        data: {
          customer_id: customer._id?.toString?.() || customer._id,
          customer_name: customer.name || '',
          customer: defaultCustomer,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getDefaultCustomer:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  /**
   * PHP: getDefaultSupplierModel()
   * Get default supplier details by ID
   */
  async getDefaultSupplier(supplierId) {
    /*
     * Heal like the customer: with a branch context a missing id resolves
     * to the branch's General Supplier - found or created, branch doc
     * repointed. Contextless still refuses below.
     */
    if (!supplierId && this.branchId) {
      try {
        const suppliers = await this.getCollection('suppliers');
        const healLicense = this.licenseId ? { license: this.normalizeId(this.licenseId) } : {};
        const branchIdNorm = this.normalizeId(this.branchId);
        let general = await suppliers.findOne({
          branch_id: branchIdNorm,
          name: { $regex: GENERAL_SUPPLIER_PATTERN },
          ...healLicense,
        });
        if (!general) {
          const now = new Date();
          const seed = {
            branch_id: branchIdNorm,
            name: GENERAL_SUPPLIER_NAME,
            email: `anonymous-supplier-${branchIdNorm}@posnic.local`,
            phone: '',
            address: '',
            sortname: '',
            country: '',
            state: '',
            city: '',
            created_date: now,
            updated_date: now,
          };
          if (this.licenseId) seed.license = this.normalizeId(this.licenseId);
          const ins = await suppliers.insertOne(seed);
          general = { ...seed, _id: ins.insertedId };
        }
        try {
          const branches = await this.getCollection('branches');
          await branches.updateOne(
            { _id: branchIdNorm, ...healLicense },
            { $set: { default_supplier: general._id, updated_date: new Date() } }
          );
        } catch (e) {
          /* best-effort pointer */
        }
        supplierId = general._id;
      } catch (e) {
        /* fall through to the plain refusal below */
      }
    }

    if (!supplierId) {
      return {
        status: false,
        data: null,
        message: 'Supplier ID is required',
      };
    }

    try {
      const suppliersCollection = await this.getCollection('suppliers');
      const licenseFilter = this.licenseId ? { license: this.normalizeId(this.licenseId) } : {};

      const supplier = await suppliersCollection.findOne({
        _id: this.normalizeId(supplierId),
        ...licenseFilter,
      });

      if (!supplier) {
        // Repair only this branch's saved default, never an arbitrary requested
        // supplier or a foreign tenant's record. Reuse the normal default path.
        if (this.branchId && this.licenseId) {
          const branches = await this.getCollection('branches');
          const branch = await branches.findOne({
            _id: this.normalizeId(this.branchId),
            ...licenseFilter,
          });
          if (branch?.default_supplier && String(branch.default_supplier) === String(supplierId)) {
            return this.getDefaultSupplier(null);
          }
        }
        return {
          status: false,
          data: null,
          message: 'Supplier not found',
        };
      }

      const defaultSupplier = {
        supplier_id: supplier._id?.toString?.() || supplier._id,
        supplier_name: supplier.name || '',
        supplier_address: supplier.address || '',
        supplier_phone: supplier.phone || '',
        supplier_email: supplier.email || '',
        supplier_state: supplier.state || '',
      };

      return {
        status: true,
        data: {
          supplier_id: supplier._id?.toString?.() || supplier._id,
          supplier_name: supplier.name || '',
          supplier: defaultSupplier,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getDefaultSupplier:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getDefaultCustomerSupplier(customerId, supplierId) {
    /*
     * Branch switch lands here with whatever the previous branch left in
     * localStorage - possibly nothing. With a branch context BOTH defaults
     * self-heal: the customer through the Walk-in heal, the supplier below.
     */
    if (!customerId && this.branchId) {
      const healed = await this.getDefaultCustomer('');
      if (healed.status && healed.data && healed.data.customer_id) {
        customerId = healed.data.customer_id;
      }
    }
    if ((!customerId || !supplierId) && !this.branchId) {
      return {
        status: false,
        data: null,
        message: 'Customer and supplier ids are required',
      };
    }
    // (supplier may be empty - with a branch context it self-heals below)

    try {
      const [customersCollection, suppliersCollection] = await Promise.all([
        this.getCollection('customers'),
        this.getCollection('suppliers'),
      ]);

      /*
       * Self-heal on branch switch (owner report): a branch without a
       * default supplier gets its General Supplier found or created and
       * the branch doc repointed - same medicine as the Walk-in customer.
       */
      if (!supplierId && this.branchId) {
        const healLicense = this.licenseId ? { license: this.normalizeId(this.licenseId) } : {};
        const branchIdNorm = this.normalizeId(this.branchId);
        let general = await suppliersCollection.findOne({
          branch_id: branchIdNorm,
          name: { $regex: GENERAL_SUPPLIER_PATTERN },
          ...healLicense,
        });
        if (!general) {
          const now = new Date();
          const seed = {
            branch_id: branchIdNorm,
            name: GENERAL_SUPPLIER_NAME,
            // suppliers carries a unique index on email - unique per branch.
            email: `anonymous-supplier-${branchIdNorm}@posnic.local`,
            phone: '',
            address: '',
            sortname: '',
            country: '',
            state: '',
            city: '',
            created_date: now,
            updated_date: now,
          };
          if (this.licenseId) seed.license = this.normalizeId(this.licenseId);
          const ins = await suppliersCollection.insertOne(seed);
          general = { ...seed, _id: ins.insertedId };
        }
        try {
          const branches = await this.getCollection('branches');
          await branches.updateOne(
            { _id: branchIdNorm },
            { $set: { default_supplier: general._id } }
          );
        } catch (e) {
          /* pointer update is best-effort */
        }
        supplierId = general._id;
      }

      const licenseFilter = this.licenseId ? { license: this.normalizeId(this.licenseId) } : {};

      const [customer, supplier] = await Promise.all([
        customersCollection.findOne({
          _id: this.normalizeId(customerId),
          ...licenseFilter,
        }),
        suppliersCollection.findOne({
          _id: this.normalizeId(supplierId),
          ...licenseFilter,
        }),
      ]);

      if (!customer || !supplier) {
        return {
          status: false,
          data: null,
          message: 'Not found',
        };
      }

      const defaultCustomer = {
        customer_id: customer._id?.toString?.() || customer._id,
        customer_name: customer.name || '',
        customer_address: customer.address || '',
        customer_phone: customer.phone || '',
        customer_email: customer.email || '',
        customer_state: customer.state || '',
      };

      const defaultSupplier = {
        supplier_id: supplier._id?.toString?.() || supplier._id,
        supplier_name: supplier.name || '',
        supplier_address: supplier.address || '',
        supplier_phone: supplier.phone || '',
        supplier_email: supplier.email || '',
        supplier_state: supplier.state || '',
      };

      return {
        status: true,
        data: {
          customer_id: defaultCustomer.customer_id,
          customer_name: defaultCustomer.customer_name,
          supplier_id: defaultSupplier.supplier_id,
          supplier_name: defaultSupplier.supplier_name,
          customer: defaultCustomer,
          supplier: defaultSupplier,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getDefaultCustomerSupplier:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  /**
   * PHP: getThemeSettings()
   * Fetch theme/appearance settings for the current branch & license.
   * Returns: { status: boolean, data: { theme_settings }, message }
   */
  async getThemeSettings() {
    try {
      const collection = await this.getCollection();

      const branchId = this.normalizeId(this.branchId);
      const licenseId = this.normalizeId(this.licenseId);

      if (!branchId || !licenseId) {
        return {
          status: false,
          data: null,
          message: 'Branch and license context required',
        };
      }

      const setting = await collection.findOne(
        { _id: branchId, license: licenseId },
        { projection: { theme_settings: 1 } }
      );

      if (setting && setting.theme_settings) {
        return {
          status: true,
          data: { theme_settings: setting.theme_settings },
          message: 'Theme settings retrieved',
        };
      }

      return {
        status: false,
        data: null,
        message: 'No theme settings found',
      };
    } catch (error) {
      console.error('Error in getThemeSettings:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getBackupTable(params = {}, options = {}) {
    try {
      const collection = await this.getCollection(this.backupCollection);
      const limit =
        Number.isFinite(parseInt(options.limit, 10)) && parseInt(options.limit, 10) > 0
          ? parseInt(options.limit, 10)
          : 5;
      const page =
        Number.isFinite(parseInt(options.page, 10)) && parseInt(options.page, 10) > 0
          ? parseInt(options.page, 10)
          : 1;

      const branchIds = Array.isArray(params.branchIds) ? params.branchIds : [];
      const branchObjectIds = branchIds
        .map((id) => {
          try {
            return new ObjectId(id);
          } catch (error) {
            return null;
          }
        })
        .filter(Boolean);

      const timeZone = this.user?.settings?.time_zone || this.timeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(
        params.startingDate ||
          params.starting_date ||
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        timeZone
      );
      const toTimestamp = BaseModel.endingDate(
        params.endingDate || params.ending_date || new Date(),
        timeZone
      );

      const dateFilter = {
        document_backup_date: {
          $gte: new Date(fromTimestamp || 0),
          $lte: new Date(toTimestamp || Date.now()),
        },
      };

      // Sync-only deletion markers have no recoverable document body.
      const andConditions = [
        dateFilter,
        { document_name: params.table },
        { body_discarded: { $ne: true } },
      ];

      if (params.table === 'items' && branchObjectIds.length) {
        // Items may have branch_access array
        andConditions.push({
          'branch_access.branch_id': { $in: branchObjectIds },
        });
      } else if (params.table === 'branches') {
        // no branch filter for branches table
      } else if (branchObjectIds.length) {
        // All other tables including users use branch_id field
        // Users backup stores branch_id from current session, not branch_access array
        andConditions.push({
          branch_id: { $in: branchObjectIds },
        });
      }

      if (this.licenseId) {
        // Ensure license is ObjectId
        andConditions.push({
          license: this.normalizeId(this.licenseId),
        });
      }

      // Only add field filter if both selectField and inputField have values
      if (params.selectField && params.inputField && params.inputField.trim()) {
        andConditions.push({
          [params.selectField]: params.inputField.trim(),
        });
      }

      const filter = andConditions.length > 1 ? { $and: andConditions } : andConditions[0] || {};

      console.log('🗄️ getBackupTable - Input params:', {
        table: params.table,
        branchIds: params.branchIds,
        selectField: params.selectField,
        inputField: params.inputField,
        startingDate: params.startingDate,
        endingDate: params.endingDate,
      });
      console.log(
        '🗄️ getBackupTable - branchObjectIds type check:',
        branchObjectIds.map((id) => ({ value: id.toString(), isObjectId: id instanceof ObjectId }))
      );
      console.log('🗄️ getBackupTable - license type:', {
        value: this.licenseId?.toString(),
        isObjectId: this.normalizeId(this.licenseId) instanceof ObjectId,
      });
      console.log('🗄️ getBackupTable - andConditions:', JSON.stringify(andConditions, null, 2));
      console.log('🗄️ getBackupTable - Final Filter:', JSON.stringify(filter, null, 2));
      console.log('🗄️ getBackupTable - Collection:', this.backupCollection);

      // Debug: Check what users backups exist in recycle_bin
      if (params.table === 'users') {
        const testDocs = await collection.find({ document_name: 'users' }).limit(3).toArray();
      }

      const cursor = await collection.find(filter, {
        sort: { document_backup_date: -1, _id: -1 },
        skip: (page - 1) * limit,
        limit,
      });
      const list = await cursor.toArray();
      const total = await collection.countDocuments(filter);

      console.log('🗄️ getBackupTable - Query result:', {
        total,
        listCount: list.length,
        page,
        limit,
        skip: (page - 1) * limit,
        sampleDoc: list[0]
          ? {
              _id: list[0]._id,
              document_name: list[0].document_name,
              branch_id: list[0].branch_id?.toString(),
              has_branch_access: !!list[0].branch_access,
            }
          : null,
      });

      return {
        status: true,
        data: {
          total,
          current_page: page,
          total_pages: Math.ceil(total / limit),
          per_page: limit,
          list: list.map((item) => BaseModel.simplifyFields(item)),
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in SettingModel.getBackupTable:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  /**
   * Update general settings for the branch
   * @param {Object} data - Settings data
   * @returns {Promise<Object>} - Result of the operation
   */
  async editGeneralSetting(data) {
    try {
      const collection = await this.getCollection();
      const currency_type = [
        {
          currency_text: data.currencyTextname?.trim() || '',
          currency_sign: data.currencyText?.trim() || '$',
        },
      ];

      let sortname = '';
      try {
        const countriesJsonPath = path.join(
          __dirname,
          '..',
          '..',
          '..',
          'api',
          'src',
          'json',
          'countries.json'
        );
        const countriesData = JSON.parse(fs.readFileSync(countriesJsonPath, 'utf8'));
        const country = data.setting_country;
        const countryMatch = countriesData.countries?.find((c) => c.value === country);
        if (countryMatch?.sortname) {
          sortname = countryMatch.sortname;
        }
      } catch (err) {
        console.warn('Could not load countries.json for sortname lookup:', err.message);
      }

      const hardware_weight_machine_enable =
        data.hardware_weight_machine_enable === 'true' ||
        data.hardware_weight_machine_enable === true;

      /*
       * The PIN lock is a shop-wide decision, so it is stored on the branch
       * rather than per machine: a shop that wants its tills locked wants all
       * of them locked, and one till opting out would be the one left open.
       *
       * Off unless a shop turns it on. An update should never start demanding
       * a PIN nobody has been given.
       */
      const till_lock_enable = data.till_lock_enable === 'true' || data.till_lock_enable === true;

      // 0 means "only when asked" - no idle locking. Capped so a typo cannot
      // set a lock four hours away and quietly disable the thing.
      let till_lock_idle_minutes = parseInt(data.till_lock_idle_minutes, 10);
      if (isNaN(till_lock_idle_minutes) || till_lock_idle_minutes < 0) {
        till_lock_idle_minutes = 0;
      }
      till_lock_idle_minutes = Math.min(till_lock_idle_minutes, 120);

      /*
       * Staff clock-in / attendance. On unless the shop turns it off - the
       * shift system shipped live, so an update (or an old client that does
       * not send the field) must not take the clock button away from shops
       * already using it. Only an explicit 'false' disables it.
       */
      const staff_shifts_enable = !(
        data.staff_shifts_enable === 'false' || data.staff_shifts_enable === false
      );

      // Tips at clock-out: hospitality-only, so OFF unless the shop turns it
      // on. The roster is generally useful, so it follows the shifts pattern:
      // on unless explicitly disabled.
      const staff_tips_enable =
        data.staff_tips_enable === 'true' || data.staff_tips_enable === true;
      const staff_roster_enable = !(
        data.staff_roster_enable === 'false' || data.staff_roster_enable === false
      );

      /*
       * Cash register sessions. On unless the shop turns it off - registers
       * shipped live, so shops using them must feel nothing. Off means the
       * whole register apparatus steps aside: no selection at login, no gate
       * before a sale, no register menu. Selling must never be blocked by a
       * module the shop does not use.
       */
      const cash_register_enable = !(
        data.cash_register_enable === 'false' || data.cash_register_enable === false
      );

      /*
       * Module On/Off switches. Most default ON (only an explicit 'false'
       * disables) because those surfaces shipped live and visible - an update
       * must never hide a section a shop already uses. Quick Sale is the
       * deliberate exception: it never shipped as part of the till's core, so
       * it is opt-in and an absent value means OFF. Off hides menus and
       * sections; it never touches data.
       */
      const offOnly = (v) => !(v === 'false' || v === false);
      const onOnly = (v) => v === 'true' || v === true;
      const module_recyclebin_enable = offOnly(data.module_recyclebin_enable);
      const module_themes_enable = offOnly(data.module_themes_enable);
      const quick_sale_enable = onOnly(data.quick_sale_enable);

      /*
       * Two different forms save through here now: the Module On/Off tab
       * (sends every toggle) and the merged Branch edit page (sends none of
       * them). A toggle key ABSENT from the payload must be left untouched -
       * writing its parse default instead silently reset Tips/PIN-lock every
       * time the shop saved its address (a live bug the presence gate fixes).
       */
      const ifSent = (key, value) => (data[key] !== undefined ? { [key]: value } : {});

      /*
       * The branch being edited. The merged Branch edit page names a target
       * (any branch of THIS license - the license filter stays in the query);
       * absent, the session branch, exactly as before.
       */
      const targetBranchId =
        data.target_branch_id && /^[0-9a-fA-F]{24}$/.test(String(data.target_branch_id))
          ? data.target_branch_id
          : this.branchId;

      /* Registers, when the branch edit sends them. A register that already
         exists KEEPS its register_id (matched by name) - regenerating ids
         orphans user links and historical sessions. */
      let registerUpdate = {};
      if (Array.isArray(data.register)) {
        const existingDoc = await collection.findOne(
          { _id: this.normalizeId(targetBranchId), license: this.normalizeId(this.licenseId) },
          { projection: { register: 1 } }
        );
        const existingByName = new Map(
          ((existingDoc && existingDoc.register) || [])
            .filter((r) => r && r.register_name)
            .map((r) => [String(r.register_name).trim(), r.register_id])
        );
        const registers = [];
        data.register.forEach((regName) => {
          if (regName && String(regName).trim()) {
            const name = String(regName).trim();
            registers.push({
              register_id: existingByName.get(name) || new ObjectId(),
              register_name: name,
            });
          }
        });
        registerUpdate = { register: registers };
      }

      // Strip GMT offset from timezone (e.g., "Pacific/Niue (GMT-11:00)" -> "Pacific/Niue")
      let cleanTimezone = data.time_zone?.trim() || 'Africa/Cairo';
      const gmtOffsetMatch = cleanTimezone.match(/^([^(]+)\s*\(GMT[^)]+\)$/);
      if (gmtOffsetMatch) {
        cleanTimezone = gmtOffsetMatch[1].trim();
      }

      const updateData = {
        branch_name: data.store_name?.trim() || '',
        store_address: data.store_address?.trim() || '',
        store_email: data.store_email?.trim() || '',
        store_telephone: data.store_telephone?.trim() || '',
        store_alternativephone: data.store_alternativephone?.trim() || '',
        client_dateformat: data.storedate || 'yyyy/mm/dd',
        server_dateformat: data.serverdate || 'Y/m/d',
        dateformat_text: data.dateText || '2018/01/01 -- yyyy/mm/dd',
        time_format: 'enable',
        city: data.city?.trim() || '',
        pincode: data.pincode?.trim() || '',
        website: data.website?.trim() || '',
        sortname: sortname,
        country: data.setting_country?.trim() || '',
        country_id: data.country_id?.trim() || '',
        state: data.setting_state?.trim() || '',
        currency: data.currencyText?.trim() || '$',
        currency_text: data.currency_setting?.trim() || 'جنية / EGP or $',
        currency_type: data.currency_type?.trim() || '$',
        currency_value: currency_type,
        time_zone: cleanTimezone,
        printing_address: data.printing_address?.trim() || '',
        ...ifSent('hardware_weight_machine_enable', hardware_weight_machine_enable),
        ...ifSent('till_lock_enable', till_lock_enable),
        ...ifSent('till_lock_idle_minutes', till_lock_idle_minutes),
        ...ifSent('staff_shifts_enable', staff_shifts_enable),
        ...ifSent('staff_tips_enable', staff_tips_enable),
        ...ifSent('staff_roster_enable', staff_roster_enable),
        ...ifSent('cash_register_enable', cash_register_enable),
        ...ifSent('module_recyclebin_enable', module_recyclebin_enable),
        ...ifSent('module_themes_enable', module_themes_enable),
        ...ifSent('allow_sale_date_edit', data.allow_sale_date_edit === 'false' ? 'false' : 'true'),
        ...registerUpdate,
      };

      // License filter stays: a target outside this license matches nothing.
      const filter = {
        _id: this.normalizeId(targetBranchId),
        license: this.normalizeId(this.licenseId),
      };

      /*
       * STAMP IT, OR THE TILL NEVER LEARNS.
       *
       * These settings live on the branch document, and `branches` is a synced
       * collection at global scope - "tenant-wide data every device needs". But
       * the sync gateway only offers a device rows whose updated_date has
       * moved:
       *
       *     { updated_date: { $gt: since.ts } }
       *     { $expr: { $gt: ['$updated_date', '$_syncMeta.at'] } }
       *
       * and this write goes through the NATIVE driver, so the schema's
       * `timestamps: { updatedAt: 'updated_date' }` never fires. Nothing else
       * here set it either.
       *
       * The result was a shop whose branch document still carried its creation
       * date ten months later. Every settings change it had ever made was
       * correct in the cloud, correct on the web, and invisible to its till -
       * the address on its printed bills, the bill-print switches, all of it.
       * Nothing reported a failure because nothing had failed; the row was
       * simply never eligible to travel.
       */
      updateData.updated_date = new Date();
      const updateResult = await collection.updateOne(filter, { $set: updateData });

      // Check if no document was matched
      if (updateResult.matchedCount === 0) {
        console.error('No branch document matched the filter:', filter);
        return {
          status: false,
          data: null,
          message: 'Branch not found or license mismatch',
        };
      }

      const country_state = {
        country: data.setting_country || '',
        state: data.setting_state || '',
        serverdate: data.serverdate || 'Y/m/d',
        clientdate: data.storedate || 'yyyy/mm/dd',
        time_zone: cleanTimezone,
        time_format: 'enable',
        branch_name: data.store_name?.trim() || '',
        store_address: data.store_address?.trim() || '',
        store_email: data.store_email?.trim() || '',
        store_telephone: data.store_telephone?.trim() || '',
        branch_image: this.user?.branch_image || 'store.png',
        printing_address: data.printing_address?.trim() || '',
        store_alternativephone: data.store_alternativephone?.trim() || '',
        country_id: data.country_id?.trim() || '',
        hardware_weight_machine_enable: hardware_weight_machine_enable,
        till_lock_enable: till_lock_enable,
        till_lock_idle_minutes: till_lock_idle_minutes,
        staff_shifts_enable: staff_shifts_enable,
        staff_tips_enable: staff_tips_enable,
        staff_roster_enable: staff_roster_enable,
        cash_register_enable: cash_register_enable,
        module_recyclebin_enable: module_recyclebin_enable,
        module_themes_enable: module_themes_enable,
        quick_sale_enable: quick_sale_enable,
        ...(data.custom_charges_enable !== undefined
          ? {
              custom_charges_enable:
                data.custom_charges_enable === true || data.custom_charges_enable === 'true',
            }
          : {}),
      };

      // Update branch_name across all collections - for the branch actually
      // edited, which is no longer always the session branch.
      const branchDetails = {
        id: String(targetBranchId),
        branch_name: data.store_name?.trim() || '',
      };

      try {
        await this.updateBranchNameInCollections(branchDetails);
      } catch (updateError) {
        console.error('Error updating branch name in collections:', updateError);
        // Non-fatal: continue even if cross-collection updates fail
      }

      return {
        status: true,
        data: country_state,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in editGeneralSetting:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async updateStarterLocale(data = {}) {
    try {
      if (!this.branchId || !this.licenseId) {
        throw new Error('Branch context is required');
      }

      const collection = await this.getCollection();
      const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
      const currencySymbol = text(data.currencyText || data.currency_type) || '$';
      const currencyName = text(data.currencyTextname || data.currency_setting) || currencySymbol;
      const currencyValue = [
        {
          currency_text: currencyName,
          currency_sign: currencySymbol,
        },
      ];

      let sortname = '';
      try {
        const countriesJsonPath = path.join(
          __dirname,
          '..',
          '..',
          '..',
          'api',
          'src',
          'json',
          'countries.json'
        );
        const countriesData = JSON.parse(fs.readFileSync(countriesJsonPath, 'utf8'));
        const countryMatch = countriesData.countries?.find(
          (c) => c.value === text(data.setting_country)
        );
        if (countryMatch?.sortname) {
          sortname = countryMatch.sortname;
        }
      } catch (err) {
        console.warn(
          'Could not load countries.json for starter locale sortname lookup:',
          err.message
        );
      }

      let cleanTimezone = text(data.time_zone) || 'Africa/Cairo';
      const gmtOffsetMatch = cleanTimezone.match(/^([^(]+)\s*\(GMT[^)]+\)$/);
      if (gmtOffsetMatch) {
        cleanTimezone = gmtOffsetMatch[1].trim();
      }

      const updateData = {
        country: text(data.setting_country),
        country_id: text(data.country_id),
        state: text(data.setting_state),
        sortname,
        currency: currencySymbol,
        currency_text: text(data.currency_setting) || currencyName,
        currency_type: currencySymbol,
        currency_value: currencyValue,
        time_zone: cleanTimezone,
        client_dateformat: text(data.storedate) || 'dd/mm/yyyy',
        server_dateformat: text(data.serverdate) || 'd/m/Y',
        dateformat_text: text(data.dateText) || '01/01/2018 - dd/mm/yyyy',
      };

      const filter = {
        _id: this.normalizeId(this.branchId),
        license: this.normalizeId(this.licenseId),
      };
      /*
       * STAMP IT, OR THE TILL NEVER LEARNS.
       *
       * These settings live on the branch document, and `branches` is a synced
       * collection at global scope - "tenant-wide data every device needs". But
       * the sync gateway only offers a device rows whose updated_date has
       * moved:
       *
       *     { updated_date: { $gt: since.ts } }
       *     { $expr: { $gt: ['$updated_date', '$_syncMeta.at'] } }
       *
       * and this write goes through the NATIVE driver, so the schema's
       * `timestamps: { updatedAt: 'updated_date' }` never fires. Nothing else
       * here set it either.
       *
       * The result was a shop whose branch document still carried its creation
       * date ten months later. Every settings change it had ever made was
       * correct in the cloud, correct on the web, and invisible to its till -
       * the address on its printed bills, the bill-print switches, all of it.
       * Nothing reported a failure because nothing had failed; the row was
       * simply never eligible to travel.
       */
      updateData.updated_date = new Date();
      const result = await collection.updateOne(filter, { $set: updateData });
      if (result.matchedCount === 0) {
        return {
          status: false,
          data: null,
          message: 'Branch not found or license mismatch',
        };
      }

      return {
        status: true,
        data: {
          country: updateData.country,
          state: updateData.state,
          country_id: updateData.country_id,
          currency_text: updateData.currency_text,
          currency_type: updateData.currency_type,
          time_zone: updateData.time_zone,
          clientdate: updateData.client_dateformat,
          serverdate: updateData.server_dateformat,
          dateformat_text: updateData.dateformat_text,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in updateStarterLocale:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return ['true', '1', 'yes', 'on'].includes(normalized);
    }
    return Boolean(value);
  }

  toNumber(value, fallback = 0) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  async updateCommonSettings(data = {}) {
    try {
      if (
        data.sales_exact_numeric_codes !== undefined &&
        typeof data.sales_exact_numeric_codes !== 'boolean'
      ) {
        return { status: false, data: null, message: 'Exact numeric search must be on or off' };
      }
      if (
        data.allow_sale_hard_delete !== undefined &&
        String(this.user?.usertype || this.user?.role || '').toLowerCase() !== 'super_admin'
      ) {
        return {
          status: false,
          data: null,
          message: 'Only super admins can change the sale hard-delete setting',
        };
      }
      /*
       * THE QR, MADE ONCE.
       *
       * Before anything else, because the result goes into `data` and the
       * write below reads it like any other field. It needs the branch as
       * it stands to know whether the address changed - a settings page is
       * saved for fifty unrelated reasons and re-encoding every time would
       * be work nobody asked for.
       */
      const { resolveFooterImage } = require('../helpers/footer-qr');
      let currentFooter;
      if (
        data.footer_qr_url !== undefined ||
        data.footer_image !== undefined ||
        data.footer_image_caption !== undefined
      ) {
        const branches = await this.getCollection('branches');
        const now = await branches.findOne(
          { _id: this.normalizeId(this.branchId) },
          { projection: { footer_qr_url: 1, footer_image: 1, footer_image_caption: 1 } }
        );
        currentFooter = now || {};
        const made = await resolveFooterImage(data, now || {});
        if (made) Object.assign(data, made);
        else {
          // Keep the picture and its source together on a no-op or failed generation.
          delete data.footer_image;
          delete data.footer_qr_url;
        }
      }

      // Ensure context is set (branchId, licenseId, user required for updates)
      if (!this.branchId || !this.licenseId || !this.user?._id) {
        throw new Error('Branch context is required (branchId, licenseId, user._id)');
      }

      /*
       * Module On/Off for ANOTHER branch (M4): a multi-branch admin picks a
       * branch on the Modules tab and flips ITS switches without switching
       * sessions. Deliberately modules-only: the rest of this function's
       * surface (printing, receipts, defaults) reads controls that still
       * show the SESSION branch's values, and writing those to the target
       * would clobber its real settings. So a remote target writes the
       * toggle map and nothing else - same license filter as every branch
       * write, so a foreign id is a silent no-op.
       */
      const remoteTarget =
        data.target_branch_id &&
        /^[0-9a-fA-F]{24}$/.test(String(data.target_branch_id)) &&
        String(data.target_branch_id) !== String(this.branchId)
          ? data.target_branch_id
          : null;
      if (remoteTarget) {
        return this.updateBranchModules(remoteTarget, data);
      }
      /*
       * modules_only: the same toggle-map-only write for the SESSION branch.
       * The first-run Feature picker saves through here - it carries only
       * switches (plus the controller's validation satisfiers, which this
       * path ignores), so routing it into the full surface below would write
       * empty printing/receipt fields read from controls it never showed.
       */
      if (data.modules_only === true || data.modules_only === 'true') {
        return this.updateBranchModules(this.branchId, data);
      }

      // PHP model does NOT validate field data - controller handles that
      const usersCollection = await this.getCollection('users');
      const branchCollection = await this.getCollection();

      // Update user printing_design using positional operator (matches PHP logic line 330-339)
      // Wrapped in try-catch: if user doesn't have printing_design for this branch, continue anyway
      // Skipped entirely for partial payloads that carry no printing fields.
      if (data.print_type !== undefined) {
        try {
          await usersCollection.updateOne(
            {
              _id: this.normalizeId(this.user._id),
              'printing_design.branch_id': this.normalizeId(this.branchId),
            },
            {
              $set: {
                'printing_design.$.printing_design': data.print_type,
                ...(data.print_character !== undefined
                  ? { 'printing_design.$.printing_max_char': data.print_character }
                  : {}),
                ...(data.print_size !== undefined
                  ? { 'printing_design.$.printing_size': data.print_size }
                  : {}),
                // Paper width in millimetres. Added alongside the others rather
                // than replacing any: printing_size is the font size, this is
                // the roll the receipt has to fit on.
                ...(data.print_width !== undefined
                  ? { 'printing_design.$.print_width': data.print_width }
                  : {}),
              },
            }
          );
        } catch (userPrintError) {
          // Non-blocking: continue even if user printing update fails
          console.warn(
            'User printing_design update failed (non-critical):',
            userPrintError.message
          );
        }
      }

      // Default values - matches PHP lines 342-351
      // Note: enableNotificationReminders and enableEmailReminders are NOT defaulted in PHP
      // They are only set if planAccess is granted
      let printUrl = false;

      // These are only set if plan access is granted (not defaulted like PHP)
      let enableNotificationReminders;
      let enableEmailReminders;

      // Check access permission for 'plan' (mirrors PHP logic)
      const planAccess = this.user?.access?.plan?.read ?? false;

      if (planAccess !== false) {
        // If access is granted, check values from the data
        printUrl = this.toBoolean(data.print_url);
        enableNotificationReminders = this.toBoolean(data.enable_notification_reminders);
        enableEmailReminders = this.toBoolean(data.enable_email_reminders);
      }

      // Convert all boolean fields
      const salesMail = this.toBoolean(data.sales_mail);
      const customerPrint = this.toBoolean(data.customer_print);
      const barcode = this.toBoolean(data.receipt_barcode);
      const stockManagement = this.toBoolean(data.stock_management);
      const stockManagementLog = this.toBoolean(data.stock_log_management);
      const printall = this.toBoolean(data.printall);
      const printLogoImg = this.toBoolean(data.print_logoimg);
      const printSaleNotes = this.toBoolean(data.print_sale_notes);
      /*
       * What the bill carries. The form posts 'true' / 'false' as STRINGS, so
       * these go through toBoolean like every other switch on the card - a
       * stored 'false' read as a boolean is truthy, which is how a switched-off
       * setting silently stays on.
       */
      const billPrint = {};
      billPrint.bill_print_total_qty = this.toBoolean(data.bill_print_total_qty);
      billPrint.bill_print_session = this.toBoolean(data.bill_print_session);
      const keyboardView = this.toBoolean(data.keyboard_view);
      const customerCheckbox = this.toBoolean(data.customer_checkbox);
      const supplierCheckbox = this.toBoolean(data.supplier_checkbox);
      const saleInlineEditor = this.toBoolean(data.sale_inline_editor);
      // the double-click editor's own switch (replaces the old inline pencils)
      const saleQuickEdit = data.sale_quick_edit_enable;
      const tableOptions = this.toBoolean(data.table_options);
      const roundOff = this.toBoolean(data.roundOff);
      const hardwareWeightMachineEnable = this.toBoolean(data.hardware_weight_machine_enable);

      // Build $set object - conditionally include fields only when defined (matches PHP behavior)
      const updateFields = {
        default_customer: this.normalizeId(data.default_customer),
        default_supplier: this.normalizeId(data.default_supplier),
        notification_range: data.notification_value,
        discount_percentage: parseFloat(data.discount_percentage),
        discount_amount: parseFloat(data.discount_amount),
        sales_prefix: data.sales_prefix,
        ...(data.allow_payment_correction !== undefined
          ? {
              allow_payment_correction:
                data.allow_payment_correction === true || data.allow_payment_correction === 'true',
            }
          : {}),
        ...(data.allow_sale_hard_delete !== undefined
          ? {
              allow_sale_hard_delete:
                data.allow_sale_hard_delete === true || data.allow_sale_hard_delete === 'true',
            }
          : {}),
        ...Object.fromEntries(
          ['sales_search_fields', 'sales_search_display_fields']
            .filter((key) => data[key] !== undefined)
            .map((key) => [key, require('../helpers/sales-search-fields').validate(key, data[key])])
        ),
        /*
         * WHEN THE BILL NUMBER STARTS AGAIN AT ONE.
         *
         * Only written when the form actually sent it, so a save from an
         * older screen - or from any of the other forms that post into this
         * same method - cannot silently switch a shop's numbering off. An
         * unrecognised value is stored as empty, which is off: a typo must
         * not restart a shop's invoice series.
         */
        ...(data.bill_number_reset !== undefined
          ? {
              bill_number_reset: ['financial', 'calendar'].includes(
                String(data.bill_number_reset || '').trim()
              )
                ? String(data.bill_number_reset).trim()
                : '',
            }
          : {}),
        ...(data.bill_number_fy_start_month !== undefined
          ? {
              bill_number_fy_start_month: (() => {
                const month = Number(data.bill_number_fy_start_month);
                return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 4;
              })(),
            }
          : {}),
        // Shop's own outgoing mail (owner rule: theirs first, ours as the
        // cloud fallback). Password stored as given - it must be usable.
        ...(data.email_smtp_host !== undefined
          ? { email_smtp_host: String(data.email_smtp_host || '').trim() }
          : {}),
        ...(data.email_smtp_port !== undefined
          ? { email_smtp_port: String(data.email_smtp_port || '').trim() }
          : {}),
        ...(data.email_smtp_secure !== undefined
          ? { email_smtp_secure: String(data.email_smtp_secure) === 'true' }
          : {}),
        ...(data.email_smtp_username !== undefined
          ? { email_smtp_username: String(data.email_smtp_username || '').trim() }
          : {}),
        /* S4: the password is never sent to the browser any more, so the form
           loads with this field empty. Empty therefore means "keep the saved
           one" - writing it through would blank the shop's mail the first
           time anyone saved an unrelated setting. */
        ...secretUpdate('email_smtp_password', data.email_smtp_password),
        ...(data.email_smtp_from !== undefined
          ? { email_smtp_from: String(data.email_smtp_from || '').trim() }
          : {}),
        ...(data.footer_image !== undefined
          ? {
              /*
               * The QR, or whatever the shop put under its total. Capped at
               * the same 400KB as the signature: it is a data URL living in
               * the branch document, and a phone photograph dropped in here
               * would be megabytes on every settings read.
               *
               * An empty string removes it, which is how the clear button
               * works - there is no separate switch, because an image that
               * is there is one the shop wants printed.
               */
              footer_image: String(data.footer_image || '').slice(0, 400000),
            }
          : {}),
        ...(data.footer_qr_url !== undefined
          ? {
              footer_qr_url: String(data.footer_qr_url || '')
                .trim()
                .slice(0, 2000),
            }
          : {}),
        ...(data.footer_image_caption !== undefined
          ? {
              /* Two lines at 48 characters is what fits above a QR before
                 the receipt starts looking like a leaflet. */
              footer_image_caption: String(data.footer_image_caption || '')
                .trim()
                .split(String.fromCharCode(10))
                .slice(0, 2)
                .map((line) => line.trim().slice(0, 64))
                .filter(Boolean)
                .join(String.fromCharCode(10)),
            }
          : {}),
        receiving_prefix: data.receiving_prefix,
        roundOff: roundOff,
        receipt_barcode: barcode,
        stock_management: stockManagement,
        stock_management_log: stockManagementLog,
        printall: printall,
        sales_mail: salesMail,
        customer_print: customerPrint,
        print_url: printUrl,
        print_logoimg: printLogoImg,
        print_sale_notes: printSaleNotes,
        bill_print_total_qty: billPrint.bill_print_total_qty,
        bill_print_session: billPrint.bill_print_session,
        branch_fssai_number: String(data.branch_fssai_number || '').trim(),
        keyboard_view: keyboardView,
        balance_view: true,
        ...(data.sale_redirect_seconds !== undefined
          ? {
              sale_redirect_seconds: require('../utils/sale-redirect').validateSeconds(
                data.sale_redirect_seconds
              ),
            }
          : {}),
        customer_checkbox: customerCheckbox,
        supplier_checkbox: supplierCheckbox,
        print_type: data.print_type,
        /* A count, not a switch. Read back as a number wherever it is used, so
           a form that posts "2" does not become the string "2" on the bill. */
        bill_print_copies: data.bill_print_copies,
        printing_size: data.print_size,
        print_width: data.print_width,
        print_character: data.print_character,
        header_print: data.header_print,
        footer_print: data.footer_print,
        sale_inline_editor: saleInlineEditor,
        ...(saleQuickEdit !== undefined
          ? { sale_quick_edit_enable: String(saleQuickEdit) === 'true' }
          : {}),
        table_options: tableOptions,
        hardware_weight_machine_enable: hardwareWeightMachineEnable,
      };

      // Only include these fields if they were set (planAccess was granted)
      if (enableNotificationReminders !== undefined) {
        updateFields.enable_notification_reminders = enableNotificationReminders;
      }
      if (enableEmailReminders !== undefined) {
        updateFields.enable_email_reminders = enableEmailReminders;
      }

      /*
       * Workforce, till and Module On/Off switches. THIS function is what the
       * Modules tab actually saves through - and it silently dropped every
       * one of these keys, so "switch everything off, refresh, everything is
       * back on" was exactly what happened: nothing was ever written, and the
       * default-ON read filled the gaps. Presence-gated so callers that do
       * not send a key can never reset it.
       */
      const offOnly = (v) => !(v === 'false' || v === false);
      const onOnly = (v) => v === 'true' || v === true;
      const TOGGLES = {
        staff_shifts_enable: offOnly,
        staff_tips_enable: onOnly,
        staff_roster_enable: offOnly,
        cash_register_enable: offOnly,
        till_lock_enable: onOnly,
        module_recyclebin_enable: offOnly,
        module_themes_enable: offOnly,
        quick_sale_enable: onOnly,
        /* Not a module: a record that the welcome has been shown. onOnly,
           because absent must mean "not yet welcomed" - the opposite
           default would mean nobody is ever welcomed and nothing looks
           wrong. Presence-gated by the loop below, so a settings save
           that does not mention it cannot set it either way. */
        first_run_done: onOnly,
        first_run_decided: onOnly,
      };
      for (const [key, parse] of Object.entries(TOGGLES)) {
        if (data[key] !== undefined) {
          updateFields[key] = parse(data[key]);
        }
      }
      if (data.till_lock_idle_minutes !== undefined) {
        let idle = parseInt(data.till_lock_idle_minutes, 10);
        if (isNaN(idle) || idle < 0) idle = 0;
        updateFields.till_lock_idle_minutes = Math.min(idle, 120);
      }

      /*
       * Partial-save safety: this endpoint also takes small PATCH-style
       * payloads (the quotation defaults card, the signature upload from the
       * quote page). Any $set field whose SOURCE key was not sent is dropped
       * here, so a partial payload can never wipe the rest of the shop's
       * settings with undefined/false derived from absent controls. Full
       * settings-form saves send every key, so they are unaffected.
       */
      const SOURCE_OF = {
        default_customer: 'default_customer',
        default_supplier: 'default_supplier',
        notification_range: 'notification_value',
        discount_percentage: 'discount_percentage',
        discount_amount: 'discount_amount',
        sales_prefix: 'sales_prefix',
        sales_search_fields: 'sales_search_fields',
        sales_search_display_fields: 'sales_search_display_fields',
        bill_number_reset: 'bill_number_reset',
        bill_number_fy_start_month: 'bill_number_fy_start_month',
        receiving_prefix: 'receiving_prefix',
        roundOff: 'roundOff',
        receipt_barcode: 'receipt_barcode',
        stock_management: 'stock_management',
        stock_management_log: 'stock_log_management',
        printall: 'printall',
        sales_mail: 'sales_mail',
        customer_print: 'customer_print',
        print_url: 'print_url',
        print_logoimg: 'print_logoimg',
        print_sale_notes: 'print_sale_notes',
        bill_print_total_qty: 'bill_print_total_qty',
        bill_print_session: 'bill_print_session',
        branch_fssai_number: 'branch_fssai_number',
        keyboard_view: 'keyboard_view',
        balance_view: 'balance_view',
        sale_redirect_seconds: 'sale_redirect_seconds',
        customer_checkbox: 'customer_checkbox',
        supplier_checkbox: 'supplier_checkbox',
        print_type: 'print_type',
        bill_print_copies: 'bill_print_copies',
        printing_size: 'print_size',
        print_width: 'print_width',
        print_character: 'print_character',
        header_print: 'header_print',
        footer_print: 'footer_print',
        sale_inline_editor: 'sale_inline_editor',
        table_options: 'table_options',
        hardware_weight_machine_enable: 'hardware_weight_machine_enable',
        enable_notification_reminders: 'enable_notification_reminders',
        enable_email_reminders: 'enable_email_reminders',
      };
      for (const [field, src] of Object.entries(SOURCE_OF)) {
        if (data[src] === undefined && field in updateFields) {
          delete updateFields[field];
        }
      }

      /*
       * THE WATERMARK, OR THE TILL NEVER HEARS ABOUT IT.
       *
       * The sync gateway sends a device only rows whose `updated_date` has
       * moved past what that device last saw. This is a native-driver
       * updateOne, so the Mongoose `timestamps: { updatedAt: 'updated_date' }`
       * hook does not run and nothing stamps it. The branch record changes,
       * the screen says Saved, and the row is invisible to sync for ever.
       *
       * Fixed once already for the two writes above (#838). These two were
       * missed in the same file, which is why a setting could appear saved on
       * screen while sync never saw the change.
       */
      if (data.receipt_designs !== undefined) {
        updateFields.receipt_designs = require('../helpers/receipt-design').normalize(
          data.receipt_designs
        );
      }
      updateFields.updated_date = new Date();

      // Core Settings uses this legacy endpoint. Keep the grouped preference
      // used by Sales and its synchronized branch mirror in agreement.
      if (data.sales_exact_numeric_codes !== undefined) {
        const SettingsRepository = require('../repositories/settings.repository');
        const saved = await new SettingsRepository().saveGroup(
          'preferences',
          { sales_exact_numeric_codes: data.sales_exact_numeric_codes },
          { branchId: this.branchId, licenseId: this.licenseId }
        );
        if (!saved.status) return saved;
      }

      // Update branch collection (matches PHP $set logic line 389-434)
      await branchCollection.updateOne(
        { _id: this.normalizeId(this.branchId), license: this.normalizeId(this.licenseId) },
        { $set: updateFields }
      );

      // Prepare result data (matches PHP return structure line 474-481)
      const result = {
        customer: data.default_customer,
        supplier: data.default_supplier,
        url: printUrl,
        header_print: data.header_print,
        footer_print: data.footer_print,
        ...(data.receipt_designs !== undefined ? { receipt_designs: data.receipt_designs } : {}),
      };
      // Return the resolved picture, including cache hits and explicit clears,
      // so the form and the next print see the saved state without a reload.
      if (currentFooter) {
        for (const key of ['footer_image', 'footer_qr_url', 'footer_image_caption']) {
          result[key] = String(updateFields[key] ?? currentFooter[key] ?? '');
        }
      }

      return {
        status: true,
        data: result,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in updateCommonSettings:', error);
      console.error('Stack trace:', error.stack);
      return {
        status: false,
        data: null,
        message: `Update failed: ${error.message}`,
      };
    }
  }

  /*
   * The one shared truth about module switches: which keys exist and how a
   * missing value parses. offOnly keys default ON (absent = enabled),
   * onOnly keys default OFF. Both writers below and the branch read use
   * THIS map - a key added here is a key added everywhere.
   */
  static moduleToggleMap() {
    const offOnly = (v) => !(v === 'false' || v === false);
    const onOnly = (v) => v === 'true' || v === true;
    return {
      staff_shifts_enable: { parse: offOnly, dflt: true },
      table_options: { parse: onOnly, dflt: false },
      hardware_weight_machine_enable: { parse: onOnly, dflt: false },
      staff_tips_enable: { parse: onOnly, dflt: false },
      staff_roster_enable: { parse: offOnly, dflt: true },
      cash_register_enable: { parse: offOnly, dflt: true },
      till_lock_enable: { parse: onOnly, dflt: false },
      module_recyclebin_enable: { parse: offOnly, dflt: true },
      module_themes_enable: { parse: offOnly, dflt: true },
      quick_sale_enable: { parse: onOnly, dflt: false },
      custom_charges_enable: { parse: (v) => v === true || v === 'true', dflt: false },
    };
  }

  /**
   * Modules-only write to another branch of this license (M4 branch
   * selector). Presence-gated like every toggle write: a payload that
   * omits a key leaves it untouched.
   */
  async updateBranchModules(targetBranchId, data = {}) {
    try {
      const branchCollection = await this.getCollection();
      const updateFields = {};
      for (const [key, def] of Object.entries(SettingModel.moduleToggleMap())) {
        if (data[key] !== undefined) {
          updateFields[key] = def.parse(data[key]);
        }
      }
      if (data.till_lock_idle_minutes !== undefined) {
        let idle = parseInt(data.till_lock_idle_minutes, 10);
        if (isNaN(idle) || idle < 0) idle = 0;
        updateFields.till_lock_idle_minutes = Math.min(idle, 120);
      }
      if (!Object.keys(updateFields).length) {
        return { status: true, data: null, message: 'success' };
      }
      /*
       * THE WATERMARK, OR THE TILL NEVER HEARS ABOUT IT.
       *
       * The sync gateway sends a device only rows whose `updated_date` has
       * moved past what that device last saw. This is a native-driver
       * updateOne, so the Mongoose `timestamps: { updatedAt: 'updated_date' }`
       * hook does not run and nothing stamps it. The branch record changes,
       * the screen says Saved, and the row is invisible to sync for ever.
       *
       * Fixed once already for the two writes above (#838). These two were
       * missed in the same file, which is why a setting could appear saved on
       * screen while sync never saw the change.
       */
      updateFields.updated_date = new Date();

      const r = await branchCollection.updateOne(
        { _id: this.normalizeId(targetBranchId), license: this.normalizeId(this.licenseId) },
        { $set: updateFields }
      );
      if (!r.matchedCount) {
        return { status: false, data: null, message: 'No such branch in this shop' };
      }
      return {
        status: true,
        data: { target_branch_id: String(targetBranchId) },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in updateBranchModules:', error);
      return { status: false, data: null, message: `Update failed: ${error.message}` };
    }
  }

  /**
   * The module switches of one branch of this license, parsed to booleans
   * with the same defaults the whole app gates on - what the Modules tab's
   * branch selector loads before editing.
   */
  async getBranchModules(targetBranchId) {
    try {
      const branchCollection = await this.getCollection();
      const branch = await branchCollection.findOne({
        _id: this.normalizeId(targetBranchId),
        license: this.normalizeId(this.licenseId),
      });
      if (!branch) {
        return { status: false, data: null, message: 'No such branch in this shop' };
      }
      const modules = {};
      for (const [key, def] of Object.entries(SettingModel.moduleToggleMap())) {
        modules[key] = branch[key] === undefined ? def.dflt : def.parse(branch[key]);
      }
      let idle = parseInt(branch.till_lock_idle_minutes, 10);
      if (isNaN(idle) || idle < 0) idle = 0;
      modules.till_lock_idle_minutes = Math.min(idle, 120);
      return {
        status: true,
        data: {
          branch_id: String(branch._id),
          branch_name: branch.branch_name || '',
          modules,
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getBranchModules:', error);
      return { status: false, data: null, message: `Read failed: ${error.message}` };
    }
  }

  /**
   * PHP: getSelectUnitAjaxList($query)
   * Autocomplete list of units for the current branch/license.
   * Returns: { status: boolean, data: [{ unit_id, unit_name, unit_value }], message }
   */
  async getSelectUnitAjaxList(query = '') {
    try {
      const collection = await this.getCollection(this.unitCollection);

      const filter = this.buildFilter({});

      if (query && typeof query === 'string' && query.trim()) {
        filter.name = { $regex: query.trim(), $options: 'i' };
      }

      const cursor = await collection.find(filter, {
        sort: { name: 1 },
        limit: 50,
      });
      const docs = await cursor.toArray();

      const units = docs.map((doc) => ({
        unit_id: doc._id?.toString?.() || doc._id,
        unit_name: doc.name || '',
        unit_value:
          typeof doc.value === 'number'
            ? doc.value
            : typeof doc.unit_value === 'number'
              ? doc.unit_value
              : doc.value || doc.unit_value || 0,
      }));

      return {
        status: true,
        data: units,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getSelectUnitAjaxList:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async changePasswordModel(data) {
    try {
      const bcrypt = require('bcryptjs');

      // Validate passwords match
      if (data.new_password !== data.confirm_password) {
        return { status: false, message: 'Passwords do not match' };
      }

      const usersCollection = await this.getCollection('users');
      const user = await usersCollection.findOne({ _id: this.normalizeId(this.user._id) });

      if (!user) {
        return { status: false, message: 'User not found' };
      }

      // Verify old password - compare with hashed password in database
      if (!user.password) {
        return { status: false, message: 'User password not set' };
      }

      // Try comparing password - first with base64 encoding (PHP behavior), then without
      const base64OldPassword = Buffer.from(data.old_password).toString('base64');
      let oldPasswordValid = await bcrypt.compare(base64OldPassword, user.password);

      // If base64 comparison fails, try without base64 (for passwords created without base64)
      if (!oldPasswordValid) {
        oldPasswordValid = await bcrypt.compare(data.old_password, user.password);
      }

      if (!oldPasswordValid) {
        /* Recorded too. Somebody repeatedly failing to change a password is
           either a person who has forgotten it or somebody working through a
           list, and the address is what tells those apart. */
        await recordAudit(await this.getDB().catch(() => null), {
          event: 'password_change_failed',
          actor: { id: String(user._id), name: user.email || user.username || '' },
          target: { id: String(user._id), name: user.email || user.username || '', type: 'user' },
          ip: this.ip,
          userAgent: this.userAgent,
          branchId: this.branchId,
          license: this.licenseId,
          extra: { reason: 'current password did not match' },
        });
        return { status: false, message: 'Current password is incorrect' };
      }

      // Hash new password - base64 encode first, then hash (matching PHP behavior)
      const base64NewPassword = Buffer.from(data.new_password).toString('base64');
      const hashedPassword = await bcrypt.hash(base64NewPassword, 12);

      // Generate new userkey
      const random =
        new Date().toLocaleDateString('en-GB').replace(/\//g, '') + Math.random().toString();
      const newUserKey = await bcrypt.hash(random, 10);

      const updateData = {
        password: hashedPassword,
        userkey: newUserKey,
        updated_at: new Date(),
      };

      const result = await usersCollection.updateOne(
        { _id: this.normalizeId(this.user._id) },
        { $set: updateData }
      );

      if (result.modifiedCount === 0) {
        return { status: false, message: 'Failed to update password' };
      }

      /*
       * The event that could not be answered.
       *
       * When a shop was locked out, the only evidence a password had changed
       * was a timestamp on the user document - no actor, no address, nothing
       * to tell the owner whether it was them last Tuesday or somebody else.
       * The password itself is never written here; recordAudit redacts any
       * field whose name looks like a secret regardless of what is passed.
       */
      await recordAudit(await this.getDB().catch(() => null), {
        event: 'password_changed',
        actor: { id: String(user._id), name: user.email || user.username || '' },
        target: { id: String(user._id), name: user.email || user.username || '', type: 'user' },
        ip: this.ip,
        userAgent: this.userAgent,
        branchId: this.branchId,
        license: this.licenseId,
        extra: { method: 'self_service_change_password' },
      });

      return {
        status: true,
        data: result.modifiedCount,
        message: 'Password updated successfully',
      };
    } catch (error) {
      console.error('Error in changePasswordModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async deleteStoreCollection(collectionName) {
    try {
      if (!collectionName) throw new Error('Collection name required');
      const collection = await this.getCollection(collectionName);

      // Safety check: only allow specific collections
      const allowed = ['customers', 'suppliers', 'items', 'sales', 'receivings'];
      if (!allowed.includes(collectionName)) {
        return { status: false, message: 'Deletion of this collection is not allowed' };
      }

      const result = await collection.deleteMany({
        branch_id: this.branchId,
        license: this.licenseId,
      });

      return {
        status: true,
        data: result.deletedCount,
        message: `${collectionName} data deleted successfully`,
      };
    } catch (error) {
      console.error('Error in deleteStoreCollection:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async deleteAllSelectedCollection(data) {
    try {
      const collections = data.collections || [];
      const results = {};

      for (const col of collections) {
        const res = await this.deleteStoreCollection(col);
        results[col] = res.status ? 'Deleted' : 'Failed';
      }

      return {
        status: true,
        data: results,
        message: 'Selected collections processed',
      };
    } catch (error) {
      console.error('Error in deleteAllSelectedCollection:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async updateCommonCustomerSettings(customerId) {
    return this.updateCommonSettings({ default_customer: customerId });
  }

  async updateCommonSupplierSettings(supplierId) {
    return this.updateCommonSettings({ default_supplier: supplierId });
  }

  /**
   * Update email settings
   * @param {Object} data - Email settings data
   * @returns {Promise<Object>} - Result of the operation
   */
  async editEmailSetting(data) {
    try {
      const collection = await this.getCollection();
      const updateData = {
        'email.host': data.host?.trim() || '',
        'email.port': parseInt(data.port, 10) || 587,
        'email.username': data.username?.trim() || '',
        'email.password': data.password?.trim() || '',
        'email.encryption': data.encryption?.trim() || 'tls',
        'email.from_address': data.from_address?.trim() || '',
        'email.from_name': data.from_name?.trim() || '',
        updated_at: new Date(),
        updated_by: this.user?.username || 'system',
        updated_by_id: this.user?._id || null,
      };

      const result = await collection.updateOne(
        { _id: this.branchId, license: this.licenseId },
        { $set: updateData }
      );

      return {
        status: true,
        data: result.modifiedCount,
        message: 'Email settings updated successfully',
      };
    } catch (error) {
      console.error('Error in editEmailSetting:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getSystemSettings() {
    try {
      const collection = await this.getCollection();
      const settings = await collection.findOne(
        { _id: this.branchId, license: this.licenseId },
        {
          projection: {
            _id: 0,
            email: 1,
          },
        }
      );

      return {
        status: true,
        data: settings || {},
        message: 'System settings retrieved successfully',
      };
    } catch (error) {
      console.error('Error in getSystemSettings:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getDenomAllModel() {
    try {
      const collection = await this.getCollection(this.denomCollection);

      // Denom collection stores branch_id as string, license as ObjectId
      const filter = {};
      if (this.branchId) {
        filter.branch_id = this.branchId.toString();
      }
      if (this.licenseId) {
        filter.license = this.normalizeId(this.licenseId);
      }

      // PHP just retrieves existing denominations without auto-creation
      const pipeline = [
        { $match: filter },
        {
          $project: {
            denom_id: '$_id',
            denom_value: { $ifNull: ['$denom_value', '$cash_field'] },
          },
        },
        {
          $group: {
            _id: {
              denom_id: '$denom_id',
              denom_value: '$denom_value',
            },
          },
        },
        { $sort: { '_id.denom_value': 1 } },
        { $limit: 10 },
      ];

      const raw = await collection.aggregate(pipeline).toArray();

      const data = raw
        .map((doc) => {
          const denomId = doc._id?.denom_id;
          const denomValueRaw = doc._id?.denom_value;

          const denomValue =
            typeof denomValueRaw === 'number' ? denomValueRaw : parseFloat(denomValueRaw);

          if (!denomId || !Number.isFinite(denomValue)) {
            return null;
          }

          return {
            denom_id:
              typeof denomId === 'string' ? denomId : denomId.toString?.() || String(denomId),
            denom_value: denomValue,
          };
        })
        .filter(Boolean);

      return {
        status: true,
        data,
        message: 'Denomination list retrieved',
      };
    } catch (error) {
      console.error('Error in getDenomAllModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async addDenomModel(data) {
    return this.addDenomFiledModel(data);
  }

  async addDenomDataModel(data) {
    return this.addDenomFiledModel(data);
  }

  async addDenomFiledModel(data) {
    try {
      const collection = await this.getCollection(this.denomCollection);

      // PHP lines 1532-1546: Check for duplicate cash_field value
      // Denom collection stores branch_id as string, license as ObjectId
      const recordsFiltered = await collection.findOne({
        branch_id: this.branchId.toString(),
        cash_field: parseFloat(data.denom_value),
        license: this.normalizeId(this.licenseId),
      });

      if (recordsFiltered) {
        return {
          status: false,
          data: null,
          message: 'This field details already exist in our system',
        };
      }

      // PHP lines 1548-1561: Get branch_name and build insert data
      const branch_name = await this.getBranchName();
      const mongoDate = new Date();

      // Denom collection stores branch_id as string, license as ObjectId
      const insertData = {
        branch_id: this.branchId.toString(),
        branch_name: branch_name,
        denom_value: parseFloat(data.denom_value), // Primary field used by getDenomAll
        cash_field: parseFloat(data.denom_value), // Legacy field for compatibility
        created_date: mongoDate,
        created_by: this.user?.username || 'system',
        created_by_id: this.normalizeId(this.user?._id),
        updated_date: mongoDate,
        updated_by: this.user?.username || 'system',
        updated_by_id: this.normalizeId(this.user?._id),
        license: this.normalizeId(this.licenseId),
      };

      // PHP lines 1562-1563: Insert document
      const insertOneResult = await collection.insertOne(insertData);
      const lastInsertedId = insertOneResult.insertedId;

      // PHP lines 1565-1575: Push to cash_fields array (two-step process)
      const field_array_data = {
        field_id: lastInsertedId,
        field_value: data.denom_value,
      };

      await collection.updateOne(
        {
          _id: lastInsertedId,
          branch_id: this.branchId.toString(),
          license: this.normalizeId(this.licenseId),
        },
        { $push: { cash_fields: field_array_data } }
      );

      // PHP lines 1576-1580: Return success response
      return {
        status: true,
        data: lastInsertedId.toString(),
        message: 'Field Added Successfully',
      };
    } catch (error) {
      console.error('Error in addDenomFiledModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async editDenomFiledModel(data) {
    try {
      const collection = await this.getCollection(this.denomCollection);
      // PHP line 1641: uses $data['denom_id']
      const id = data.denom_id || data.id || data._id;
      if (!id) throw new Error('ID is required');

      // PHP lines 1635-1648: Check for duplicate cash_field, excluding current ID
      // Denom collection stores branch_id as string, license as ObjectId
      const recordsFiltered = await collection.findOne({
        branch_id: this.branchId.toString(),
        cash_field: parseFloat(data.denom_value),
        license: this.normalizeId(this.licenseId),
      });

      if (recordsFiltered && recordsFiltered._id.toString() !== id.toString()) {
        return {
          status: false,
          data: null,
          message: 'This details already exist in our system',
        };
      }

      // PHP lines 1662: Build denom_data array for cash_fields
      const denom_data = [
        {
          field_id: this.normalizeId(id),
          field_value: data.denom_value,
        },
      ];

      // PHP lines 1665-1671: Build update data
      const mongoDate = new Date();
      const updateData = {
        denom_value: parseFloat(data.denom_value), // Update denom_value (used by getDenomAll)
        cash_field: parseFloat(data.denom_value), // Update cash_field (legacy field)
        cash_fields: denom_data,
        updated_date: mongoDate,
        updated_by: this.user?.username || 'system',
        updated_by_id: this.normalizeId(this.user?._id),
      };

      // PHP lines 1674-1677: Update document with _id, branch_id and license filters
      // Denom collection stores branch_id as string, license as ObjectId
      const result = await collection.updateOne(
        {
          _id: this.normalizeId(id),
          branch_id: this.branchId.toString(),
          license: this.normalizeId(this.licenseId),
        },
        { $set: updateData }
      );

      return {
        status: true,
        data: result.modifiedCount.toString(),
        message: 'Field Updated Successfully',
      };
    } catch (error) {
      console.error('Error in editDenomFiledModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async deleteDenomFiledModel(id) {
    try {
      const collection = await this.getCollection(this.denomCollection);
      if (!id) throw new Error('ID is required');

      // PHP lines 1709-1713: Delete with _id, branch_id, and license filters
      // Denom collection stores branch_id as string, license as ObjectId
      const result = await collection.deleteOne({
        _id: this.normalizeId(id),
        branch_id: this.branchId.toString(),
        license: this.normalizeId(this.licenseId),
      });

      if (result.deletedCount === 0) {
        return {
          status: false,
          data: null,
          message: 'Denomination not found or you do not have permission to delete it',
        };
      }

      return {
        status: true,
        data: result.deletedCount,
        message: 'Field deleted successfully',
      };
    } catch (error) {
      console.error('Error in deleteDenomFiledModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  /*
   * Modifier groups: named option sets with min/max selection rules and price
   * deltas, referenced by items and picked at sale time.
   */
  static normalizeModifierGroup(data = {}) {
    const name = String(data.name || '').trim();
    if (!name) return { error: 'The group needs a name.' };
    if (name.length > 60) return { error: 'Group name is too long (60 max).' };
    let min = parseInt(data.min, 10);
    let max = parseInt(data.max, 10);
    if (isNaN(min) || min < 0) min = 0;
    if (isNaN(max) || max < 0) max = 0; // 0 = no upper limit
    if (max !== 0 && max < min) return { error: 'Max picks cannot be below min picks.' };
    const rawOptions = Array.isArray(data.options) ? data.options : [];
    const options = [];
    const seen = new Set();
    for (const o of rawOptions) {
      const oname = String((o && o.name) || '').trim();
      if (!oname) continue;
      if (seen.has(oname.toLowerCase())) {
        return { error: 'Option "' + oname + '" appears twice.' };
      }
      seen.add(oname.toLowerCase());
      const delta = Number(o.price_delta);
      options.push({ name: oname, price_delta: Number.isFinite(delta) ? delta : 0 });
    }
    if (!options.length) return { error: 'The group needs at least one option.' };
    if (min > options.length) return { error: 'Min picks exceeds the number of options.' };
    return { value: { name, min, max, options } };
  }

  async getModifierGroupsModel() {
    try {
      const collection = await this.getCollection('modifier_groups');
      const list = await collection.find(this.buildFilter()).sort({ name: 1 }).toArray();
      return {
        status: true,
        data: list.map((doc) => ({
          id: doc._id.toString(),
          name: doc.name,
          min: doc.min || 0,
          max: doc.max || 0,
          options: doc.options || [],
        })),
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getModifierGroupsModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async addModifierGroupModel(data) {
    try {
      const norm = SettingModel.normalizeModifierGroup(data);
      if (norm.error) return { status: false, data: null, message: norm.error };
      const collection = await this.getCollection('modifier_groups');
      const dup = await collection.findOne({
        ...this.buildFilter(),
        name: {
          $regex: new RegExp(
            '^' + norm.value.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
            'i'
          ),
        },
      });
      if (dup)
        return { status: false, data: null, message: 'A group with this name already exists.' };
      const now = new Date();
      const r = await collection.insertOne({
        ...norm.value,
        branch_id: this.normalizeId(this.branchId),
        branch_name: await this.getBranchName(),
        license: this.normalizeId(this.licenseId),
        created_date: now,
        created_by: this.user?.username || 'system',
        updated_date: now,
        updated_by: this.user?.username || 'system',
      });
      return {
        status: true,
        data: { id: r.insertedId.toString() },
        message: 'Modifier group created',
      };
    } catch (error) {
      console.error('Error in addModifierGroupModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async editModifierGroupModel(id, data) {
    try {
      if (!id) return { status: false, data: null, message: 'Group id required' };
      const norm = SettingModel.normalizeModifierGroup(data);
      if (norm.error) return { status: false, data: null, message: norm.error };
      const collection = await this.getCollection('modifier_groups');
      const r = await collection.updateOne(
        { _id: this.normalizeId(id), license: this.normalizeId(this.licenseId) },
        {
          $set: {
            ...norm.value,
            updated_date: new Date(),
            updated_by: this.user?.username || 'system',
          },
        }
      );
      if (!r.matchedCount) return { status: false, data: null, message: 'No such modifier group' };
      return { status: true, data: null, message: 'Modifier group updated' };
    } catch (error) {
      console.error('Error in editModifierGroupModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async deleteModifierGroupModel(id) {
    try {
      if (!id) return { status: false, data: null, message: 'Group id required' };
      /* A group items still point at must not silently vanish out from
         under their sale screens. */
      const items = await this.getCollection('items');
      const used = await items.countDocuments({
        license: this.normalizeId(this.licenseId),
        modifier_group_ids: new ObjectId(String(id)),
      });
      if (used > 0) {
        return {
          status: false,
          data: null,
          message: 'This group is used by ' + used + ' item(s). Remove it from them first.',
        };
      }
      const collection = await this.getCollection('modifier_groups');
      const removed = await collection.findOne({
        _id: new ObjectId(String(id)),
        license: this.normalizeId(this.licenseId),
      });
      if (removed) await BaseModel.deletedDocumentBackup('modifier_groups', removed);
      const r = await collection.deleteOne({
        _id: new ObjectId(String(id)),
        license: this.normalizeId(this.licenseId),
      });
      if (!r.deletedCount) return { status: false, data: null, message: 'No such modifier group' };
      return { status: true, data: null, message: 'Modifier group deleted' };
    } catch (error) {
      console.error('Error in deleteModifierGroupModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  /*
   * Price lists (variant roadmap V4): customer-group pricing. A list is
   * keyed to a customer category and holds either a percentage rule
   * (percent_off - negative = markup) or per-item price overrides, or
   * both (overrides win). Resolution happens on the sale screen at line
   * price time; discounts flow after it, unchanged.
   */
  static normalizePriceList(data = {}) {
    const categoryId = String(data.customer_category_id || '').trim();
    if (!categoryId) return { error: 'Pick the customer category this list prices for.' };
    let percent = Number(data.percent_off);
    if (!Number.isFinite(percent)) percent = 0;
    if (percent <= -1000 || percent >= 100) {
      return { error: 'Percent off must be below 100 (negative means markup).' };
    }
    const rawOverrides = Array.isArray(data.item_overrides) ? data.item_overrides : [];
    const overrides = [];
    const seen = new Set();
    for (const o of rawOverrides) {
      const itemId = String((o && o.item_id) || '').trim();
      const price = Number(o && o.price);
      if (!itemId || seen.has(itemId)) continue;
      if (!Number.isFinite(price) || price < 0) continue;
      seen.add(itemId);
      overrides.push({
        item_id: itemId,
        item_name: String((o && o.item_name) || '').trim(),
        price,
      });
    }
    if (!percent && !overrides.length) {
      return { error: 'A list needs a percentage or at least one item price.' };
    }
    return {
      value: {
        customer_category_id: categoryId,
        customer_category_name: String(data.customer_category_name || '').trim(),
        percent_off: percent,
        item_overrides: overrides,
      },
    };
  }

  async getPriceListsModel() {
    try {
      const collection = await this.getCollection('price_lists');
      const list = await collection
        .find(this.buildFilter())
        .sort({ customer_category_name: 1 })
        .toArray();
      return {
        status: true,
        data: list.map((doc) => ({
          id: doc._id.toString(),
          customer_category_id: String(doc.customer_category_id || ''),
          customer_category_name: doc.customer_category_name || '',
          percent_off: doc.percent_off || 0,
          item_overrides: (doc.item_overrides || []).map((o) => ({
            item_id: String(o.item_id || ''),
            item_name: o.item_name || '',
            price: o.price,
          })),
        })),
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getPriceListsModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async savePriceListModel(data) {
    try {
      const norm = SettingModel.normalizePriceList(data);
      if (norm.error) return { status: false, data: null, message: norm.error };
      const collection = await this.getCollection('price_lists');
      const now = new Date();
      /* One list per category per branch - saving again replaces it, which
         is what a shopkeeper editing "Wholesale prices" means. */
      await collection.updateOne(
        { ...this.buildFilter(), customer_category_id: norm.value.customer_category_id },
        {
          $set: {
            ...norm.value,
            branch_id: this.normalizeId(this.branchId),
            license: this.normalizeId(this.licenseId),
            updated_date: now,
            updated_by: this.user?.username || 'system',
          },
          $setOnInsert: { created_date: now, created_by: this.user?.username || 'system' },
        },
        { upsert: true }
      );
      return { status: true, data: null, message: 'Price list saved' };
    } catch (error) {
      console.error('Error in savePriceListModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async deletePriceListModel(id) {
    try {
      if (!id) return { status: false, data: null, message: 'List id required' };
      const collection = await this.getCollection('price_lists');
      const removed = await collection.findOne({
        _id: new ObjectId(String(id)),
        license: this.normalizeId(this.licenseId),
      });
      if (removed) await BaseModel.deletedDocumentBackup('price_lists', removed);
      const r = await collection.deleteOne({
        _id: new ObjectId(String(id)),
        license: this.normalizeId(this.licenseId),
      });
      if (!r.deletedCount) return { status: false, data: null, message: 'No such price list' };
      return { status: true, data: null, message: 'Price list deleted' };
    } catch (error) {
      console.error('Error in deletePriceListModel:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  // Unit CRUD Methods (from PHP)
  async getUnitAllModel() {
    try {
      const collection = await this.getCollection(this.unitCollection);
      const filter = this.buildFilter();

      console.log('DEBUG - getUnitAllModel filter:', {
        branchId: this.branchId,
        licenseId: this.licenseId,
        filter: JSON.stringify(filter),
        filterBranchId: filter.branch_id?.toString(),
        filterLicense: filter.license?.toString(),
      });

      const cursor = await collection.find(filter).sort({ name: 1 }).limit(100);
      const docs = await cursor.toArray();

      console.log('DEBUG - getUnitAllModel results:', {
        count: docs.length,
        firstUnit: docs[0]
          ? {
              name: docs[0].name,
              branch_id: docs[0].branch_id?.toString(),
              license: docs[0].license?.toString(),
            }
          : null,
      });

      const units = docs.map((doc) => ({
        unit_id: doc._id?.toString?.() || doc._id,
        created_date: doc.created_date,
        unit_name: doc.name || '',
        unit_value: doc.value || doc.unit_value || '',
      }));

      return {
        status: true,
        data: units,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getUnitAllModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async addUnitModel(data) {
    try {
      const collection = await this.getCollection(this.unitCollection);

      // Check for duplicates
      const existing = await collection.findOne(this.buildFilter({ value: data.unit_value }));

      if (existing) {
        return {
          status: 'error',
          data: null,
          message: 'This unit details already exist in our system',
        };
      }

      const mongoDate = new Date();
      const insertData = {
        branch_id: this.normalizeId(this.branchId),
        branch_name: this.user?.branch_name || '',
        name: data.unit_name?.trim() || '',
        value: data.unit_value?.trim() || '',
        created_date: mongoDate,
        created_by: this.user?.username || 'system',
        created_by_id: this.normalizeId(this.user?._id),
        updated_date: mongoDate,
        updated_by: this.user?.username || 'system',
        updated_by_id: this.normalizeId(this.user?._id),
        license: this.normalizeId(this.licenseId),
      };

      const result = await collection.insertOne(insertData);

      return {
        status: true,
        data: result.insertedId?.toString?.() || result.insertedId,
        message: 'Unit Added Successfully',
      };
    } catch (error) {
      console.error('Error in addUnitModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async editUnitModel(data) {
    try {
      const collection = await this.getCollection(this.unitCollection);
      const mongoDate = new Date();
      const objectId = this.normalizeId(data.unit_id || data.id);

      if (!objectId) {
        throw new Error('Unit ID is required');
      }

      const updateData = {
        name: data.unit_name?.trim() || '',
        value: data.unit_value?.trim() || '',
        updated_date: mongoDate,
        updated_by: this.user?.username || 'system',
        updated_by_id: this.normalizeId(this.user?._id),
      };

      const result = await collection.updateOne(
        { _id: objectId, license: this.normalizeId(this.licenseId) },
        { $set: updateData }
      );

      return {
        status: true,
        data: result.modifiedCount,
        message: 'Unit Updated Successfully',
      };
    } catch (error) {
      console.error('Error in editUnitModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async deleteUnitModel(id) {
    try {
      const collection = await this.getCollection(this.unitCollection);
      if (!id) throw new Error('Unit ID is required');

      const result = await collection.deleteOne({
        _id: this.normalizeId(id),
        branch_id: this.normalizeId(this.branchId),
        license: this.normalizeId(this.licenseId),
      });

      if (result.deletedCount === 0) {
        return {
          status: false,
          data: null,
          message: 'Unit not found or you do not have permission to delete it',
        };
      }

      return {
        status: true,
        data: result.deletedCount,
        message: 'Unit deleted successfully',
      };
    } catch (error) {
      console.error('Error in deleteUnitModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  // Payment Methods
  /**
   * Update branch_name across all collections
   * Matches PHP implementation lines 113-121
   * @param {Object} branchDetails - { id: string, branch_name: string }
   */
  async editThemeSettings(data) {
    try {
      const collection = await this.getCollection();
      const themeSettings = {
        preset: data.preset?.trim() || 'default',
        primaryColor: data.primaryColor?.trim() || '#5a8dee',
        bodyBg: data.bodyBg?.trim() || '#f2f3f7',
        cardBg: data.cardBg?.trim() || '#ffffff',
        sidebarBg: data.sidebarBg?.trim() || '#ffffff',
        topbarBg: data.topbarBg?.trim() || '#ffffff',
        textPrimary: data.textPrimary?.trim() || '#141d46',
        textSecondary: data.textSecondary?.trim() || '#8A98AC',
        fontFamily: data.fontFamily?.trim() || "'Mukta Vaani', sans-serif",
        fontSize: data.fontSize?.trim() || '16',
        fontWeight: data.fontWeight?.trim() || '300',
        borderColor: data.borderColor?.trim() || '#e6e6e6',
        menuBg: data.menuBg?.trim() || '#ffffff',
        menuText: data.menuText?.trim() || '#8A98AC',
        menuActiveBg: data.menuActiveBg?.trim() || '#5a8dee',
        menuActiveText: data.menuActiveText?.trim() || '#ffffff',
      };

      const updateResult = await collection.updateOne(
        {
          _id: this.normalizeId(this.branchId),
          license: this.normalizeId(this.licenseId),
        },
        { $set: { theme_settings: themeSettings } }
      );

      return {
        status: true,
        data: themeSettings,
        message: 'Theme settings updated successfully',
      };
    } catch (error) {
      console.error('Error in editThemeSettings:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async updateBranchLogoModel(file, branchId) {
    try {
      if (!file) {
        return {
          status: true,
          data: 'store.png',
          message: 'Image uploaded successfully',
        };
      }

      // File is already uploaded by multer middleware.
      // Return a public path under /uploads so the browser can
      // load it from whatever host/port is serving the dashboard.
      // This mirrors the behaviour used for kiosk images and
      // avoids hard-coding localhost:5000 which breaks when the
      // API runs on a different port (e.g. 5555).
      const fileUrl = `/uploads/${file.filename}`;

      return {
        status: true,
        data: fileUrl,
        message: 'Image uploaded successfully',
      };
    } catch (error) {
      console.error('Error in updateBranchLogoModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getForgotUserDetails(email, req = null) {
    try {
      // Installation-wide, before looking up an account, so this error does
      // not disclose whether the submitted email exists.
      if (
        require('../utils/recovery-codes').enabled() &&
        !(process.env.BREVO_API_KEY || process.env.SENDINBLUE_KEY)
      ) {
        return {
          status: false,
          data: null,
          message:
            'Email recovery is unavailable on this installation. Use an offline recovery code, or ask your administrator for help.',
        };
      }
      const usersCollection = await this.getCollection('users');
      /*
       * String(), because this value came from a request body and Mongo reads
       * an object as operators. `{"email": {"$ne": null}}` posted to
       * forgot-password would otherwise match the FIRST user in the shop and
       * send a reset link for somebody else's account.
       *
       * The controller's regex happens to reject an object today - test()
       * stringifies it to "[object Object]" - but that is the caller being
       * careful, and this method is what actually touches the database.
       */
      const user = await usersCollection.findOne({ email: String(email) });

      if (!user) {
        return {
          status: true,
          data: null,
          message:
            'Thank you for your forgotten password request. If that email address exists in our database, you will receive an email to that address shortly. If you do not receive the password reset message within a few moments, please check your spam folder.',
        };
      }

      // Set expiry date (10 minutes from now) - matching PHP
      const expireDate = new Date(Date.now() + 10 * 60 * 1000);
      await usersCollection.updateOne({ _id: user._id }, { $set: { expire_date: expireDate } });

      /*
       * The link goes to THIS shop, not to a hardcoded address.
       *
       * This used to read SERVER_NAME, which is set on no process in the
       * estate, fall through to the localhost branch, and mail every hosted
       * shop a link to http://localhost:3000 - the recipient's own computer,
       * on a port with nothing listening. Self-service recovery has therefore
       * never once worked for a cloud shop, which is why a locked-out owner
       * needed five days and a database session to get back into his till.
       *
       * publicPageUrl derives the address from the request, but accepts only a
       * host on a domain we actually run: a link inside an email we send is
       * exactly what password-reset poisoning targets.
       */
      const basePath = publicPageUrl(req, 'forgotpassword.html', {
        forgotpassword_Id: user.userkey,
      });

      if (!basePath) {
        /* Refused rather than sent. A dead link and a poisoned link are both
           worse than an error somebody can see and fix. */
        console.error(
          '[forgot-password] no trustworthy public address for this shop - ' +
            'set PUBLIC_BASE_URL. No email sent.'
        );
        return {
          status: false,
          data: null,
          message: 'Password reset is not configured for this shop. Please contact support.',
        };
      }

      // Send email via Brevo (matching PHP lines 714-729)
      try {
        const brevoApiKey = process.env.BREVO_API_KEY || process.env.SENDINBLUE_KEY;

        if (!brevoApiKey) {
          console.warn('BREVO_API_KEY not configured, skipping email send');
          return {
            status: true,
            data: null,
            message:
              'Thank you for your forgotten password request. If that email address exists in our database, you will receive an email to that address shortly. If you do not receive the password reset message within a few moments, please check your spam folder.',
          };
        }

        const SibApiV3Sdk = require('sib-api-v3-sdk');
        const defaultClient = SibApiV3Sdk.ApiClient.instance;
        const apiKey = defaultClient.authentications['api-key'];
        apiKey.apiKey = brevoApiKey;

        const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

        sendSmtpEmail.to = [{ email: email, name: user.username }];
        sendSmtpEmail.templateId = 5; // Brevo template ID (matching PHP)
        sendSmtpEmail.params = {
          bodyMessage: `${user.firstname || ''} ${user.lastname || ''}`.trim(),
          mailpath: basePath,
        };
        sendSmtpEmail.headers = {
          'X-Mailin-custom': 'custom_header_1:custom_value_1|custom_header_2:custom_value_2',
        };

        await apiInstance.sendTransacEmail(sendSmtpEmail);

        return {
          status: true,
          data: null,
          message:
            'Thank you for your forgotten password request. If that email address exists in our database, you will receive an email to that address shortly. If you do not receive the password reset message within a few moments, please check your spam folder.',
        };
      } catch (emailError) {
        console.error('Error sending email via Brevo:', emailError);
        console.error('Brevo error details:', emailError.response?.body || emailError.message);

        // Still return success to not reveal if email exists (security best practice)
        // This matches PHP behavior
        return {
          status: true,
          data: null,
          message:
            'Thank you for your forgotten password request. If that email address exists in our database, you will receive an email to that address shortly. If you do not receive the password reset message within a few moments, please check your spam folder.',
        };
      }
    } catch (error) {
      console.error('Error in getForgotUserDetails:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getDasboardSalesCountModel() {
    try {
      const collection = await this.getCollection();
      const branchId = this.normalizeId(this.branchId);
      const licenseId = this.normalizeId(this.licenseId);

      const branchDetails = await collection.findOne({
        _id: branchId,
        license: licenseId,
      });

      if (!branchDetails || !branchDetails.created_date) {
        return {
          status: false,
          data: 0,
          message: 'Branch details not found',
        };
      }

      const createdDate = new Date(branchDetails.created_date);
      const currentDate = new Date();
      const diffTime = Math.abs(currentDate - createdDate);
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

      return {
        status: true,
        data: diffDays,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getDasboardSalesCountModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async restoreBackup(ids) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          status: false,
          data: null,
          message: 'No IDs provided for restoration',
        };
      }

      const collection = await this.getCollection(this.backupCollection);
      const objectIds = ids.map((id) => this.normalizeId(id)).filter(Boolean);

      const condition = {
        $and: [{ _id: { $in: objectIds } }, { license: this.normalizeId(this.licenseId) }],
      };

      const restoreDocs = await collection.find(condition).toArray();

      if (!restoreDocs || restoreDocs.length === 0) {
        return {
          status: false,
          data: null,
          message: 'No documents found for restoration',
        };
      }

      if (restoreDocs.some((doc) => doc.body_discarded === true)) {
        return {
          status: false,
          data: null,
          message: 'No documents found for restoration',
        };
      }

      // Restore each document to its original collection
      let restoredCount = 0;
      const errors = [];

      for (const doc of restoreDocs) {
        const collectionName = doc.document_name;
        if (!collectionName) continue;

        try {
          const targetCollection = await this.getCollection(collectionName);
          const backupData = { ...doc };
          delete backupData.document_name;
          delete backupData.document_backup_date;

          // Check if document with this _id already exists
          const existingDoc = await targetCollection.findOne({ _id: backupData._id });

          if (existingDoc) {
            // Document exists, replace it
            await targetCollection.replaceOne({ _id: backupData._id }, backupData);
          } else {
            // Document doesn't exist, insert it
            // Remove _id to let MongoDB generate a new one to avoid conflicts
            const insertData = { ...backupData };
            delete insertData._id;

            const result = await targetCollection.insertOne(insertData);
          }
          restoredCount++;
        } catch (docError) {
          console.error(
            `❌ Error restoring document ${doc._id} to ${collectionName}:`,
            docError.message
          );
          errors.push({ id: doc._id, collection: collectionName, error: docError.message });
        }
      }

      console.log(
        `📊 Restore summary: ${restoredCount} documents restored, ${errors.length} errors`
      );

      // Delete from backup collection
      await collection.deleteMany(condition);

      return {
        status: true,
        data: null,
        message: 'Document Restored successfully',
      };
    } catch (error) {
      console.error('Error in restoreBackup:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getSettingTableRow(id) {
    try {
      const collection = await this.getCollection(this.backupCollection);
      const param = await collection.findOne({
        _id: this.normalizeId(id),
        license: this.normalizeId(this.licenseId),
      });

      if (param && param.body_discarded !== true) {
        // Reuse the sale detail adapter for Captain and legacy item/date shapes,
        // using this authorized backup, never a current sale with the same ID.
        if (param.document_name === 'sales') {
          return require('../repositories/sale.repository').getLegacyDetails(id, {
            snapshot: param,
          });
        }
        return {
          status: true,
          data: BaseModel.simplifyFields(param),
          message: 'success',
        };
      }

      return {
        status: false,
        data: null,
        message: 'error',
      };
    } catch (error) {
      console.error('Error in getSettingTableRow:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async autoSuggestionRecycleBinTableField(field, collectionName, query = null) {
    try {
      let branchCondition;
      if (collectionName === 'users') {
        branchCondition = {
          'branch_access.branch_id': this.normalizeId(this.branchId),
          document_name: collectionName,
        };
      } else if (collectionName === 'branches') {
        branchCondition = {
          created_by_id: this.normalizeId(this.user?._id),
          document_name: collectionName,
        };
      } else {
        branchCondition = {
          branch_id: this.normalizeId(this.branchId),
          document_name: collectionName,
        };
      }

      const collection = await this.getCollection(this.backupCollection);
      const filter = {
        $and: [
          query ? { [field]: { $regex: searchPattern(query), $options: 'i' } } : {},
          branchCondition,
          { license: this.normalizeId(this.licenseId) },
        ],
      };

      const cursor = await collection.find(filter).limit(5);
      const data = await cursor.toArray();

      const fieldValues = [];
      for (const item of data) {
        if (item[field] && !fieldValues.includes(item[field])) {
          fieldValues.push(item[field]);
        }
      }

      const suggest = [...new Set(fieldValues)];

      return {
        status: true,
        data: suggest,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in autoSuggestionRecycleBinTableField:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getAllCollectionTotal() {
    try {
      const collectionNames = [
        'sales',
        'receivings',
        'customers',
        'suppliers',
        'categories',
        'expenses',
        'stocklogs',
        'recycle_bin',
        'items',
      ];

      const returnValue = {};

      for (const docValue of collectionNames) {
        let condition;
        if (docValue === 'items') {
          condition = {
            'branch_access.branch_id': this.normalizeId(this.branchId),
            license: this.normalizeId(this.licenseId),
          };
        } else {
          condition = {
            branch_id: this.normalizeId(this.branchId),
            license: this.normalizeId(this.licenseId),
          };
        }

        const collection = await this.getCollection(docValue);
        const count = await collection.countDocuments(condition);
        returnValue[docValue] = count || 0;
      }

      const data = {
        sales_count: returnValue.sales || 0,
        receivings_count: returnValue.receivings || 0,
        customers_count: returnValue.customers || 0,
        suppliers_count: returnValue.suppliers || 0,
        categories_count: returnValue.categories || 0,
        expenses_count: returnValue.expenses || 0,
        stock_activity_log_count: returnValue.stocklogs || 0,
        recycle_bin_count: returnValue.recycle_bin || 0,
        items_count: returnValue.items || 0,
      };

      return {
        status: true,
        data: data,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getAllCollectionTotal:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async storedImageModel(data) {
    try {
      const collection = await this.getCollection();
      const usersCollection = await this.getCollection('users');

      const logoValue = data.setting_logo_value?.trim() || 'store.png';
      // The merged Branch edit page names its target; absent, the session
      // branch as before. License filter keeps it inside this shop.
      const targetBranchId =
        data.target_branch_id && /^[0-9a-fA-F]{24}$/.test(String(data.target_branch_id))
          ? data.target_branch_id
          : this.branchId;

      await collection.updateOne(
        {
          _id: this.normalizeId(targetBranchId),
          license: this.normalizeId(this.licenseId),
        },
        { $set: { logo: logoValue } }
      );

      await usersCollection.updateMany(
        {
          'branch_access.branch_id': this.normalizeId(targetBranchId),
          license: this.normalizeId(this.licenseId),
        },
        { $set: { 'branch_access.$.branch_image': logoValue } }
      );

      return {
        status: true,
        data: logoValue,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in storedImageModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async branchImageDeleteModel(imageUrl) {
    try {
      // Delete from S3 or local storage would happen here
      // For now, just reset to default
      const defaultImage = 'store.png';
      const result = await this.storedImageModel({
        setting_logo_value: defaultImage,
      });

      return result;
    } catch (error) {
      console.error('Error in branchImageDeleteModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async updateBranchNameInCollections(branchDetails) {
    try {
      const branchId = this.normalizeId(branchDetails.id);
      const newBranchName = branchDetails.branch_name;

      // Collections to update with branch_id filter
      const collectionsWithBranchId = [
        'sales',
        'receivings',
        'customers',
        'suppliers',
        'recycle_bin',
        'categories',
      ];

      // Update each collection
      for (const collectionName of collectionsWithBranchId) {
        try {
          const collection = await this.getCollection(collectionName);
          await collection.updateMany(
            { branch_id: branchId },
            { $set: { branch_name: newBranchName } }
          );
        } catch (err) {
          console.warn(`Failed to update branch_name in ${collectionName}:`, err.message);
        }
      }

      // Items collection uses branch_access array
      try {
        const itemsCollection = await this.getCollection('items');
        await itemsCollection.updateMany(
          { 'branch_access.branch_id': branchId },
          { $set: { 'branch_access.$.branch_name': newBranchName } }
        );
      } catch (err) {
        console.warn('Failed to update branch_name in items:', err.message);
      }

      // Users collection uses branch_access array
      try {
        const usersCollection = await this.getCollection('users');
        await usersCollection.updateMany(
          { 'branch_access.branch_id': branchId },
          { $set: { 'branch_access.$.branch_name': newBranchName } }
        );
      } catch (err) {
        console.warn('Failed to update branch_name in users:', err.message);
      }

      return true;
    } catch (error) {
      console.error('Error in updateBranchNameInCollections:', error);
      throw error;
    }
  }
}

module.exports = SettingModel;
