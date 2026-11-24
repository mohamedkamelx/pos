const { recordedUserName } = require('../utils/recorded-user-name');
const { reportableSales, reportSaleTotal } = require('../helpers/reportable-sales');
const { lineCostExpression } = require('../helpers/sale-cost');
const Money = require('../utils/currency');
const itemText = require('../utils/item-localization');
const mongoose = require('mongoose');
const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const BaseModel = require('../models/base.model');
const { ensureIndexOnce } = require('../db/ensure-index');
const { formatDate } = require('../utils/helpers');

const billNumber = require('../utils/bill-number');
const StockLogsRepository = require('./stock-log.repository');
const { PAYMENT_STATUS } = require('../constants');
const moment = require('moment-timezone');

const activeTenantFilter = () => ({
  ...(BaseModel.license ? { license: BaseModel.license } : {}),
  ...(BaseModel.currentBranch ? { branch_id: BaseModel.currentBranch } : {}),
});

const round = (value, decimals = 2) => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, decimals);
  return value && !Number.isNaN(value) ? Math.round(value * factor) / factor : 0;
};

const toNumberSafe = (value, fallback = 0) => {
  if (value === null || typeof value === 'undefined') {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === 'null' || trimmed === 'nan') {
      return 0;
    }
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : 0;
  }

  const fb = Number(fallback);
  return Number.isFinite(fb) ? fb : 0;
};

const roundQty = (value) => Math.round(toNumberSafe(value, 0) * 1000) / 1000;

const normalizeReturnItemKey = (item = {}) =>
  String(item.line_id || item.item_id || item.item || item.id || item._id || '');

const addQtyToMap = (map, key, qty) => {
  if (!key) return;
  map.set(key, roundQty((map.get(key) || 0) + roundQty(qty)));
};

const buildReturnedQtyMap = (itemsReturnBlocks = []) => {
  const returned = new Map();
  if (!Array.isArray(itemsReturnBlocks)) return returned;

  for (const block of itemsReturnBlocks) {
    const values = block?.returnArray?.returnValue;
    if (!Array.isArray(values)) continue;

    for (const item of values) {
      addQtyToMap(returned, normalizeReturnItemKey(item), item.item_quantity);
    }
  }

  return returned;
};

const buildReturnSignature = (saleObjectId, returnItems = [], payload = {}) => {
  const normalizedItems = (Array.isArray(returnItems) ? returnItems : [])
    .map((item) => ({
      item_id: normalizeReturnItemKey(item),
      qty: roundQty(item.item_quantity),
      price: round(toNumberSafe(item.item_price, 0), 2),
      total: round(toNumberSafe(item.total_amount, 0), 2),
    }))
    .filter((item) => item.item_id && item.qty > 0)
    .sort((a, b) => a.item_id.localeCompare(b.item_id));

  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        sale_id: String(saleObjectId),
        items: normalizedItems,
        extra_discount: round(toNumberSafe(payload.extra_discount, 0), 2),
        extra_discount_type: payload.extra_discount_type || '',
        round_off_check: Boolean(payload.round_off_check),
      })
    )
    .digest('hex');
};

class SalesRepository {
  constructor(defaultModel) {
    this.defaultModel = defaultModel || null;
  }

  getModel(SaleModel) {
    if (SaleModel) {
      return SaleModel;
    }

    if (!this.defaultModel) {
      this.defaultModel = require('../models/sale.model');
    }

    return this.defaultModel;
  }

  async create(data, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    const doc = new Model({ ...data, origin: require('../utils/sale-origin').stamp(data) });
    await doc.save();
    return doc;
  }

  async paginate(filter, options, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.paginate(filter, options);
  }

