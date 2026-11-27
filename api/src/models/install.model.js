// src/models/install_model.js
const { ObjectId } = require('mongodb');
const BaseModel = require('./base.model');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { WALK_IN_NAME, GENERAL_SUPPLIER_NAME } = require('../utils/default-parties');

class InstallModel extends BaseModel {
  constructor() {
    super();
    this.collectionName = 'branches';
  }

  async installInsertDocument(data) {
    try {
      const licenseId = new ObjectId(data.register_license);

      // Check if user already exists
      const userCollection = await this.getCollection('users');
      const existingUser = await userCollection.findOne({
        $or: [
          { username: data.register_username },
          { email: data.register_useremail },
          { license: licenseId },
        ],
      });

      // If user exists, return error
      if (existingUser) {
        let duplicateField = '';
        if (existingUser.username === data.register_username) {
          duplicateField = 'username';
        } else if (existingUser.email === data.register_useremail) {
          duplicateField = 'email';
        } else if (existingUser.license.toString() === licenseId.toString()) {
          duplicateField = 'license';
        }
        return {
          status: false,
          data: '',
          message: `This ${duplicateField} already exists in our system`,
        };
      }

      // Create access permissions
      const access = {
        dashboard: { read: true },
        sales: { read: true, write: true, delete: true },
        receiving: { read: true, write: true, delete: true },
        customer: { read: true, write: true, delete: true },
        supplier: { read: true, write: true, delete: true },
        category: { read: true, write: true, delete: true },
        item: { read: true, write: true, delete: true },
        user: { read: true, write: true, delete: true },
        branch: { read: true, write: true, delete: true },
        report: { read: true, write: true, delete: true },
        plan: { read: false },
      };

      // Generate user secret key
      const random =
        new Date().toISOString().slice(0, 10).replace(/-/g, '') + Math.floor(Math.random() * 10000);
      const usersecretkey = await bcrypt.hash(random, 10);

      // Create timestamps
      const now = new Date();
      const oneYearLater = new Date(now);
      oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);

      // Insert user
      const userInsertResult = await userCollection.insertOne({
        branch_access: '',
        plan: {
          name: 'premium',
          max_sales: 'unlimited',
          plan_expire: oneYearLater,
        },
        userkey: usersecretkey.trim(),
        firstname: (data.register_firstname || '').trim(),
        lastname: (data.register_lastname || '').trim(),
        username: data.register_username.trim(),
        password: data.register_userpassword.trim(),
        usertype: 'super_admin',
        email: data.register_useremail.trim(),
        apikey: '',
        access: access,
        image: 'user.svg',
        activate: true,
        printing_design: '',
        register_status: 'Closed',
        created_date: now,
        updated_date: now,
        expired_date: oneYearLater,
        created_by: data.register_username,
        created_by_id: '',
        updated_by: data.register_username,
        updated_by_id: '',
        license: licenseId,
        plan_access: [],
      });

      const userId = userInsertResult.insertedId;

      // Load print templates
      const regularBodyPrint = fs.readFileSync(
        path.join(__dirname, '../json/print_a4html.txt'),
        'utf8'
      );
      const thermalBodyPrint = fs.readFileSync(
        path.join(__dirname, '../json/print_standard_html.txt'),
        'utf8'
      );

      // Create branch
      const branchCollection = await this.getCollection(this.collectionName);
      const branchInsertResult = await branchCollection.insertOne({
        theme: 'blue',
        branch_name: data.register_companyname.trim(),
        business_type: String(
          (data.businessType !== undefined ? data.businessType : data.business_type) || ''
        )
          .trim()
          .slice(0, 80),
        store_address: (data.register_address || '').trim(),
        store_email: data.register_useremail.trim(),
        store_telephone: (data.register_fullnumber || '').trim(),
        country: (data.register_country || '').trim(),
        country_id: data.register_countryid || '',
        state: (data.register_state || '').trim(),
        city: '',
        pincode: '',
        website: '',
        logo: 'store.png',
        languge: 'ar',
        currency: '$',
        currency_text: 'جنية / EGP or $',
        currency_type: '$',
        currency_value: [{ currency_text: 'EGP', currency_sign: '$' }],
        time_zone: (data.register_timezone || '').trim(),
        printing_address: (data.register_address || '').trim(),
        notification_range: '10',
        discount: '',
        discount_amount: '0',
        discount_percentage: '0.00',
        sales_prefix: 'S',
        receiving_prefix: 'RID',
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
        print_type: 'standard',
        printing_size: 'receipt_medium',
        print_character: 'default',
        header_print: 'default',
        footer_print: 'Thank you for shopping...!',
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
        client_dateformat: 'dd/mm/yyyy',
        time_format: 'enable',
        server_dateformat: 'd/m/Y',
        dateformat_text: '01/01/2018 -- dd/mm/yyyy',
        default_customer: '',
        default_supplier: '',
        created_date: now,
        updated_date: now,
        created_by: '',
        created_by_id: '',
        updated_by: '',
        updated_by_id: '',
        register: [],
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
      });

      const branchId = branchInsertResult.insertedId;

      // Update user with branch access
      const userBranch = [
        {
          branch_id: branchId,
          branch_name: data.register_companyname,
          branch_image: 'store.png',
        },
      ];
      const printBranch = [
        {
          branch_id: branchId,
          printing_design: 'standard',
          printing_max_char: 'default',
          printing_size: 'receipt_medium',
        },
      ];

      await userCollection.updateOne(
        { _id: userId, license: licenseId },
        {
          $set: {
            branch_access: userBranch,
            printing_design: printBranch,
            created_by_id: userId,
            updated_by_id: userId,
          },
        }
      );

      const countriesData = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../json/countries.json'), 'utf8')
      );
      const selectedCountry = countriesData.countries.find(
        (countryData) => countryData.value === data.register_country
      );
      const sortname = selectedCountry ? selectedCountry.sortname : '';