  async getLegacyDetails(id, { SaleModel, snapshot } = {}) {
    try {
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return { status: false, data: null, message: 'Invalid sale id' };
      }

      const saleObjectId = new mongoose.Types.ObjectId(id);
      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');
      const recycleBinCollection = db.collection('recycle_bin');
      const customersCollection = db.collection('customers');
      const branchesCollection = db.collection('branches');

      const filter = {
        _id: saleObjectId,
        ...(BaseModel.license ? { license: BaseModel.license } : {}),
        ...(BaseModel.currentBranch ? { branch_id: BaseModel.currentBranch } : {}),
      };

      let saleDoc = snapshot || (await salesCollection.findOne(filter));

      // Fallback for deleted sales: if the sale is not present in the live
      // `sales` collection, try to load a backup copy from the
      // `recycle_bin`. This enables viewing / printing sales that have been
      // moved to the Recycle Bin while keeping the primary behaviour
      // unchanged for active sales.
      if (!saleDoc) {
        const recycleFilter = {
          _id: saleObjectId,
          document_name: 'sales',
          body_discarded: { $ne: true },
          ...(BaseModel.currentBranch ? { branch_id: BaseModel.currentBranch } : {}),
          ...(BaseModel.license ? { license: BaseModel.license } : {}),
        };

        const backupDoc = await recycleBinCollection.findOne(recycleFilter);

        if (!backupDoc) {
          return { status: false, data: null, message: 'Sale not found' };
        }

        saleDoc = backupDoc;
      }

      const doc = { ...saleDoc };

      // Normalise legacy extra discount fields so that the sales edit and
      // return screens always receive meaningful values, even for older
      // PHP-created sales that only stored sale_extra_discount.
      const rawExtraDiscValue =
        doc.extra_discount !== undefined && doc.extra_discount !== null
          ? Number(doc.extra_discount)
          : 0;
      const rawSaleExtraDiscValue =
        doc.sale_extra_discount !== undefined && doc.sale_extra_discount !== null
          ? Number(doc.sale_extra_discount)
          : 0;

      const extraDiscNum = Number.isFinite(rawExtraDiscValue) ? rawExtraDiscValue : 0;
      const saleExtraDiscNum = Number.isFinite(rawSaleExtraDiscValue) ? rawSaleExtraDiscValue : 0;

      let extraDiscountTypeRaw =
        typeof doc.extra_discount_type === 'string'
          ? doc.extra_discount_type.toLowerCase().trim()
          : '';

      // Map legacy labels to the values expected by the frontend helpers
      if (extraDiscountTypeRaw === 'percentage') {
        extraDiscountTypeRaw = 'percent';
      } else if (extraDiscountTypeRaw === 'fixed' || extraDiscountTypeRaw === 'amount') {
        extraDiscountTypeRaw = 'price';
      }

      if (extraDiscountTypeRaw) {
        doc.extra_discount_type = extraDiscountTypeRaw;
      }

      // For legacy amount-based discounts that only persisted the final
      // sale_extra_discount, backfill extra_discount so the edit form can
      // display the correct value. Percent-based discounts already store the
      // input percentage in extra_discount, so we leave those untouched.
      if (
        (typeof doc.extra_discount === 'undefined' ||
          doc.extra_discount === null ||
          extraDiscNum === 0) &&
        saleExtraDiscNum > 0 &&
        extraDiscountTypeRaw !== 'percent'
      ) {
        doc.extra_discount = saleExtraDiscNum;
      }

      // Backfill legacy note fields for Node-created sales so that
      // sales_view.js can always rely on sales_description and
      // payment_description even when only generic notes + payments
      // were stored by the Node controllers.
      if (
        (typeof doc.sales_description === 'undefined' ||
          doc.sales_description === null ||
          (typeof doc.sales_description === 'string' && !doc.sales_description.trim())) &&
        typeof doc.notes === 'string' &&
        doc.notes.trim()
      ) {
        doc.sales_description = doc.notes;
      }

      if (
        typeof doc.payment_description === 'undefined' ||
        doc.payment_description === null ||
        (typeof doc.payment_description === 'string' && !doc.payment_description.trim())
      ) {
        let paymentNote = '';
        if (Array.isArray(doc.payments) && doc.payments.length > 0) {
          const firstPayment = doc.payments[0] || {};
          if (typeof firstPayment.reference === 'string' && firstPayment.reference.trim()) {
            paymentNote = firstPayment.reference.trim();
          } else if (typeof firstPayment.notes === 'string' && firstPayment.notes.trim()) {
            paymentNote = firstPayment.notes.trim();
          }
        }

        if (paymentNote) {
          doc.payment_description = paymentNote;
        }
      }

      // Legacy screens expect these identifiers
      if (!doc.sales_id && doc.invoice_number) {
        doc.sales_id = doc.invoice_number;
      }
      if (!doc.invoice_number && doc.sales_id) {
        doc.invoice_number = doc.sales_id;
      }
      if (!doc.sale_no) {
        doc.sale_no = doc.sales_id || doc.invoice_number || (doc._id ? doc._id.toString() : '');
      }

      let branchDoc = null;
      const branchId = doc.branch_id || doc.branch || BaseModel.currentBranch || null;

      if (branchId) {
        let normalizedBranchId = branchId;
        if (branchId instanceof mongoose.Types.ObjectId) {
          normalizedBranchId = branchId;
        } else if (mongoose.Types.ObjectId.isValid(String(branchId))) {
          normalizedBranchId = new mongoose.Types.ObjectId(String(branchId));
        }

        branchDoc = await branchesCollection.findOne({
          _id: normalizedBranchId,
          ...(BaseModel.license ? { license: BaseModel.license } : {}),
        });
        if (branchDoc && branchDoc._id) {
          doc.branch_id = branchDoc._id;

          if (
            typeof doc.printing_address === 'undefined' ||
            doc.printing_address === null ||
            (typeof doc.printing_address === 'string' && !doc.printing_address.trim())
          ) {
            if (typeof branchDoc.printing_address === 'string') {
              doc.printing_address = branchDoc.printing_address;
            }
          }
        }
      }

      let print_sale_notes = false;
      let customer_print = true;
      let print_logoimg = false;
      let receipt_barcode = true;
      let logo = '';
      if (branchDoc) {
        if (typeof branchDoc.print_sale_notes === 'boolean') {
          print_sale_notes = branchDoc.print_sale_notes;
        }
        if (typeof branchDoc.customer_print === 'boolean') {
          customer_print = branchDoc.customer_print;
        }
        if (typeof branchDoc.print_logoimg === 'boolean') {
          print_logoimg = branchDoc.print_logoimg;
        }
        if (typeof branchDoc.receipt_barcode === 'boolean') {
          receipt_barcode = branchDoc.receipt_barcode;
        }
        if (branchDoc.logo) {
          logo = branchDoc.logo;
        }
      }

      doc.customer_print = customer_print;
      doc.print_logoimg = print_logoimg;
      doc.print_sale_notes = print_sale_notes;
      doc.receipt_barcode = receipt_barcode;
      // Read the saved footer for every print, including an explicit removal.
      // A browser's settings cache may still contain an older shop image.
      doc.footer_image = String(branchDoc?.footer_image || '');
      doc.footer_image_caption = String(branchDoc?.footer_image_caption || '');
      doc.receipt_designs = branchDoc?.receipt_designs || null;
      if (doc.receipt_designs) {
        for (const key of [
          'branch_name',
          'printing_address',
          'store_telephone',
          'store_email',
          'website',
          'branch_fssai_number',
          'country',
          'invoice_terms',
          'quote_default_signature',
        ]) {
          doc[key] = branchDoc[key];
        }
        doc.logo = branchDoc.logo || '';
      }
      if (logo && !doc.logo) {
        doc.logo = logo;
      }

      let customerObjectId = null;
      if (doc.customer_id) {
        if (doc.customer_id instanceof mongoose.Types.ObjectId) {
          customerObjectId = doc.customer_id;
        } else if (mongoose.Types.ObjectId.isValid(String(doc.customer_id))) {
          customerObjectId = new mongoose.Types.ObjectId(String(doc.customer_id));
        }
      } else if (doc.customer) {
        if (doc.customer instanceof mongoose.Types.ObjectId) {
          customerObjectId = doc.customer;
        } else if (mongoose.Types.ObjectId.isValid(String(doc.customer))) {
          customerObjectId = new mongoose.Types.ObjectId(String(doc.customer));
        }
        if (customerObjectId && !doc.customer_id) {
          doc.customer_id = customerObjectId;
        }
      }

      if (customerObjectId) {
        const customerFilter = {
          _id: customerObjectId,
          ...(BaseModel.license ? { license: BaseModel.license } : {}),
          ...(BaseModel.currentBranch ? { branch_id: BaseModel.currentBranch } : {}),
        };

        const customerData = await customersCollection.findOne(customerFilter);

        if (customerData) {
          doc.customer_name = doc.customer_name || customerData.name || '';
          doc.customer_phone = doc.customer_phone || customerData.phone || '';
          doc.customer_email = doc.customer_email || customerData.email || '';
          doc.customer_address = doc.customer_address || customerData.address || '';
          doc.customer_state = doc.customer_state || customerData.state || '';
          doc.customer_country = customerData.country || doc.customer_country || '';
          doc.customer_company_name = doc.customer_company_name || customerData.company_name || '';
          const balanceValue =
            typeof customerData.balance === 'number'
              ? customerData.balance
              : Number(customerData.balance || 0) || 0;
          doc.customer_balance = balanceValue;

          const rawPartial = customerData.partial_balance;
          let customerPartial = false;
          if (typeof rawPartial === 'boolean') {
            customerPartial = rawPartial;
          } else if (typeof rawPartial === 'string') {
            const trimmed = rawPartial.trim().toLowerCase();
            customerPartial = trimmed === 'true' || trimmed === '1';
          } else if (typeof rawPartial === 'number') {
            customerPartial = rawPartial === 1;
          }
          doc.customer_partial = customerPartial;
        }
      }

      if (typeof doc.customer_balance === 'undefined') {
        doc.customer_balance = 0.0;
      }

      // Normalize nested structures to match legacy PHP Extended JSON expectations
      // used by sales_view.js for return items.

      // Helper to wrap ObjectId/string into { $oid: "..." }
      const wrapObjectIdForLegacy = (value) => {
        if (!value) return value;
        // If already in { $oid: ... } form, keep as-is
        if (typeof value === 'object' && value.$oid) {
          return value;
        }

        let hex = null;
        if (value instanceof mongoose.Types.ObjectId) {
          hex = value.toString();
        } else if (typeof value === 'string') {
          hex = value;
        } else if (
          typeof value === 'object' &&
          value._bsontype === 'ObjectID' &&
          typeof value.toString === 'function'
        ) {
          // Raw BSON ObjectId from mongodb driver
          hex = value.toString();
        }

        if (!hex) return value;
        return { $oid: hex };
      };

      // Helper to wrap Date/number/string into { $date: { $numberLong: "..." } }
      const wrapDateForLegacy = (value) => {
        if (!value) return value;

        // Already in legacy extended JSON
        if (
          typeof value === 'object' &&
          value.$date &&
          typeof value.$date === 'object' &&
          Object.prototype.hasOwnProperty.call(value.$date, '$numberLong')
        ) {
          return value;
        }

        let dateObj = null;
        if (value instanceof Date) {
          dateObj = value;
        } else if (typeof value === 'number') {
          const d = new Date(value);
          if (!Number.isNaN(d.getTime())) dateObj = d;
        } else if (typeof value === 'string') {
          const ts = Date.parse(value);
          if (!Number.isNaN(ts)) {
            dateObj = new Date(ts);
          }
        }

        if (!dateObj) return value;

        return {
          $date: {
            $numberLong: String(dateObj.getTime()),
          },
        };
      };

      // Helper to safely coerce discount/amount fields that may be
      // null, empty strings, or legacy string values like "null" into
      // numeric zeros. This prevents the sales_view.js templates from
      // rendering "null%" in the Return Line Item card.
      const toNumberSafeLocal = (value, fallback = 0) => {
        if (value === null || typeof value === 'undefined') {
          return 0;
        }
        if (typeof value === 'number') {
          return Number.isFinite(value) ? value : 0;
        }
        if (typeof value === 'string') {
          const trimmed = value.trim().toLowerCase();
          if (!trimmed || trimmed === 'null' || trimmed === 'nan') {
            return 0;
          }
          const num = Number(trimmed);
          return Number.isFinite(num) ? num : 0;
        }

        const fb = Number(fallback);
        return Number.isFinite(fb) ? fb : 0;
      };

      // Build a lookup of item_id -> item_price from return line items so that
      // fully returned lines in the main items array (which may have quantity 0
      // and item_price 0) can still display a meaningful price in the Line Item
      // section of sales_view.js.
      const returnPriceByItemId = new Map();
      if (Array.isArray(doc.items_return)) {
        doc.items_return.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;
          const ra =
            entry.returnArray && typeof entry.returnArray === 'object' ? entry.returnArray : null;
          if (!ra || !Array.isArray(ra.returnValue)) return;

          ra.returnValue.forEach((line) => {
            if (!line || typeof line !== 'object') return;
            const rawId = line.item_id || line.item || line.itemId;
            if (!rawId) return;
            const key = String(rawId);
            const price = toNumberSafeLocal(line.item_price, 0);
            if (price > 0 && !returnPriceByItemId.has(key)) {
              returnPriceByItemId.set(key, price);
            }
          });
        });
      }

      if (Array.isArray(doc.items)) {
        doc.items = doc.items.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const cloned = { ...item };

          // Frontend legacy sales view expects PHP-style keys
          // Map from the Mongoose sale item schema fields if needed.
          if (typeof cloned.item_name === 'undefined' && typeof cloned.name !== 'undefined') {
            cloned.item_name = cloned.name;
          }
          if (
            typeof cloned.item_quantity === 'undefined' &&
            typeof cloned.quantity !== 'undefined'
          ) {
            cloned.item_quantity = cloned.quantity;
          }
          if (
            typeof cloned.item_price === 'undefined' &&
            typeof cloned.unit_price !== 'undefined'
          ) {
            cloned.item_price = cloned.unit_price;
          }
          if (
            typeof cloned.item_discount === 'undefined' &&
            typeof cloned.discount !== 'undefined'
          ) {
            cloned.item_discount = cloned.discount;
          }
          if (typeof cloned.total_amount === 'undefined' && typeof cloned.total !== 'undefined') {
            cloned.total_amount = cloned.total;
          }

          // The frontend total display expects a selling_price field
          if (typeof cloned.selling_price === 'undefined') {
            cloned.selling_price =
              Number(cloned.sale_inline_item_price ?? cloned.item_price ?? cloned.price ?? 0) || 0;
          }

          // Normalize discount fields for frontend calculations
          if (typeof cloned.discount_amount === 'undefined') {
            cloned.discount_amount =
              Number(
                cloned.sale_inline_discount_value ?? cloned.item_discount ?? cloned.discount ?? 0
              ) || 0;
          }
          if (typeof cloned.discount_percentage === 'undefined') {
            cloned.discount_percentage =
              Number(
                cloned.sale_inline_discount_pervalue ?? cloned.item_discount_percentage ?? 0
              ) || 0;
          }
          if (typeof cloned.item_discount_percentage === 'undefined') {
            cloned.item_discount_percentage =
              Number(cloned.discount_percentage ?? cloned.sale_inline_discount_pervalue ?? 0) || 0;
          }
          if (typeof cloned.item_discount === 'undefined') {
            cloned.item_discount =
              Number(
                cloned.discount_amount ?? cloned.sale_inline_discount_value ?? cloned.discount ?? 0
              ) || 0;
          }
          if (typeof cloned.item_unit === 'undefined') {
            cloned.item_unit = (
              cloned.item_unit ??
              cloned.unit ??
              cloned.unit_name ??
              'qty'
            ).toString();
          }

          if (typeof cloned.item_id === 'undefined') {
            if (cloned.item) cloned.item_id = cloned.item;
            else if (cloned.itemId) cloned.item_id = cloned.itemId;
          }

          if (
            typeof cloned.item_discount_amount === 'undefined' &&
            typeof cloned.item_discount !== 'undefined'
          ) {
            cloned.item_discount_amount = cloned.item_discount;
          }

          if (typeof cloned.item_total === 'undefined') {
            if (typeof cloned.total_amount !== 'undefined') {
              cloned.item_total = cloned.total_amount;
            } else if (typeof cloned.total !== 'undefined') {
              cloned.item_total = cloned.total;
            }
          }

          // Additional aliases used by some legacy JS templates
          const qtyNum = toNumberSafe(cloned.item_quantity, 0);
          // Normalise quantity to a number so frontend code that calls
          // item_quantity.toFixed(2) (e.g. in addSalesLineItems for return
          // flows) never throws when we loaded quantities as strings like
          // "1.00" from Mongo.
          cloned.item_quantity = qtyNum;

          let priceNum = toNumberSafe(cloned.item_price, 0);

          // First, try to reconstruct price from total / quantity whenever
          // quantity is positive.
          if ((priceNum === 0 || !Number.isFinite(priceNum)) && qtyNum > 0) {
            const lineTotalCandidate =
              typeof cloned.item_total !== 'undefined'
                ? cloned.item_total
                : typeof cloned.total_amount !== 'undefined'
                  ? cloned.total_amount
                  : cloned.total;
            const lineTotalNum = toNumberSafe(lineTotalCandidate, 0);
            if (lineTotalNum > 0) {
              priceNum = lineTotalNum / qtyNum;
              cloned.item_price = priceNum;
            }
          }

          // If price is still zero (for example, fully returned items where
          // quantity is 0), fall back to the price recorded on the
          // corresponding return line.
          if (priceNum === 0 || !Number.isFinite(priceNum)) {
            let mappedPrice;

            // Primary match: by item id
            const rawItemId = cloned.item_id || cloned.item || cloned.itemId;
            if (rawItemId) {
              mappedPrice = returnPriceByItemId.get(String(rawItemId));
            }

            // Safe fallback: when there is only a single distinct return price
            // recorded (common case: one-line sale with one return), reuse that
            // price even if ids do not line up perfectly.
            if ((!mappedPrice || mappedPrice <= 0) && returnPriceByItemId.size === 1) {
              const first = returnPriceByItemId.values().next().value;
              if (typeof first !== 'undefined') {
                mappedPrice = first;
              }
            }

            if (mappedPrice && mappedPrice > 0) {
              priceNum = mappedPrice;
              cloned.item_price = mappedPrice;
            }
          }

          // At this point, ensure item_price is always a pure number. The
          // legacy sales_view.js code calls price.toFixed(2) on
          // data.items[i].item_price; if we leave item_price as a string such
          // as "25000" the browser will throw a TypeError. Keeping this field
          // numeric also matches the original PHP JSON output.
          cloned.item_price = Number.isFinite(priceNum) ? priceNum : 0;

          if (typeof cloned.price === 'undefined') {
            cloned.price = priceNum;
          }

          if (
            cloned.total_amount === null ||
            typeof cloned.total_amount === 'undefined' ||
            !Number.isFinite(Number(cloned.total_amount))
          ) {
            const effectivePrice = Number.isFinite(priceNum) ? priceNum : 0;
            cloned.total_amount = qtyNum * effectivePrice;
          } else {
            cloned.total_amount = toNumberSafe(cloned.total_amount, 0);
          }

          return cloned;
        });
      }

      // Ensure items_return[].returnArray fields follow legacy shape and
      // normalise individual return line items early so no consumer ever
      // sees null discount values.
      if (Array.isArray(doc.items_return)) {
        doc.items_return = doc.items_return.map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const clonedEntry = { ...entry };

          if (clonedEntry.returnArray && typeof clonedEntry.returnArray === 'object') {
            const ra = { ...clonedEntry.returnArray };
            ra.returnDate = wrapDateForLegacy(ra.returnDate);
            ra.returnObjId = wrapObjectIdForLegacy(ra.returnObjId);

            const values = Array.isArray(ra.returnValue) ? ra.returnValue : [];
            ra.returnValue = values.map((item) => {
              if (!item || typeof item !== 'object') return item;
              const line = { ...item };

              // Coerce legacy string/null values into safe numbers so the
              // frontend never sees "null" or NaN for discount fields.
              line.item_discount = toNumberSafe(line.item_discount, 0);
              line.item_discount_percentage = toNumberSafe(line.item_discount_percentage, 0);

              if (
                line.total_amount === null ||
                typeof line.total_amount === 'undefined' ||
                !Number.isFinite(Number(line.total_amount))
              ) {
                const qty = toNumberSafe(line.item_quantity, 0);
                const price = toNumberSafe(line.item_price, 0);
                line.total_amount = qty * price;
              } else {
                line.total_amount = toNumberSafe(line.total_amount, 0);
              }

              // Normalise item_unit for safety in the return line item table.
              if (typeof line.item_unit === 'undefined' || line.item_unit === null) {
                line.item_unit = 'qty';
              }

              return line;
            });

            clonedEntry.returnArray = ra;
          }

          return clonedEntry;
        });
      }

      const normalized = BaseModel.simplifyFields(doc);

      // Ensure legacy note fields are always strings for frontend checks and
      // mirror PHP behaviour, where Sale Note / Payment Note are stored on the
      // main sales document and reused for partial/full returns.
      if (normalized && typeof normalized === 'object') {
        // Display dates lose precision during normalization; edits need the exact revision.
        const revisionDate = new Date(saleDoc.updated_date || saleDoc.created_date || 0);
        normalized.order_revision = Number.isFinite(revisionDate.getTime())
          ? revisionDate.toISOString()
          : null;
        const firstNonEmptyString = (...values) => {
          for (const value of values) {
            if (typeof value === 'string' && value.trim() !== '') {
              return value;
            }
          }
          return '';
        };

        normalized.sales_description = firstNonEmptyString(
          normalized.sales_description,
          doc.sales_description,
          doc.notes
        );

        normalized.payment_description = firstNonEmptyString(
          normalized.payment_description,
          doc.payment_description
        );

        normalized.discount_description = firstNonEmptyString(
          normalized.discount_description,
          doc.discount_description
        );
      }

      // Ensure expected top-level totals exist for the sales view modal
      if (normalized && typeof normalized === 'object') {
        if (!Array.isArray(normalized.items_return)) {
          normalized.items_return = [];
        }

        // Ensure every items_return entry has the expected legacy shape
        if (Array.isArray(normalized.items_return) && normalized.items_return.length) {
          normalized.items_return = normalized.items_return
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return null;
              const cloned = { ...entry };
              const raRaw =
                cloned.returnArray && typeof cloned.returnArray === 'object'
                  ? cloned.returnArray
                  : {};

              const ra = { ...raRaw };

              if (!ra.returnDate) {
                const dt = normalized.date || normalized.createdAt || new Date();
                const t = dt instanceof Date ? dt.getTime() : Date.parse(dt);
                ra.returnDate = {
                  $date: {
                    $numberLong: String(Number.isFinite(t) ? t : Date.now()),
                  },
                };
              }

              if (!ra.returnObjId) {
                const oid =
                  (ra.returnObjId && ra.returnObjId.$oid) ||
                  (normalized._id && normalized._id.$oid) ||
                  normalized._id ||
                  '';
                ra.returnObjId = { $oid: String(oid) };
              }

              if (!ra.returnId) {
                ra.returnId = String(ra.return_id || ra.returnId || '');
              }

              if (!Array.isArray(ra.returnValue)) {
                ra.returnValue = [];
              }

              // Normalise individual return line items so the view never
              // displays `null%` for discount and always has a
              // sensible total_amount.
              ra.returnValue = ra.returnValue.map((item) => {
                if (!item || typeof item !== 'object') return item;
                const line = { ...item };

                // Coerce legacy string/null values into safe numbers so the
                // frontend never sees "null" for discount fields.
                line.item_discount = toNumberSafe(line.item_discount, 0);
                line.item_discount_percentage = toNumberSafe(line.item_discount_percentage, 0);

                if (
                  line.total_amount === null ||
                  typeof line.total_amount === 'undefined' ||
                  !Number.isFinite(Number(line.total_amount))
                ) {
                  const qty = toNumberSafe(line.item_quantity, 0);
                  const price = toNumberSafe(line.item_price, 0);
                  line.total_amount = qty * price;
                } else {
                  line.total_amount = toNumberSafe(line.total_amount, 0);
                }

                return line;
              });

              if (typeof ra.roundOff === 'undefined') ra.roundOff = 0;
              if (typeof ra.extraDiscount === 'undefined') ra.extraDiscount = 0;
              if (typeof ra.itemsTotalAmount === 'undefined') ra.itemsTotalAmount = 0;

              cloned.returnArray = ra;
              return cloned;
            })
            .filter(Boolean);
        }

        if (typeof normalized.items_return_total === 'undefined') {
          normalized.items_return_total = 0;
        }
        if (typeof normalized.items_return_subtotal === 'undefined') {
          normalized.items_return_subtotal = 0;
        }
        if (typeof normalized.return_discount === 'undefined') {
          normalized.return_discount = 0;
        }
        if (typeof normalized.return_round_off === 'undefined') {
          normalized.return_round_off = 0;
        }
        if (typeof normalized.return_extra_discount === 'undefined') {
          normalized.return_extra_discount = 0;
        }
        if (typeof normalized.items_subtotal === 'undefined') {
          normalized.items_subtotal = normalized.subtotal ?? normalized.sales_sub_total ?? 0;
        }

        if (
          typeof normalized.sales_total !== 'undefined' &&
          typeof normalized.items_total === 'undefined'
        ) {
          normalized.items_total = normalized.sales_total;
        }
        if (
          typeof normalized.total !== 'undefined' &&
          typeof normalized.items_total === 'undefined'
        ) {
          normalized.items_total = normalized.total;
        }
        if (
          typeof normalized.subtotal === 'undefined' &&
          typeof normalized.sales_sub_total !== 'undefined'
        ) {
          normalized.subtotal = normalized.sales_sub_total;
        }

        // Ensure sale_no and status exist
        if (typeof normalized.sale_no === 'undefined') {
          normalized.sale_no =
            normalized.sales_id || normalized.invoice_number || normalized._id || '';
        }
        if (typeof normalized.status === 'undefined') {
          normalized.status = normalized.payment_status || '';
        }

        // PHP-style payment_status label normalization for view modal
        const rawStatus = (normalized.payment_status ?? '').toString().trim().toLowerCase();
        const paidAmt = Number(normalized.paid_amount ?? normalized.paidAmount ?? 0) || 0;
        if (rawStatus === 'completed' || rawStatus === 'paid') {
          normalized.payment_status = 'Paid';
        } else if (rawStatus === 'cancelled' || rawStatus === 'canceled') {
          normalized.payment_status = 'Cancelled';
        } else if (rawStatus === 'pending') {
          normalized.payment_status = paidAmt <= 0 ? 'Unpaid' : 'Pending';
        }

        // As a final safeguard, recompute item totals if the document is missing them.
        const items = Array.isArray(normalized.items) ? normalized.items : [];
        if (items.length) {
          const sum = items.reduce((acc, it) => {
            const line = Number(it?.item_total ?? it?.total_amount ?? it?.total ?? 0) || 0;
            return acc + line;
          }, 0);

          if (
            typeof normalized.items_total === 'undefined' ||
            Number(normalized.items_total) === 0
          ) {
            normalized.items_total = round(sum, 2);
          }
          if (typeof normalized.sales_total === 'undefined') {
            normalized.sales_total = normalized.items_total;
          }
          if (typeof normalized.total === 'undefined') {
            normalized.total = normalized.sales_total;
          }
        }

        // Normalise the primary date fields using the business timezone so
        // that the sale details modal matches the Sales History list. For
        // normal sales we keep the original sale date, but for
        // PartialReturn / FullReturn we prefer the last updated timestamp
        // (the time the return was completed), which is what the Sales
        // History grid displays.
        const tz = branchDoc?.time_zone || BaseModel.currentTimeZone || 'Africa/Cairo';

        let dateSource = null;
        const process = (doc.sale_process || '').toString();
        if (process === 'PartialReturn' || process === 'FullReturn') {
          dateSource =
            doc.updated_date ||
            doc.updatedAt ||
            doc.date ||
            doc.created_date ||
            doc.createdAt ||
            null;
        } else {
          dateSource =
            doc.settled_at ||
            doc.date ||
            doc.created_date ||
            doc.createdAt ||
            doc.updated_date ||
            doc.updatedAt ||
            null;
        }

        if (dateSource) {
          const formatted = formatDate(dateSource, { timeZone: tz });
          if (formatted) {
            normalized.date = formatted;
            normalized.created_date = formatDate(doc.created_date || doc.createdAt || dateSource, {
              timeZone: tz,
            });
            // A paid receipt carries the saved settlement clock, not the time
            // a later correction or reprint was requested.
            normalized.receipt_date = formatDate(
              (process === 'PartialReturn' || process === 'FullReturn' ? dateSource : null) ||
                doc.settled_at ||
                (normalized.payment_status === 'Paid' ? doc.date : null) ||
                doc.created_date ||
                doc.createdAt ||
                dateSource,
              { timeZone: tz }
            );
            normalized.receipt_date_order = 'mdy';
          }
        }
      }

      // Ordinary bills and payment use sales_total/sales_sub_total. Returns
      // retain their separate remaining-item totals.
      const hasReturns =
        /return|exchange/i.test(String(saleDoc.sale_process || '')) ||
        (Array.isArray(saleDoc.items_return) && saleDoc.items_return.length > 0) ||
        (Array.isArray(saleDoc.returnArray) && saleDoc.returnArray.length > 0);
      if (!hasReturns) {
        for (const [source, targets] of [
          ['sales_total', ['items_total', 'total']],
          ['sales_sub_total', ['items_subtotal', 'subtotal']],
        ]) {
          const value = saleDoc[source];
          if (
            value !== undefined &&
            value !== null &&
            value !== '' &&
            Number.isFinite(Number(value))
          ) {
            for (const target of targets) normalized[target] = Number(value);
          }
        }
      }
      if (['PartialReturn', 'FullReturn'].includes(saleDoc.sale_process)) {
        for (const [source, targets] of [
          ['items_total', ['sales_total', 'total']],
          ['items_subtotal', ['sales_sub_total', 'subtotal']],
        ]) {
          const value = saleDoc[source];
          if (value != null && value !== '' && Number.isFinite(Number(value))) {
            for (const target of targets) normalized[target] = Number(value);
          }
        }
      }

      normalized.receipt_line_rows = require('../helpers/bill-payload').itemLines(
        saleDoc,
        branchDoc || {}
      );

      return {
        status: true,
        data: normalized,
        message: 'get successfully',
      };
    } catch (error) {
      console.error('Error in getSalesDetailsLegacy:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async deleteSales(ids, { SaleModel, requireRecycleBackup = false } = {}) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { status: false, data: null, message: 'No IDs provided' };
      }

      // Ensure BaseModel has an initialized Mongo connection for recycle_bin
      // backups and data_change_log.
      const base = new BaseModel('sales');
      await base.getCollection('recycle_bin');

      const objectIds = ids
        .map((id) => {
          if (!id) return null;
          const str = String(id).trim();
          return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
        })
        .filter((oid) => oid);

      if (objectIds.length === 0) {
        return { status: false, data: null, message: 'No valid IDs provided' };
      }

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');
      const transactionCollection = db.collection('transaction');
      const customersCollection = db.collection('customers');
      const cashRegisterCollection = db.collection('cashregister');
      const branchesCollection = db.collection('branches');
      const itemsCollection = db.collection('items');
      const stockLogsRepository = new StockLogsRepository();

      // Write change logs for each sale id (PHP BaseModel::changeLog parity)
      for (const oid of objectIds) {
        try {
          await base.changeLog('sales', BaseModel.loggedUser, oid, 'delete');
        } catch (e) {
          // changeLog is non-throwing by design; ignore failures.
        }
      }

      const licenseFilter = BaseModel.license ? { license: BaseModel.license } : {};

      const salesFilter = {
        _id: { $in: objectIds },
        ...licenseFilter,
        ...(BaseModel.currentBranch ? { branch_id: BaseModel.currentBranch } : {}),
      };

      const salesDocs = await salesCollection.find(salesFilter).toArray();
      if (requireRecycleBackup) {
        for (const doc of salesDocs) {
          const retained = { ...doc };
          const backup = await BaseModel.deletedDocumentBackup('sales', retained, {
            requireRetention: true,
          });
          if (!backup || backup.status !== true) {
            throw Object.assign(
              new Error(
                'Sale was not deleted because its Recycle Bin backup could not be saved. Check that Recycle Bin is enabled and retry.'
              ),
              { statusCode: 409 }
            );
          }
        }
      }

      // Clean register_sales references in cashregister collection
      try {
        await cashRegisterCollection.updateMany(
          {
            'register_sales.sales_id': { $in: objectIds },
            ...licenseFilter,
          },
          {
            $pull: {
              register_sales: {
                sales_id: { $in: objectIds },
              },
            },
          }
        );
      } catch (e) {
        // Do not block delete flow on register cleanup issues
        console.error('Error cleaning cashregister for deleted sales:', e);
      }

      const now = new Date();

      for (const doc of salesDocs) {
        if (!doc) continue;

        const saleId = doc._id;
        const customerId = doc.customer_id || doc.customer || null;
        const branchId = doc.branch_id || doc.branch || BaseModel.currentBranch || null;
        const licenseId = doc.license || BaseModel.license || null;

        // Handle partial customer transactions (wallet) when partial_check is true
        const partialCheck = doc.partial_check === 'true' || doc.partial_check === true;

        if (partialCheck && customerId) {
          try {
            const txFilter = {
              sale_id: saleId,
              customer_id: customerId,
            };
            if (branchId) {
              txFilter.branch_id = branchId;
            }
            if (licenseId) {
              txFilter.license = licenseId;
            }

            const txDocs = await transactionCollection.find(txFilter).toArray();
            for (const tx of txDocs) {
              await BaseModel.deletedDocumentBackup('transaction', tx);
            }

            await transactionCollection.deleteMany(txFilter);

            const customerMatchAnd = [{ customer_id: customerId }];
            if (branchId) {
              customerMatchAnd.push({ branch_id: branchId });
            }
            if (licenseId) {
              customerMatchAnd.push({ license: licenseId });
            }

            const aggregateMatch = customerMatchAnd.length > 0 ? { $and: customerMatchAnd } : {};

            const walletAgg = await transactionCollection
              .aggregate([
                { $match: aggregateMatch },
                {
                  $group: {
                    _id: null,
                    totalInAmount: {
                      $sum: {
                        $cond: [{ $eq: ['$type', 'in'] }, '$amount', 0],
                      },
                    },
                    totalOutAmount: {
                      $sum: {
                        $cond: [{ $eq: ['$type', 'out'] }, '$amount', 0],
                      },
                    },
                  },
                },
                {
                  $addFields: {
                    totalAmountDue: {
                      $subtract: ['$totalInAmount', '$totalOutAmount'],
                    },
                  },
                },
              ])
              .toArray();

            let totalWalletAmount = 0;
            if (walletAgg.length > 0) {
              const row = walletAgg[0];
              totalWalletAmount =
                typeof row.totalAmountDue === 'number'
                  ? row.totalAmountDue
                  : Number(row.totalAmountDue || 0) || 0;
            }

            const customerFilter = {
              _id: customerId,
            };
            if (branchId) {
              customerFilter.branch_id = branchId;
            }
            if (licenseId) {
              customerFilter.license = licenseId;
            }

            await customersCollection.updateOne(customerFilter, {
              $set: { balance: totalWalletAmount },
            });
          } catch (e) {
            console.error('Error updating customer wallet during sale delete:', e);
          }
        }

        // Backup sales document to recycle_bin
        try {
          if (!requireRecycleBackup) await BaseModel.deletedDocumentBackup('sales', doc);
        } catch (e) {
          console.error('Error backing up deleted sale document:', e);
        }

        // Restore stock quantities and write stock logs (skip Hold sales)
        const saleProcess = doc.sale_process || null;
        if (saleProcess && String(saleProcess).toLowerCase() === 'hold') {
          continue;
        }

        const branchForStock = branchId || BaseModel.currentBranch || doc.branch_id || doc.branch;
        let branchSettings = null;
        if (branchForStock) {
          try {
            let normalizedBranchId = branchForStock;
            if (branchForStock instanceof mongoose.Types.ObjectId) {
              normalizedBranchId = branchForStock;
            } else if (mongoose.Types.ObjectId.isValid(String(branchForStock))) {
              normalizedBranchId = new mongoose.Types.ObjectId(String(branchForStock));
            }

            branchSettings = await branchesCollection.findOne({
              _id: normalizedBranchId,
            });
          } catch (e) {
            console.error('Error loading branch settings for sale delete stock log:', e);
          }
        }

        const stockLogStatus = [true, 'true'].includes(branchSettings?.stock_management_log);

        const items = Array.isArray(doc.items) ? doc.items : [];
        const salesIdentifier = doc.sales_id || doc.invoice_number || (saleId && saleId.toString());

        for (const item of items) {
          try {
            const rawItemId = item.item_id || item.item || item.id;
            if (!rawItemId) continue;

            const quantity =
              item.item_quantity != null
                ? item.item_quantity
                : item.quantity != null
                  ? item.quantity
                  : 0;
            const itemQty = require('../helpers/selling-units').stockQuantity(item, quantity || 0);
            if (!Number.isFinite(itemQty) || itemQty <= 0) continue;

            let itemObjectId = null;
            if (
              rawItemId &&
              typeof rawItemId === 'object' &&
              rawItemId._bsontype === 'ObjectID' &&
              typeof rawItemId.toString === 'function'
            ) {
              itemObjectId = new mongoose.Types.ObjectId(rawItemId.toString());
            } else if (mongoose.Types.ObjectId.isValid(String(rawItemId))) {
              itemObjectId = new mongoose.Types.ObjectId(String(rawItemId));
            }

            if (!itemObjectId) continue;

            const itemFilter = {
              _id: { $eq: itemObjectId },
            };
            if (licenseId) {
              itemFilter.license = { $eq: licenseId };
            }

            const itemDoc = await itemsCollection.findOne(itemFilter);
            if (!itemDoc || ![true, 'true'].includes(itemDoc.track_inventory)) continue;

            const openingBalance = Number(itemDoc.available_quantity || 0);
            const availableQuantity = openingBalance + itemQty;

            // Restore tracked stock even when the optional stock log is disabled.
            await itemsCollection.updateOne(itemFilter, {
              $inc: { available_quantity: itemQty },
              $set: { updated_date: now },
            });
            if (stockLogStatus) {
              const countStr = String(itemQty);

              const stockLog = await stockLogsRepository.createStockLog({
                stocklog: stockLogStatus,
                branch_id: branchForStock,
                view_item_id: itemObjectId,
                item_barcode_id: itemDoc.barcode_id || '',
                item_name: item.item_name || item.name || itemDoc.name || '',
                item_quantity: itemQty,
                process: 'Delete Sale',
                reference: salesIdentifier || '',
                opening_balance: openingBalance,
                closing_balance: availableQuantity,
                count: countStr,
                date: now,
                action: 'Add',
                changed_by_userid: BaseModel.loggedUser,
                changed_by: BaseModel.loggedUserName || 'System',
              });
              if (stockLog?.status === false)
                throw new Error('Stock log could not be saved during deletion.');
            }
          } catch (e) {
            console.error('Error restoring stock for deleted sale item:', e);
          }
        }
      }

      const deleted = await salesCollection.deleteMany(salesFilter);
      if (typeof deleted?.deletedCount === 'number' && deleted.deletedCount !== salesDocs.length)
        throw new Error('Sale deletion was interrupted and needs review.');

      return {
        status: true,
        data: objectIds.map((oid) => oid.toString()),
        message: 'success',
      };
    } catch (error) {
      console.error('Error in deleteSaleCollectionData:', error);
      return {
        status: false,
        statusCode: error.statusCode || error.status || 500,
        data: null,
        message: error.message,
      };
    }
  }

  async getById(id, { SaleModel } = {}) {
    if (!id) return null;
    const Model = this.getModel(SaleModel);
    const tenant = activeTenantFilter();
    return Object.keys(tenant).length ? Model.findOne({ _id: id, ...tenant }) : Model.findById(id);
  }

  async findById(id, { projection, populate, SaleModel } = {}) {
    if (!id) return null;
    const Model = this.getModel(SaleModel);

    const tenant = activeTenantFilter();
    let query = Object.keys(tenant).length
      ? Model.findOne({ _id: id, ...tenant })
      : Model.findById(id);

    if (projection) {
      query = query.select(projection);
    }

    if (populate) {
      // Allow single path or array of populate specs
      if (Array.isArray(populate)) {
        populate.forEach((pop) => {
          query = query.populate(pop);
        });
      } else {
        query = query.populate(populate);
      }
    }

    return query.lean();
  }

  async save(sale) {
    if (!sale) return null;
    return sale.save();
  }

  async updateWalletAmount(saleId, walletAmount) {
    try {
      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const result = await salesCollection.updateOne(
        {
          _id: new mongoose.Types.ObjectId(saleId),
          license: BaseModel.license,
        },
        {
          $set: {
            wallet_amount: parseFloat(walletAmount),
          },
        }
      );

      return result.modifiedCount > 0;
    } catch (error) {
      console.error('Error updating wallet amount:', error);
      return false;
    }
  }

  async aggregate(pipeline, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.aggregate(pipeline);
  }

  async find(match, projection, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    let query = Model.find(match);
    if (projection) {
      query = query.select(projection);
    }
    return query.lean();
  }

  async findOne(match, projection, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    let query = Model.findOne(match);
    if (projection) {
      query = query.select(projection);
    }
    return query.lean();
  }

  async countDocuments(match, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.countDocuments(match);
  }

  async getSaleForReceipt(id, { SaleModel } = {}) {
    if (!id) return null;
    const Model = this.getModel(SaleModel);
    return Model.findOne({
      $or: [{ _id: id }, { sales_id: id }],
    }).populate('branch_id');
  }

  async getSaleForCustomerPrint(id, { SaleModel } = {}) {
    if (!id) return null;
    const Model = this.getModel(SaleModel);
    return Model.findOne({
      $or: [{ _id: id }, { sales_id: id }],
    })
      .populate('branch_id')
      .populate('items.item_id')
      .lean();
  }

  async userReportPage(data, options, { SaleModel } = {}) {
    try {
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(data.starting_date, timeZone);
      const toTimestamp = BaseModel.endingDate(data.ending_date, timeZone);

      const fromDate = new Date(fromTimestamp || 0);
      const toDate = new Date(toTimestamp || Date.now());

      const rawBranch = data.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const branchObjectIds = (branchIds || [])
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [
        { branch_id: { $in: branchObjectIds } },
        { updated_date: { $gte: fromDate, $lte: toDate } },
      ];
      if (BaseModel.license) {
        andConditions.push({ license: BaseModel.license });
      }

      /** @type {Record<string, any>} */
      const filters = { $and: andConditions };
      if (data.user_id && mongoose.Types.ObjectId.isValid(data.user_id)) {
        filters.user_id = new mongoose.Types.ObjectId(data.user_id);
      }

      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      const page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
      const skip = Math.max(0, (page - 1) * limit);

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const pipeline = [
        { $unwind: '$items' },
        { $match: filters },
        {
          $addFields: {
            sales_total_num: {
              ...reportSaleTotal(),
            },
            line_cost_num: lineCostExpression(),
          },
        },
        {
          $group: {
            _id: { user_id: '$user_id', sale_id: '$_id' },
            user_name: { $first: '$user_name' },
            cost: { $sum: '$line_cost_num' },
            sales_total: { $first: reportSaleTotal() },
            refund_total: { $first: '$items_return_total' },
          },
        },
        {
          $group: {
            _id: { user_id: '$_id.user_id' },
            user_name: { $last: '$user_name' },
            profit: { $sum: { $subtract: ['$sales_total', '$cost'] } },
            sales_total: { $sum: '$sales_total' },
            sales_avg: { $avg: '$sales_total' },
            refund_total: { $sum: '$refund_total' },
            sales_count: { $sum: 1 },
          },
        },
        {
          $facet: {
            rows: [
              { $sort: { sales_total: -1, '_id.user_id': 1 } },
              { $skip: skip },
              { $limit: limit },
            ],
            totals: [
              {
                $group: {
                  _id: null,
                  employees: { $sum: 1 },
                  sales: { $sum: '$sales_count' },
                  amount: { $sum: '$sales_total' },
                },
              },
            ],
          },
        },
      ];
      const [report] = await salesCollection.aggregate(pipeline, { allowDiskUse: true }).toArray();
      const summary = report.totals[0] || { employees: 0, sales: 0, amount: 0 };
      const salesList = report.rows;
      const list = salesList.map((doc) => {
        const id = doc._id || {};
        return {
          user_name: doc.user_name,
          user_id: id.user_id,
          sales_payment: round(doc.sales_total || 0, 2),
          refund_payment: round(doc.refund_total || 0, 2),
          sales_count: doc.sales_count || 0,
          sales_profit: round(doc.profit || 0, 2),
          sales_avg: round(doc.sales_avg || 0, 2),
        };
      });

      const total = summary.employees;

      return {
        status: true,
        list,
        summary: { sales: summary.sales, amount: round(summary.amount, 2) },
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(Math.ceil(total / (limit || 1)), 1),
        },
        message: 'Get Successfully',
      };
    } catch (error) {
      console.error('Error in userReportPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getUserGraphicalReports(value = {}, { SaleModel } = {}) {
    try {
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(value.starting_date, timeZone);
      const toTimestamp = BaseModel.endingDate(value.ending_date, timeZone);

      const fromDate = new Date(fromTimestamp || 0);
      const toDate = new Date(toTimestamp || Date.now());

      const rawBranch = value.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const branchObjectIds = (branchIds || [])
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [
        {
          branch_id: { $in: branchObjectIds },
          ...reportableSales(),
        },
        {
          updated_date: { $gte: fromDate, $lte: toDate },
          ...(BaseModel.license ? { license: BaseModel.license } : {}),
        },
      ];

      const condition = { $and: andConditions };
      if (value.user_id && mongoose.Types.ObjectId.isValid(value.user_id)) {
        condition.user_id = new mongoose.Types.ObjectId(value.user_id);
      }

      const db = await BaseModel.getDb();
      const collection = db.collection('sales');

      const pipeline = [
        { $match: condition },
        {
          $project: {
            items_total: reportSaleTotal(),
            h: {
              $dayOfWeek: {
                date: '$updated_date',
                timezone: timeZone,
              },
            },
          },
        },
        {
          $group: {
            _id: '$h',
            totalValue: { $sum: reportSaleTotal() },
          },
        },
      ];

      const salesData = await collection.aggregate(pipeline).toArray();

      if (!Array.isArray(salesData) || salesData.length === 0) {
        return {
          status: true,
          data: [],
          message: '',
        };
      }

      const days = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      const totalsByIndex = new Array(7).fill(0);

      for (const doc of salesData) {
        const dow = typeof doc._id === 'number' ? doc._id : Number(doc._id) || 0;
        if (dow >= 1 && dow <= 7) {
          const idx = dow === 7 ? 0 : dow; // 7 -> 0 (Sat), 1..6 -> 1..6
          totalsByIndex[idx] += Number(doc.totalValue || 0);
        }
      }

      const arrSalesPurchase = [];
      for (let m = 0; m < 7; m++) {
        arrSalesPurchase.push({
          week: days[m],
          sales: round(totalsByIndex[m] || 0, 2),
        });
      }

      return {
        status: true,
        data: arrSalesPurchase,
        message: 'Graphical report successfully',
      };
    } catch (error) {
      console.error('Error in getUserGraphicalReports:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async returnSalesReportPage(data = {}, options = {}, { SaleModel } = {}) {
    try {
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTs = BaseModel.startingDate
        ? BaseModel.startingDate(data.starting_date, timeZone)
        : Date.parse(data.starting_date || '') || 0;
      const toTs = BaseModel.endingDate
        ? BaseModel.endingDate(data.ending_date, timeZone)
        : Date.parse(data.ending_date || '') || Date.now();

      const fromDate = new Date(fromTs || 0);
      const toDate = new Date(toTs || Date.now());

      const branchIds = Array.isArray(data.branchid) ? data.branchid : [];
      const branchObjectIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [];
      if (branchObjectIds.length) {
        andConditions.push({ branch_id: { $in: branchObjectIds } });
      }
      andConditions.push({
        sale_process: { $in: ['PartialReturn', 'FullReturn'] },
      });

      if (!mongoose.Types.ObjectId.isValid(data.license)) throw Error('Missing license');
      andConditions.push({ license: new mongoose.Types.ObjectId(String(data.license)) });
      if (data.customer) {
        if (!mongoose.Types.ObjectId.isValid(data.customer)) throw Error('Invalid customer');
        andConditions.push({
          customer_id: {
            $in: [String(data.customer), new mongoose.Types.ObjectId(String(data.customer))],
          },
        });
      }
      const filters = { $and: andConditions };
      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      const page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
      const skip = Math.max(0, (page - 1) * limit);

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const stages = [
        { $match: filters },
        { $unwind: '$items_return' },
        { $unwind: '$items_return.returnArray' },
        { $set: { event: '$items_return.returnArray' } },
        {
          $set: {
            eventDate: {
              $convert: {
                input: {
                  $ifNull: [
                    '$event.returnDate',
                    { $arrayElemAt: ['$event.returnValue.return_date', 0] },
                  ],
                },
                to: 'date',
                onError: null,
                onNull: null,
              },
            },
          },
        },
        { $match: { eventDate: { $gte: fromDate, $lte: toDate } } },
      ];
      if (data.search) {
        const literal = new RegExp(data.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        stages.push({
          $match: {
            $or: ['sales_id', 'customer_name', 'event.returnId', 'event.returnValue.return_id'].map(
              (k) => ({ [k]: literal })
            ),
          },
        });
      }
      stages.push({
        $project: {
          sale_id: '$sales_id',
          customer_name: 1,
          payment_mode: 1,
          date: '$eventDate',
          ref: '$event.returnId',
          count: { $size: { $ifNull: ['$event.returnValue', []] } },
          amount: {
            $ifNull: ['$event.itemsTotalAmount', { $sum: '$event.returnValue.total_amount' }],
          },
        },
      });
      const sort =
        options.sort === 'new'
          ? { date: -1, _id: -1, ref: 1 }
          : { amount: -1, date: -1, _id: -1, ref: 1 };
      const [result] = await salesCollection
        .aggregate([
          ...stages,
          {
            $facet: {
              list: [{ $sort: sort }, { $skip: skip }, { $limit: limit }],
              counts: [{ $count: 'total' }],
            },
          },
        ])
        .toArray();
      const list = result.list.map((row) => ({
        id: row._id,
        sale_id: row.sale_id,
        customer_name: row.customer_name,
        payment_mode: row.payment_mode,
        date: formatDate(row.date),
        return: round(row.amount || 0, 2),
        count: row.count,
      }));
      const total = result.counts[0]?.total || 0;
      return {
        status: true,
        list,
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(Math.ceil(total / (limit || 1)), 1),
        },
        message: 'Get Successfully',
      };
    } catch (error) {
      console.error('Error in returnSalesReportPage:', error);
      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      return {
        status: false,
        list: null,
        pagination: {
          page: 1,
          limit,
          total: 0,
          pages: 1,
        },
        message: error.message,
      };
    }
  }

  async returnProductReportPage(data = {}, options = {}, { SaleModel } = {}) {
    try {
      const rawBranch = data.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const branchObjectIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [];
      if (branchObjectIds.length) {
        andConditions.push({ branch_id: { $in: branchObjectIds } });
      }

      if (data.sales_id && mongoose.Types.ObjectId.isValid(data.sales_id)) {
        andConditions.push({ _id: new mongoose.Types.ObjectId(data.sales_id) });
      }

      if (BaseModel.license) {
        andConditions.push({ license: BaseModel.license });
      }

      const filters = andConditions.length ? { $and: andConditions } : {};

      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : BaseModel.limit;
      const page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
      const skip = Math.max(0, (page - 1) * limit);

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const pipeline = [
        { $unwind: '$items_return' },
        { $unwind: '$items_return.returnArray' },
        { $unwind: '$items_return.returnArray.returnValue' },
        { $match: filters },
        {
          $group: {
            _id: {
              sales_id: '$sales_id',
              item_id: '$items_return.returnArray.returnValue.item_id',
              item_name: '$items_return.returnArray.returnValue.item_name',
              customer_name: '$customer_name',
              customer_phone: '$customer_phone',
              customer_email: '$customer_email',
              customer_address: '$customer_address',
              user_name: '$user_name',
              branch_name: '$branch_name',
            },
            item_quantity: {
              $sum: '$items_return.returnArray.returnValue.item_quantity',
            },
            total_amount: {
              $sum: '$items_return.returnArray.returnValue.total_amount',
            },
          },
        },
        {
          $facet: {
            rows: [
              { $sort: { sales_total: -1, '_id.user_id': 1 } },
              { $skip: skip },
              { $limit: limit },
            ],
            totals: [
              {
                $group: {
                  _id: null,
                  employees: { $sum: 1 },
                  sales: { $sum: '$sales_count' },
                  amount: { $sum: '$sales_total' },
                },
              },
            ],
          },
        },
      ];

      const [report] = await salesCollection.aggregate(pipeline, { allowDiskUse: true }).toArray();
      const summary = report.totals[0] || { employees: 0, sales: 0, amount: 0 };
      const salesList = report.rows;
      const list = [];
      const customDetails = {
        sales_id: null,
        customer_name: null,
        customer_phone: null,
        customer_email: null,
        customer_address: null,
        user_name: null,
        branch_name: null,
      };

      for (const doc of salesList) {
        const id = doc._id || {};
        list.push({
          _id: id.item_id ? id.item_id.toString() : '',
          name: id.item_name || '',
          total_amount: round(doc.total_amount || 0, 2),
          item_quantity: round(doc.item_quantity || 0, 2),
        });

        if (!customDetails.sales_id && id.sales_id) {
          customDetails.sales_id = id.sales_id;
          customDetails.customer_name = id.customer_name || '';
          customDetails.customer_phone = id.customer_phone || '';
          customDetails.customer_email = id.customer_email || '';
          customDetails.customer_address = id.customer_address || '';
          customDetails.user_name = id.user_name || '';
          customDetails.branch_name = id.branch_name || '';
        }
      }

      const total = summary.employees;
      return {
        status: true,
        list,
        summary: { sales: summary.sales, amount: round(summary.amount, 2) },
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(Math.ceil(total / (limit || 1)), 1),
        },
        message: 'Get Successfully',
      };
    } catch (error) {
      console.error('Error in productBasedReportPage:', error);
      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      return {
        status: false,
        list: null,
        pagination: {
          page: 1,
          limit,
          total: 0,
          pages: 1,
        },
        message: error.message,
      };
    }
  }

  async pendingSalesReportPage(data, options, { SaleModel } = {}) {
    try {
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTs = BaseModel.startingDate
        ? BaseModel.startingDate(data.starting_date, timeZone)
        : Date.parse(data.starting_date || '') || 0;
      const toTs = BaseModel.endingDate
        ? BaseModel.endingDate(data.ending_date, timeZone)
        : Date.parse(data.ending_date || '') || Date.now();

      const fromDate = new Date(fromTs || 0);
      const toDate = new Date(toTs || Date.now());

      const branchIds = Array.isArray(data.branchid) ? data.branchid : [];
      const branchObjectIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [];
      if (branchObjectIds.length) {
        andConditions.push({ branch_id: { $in: branchObjectIds } });
      }
      andConditions.push({ sale_process: { $in: ['Add', 'Edit', 'PartialReturn'] } });

      const dateAndPayment = {
        updated_date: { $gte: fromDate, $lte: toDate },
        $or: [
          { payment_status: 'Partialy Paid' },
          { payment_status: PAYMENT_STATUS.PENDING },
          { payment_pending: { $gt: 0 } },
        ],
      };
      if (BaseModel.license) {
        dateAndPayment.license = BaseModel.license;
      }
      andConditions.push(dateAndPayment);

      const filters = { $and: andConditions };

      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      const page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
      const skip = Math.max(0, (page - 1) * limit);

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const pipeline = [
        { $match: filters },
        {
          $group: {
            _id: {
              date: '$updated_date',
              id: '$_id',
              sales_id: '$sales_id',
              user_name: '$user_name',
              customer_name: '$customer_name',
              customer_phone: '$customer_phone',
              number_of_items: '$number_of_items',
            },
            pending_amount: { $sum: reportSaleTotal() },
            partial_amount: { $sum: '$partial_balance' },
            due_amount: { $sum: '$payment_pending' },
          },
        },
        { $sort: { pending_amount: -1 } },
        { $skip: skip },
        { $limit: limit },
      ];

      const aggResults = await salesCollection.aggregate(pipeline).toArray();

      const list = (aggResults || []).map((doc) => {
        const id = doc._id || {};
        const rawDate = id.date;
        const formattedDate = rawDate ? formatDate(rawDate) : null;
        return {
          date: formattedDate,
          id: id.id,
          sale_id: id.sales_id,
          customer_name: id.customer_name,
          customer_phone: id.customer_phone,
          pending_amount: round(doc.pending_amount || 0, 2),
          partial_amount: round(doc.partial_amount || 0, 2),
          due_amount: round(doc.due_amount || 0, 2),
          number_of_items: id.number_of_items,
        };
      });

      const total = await salesCollection.countDocuments(filters);

      return {
        status: true,
        list,
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(Math.ceil(total / (limit || 1)), 1),
        },
        message: 'Get Successfully',
      };
    } catch (error) {
      console.error('Error in pendingSalesReportPage:', error);
      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      return {
        status: false,
        list: null,
        pagination: {
          page: 1,
          limit,
          total: 0,
          pages: 1,
        },
        message: error.message,
      };
    }
  }

  async pendingCustomerReportPage(data = {}, options = {}, { SaleModel } = {}) {
    try {
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTs = BaseModel.startingDate
        ? BaseModel.startingDate(data.starting_date, timeZone)
        : Date.parse(data.starting_date || '') || 0;
      const toTs = BaseModel.endingDate
        ? BaseModel.endingDate(data.ending_date, timeZone)
        : Date.parse(data.ending_date || '') || Date.now();

      const fromDate = new Date(fromTs || 0);
      const toDate = new Date(toTs || Date.now());

      const branchIds = Array.isArray(data.branchid) ? data.branchid : [];
      const branchObjectIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [];
      if (branchObjectIds.length) {
        andConditions.push({ branch_id: { $in: branchObjectIds } });
      }
      andConditions.push({ sale_process: { $in: ['Add', 'Edit', 'PartialReturn'] } });

      const dateAndPayment = {
        updated_date: { $gte: fromDate, $lte: toDate },
        $or: [
          { payment_status: 'Partialy Paid' },
          { payment_status: PAYMENT_STATUS.PENDING },
          { payment_pending: { $gt: 0 } },
        ],
      };
      if (BaseModel.license) {
        dateAndPayment.license = BaseModel.license;
      }
      andConditions.push(dateAndPayment);

      const filters = { $and: andConditions };

      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      const page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
      const skip = Math.max(0, (page - 1) * limit);

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const pipeline = [
        { $match: filters },
        {
          $group: {
            _id: {
              customer_id: '$customer_id',
              customer_name: '$customer_name',
              customer_phone: '$customer_phone',
              referrer: { $ifNull: ['$referrer_name', '--'] },
            },
            number_of_items: { $sum: '$number_of_items' },
            pending_amount: { $sum: reportSaleTotal() },
            partial_amount: { $sum: '$partial_balance' },
            due_amount: { $sum: '$payment_pending' },
          },
        },
        { $sort: { pending_amount: -1 } },
        { $skip: skip },
        { $limit: limit },
      ];

      const aggResults = await salesCollection.aggregate(pipeline).toArray();

      const list = (aggResults || []).map((doc) => {
        const id = doc._id || {};
        return {
          customer_id: id.customer_id ? id.customer_id.toString() : '',
          customer_name: id.customer_name || '',
          customer_phone: id.customer_phone || '',
          sales_payment: round(doc.pending_amount || 0, 2),
          partial_balance: round(doc.partial_amount || 0, 2),
          due_balance: round(doc.due_amount || 0, 2),
          sales_count: doc.number_of_items || 0,
          referrer: id.referrer || '--',
        };
      });

      const countPipeline = [
        { $match: filters },
        {
          $group: {
            _id: {
              customer_id: '$customer_id',
              customer_name: '$customer_name',
              customer_phone: '$customer_phone',
            },
          },
        },
        { $count: 'total' },
      ];

      const countDocs = await salesCollection.aggregate(countPipeline).toArray();
      const total = (countDocs[0] && countDocs[0].total) || 0;

      return {
        status: true,
        list,
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(Math.ceil(total / (limit || 1)), 1),
        },
        message: 'Get Successfully',
      };
    } catch (error) {
      console.error('Error in pendingCustomerReportPage:', error);
      const limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 5;
      return {
        status: false,
        list: null,
        pagination: {
          page: 1,
          limit,
          total: 0,
          pages: 1,
        },
        message: error.message,
      };
    }
  }

  /*
   * The item/category details tables send these rows to the client RAW, and
   * the client renders row.items_total.toFixed(2) per row. Answer the totals
   * here with the same fallbacks the sales list formatter uses so every row
   * is renderable.
   */
  _renderableSaleRows(rawList) {
    const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
    return (rawList || []).map((doc) => {
      const row = {
        ...doc,
        items_total: round2(doc.items_total ?? doc.sales_total ?? doc.total ?? 0),
        items_return_total: round2(doc.items_return_total ?? 0),
      };
      if (typeof doc.currencyCode !== 'undefined') row.currencyCode = doc.currencyCode;
      if (typeof doc.currencyDigits !== 'undefined') row.currencyDigits = doc.currencyDigits;
      return row;
    });
  }

  async _saleActivityTotals(Model, matchFilter) {
    // Stream the complete history: page totals omit sales, while a raw Mongo
    // sum bypasses the totals already prepared for the list.
    const cursor = Model.find(matchFilter).lean().cursor();
    const groups = new Map();
    try {
      for await (const doc of cursor) {
        const [row] = this._renderableSaleRows([doc]);
        const code = /^[A-Z]{3}$/.test(row.currencyCode || '') ? row.currencyCode : '';
        const digits =
          Number.isInteger(row.currencyDigits) && row.currencyDigits >= 0 && row.currencyDigits <= 4
            ? row.currencyDigits
            : 2;
        const group = groups.get(code) || {
          currencyCode: code,
          currencyDigits: digits,
          sale: 0n,
          returned: 0n,
        };
        group.currencyDigits = Math.max(group.currencyDigits, digits);
        // Four-place integer accumulation avoids floating point drift between
        // bills. Keep legacy unknown currency separate from named currencies.
        const minor = (amount) => {
          const value = Math.round(Number(amount) * 10000);
          if (!Number.isSafeInteger(value))
            throw new Error('Activity amount is outside the supported range.');
          return BigInt(value);
        };
        group.sale += minor(row.items_total);
        group.returned += minor(row.items_return_total);
        groups.set(code, group);
      }
    } finally {
      await cursor.close();
    }
    const amount = (value) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number))
        throw new Error('Activity total is outside the supported range.');
      return number / 10000;
    };
    return [...groups.values()]
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode))
      .map((group) => ({
        currencyCode: group.currencyCode,
        currencyDigits: group.currencyDigits,
        total: amount(group.sale),
        return_total: amount(group.returned),
      }));
  }

  _lineActivityCurrencyTotals(sales, returns) {
    const groups = new Map();
    for (const [rows, field] of [
      [sales, 'total'],
      [returns, 'return_total'],
    ]) {
      for (const row of rows) {
        const code =
          typeof row._id?.code === 'string' && /^[A-Z]{3}$/.test(row._id.code) ? row._id.code : '';
        const digits =
          Number.isInteger(row._id?.digits) && row._id.digits >= 0 && row._id.digits <= 4
            ? row._id.digits
            : 2;
        const group = groups.get(code) || {
          currencyCode: code,
          currencyDigits: digits,
          total: 0,
          return_total: 0,
        };
        group.currencyDigits = Math.max(group.currencyDigits, digits);
        group[field] += Number(row.total_amount) || 0;
        groups.set(code, group);
      }
    }
    return [...groups.values()]
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode))
      .map((group) => ({
        ...group,
        total: Money.fromMinor(Money.toMinor(group.total, group), group),
        return_total: Money.fromMinor(Money.toMinor(group.return_total, group), group),
      }));
  }

  async itemSaleDetailsPage(value, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      // Normalize branch ids (may come as single value or array)
      const rawBranch = value.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      const rawItemId = value.item_id;

      // If no item_id is provided at all, mirror PHP shape but return an
      // empty, successful payload instead of an error so the frontend can
      // show an empty Activities table without a toast.
      if (!rawItemId) {
        const limit = parseInt(options.limit, 10) || 5;
        const page = parseInt(options.page, 10) || 1;

        const emptyTable = {
          status: true,
          data: {
            list: [],
            total: 0,
            current_page: page,
            total_pages: 0,
            per_page: limit,
          },
          message: 'Get Successfully',
        };

        return {
          status: true,
          data: {
            sale: [],
            return: [],
            table: emptyTable,
          },
          message: 'get detail successfully',
        };
      }

      // Support both string and ObjectId item_id representations. This keeps
      // compatibility with legacy PHP data (where item_id was often stored as
      // a plain string) and newer Node-created sales (which may use ObjectId).
      const itemIdCandidates = [rawItemId];
      if (mongoose.Types.ObjectId.isValid(rawItemId)) {
        itemIdCandidates.push(new mongoose.Types.ObjectId(rawItemId));
      }

      const branchCondition =
        objectBranchIds.length > 0 ? { branch_id: { $in: objectBranchIds } } : null;

      // Filters used for the main table (sales that have this item either in items or return items)
      const tableFilters = {
        $and: [
          branchCondition,
          {
            $or: [
              { 'items.item_id': { $in: itemIdCandidates } },
              {
                'items_return.returnArray.returnValue.item_id': {
                  $in: itemIdCandidates,
                },
              },
            ],
          },
        ].filter(Boolean),
      };

      // Filters for sales side (items only)
      const filters = {
        $and: [branchCondition, { 'items.item_id': { $in: itemIdCandidates } }].filter(Boolean),
      };

      // Filters for returns side (items_return only)
      const returnFilters = {
        $and: [
          branchCondition,
          {
            'items_return.returnArray.returnValue.item_id': {
              $in: itemIdCandidates,
            },
          },
        ].filter(Boolean),
      };

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);
      const sort = options.sort || { _id: 1 };

      // Fetch paginated list for table (similar to PHP parent::page result)
      const list = this._renderableSaleRows(
        await Model.find(tableFilters).sort(sort).skip(skip).limit(limit).lean()
      );

      const totalCount = await Model.countDocuments(tableFilters);

      const tableData = {
        status: true,
        data: {
          list,
          total: totalCount,
          current_page: page,
          total_pages: limit ? Math.ceil(totalCount / limit) : 0,
          per_page: limit,
        },
        message: 'Get Successfully',
      };

      // Aggregate total quantity for sales side
      const salesList = await Model.aggregate([
        { $match: filters },
        { $unwind: '$items' },
        {
          $match: {
            ...filters,
            // Cancelled preparations stay in audit history but are not sales.
            // Returns retain their separate existing gross/return accounting.
            sale_process: { $not: /^(cancelled|canceled)$/i },
            'items.cancelled': { $in: [null, false, 0, ''] },
            'items.status': { $not: /^(cancelled|canceled)$/i },
            $expr: {
              $gt: [
                {
                  $convert: {
                    input: { $ifNull: ['$items.item_quantity', '$items.quantity'] },
                    to: 'double',
                    onError: 0,
                    onNull: 0,
                  },
                },
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: {
              code: { $ifNull: ['$currencyCode', ''] },
              digits: { $ifNull: ['$currencyDigits', 2] },
            },
            total_amount: {
              $sum: {
                $ifNull: ['$items.total_amount', { $ifNull: ['$items.total', 0] }],
              },
            },
            total_qty: {
              $sum: {
                $ifNull: ['$items.item_quantity', '$items.quantity'],
              },
            },
          },
        },
      ]);

      const salesValues = salesList.length
        ? [salesList.reduce((sum, doc) => sum + (Number(doc.total_qty) || 0), 0)]
        : [];

      // Aggregate total quantity for returns side
      const returnList = await Model.aggregate([
        { $unwind: '$items_return' },
        { $unwind: '$items_return.returnArray' },
        { $unwind: '$items_return.returnArray.returnValue' },
        { $match: returnFilters },
        {
          $group: {
            _id: {
              code: { $ifNull: ['$currencyCode', ''] },
              digits: { $ifNull: ['$currencyDigits', 2] },
            },
            total_amount: {
              $sum: '$items_return.returnArray.returnValue.total_amount',
            },
            total_qty: {
              $sum: '$items_return.returnArray.returnValue.item_quantity',
            },
          },
        },
      ]);

      const returnValues = returnList.length
        ? [returnList.reduce((sum, doc) => sum + (Number(doc.total_qty) || 0), 0)]
        : [];

      const currencyTotals = this._lineActivityCurrencyTotals(salesList, returnList);
      const saleAmount = currencyTotals.length === 1 ? currencyTotals[0].total : 0;
      const returnAmount = currencyTotals.length === 1 ? currencyTotals[0].return_total : 0;

      const arrTableData = {
        sale: salesValues,
        return: returnValues,
        sale_amount: saleAmount,
        currency_totals: currencyTotals,
        return_amount: returnAmount,
        table: tableData,
      };

      return {
        status: true,
        data: arrTableData,
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in itemSaleDetailsPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async categorySaleDetailsPage(value, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      // Normalize branch ids (may come as single value or array)
      const rawBranch = value.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (!value.category_id || !mongoose.Types.ObjectId.isValid(value.category_id)) {
        return {
          status: false,
          data: null,
          message: 'Invalid category id',
        };
      }

      const categoryObjectId = new mongoose.Types.ObjectId(value.category_id);

      // Filters used for the main table (sales that have category either in items or return items)
      const tableFilters = {
        $and: [
          { branch_id: { $in: objectBranchIds } },
          {
            $or: [
              { 'items.category_id': categoryObjectId },
              {
                'items_return.returnArray.returnValue.category_id': categoryObjectId,
              },
            ],
          },
        ],
      };

      // Filters for sales side (items only)
      const filters = {
        $and: [{ branch_id: { $in: objectBranchIds } }, { 'items.category_id': categoryObjectId }],
      };

      // Filters for returns side (items_return only)
      const returnFilters = {
        $and: [
          { branch_id: { $in: objectBranchIds } },
          {
            'items_return.returnArray.returnValue.category_id': categoryObjectId,
          },
        ],
      };

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);
      const sort = options.sort || { _id: 1 };

      // Fetch paginated list for table (similar to PHP parent::page result)
      const list = this._renderableSaleRows(
        await Model.find(tableFilters).sort(sort).skip(skip).limit(limit).lean()
      );

      const totalCount = await Model.countDocuments(tableFilters);

      const tableData = {
        status: true,
        data: {
          list,
          total: totalCount,
          current_page: page,
          total_pages: limit ? Math.ceil(totalCount / limit) : 0,
          per_page: limit,
        },
        message: 'Get Successfully',
      };

      // Aggregate total quantity for sales side
      const salesList = await Model.aggregate([
        { $match: filters },
        { $unwind: '$items' },
        {
          $match: {
            ...filters,
            // Cancelled preparations stay in audit history but are not sales.
            // Returns retain their separate existing gross/return accounting.
            sale_process: { $not: /^(cancelled|canceled)$/i },
            'items.cancelled': { $in: [null, false, 0, ''] },
            'items.status': { $not: /^(cancelled|canceled)$/i },
            $expr: {
              $gt: [
                {
                  $convert: {
                    input: { $ifNull: ['$items.item_quantity', '$items.quantity'] },
                    to: 'double',
                    onError: 0,
                    onNull: 0,
                  },
                },
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: {
              code: { $ifNull: ['$currencyCode', ''] },
              digits: { $ifNull: ['$currencyDigits', 2] },
            },
            total_amount: {
              $sum: {
                $ifNull: ['$items.total_amount', { $ifNull: ['$items.total', 0] }],
              },
            },
            total_qty: {
              $sum: {
                $ifNull: ['$items.item_quantity', '$items.quantity'],
              },
            },
          },
        },
      ]);

      const salesValues = salesList.length
        ? [salesList.reduce((sum, doc) => sum + (Number(doc.total_qty) || 0), 0)]
        : [];

      // Aggregate total quantity for returns side
      const returnList = await Model.aggregate([
        { $unwind: '$items_return' },
        { $unwind: '$items_return.returnArray' },
        { $unwind: '$items_return.returnArray.returnValue' },
        { $match: returnFilters },
        {
          $group: {
            _id: {
              code: { $ifNull: ['$currencyCode', ''] },
              digits: { $ifNull: ['$currencyDigits', 2] },
            },
            total_amount: {
              $sum: '$items_return.returnArray.returnValue.total_amount',
            },
            total_qty: {
              $sum: '$items_return.returnArray.returnValue.item_quantity',
            },
          },
        },
      ]);

      const returnValues = returnList.length
        ? [returnList.reduce((sum, doc) => sum + (Number(doc.total_qty) || 0), 0)]
        : [];

      const currencyTotals = this._lineActivityCurrencyTotals(salesList, returnList);
      const saleAmount = currencyTotals.length === 1 ? currencyTotals[0].total : 0;
      const returnAmount = currencyTotals.length === 1 ? currencyTotals[0].return_total : 0;

      const arrTableData = {
        sale: salesValues,
        return: returnValues,
        sale_amount: saleAmount,
        currency_totals: currencyTotals,
        return_amount: returnAmount,
        table: tableData,
      };

      return {
        status: true,
        data: arrTableData,
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in categorySaleDetailsPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async userSalesDetailsPage(value, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      const arrayMerge = [];
      if (value.branchid && Array.isArray(value.branchid)) {
        for (let i = 0; i < value.branchid.length; i++) {
          if (mongoose.Types.ObjectId.isValid(value.branchid[i])) {
            arrayMerge.push(new mongoose.Types.ObjectId(value.branchid[i]));
          }
        }
      }

      if (!value.user_id || !mongoose.Types.ObjectId.isValid(value.user_id) || !arrayMerge.length) {
        return {
          status: false,
          data: null,
          message: 'Invalid branch or user id',
        };
      }

      // Match PHP filter structure exactly - user_id and license in same object
      const filters = {
        $and: [
          { branch_id: { $in: arrayMerge } },
          {
            user_id: new mongoose.Types.ObjectId(value.user_id),
            license: new mongoose.Types.ObjectId(options.license || value.license),
          },
        ],
      };

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);
      const sort = options.sort || { _id: 1 };

      const list = this._renderableSaleRows(
        await Model.find(filters).sort(sort).skip(skip).limit(limit).lean()
      );

      const totalCount = await Model.countDocuments(filters);

      const tableData = {
        status: true,
        data: {
          list,
          total: totalCount,
          current_page: page,
          total_pages: limit ? Math.ceil(totalCount / limit) : 0,
          per_page: limit,
        },
        message: 'Get Successfully',
      };

      // Aggregation match filter - same structure as find()
      const salesList = await Model.aggregate([
        { $match: filters },
        {
          $group: {
            _id: '$user_id',
            total_amount: { $sum: '$sales_total' },
          },
        },
      ]);

      const total = [];
      for (const doc of salesList) {
        total.push(round(doc.total_amount || 0, 2));
      }

      const arrTableData = {
        table: tableData,
        total,
      };

      return {
        status: true,
        data: arrTableData,
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in userSalesDetailsPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async returnProductViewPage(id, { SaleModel } = {}) {
    try {
      if (!id) {
        return {
          status: false,
          data: null,
          message: 'Return id is required',
        };
      }

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const filters = {
        'items_return.returnArray.returnValue.return_id': id,
      };

      const branchId = BaseModel.currentBranch || null;
      if (branchId && mongoose.Types.ObjectId.isValid(String(branchId))) {
        filters.branch_id = new mongoose.Types.ObjectId(String(branchId));
      }

      if (BaseModel.license) {
        filters.license = BaseModel.license;
      }

      const pipeline = [
        { $unwind: '$items_return' },
        { $unwind: '$items_return.returnArray' },
        { $unwind: '$items_return.returnArray.returnValue' },
        { $match: filters },
        {
          $group: {
            _id: {
              return_id: '$items_return.returnArray.returnValue.return_id',
              return_date: '$items_return.returnArray.returnValue.return_date',
              customer_name: '$customer_name',
              customer_phone: '$customer_phone',
              customer_email: '$customer_email',
              customer_address: '$customer_address',
            },
            item_id: {
              $first: '$items_return.returnArray.returnValue.item_id',
            },
            item_name: {
              $first: '$items_return.returnArray.returnValue.item_name',
            },
            item_price: {
              $first: '$items_return.returnArray.returnValue.item_price',
            },
            item_discount: {
              $first: '$items_return.returnArray.returnValue.item_discount',
            },
            item_discount_percentage: {
              $first: '$items_return.returnArray.returnValue.item_discount_percentage',
            },
            item_quantity: {
              $first: '$items_return.returnArray.returnValue.item_quantity',
            },
            total_amount: {
              $first: '$items_return.returnArray.returnValue.total_amount',
            },
            payment_mode: {
              $first: '$items_return.returnArray.returnValue.payment_mode',
            },
          },
        },
      ];

      const salesList = await salesCollection.aggregate(pipeline).toArray();

      const productValues = [];

      // Local helper to wrap Date/number/string into legacy Extended JSON
      const wrapDateForLegacyLocal = (value) => {
        if (!value) return value;
        if (
          typeof value === 'object' &&
          value.$date &&
          typeof value.$date === 'object' &&
          Object.prototype.hasOwnProperty.call(value.$date, '$numberLong')
        ) {
          return value;
        }
        let dateObj = null;
        if (value instanceof Date) {
          dateObj = value;
        } else if (typeof value === 'number') {
          const d = new Date(value);
          if (!Number.isNaN(d.getTime())) dateObj = d;
        } else if (typeof value === 'string') {
          const ts = Date.parse(value);
          if (!Number.isNaN(ts)) {
            dateObj = new Date(ts);
          }
        }
        if (!dateObj) return value;
        return {
          $date: {
            $numberLong: String(dateObj.getTime()),
          },
        };
      };

      for (const doc of salesList) {
        const c = doc._id || {};

        const price = Number(doc.item_price ?? 0);
        const qty = Number(doc.item_quantity ?? 0);
        const discount = Number(doc.item_discount ?? 0);
        const discountPct = Number(doc.item_discount_percentage ?? 0);
        const subPrice = price * qty;

        let totalDiscount;
        if (discount > 0) {
          totalDiscount = discount * qty;
        } else if (discountPct > 0) {
          totalDiscount = subPrice * (discountPct / 100);
        } else {
          totalDiscount = 0;
        }

        const storedTotal = Number(doc.total_amount);
        const finalTotal = Number.isFinite(storedTotal) ? storedTotal : subPrice - totalDiscount;

        productValues.push({
          return_id: c.return_id,
          return_date: wrapDateForLegacyLocal(c.return_date),
          customer_name: c.customer_name,
          customer_phone: c.customer_phone,
          customer_email: c.customer_email,
          customer_address: c.customer_address,
          subtotal: subPrice,
          sale_discount: totalDiscount,
          finaltotal: finalTotal,
          item_id: doc.item_id,
          item_name: doc.item_name,
          item_price: doc.item_price,
          item_discount: doc.item_discount,
          item_discount_percentage: doc.item_discount_percentage,
          item_quantity: doc.item_quantity,
          total_amount: doc.total_amount,
          payment_mode: doc.payment_mode,
        });
      }

      return {
        status: true,
        data: productValues,
        message: 'Get detail successfully',
      };
    } catch (error) {
      console.error('Error in returnProductViewPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async paymentSalesTransactionReportPage(data, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(data.starting_date, timeZone);
      const toTimestamp = BaseModel.endingDate(data.ending_date, timeZone);

      const fromDate = new Date(fromTimestamp || 0);
      const toDate = new Date(toTimestamp || Date.now());

      const branchIds = Array.isArray(data.branchid) ? data.branchid : [];
      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const firstClause = {
        branch_id: { $in: objectBranchIds },
        ...reportableSales(),
      };

      const secondClause = {
        date: { $gte: fromDate, $lte: toDate },
        ...(BaseModel.license ? { license: BaseModel.license } : {}),
      };

      const filters = {
        $and: [firstClause, secondClause],
      };

      if (data.payment_mode && data.payment_mode !== 'All') {
        filters.payment_mode = data.payment_mode;
      }

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const projection = {
        _id: 1,
        branch_id: 1,
        branch_name: 1,
        user_id: 1,
        user_name: 1,
        'origin.actor_name': 1,
        sales_id: 1,
        date: 1,
        items: 1,
        items_return: 1,
        sale_process: 1,
        customer_id: 1,
        customer_name: 1,
        customer_address: 1,
        customer_phone: 1,
        customer_email: 1,
        customer_state: 1,
        customer_country: 1,
        payment_pending: 1,
        payment_mode: 1,
        partial_balance: 1,
        partial_check: 1,
        payment_description: 1,
        printing_address: 1,
        payment_status: 1,
        sales_description: 1,
        sales_total: 1,
        sales_round_off: 1,
        round_off: 1,
        return_round_off: 1,
        sales_sub_total: 1,
        items_total: 1,
        paid_amount: 1,
        items_return_total: 1,
        items_subtotal: 1,
        items_return_subtotal: 1,
        total_companyprice: 1,
        discount: 1,
        return_discount: 1,
        number_of_items: 1,
        number_of_items_return: 1,
        created_date: 1,
        updated_date: 1,
        created_by: 1,
        updated_by: 1,
        wallet_amount: 1,
        sale_extra_discount: 1,
        extra_discount: 1,
        discount_description: 1,
        return_extra_discount: 1,
        extra_discount_type: 1,
        sale_method: 1,
        multi_payment: 1,
        denomination_values: 1,
      };

      const rawList = await Model.find(filters)
        .select(projection)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const list = (Array.isArray(rawList) ? rawList : []).map((row) => ({
        ...row,
        user_name: recordedUserName(row.user_name, row.created_by, row.origin?.actor_name),
      }));

      const total = await Model.countDocuments(filters);

      return {
        status: true,
        data: {
          list,
          pagination: {
            page,
            limit,
            total,
            pages: Math.max(Math.ceil(total / (limit || 1)), 1),
          },
        },
        message: 'Get payment sales transaction details successfully',
      };
    } catch (error) {
      console.error('Error in paymentSalesTransactionReportPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getPaymentSaleTypeReport(data = {}, { SaleModel } = {}) {
    try {
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(data.starting_date, timeZone);
      const toTimestamp = BaseModel.endingDate(data.ending_date, timeZone);

      const fromDate = new Date(fromTimestamp || 0);
      const toDate = new Date(toTimestamp || Date.now());

      // Branch ids
      const rawBranch = data.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [];
      if (objectBranchIds.length) {
        andConditions.push({ branch_id: { $in: objectBranchIds } });
      }
      andConditions.push({ date: { $gte: fromDate, $lte: toDate } });
      if (BaseModel.license) {
        andConditions.push({ license: BaseModel.license });
      }

      const filters = { $and: andConditions };

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const cursor = salesCollection.find(filters, {
        projection: {
          sales_total: 1,
          currencyDigits: 1,
          paid_amount: 1,
          payment_status: 1,
          items_total: 1,
          partial_balance: 1,
          payment_pending: 1,
          items_return_total: 1,
        },
        limit: 50000,
        batchSize: 1000,
      });

      const totals = {
        sales_payment: 0,
        partial_amount: 0,
        outstanding_amount: 0,
        refund_payment: 0,
        sales_count: 0,
      };

      const docs = await cursor.toArray();
      // Retain the finest persisted precision in this report. Sales without a
      // saved precision remain in hundredths.
      const reportDigits = docs.reduce((digits, doc) => {
        const saved = doc.currencyDigits;
        return Number.isInteger(saved) && saved >= 0 && saved <= 4
          ? Math.max(digits, saved)
          : digits;
      }, 2);

      const round = (value, decimals = 2) => {
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num)) return 0;
        const factor = Math.pow(10, decimals);
        return value && !Number.isNaN(value) ? Math.round(value * factor) / factor : 0;
      };

      for (const doc of docs) {
        const saleTotal = Number(doc.items_total || doc.sales_total || 0);
        const partialBalance = Number(doc.partial_balance || 0);
        const paymentPending = Number(doc.payment_pending || 0);
        const refundTotal = Number(doc.items_return_total || 0);
        const paid =
          doc.paid_amount == null
            ? String(doc.payment_status || '').toLowerCase() === 'unpaid'
              ? 0
              : saleTotal - paymentPending
            : Number(doc.paid_amount) || 0;

        totals.sales_payment += paid;
        totals.partial_amount += partialBalance;
        totals.outstanding_amount += paymentPending;
        totals.refund_payment += refundTotal;
        totals.sales_count += 1;
      }

      const salesValues =
        totals.sales_count > 0
          ? [
              {
                sales_payment: round(totals.sales_payment, reportDigits),
                partial_amount: round(totals.partial_amount, reportDigits),
                outstanding_amount: round(totals.outstanding_amount, reportDigits),
                refund_payment: round(totals.refund_payment, reportDigits),
                sales_count: totals.sales_count,
              },
            ]
          : [];

      const graphicalData = {
        payment: salesValues,
        currencyDigits: reportDigits,
      };

      return {
        status: true,
        data: graphicalData,
        message: 'Get payment details successfully',
      };
    } catch (error) {
      console.error('Error in getPaymentSaleTypeReport:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async paymentReturnSalesTranscationReportTable(data, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(data.starting_date, timeZone);
      const toTimestamp = BaseModel.endingDate(data.ending_date, timeZone);

      const fromDate = new Date(fromTimestamp || 0);
      const toDate = new Date(toTimestamp || Date.now());

      const branchIds = Array.isArray(data.branchid) ? data.branchid : [];
      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const firstClause = {
        branch_id: { $in: objectBranchIds },
        sale_process: { $in: ['PartialReturn', 'FullReturn'] },
      };

      const secondClause = {
        date: { $gte: fromDate, $lte: toDate },
        ...(BaseModel.license ? { license: BaseModel.license } : {}),
      };

      const filters = {
        $and: [firstClause, secondClause],
      };

      if (data.payment_mode && data.payment_mode !== 'All') {
        filters.payment_mode = data.payment_mode;
      }

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const projection = {
        _id: 1,
        branch_id: 1,
        branch_name: 1,
        user_id: 1,
        user_name: 1,
        'origin.actor_name': 1,
        sales_id: 1,
        date: 1,
        items: 1,
        items_return: 1,
        sale_process: 1,
        customer_id: 1,
        customer_name: 1,
        customer_address: 1,
        customer_phone: 1,
        customer_email: 1,
        customer_state: 1,
        customer_country: 1,
        payment_pending: 1,
        payment_mode: 1,
        partial_balance: 1,
        partial_check: 1,
        payment_description: 1,
        printing_address: 1,
        payment_status: 1,
        sales_description: 1,
        sales_total: 1,
        sales_round_off: 1,
        round_off: 1,
        return_round_off: 1,
        sales_sub_total: 1,
        items_total: 1,
        items_return_total: 1,
        items_subtotal: 1,
        items_return_subtotal: 1,
        total_companyprice: 1,
        discount: 1,
        return_discount: 1,
        number_of_items: 1,
        number_of_items_return: 1,
        created_date: 1,
        updated_date: 1,
        created_by: 1,
        updated_by: 1,
        wallet_amount: 1,
        sale_extra_discount: 1,
        extra_discount: 1,
        discount_description: 1,
        return_extra_discount: 1,
        extra_discount_type: 1,
        sale_method: 1,
        multi_payment: 1,
        denomination_values: 1,
      };

      const rawList = await Model.find(filters)
        .select(projection)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const list = (Array.isArray(rawList) ? rawList : []).map((row) => ({
        ...row,
        user_name: recordedUserName(row.user_name, row.created_by, row.origin?.actor_name),
      }));

      const total = await Model.countDocuments(filters);

      return {
        status: true,
        data: {
          list,
          pagination: {
            page,
            limit,
            total,
            pages: Math.max(Math.ceil(total / (limit || 1)), 1),
          },
        },
        message: 'Get payment return sales transaction details successfully',
      };
    } catch (error) {
      console.error('Error in paymentReturnSalesTranscationReportTable:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getPaymentGraphicalReports(data, { SaleModel } = {}) {
    try {
      // Match legacy PHP BaseModel::startingDate / endingDate behaviour
      const timeZone = BaseModel.currentTimeZone || 'Africa/Cairo';
      const fromTimestamp = BaseModel.startingDate(data.starting_date, timeZone);
      const toTimestamp = BaseModel.endingDate(data.ending_date, timeZone);

      const fromDate = new Date(fromTimestamp || 0);
      const toDate = new Date(toTimestamp || Date.now());

      // Branch ids
      const rawBranch = data.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const andConditions = [];
      if (objectBranchIds.length) {
        andConditions.push({ branch_id: { $in: objectBranchIds } });
      }
      andConditions.push({ date: { $gte: fromDate, $lte: toDate } });
      if (BaseModel.license) {
        andConditions.push({ license: BaseModel.license });
      }

      const filters = { $and: andConditions };

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const cursor = salesCollection.find(filters, {
        projection: {
          payment_mode: 1,
          multi_payment: 1,
          items_total: 1,
          items_return_total: 1,
        },
        limit: 50000,
        batchSize: 1000,
      });

      /** @type {Record<string, { sales_payment_mode: string, sales_payment: number, sales_return_total: number }>} */
      const methodTotals = {};

      const docs = await cursor.toArray();

      // Local helper copied from sale.model.js to match legacy rounding behaviour
      const round = (value, decimals = 2) => {
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num)) return 0;
        const factor = Math.pow(10, decimals);
        return value && !Number.isNaN(value) ? Math.round(value * factor) / factor : 0;
      };

      for (const doc of docs) {
        const itemsTotal = Number(doc.items_total || 0);
        const itemsReturn = Number(doc.items_return_total || 0);

        let multiPaymentArr = null;
        const raw = doc.multi_payment;
        if (raw !== undefined && raw !== null && raw !== '') {
          if (Array.isArray(raw)) {
            multiPaymentArr = raw;
          } else if (typeof raw === 'object') {
            multiPaymentArr = raw;
          } else if (typeof raw === 'string') {
            const trimmed = raw.trim();
            if (trimmed !== '') {
              try {
                const decoded = JSON.parse(trimmed);
                if (decoded && typeof decoded === 'object') {
                  multiPaymentArr = decoded;
                }
              } catch (e) {
                // Ignore malformed JSON and fall back to single payment_mode
              }
            }
          }
        }

        let usedMulti = false;
        if (
          multiPaymentArr &&
          typeof multiPaymentArr === 'object' &&
          Object.keys(multiPaymentArr).length > 0
        ) {
          // First compute the sum of positive multi_payment amounts.
          let sumMulti = 0.0;
          for (const amount of Object.values(multiPaymentArr)) {
            const num = Number(amount) || 0;
            if (num > 0) {
              sumMulti += num;
            }
          }

          if (sumMulti > 0) {
            for (const [method, amount] of Object.entries(multiPaymentArr)) {
              const num = Number(amount) || 0;
              if (num <= 0) continue;

              usedMulti = true;

              // Normalise key: lowercase, no spaces; keep first
              // seen variant as display label.
              let displayName = String(method || '').trim();
              if (!displayName) {
                displayName = 'N/A';
              }
              const methodKey = displayName.replace(/\s+/g, '').toLowerCase();

              if (!methodTotals[methodKey]) {
                methodTotals[methodKey] = {
                  sales_payment_mode: displayName,
                  sales_payment: 0.0,
                  sales_return_total: 0.0,
                };
              }

              // Amount actually taken via this method.
              methodTotals[methodKey].sales_payment += num;

              // Allocate returns proportionally to the payment split.
              const ratio = sumMulti > 0 ? num / sumMulti : 0.0;
              methodTotals[methodKey].sales_return_total += itemsReturn * ratio;
            }
          }
        }

        // Fallback: no usable multi_payment found; treat the whole bill
        // as belonging to its single payment_mode value.
        if (!usedMulti) {
          let mode = doc.payment_mode ? String(doc.payment_mode).trim() : '';
          if (!mode) {
            mode = 'N/A';
          }

          const methodKey = mode.replace(/\s+/g, '').toLowerCase();
          if (!methodTotals[methodKey]) {
            methodTotals[methodKey] = {
              sales_payment_mode: mode,
              sales_payment: 0.0,
              sales_return_total: 0.0,
            };
          }

          methodTotals[methodKey].sales_payment += itemsTotal;
          methodTotals[methodKey].sales_return_total += itemsReturn;
        }
      }

      // Normalise into the expected array format; sort by sales_payment
      // descending so the most-used modes appear first.
      const salesValues = Object.values(methodTotals)
        .filter((totals) => {
          const paymentMode = String(totals.sales_payment_mode || '').trim();
          return paymentMode !== '' && paymentMode.toLowerCase() !== 'n/a' && paymentMode !== 'N/A';
        })
        .map((totals) => ({
          sales_payment_mode: totals.sales_payment_mode,
          sales_payment: round(totals.sales_payment || 0, 2),
          sales_return_total: round(totals.sales_return_total || 0, 2),
        }));

      salesValues.sort((a, b) => {
        const av = a.sales_payment || 0;
        const bv = b.sales_payment || 0;
        if (av === bv) return 0;
        return av < bv ? 1 : -1; // descending
      });

      const graphicalData = {
        sales: salesValues,
      };

      return {
        status: true,
        data: graphicalData,
        message: 'Graphical report successfully',
      };
    } catch (error) {
      console.error('Error in getPaymentGraphicalReports:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async customerSaleDetailsPage(value, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      // Normalize branch ids (may come as single value or array)
      const rawBranch = value.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      // Validate customer id & branches
      if (
        !value.customer_id ||
        !mongoose.Types.ObjectId.isValid(value.customer_id) ||
        !objectBranchIds.length
      ) {
        return {
          status: false,
          data: null,
          message: 'Invalid branch or customer id',
        };
      }

      const customerObjectId = new mongoose.Types.ObjectId(value.customer_id);

      // Match legacy PHP fields (branch_id + customer_id) and also support
      // new Mongoose-based sales using the `customer` ref field.
      const matchFilter = {
        $and: [
          { branch_id: { $in: objectBranchIds } },
          {
            $or: [{ customer_id: customerObjectId }, { customer: customerObjectId }],
          },
        ],
      };

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);
      const sort = options.sort || { _id: 1 };

      // Fetch paginated list of sales for this customer
      const list = this._renderableSaleRows(
        await Model.find(matchFilter).sort(sort).skip(skip).limit(limit).lean()
      );

      const totalCount = await Model.countDocuments(matchFilter);

      // Build table structure compatible with PHP BaseModel::page
      const tableData = {
        status: true,
        data: {
          list,
          total: totalCount,
          current_page: page,
          total_pages: limit ? Math.ceil(totalCount / limit) : 0,
          per_page: limit,
        },
        message: 'Get Successfully',
      };

      const currencyTotals = await this._saleActivityTotals(Model, matchFilter);
      // Old clients receive a numeric total only when it represents one
      // currency. Updated clients render every currency group explicitly.
      const totals = currencyTotals.length === 1 ? [currencyTotals[0].total] : [];
      const returnTotals = currencyTotals.length === 1 ? [currencyTotals[0].return_total] : [];

      const arrTableData = {
        table: tableData,
        currency_totals: currencyTotals,
        total: totals,
        return_total: returnTotals,
      };

      return {
        status: true,
        data: arrTableData,
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in customerSaleDetailsPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async customerCategorySaleDetailsPage(value, options = {}, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      // Normalize branch ids (may come as single value or array)
      const rawBranch = value.branchid;
      const branchIds = Array.isArray(rawBranch) ? rawBranch : rawBranch ? [rawBranch] : [];

      const objectBranchIds = branchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      // Validate category id & branches
      if (
        !value.category_id ||
        !mongoose.Types.ObjectId.isValid(value.category_id) ||
        !objectBranchIds.length
      ) {
        return {
          status: false,
          data: null,
          message: 'Invalid branch or category id',
        };
      }

      const categoryObjectId = new mongoose.Types.ObjectId(value.category_id);

      const matchFilter = {
        $and: [{ branch_id: { $in: objectBranchIds } }, { category_id: categoryObjectId }],
      };

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);
      const sort = options.sort || { _id: 1 };

      // Fetch paginated list of sales for this customer category
      const list = this._renderableSaleRows(
        await Model.find(matchFilter).sort(sort).skip(skip).limit(limit).lean()
      );

      const totalCount = await Model.countDocuments(matchFilter);

      const tableData = {
        status: true,
        data: {
          list,
          total: totalCount,
          current_page: page,
          total_pages: limit ? Math.ceil(totalCount / limit) : 0,
          per_page: limit,
        },
        message: 'Get Successfully',
      };

      const currencyTotals = await this._saleActivityTotals(Model, matchFilter);
      // Old clients receive a numeric total only when it represents one
      // currency. Updated clients render every currency group explicitly.
      const totals = currencyTotals.length === 1 ? [currencyTotals[0].total] : [];
      const returnTotals = currencyTotals.length === 1 ? [currencyTotals[0].return_total] : [];

      const arrTableData = {
        table: tableData,
        currency_totals: currencyTotals,
        return_total: returnTotals,
        total: totals,
      };

      return {
        status: true,
        data: arrTableData,
        message: 'get detail successfully',
      };
    } catch (error) {
      console.error('Error in customerCategorySaleDetailsPage:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async returnSalesOrder(payload = {}, { SaleModel, deviceId } = {}) {
    let returnLockContext = null;
    const releaseReturnLock = async () => {
      if (!returnLockContext) return;
      const { salesCollection, saleObjectId, licenseFilter, signature, token } = returnLockContext;
      try {
        await salesCollection.updateOne(
          {
            _id: saleObjectId,
            ...licenseFilter,
            'return_refund_lock.signature': signature,
            'return_refund_lock.token': token,
          },
          { $unset: { return_refund_lock: '' } }
        );
      } catch (unlockError) {
        console.error('Error releasing return/refund lock:', unlockError);
      } finally {
        returnLockContext = null;
      }
    };

    try {
      if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
        return {
          status: false,
          data: null,
          message: 'Return sales value is null',
        };
      }

      const MongooseObjectId = mongoose.Types.ObjectId;

      const partialCheck = String(payload.partial_check) === 'true';
      const paymentPending = Number(payload.payment_pending || 0);

      if (partialCheck && paymentPending > 0) {
        return {
          status: false,
          data: null,
          message: 'Please complete your transaction',
        };
      }

      const rawSaleId =
        payload.sales_id || payload.id || payload.sale_id || payload.sales_document_id || null;

      if (!rawSaleId || !MongooseObjectId.isValid(String(rawSaleId))) {
        return {
          status: false,
          data: null,
          message: 'Sales id is missing or invalid',
        };
      }

      const saleObjectId = new MongooseObjectId(String(rawSaleId));

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');
      const branchesCollection = db.collection('branches');
      const itemsCollection = db.collection('items');

      const licenseFilter = BaseModel.license ? { license: BaseModel.license } : {};

      let saleDocument = await salesCollection.findOne({
        _id: saleObjectId,
        ...activeTenantFilter(),
      });

      if (!saleDocument) {
        return {
          status: false,
          data: null,
          message: 'Sale not found',
        };
      }

      const branchId =
        saleDocument.branch_id || saleDocument.branch || BaseModel.currentBranch || null;

      let branchSettings = null;
      if (branchId) {
        let normalizedBranchId = branchId;
        if (branchId instanceof MongooseObjectId) {
          normalizedBranchId = branchId;
        } else if (MongooseObjectId.isValid(String(branchId))) {
          normalizedBranchId = new MongooseObjectId(String(branchId));
        }

        try {
          branchSettings = await branchesCollection.findOne({
            _id: normalizedBranchId,
            ...(BaseModel.license ? { license: BaseModel.license } : {}),
          });
        } catch (e) {
          console.error('Error loading branch settings for return sales:', e);
        }
      }

      const licenseId = saleDocument.license || BaseModel.license || null;

      const items = require('../utils/order-line').reconcile(
        Array.isArray(payload.items) ? payload.items : [],
        saleDocument.items || []
      );
      const returnItems = require('../utils/order-line').reconcile(
        Array.isArray(payload.items_return) ? payload.items_return : [],
        saleDocument.items || []
      );
      const now = new Date();

      if (!returnItems.length) {
        return {
          status: false,
          data: null,
          message: 'No return items provided',
        };
      }

      const returnSignature = buildReturnSignature(saleObjectId, returnItems, payload);
      const existingReturnTransactions = Array.isArray(saleDocument.return_refund_transactions)
        ? saleDocument.return_refund_transactions
        : [];

      if (existingReturnTransactions.some((entry) => entry?.signature === returnSignature)) {
        return {
          status: false,
          statusCode: 409,
          data: null,
          message: 'This refund has already been processed for this sale',
        };
      }

      const lockExpiry = new Date(now.getTime() - 2 * 60 * 1000);
      const lockToken = new MongooseObjectId().toHexString();
      const lockResult = await salesCollection.updateOne(
        {
          _id: saleObjectId,
          ...licenseFilter,
          payment_correction_pending: { $exists: false },
          $and: [
            {
              $or: [
                { return_refund_lock: { $exists: false } },
                { 'return_refund_lock.locked_at': { $lt: lockExpiry } },
                { 'return_refund_lock.signature': returnSignature },
              ],
            },
            {
              $or: [
                { return_refund_transactions: { $exists: false } },
                {
                  return_refund_transactions: {
                    $not: { $elemMatch: { signature: returnSignature } },
                  },
                },
              ],
            },
          ],
        },
        {
          $set: {
            return_refund_lock: {
              token: lockToken,
              signature: returnSignature,
              locked_at: now,
              locked_by: BaseModel.loggedUser || null,
              locked_by_name: BaseModel.loggedUserName || 'System',
            },
          },
        }
      );

      if (!lockResult.modifiedCount) {
        return {
          status: false,
          statusCode: 409,
          data: null,
          message: 'Refund is already processing or already completed for this sale',
        };
      }

      returnLockContext = {
        salesCollection,
        saleObjectId,
        licenseFilter,
        signature: returnSignature,
        token: lockToken,
      };

      saleDocument =
        (await salesCollection.findOne({ _id: saleObjectId, ...licenseFilter })) || saleDocument;

      const remainingQtyByItem = new Map();
      for (const item of Array.isArray(saleDocument.items) ? saleDocument.items : []) {
        addQtyToMap(remainingQtyByItem, normalizeReturnItemKey(item), item.item_quantity);
      }

      const previouslyReturnedQtyByItem = buildReturnedQtyMap(saleDocument.items_return);
      const incomingReturnQtyByItem = new Map();
      for (const item of returnItems) {
        addQtyToMap(incomingReturnQtyByItem, normalizeReturnItemKey(item), item.item_quantity);
      }

      const overReturnItems = [];
      for (const [itemId, incomingQty] of incomingReturnQtyByItem.entries()) {
        const remainingQty = roundQty(remainingQtyByItem.get(itemId) || 0);
        const alreadyReturnedQty = roundQty(previouslyReturnedQtyByItem.get(itemId) || 0);
        const originalQty = roundQty(remainingQty + alreadyReturnedQty);

        if (incomingQty <= 0 || incomingQty > remainingQty + 0.0001) {
          const returnLine =
            returnItems.find((item) => normalizeReturnItemKey(item) === itemId) || {};
          overReturnItems.push({
            item_id: itemId,
            item_name: returnLine.item_name || returnLine.name || '',
            original_quantity: originalQty,
            already_returned_quantity: alreadyReturnedQty,
            remaining_quantity: remainingQty,
            requested_quantity: incomingQty,
          });
        }
      }

      if (overReturnItems.length) {
        await releaseReturnLock();
        return {
          status: false,
          statusCode: 409,
          data: {
            items: overReturnItems,
          },
          message: 'Return quantity cannot exceed the remaining sale quantity',
        };
      }

      const firstNonEmptyFromArray = (arr, key) => {
        if (!Array.isArray(arr)) return null;
        for (const entry of arr) {
          if (entry && typeof entry[key] === 'string' && entry[key].trim() !== '') {
            return entry[key];
          }
        }
        return null;
      };

      const salesDescriptionFromPayload =
        firstNonEmptyFromArray(returnItems, 'sales_description') ||
        firstNonEmptyFromArray(items, 'sales_description') ||
        (typeof payload.sales_description === 'string' ? payload.sales_description : null);

      const paymentDescriptionFromPayload =
        firstNonEmptyFromArray(returnItems, 'payment_description') ||
        firstNonEmptyFromArray(items, 'payment_description') ||
        (typeof payload.payment_description === 'string' ? payload.payment_description : null);

      const discountDescriptionFromPayload =
        firstNonEmptyFromArray(returnItems, 'discount_description') ||
        firstNonEmptyFromArray(items, 'discount_description') ||
        (typeof payload.discount_description === 'string' ? payload.discount_description : null);

      const originalSaleItems = Array.isArray(saleDocument.items) ? saleDocument.items : [];

      const itemsSale = [];

      for (const item of items) {
        const rawItemId = item.item_id || item.item || item.id;
        if (!rawItemId || !MongooseObjectId.isValid(String(rawItemId))) {
          continue;
        }

        const itemObjectId = new MongooseObjectId(String(rawItemId));
        const itemFilter = {
          _id: itemObjectId,
          ...(licenseId ? { license: licenseId } : {}),
        };

        const itemDoc = await itemsCollection.findOne(itemFilter);
        if (!itemDoc) {
          continue;
        }

        const qty = toNumberSafe(item.item_quantity, 0);
        if (!qty || qty <= 0) {
          continue;
        }

        const price = toNumberSafe(item.item_price, 0);
        const totalAmount = toNumberSafe(item.total_amount, qty * price);
        const costLine = originalSaleItems.find(
          (line) => normalizeReturnItemKey(line) === normalizeReturnItemKey(item)
        );
        const originalQty = toNumberSafe(costLine?.item_quantity, 0);
        const companyPrice =
          originalQty > 0 && Number.isFinite(Number(costLine?.company_price_total))
            ? (qty * Number(costLine.company_price_total)) / originalQty
            : require('../helpers/selling-units').stockQuantity(costLine || item, qty) *
              toNumberSafe(itemDoc.company_price, 0);

        const discountAmount = toNumberSafe(item.item_discount, 0);
        const discountPercentage =
          discountAmount > 0 ? 0 : toNumberSafe(item.item_discount_percentage, 0);

        const availableQty = toNumberSafe(item.item_available_quantity, 0);

        itemsSale.push({
          item_status: 'Add',
          return: false,
          item_name: item.item_name,
          ...itemText.snapshot(item.translations ? item : itemDoc),
          item_sku: itemDoc.itemid || itemDoc.sku || '',
          item_price: price,
          item_discount: discountAmount,
          item_discount_percentage: discountPercentage,
          item_quantity: qty,
          item_available_quantity: availableQty,
          ...require('../utils/order-line').identity(item),
          item_id: rawItemId,
          total_amount: totalAmount,
          barcode_id: itemDoc.barcode_id,
          company_price_total: companyPrice,
          category_id: itemDoc.category_id,
          category_name: itemDoc.category_name,
          supplier_id: itemDoc.supplier_id,
          supplier_name: itemDoc.supplier_name,
          item_unit:
            (
              originalSaleItems.find(
                (line) =>
                  normalizeReturnItemKey(line) === normalizeReturnItemKey(item) &&
                  String(line.item_id || line.item) === String(rawItemId)
              ) || {}
            ).item_unit ||
            item.item_unit ||
            'qty',
          unit_conversion: (
            originalSaleItems.find(
              (line) =>
                normalizeReturnItemKey(line) === normalizeReturnItemKey(item) &&
                String(line.item_id || line.item) === String(rawItemId)
            ) || {}
          ).unit_conversion,
        });
      }

      const itemsReturn = [];
      let itemsTotalAmount = 0;

      const returnFlag = true;
      const process = 'Return';

      for (const item of returnItems) {
        const rawItemId = item.item_id || item.item || item.id;
        if (!rawItemId || !MongooseObjectId.isValid(String(rawItemId))) {
          continue;
        }

        const itemObjectId = new MongooseObjectId(String(rawItemId));
        const itemFilter = {
          _id: itemObjectId,
          ...(licenseId ? { license: licenseId } : {}),
        };

        const itemDoc = await itemsCollection.findOne(itemFilter);
        if (!itemDoc) {
          continue;
        }

        const qty = toNumberSafe(item.item_quantity, 0);
        const price = toNumberSafe(item.item_price, 0);
        const totalAmount = toNumberSafe(item.total_amount, qty * price);

        const costLine = originalSaleItems.find(
          (line) => normalizeReturnItemKey(line) === normalizeReturnItemKey(item)
        );
        const originalQty = toNumberSafe(costLine?.item_quantity, 0);
        const companyPrice =
          originalQty > 0 && Number.isFinite(Number(costLine?.company_price_total))
            ? (qty * Number(costLine.company_price_total)) / originalQty
            : require('../helpers/selling-units').stockQuantity(costLine || item, qty) *
              toNumberSafe(itemDoc.company_price, 0);

        const originalLine =
          originalSaleItems.find((line) => {
            if (!line || typeof line !== 'object') return false;
            const srcId = line.item_id || line.item || line.itemId;
            return (
              srcId &&
              String(srcId) === String(rawItemId) &&
              normalizeReturnItemKey(line) === normalizeReturnItemKey(item)
            );
          }) || null;

        const discountAmountRaw = toNumberSafe(originalLine && originalLine.item_discount, 0);
        const discountPercentageRaw = toNumberSafe(
          originalLine && originalLine.item_discount_percentage,
          0
        );
        const discountAmount = discountAmountRaw > 0 ? discountAmountRaw : 0;
        const discountPercentage = discountAmountRaw === 0 ? discountPercentageRaw : 0;

        const returnPrefixId = `RFS${formatDate(now, {
          year: '2-digit',
          month: '2-digit',
          day: '2-digit',
        }).replace(/[^0-9]/g, '')}${Math.floor(Math.random() * 1e4)}`;

        itemsReturn.push({
          unit_conversion: originalLine && originalLine.unit_conversion,
          item_status: process,
          return: returnFlag,
          item_name: item.item_name,
          item_sku:
            (originalLine && (originalLine.item_sku || originalLine.item_code)) ||
            itemDoc.itemid ||
            itemDoc.sku ||
            '',
          item_price: price,
          item_discount: discountAmount,
          item_discount_percentage: discountPercentage,
          item_quantity: qty,
          ...require('../utils/order-line').identity(item),
          item_id: rawItemId,
          total_amount: totalAmount,
          barcode_id: itemDoc.barcode_id,
          company_price_total: companyPrice,
          category_id: itemDoc.category_id,
          category_name: itemDoc.category_name,
          supplier_id: itemDoc.supplier_id,
          supplier_name: itemDoc.supplier_name,
          return_id: returnPrefixId,
          return_date: now,
          item_unit: (originalLine && originalLine.item_unit) || item.item_unit || 'qty',
        });

        itemsTotalAmount += totalAmount;
      }

      const extraDiscountRaw =
        payload.extra_discount !== undefined && payload.extra_discount !== null
          ? Number(payload.extra_discount)
          : 0;
      let extraDiscount = Number.isFinite(extraDiscountRaw) ? extraDiscountRaw : 0;

      let itemsTotMinusExtraDisc = itemsTotalAmount - extraDiscount;

      if (payload.extra_discount_type === 'percent') {
        const discAmt = (itemsTotalAmount * extraDiscount) / 100;
        itemsTotMinusExtraDisc = itemsTotalAmount - discAmt;
        extraDiscount = discAmt;
      }

      const roundOffCheck = payload.round_off_check === true;
      const roundOffValue = roundOffCheck
        ? round(itemsTotMinusExtraDisc) - itemsTotMinusExtraDisc
        : 0;
      const returnItemsTotalAmount = roundOffCheck
        ? round(itemsTotMinusExtraDisc)
        : itemsTotMinusExtraDisc;

      const returnObjId = new MongooseObjectId();
      const returnRegisterId =
        await require('../services/business-return-register').verifiedReturnRegister(db, {
          sessionId: payload.return_register_id,
          license: licenseId,
          branchId,
          actorId: BaseModel.loggedUser,
          deviceId,
          at: now,
        });

      const itemsReturnData = {
        returnArray: {
          returnObjId,
          returnId: `RFS${formatDate(now, {
            year: '2-digit',
            month: '2-digit',
            day: '2-digit',
          }).replace(/[^0-9]/g, '')}${Math.floor(Math.random() * 1e4)}`,
          returnDate: now,
          ...(returnRegisterId ? { cashregister_id: returnRegisterId } : {}),
          returnValue: itemsReturn,
          roundOff: round(roundOffValue, 2),
          itemsTotalAmount: round(returnItemsTotalAmount, 2),
          extraDiscount: round(Math.abs(extraDiscount), 2),
          extraDiscountType: payload.extra_discount_type,
        },
      };

      const pushReturnResult = await salesCollection.updateOne(
        {
          _id: saleObjectId,
          ...licenseFilter,
          'return_refund_lock.token': lockToken,
        },
        require('../services/business-item-origin').withOriginalItemFacts(
          saleDocument,
          {
            $push: {
              items_return: itemsReturnData,
              return_refund_transactions: {
                signature: returnSignature,
                return_obj_id: returnObjId,
                return_id: itemsReturnData.returnArray.returnId,
                amount: round(returnItemsTotalAmount, 2),
                item_count: itemsReturn.length,
                created_at: now,
                ...(returnRegisterId ? { cashregister_id: returnRegisterId } : {}),
                created_by: BaseModel.loggedUser || null,
                created_by_name: BaseModel.loggedUserName || 'System',
              },
            },
          },
          now
        )
      );

      if (!pushReturnResult.modifiedCount) {
        await releaseReturnLock();
        return {
          status: false,
          statusCode: 409,
          data: null,
          message: 'Refund could not be saved because another return changed this sale',
        };
      }

      try {
        const stockLogsRepository = new StockLogsRepository();

        for (const item of returnItems) {
          const rawItemId = item.item_id || item.item || item.id;
          if (!rawItemId || !MongooseObjectId.isValid(String(rawItemId))) {
            continue;
          }

          const itemObjectId = new MongooseObjectId(String(rawItemId));
          const itemFilter = {
            _id: itemObjectId,
            ...(licenseId ? { license: licenseId } : {}),
          };

          const itemDoc = await itemsCollection.findOne(itemFilter);
          if (!itemDoc) {
            continue;
          }

          const openingBalance = Number(itemDoc.available_quantity || 0);
          const sourceLine =
            originalSaleItems.find(
              (line) =>
                normalizeReturnItemKey(line) === normalizeReturnItemKey(item) &&
                String(line.item_id || line.item) === String(rawItemId)
            ) || {};
          const itemQty = require('../helpers/selling-units').stockQuantity(
            sourceLine,
            item.item_quantity || 0
          );
          if (!itemQty || itemQty <= 0) {
            continue;
          }

          const closingBalance = openingBalance + itemQty;

          // PHP checks: $item_documents['track_inventory'] === true (boolean or string 'true')
          if (itemDoc.track_inventory === true || itemDoc.track_inventory === 'true') {
            const countStr = String(itemQty);

            await stockLogsRepository.createStockLog({
              stocklog: true,
              branch_id: branchId,
              view_item_id: itemObjectId,
              item_barcode_id: itemDoc.barcode_id || '',
              item_name: item.item_name || item.name || itemDoc.name || '',
              item_quantity: itemQty,
              process: 'Return Sale',
              reference: payload.alternative_id || saleDocument.alternative_id || saleObjectId,
              opening_balance: openingBalance,
              closing_balance: closingBalance,
              count: countStr,
              date: now,
              action: 'Add',
              changed_by_userid: BaseModel.loggedUser,
              changed_by: BaseModel.loggedUserName || 'System',
            });

            await itemsCollection.updateOne(itemFilter, {
              $set: {
                available_quantity: closingBalance,
              },
            });
          }
        }
      } catch (e) {
        console.error('Error updating stock for return sale:', e);
      }

      try {
        saleDocument =
          (await salesCollection.findOne({ _id: saleObjectId, ...licenseFilter })) || saleDocument;

        const extra_discount = Number(saleDocument.extra_discount || 0);
        let return_extra_discount = 0;
        let return_sale_amount = 0;
        let return_round_off = 0;
        let return_sale_amount_round = 0;
        const returnDiscountData = [];
        const returnSubtotalData = [];
        let return_sale_company_amount = 0;

        const itemsReturnBlocks = Array.isArray(saleDocument.items_return)
          ? saleDocument.items_return
          : [];

        for (const block of itemsReturnBlocks) {
          if (!block || !block.returnArray) continue;
          const ra = block.returnArray;

          return_round_off += Number(ra.roundOff || 0);
          return_sale_amount_round += Number(ra.itemsTotalAmount || 0);
          return_extra_discount += Number(ra.extraDiscount || 0);

          const values = Array.isArray(ra.returnValue) ? ra.returnValue : [];
          for (const documents of values) {
            const itemQuantity = Number(documents.item_quantity || 0);
            const itemPrice = Number(documents.item_price || 0);
            const itemAmount = itemPrice * itemQuantity;

            return_sale_company_amount += Number(documents.company_price_total || 0);
            return_sale_amount += Number(documents.total_amount || 0);

            const itemDiscount = Number(documents.item_discount || 0);
            const itemDiscountPercentage = Number(documents.item_discount_percentage || 0);

            let itemDiscountAmountMultiple = 0;
            if (itemDiscount > 0) {
              itemDiscountAmountMultiple = itemDiscount * itemQuantity;
            } else if (itemDiscountPercentage > 0) {
              itemDiscountAmountMultiple = itemAmount * (itemDiscountPercentage / 100);
            }

            returnDiscountData.push({ discount_amount: itemDiscountAmountMultiple });
            returnSubtotalData.push({ subtotal_amount: itemAmount });
          }
        }

        const return_sale_subtotal_amount = returnSubtotalData.reduce(
          (sum, row) => sum + Number(row.subtotal_amount || 0),
          0
        );
        const return_sale_discount_amount = returnDiscountData.reduce(
          (sum, row) => sum + Number(row.discount_amount || 0),
          0
        );
        const itemsArray = Array.isArray(itemsSale) ? itemsSale : [];
        let sale_total_amount = itemsArray.reduce((sum, row) => {
          if (!row || typeof row !== 'object') return sum;

          const lineTotal = toNumberSafe(row.total_amount ?? row.total ?? row.items_total, 0);

          return sum + lineTotal;
        }, 0);

        if (!itemsArray.length) {
          sale_total_amount = 0;
        }

        const base_sale_subtotal = Number(
          saleDocument.sales_sub_total ?? saleDocument.items_subtotal ?? sale_total_amount
        );
        const base_sale_discount = Number(saleDocument.discount || 0);
        let base_sale_company = Number(saleDocument.total_companyprice || 0);

        if (!base_sale_company && Array.isArray(originalSaleItems)) {
          base_sale_company = originalSaleItems.reduce(
            (sum, line) =>
              sum + Number(line && line.company_price_total ? line.company_price_total : 0),
            0
          );
        }

        const sale_subtotal_amount = Math.max(base_sale_subtotal - return_sale_subtotal_amount, 0);
        const sale_discount_amount = Math.max(base_sale_discount - return_sale_discount_amount, 0);

        let sale_company_amount = itemsArray.reduce((sum, row) => {
          if (!row || typeof row !== 'object') return sum;
          const cp = toNumberSafe(row.company_price_total, 0);
          return sum + cp;
        }, 0);

        if (!Number.isFinite(sale_company_amount)) {
          sale_company_amount = 0;
        }

        const updatedRoundOffValue = roundOffCheck
          ? round(sale_total_amount) - sale_total_amount
          : 0;
        const updatedItemsTotalAmount = roundOffCheck
          ? round(sale_total_amount)
          : sale_total_amount;

        let extraDiscSubReturnExtradisc = extra_discount - return_extra_discount;
        if (payload.extra_discount_type === 'percent') {
          extraDiscSubReturnExtradisc = sale_total_amount * (extra_discount / 100);
        }

        // Zero is a recorded refund too. A fully discounted return must not
        // fall back to the undiscounted line sum merely because its total is 0.
        const recordedReturnTotals =
          itemsReturnBlocks.length > 0 &&
          itemsReturnBlocks.every(
            (block) =>
              typeof block?.returnArray?.itemsTotalAmount === 'number' &&
              Number.isFinite(block.returnArray.itemsTotalAmount)
          );
        if (return_sale_amount_round !== 0 || recordedReturnTotals) {
          return_sale_amount = return_sale_amount_round;
        }

        const updatedSaleProcess = sale_total_amount > 0 ? 'PartialReturn' : 'FullReturn';

        const finalItemsArray = updatedSaleProcess === 'FullReturn' ? [] : itemsArray;
        const finalNumberOfItems = updatedSaleProcess === 'FullReturn' ? 0 : itemsArray.length || 0;

        const updateData = {
          sale_process: updatedSaleProcess,
          multi_payment:
            saleDocument &&
            saleDocument.multi_payment !== undefined &&
            saleDocument.multi_payment !== null
              ? saleDocument.multi_payment
              : [],
          updated_date: now,
          updated_by: BaseModel.loggedUserName,
          updated_by_id: BaseModel.loggedUser,
          items: finalItemsArray,
          number_of_items: finalNumberOfItems,
          discount: round(sale_discount_amount, 2),
          items_total: round(updatedItemsTotalAmount - extraDiscSubReturnExtradisc, 2),
          items_subtotal: sale_subtotal_amount,
          return_discount: round(return_sale_discount_amount, 2),
          items_return_total: round(return_sale_amount, 2),
          return_round_off: round(return_round_off, 2),
          items_return_subtotal: return_sale_subtotal_amount,
          sales_description:
            salesDescriptionFromPayload &&
            typeof salesDescriptionFromPayload === 'string' &&
            salesDescriptionFromPayload.trim() !== ''
              ? salesDescriptionFromPayload
              : saleDocument.sales_description || '',
          payment_description:
            paymentDescriptionFromPayload &&
            typeof paymentDescriptionFromPayload === 'string' &&
            paymentDescriptionFromPayload.trim() !== ''
              ? paymentDescriptionFromPayload
              : saleDocument.payment_description || '',
          discount_description:
            discountDescriptionFromPayload &&
            typeof discountDescriptionFromPayload === 'string' &&
            discountDescriptionFromPayload.trim() !== ''
              ? discountDescriptionFromPayload
              : saleDocument.discount_description || '',
          notes:
            salesDescriptionFromPayload &&
            typeof salesDescriptionFromPayload === 'string' &&
            salesDescriptionFromPayload.trim() !== ''
              ? salesDescriptionFromPayload
              : saleDocument.notes || saleDocument.sales_description || '',
          round_off: round(updatedRoundOffValue, 2),
          sale_extra_discount: round(Math.abs(extraDiscSubReturnExtradisc), 2),
          return_extra_discount: round(Math.abs(return_extra_discount), 2),
          total_companyprice: sale_company_amount,
        };

        await salesCollection.updateOne(
          {
            _id: saleObjectId,
            ...licenseFilter,
            'return_refund_lock.token': lockToken,
          },
          {
            $set: updateData,
          }
        );

        try {
          const cashregisterCollection = db.collection('cashregister');
          await cashregisterCollection.updateOne(
            {
              'register_sales.sales_id': saleObjectId,
              ...licenseFilter,
            },
            {
              $set: {
                'register_sales.$.sale_process': updatedSaleProcess,
                'register_sales.$.register_amount': sale_total_amount,
                'register_sales.$.registerItems_return_total': return_sale_amount,
              },
            }
          );
        } catch (err) {
          console.error('Error updating cashregister for return sale:', err);
        }
      } catch (aggErr) {
        console.error('Error updating sale aggregates for return:', aggErr);
      }

      const printFlag =
        payload.print === 'on' ||
        payload.print === true ||
        payload.print === 'true' ||
        (branchSettings && branchSettings.printall === true);

      await releaseReturnLock();

      /* A return changed the sale record (and possibly minted a return doc):
         both must reach the cloud on the critical lane, not the 15s scan.
         Fire-safe; no-op in the cloud. */
      try {
        const { enqueue, REASONS } = require('../sync/outbox');
        enqueue({ collection: 'sales', documentId: saleObjectId, reason: REASONS.RETURN });
        if (returnObjId && String(returnObjId) !== String(saleObjectId)) {
          enqueue({ collection: 'sales', documentId: returnObjId, reason: REASONS.RETURN });
        }
        require('../sync/nudge').nudgeSyncAgent();
      } catch (e) {
        /* accelerator only */
      }

      return {
        status: true,
        data: {
          print: printFlag,
          sale_id: String(returnObjId || saleObjectId),
          return_id: itemsReturnData.returnArray.returnId,
          return_amount: round(returnItemsTotalAmount, 2),
          returned_items: itemsReturn.map((item) => ({
            item_id: item.item_id,
            item_name: item.item_name,
            quantity: item.item_quantity,
            total_amount: item.total_amount,
          })),
          refund_reason:
            salesDescriptionFromPayload ||
            paymentDescriptionFromPayload ||
            discountDescriptionFromPayload ||
            payload.reason ||
            '',
        },
        message: 'success',
      };
    } catch (error) {
      console.error('Error in returnSalesOrder:', error);
      await releaseReturnLock();
      return {
        status: false,
        ...(error.status === 409 ? { statusCode: 409 } : {}),
        data: null,
        message: error.message,
      };
    }
  }

  async exportSalesOrder(data = [], { SaleModel } = {}) {
    try {
      let ids = [];

      if (Array.isArray(data)) {
        ids = data;
      } else if (data && Array.isArray(data.data)) {
        ids = data.data;
      } else if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            ids = parsed;
          }
        } catch (e) {}
      }

      if (!ids.length) {
        return {
          status: false,
          data: null,
          message: 'No IDs provided',
        };
      }

      const objectIds = ids
        .map((id) => (id != null ? String(id).trim() : ''))
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (!objectIds.length) {
        return {
          status: false,
          data: null,
          message: 'No valid IDs provided',
        };
      }

      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const filter = {
        _id: { $in: objectIds },
      };

      if (BaseModel.license) {
        filter.license = BaseModel.license;
      }

      const cursor = salesCollection.find(filter, {
        sort: { _id: -1 },
        projection: {
          sales_id: 1,
          customer_name: 1,
          customer_address: 1,
          customer_phone: 1,
          customer_email: 1,
          payment_mode: 1,
          payment_description: 1,
          sales_description: 1,
          sales_sub_total: 1,
          sales_total: 1,
        },
      });

      const docs = await cursor.toArray();

      return {
        status: true,
        data: docs,
        message: 'Sale Data Exported',
      };
    } catch (error) {
      console.error('Error in exportSalesOrder:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async getSalesDataChanges(from, { SaleModel } = {}) {
    const collectionName = 'sales';
    const base = new BaseModel(collectionName);

    // Mirror legacy BaseModel::getAllDataChanges behaviour used in the
    // Sale model static getDataChanges, but keep the logic in the
    // repository layer instead of the Mongoose model.
    return base.getAllDataChanges(collectionName, 'sales', from, null);
  }

  async getReturnSalesDetails(salesId, { SaleModel } = {}) {
    try {
      if (!salesId || !mongoose.Types.ObjectId.isValid(salesId)) {
        return { status: false, data: null, message: 'Invalid sale id' };
      }

      const saleObjectId = new mongoose.Types.ObjectId(salesId);
      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');

      const filter = {
        _id: saleObjectId,
        ...activeTenantFilter(),
      };

      const saleDoc = await salesCollection.findOne(filter);

      if (!saleDoc) {
        return { status: false, data: null, message: 'Sale not found' };
      }

      const normalized = BaseModel.simplifyFields(saleDoc);

      return {
        status: true,
        data: normalized,
        message: 'success',
      };
    } catch (error) {
      console.error('Error in getReturnSalesDetails:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getReturnPrintDetails(id, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return { status: false, data: null, message: 'Invalid return id' };
      }

      const returnObjId = new mongoose.Types.ObjectId(id);

      const matchStage = {
        'items_return.returnArray.returnObjId': returnObjId,
      };
      if (BaseModel.license) {
        matchStage.license = BaseModel.license;
      }

      const pipeline = [
        { $match: matchStage },
        { $unwind: '$items_return' },
        { $unwind: '$items_return.returnArray' },
        { $unwind: '$items_return.returnArray.returnValue' },
        { $match: { 'items_return.returnArray.returnObjId': returnObjId } },
        {
          $project: {
            sales_id: '$sales_id',
            customer_name: '$customer_name',
            customer_phone: '$customer_phone',
            customer_email: '$customer_email',
            customer_address: '$customer_address',
            customer_print: '$customer_print',
            print_sale_notes: '$print_sale_notes',
            sales_description: '$sales_description',
            return_discount: '$return_discount',
            items_return_subtotal: '$items_return_subtotal',
            items_return_total: '$items_return_total',
            payment_mode: '$payment_mode',
            return_id: '$items_return.returnArray.returnId',
            return_date: '$items_return.returnArray.returnDate',
            item_id: '$items_return.returnArray.returnValue.item_id',
            item_name: '$items_return.returnArray.returnValue.item_name',
            item_price: '$items_return.returnArray.returnValue.item_price',
            item_discount: '$items_return.returnArray.returnValue.item_discount',
            item_discount_percentage:
              '$items_return.returnArray.returnValue.item_discount_percentage',
            item_quantity: '$items_return.returnArray.returnValue.item_quantity',
            item_unit: '$items_return.returnArray.returnValue.item_unit',
            total_amount: '$items_return.returnArray.returnValue.total_amount',
            roundOff: '$items_return.returnArray.roundOff',
            itemsTotalAmount: '$items_return.returnArray.itemsTotalAmount',
            extraDiscount: '$items_return.returnArray.extraDiscount',
          },
        },
      ];

      const docs = await Model.aggregate(pipeline);

      if (!docs || !docs.length) {
        return {
          status: false,
          data: null,
          message: 'Sales Details Not Found',
        };
      }

      const numberOrZero = (value, fallback = 0) => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const num = Number(value);
        if (Number.isFinite(num)) return num;
        const fb = Number(fallback);
        return Number.isFinite(fb) ? fb : 0;
      };

      const first = docs[0];

      const tz = BaseModel.currentTimeZone || 'Africa/Cairo';

      const custom_data = {
        sales_id: first.sales_id || '',
        return_id: first.return_id || '',
        date: formatDate(first.return_date || first.date, { timeZone: tz }),
        customer_name: first.customer_name || '',
        customer_phone: first.customer_phone || '',
        customer_email: first.customer_email || '',
        customer_address: first.customer_address || '',
        customer_print: typeof first.customer_print === 'boolean' ? first.customer_print : true,
        print_sale_notes: first.print_sale_notes === true,
        sales_description: first.sales_description || '',
        discount: round(numberOrZero(first.return_discount, 0), 2),
        payment_mode: first.payment_mode || '',
        receipt_barcode: true,
      };

      const return_data = docs.map((row) => ({
        item_id: row.item_id,
        item_name: row.item_name,
        item_quantity: numberOrZero(row.item_quantity, 0),
        item_price: numberOrZero(row.item_price, 0),
        item_total_amount: numberOrZero(row.total_amount, 0),
        item_discount: numberOrZero(row.item_discount, 0),
        item_discount_percentage: numberOrZero(row.item_discount_percentage, 0),
        item_return_discount: numberOrZero(row.item_discount, 0),
        item_unit: row.item_unit && typeof row.item_unit === 'string' ? row.item_unit : 'qty',
        roundOff: numberOrZero(row.roundOff, 0),
        extraDiscount: numberOrZero(row.extraDiscount, 0),
        itemsTotalAmount: numberOrZero(row.itemsTotalAmount, 0),
      }));

      return {
        status: true,
        data: { custom_data, return_data },
        message: 'Get detail successfully',
      };
    } catch (error) {
      console.error('Error in returnPrintDetailsPage:', error);
      return { status: false, data: null, message: error.message };
    }
  }

  async getSalesAjaxList(query, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.getSalesAjaxList(query);
  }

  async getSaleQtyDetail(id, { SaleModel } = {}) {
    try {
      const ObjectId = mongoose.Types.ObjectId;

      if (!id || !ObjectId.isValid(String(id))) {
        return {
          status: false,
          data: null,
          message: 'Invalid sale id',
        };
      }

      const saleObjectId = new ObjectId(String(id));
      const db = await BaseModel.getDb();
      const salesCollection = db.collection('sales');
      const itemsCollection = db.collection('items');

      const condition = {
        _id: saleObjectId,
      };

      if (BaseModel.currentBranch) {
        let branchId = BaseModel.currentBranch;
        if (!(branchId instanceof ObjectId) && ObjectId.isValid(String(branchId))) {
          branchId = new ObjectId(String(branchId));
        }
        condition.branch_id = branchId;
      }
      if (BaseModel.license) {
        condition.license = BaseModel.license;
      }

      const pipeline = [
        { $unwind: '$items' },
        { $match: condition },
        {
          $group: {
            _id: {
              item_id: '$items.item_id',
              sale_quantity: '$items.item_quantity',
              sale_available_quantity: '$items.item_available_quantity',
            },
          },
        },
      ];

      const cursor = salesCollection.aggregate(pipeline);
      const saleData = [];

      for await (const doc of cursor) {
        const groupId = doc && doc._id;
        if (!groupId) continue;

        saleData.push({
          item_id: groupId.item_id,
          sale_quantity: Number(groupId.sale_quantity || 0),
          sale_available_quantity: Number(groupId.sale_available_quantity || 0),
        });
      }

      let saleQuantity = 0;
      let itemQuantity = 0;

      // Mirror PHP behaviour: iterate over grouped items and keep the
      // last pair of saleQuantity / itemQuantity encountered.
      for (const item of saleData) {
        saleQuantity = Number(item.sale_quantity || 0);

        const rawItemId = item.item_id;
        if (!rawItemId || !ObjectId.isValid(String(rawItemId))) {
          continue;
        }

        const itemObjectId = new ObjectId(String(rawItemId));
        const itemFilter = {
          _id: itemObjectId,
        };
        if (BaseModel.license) {
          itemFilter.license = BaseModel.license;
        }

        const itemDoc = await itemsCollection.findOne(itemFilter);
        if (!itemDoc) {
          continue;
        }

        itemQuantity = Number(itemDoc.available_quantity || 0);
      }

      if (saleQuantity <= itemQuantity) {
        return {
          status: true,
          data: null,
          message: 'Available',
        };
      }

      return {
        status: false,
        data: null,
        message: 'Not available instock',
      };
    } catch (error) {
      console.error('Error in getSaleQtyDetailModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async sendDailySalesMail(input, { SaleModel, shopTransport } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.sendDailySalesMail(input, shopTransport);
  }

  async salesPaymentCloseModel(data, { SaleModel } = {}) {
    try {
      if (!data.sales || data.sales.length === 0) {
        return {
          status: false,
          data: null,
          message: 'empty value',
        };
      }

      const db = await BaseModel.getDb();
      const saleCollection = db.collection('sales');
      const transactionCollection = db.collection('transaction');
      const customerCollection = db.collection('customers');

      // Get context from value
      const license = data.license;
      const branch_id = data.branch_id;
      const loggedUserName = data.loggedUserName;
      const loggedUserId = data.loggedUserId;

      // Process each sale
      for (const saleData of data.sales) {
        // Build query filter
        const saleQuery = {
          _id: new ObjectId(saleData.id),
          license,
        };

        // Only add branch_id if it's valid
        if (branch_id && ObjectId.isValid(branch_id)) {
          saleQuery.branch_id = new ObjectId(branch_id);
        }

        // Get sale details first
        const saleDetails = await saleCollection.findOne(saleQuery);
        if (!saleDetails) continue;

        // Build update filter (same as query filter)
        const updateFilter = {
          _id: new ObjectId(saleData.id),
          license,
        };

        if (branch_id && ObjectId.isValid(branch_id)) {
          updateFilter.branch_id = new ObjectId(branch_id);
        }

        const settled = await saleCollection.updateMany(updateFilter, {
          $set: {
            partial_balance: parseFloat(saleData.amount) + parseFloat(saleData.paidamount || 0),
            payment_status: 'Paid',
            payment_pending: 0.0,
            updated_date: new Date(),
            updated_by: loggedUserName,
            updated_by_id: loggedUserId ? new ObjectId(loggedUserId) : undefined,
          },
        });

        if (!settled.matchedCount) throw new Error('Sale payment could not be updated.');

        // Build transaction filter
        const transactionFilter = {
          sale_id: new ObjectId(saleData.id),
          license,
        };

        if (branch_id && ObjectId.isValid(branch_id)) {
          transactionFilter.branch_id = new ObjectId(branch_id);
        }

        // Update transaction
        await transactionCollection.updateOne(transactionFilter, {
          $set: {
            description: 'Edit sale',
            amount: parseFloat(saleData.amount),
            type: 'out',
            pending: 0.0,
            updated_date: new Date(),
          },
        });

        // Update wallet amount
        await saleCollection.updateOne(updateFilter, {
          $set: {
            wallet_amount: (saleDetails.wallet_amount || 0) + parseFloat(saleData.amount),
          },
        });
      }

      /* A settlement with no customer to recompute (a walk-in sale marked
         paid from its invoice) stops here: the sales are settled, and there
         is no ledger to total. Before this guard, ObjectId(undefined) threw
         AFTER the sales were already marked paid. */
      if (!data.id || !ObjectId.isValid(String(data.id))) {
        return { status: true, data: 0, message: 'Sales settled successfully' };
      }

      // Recalculate customer balance
      const filters = {
        customer_id: new ObjectId(data.id),
        license,
      };

      if (branch_id && ObjectId.isValid(branch_id)) {
        filters.branch_id = new ObjectId(branch_id);
      }

      const aggregateResult = await transactionCollection
        .aggregate([
          { $match: filters },
          {
            $group: {
              _id: null,
              totalInAmount: {
                $sum: { $cond: [{ $eq: ['$type', 'in'] }, '$amount', 0] },
              },
              totalOutAmount: {
                $sum: { $cond: [{ $eq: ['$type', 'out'] }, '$amount', 0] },
              },
            },
          },
          {
            $addFields: {
              totalAmountDue: {
                $subtract: ['$totalInAmount', '$totalOutAmount'],
              },
            },
          },
        ])
        .toArray();

      const totalWalletAmount = aggregateResult.length > 0 ? aggregateResult[0].totalAmountDue : 0;

      // Build customer update filter
      const customerFilter = {
        _id: new ObjectId(data.id),
        license,
      };

      if (branch_id && ObjectId.isValid(branch_id)) {
        customerFilter.branch_id = new ObjectId(branch_id);
      }

      // Update customer balance
      await customerCollection.updateOne(customerFilter, {
        $set: {
          balance: totalWalletAmount,
        },
      });

      return {
        status: true,
        data: totalWalletAmount,
        message: 'Sales settled successfully',
      };
    } catch (error) {
      console.error('Error in salesPaymentCloseModel:', error);
      return {
        status: false,
        data: null,
        message: error.message,
      };
    }
  }

  async fetchLastSaleModel(branchId, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.fetchLastSaleModel(branchId);
  }

  async itemExpiryReportPage(data, options, { SaleModel } = {}) {
    try {
      // Mirror legacy Sale.itemExpiryReportPage behaviour but keep logic in
      // the repository layer instead of on the Mongoose model.
      const baseModel = new BaseModel('items');

      const fromDate = baseModel.startingDate(
        data.starting_date,
        BaseModel.currentTimeZone || 'Africa/Cairo'
      );
      const toDate = baseModel.endingDate(
        data.ending_date,
        BaseModel.currentTimeZone || 'Africa/Cairo'
      );

      let branchId = data.branchid;
      if (Array.isArray(branchId)) {
        branchId = branchId[0];
      }
      if (branchId && typeof branchId === 'string' && mongoose.Types.ObjectId.isValid(branchId)) {
        branchId = new mongoose.Types.ObjectId(branchId);
      }

      const limit = parseInt(options.limit, 10) || 5;
      const page = parseInt(options.page, 10) || 1;
      const skip = Math.max(0, (page - 1) * limit);

      const collection = await baseModel.getCollection('items');

      // items_expiry_date may be stored as a BSON Date (PHP legacy) or as a
      // string "YYYY-MM-DD" (Node.js created items).  Use $or to match both.
      const fromDateObj = new Date(fromDate);
      const toDateObj = new Date(toDate);
      const fromDateStr = fromDateObj.toISOString().split('T')[0];
      const toDateStr = toDateObj.toISOString().split('T')[0];

      const filters = {
        $or: [
          { items_expiry_date: { $gte: fromDateObj, $lte: toDateObj } },
          { items_expiry_date: { $gte: fromDateStr, $lte: toDateStr } },
        ],
        available_quantity: { $gt: 0 },
        'branch_access.branch_id': branchId,
      };

      const total = await collection.countDocuments(filters);

      const expiredItems = await collection
        .find(filters, {
          projection: {
            name: 1,
            available_quantity: 1,
            category_name: 1,
            items_expiry_date: 1,
          },
          skip,
          limit,
        })
        .toArray();

      const itemData = expiredItems.map((item) => {
        const expiryDate =
          item.items_expiry_date instanceof Date
            ? item.items_expiry_date.toISOString().split('T')[0]
            : new Date(item.items_expiry_date).toISOString().split('T')[0];

        return {
          item_name: item.name || '',
          available_quantity: item.available_quantity || 0,
          category_name: item.category_name || '',
          expiry_date: expiryDate,
        };
      });

      return {
        status: true,
        total,
        current_page: page,
        total_pages: Math.ceil(total / limit),
        per_page: limit,
        list: itemData,
      };
    } catch (error) {
      console.error('Error in itemExpiryReportPage:', error);
      return {
        status: false,
        data: null,
        message: error.message || 'Failed to fetch item expiry report',
      };
    }
  }

  async salePage(filters, options, branchId, { SaleModel } = {}) {
    try {
      const Model = this.getModel(SaleModel);

      const limit = parseInt(options?.limit, 10) || 10;
      const page = parseInt(options?.page, 10) || 1;
      const skip = (page - 1) * limit;
      const sort = options?.sort || { _id: -1 };

      const query = {};

      // Apply branchId filter
      if (branchId) {
        const { ObjectId } = require('mongodb');
        if (ObjectId.isValid(String(branchId))) {
          query.branch_id = new mongoose.Types.ObjectId(String(branchId));
        } else {
          query.branch_id = branchId;
        }
      }

      // Apply filters
      if (filters && typeof filters === 'object') {
        for (const [key, value] of Object.entries(filters)) {
          if (key === 'branch_id') continue; // already handled
          query[key] = value;
        }
      }

      // Add license filter
      if (BaseModel.license) {
        query.license = BaseModel.license;
      }

      const [docs, total] = await Promise.all([
        Model.find(query).sort(sort).skip(skip).limit(limit).lean(),
        Model.countDocuments(query),
      ]);

      return {
        status: true,
        message: docs.length ? 'Records fetched' : 'No records found',
        data: {
          list: docs,
          total,
          per_page: limit,
          current_page: page,
          total_pages: Math.max(Math.ceil(total / limit), 1),
        },
      };
    } catch (error) {
      console.error('Error in salePage:', error);
      return { status: false, message: error.message, data: null };
    }
  }

  /**
   * The next bill number for a branch: the counter and the format together.
   *
   * THE ONLY DOOR. Both the till and the customer's own ordering page come
   * through here, and they have to: they share one counter, so a year that
   * resets on one path and not the other would have the till issuing numbers
   * the year had already used. sale.service.js used to take the number and
   * build it itself, which is how the two would have drifted.
   *
   * `fallbackPrefix` exists for those callers, which hold the shop's prefix
   * already and would rather not have this read the branch to find the same
   * answer twice.
   */
  async generateSalesIdForBranch(
    branchIdRaw,
    { reseed = false, fallbackPrefix, numberingContext } = {}
  ) {
    if (!branchIdRaw) {
      throw new Error('branchId is required to generate sales_id');
    }

    if (numberingContext && (!numberingContext.db || !numberingContext.license))
      throw new Error('A database and licence are required for scoped bill numbering');
    const db = numberingContext?.db || (await BaseModel.getDb());
    const branches = db.collection('branches');
    const salesCollection = db.collection('sales');

    const branchId =
      branchIdRaw instanceof mongoose.Types.ObjectId
        ? branchIdRaw
        : mongoose.Types.ObjectId.isValid(String(branchIdRaw))
          ? new mongoose.Types.ObjectId(String(branchIdRaw))
          : branchIdRaw;

    const branchDoc = await branches.findOne({
      _id: branchId,
      ...(numberingContext
        ? { license: numberingContext.license }
        : BaseModel.license
          ? { license: BaseModel.license }
          : {}),
    });
    if (numberingContext && !branchDoc)
      throw new Error('Branch not found for scoped bill numbering');
    // The prefix comes from the branch config. An empty prefix is honoured - a
    // shop may want plain numbers - so only a branch that never set the field
    // falls back to the default 'S'.
    const prefixRaw = branchDoc?.sales_prefix ?? branchDoc?.salesPrefix;
    const prefix =
      fallbackPrefix !== undefined
        ? String(fallbackPrefix)
        : prefixRaw != null
          ? prefixRaw.toString().trim()
          : 'S';
    const prefixLength = prefix.length;

    void prefixLength;
    void salesCollection;
    /*
     * WHICH NUMBERING PERIOD THIS BILL BELONGS TO.
     *
     * Empty for every shop that has not asked for one, which is all of them
     * until somebody turns it on - and an empty period produces exactly the
     * number this method produced before it existed. See _billPeriod.
     */
    const period = this._billPeriod(branchDoc);

    /* The branch's own licence first: see nextSalesNumberForBranch. The
       ambient one is a fallback for a branch this process cannot read. */
    const n = await this.nextSalesNumberForBranch(
      branchId,
      (branchDoc && branchDoc.license) || BaseModel.license,
      { reseed, period, numberingContext }
    );
    return this.buildDocNumber('S', branchId, n, {
      fallbackPrefix: prefix,
      period: period.label,
      numberingContext,
    });
  }

  /**
   * The numbering period a bill made RIGHT NOW falls in, for this branch.
   *
   * Owner: "we need year pattern required in the sales bill number example
   * attached have 26 in the year... you suggest per day increase or year wise
   * reset better tell me international standards", and on the answer: "i
   * accept recommandation and may configurable if people from EU and
   * international."
   *
   * IN THE SHOP'S OWN CLOCK, not the server's. A bill rung up at half past
   * midnight on the first of April in Chennai belongs to the new numbering
   * year; a cloud instance running in UTC would still call it March and put
   * it in the old one - a bill numbered into a year that has closed.
   *
   * Midday local is used rather than the exact instant so that a daylight
   * shift of an hour either way cannot move a bill across a year boundary.
   *
   * Off unless the shop asked, and off is the shape of every number issued in
   * this product so far. See utils/bill-number.js for the rule this obeys.
   */
  _billPeriod(branchDoc, when = new Date()) {
    const reset = String((branchDoc && branchDoc.bill_number_reset) || '').trim();
    if (!billNumber.RESET_MODES.includes(reset) || reset === 'off') {
      return { key: '', label: '', mode: 'off' };
    }
    try {
      const zone = (branchDoc && branchDoc.time_zone) || 'UTC';
      const local = moment(when).tz(zone);
      const atNoon = new Date(local.year(), local.month(), local.date(), 12, 0, 0);
      return billNumber.periodFor(atNoon, {
        reset,
        financialYearStartMonth: Number(branchDoc && branchDoc.bill_number_fy_start_month) || 4,
      });
    } catch (e) {
      /* A time zone nobody can read must not stop a shop billing. Off is the
         behaviour every shop had before this existed. */
      console.warn('[bill-number] could not read the shop clock:', e && e.message);
      return { key: '', label: '', mode: 'off' };
    }
  }

  /*
   * The next bill number for a branch, atomically.
   *
   * The old way read the LAST INSERTED sale and added one, which minted
   * duplicate bill numbers two different ways: two simultaneous saves both
   * read the same "last" and both got the same next number, and a sync merge
   * can insert an older-numbered sale last, so the next bill reused a number
   * the branch had already issued. Both have happened on live data.
   *
   * A per-branch counter moved with $inc is atomic in MongoDB: every caller
   * gets a distinct number no matter how many save at once. It is seeded once
   * from the highest number the branch ever issued - set-if-absent, so two
   * concurrent seeders cannot regress it - and it lives in a counters
   * collection that does not ride the sync wire, so each side numbers its own
   * writes and never inherits a counter that went backwards.
   */
  async nextSalesNumberForBranch(
    branchIdRaw,
    licenseRaw,
    { reseed = false, period = null, numberingContext } = {}
  ) {
    const db = numberingContext?.db || (await BaseModel.getDb());
    const counters = db.collection('counters');

    /*
     * ONE COUNTER PER BRANCH, whichever door the sale came through.
     *
     * The licence used to be whatever the caller happened to hold. A branch
     * could end up with two counters, one keyed by the licence and one by the
     * empty string, each seeded once and each counting on alone. Once both
     * existed they issued the same numbers and the unique index refused the
     * second. The branch's own licence is the one answer every door agrees on.
     */
    let license = licenseRaw;
    if (!license && branchIdRaw) {
      try {
        const owner = await db.collection('branches').findOne(
          {
            _id: mongoose.Types.ObjectId.isValid(String(branchIdRaw))
              ? new mongoose.Types.ObjectId(String(branchIdRaw))
              : branchIdRaw,
          },
          { projection: { license: 1 } }
        );
        if (owner && owner.license) license = owner.license;
      } catch (e) {
        /* A branch that cannot be read leaves the caller's answer standing;
           the duplicate backstop below still holds. */
      }
    }

    const key = {
      kind: 'sales_id',
      branch_key: String(branchIdRaw || ''),
      license_key: String(license || ''),
    };

    /* Idempotent and cheap; the unique index is what makes the concurrent
       seed below safe, so it is ensured before first use rather than hoped
       for. A failure leaves the flag unset so the next call tries again. */
    if (numberingContext) {
      await ensureIndexOnce(
        counters,
        { kind: 1, branch_key: 1, license_key: 1 },
        { unique: true, name: 'one_counter_per_scope' }
      );
    } else if (!this.constructor._countersIndexEnsured) {
      this.constructor._countersIndexEnsured = true;
      try {
        await counters.createIndex(
          { kind: 1, branch_key: 1, license_key: 1 },
          { unique: true, name: 'one_counter_per_scope' }
        );
      } catch (e) {
        this.constructor._countersIndexEnsured = false;
      }
    }

    // The bill-number uniqueness backstop, ensured alongside the counter.
    await this._ensureSalesIdIndex(db);

    /*
     * WHICH PERIOD THE COUNTER IS COUNTING, stored on the row rather than in
     * the key.
     *
     * Keying on it would mean a second row per branch per year, and the
     * unique index that guards this collection - one_counter_per_scope, on
     * kind + branch + licence - would refuse it. Changing that index means a
     * migration on ninety live shops in the path that numbers every bill, to
     * store a number that fits perfectly well on the row already there.
     *
     * Empty when the shop has not asked for a reset, which is how every
     * existing row already reads once $ifNull has done its work below.
     */
    const wantedPeriod = String((period && period.key) || '');

    const existing = await counters.findOne(key);
    if (!existing) {
      const seed = await this.maxIssuedSalesNumber(branchIdRaw, licenseRaw, {
        periodLabel: (period && period.label) || '',
        numberingContext,
      });
      /* With the unique index, one of two concurrent seeders inserts and the
         other's upsert errors; both then increment the same row. */
      await counters
        .updateOne(key, { $setOnInsert: { seq: seed, period_key: wantedPeriod } }, { upsert: true })
        .catch(() => {});
    }

    /*
     * Asked for after a number came back taken: catch the counter up.
     *
     * A counter can sit behind the sales it is numbering - a restore that
     * brought the sales back without the counters, or numbers issued through
     * the second counter this method no longer creates. Adding one then walks
     * into every taken number in turn, a failed order each time. $max only
     * ever raises, so a number allocated concurrently cannot be undone by it.
     */
    if (reseed) {
      const behind = await this.maxIssuedSalesNumber(branchIdRaw, license, {
        periodLabel: (period && period.label) || '',
        numberingContext,
      });
      if (behind > 0) {
        /*
         * The period is stamped here too, so catching up cannot leave the row
         * claiming a year it is no longer counting - which would make the
         * very next bill roll over a second time and restart at one.
         */
        await counters
          .updateOne(
            key,
            { $max: { seq: behind }, $set: { period_key: wantedPeriod } },
            { upsert: true }
          )
          .catch(() => {});
      }
    }

    /*
     * THE ROLL-OVER, IN ONE ATOMIC STEP.
     *
     * A read, a compare and a write would be three, and a year turns over at
     * midnight while sales are still being recorded: two tills billing in
     * that second would both read the old year, both reset to zero and both
     * issue number one. One pipeline update is a single atomic operation on
     * the document, so the second caller sees whatever the first left.
     *
     * Same period, or no period at all: add one, exactly as this did before.
     * A different period: start again at one and stamp the new period on the
     * row. `$ifNull` is what makes every counter written before this change
     * read as "no period" rather than as a mismatch - otherwise the first
     * bill on every shop in the estate would restart at one.
     *
     * Needs MongoDB 4.2 for pipeline updates; the product ships 7.0.
     */
    const res = await counters.findOneAndUpdate(
      key,
      [
        {
          $set: {
            seq: {
              $cond: [
                { $eq: [{ $ifNull: ['$period_key', ''] }, wantedPeriod] },
                { $add: [{ $ifNull: ['$seq', 0] }, 1] },
                1,
              ],
            },
            period_key: wantedPeriod,
          },
        },
      ],
      { returnDocument: 'after' }
    );
    const doc = res && typeof res.seq === 'number' ? res : res && res.value;
    if (!doc || typeof doc.seq !== 'number') {
      throw new Error('could not allocate a sales number for this branch');
    }
    return doc.seq;
  }

  /*
   * A short, stable code unique to THIS till.
   *
   * The per-branch counter is atomic but LOCAL to each till and never synced,
   * so two tills in one branch each count their own sequence and hand out the
   * same numbers - the cause of duplicate bill numbers across devices. A local
   * counter cannot fix that on its own: independent offline tills cannot agree
   * on "the next number" without colliding. So each till stamps its own code
   * into every bill number, and no two tills ever share a numbering space.
   *
   * Generated once and kept in device_meta - a collection that, like counters,
   * does NOT ride the sync wire - so it survives restarts and never travels to
   * another till. Cached on the class after first read. Four base-36 chars is
   * ~1.68M codes; with 35 tills the chance any two share one is ~0.04%, and the
   * unique index below turns even that into a caught retry, never a silent dup.
   */
  async deviceTag(numberingContext) {
    if (!numberingContext && this.constructor._deviceTag) return this.constructor._deviceTag;
    try {
      const db = numberingContext?.db || (await BaseModel.getDb());
      const meta = db.collection('device_meta');
      let doc = await meta.findOne({ _id: 'device_tag' });
      if (!doc || !doc.tag) {
        const bytes = crypto.randomBytes(6);
        let n = 0;
        for (const b of bytes) n = n * 256 + b; // < 2^48, exact in a double
        const tag = n.toString(36).toUpperCase().slice(-4).padStart(4, '0');
        // Set-if-absent so two first-sales racing on a fresh till settle on one.
        await meta
          .updateOne(
            { _id: 'device_tag' },
            { $setOnInsert: { _id: 'device_tag', tag, createdAt: new Date() } },
            { upsert: true }
          )
          .catch(() => {});
        doc = await meta.findOne({ _id: 'device_tag' });
      }
      if (numberingContext) return (doc && doc.tag) || '';
      this.constructor._deviceTag = (doc && doc.tag) || '';
    } catch (e) {
      if (numberingContext) throw e;
      // No tag rather than a failed sale. An untagged number is the old
      // behaviour, no worse than before; the next sale tries again.
      this.constructor._deviceTag = '';
    }
    return this.constructor._deviceTag;
  }

  /*
   * Build a full bill number: prefix, this till's code, then the running
   * number. Single source of the format, so every sale path uses the same
   * shape. Falls back to the old untagged form only if a till code could not
   * be read, which must never fail a sale.
   */
  async buildSalesId(prefix, n, { period = '', numberingContext } = {}) {
    const tag = await this.deviceTag(numberingContext);
    const p = (prefix || '').toString().trim();
    /*
     * The one shape utils/bill-number.js cannot express: a prefix glued
     * straight onto the number with no separator, which is what a till with
     * no code has always produced. Kept byte for byte while no year is asked
     * for, because changing the shape of every number on those shops is not
     * something to do on the way past.
     */
    if (!tag && !period) return `${p}${String(n).padStart(6, '0')}`;
    // An empty prefix yields just the tag+number (or a bare number) - no leading
    // dash - so a shop that clears its prefix still gets clean bill numbers.
    const head = tag ? (p ? `${p}-${tag}` : tag) : p;
    const built = billNumber.compose({
      typeLetter: head,
      period,
      sequence: n,
      sequenceWidth: 6,
    });
    if (built.warning) console.warn('[bill-number]', built.warning);
    return built.number;
  }

  /*
   * The gateway-assigned code for this till, like "D1" - unique per shop
   * because only the gateway sees every device. The sync agent writes it into
   * device_meta when the till checks in. Empty until then, which is why the
   * readable format keeps the till-tag fallback: numbering must never wait on
   * the gateway. Only a real code is cached, so it is picked up the moment it
   * arrives, without a restart.
   */
  async deviceCode(numberingContext) {
    if (!numberingContext && this.constructor._deviceCode) return this.constructor._deviceCode;
    try {
      const db = numberingContext?.db || (await BaseModel.getDb());
      const doc = await db.collection('device_meta').findOne({ _id: 'device_code' });
      const code = (doc && doc.code) || '';
      if (code && !numberingContext) this.constructor._deviceCode = code;
      return code;
    } catch (e) {
      if (numberingContext) throw e;
      return '';
    }
  }

  /*
   * A short, stable code for a branch, like "B1" - its position among this
   * licence's branches ordered by when they were created. Deterministic, so
   * every till derives the same code without coordinating, and stable, because
   * a newer branch only ever appends. It is a label only: the device code is
   * what makes a number unique, so a rare mid-sync disagreement is cosmetic.
   */
  async branchCode(branchId, numberingContext) {
    if (!branchId) return '';
    const id = String(branchId);
    const cached = numberingContext ? null : this.constructor._branchCodes;
    if (cached && cached[id]) return cached[id];
    try {
      const db = numberingContext?.db || (await BaseModel.getDb());
      const branches = db.collection('branches');
      const filter = {};
      if (numberingContext) filter.license = numberingContext.license;
      else if (BaseModel.license) filter.license = BaseModel.license;
      const rows = await branches
        .find(filter, { projection: { _id: 1, created_date: 1 } })
        .toArray();
      rows.sort((a, b) => {
        const ca = a.created_date ? new Date(a.created_date).getTime() : 0;
        const cb = b.created_date ? new Date(b.created_date).getTime() : 0;
        if (ca !== cb) return ca - cb;
        return String(a._id).localeCompare(String(b._id));
      });
      const map = {};
      rows.forEach((r, i) => {
        map[String(r._id)] = 'B' + (i + 1);
      });
      if (!numberingContext) this.constructor._branchCodes = map;
      return map[id] || '';
    } catch (e) {
      if (numberingContext) throw e;
      return '';
    }
  }

  /*
   * A document number in the readable scheme, when the pieces are there:
   *
   *   <R->? <type> <branch> <device> - <number>
   *   SB1D1-000045   a sale        PB1D1-000008   a purchase
   *   R-SB1D1-000012 a sales return  R-PB1D1-000003 a purchase return
   *
   * Until this till has BOTH a branch code and a gateway-assigned device code
   * it falls back to the till-tagged number (SID-A3F9-000045), which is already
   * collision-free - so the visible format changes exactly once, cleanly, and
   * a sale never waits on the gateway.
   */
  /**
   * The bill number itself, inside the sixteen characters the format allows.
   *
   * The parts are assembled by utils/bill-number.js, which shortens the
   * RUNNING NUMBER when something has to give and says so: dropping the year
   * would break uniqueness for the year, and dropping the till code would let
   * two tills mint the same number. With no year asked for it produces exactly
   * what the expression here produced before, which is pinned by test.
   */
  async buildDocNumber(
    typeLetter,
    branchId,
    n,
    { isReturn = false, fallbackPrefix = 'S', period = '', numberingContext } = {}
  ) {
    const [branchCode, deviceCode] = await Promise.all([
      this.branchCode(branchId, numberingContext),
      this.deviceCode(numberingContext),
    ]);
    if (branchCode && deviceCode) {
      const built = billNumber.compose({
        typeLetter: `${isReturn ? 'R-' : ''}${typeLetter}`,
        branchCode,
        deviceCode,
        period,
        sequence: n,
        sequenceWidth: 6,
      });
      /* A shop whose codes leave no room is told, once per bill, in words it
         can act on. Never thrown: a long number beats no sale. */
      if (built.warning) console.warn('[bill-number]', built.warning);
      return built.number;
    }
    return this.buildSalesId(fallbackPrefix, n, { period, numberingContext });
  }

  /*
   * The hard backstop: no two sales in a licence may share a bill number, ever.
   * The till code above makes a collision astronomically unlikely; this makes a
   * silent duplicate impossible - a stray collision fails loud and is retried
   * for the next number instead of quietly becoming a second SID000005.
   *
   * Best-effort and lazy, like the counter index: on a shop that still carries
   * legacy duplicates the build throws and the flag stays unset, so it simply
   * builds later, once those are cleaned. Partial on a string bill number so
   * documents without one are ignored.
   */
  async _ensureSalesIdIndex(db) {
    /* Once per DATABASE. The old latch was a static boolean, which on a
       process serving many shops meant the FIRST shop to make a sale got this
       index and no other shop ever did. For a unique index that guards bill
       numbers, that is not a missing optimisation - it is the guarantee
       quietly not applying to almost everyone. */
    await ensureIndexOnce(
      db.collection('sales'),
      { license: 1, sales_id: 1 },
      {
        unique: true,
        partialFilterExpression: { sales_id: { $type: 'string' } },
        name: 'unique_sales_id_per_license',
      }
    );
  }

  /*
   * The answer for an order that already exists.
   *
   * Built in one place because it is returned from two: the lookup before the
   * insert, and the insert that lost the race to a unique index. If those ever
   * answered differently, the same order would get a different answer depending
   * on which microsecond its retry arrived in.
   *
   * `duplicate: true` is on it so the app can tell "your order is in" from "we
   * took your order just now", which matters when an operator is deciding
   * whether to send it again.
   */
  _duplicateOrderAnswer(already) {
    return {
      status: true,
      message: 'Order placed successfully',
      data: {
        tokenId: already.token_id || already.tokenId || '',
        sale_id: already._id.toString(),
        sales_id: already.sales_id,
        branch_name: already.branch_name,
        items: already.items || [],
        subtotal: already.sub_total ?? already.subtotal ?? 0,
        discount: already.discount ?? 0,
        total: already.sales_total ?? already.total ?? 0,
        payment_status: already.payment_status,
        duplicate: true,
      },
    };
  }

  /*
   * One order per key, enforced by the database rather than by a lookup.
   *
   * A read-then-write cannot stop two simultaneous copies of the same order:
   * both read nothing, both write. Only the index can, and it has to be there
   * for EVERY shop, which is why it goes through ensureIndexOnce - a static
   * boolean would give it to whichever shop made the first order after
   * a restart and to nobody else.
   *
   * Partial, on a string key, so the millions of till sales that carry no key
   * are not all colliding on null.
   */
  async _ensureIdempotencyIndex(db) {
    await ensureIndexOnce(
      db.collection('sales'),
      { license: 1, idempotency_key: 1 },
      {
        unique: true,
        partialFilterExpression: { idempotency_key: { $type: 'string' } },
        name: 'unique_idempotency_key_per_license',
      }
    );
  }

  /* A clash on the key above, told apart from a clash on the bill number so
     the two are handled differently: a bill number is re-taken, a repeated
     order is answered with the order that already exists. */
  isDuplicateIdempotencyError(err) {
    if (!err || (err.code !== 11000 && err.code !== 11001)) return false;
    const where = `${err.message || ''} ${JSON.stringify(err.keyPattern || err.keyValue || {})}`;
    return /idempotency_key/i.test(where);
  }

  isDuplicateSalesIdError(err) {
    if (!err || (err.code !== 11000 && err.code !== 11001)) return false;
    const where = `${err.message || ''} ${JSON.stringify(err.keyPattern || err.keyValue || {})}`;
    return /sales_id/i.test(where);
  }

  /*
   * Create a sale, and if the bill number lost a one-in-a-million race, take
   * the next number and try again rather than fail the sale. `nextId` returns a
   * freshly allocated bill number. Only a bill-number clash is retried; every
   * other error is thrown straight through, unchanged.
   */
  async createSaleUnique(data, nextId, { attempts = 6 } = {}) {
    for (let i = 0; ; i++) {
      try {
        return await this.create(data);
      } catch (err) {
        if (i >= attempts - 1 || !this.isDuplicateSalesIdError(err)) throw err;
        const sid = await nextId();
        data.sales_id = sid;
        data.invoice_number = sid;
        data.sale_no = sid;
      }
    }
  }

  /*
   * The highest number this branch has ever put on a bill, whatever the
   * prefix was at the time. Runs once per branch, to seed its counter.
   */
  /*
   * Insert an order, taking a fresh bill number if this one has just been taken.
   *
   * The till has had this since bill numbers became unique (createSaleUnique);
   * the customer's own ordering page never did, so a collision reached the
   * phone as "E11000 duplicate key error ... unique_sales_id_per_license",
   * under a Retry button that asked for the very same number again. Each retry
   * catches the counter up to the highest number the branch has actually
   * issued, so a counter that has fallen behind is right on the next attempt
   * rather than after as many attempts as there are taken numbers.
   *
   * Only a duplicate BILL NUMBER is retried. Anything else - a duplicate
   * idempotency key above all, which means this very order is already saved -
   * is raised, because retrying it would be how one order becomes two.
   */
  async insertSaleWithFreshNumber(salesCollection, document, branchId, { attempts = 5 } = {}) {
    document.origin = require('../utils/sale-origin').stamp(document);
    if (document.license && branchId) {
      const settings = (await BaseModel.getDb()).collection('settings');
      document.wording_snapshot = await require('../services/document-wording-snapshot').capture(
        settings,
        document.license,
        branchId
      );
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await salesCollection.insertOne(document);
      } catch (error) {
        if (attempt >= attempts || !this.isDuplicateSalesIdError(error)) throw error;
        const fresh = await this.generateSalesIdForBranch(branchId, { reseed: true });
        console.warn(
          `[order] bill number ${document.sales_id} was already issued; taking ${fresh}`
        );
        document.sales_id = fresh;
        if (document.invoice_number) document.invoice_number = fresh;
        if (document.sale_no) document.sale_no = fresh;
      }
    }
  }

  async maxIssuedSalesNumber(branchIdRaw, licenseRaw, { periodLabel = '', numberingContext } = {}) {
    const db = numberingContext?.db || (await BaseModel.getDb());
    const asObjectId = (v) =>
      v instanceof mongoose.Types.ObjectId
        ? v
        : mongoose.Types.ObjectId.isValid(String(v))
          ? new mongoose.Types.ObjectId(String(v))
          : v;
    const filter = { branch_id: asObjectId(branchIdRaw) };
    if (licenseRaw) filter.license = asObjectId(licenseRaw);
    const rows = await db
      .collection('sales')
      .find(filter, { projection: { sales_id: 1 } })
      .toArray();
    /*
     * ONLY THIS YEAR'S NUMBERS, when the shop numbers by year.
     *
     * This is what catches a counter up after a number came back taken. On a
     * shop that resets every year, the highest number it ever issued is in
     * some earlier year - and $max-ing the new year's counter to it would
     * jump the series from 4 to 901 on the first collision, which is a gap an
     * auditor asks about. The label sits in its own dash-delimited segment
     * immediately before the running number, so it can be matched exactly
     * rather than searched for.
     *
     * No label means no filter, which is every shop that has not turned the
     * year on and is exactly what this did before.
     */
    const inPeriod = periodLabel
      ? new RegExp(`(^|-)${String(periodLabel).replace(/[^A-Za-z0-9]/g, '')}-\\d+$`)
      : null;

    let max = 0;
    for (const r of rows) {
      const salesId = String((r && r.sales_id) || '');
      if (inPeriod && !inPeriod.test(salesId)) continue;
      const m = /(\d+)\s*$/.exec(salesId);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  }

  /*
   * Priced modifiers selected on a sale line. The item defines the allowed
   * groups; a request naming an unknown option is refused so the till cannot
   * quietly charge for something that was not offered.
   */
  async _priceModifiers(chosen, itemDoc, branchDoc) {
    const asked = Array.isArray(chosen) ? chosen.filter((one) => one && one.name) : [];
    if (!asked.length) return { status: true, delta: 0, lines: [] };

    const refuse = (name) => ({
      status: false,
      data: { state: 'item_option_unknown', item: itemDoc.name || '', option: name },
      message: `${itemDoc.name || 'That item'} does not come with ${name}.`,
    });

    const ids = (itemDoc.modifier_group_ids || [])
      .map((id) => String(id))
      .filter((id) => ObjectId.isValid(id));
    if (!ids.length) return refuse(asked[0].name);

    const collection = await this.getCollection('modifier_groups');
    const docs = await collection
      .find({
        _id: { $in: ids.map((id) => new ObjectId(id)) },
        license: branchDoc.license || BaseModel.license,
      })
      .toArray();

    const offered = new Map();
    const ceilings = new Map();
    for (const doc of docs) {
      const groupName = String(doc.name || '');
      const options = new Map();
      for (const option of doc.options || []) {
        options.set(String(option.name || ''), Number(option.price_delta) || 0);
      }
      offered.set(groupName, options);
      ceilings.set(groupName, Number(doc.max) || 0);
    }

    const groupOffering = (optionName) => {
      for (const [groupName, options] of offered) {
        if (options.has(optionName)) return groupName;
      }
      return null;
    };

    const lines = [];
    const taken = new Map();
    for (const one of asked) {
      const wanted = String(one.name);
      const groupName =
        one.group != null && offered.has(String(one.group))
          ? String(one.group)
          : groupOffering(wanted);
      if (!groupName || !offered.get(groupName).has(wanted)) return refuse(wanted);

      const already = taken.get(groupName) || [];
      if (already.includes(wanted)) continue;
      const ceiling = ceilings.get(groupName) || 0;
      if (ceiling > 0 && already.length >= ceiling) continue;

      taken.set(groupName, already.concat(wanted));
      lines.push({
        group: groupName,
        name: wanted,
        price_delta: offered.get(groupName).get(wanted),
      });
    }

    const delta = lines.reduce((sum, one) => sum + one.price_delta, 0);
    return { status: true, delta, lines };
  }

  async getLastSaleForBranch(branchId, licenseId, { SaleModel } = {}) {
    const Model = this.getModel(SaleModel);
    return Model.findOne({ branch_id: branchId, license: licenseId }).sort({
      _id: -1,
    });
  }
}

module.exports = new SalesRepository();