      // Create default customer
      const customerCollection = await this.getCollection('customers');
      const customerInsertResult = await customerCollection.insertOne({
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
      });

      // Create default supplier
      const supplierCollection = await this.getCollection('suppliers');
      const supplierInsertResult = await supplierCollection.insertOne({
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
      });

      // Create a default "General" customer category so the customer form has a
      // ready group and a new shop need not create one before its first save.
      const customerCategoryCollection = await this.getCollection('customer_category');
      await customerCategoryCollection.insertOne({
        branch_id: branchId,
        branch_name: data.register_companyname.trim(),
        name: 'General',
        description: 'Default customer group.',
        created_date: now,
        updated_date: now,
        created_by: data.register_username,
        created_by_id: userId,
        updated_by: data.register_username,
        updated_by_id: userId,
        license: licenseId,
      });

      // Update branch with default values
      await branchCollection.updateOne(
        { _id: branchId, license: licenseId },
        {
          $set: {
            default_customer: customerInsertResult.insertedId,
            default_supplier: supplierInsertResult.insertedId,
            created_by: data.register_username,
            created_by_id: userId,
            updated_by: data.register_username,
            updated_by_id: userId,
          },
        }
      );

      // Add email fields
      await branchCollection.updateOne(
        { _id: branchId, license: licenseId },
        {
          $push: {
            email_fields: {
              branch_id: branchId,
              email_address: [{ email: data.register_useremail }],
              report_type: 'daily',
              send_mail: 'mail_off',
            },
          },
        }
      );

      // Create default unit
      const unitCollection = await this.getCollection('unit');
      const unitInsertResult = await unitCollection.insertOne({
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
      });

      // A new shop always starts with one default category and item.
      // Demo samples are not installed, even if an old caller asks for them.
      await this.insertDefaultCategoryAndItem({
        branchId,
        branchName: data.register_companyname.trim(),
        userId,
        username: data.register_username,
        licenseId,
        now,
        userBranch,
        supplierId: supplierInsertResult.insertedId,
        supplierName: GENERAL_SUPPLIER_NAME,
        unitId: unitInsertResult.insertedId,
      });

      return {
        status: true,
        data: '',
        message: 'Account created successfully',
      };
    } catch (error) {
      console.error('Error in installInsertDocument:', error);

      // Handle MongoDB duplicate key errors (E11000)
      if (error.code === 11000) {
        const duplicateField = Object.keys(error.keyPattern || {})[0] || 'field';
        const duplicateValue = error.keyValue ? error.keyValue[duplicateField] : 'unknown';
        const collectionMatch = error.message.match(/collection: [\w.]+\.(\w+)/);
        const collection = collectionMatch ? collectionMatch[1] : 'database';

        return {
          status: false,
          data: '',
          message: `Duplicate ${duplicateField} '${duplicateValue}' already exists in ${collection}. Please use a different value.`,
        };
      }

      // Handle other errors
      return {
        status: false,
        data: '',
        message: error.message || 'An error occurred during installation',
      };
    }
  }

  async insertDefaultCategoryAndItem(params) {
    try {
      const {
        branchId,
        branchName,
        userId,
        username,
        licenseId,
        now,
        userBranch,
        supplierId,
        supplierName,
        unitId,
      } = params;

      // Insert default category
      const categoryCollection = await this.getCollection('categories');
      const categoryInsertResult = await categoryCollection.insertOne({
        name: 'Supermarkets',
        discount_percentage: 0.0,
        discount_amount: 0,
        description:
          'A supermarket is a self-service shop offering a wide variety of food, beverages and household products, organized into sections. This kind of store is larger and has a wider selection than earlier grocery stores, but is smaller and more limited in the range of merchandise than a hypermarket or big-box market',
        branch_id: branchId,
        branch_name: branchName,
        image: '',
        created_date: now,
        created_by: username,
        created_by_id: userId,
        updated_date: now,
        updated_by: username,
        updated_by_id: username,
        license: licenseId,
      });

      // Insert default item
      const itemCollection = await this.getCollection('items');
      await itemCollection.insertOne({
        branch_id: branchId,
        branch_name: branchName,
        category_id: categoryInsertResult.insertedId,
        license: licenseId,
        date: now,
        item_status: 'regular',
        itemid: '',
        barcode_id: '',
        created_date: now,
        created_by: username,
        created_by_id: userId,
        branch_access: userBranch,
        category_name: 'Supermarkets',
        supplier_id: supplierId,
        supplier_name: supplierName,
        discount_percentage: 0.0,
        discount_amount: 0,
        mrp_price: 190.0,
        company_price: 130.0,
        selling_price: 138.0,
        items_mfg_date: null,
        items_expiry_date: null,
        available_quantity: 100,
        image: '',
        multi_image: [],
        sort_order: 1,
        description:
          'Fortune Sunlite Oil is refined sunflower oil that is healthy and tasty. Its high boiling point makes it an excellent choice for everyday cooking.',
        track_inventory: true,
        name: 'Fortune Sunlite Refined Sunflower Oil 1L',
        updated_date: now,
        updated_by: username,
        updated_by_id: username,
        unit: 'qty',
        unit_id: unitId,
      });
    } catch (error) {
      console.error('Error in insertDefaultCategoryAndItem:', error);
      // Don't throw error, just log it - installation can continue without default data
    }
  }

  /**
   * Cleanup all data by license ID
   * Removes all records from all collections that have the specified license
   */
  async cleanupByLicense(licenseId) {
    try {
      const license = new ObjectId(licenseId);

      // Define all collections that have license field
      const collections = [
        'users',
        'branches',
        'customers',
        'suppliers',
        'categories',
        'items',
        'unit',
        'sales',
        'receiving',
        'stocklogs',
        'payments',
        'reports',
        'notifications',
        'settings',
      ];

      const deletionResults = {};
      let totalDeleted = 0;

      // Delete from each collection
      for (const collectionName of collections) {
        try {
          const collection = await this.getCollection(collectionName);
          const result = await collection.deleteMany({ license: license });
          deletionResults[collectionName] = result.deletedCount;
          totalDeleted += result.deletedCount;
        } catch (error) {
          console.error(`Error deleting from ${collectionName}:`, error.message);
          deletionResults[collectionName] = `Error: ${error.message}`;
        }
      }

      return {
        status: true,
        data: {
          license: licenseId,
          totalDeleted: totalDeleted,
          details: deletionResults,
        },
        message: `Successfully deleted ${totalDeleted} records across all collections for license ${licenseId}`,
      };
    } catch (error) {
      console.error('Error in cleanupByLicense:', error);
      return {
        status: false,
        data: '',
        message: error.message || 'An error occurred during cleanup',
      };
    }
  }
}

module.exports = new InstallModel();
