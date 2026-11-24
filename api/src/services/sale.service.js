const pricingAuthority = require('./pricing-authority');
const mongoose = require('mongoose');
const { ObjectId } = require('mongodb');
const Sale = require('../models/sale.model');
const BaseModel = require('../models/base.model');
const StockLogsRepository = require('../repositories/stock-log.repository');
const ItemRepository = require('../repositories/item.repository');
const CustomerRepository = require('../repositories/customer.repository');
const RegisterRepository = require('../repositories/register.repository');
const branchesRepository = require('../repositories/branch.repository');
const salesRepository = require('../repositories/sale.repository');
const { ERROR_MESSAGES } = require('../constants/sales.constants');
const { PAYMENT_STATUS, SALE_STATUS } = require('../constants');
const { NotFoundError, BadRequestError } = require('../utils/appError');
const { toNumberExpression } = require('../helpers/sales.helper');
const { lineCostExpression } = require('../helpers/sale-cost');
const { reportSaleTotal } = require('../helpers/reportable-sales');

// Helper to get model instance or class
const getModel = (SaleModel) => SaleModel || Sale;

const { computeLineTotal } = require('./line-total');
const { calculateSaleHeader, round2 } = require('./sale-header');
const { normalizeSaleCharges } = require('./sale-charges');

// Daily payment aggregation. The till records one paid amount; no tender
// type exists to group by, and an unpaid balance is not money received.
const buildDailyPaymentAggregationPipeline = (match) => [
  { $match: match },
  {
    $group: {
      _id: null,
      total: {
        $sum: {
          $cond: [
            { $eq: ['$payment_status', 'Unpaid'] },
            0,
            {
              $cond: [
                { $ne: [{ $ifNull: ['$paid_amount', null] }, null] },
                { $toDouble: { $ifNull: ['$paid_amount', 0] } },
                {
                  $subtract: [
                    { $toDouble: { $ifNull: [reportSaleTotal(), 0] } },
                    { $toDouble: { $ifNull: ['$payment_pending', 0] } },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
  { $project: { _id: 'Paid', total: 1 } },
];

// Lightweight helpers for controllers that still need branch metadata
// Delegates to the BranchesRepository so that all branch DB access stays
// inside the repository layer.
const getBranchById = async (id) => {
  if (!id) return null;
  try {
    return await branchesRepository.findById(id, { lean: true });
  } catch (error) {
    console.warn('getBranchById: Branch lookup failed', error);
    return null;
  }
};

/**
 * Enrich a basic sale context with branch-specific settings.
 *
 * This helper centralises the logic for loading a Branch document and
 * populating the derived context fields (roundOff, branchSettings,
 * stockManagement, salesPrefix, branchName, branchState, printingAddress).
 *
 * It is deliberately tolerant: if the branch lookup fails for any reason,
 * the original context is returned unchanged so that callers can fall back
 * to sensible defaults without breaking existing behaviour.
 *
 * @param {Object} context
 * @returns {Promise<Object>} updated context
 */
const enrichSaleContext = async (context = {}) => {
  const updated = { ...context };
  const rawBranchId = updated.branchId;

  if (!rawBranchId) {
    return updated;
  }

  try {
    const branchDoc = await branchesRepository.findById(rawBranchId, {
      lean: true,
    });
    if (!branchDoc) {
      return updated;
    }

    updated.roundOff = branchDoc.roundOff === true;
    updated.branchSettings = branchDoc;
    console.log(branchDoc.stock_management);
    // Use database stock_management setting
    updated.stockManagement = branchDoc.stock_management !== false;
    // The branch's prefix wins, even if it is blank (a shop may want plain
    // numbers); only when it was never set do we keep the prior value or 'S'.
    updated.salesPrefix =
      branchDoc.sales_prefix != null
        ? branchDoc.sales_prefix
        : updated.salesPrefix != null
          ? updated.salesPrefix
          : 'S';
    updated.branchName = branchDoc.branch_name || updated.branchName;
    updated.branchState = (branchDoc.store_state || branchDoc.state || branchDoc.branch_state || '')
      .toString()
      .trim();
    updated.printingAddress = branchDoc.printing_address;

    return updated;
  } catch (error) {
    console.warn('enrichSaleContext: Branch fetch failed', error);
    return updated;
  }
};

/**
 * processSale - Main logic for Add/Edit sale (Equivalent to PHP salesInsertUpdate)
 * @param {Object} data - The payload (items, customer_id, totals, etc.)
 * @param {String} id - Sale ID (empty for Add, present for Edit)
 * @param {String} process - 'Add' | 'Edit' | 'Hold'
 * @param {Object} context - { branchId, licenseId, userId, userName, ... }
 */
const processSale = async (
  data,
  id = '',
  process = 'Add',
  context = {},
  {
    preview = false,
    beforeCommit,
    stockGrant,
    beforeStockCommit,
    prepareAllocated = false,
    preparePaidEdit = false,
  } = {}
) => {
  // Retry identity describes the submitted request, not derived charge fields.
  const submittedPayload = structuredClone(data);
  // The decision gate closes over the caller's trusted context. Pricing adds
  // a local copy below; retain the gate's later verified device identity.
  const decisionContext = context;
  try {
    let extensionStock = null;
    let extensionSubmission = null;
    if (
      prepareAllocated &&
      (stockGrant === undefined || preview || beforeCommit || beforeStockCommit)
    )
      return { status: false, message: 'Unsupported allocated sale preparation' };
    if (
      beforeStockCommit !== undefined &&
      (typeof beforeStockCommit !== 'function' || stockGrant === undefined)
    )
      return { status: false, message: 'Unsupported allocated sale commit' };
    if (stockGrant !== undefined) {
      if (preview || id !== '' || process !== 'Add')
        return { status: false, message: 'Unsupported stock allocation sale' };
      extensionStock = await require('./extension-stock-allocations').validateSaleGrant(
        stockGrant,
        context,
        data.items || []
      );
      // The key is chosen by the host allocation, never by the extension UI.
      data = {
        ...data,
        idempotencyKey: `extension-sale:${extensionStock.saleId}`,
        extension_stock_operation: extensionStock.stockOperationId,
      };
      extensionSubmission = structuredClone(data);
    }
    if (
      beforeCommit !== undefined &&
      (typeof beforeCommit !== 'function' || id !== '' || process !== 'Add')
    )
      return { status: false, message: 'Unsupported decision commit' };
    if (
      preview &&
      (id !== '' ||
        process !== 'Add' ||
        !Array.isArray(data?.items) ||
        data.items.length < 1 ||
        data.items.length > 100)
    )
      return { status: false, message: 'Unsupported decision preview' };
    // Name-only checkout keeps a bill snapshot without inventing a customer account.
    if (!data.customer_id && [true, 'true'].includes(data.partial_check))
      return { status: false, message: 'Choose a saved customer for a part-payment sale.' };
    // 1. Basic Validation
    if ((parseFloat(data.sales_total) || 0) < 0) {
      // PHP checks < 1, but let's say 0 for safety, PHP said < 1
      // PHP: if ((int) $data['sales_total'] < 1) ... 'Pay Total cannot be zero or less than zero.'
      // However, some businesses allow 0 cost sales. I'll stick to PHP parity strictly.
      if (parseInt(data.sales_total) < 1) {
        return {
          status: false,
          data: null,
          message: ERROR_MESSAGES.PAY_TOTAL_INVALID,
        };
      }
    }

    const branchId = context.branchId ? new ObjectId(context.branchId) : null;
    const licenseId = context.licenseId ? new ObjectId(context.licenseId) : null;
    const userId = context.userId ? new ObjectId(context.userId) : null;
    const userName = context.userName || 'System';

    if (!branchId || !licenseId) {
      return { status: false, message: ERROR_MESSAGES.BRANCH_LICENSE_REQUIRED };
    }

    const savedAnswer = async (saleId, saleNumber, duplicate = false) => {
      if (data.create_customer_on_save === true)
        await require('./sale-customer').finish(
          await BaseModel.getDb(),
          { branchId, license: licenseId },
          saleId
        );
      return {
        status: true,
        data: {
          _id: saleId,
          sales_id: saleId,
          sale_number: saleNumber,
          print: context.branchSettings?.printall || false,
          waring: 'success',
          name: (data.customer_name || '').trim(),
          phone: (data.customer_phone || '').trim(),
          customer_balance: duplicate ? 0 : customer ? customer.balance || 0 : 0,
          country_sort: context.branchSettings?.sortname || 'in',
          ...(duplicate ? { duplicate: true } : {}),
        },
        message: 'Sale saved successfully',
      };
    };

    // A retry returns its committed result before current catalogue changes
    // can invalidate the original, already accepted request.
    if (!preview && id === '' && data.idempotencyKey) {
      const existing = await require('./desktop-submission').lookup(
        await BaseModel.getDb(),
        { branchId, license: licenseId },
        String(userId || ''),
        extensionSubmission || submittedPayload
      );
      if (existing) return await savedAnswer(existing._id, existing.sales_id, true);
    }

    // 2. Check Plan / Max Sales (Skipped for now, assuming valid plan)
    // In strict PHP parity, we would check collection count.

    // Repositories for dependent modules to keep DB access out of services
    const itemRepository = new ItemRepository();
    const customerRepository = new CustomerRepository();
    const registerRepository = new RegisterRepository();

    if (data.register_id) {
      const registerSession = await registerRepository.validateSessionOwner(
        data.register_id,
        context.userId,
        context.deviceId,
        ...(preview || preparePaidEdit ? [{ acquire: false }] : [])
      );
      if (!registerSession.status) {
        return {
          status: false,
          data: null,
          message:
            registerSession.message ||
            'This cash register session is locked by another user or device.',
        };
      }
    }

    // 3. Process Items & Calculations
    let items = data.items || [];
    // Product stock is shared, but edits and conversion snapshots belong to a line.
    const orderLine = require('../utils/order-line');
    const unitsByProduct = new Map();
    for (const line of items) {
      const key = String(line.item_id || '');
      const units = unitsByProduct.get(key) || new Set();
      units.add(String(line.item_unit || ''));
      unitsByProduct.set(key, units);
    }
    if ([...unitsByProduct.values()].some((units) => units.size > 1)) orderLine.validate(items);

    // Robust numeric parser for legacy string values that may contain
    // commas or currency/percent symbols.
    const parseLegacyNumber = (value) => {
      if (value === undefined || value === null) return null;
      const sanitized = String(value)
        .replace(/,/g, '')
        .replace(/[^0-9+\-.]/g, '')
        .trim();
      if (!sanitized) return null;
      const num = parseFloat(sanitized);
      return Number.isFinite(num) ? num : null;
    };

    const total_data = [];
    const total_company_data = [];
    const discount_data = [];
    const subtotal_data = [];

    // Inventory Change Tracking
    const changes_items = [];
    const existing_changes = [];
    const oldItemsData = {};

    // Fetch Existing Sale if Edit
    let existingSale = null;
    if (id !== '') {
      existingSale = await salesRepository.getById(id);
      if (existingSale) {
        if (existingSale.payment_correction_pending)
          return { status: false, message: 'Finish the pending payment correction first.' };
        if (existingSale.extension_stock_operation)
          return { status: false, message: 'Use the normal return process for an allocated sale.' };
        if (existingSale.paid_bill_corrections?.length && !preparePaidEdit)
          return { status: false, message: 'Review the paid bill correction before saving.' };
        if (existingSale.items) {
          existingSale.items.forEach((oldItem) => {
            if (oldItem.item_id) {
              oldItemsData[orderLine.key(oldItem)] = {
                item_id: String(oldItem.item_id),
                quantity: parseFloat(oldItem.item_quantity),
                unit_conversion: oldItem.unit_conversion,
                name: oldItem.item_name || '',
                item_code: oldItem.item_sku || '', // PHP uses item_code/item_id inconsistent naming sometimes
                price: parseFloat(oldItem.item_price || 0),
                unit: oldItem.item_unit || 'qty',
                status: oldItem.item_status || '',
              };
            }
          });
        }
        if (existingSale.changes) {
          existing_changes.push(...existingSale.changes);
        }
      }
    }

    if (existingSale) {
      items = require('../utils/order-line').reconcile(items, existingSale.items || []);
    }
    const customerPlan =
      data.create_customer_on_save === true
        ? await require('./sale-customer').plan(
            await BaseModel.getDb(),
            { branchId, license: licenseId },
            data
          )
        : null;
    if (customerPlan) data.customer_id = String(customerPlan.id);
    const pricingBranch = context.branchSettings || {};
    const pricingCustomer = data.customer_id
      ? await customerRepository.findById(data.customer_id)
      : null;
    let priceList;
    if (pricingCustomer?.category_id) {
      const pricingDb = await BaseModel.getDb();
      priceList = await pricingDb.collection('price_lists').findOne({
        branch_id: branchId,
        license: licenseId,
        customer_category_id: String(pricingCustomer.category_id),
      });
    }
    const itemsale = [];
    const total_available_qty_map = {}; // To track simulated deductions within this batch

    // Iterate Items (Validation + Calc)
    for (const item of items) {
      const itemQuantity = parseFloat(item.item_quantity);
      const itemId = item.item_id;

      // Fetch Item from DB via repository
      const document = await itemRepository.findItemById(itemId);

      if (!document) {
        return {
          status: false,
          data: null,
          message: ERROR_MESSAGES.ITEM_REMOVED,
        };
      }

      // Validate ID match (PHP does this)
      if (document._id.toString() !== itemId) {
        return {
          status: false,
          data: null,
          message: ERROR_MESSAGES.INVALID_ITEM_ID,
        };
      }

      // Determine Values (Logic from PHP)
      // Prefer numeric overrides from payload, then per-item discount fields,
      // then legacy item master. All values may arrive as formatted strings.
      let discountAmount =
        parseLegacyNumber(item.sale_inline_discount_value) ??
        parseLegacyNumber(item.item_discount) ??
        parseLegacyNumber(document.discount_amount) ??
        0;

      const discountPercentage =
        parseLegacyNumber(item.sale_inline_discount_pervalue) ??
        parseLegacyNumber(item.item_discount_percentage) ??
        parseLegacyNumber(document.discount_percentage) ??
        0;

      const previousLine = existingSale?.items?.find(
        (line) => String(line.line_id || line.item_id) === String(item.line_id || itemId)
      );
      let unitConversion;
      try {
        unitConversion = require('../helpers/selling-units').resolve(
          document,
          item.item_unit,
          previousLine
        );
      } catch (error) {
        return { status: false, message: error.message };
      }
      if (unitConversion.factor !== 1 && (priceList || extensionStock))
        return {
          status: false,
          message: 'Alternate units are supported for ordinary counter sales. Use the base unit.',
        };
      const stockQuantity = require('../helpers/selling-units').stockQuantity(
        { unit_conversion: unitConversion },
        itemQuantity
      );
      if (
        parseLegacyNumber(item.sale_inline_discount_value) === null &&
        parseLegacyNumber(item.item_discount) === null
      )
        discountAmount *= unitConversion.factor;
      if (
        previousLine?.pricing &&
        item.modifiers !== undefined &&
        JSON.stringify(item.modifiers) !== JSON.stringify(previousLine.modifiers || [])
      )
        return {
          status: false,
          message: 'Add a separate line to change priced modifiers.',
          data: { state: 'item_modifiers_changed' },
        };
      const extras = previousLine?.pricing
        ? { delta: previousLine.pricing.modifier_delta || 0, lines: previousLine.modifiers || [] }
        : item.modifiers?.length
          ? await salesRepository._priceModifiers(item.modifiers, document, {
              ...pricingBranch,
              license: licenseId,
            })
          : { delta: 0, lines: [] };
      if (extras.status === false) return extras;
      let pricing;
      try {
        pricing = pricingAuthority.resolve({
          product: {
            ...document,
            selling_price:
              unitConversion.price ??
              Number(document.selling_price ?? document.item_price ?? 0) * unitConversion.factor,
          },
          branch: pricingBranch,
          allowCounterPriceOverride: context.allowCounterPriceOverride === true,
          allowParkedPriceOverride:
            existingSale?.sale_process === 'Hold' && existingSale?.payment_status !== 'Paid',
          roundGrossUnit: context.roundGrossUnit === true,
          previous: previousLine,
          submitted: pricingAuthority.desktopSubmittedPrice(item),
          extras: extras.delta,
          priceList,
        });
      } catch (error) {
        return pricingAuthority.failure(error);
      }
      const sellingPrice = pricing.selling_price;
      const itemAmount = sellingPrice * itemQuantity;

      /*
       * The bill sends the per-unit cost in `company_price_total` (the
       * historical field name). Store the FULL line cost here instead:
       * quantity x unit. Reports, returns, edits and the dashboard then read
       * one meaning everywhere. `unit_company_price` keeps the unit value
       * the next edit needs, without guessing from a line total.
       *
       * Alternate selling units multiply the base-unit cost by the factor, so
       * a box of 12 carries 12 units of cost on its line.
       */
      const submittedUnitCost =
        unitConversion.factor === 1 ? parseLegacyNumber(item.company_price_total) : null;
      const previousUnitCost = parseLegacyNumber(previousLine?.unit_company_price);
      const masterUnitCost = parseLegacyNumber(document.company_price) ?? 0;
      const unitCompanyPrice =
        unitConversion.factor === 1
          ? (submittedUnitCost ?? previousUnitCost ?? masterUnitCost)
          : masterUnitCost * unitConversion.factor;
      const companyPrice = round2(itemQuantity * unitCompanyPrice);

      total_company_data.push({ company_amount: companyPrice });

      let itemDiscountAmountMultiple = 0;
      let itemDiscountPercentageMultiple = 0;
      let itemDiscountAmountTotalCalculation = 0;

      const lineTotal = computeLineTotal({
        itemAmount,
        sellingPrice,
        itemQuantity,
        roundGrossUnit: pricing.roundGrossUnit === true,
        currencyFactor: pricing.currency.factor,
        discountAmount,
        discountPercentage,
      });
      if (
        discountAmount < 0 ||
        discountPercentage < 0 ||
        discountPercentage > 100 ||
        !Number.isFinite(lineTotal.total) ||
        lineTotal.total < 0
      )
        throw new BadRequestError('Item discount must not exceed the item amount or 100%.');
      itemDiscountAmountTotalCalculation = lineTotal.total;
      itemDiscountAmountMultiple = discountAmount > 0 ? discountAmount * itemQuantity : 0;
      itemDiscountPercentageMultiple =
        !(discountAmount > 0) && discountPercentage > 0 ? discountPercentage : 0;
      total_data.push({ totalsales_Amount: lineTotal.total });
      discount_data.push({ discount_amount: lineTotal.discount });
      subtotal_data.push({ subtotal_amount: lineTotal.subtotal });

      // Inventory check
      const availablequatity = parseFloat(document.available_quantity || 0);
      const total_available_qty = availablequatity - stockQuantity;

      // Calculate Changes (Old Item logic)
      let changeQty = 0;
      let changeProcess = '';
      let finalStatus = item.item_status || '';

      if (id === '') {
        // Add Mode
        changeProcess = 'add';
        changeQty = itemQuantity;
      } else {
        // Edit Mode
        const itemIdStr = orderLine.key(item);
        let oldQty = 0;
        let oldStatus = '';

        if (oldItemsData[itemIdStr]) {
          oldQty = oldItemsData[itemIdStr].quantity;
          oldStatus = oldItemsData[itemIdStr].status;
          delete oldItemsData[itemIdStr]; // Mark as processed
        }

        if (String(oldStatus).toLowerCase() === 'instant') {
          finalStatus = 'instant';
        }

        if (itemQuantity > oldQty) {
          changeProcess = 'add';
          changeQty = itemQuantity - oldQty;
        } else if (itemQuantity < oldQty) {
          changeProcess = 'cancel';
          changeQty = oldQty - itemQuantity;
        }
      }

      if (changeQty > 0) {
        changes_items.push({
          item_id: itemId,
          item_name: document.name,
          ...require('../utils/item-localization').snapshot(document),
          item_quantity: changeQty,
          stock_quantity: require('../helpers/selling-units').stockQuantity(
            { unit_conversion: unitConversion },
            changeQty
          ),
          process: changeProcess,
          item_code: document.itemid,
          unit: item.item_unit || 'qty',
          price: sellingPrice,
          total: sellingPrice * changeQty,
        });
      }

      // Determine available quantity mirror (PHP: item_available_quantity)
      const itemAvailableQty =
        item.item_status !== 'instant' ? total_available_qty : availablequatity;

      // Add to itemsale (Mongoose core fields + full PHP $itemsale mirror)
      itemsale.push({
        pricing,
        ...(previousLine ? require('../utils/service-line').metadata(previousLine) : {}),
        ...require('../utils/order-line').identity(item),
        ...(extras.lines.length ? { modifiers: extras.lines } : {}),
        // Mongoose Schema Required Fields (Node-native)
        item: new ObjectId(itemId),
        name: document.name,
        quantity: itemQuantity,
        unit_price: sellingPrice,
        item_base_price: sellingPrice,
        discount: itemDiscountAmountMultiple,
        total: itemDiscountAmountTotalCalculation,

        // Legacy Fields (strict PHP parity with $itemsale structure)
        sale_inline_item_price: sellingPrice,
        sale_inline_discount_value: discountAmount,
        sale_inline_discount_pervalue: discountPercentage,
        item_status: finalStatus,
        return: false,
        item_name: document.name,
        ...require('../utils/item-localization').snapshot(document),
        item_sku: document.itemid,
        item_price: sellingPrice,
        item_discount: discountAmount,
        item_discount_percentage: discountPercentage,
        item_quantity: itemQuantity,
        unit_conversion: unitConversion,
        item_available_quantity: itemAvailableQty,
        item_id: itemId || '',
        item_unit: unitConversion.unit,
        total_amount: itemDiscountAmountTotalCalculation,
        barcode_id: document.barcode_id || '',
        // Full line cost; unit_company_price is what an edit starts from.
        company_price_total: companyPrice,
        unit_company_price: round2(unitCompanyPrice),
        category_id: document.category_id || undefined,
        category_name: document.category_name || '',
        supplier_id: document.supplier_id || undefined,
        supplier_name: document.supplier_name || '',
        item_description: typeof item.item_description === 'string' ? item.item_description : '',
        track_inventory: Boolean(document.track_inventory),
        negative_stock:
          typeof document.negative_stock === 'boolean' ? document.negative_stock : false,
      });
    } // End Item Loop

    // Summing Totals (base on PHP-style item calculations)
    let sale_tot_amount = total_data.reduce((acc, i) => acc + i.totalsales_Amount, 0);
    let sale_subtotal_amount = subtotal_data.reduce((acc, i) => acc + i.subtotal_amount, 0);
    let sale_discount_amount = discount_data.reduce((acc, i) => acc + i.discount_amount, 0);
    let sale_company_amount = total_company_data.reduce((acc, i) => acc + i.company_amount, 0);

    // The legacy frontend also sends aggregate totals
    // (sales_total, sales_sub_total, discount, sales_total_company_price).
    // To fully mirror PHP's behaviour and preserve precision, we treat those
    // payload values only as a **fallback** when our server-side sums are
    // missing/invalid, not as the primary source of truth.
    const parsePayloadNumber = (value) => {
      if (value === undefined || value === null) return null;
      const str = String(value).replace(/,/g, '').trim();
      if (!str) return null;
      const num = parseFloat(str);
      return Number.isFinite(num) ? num : null;
    };

    const preferServerValue = (serverValue, payloadRaw) => {
      const payloadNum = parsePayloadNumber(payloadRaw);
      if ((serverValue === null || !Number.isFinite(serverValue)) && payloadNum !== null) {
        return payloadNum;
      }
      return serverValue;
    };

    sale_tot_amount = preferServerValue(sale_tot_amount, data.sales_total);
    sale_subtotal_amount = preferServerValue(sale_subtotal_amount, data.sales_sub_total);
    sale_discount_amount = preferServerValue(
      sale_discount_amount,
      data.payment_descriptiondiscount ?? data.discount ?? data.discount_amount
    );
    sale_company_amount = preferServerValue(
      sale_company_amount,
      data.sales_total_company_price ?? data.sales_total_companyprice
    );

    // Date
    const dateInput = data.date || new Date();
    const mongo_date = new Date(dateInput);

    // Cancelled Items (Remaining in oldItemsData)
    if (id !== '' && Object.keys(oldItemsData).length > 0) {
      Object.keys(oldItemsData).forEach((remItemId) => {
        const remItem = oldItemsData[remItemId];
        changes_items.push({
          item_id: remItem.item_id,
          item_name: remItem.name,
          item_quantity: remItem.quantity,
          stock_quantity: require('../helpers/selling-units').stockQuantity(
            { unit_conversion: remItem.unit_conversion },
            remItem.quantity
          ),
          process: 'cancel',
          item_code: remItem.item_code,
          unit: remItem.unit,
          price: remItem.price,
          total: remItem.price * remItem.quantity,
        });
      });
    }

    if (changes_items.length > 0) {
      existing_changes.push({
        timestamp: mongo_date, // Node Date object
        items: changes_items,
      });
    }

    // Stop before numbering, stock, payment or sale writes. This internal
    // preview uses the exact checkout header calculations above/below.
    const manualCharges = await normalizeSaleCharges(data.charges, existingSale?.charges || []);
    data = { ...data, charges: manualCharges };
    context = {
      ...context,
      manualChargesTotal: data.charges.reduce((sum, c) => sum + c.amount, 0),
    };
    const decisionPricing =
      preview || beforeCommit || beforeStockCommit || prepareAllocated
        ? {
            header: calculateSaleHeader(data, sale_tot_amount, context),
            roundOff: context.roundOff === true,
            subtotal: sale_subtotal_amount,
            lineDiscount: sale_discount_amount,
            items: itemsale.map((item) => ({
              itemId: String(item.item_id),
              name: item.item_name,
              quantity: item.item_quantity,
              unitPrice: item.item_price,
              discountAmount: item.item_discount,
              discountPercent: item.item_discount_percentage,
              total: item.total_amount,
            })),
          }
        : null;
    if (preview) return { status: true, data: decisionPricing };

    // Generate Sales ID if New.
    //
    // Allocated from the atomic per-branch counter rather than by reading the
    // last sale and adding one: two simultaneous saves used to both read the
    // same "last" and mint the same bill number, and the old parse also
    // assumed every prefix was three characters, which corrupted the sequence
    // for any shop with a custom prefix of another length.
    let prefixId = '';
    if (id === '') {
      const prefixValue = context.salesPrefix != null ? context.salesPrefix : 'S';
      // Readable scheme (SB1D1-000045) once this till has its branch and its
      // gateway-assigned device code; until then a till-tagged number that is
      // already collision-free. Either way, two tills can never clash.
      //
      // ONE COUNTER, ONE FORMAT through the shared generator. Building a number
      // separately is how two paths came to disagree about the year: a shop
      // numbering by financial year would stamp one set of receipts with the
      // old year and another with the new, and the till would reissue numbers
      // already given out. See repositories/sale.repository generateSalesIdForBranch.
      prefixId = await salesRepository.generateSalesIdForBranch(branchId, {
        fallbackPrefix: prefixValue,
      });
    }

    const {
      extraDiscount,
      salesExtraDiscount,
      finalSaleTotAmount,
      salesTotalForDoc,
      roundOffForDoc,
      itemsTotalForDoc,
    } = calculateSaleHeader(data, sale_tot_amount, context);

    // PHP-like helper functions for exact logic parity
    const isset = (value) => value !== undefined && value !== null;
    const empty = (value) => !value || (typeof value === 'string' && value.trim() === '');

    // Partial / payment status (PHP parity - exact match to salesInsertUpdate lines 544-579)
    let partialCheck = false;
    let partialBalance = finalSaleTotAmount;
    let paymentStatus = 'Paid';
    let paymentPending = 0.0;

    // PHP line 547-552: Check if partial_check is 'true'
    /*
     * Tip in the bill (TIP_IN_TOTAL_DESIGN.md, revised): India default keeps
     * the tip OUT of the payable; when the till ticked "add to bill"
     * (tip_in_total), the amount due grows by the tip. Flag absent =>
     * effectiveDue === finalSaleTotAmount and every comparison below is
     * byte-identical to before.
     */
    const tipInTotal = String(data.tip_in_total) === 'true' && parseFloat(data.tip_amount || 0) > 0;
    const effectiveDue =
      finalSaleTotAmount +
      (tipInTotal ? Math.max(0, round2(parseFloat(data.tip_amount) || 0, 2)) : 0);

    if (isset(data.partial_check) && String(data.partial_check) === 'true') {
      // PHP line 548: $partialCheck = $data['partial_check']; (stores string 'true', not boolean)
      partialCheck = data.partial_check;
      // PHP line 549: $partialBalance = ($data['partial_check'] === 'true') ? (float) $data['partial_balance'] : 0.00;
      partialBalance =
        String(data.partial_check) === 'true' ? parseFloat(data.partial_balance || 0) : 0.0;
      // PHP line 550: $paymentStatus = ($process === 'Hold') ? 'Unpaid' : ($sale_tot_amount <= $data['partial_balance'] ? 'Paid' : 'Partialy Paid');
      const amountPaid = parseFloat(data.partial_balance) || 0;
      paymentStatus =
        process === 'Hold' || amountPaid <= 0
          ? 'Unpaid'
          : effectiveDue <= amountPaid
            ? 'Paid'
            : 'Partialy Paid';
      paymentPending =
        process === 'Hold' || amountPaid <= 0
          ? effectiveDue
          : effectiveDue <= amountPaid
            ? 0.0
            : effectiveDue - amountPaid;
    }

    // Legacy callers may still send the old unpaid flag. New checkouts do not.
    if (!empty(data.unpaid) && String(data.unpaid) === 'true') {
      paymentStatus = 'Unpaid';
      paymentPending = effectiveDue;
    }

    // Derive paid_amount and balance so Mongoose pre-save hook preserves PHP semantics
    let paidAmount = 0;
    let balance = 0;

    if (partialCheck) {
      // In PHP partial sale, customer has paid partialBalance and pending = paymentPending
      paidAmount = partialBalance;
      balance = paymentPending;
    } else {
      if (paymentStatus === 'Paid') {
        paidAmount = finalSaleTotAmount;
        balance = 0;
      } else if (paymentStatus === 'Unpaid') {
        paidAmount = 0;
        balance = finalSaleTotAmount;
      } else if (paymentStatus === 'Partialy Paid') {
        paidAmount = finalSaleTotAmount - paymentPending;
        balance = paymentPending;
      }
    }

    // An edit may arrive from a till that loaded the bill before a later
    // collection was recorded. Never let that stale tender erase money the
    // party already paid: the document's paid/balance fields must move with
    // every edit so the Debts page and statement keep seeing the same truth.
    // Paid-bill corrections are exempt because they deliberately reprice and
    // rewrite a fully settled bill through their own audited path.
    const storedPaymentValue = (field) => {
      if (!existingSale) return undefined;
      return typeof existingSale.get === 'function' ? existingSale.get(field) : existingSale[field];
    };
    const hasStoredPaymentState =
      process === 'Edit' &&
      !preparePaidEdit &&
      id !== '' &&
      existingSale &&
      (storedPaymentValue('paid_amount') !== undefined ||
        storedPaymentValue('balance') !== undefined);
    let recordedPaidAmount = null;

    if (hasStoredPaymentState) {
      const rawRecordedPaid = Number(
        storedPaymentValue('paid_amount') ?? storedPaymentValue('partial_balance')
      );
      recordedPaidAmount = Number.isFinite(rawRecordedPaid)
        ? Math.max(0, round2(rawRecordedPaid))
        : 0;

      if (recordedPaidAmount > effectiveDue + 0.005) {
        return {
          status: false,
          message: 'Sale total cannot be less than the amount already paid',
        };
      }
    }

    if (recordedPaidAmount !== null && paidAmount < recordedPaidAmount) {
      paidAmount = recordedPaidAmount;
      balance = round2(Math.max(0, effectiveDue - paidAmount));
      paymentPending = balance;
      if (balance <= 0.004) {
        paymentStatus = 'Paid';
        partialCheck = false;
        partialBalance = finalSaleTotAmount;
      } else {
        paymentStatus = 'Partialy Paid';
        partialCheck = 'true';
        partialBalance = paidAmount;
      }
    }

    const saleProcess = process;
    const saleMethod = data.sale_method || existingSale?.sale_method || 'Live-Order';

    // A full payment must cover the server-calculated bill;
    // an explicit partial tender must cover the amount being recorded as paid.
    // Wallet flows have separate ledger semantics. Never silently
    // increase a submitted tender or rewrite an already collected payment.
    if (
      (paymentStatus === 'Paid' || paymentStatus === 'Partialy Paid') &&
      data.wallet_check !== true &&
      data.wallet_check !== 'true' &&
      data.multi_payment &&
      typeof data.multi_payment === 'object' &&
      Object.keys(data.multi_payment).length > 0
    ) {
      const amounts = Array.isArray(data.multi_payment)
        ? data.multi_payment.map((payment) => payment?.amount)
        : Object.values(data.multi_payment);
      const invalid = amounts.some(
        (amount) =>
          (typeof amount !== 'number' && typeof amount !== 'string') ||
          String(amount).trim() === '' ||
          !Number.isFinite(Number(amount)) ||
          Number(amount) < 0
      );
      const tenderMinor = amounts.reduce(
        (sum, amount) => sum + Math.round(Number(amount) * 100),
        0
      );
      const expectedTender = partialCheck ? partialBalance : effectiveDue;
      const dueMinor = Math.round(expectedTender * 100);
      if (invalid || !Number.isSafeInteger(tenderMinor) || tenderMinor !== dueMinor) {
        return {
          status: false,
          // This validation precedes every sale, stock and payment write. The
          // desktop may release this request from uncertain-submit recovery.
          data:
            id === '' && typeof data.idempotencyKey === 'string'
              ? { submission_outcome: 'not_saved', request_id: data.idempotencyKey }
              : null,
          message: `Payment total does not match the ${partialCheck ? 'payment amount' : 'bill total'} (${expectedTender.toFixed(2)}). Review the payment amount before saving.`,
        };
      }
    }

    // Customer
    // In Node we don't fetch and store full customer object redundantly usually, but PHP does.
    // We will stick to schema which has separate fields for customer_*
    const customer = pricingCustomer;

    // Insert block: mirror PHP $insertData field order as closely as possible.
    const insertData = {
      // PHP: branch_id, branch_name, printing_address, sales_id, wallet_amount,
      // created_date, created_by, created_by_id, license
      branch_id: branchId,
      branch_name: context.branchName || '',
      printing_address: context.printingAddress || '',
      sales_id: prefixId,
      billing_transaction_id: data.billing_transaction_id || undefined,
      wallet_amount: 0.0,
      created_date: mongo_date,
      // PHP stores username/email in created_by; mirror that while
      // keeping the ObjectId in created_by_id for internal usage.
      created_by: userName,
      created_by_id: userId,
      license: licenseId,

      // Node-only field (not present in PHP) appended after core PHP keys
      // branch field intentionally omitted to keep collection shape PHP-identical
    };

    // Country sort: prefer incoming payload; otherwise, derive from branch
    // settings (sortname or country name) to mirror PHP behaviour.
    const normalizeCountrySort = (sortRaw, countryRaw) => {
      const direct = (sortRaw ?? '').toString().trim();
      if (direct) {
        return direct.toUpperCase();
      }

      const country = (countryRaw ?? '').toString().trim();
      if (!country) return '';

      const key = country.toLowerCase();
      const map = {
        india: 'IN',
        'united states': 'US',
        'united states of america': 'US',
        'united kingdom': 'GB',
        uae: 'AE',
        'united arab emirates': 'AE',
      };

      if (map[key]) {
        return map[key];
      }

      // Generic fallback: first two letters uppercased (e.g. "India" -> "IN").
      // Generic fallback: first two letters uppercased (e.g. "India" -> "IN").
      return key.length >= 2 ? key.substring(0, 2).toUpperCase() : key.toUpperCase();
    };

    const incomingCountrySort = (data.country_sort ?? '').toString().trim();
    const finalCountrySort = incomingCountrySort
      ? incomingCountrySort.toUpperCase()
      : normalizeCountrySort(
          context.branchSettings?.sortname,
          context.branchSettings?.country || data.customer_country
        );

    // Update block: mirror PHP $updateData field order and contents as much as possible.
    const updateData = {
      // Core PHP ordering
      date: mongo_date,
      sale_process: saleProcess,
      sale_method: saleMethod,
      user_id: String(userId),
      user_name: userName,
      category_id: customer ? customer.category_id : '',
      category_name: customer ? customer.category_name : '',
      referrer_id: customer ? customer.referrer_id : '',
      referrer_name: customer ? customer.referrer_name : '',
      customer_id: data.customer_id ? new ObjectId(data.customer_id) : null,
      customer_name: (data.customer_name || '').trim(),
      customer_creation_pending:
        customerPlan?.pending === true ||
        (existingSale?.customer_creation_pending === true &&
          String(existingSale.customer_id) === String(data.customer_id)),
      customer_address: (data.customer_address || '').trim(),
      customer_phone: (data.customer_phone || '').trim(),
      customer_email: (data.customer_email || '').trim(),
      customer_country: (data.customer_country || '').trim(),
      country_sort: finalCountrySort,
      partial_check: partialCheck,
      partial_balance: partialBalance,
      payment_status: paymentStatus,
      payment_pending: paymentPending,
      ...(hasStoredPaymentState ? { paid_amount: paidAmount, balance } : {}),
      payment_mode: (data.payment_mode || '').trim(),
      sales_description: (data.sales_description || '').trim(),
      payment_description: (data.payment_description || '').trim(),
      discount_description: (data.discount_description || '').trim(),
      // Use full precision values to mirror PHP's stored doubles
      total: salesTotalForDoc,
      sales_total: salesTotalForDoc,
      sales_round_off: roundOffForDoc,
      round_off: roundOffForDoc,
      subtotal: sale_subtotal_amount,
      sales_sub_total: sale_subtotal_amount,
      items_total: itemsTotalForDoc, // Mirrors PHP items_total
      items_return_total: 0.0,
      return_round_off: 0.0,
      items_subtotal: sale_subtotal_amount,
      items_return_subtotal: 0.0,
      // Full cost of every remaining line (quantity x unit), not one unit.
      total_companyprice: round2(sale_company_amount),
      company_cost_basis: 'line-total',
      discount: sale_discount_amount,
      return_discount: 0.0,
      updated_date: mongo_date,
      // PHP stores username/email in updated_by; mirror that while
      // keeping the ObjectId in updated_by_id.
      updated_by: userName,
      updated_by_id: userId,
      number_of_items: itemsale.length,
      items: itemsale,
      changes: existing_changes,
      items_return: [],
      cashregister_id: data.register_id || '',
      license: licenseId,
      sale_extra_discount: round2(salesExtraDiscount, 2),
      extra_discount_type: data.extra_discount_type,
      extra_discount: round2(extraDiscount, 2),
      // Tip captured at tender (standard POS tip line). Metadata beside the
      // bill: never part of sales_total or drawer expectations (tip-jar
      // model); reported per employee via the labour report. An Edit that does
      // not send the field preserves the recorded tip.
      tip_amount:
        data.tip_amount !== undefined && data.tip_amount !== null
          ? Math.max(0, round2(parseFloat(data.tip_amount) || 0, 2))
          : existingSale?.tip_amount || 0,
      // Presence-gated: only an explicit tick ever sets it; edits keep it.
      tip_in_total:
        data.tip_in_total !== undefined
          ? String(data.tip_in_total) === 'true'
          : existingSale?.tip_in_total || false,
      // The same normalized charges used in checkout and payment validation.
      charges: data.charges,

      // Cash register / multi-payment mirrors.
      // cashregister_id is set above; it was written twice in this one object
      // literal, with the same value both times, so the duplicate changed
      // nothing and has been removed rather than reconciled.
      multi_payment:
        Array.isArray(data.multi_payment) ||
        (data.multi_payment && typeof data.multi_payment === 'object')
          ? data.multi_payment
          : [],
      denomination_values: data.denomination_values ?? (existingSale?.denomination_values || []),
    };

    updateData.receipt_quote = require('../helpers/receipt-quote').select(
      context.branchSettings?.receipt_designs?.quoteFooter,
      existingSale?.sales_id || prefixId,
      existingSale ? (existingSale.receipt_quote ?? null) : undefined
    );

    if (preparePaidEdit) return { status: true, data: updateData };
    let finalSaleData = id === '' ? { ...insertData, ...updateData } : updateData;
    if (extensionStock) {
      if (paymentStatus !== 'Paid')
        return { status: false, message: 'Allocated quantities require a completed payment.' };
      await require('./extension-stock-allocations').validateSaleGrant(stockGrant, context, items);
      finalSaleData._id = extensionStock.saleId;
      finalSaleData.extension_stock_operation = extensionStock.stockOperationId;
      finalSaleData.extension_id = extensionStock.extensionId;
    }
    let submissionDb = null;
    if (id === '' && data.idempotencyKey) {
      submissionDb = await BaseModel.getDb();
      const existing = await require('./desktop-submission').prepare(
        submissionDb,
        { branchId, license: licenseId },
        String(userId || ''),
        extensionSubmission || submittedPayload,
        finalSaleData
      );
      if (existing) return await savedAnswer(existing._id, existing.sales_id, true);
    }

    // Inventory Verification BEFORE Insert (PHP lines 653-690)
    if (id === '' && !extensionStock) {
      const insufficientItems = [];
      for (const item of items) {
        const doc = await itemRepository.findItemById(item.item_id);
        if (doc && doc.track_inventory && !doc.negative_stock) {
          const requiredStock = require('../helpers/selling-units').stockQuantity(
            itemsale.find((line) => orderLine.key(line) === orderLine.key(item)),
            item.item_quantity
          );
          if (doc.available_quantity < requiredStock) {
            insufficientItems.push({
              item_id: String(doc._id),
              item_quantity: doc.available_quantity,
            });
          }
        }
      }
      if (insufficientItems.length > 0) {
        return {
          status: false,
          data: insufficientItems,
          message: 'Your sales item quantity is mismatched.',
        };
      }
    }

    // Reserve tracked stock atomically before creating the sale. A normal
    // read-then-update allows two counters to sell the same final quantity.
    const stockReservations = new Map();
    if (id === '' && !extensionStock) {
      const stockRequests = new Map();
      for (const item of items) {
        const doc = await itemRepository.findItemById(item.item_id);
        const qty = require('../helpers/selling-units').stockQuantity(
          itemsale.find((line) => orderLine.key(line) === orderLine.key(item)),
          item.item_quantity
        );
        const isTracked = doc && (doc.track_inventory === true || doc.track_inventory === 'true');
        if (!isTracked || doc.negative_stock === true) continue;
        const key = String(doc._id);
        const request = stockRequests.get(key) || { doc, quantity: 0, itemName: '' };
        request.quantity += qty;
        request.itemName = request.itemName || item.item_name || doc.name || '';
        stockRequests.set(key, request);
      }

      for (const request of stockRequests.values()) {
        const reserved = await itemRepository.deductStockIfAvailable(
          request.doc._id,
          request.quantity
        );
        if (!reserved) {
          for (const reservation of stockReservations.values()) {
            await itemRepository.updateStock(reservation.itemId, reservation.quantity);
          }
          const latest = await itemRepository.findItemById(request.doc._id);
          return {
            status: false,
            data: [
              {
                item_id: String(request.doc._id),
                item_name: request.itemName,
                requested_quantity: request.quantity,
                item_quantity: Number(latest?.available_quantity || 0),
              },
            ],
            message:
              'Stock changed at another billing counter. Please refresh the item and try again.',
          };
        }
        stockReservations.set(String(request.doc._id), {
          itemId: request.doc._id,
          quantity: request.quantity,
          opening: Number(reserved.available_quantity) + request.quantity,
          closing: Number(reserved.available_quantity),
        });
      }
    }

    // --- DB OPERATIONS ---
    // Internal provider preparation: pricing, allocation and submission identity
    // have been validated. Return the exact core document before any sale write.
    // The payment coordinator persists it before asking a terminal to charge.
    if (prepareAllocated) return { status: true, data: decisionPricing, document: finalSaleData };
    let result;
    if (id === '') {
      // ADD: create a new Sale document so that the pre-save hook can
      // normalize the payload into a PHP-style 1:1 document.
      try {
        // A core payment coordinator may fence the final write against a
        // concurrently rejected/cancelled submission. This internal callback
        // is unavailable to request JSON and requires a validated stock grant.
        if (beforeStockCommit)
          finalSaleData = await beforeStockCommit(decisionPricing, finalSaleData);
        if (beforeCommit) {
          const proof = await beforeCommit(decisionPricing);
          finalSaleData.business_decision_receipt =
            require('./business-decision-receipt').decisionReceipt(
              proof,
              { ...context, businessDecisionDeviceId: decisionContext.businessDecisionDeviceId },
              data.billing_transaction_id,
              decisionPricing
            );
        }
        // If the unique bill-number index catches a one-in-a-million clash,
        // take the next number and retry rather than fail the sale.
        result = await salesRepository.createSaleUnique(finalSaleData, async () => {
          const pv = context.salesPrefix || 'INV';
          return salesRepository.generateSalesIdForBranch(branchId, { fallbackPrefix: pv });
        });
      } catch (error) {
        for (const reservation of stockReservations.values()) {
          await itemRepository.updateStock(reservation.itemId, reservation.quantity);
        }
        if (submissionDb && error.code === 11000) {
          const existing = await require('./desktop-submission').lookup(
            submissionDb,
            { branchId, license: licenseId },
            String(userId || ''),
            extensionSubmission || submittedPayload
          );
          if (existing) return await savedAnswer(existing._id, existing.sales_id, true);
        }
        throw error;
      }
    } else {
      // EDIT: load the existing document and apply the PHP-compatible
      // updateData via .save() so that the same pre-save hook used for
      // Add (including Live-Order item rewriting) also runs here.
      const doc = await salesRepository.getById(id);
      if (!doc) {
        return {
          status: false,
          data: null,
          message: 'Sale not found for update',
        };
      }
      // Repricing used the first read. Reloading the Mongoose document must
      // not silently authorize writing over a payment/closure that happened
      // in between. Mongoose applies these conditions at the actual save too.
      // A hydration default was not stored on a legacy document: compare
      // absence rather than requiring that synthesized default in MongoDB.
      doc.$where = { ...(doc.$where || {}) };
      for (const field of [
        'payment_correction_pending',
        'payment_corrections',
        'payment_status',
        'paid_amount',
        'partial_balance',
        'partial_amounts',
        'payment_pending',
      ]) {
        // Some workflows write lifecycle fields through the native driver. A
        // field outside the Mongoose schema is available through get(), but
        // not a direct property. Requiring its absence rejects valid orders.
        const storedValue =
          typeof existingSale?.get === 'function' ? existingSale.get(field) : existingSale?.[field];
        doc.$where[field] =
          storedValue === undefined || existingSale?.$isDefault?.(field)
            ? { $exists: false }
            : storedValue;
      }
      doc.set(updateData);
      result = await salesRepository.save(doc);
    }

    const saleId = id === '' ? result._id : new ObjectId(id);
    // For new sales use generated prefixId; for edits, keep the existing sales_id if available
    const salePrefixedId =
      id === '' ? prefixId : existingSale && existingSale.sales_id ? existingSale.sales_id : '';

    /*
     * The sale is committed - tell the sync agent NOW, not on the 15s scan.
     * The marker is an event row (never deduplicated) and the agent's
     * critical lane pushes sales before the stock they changed, so the shop's
     * record that money was taken reaches the cloud in ~2s. Fire-safe both
     * halves: the sale is done whatever happens here, and in the cloud both
     * are no-ops (see sync/outbox.js isEnabled).
     */
    try {
      const { enqueue, REASONS } = require('../sync/outbox');
      enqueue({ collection: 'sales', documentId: saleId, reason: REASONS.SALE });
      require('../sync/nudge').nudgeSyncAgent();
    } catch (e) {
      /* accelerator only - the periodic scan still delivers */
    }

    // Update Stock & Logs (PHP lines 696-710 for Add, 753-778 for Edit)
    const stockLogsRepository = new StockLogsRepository();
    const stockLogStatus = context.stockLogStatus || true; // Default true

    if (id === '') {
      // ADD

      for (const item of items) {
        const doc = await itemRepository.findItemById(item.item_id);
        if (!doc) continue;

        const qty = require('../helpers/selling-units').stockQuantity(
          itemsale.find((line) => orderLine.key(line) === orderLine.key(item)),
          item.item_quantity
        );
        // This quantity already left stock in a durable host operation. The
        // sale retains that reference; there is no second movement or stock log.
        if (extensionStock?.itemIds.has(String(doc._id))) continue;
        const reservation = stockReservations.get(String(doc._id));
        // One reservation covers every unit of this product. Each receipt line
        // still needs its own consecutive stock-log balances.
        const opening = reservation
          ? reservation.opening - (reservation.loggedQuantity || 0)
          : doc.available_quantity;
        const newAvailable = opening - qty;
        if (reservation) reservation.loggedQuantity = (reservation.loggedQuantity || 0) + qty;
        const count = `-${qty}`;
        const isTracked = doc.track_inventory === true || doc.track_inventory === 'true';

        // Always update item stock for tracked items, even if branch
        // stock_management is disabled. The branch setting only controls
        // whether detailed stock logs are written.
        if (isTracked) {
          // Non-negative tracked stock was already reserved atomically above.
          // Negative-stock items retain the legacy unrestricted decrement.
          if (!reservation) await itemRepository.updateStock(doc._id, -qty);

          if (context.stockManagement) {
            const stockLogResult = await stockLogsRepository.createStockLog({
              stocklog: stockLogStatus,
              branch_id: branchId,
              view_item_id: doc._id,
              item_barcode_id: doc.barcode_id || '',
              item_quantity: qty,
              item_name: item.item_name || '',
              process: 'Add Sale',
              date: mongo_date,
              action: 'subtract',
              changed_by_userid: userId,
              opening_balance: opening,
              closing_balance: newAvailable,
              count: count,
              reference: prefixId,
              changed_by: userName || 'System',
            });

            if (!stockLogResult.status) {
              console.error('[SALES] Stock log creation failed:', stockLogResult.message);
            }
          }
        }
      }
    } else {
      // EDIT
      // PHP Logic: loop through new items, calculate diff against old items carried in logic?
      // Actually PHP loop says `foreach (($data['items']) as $items_update)`
      // And compares with `old_item_quantity`.
      // In Node we are reprocessing. Logic is complex.
      // Simplified approach for Edit:
      // Since we already calculated 'changes_items' which has the delta (add/cancel), we can use that?
      // PHP Lines 753: iterates input items again.
      // It calculates `quantity = oldQuantity - item_quantity`.
      // `available_quantity = quantity + opening_balance`.
      // Wait, `quantity` here diff.

      // Let's rely on `changes_items` we built.
      // If `process` is 'add' (qty increased), we subtract from stock.
      // If `process` is 'cancel' (qty decreased), we add to stock.

      for (const change of changes_items) {
        const doc = await itemRepository.findItemById(change.item_id);
        const isTracked = doc && (doc.track_inventory === true || doc.track_inventory === 'true');
        if (!isTracked) continue;

        const qtyChange = change.stock_quantity ?? change.item_quantity;
        const opening = doc.available_quantity;
        let newAvailable = opening;
        let action = '';
        let count = '';

        if (change.process === 'add') {
          // Added more items -> Reduce Stock
          newAvailable = opening - qtyChange;
          action = 'Subtract';
          count = `-${qtyChange}`;
          // Apply the same numeric delta via repository
          await itemRepository.updateStock(doc._id, -qtyChange);
        } else {
          // Cancelled/Reduced items -> Increase Stock
          newAvailable = opening + qtyChange;
          action = 'Add';
          count = `+${qtyChange}`;
          await itemRepository.updateStock(doc._id, qtyChange);
        }

        if (context.stockManagement) {
          const stockLogResult = await stockLogsRepository.createStockLog({
            stocklog: stockLogStatus,
            branch_id: branchId,
            view_item_id: doc._id,
            item_barcode_id: doc.barcode_id || '',
            item_quantity: qtyChange,
            item_name: change.item_name || '',
            process: 'Edit Sale',
            date: mongo_date,
            action: action,
            changed_by_userid: userId,
            opening_balance: opening,
            closing_balance: newAvailable,
            count: count,
            reference: data.alternative_id || existingSale.sales_id || id,
            changed_by: userName || 'System',
          });

          if (!stockLogResult.status) {
            console.error('[SALES] Edit Sale stock log creation failed:', stockLogResult.message);
          }
        }
      }
    }
    // Update Register (PHP lines 713 (Add), 781 (Edit))
    if (data.register_id) {
      const registerData = {
        // Internal Mongo ObjectId reference for cleanup / linkage
        sales_id: saleId,
        // Human-readable sale number for UI (e.g. SDS000123)
        sale_no: salePrefixedId,
        date: mongo_date,
        register_amount: parseFloat(finalSaleTotAmount),
        register_paid_amount: parseFloat(paidAmount || 0),
        register_discount: parseFloat(sale_discount_amount),
        registerItems_return_total: 0.0,
        register_paymentmode: data.payment_mode,
        multi_payment: data.multi_payment || [],
      };

      if (id === '') {
        // ADD: push new register_sales entry
        await registerRepository.addSaleRegisterEntry({
          registerId: data.register_id,
          licenseId,
          registerData,
        });
      } else {
        // EDIT: update existing register_sales entry for this sale
        await registerRepository.updateSaleRegisterEntry({
          saleId: id,
          licenseId,
          registerData,
        });
      }
    }

    // Handle Partial Payment Transaction (PHP lines 822-876, 877-934)
    // Create/Update transaction collection record for partial payment customers
    if (partialCheck && String(partialCheck) === 'true') {
      const db = await BaseModel.getDb();
      const transactionCollection = db.collection('transaction');

      // Common transaction data (PHP $commonTransactionData)
      const commonTransactionData = {
        updated_date: mongo_date,
        customer_id: new ObjectId(data.customer_id),
        customer_name: (data.customer_name || '').trim(),
        transaction_image: 'category.svg',
        license: licenseId,
        branch_id: branchId,
      };

      if (id === '') {
        // ADD: Insert new transaction record (PHP lines 822-876)
        let transactionInsertData = {};
        const walletCheck = data.wallet_check === 'true' || data.wallet_check === true;
        const customerCurrentBalance = parseFloat(data.customer_current_balance || 0);

        if (walletCheck && customerCurrentBalance >= finalSaleTotAmount) {
          // Customer wallet covers full sale amount
          transactionInsertData = {
            sale_id: saleId,
            amount: finalSaleTotAmount,
            type: 'out',
            pending: finalSaleTotAmount - partialBalance,
            sale_total: finalSaleTotAmount,
            description: 'Add sale wallet',
          };

          // Update sale wallet_amount
          await salesRepository.updateWalletAmount(saleId, finalSaleTotAmount);
        } else if (walletCheck && customerCurrentBalance < finalSaleTotAmount) {
          // Customer wallet partially covers sale amount
          transactionInsertData = {
            sale_id: saleId,
            amount: customerCurrentBalance,
            type: 'out',
            pending: finalSaleTotAmount - partialBalance,
            sale_total: finalSaleTotAmount,
            description: 'Add sale',
          };

          // Update sale wallet_amount
          await salesRepository.updateWalletAmount(saleId, customerCurrentBalance);
        } else {
          // No wallet usage
          transactionInsertData = {
            sale_id: saleId,
            amount: 0.0,
            type: 'out',
            pending: finalSaleTotAmount - partialBalance,
            sale_total: finalSaleTotAmount,
            description: 'Add sale',
          };
        }

        const transactionCollectionData = { ...commonTransactionData, ...transactionInsertData };
        await transactionCollection.insertOne(transactionCollectionData);

        console.log('[SALES TRANSACTION] Created transaction record for partial payment:', {
          sale_id: saleId,
          customer_id: data.customer_id,
          amount: transactionInsertData.amount,
          pending: transactionInsertData.pending,
        });
      } else {
        // EDIT: Update existing transaction record (PHP lines 877-934)
        const existingTransaction = await transactionCollection.findOne({
          sale_id: saleId,
        });

        const walletCheck = data.wallet_check === 'true' || data.wallet_check === true;
        const customerCurrentBalance = parseFloat(data.customer_current_balance || 0);

        if (walletCheck && customerCurrentBalance >= finalSaleTotAmount) {
          // Customer wallet covers full sale amount
          await transactionCollection.updateOne(
            {
              sale_id: saleId,
              customer_id: new ObjectId(data.customer_id),
            },
            {
              $set: {
                amount: finalSaleTotAmount,
                type: 'out',
                updated_date: mongo_date,
                pending: finalSaleTotAmount - partialBalance,
                sale_total: finalSaleTotAmount,
                description: 'Edit sale',
              },
            }
          );

          await salesRepository.updateWalletAmount(saleId, finalSaleTotAmount);
        } else if (walletCheck && customerCurrentBalance < finalSaleTotAmount) {
          // Customer wallet partially covers sale amount
          await transactionCollection.updateOne(
            {
              sale_id: saleId,
              customer_id: new ObjectId(data.customer_id),
            },
            {
              $set: {
                amount: customerCurrentBalance,
                type: 'out',
                updated_date: mongo_date,
                pending: finalSaleTotAmount - partialBalance,
                sale_total: finalSaleTotAmount,
                description: 'Edit sale',
              },
            }
          );

          await salesRepository.updateWalletAmount(saleId, customerCurrentBalance);
        } else {
          // No wallet usage
          await transactionCollection.updateOne(
            {
              sale_id: saleId,
              customer_id: new ObjectId(data.customer_id),
            },
            {
              $set: {
                amount: 0.0,
                type: 'out',
                updated_date: mongo_date,
                pending: finalSaleTotAmount - partialBalance,
                sale_total: finalSaleTotAmount,
                description: 'Edit sale',
              },
            }
          );
        }

        console.log('[SALES TRANSACTION] Updated transaction record for partial payment:', {
          sale_id: saleId,
          customer_id: data.customer_id,
        });
      }
    }

    return await savedAnswer(saleId, salePrefixedId);
  } catch (error) {
    console.error('processSale Error:', error);
    if (error.name === 'DocumentNotFoundError') {
      return {
        status: false,
        data: null,
        message:
          'This order changed while payment was being saved. Reopen the order and check its payment status before retrying.',
      };
    }
    return {
      status: false,
      message: error.message,
      data: null,
      ...(beforeCommit && typeof error.code === 'string' && Number.isInteger(error.status)
        ? { decisionError: { code: error.code, status: error.status } }
        : {}),
    };
  }
};

const getSaleById = async (id, { SaleModel } = {}) => {
  if (!id) return null;
  // Delegate to repository so that all DB access for Sale documents
  // goes through a single abstraction layer.
  return salesRepository.getById(id, { SaleModel: getModel(SaleModel) });
};

/**
 * Update the status field for a sale document.
 * Throws NotFoundError / BadRequestError for invalid state transitions.
 *
 * @param {{ id: string|ObjectId, status: string }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<mongoose.Document>}
 */
const updateSaleStatus = async ({ id, status }, { SaleModel } = {}) => {
  const sale = await salesRepository.getById(id, {
    SaleModel: getModel(SaleModel),
  });
  if (!sale) {
    throw new NotFoundError('Sale not found');
  }

  if (sale.status === SALE_STATUS.CANCELLED) {
    throw new BadRequestError('Cannot update a cancelled sale');
  }

  sale.status = status;
  await salesRepository.save(sale);

  return sale;
};

/**
 * Append a payment to a sale and update payment-related fields.
 * Throws NotFoundError / BadRequestError if the sale is missing or
 * already fully paid.
 *
 * @param {{ id: string|ObjectId, amount: number|string, method: string, reference?: string, notes?: string }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<mongoose.Document>}
 */
const processSalePayment = async ({ id, amount, method, reference, notes }, { SaleModel } = {}) => {
  const sale = await salesRepository.getById(id, {
    SaleModel: getModel(SaleModel),
  });
  if (!sale) {
    throw new NotFoundError('Sale not found');
  }

  if (sale.payment_status === PAYMENT_STATUS.PAID) {
    throw new BadRequestError('Sale is already paid in full');
  }

  const payment = {
    amount: parseFloat(amount),
    method,
    reference,
    notes,
  };

  sale.payments.push(payment);
  sale.paid_amount = (sale.paid_amount || 0) + payment.amount;
  sale.balance = sale.total - sale.paid_amount;
  sale.payment_status = sale.balance <= 0 ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.PARTIAL;

  await salesRepository.save(sale);

  return sale;
};

/**
 * Aggregate a high-level sales summary for a single branch over an
 * optional date range. Mirrors the logic previously in
 * sales.controller#getSummary to preserve behaviour.
 *
 * @param {{ branchId: any, startDate?: string, endDate?: string }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<Object>} summary document
 */
const getSalesSummary = async ({ branchId, startDate, endDate }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);

  const match = {
    status: SALE_STATUS.COMPLETED,
    branch: branchId,
  };

  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  const summary = await salesRepository.aggregate(
    [
      { $match: match },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalAmount: { $sum: '$total' },
          totalPaid: { $sum: '$paid_amount' },
          totalBalance: { $sum: '$balance' },
          byPaymentMethod: { $push: '$payments.method' },
        },
      },
      {
        $project: {
          _id: 0,
          totalSales: 1,
          totalAmount: 1,
          totalPaid: 1,
          totalBalance: 1,
          // Flatten nested payment method arrays into a single array
          paymentMethods: {
            $reduce: {
              input: '$byPaymentMethod',
              initialValue: [],
              in: { $concatArrays: ['$$value', '$$this'] },
            },
          },
        },
      },
    ],
    { SaleModel: Model }
  );

  const defaultSummary = {
    totalSales: 0,
    totalAmount: 0,
    totalPaid: 0,
    totalBalance: 0,
    paymentMethods: { count: 0, methods: {} },
  };

  if (!Array.isArray(summary) || summary.length === 0) {
    return defaultSummary;
  }

  return summary[0] || defaultSummary;
};

/**
 * Aggregate sales by product for a single branch over an optional
 * date range. Mirrors the logic previously in
 * sales.controller#getSalesByProduct.
 *
 * @param {{ branchId: any, startDate?: string, endDate?: string }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<Array>} list of product-level aggregates
 */
const getSalesByProduct = async ({ branchId, startDate, endDate }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);

  const match = {
    status: SALE_STATUS.COMPLETED,
    branch: branchId,
  };

  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  const salesByProduct = await salesRepository.aggregate(
    [
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.item',
          name: { $first: '$items.name' },
          sku: { $first: '$items.sku' },
          quantitySold: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.total' },
        },
      },
      { $sort: { quantitySold: -1 } },
    ],
    { SaleModel: Model }
  );

  return salesByProduct;
};

/**
 * Fetch the latest 6 sales for a branch, mirroring the legacy
 * getLatestSales controller behaviour but keeping DB access in
 * the service/repository layers.
 *
 * @param {{ branchId: any, licenseId?: any }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<Array>} list of simplified latest sale rows
 */
const getLatestSales = async ({ branchId, licenseId, holdOnly }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);

  const branchMatch = [];
  if (branchId) {
    let normalized = null;
    if (branchId instanceof mongoose.Types.ObjectId) {
      normalized = branchId;
    } else if (mongoose.Types.ObjectId.isValid(String(branchId))) {
      normalized = new mongoose.Types.ObjectId(String(branchId));
    }

    if (normalized) {
      branchMatch.push({ branch_id: normalized });
      branchMatch.push({ branch: normalized });
    }
  }

  const baseFilter = {
    // Include 'Hold' so parked sales surface in the New Sale "Recent Sales" tab
    // for one-click retrieval, without leaving the billing screen.
    // The Parked tab asks for holds alone and gets a longer list.
    sale_process: holdOnly ? { $in: ['Hold'] } : { $in: ['Add', 'Edit', 'Hold'] },
  };

  if (branchMatch.length) {
    baseFilter.$or = branchMatch;
  }

  if (licenseId) {
    baseFilter.license = licenseId;
  }

  const pipeline = [
    { $match: baseFilter },
    { $sort: { _id: -1 } },
    ...require('./parked-sales').visibilityStages(),
    { $limit: holdOnly ? 20 : 6 },
  ];

  const sales = await salesRepository.aggregate(pipeline, { SaleModel: Model });

  const latestSales = sales.map((sale) => {
    const numberOfItems =
      typeof sale.number_of_items === 'number'
        ? sale.number_of_items
        : Array.isArray(sale.items)
          ? sale.items.length
          : 0;

    return {
      sales_document_id: sale._id?.toString?.() || '',
      sales_id: sale.sales_id || sale.invoice_number || '',
      customer_name: sale.customer_name || '',
      sale_process: sale.sale_process || 'Add',
      number_of_items: numberOfItems,
      total_amount:
        typeof sale.sales_total === 'number'
          ? sale.sales_total
          : Number(sale.sales_total || sale.total || 0) || 0,
      payment_status: sale.payment_status || 'Paid',
      /* When this was parked, so the Parked tab can say how long it has been
         waiting. updated first: re-holding a sale touches it, and "waiting
         since the last time anyone looked at it" is the useful figure. */
      parked_at: sale.updated_date || sale.updatedAt || sale.date || sale.created_date || null,
    };
  });

  return latestSales;
};

/**
 * Core data fetch for daily sales reports. This helper runs the same
 * MongoDB queries that dailySalesReports used previously in the
 * controller, so that controllers no longer talk to the Sale model
 * directly.
 *
 * @param {{ match: Object }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<{productAgg: Array, paymentAgg: Array, salesPayments: Array}>}
 */
const getDailySalesReportAggregates = async ({ match }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);

  const productPipeline = [
    { $match: match },
    { $unwind: '$items' },
    {
      $addFields: {
        // Support both field name formats
        'items.name': { $ifNull: ['$items.name', '$items.item_name'] },
        'items.sku': { $ifNull: ['$items.sku', '$items.item_sku'] },
        'items.quantity': { $ifNull: ['$items.quantity', '$items.item_quantity'] },
        'items.unit_price': { $ifNull: ['$items.unit_price', '$items.item_price'] },
        'items.total': { $ifNull: ['$items.total', '$items.total_amount'] },
        'items.discount': { $ifNull: ['$items.discount', '$items.item_discount'] },
      },
    },
    {
      $group: {
        _id: {
          item_id: { $ifNull: ['$items.item_id', '$items.id'] },
          name: '$items.name',
          sku: '$items.sku',
        },
        totalQty: {
          $sum: {
            $toDouble: { $ifNull: ['$items.quantity', 0] },
          },
        },
        totalAmount: {
          $sum: {
            $toDouble: { $ifNull: ['$items.total', 0] },
          },
        },
        subtotal: {
          $sum: {
            $toDouble: { $ifNull: ['$items.total', 0] },
          },
        },
        totalCompanyPrice: {
          $sum: lineCostExpression(),
        },
        totalDiscount: {
          $sum: {
            $toDouble: { $ifNull: ['$items.discount', 0] },
          },
        },
      },
    },
    { $sort: { totalQty: -1, totalAmount: -1 } },
  ];

  const paymentPipeline = buildDailyPaymentAggregationPipeline(match);

  const [productAgg, paymentAgg, salesPayments] = await Promise.all([
    salesRepository.aggregate(productPipeline, { SaleModel: Model }),
    salesRepository.aggregate(paymentPipeline, { SaleModel: Model }),
    salesRepository.find(match, 'extra_discount sale_extra_discount extra_discount_type', {
      SaleModel: Model,
    }),
  ]);

  return { productAgg, paymentAgg, salesPayments };
};

/**
 * Aggregation helper for the PDF variant of the daily sales report.
 * Mirrors the pipelines previously in sales.controller#dailyReportPdf
 * while keeping controllers free of direct model access.
 *
 * @param {{ match: Object }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<{ productAgg: Array, paymentAgg: Array, extraDiscountSummary: Object }>}
 */
const getDailyReportPdfAggregates = async ({ match }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);

  const productAgg = await salesRepository.aggregate(
    [
      { $match: match },
      { $unwind: '$items' },
      {
        $addFields: {
          'items.name': { $ifNull: ['$items.name', '$items.item_name'] },
          'items.sku': { $ifNull: ['$items.sku', '$items.item_sku'] },
          'items.quantity': { $ifNull: ['$items.quantity', '$items.item_quantity'] },
          'items.unit_price': { $ifNull: ['$items.unit_price', '$items.item_price'] },
          'items.total': { $ifNull: ['$items.total', '$items.total_amount'] },
          'items.discount': { $ifNull: ['$items.discount', '$items.item_discount'] },
        },
      },
      {
        $group: {
          _id: {
            item_id: { $ifNull: ['$items.item_id', '$items.id'] },
            name: '$items.name',
            sku: '$items.sku',
          },
          totalQty: {
            $sum: { $toDouble: { $ifNull: ['$items.quantity', 0] } },
          },
          totalAmount: {
            $sum: { $toDouble: { $ifNull: ['$items.total', 0] } },
          },
          unitPrice: {
            $first: { $toDouble: { $ifNull: ['$items.unit_price', 0] } },
          },
          totalDiscount: {
            $sum: { $toDouble: { $ifNull: ['$items.discount', 0] } },
          },
        },
      },
      { $sort: { totalQty: -1 } },
    ],
    { SaleModel: Model }
  );

  const paymentAgg = await salesRepository.aggregate(buildDailyPaymentAggregationPipeline(match), {
    SaleModel: Model,
  });

  // Aggregate extra discount for PDF (mirrors dailySalesReports logic)
  const salesPayments = await salesRepository.find(
    match,
    'extra_discount sale_extra_discount extra_discount_type',
    { SaleModel: Model }
  );

  let totalExtraDiscount = 0;
  let totalSaleExtraDiscount = 0;
  const discountByType = new Map();

  salesPayments.forEach((saleDoc) => {
    const extraDiscount = Number(saleDoc.extra_discount) || 0;
    const saleExtraDiscount = Number(saleDoc.sale_extra_discount) || 0;
    const discountType = saleDoc.extra_discount_type || 'price';

    if (extraDiscount > 0 || saleExtraDiscount > 0) {
      totalExtraDiscount += extraDiscount;
      totalSaleExtraDiscount += saleExtraDiscount;

      const existing = discountByType.get(discountType) || {
        type: discountType,
        extra_discount_total: 0,
        sale_extra_discount_total: 0,
        count_sales: 0,
      };

      existing.extra_discount_total += extraDiscount;
      existing.sale_extra_discount_total += saleExtraDiscount;
      existing.count_sales += 1;

      discountByType.set(discountType, existing);
    }
  });

  const extraDiscountByType = Array.from(discountByType.values()).map((data) => ({
    type: data.type,
    extra_discount_total: round2(data.extra_discount_total),
    sale_extra_discount_total: round2(data.sale_extra_discount_total),
    count_sales: data.count_sales,
  }));

  const extraDiscountSummary = {
    total_extra_discount: round2(totalExtraDiscount),
    total_sale_extra_discount: round2(totalSaleExtraDiscount),
    by_type: extraDiscountByType,
  };

  return { productAgg, paymentAgg, extraDiscountSummary };
};

/**
 * Aggregation helper for the graphical sales report.
 * Mirrors the pipelines and debug queries previously in
 * sales.controller#salesGraphicalReports while keeping controllers
 * free of direct model access.
 *
 * @param {{ match: Object, validBranchIds: Array }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<Array>} chart data for the graphical report
 */
const getSalesGraphicalReportData = async ({ match, validBranchIds }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);
  let timezone = process.env.DEFAULT_TIMEZONE || 'UTC';
  if (Array.isArray(validBranchIds) && validBranchIds.length === 1) {
    try {
      const branchDoc = await branchesRepository.findById(validBranchIds[0], {
        select: 'time_zone',
        lean: true,
      });
      if (branchDoc?.time_zone) {
        timezone = branchDoc.time_zone;
      }
    } catch (error) {
      console.warn('getSalesGraphicalReportData: Branch lookup failed', error);
    }
  }

  const normalizedItemTotalExpr = toNumberExpression({
    $ifNull: ['$items.total', { $ifNull: ['$items.total_amount', 0] }],
  });

  const pipeline = [
    { $match: match },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'items',
        localField: 'items.item',
        foreignField: '_id',
        as: 'item_info',
      },
    },
    {
      $unwind: {
        path: '$item_info',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $set: {
        normalizedDate: {
          $ifNull: ['$date', { $ifNull: ['$updatedAt', '$createdAt'] }],
        },
        normalizedItemTotal: normalizedItemTotalExpr,
        normalizedCompanyPrice: lineCostExpression({
          fallbackUnit: '$item_info.company_price',
        }),
      },
    },
    {
      $match: { normalizedDate: { $ne: null } },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$normalizedDate',
            timezone,
          },
        },
        totalSales: { $sum: '$normalizedItemTotal' },
        averageSale: { $avg: '$normalizedItemTotal' },
        totalCompanyPrice: { $sum: '$normalizedCompanyPrice' },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        date: '$_id',
        sales: { $round: ['$totalSales', 2] },
        avg: { $round: ['$averageSale', 2] },
        profit: {
          $round: [
            {
              $subtract: [
                '$totalSales',
                '$totalCompanyPrice', // Subtract COGS
              ],
            },
            2,
          ],
        },
      },
    },
  ];

  const chartData = await salesRepository.aggregate(pipeline, {
    SaleModel: Model,
  });
  return chartData;
};

/**
 * Aggregation helper for legacy /sales/salesSummaryReports.
 * Runs the same diagnostics and aggregation pipelines that
 * sales.controller#salesSummaryReports previously executed,
 * and returns the final shaped summary object.
 *
 * @param {{ match: Object, branchObjectIds: Array }} params
 * @param {Object} options
 * @param {mongoose.Model} [options.SaleModel]
 * @returns {Promise<Object>} summary result
 */
const getSalesSummaryReportsData = async ({ match, branchObjectIds }, { SaleModel } = {}) => {
  const Model = getModel(SaleModel);
  const salesAgg = await salesRepository.aggregate(
    [
      { $match: match },
      {
        $group: {
          _id: null,
          sales_total: {
            $sum: {
              $toDouble: {
                $ifNull: [
                  '$sales_total',
                  { $ifNull: ['$total', { $ifNull: ['$items_total', 0] }] },
                ],
              },
            },
          },
          total_discount: {
            $sum: {
              $toDouble: {
                $ifNull: ['$discount', { $ifNull: ['$sales_discount', 0] }],
              },
            },
          },
          total_cogs: {
            $sum: {
              $toDouble: {
                $ifNull: ['$total_companyprice', { $ifNull: ['$sales_total_company_price', 0] }],
              },
            },
          },
          refunds: {
            $sum: {
              $toDouble: {
                $ifNull: ['$items_return_total', { $ifNull: ['$return_total', 0] }],
              },
            },
          },
          sale_count: { $sum: 1 },
        },
      },
    ],
    { SaleModel: Model }
  );

  const summary =
    salesAgg.length > 0
      ? salesAgg[0]
      : {
          sales_total: 0,
          total_discount: 0,
          total_cogs: 0,
          refunds: 0,
          sale_count: 0,
        };

  const sales_total = summary.sales_total || 0;
  // Informational only. The billed total is already net of every discount;
  // subtracting this again made the report understate sales and profit.
  const discounts = summary.total_discount || 0;
  const refunds = summary.refunds || 0;

  // The saved bill total already contains line and extra discounts. A partial
  // return keeps that original total and records the refund separately, so
  // net sales is the bill minus money given back.
  const net_sales = sales_total - refunds;

  // COGS is already aggregated as Σ(Qty Sold × Cost Price) into total_companyprice
  const cogs = summary.total_cogs || 0;

  // Profit (Gross Profit) = Net Sales − COGS
  const gross_profit = net_sales - cogs;

  return {
    sales_total: round2(sales_total),
    net_sales: round2(net_sales),
    discounts: round2(discounts),
    gross_profit: round2(gross_profit),
    refunds: round2(refunds),
    cogs: round2(cogs),
  };
};

module.exports = {
  processSale,
  previewSale: (data, context) => processSale(data, '', 'Add', context, { preview: true }),
  enrichSaleContext,
  getSaleById,
  updateSaleStatus,
  processSalePayment,
  getSalesSummary,
  getSalesByProduct,
  getLatestSales,
  getBranchById,
  getDailySalesReportAggregates,
  getDailyReportPdfAggregates,
  getSalesGraphicalReportData,
  getSalesSummaryReportsData,
  getSalesReportsData: async ({ match, page, limit, branch }, { SaleModel } = {}) => {
    const Model = getModel(SaleModel);

    /*
     * How this shop reads dates, and what clock its day runs on.
     *
     * Passed in rather than looked up here, because the caller already has the
     * branch and a service that fetches its own settings is a service that does
     * it once per row. With no branch given this falls back to the documented
     * defaults rather than to whatever the server happens to be set to.
     */
    const display = require('../utils/date-preference').dateDisplay(branch);

    const pipeline = [
      { $match: match },
      {
        $facet: {
          metadata: [
            { $count: 'total' },
            {
              $addFields: {
                current_page: page,
                per_page: limit,
                total_pages: {
                  $ceil: {
                    $divide: ['$total', limit],
                  },
                },
              },
            },
          ],
          data: [
            { $sort: { updated_date: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $addFields: {
                dateValue: { $ifNull: ['$date', '$updated_date'] },
              },
            },
            {
              /*
               * The date as this shop asked to see it.
               *
               * This printed month-first whatever the setting said, so a report
               * dated 08/03/2026 in a Goa shop read as 8 March and meant 3
               * August - five months out, on a document used for accounting and
               * for settling arguments with customers. The timezone was fixed
               * too, which is worse: it decides which day a 9:30pm sale lands
               * on, and getting it wrong moves the last hours of trade onto
               * tomorrow's sheet.
               */
              $addFields: {
                string_date: {
                  $dateToString: {
                    format: display.format,
                    date: '$dateValue',
                    timezone: display.timezone,
                  },
                },
              },
            },
            {
              $project: {
                _id: 1,
                sales_id: 1,
                customer_name: 1,
                customer_phone: 1,
                items_total: 1,
                extra_discount: 1,
                number_of_items: 1,
                updated_date: 1,
                string_date: 1,
                items: 1,
                discount: 1,
              },
            },
          ],
        },
      },
      {
        $project: {
          total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] },
          current_page: {
            $ifNull: [{ $arrayElemAt: ['$metadata.current_page', 0] }, page],
          },
          per_page: {
            $ifNull: [{ $arrayElemAt: ['$metadata.per_page', 0] }, limit],
          },
          total_pages: {
            $ifNull: [{ $arrayElemAt: ['$metadata.total_pages', 0] }, 0],
          },
          list: '$data',
        },
      },
    ];

    const [result] = await salesRepository.aggregate(pipeline, {
      SaleModel: Model,
    });

    return (
      result || {
        list: [],
        total: 0,
        current_page: page,
        per_page: limit,
        total_pages: 0,
      }
    );
  },
  getInstantSalesReportsData: async ({ match, page, limit }, { SaleModel } = {}) => {
    const Model = getModel(SaleModel);
    const skip = (page - 1) * limit;

    const itemsPipeline = [
      { $match: match },
      { $unwind: '$items' },
      { $match: { 'items.item_status': 'instant' } },
      { $sort: { date: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          sales_id: 1,
          date: 1,
          string_date: 1,
          customer_name: 1,
          user_name: 1,
          item_name: '$items.item_name',
          item_quantity: '$items.item_quantity',
          total_amount: '$items.total_amount',
          item_status: '$items.item_status',
        },
      },
    ];

    const countPipeline = [
      { $match: match },
      { $unwind: '$items' },
      { $match: { 'items.item_status': 'instant' } },
      { $count: 'total' },
    ];

    const [itemsList, countResult] = await Promise.all([
      salesRepository.aggregate(itemsPipeline, { SaleModel: Model }),
      salesRepository.aggregate(countPipeline, { SaleModel: Model }),
    ]);

    const total =
      Array.isArray(countResult) && countResult.length > 0 ? countResult[0].total || 0 : 0;

    return { itemsList, total };
  },
  /*
   * groupByFamily (V1 tail): an optional READING view - the same per-line
   * numbers, rolled up by variant_group_id where one exists. Per the
   * reporting invariant, this changes no stored number and no default:
   * off, every variant is its own row exactly as always; exports never
   * pass the flag.
   */
  getItemSalesReportTableData: async (
    { match, skip, limit, groupByFamily, itemId },
    { SaleModel } = {}
  ) => {
    const Model = getModel(SaleModel);

    const normalizedItemTotalExpr = toNumberExpression({
      $ifNull: [
        '$items.total',
        {
          $ifNull: ['$items.total_amount', { $ifNull: ['$items.items_total', 0] }],
        },
      ],
    });

    const normalizedQuantityExpr = toNumberExpression({
      $ifNull: [
        '$items.quantity',
        {
          $ifNull: [
            '$items.item_quantity',
            {
              $ifNull: ['$items.qty', { $ifNull: ['$items.number_of_items', 0] }],
            },
          ],
        },
      ],
    });

    // `company_price_total` is the full line cost in every sale shape. A
    // missing value falls back to the item's unit cost x quantity.
    const normalizedCompanyPriceExpr = lineCostExpression({
      fallbackUnit: '$item_info.company_price',
    });

    const normalizedNameExpr = {
      $ifNull: [
        '$items.name',
        {
          $ifNull: [
            '$items.item_name',
            {
              $ifNull: [
                '$item_info.name',
                {
                  $ifNull: ['$item_info.item_name', '$item_info.label'],
                },
              ],
            },
          ],
        },
      ],
    };

    const normalizedItemIdExpr = {
      $ifNull: ['$items.item', { $ifNull: ['$items.item_id', '$item_info._id'] }],
    };

    const pipeline = [
      { $match: match },
      { $unwind: '$items' },
      ...(itemId
        ? [
            {
              $match: {
                $expr: {
                  $eq: [
                    {
                      $convert: {
                        input: { $ifNull: ['$items.item', '$items.item_id'] },
                        to: 'string',
                        onError: '',
                        onNull: '',
                      },
                    },
                    itemId,
                  ],
                },
              },
            },
          ]
        : []),
      {
        $lookup: {
          from: 'items',
          localField: 'items.item',
          foreignField: '_id',
          as: 'item_info',
        },
      },
      {
        $unwind: {
          path: '$item_info',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $set: {
          normalizedItemTotal: normalizedItemTotalExpr,
          normalizedQuantity: normalizedQuantityExpr,
          normalizedCompanyPrice: normalizedCompanyPriceExpr,
          normalizedItemName: normalizedNameExpr,
          normalizedItemId: normalizedItemIdExpr,
        },
      },
      {
        $group: groupByFamily
          ? {
              // Family members share their group id as the key; everything
              // else keys exactly as before. The summed inputs are the SAME
              // per-line values the default view sums.
              _id: {
                $ifNull: [
                  '$item_info.variant_group_id',
                  { $ifNull: ['$normalizedItemId', '$normalizedItemName'] },
                ],
              },
              name: {
                $first: { $ifNull: ['$item_info.variant_parent_name', '$normalizedItemName'] },
              },
              family_members: {
                $addToSet: { $ifNull: ['$normalizedItemId', '$normalizedItemName'] },
              },
              total_amount: { $sum: '$normalizedItemTotal' },
              item_quantity: { $sum: '$normalizedQuantity' },
              total_company_price: { $sum: '$normalizedCompanyPrice' },
              sales_avg: { $avg: '$normalizedItemTotal' },
              sales_count: { $sum: 1 },
            }
          : {
              _id: { $ifNull: ['$normalizedItemId', '$normalizedItemName'] },
              name: { $first: '$normalizedItemName' },
              total_amount: { $sum: '$normalizedItemTotal' },
              item_quantity: { $sum: '$normalizedQuantity' },
              total_company_price: { $sum: '$normalizedCompanyPrice' },
              sales_avg: { $avg: '$normalizedItemTotal' },
              sales_count: { $sum: 1 },
            },
      },
      ...(groupByFamily ? [{ $set: { family_members: { $size: '$family_members' } } }] : []),
      {
        $set: {
          sales_profit: {
            $subtract: ['$total_amount', '$total_company_price'],
          },
          item_id: {
            $cond: [
              {
                $and: [{ $ne: ['$_id', null] }, { $ne: ['$_id', ''] }],
              },
              {
                $cond: [{ $eq: [{ $type: '$_id' }, 'objectId'] }, { $toString: '$_id' }, '$_id'],
              },
              null,
            ],
          },
        },
      },
      { $sort: { item_quantity: -1, total_amount: -1, name: 1 } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
      {
        $project: {
          total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] },
          list: '$data',
        },
      },
    ];

    const [result] = await salesRepository.aggregate(pipeline, {
      SaleModel: Model,
    });
    const total = result?.total || 0;
    const list = Array.isArray(result?.list) ? result.list : [];

    return { total, list };
  },
  getCategorySalesReportTableData: async (
    { match, skip, limit, requestedCategoryId },
    { SaleModel } = {}
  ) => {
    const Model = getModel(SaleModel);

    const normalizedItemTotalExpr = toNumberExpression({
      $ifNull: [
        '$items.total',
        {
          $ifNull: ['$items.total_amount', { $ifNull: ['$items.items_total', 0] }],
        },
      ],
    });

    const normalizedQuantityExpr = toNumberExpression({
      $ifNull: [
        '$items.quantity',
        {
          $ifNull: [
            '$items.item_quantity',
            {
              $ifNull: ['$items.qty', { $ifNull: ['$items.number_of_items', 0] }],
            },
          ],
        },
      ],
    });

    const normalizedCompanyPriceExpr = lineCostExpression();

    const normalizedCategoryIdExpr = {
      $let: {
        vars: {
          candidate: {
            $ifNull: [
              '$items.category_id',
              {
                $ifNull: [
                  '$items.categoryId',
                  {
                    $ifNull: ['$items.category._id', { $ifNull: ['$items.category.id', null] }],
                  },
                ],
              },
            ],
          },
        },
        in: {
          $cond: [
            {
              $and: [{ $ne: ['$$candidate', null] }, { $ne: ['$$candidate', ''] }],
            },
            {
              $cond: [
                { $eq: [{ $type: '$$candidate' }, 'objectId'] },
                { $toString: '$$candidate' },
                '$$candidate',
              ],
            },
            null,
          ],
        },
      },
    };

    const normalizedCategoryNameExpr = {
      $ifNull: [
        '$items.category_name',
        {
          $ifNull: [
            '$items.categoryName',
            {
              $ifNull: ['$items.category.name', { $ifNull: ['$items.category', ''] }],
            },
          ],
        },
      ],
    };

    const pipeline = [
      { $match: match },
      { $unwind: '$items' },
      {
        $addFields: {
          normalizedCategoryId: normalizedCategoryIdExpr,
          normalizedCategoryName: normalizedCategoryNameExpr,
          normalizedItemTotal: normalizedItemTotalExpr,
          normalizedQuantity: normalizedQuantityExpr,
          normalizedCompanyPrice: normalizedCompanyPriceExpr,
        },
      },
    ];

    if (requestedCategoryId) {
      pipeline.push({
        $match: { normalizedCategoryId: requestedCategoryId },
      });
    }

    pipeline.push(
      {
        $group: {
          _id: {
            category_id: '$normalizedCategoryId',
            category_name: '$normalizedCategoryName',
          },
          total_amount: { $sum: '$normalizedItemTotal' },
          item_quantity: { $sum: '$normalizedQuantity' },
          total_company_price: { $sum: '$normalizedCompanyPrice' },
          sales_count: { $sum: 1 },
        },
      },
      {
        $set: {
          // Profit = category total − aggregated company cost.
          sales_profit: {
            $subtract: ['$total_amount', '$total_company_price'],
          },
          // Option A: Avg.Sale = Total Sale / Total No. Of Item Sold
          sales_avg: {
            $cond: [
              { $gt: ['$item_quantity', 0] },
              { $divide: ['$total_amount', '$item_quantity'] },
              0,
            ],
          },
          category_id: '$_id.category_id',
          category_name: '$_id.category_name',
        },
      },
      {
        $sort: {
          total_amount: -1,
          item_quantity: -1,
          category_name: 1,
        },
      },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
      {
        $project: {
          total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] },
          list: '$data',
        },
      }
    );

    const [result] = await salesRepository.aggregate(pipeline, {
      SaleModel: Model,
    });
    const total = result?.total || 0;
    const list = Array.isArray(result?.list) ? result.list : [];

    return { total, list };
  },
  getSupplierSalesReportTableData: async (
    { match, skip, limit, requestedSupplierId },
    { SaleModel } = {}
  ) => {
    const Model = getModel(SaleModel);

    const normalizedItemTotalExpr = toNumberExpression({
      $ifNull: [
        '$items.total',
        {
          $ifNull: ['$items.total_amount', { $ifNull: ['$items.items_total', 0] }],
        },
      ],
    });

    const normalizedQuantityExpr = toNumberExpression({
      $ifNull: [
        '$items.quantity',
        {
          $ifNull: [
            '$items.item_quantity',
            {
              $ifNull: ['$items.qty', { $ifNull: ['$items.number_of_items', 0] }],
            },
          ],
        },
      ],
    });

    const normalizedCompanyPriceExpr = lineCostExpression();

    const normalizedSupplierIdExpr = {
      $let: {
        vars: {
          candidate: {
            $ifNull: [
              '$items.supplier_id',
              {
                $ifNull: [
                  '$items.supplierId',
                  {
                    $ifNull: ['$items.supplier._id', { $ifNull: ['$items.supplier.id', null] }],
                  },
                ],
              },
            ],
          },
        },
        in: {
          $cond: [
            {
              $and: [{ $ne: ['$$candidate', null] }, { $ne: ['$$candidate', ''] }],
            },
            {
              $cond: [
                { $eq: [{ $type: '$$candidate' }, 'objectId'] },
                { $toString: '$$candidate' },
                '$$candidate',
              ],
            },
            null,
          ],
        },
      },
    };

    const normalizedSupplierNameExpr = {
      $ifNull: [
        '$items.supplier_name',
        {
          $ifNull: [
            '$items.supplierName',
            {
              $ifNull: ['$items.supplier.name', { $ifNull: ['$items.supplier', ''] }],
            },
          ],
        },
      ],
    };

    const pipeline = [
      { $match: match },
      { $unwind: '$items' },
      {
        $addFields: {
          normalizedSupplierId: normalizedSupplierIdExpr,
          normalizedSupplierName: normalizedSupplierNameExpr,
          normalizedItemTotal: normalizedItemTotalExpr,
          normalizedQuantity: normalizedQuantityExpr,
          normalizedCompanyPrice: normalizedCompanyPriceExpr,
        },
      },
    ];

    if (requestedSupplierId) {
      pipeline.push({
        $match: { normalizedSupplierId: requestedSupplierId },
      });
    }

    pipeline.push(
      {
        $group: {
          _id: {
            supplier_id: '$normalizedSupplierId',
            supplier_name: '$normalizedSupplierName',
          },
          total_amount: { $sum: '$normalizedItemTotal' },
          item_quantity: { $sum: '$normalizedQuantity' },
          total_company_price: { $sum: '$normalizedCompanyPrice' },
          // Gross profit per line. Using the whole sale total on every line
          // counted a two-line bill's revenue twice.
          profit: {
            $sum: {
              $subtract: ['$normalizedItemTotal', '$normalizedCompanyPrice'],
            },
          },
          sales_avg: { $avg: '$normalizedItemTotal' },
          sales_count: { $sum: 1 },
        },
      },
      {
        $set: {
          sales_profit: '$profit',
          supplier_id: '$_id.supplier_id',
          supplier_name: '$_id.supplier_name',
        },
      },
      {
        $sort: {
          total_amount: -1,
          item_quantity: -1,
          supplier_name: 1,
        },
      },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
      {
        $project: {
          total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] },
          list: '$data',
        },
      }
    );

    const [result] = await salesRepository.aggregate(pipeline, {
      SaleModel: Model,
    });
    const total = result?.total || 0;
    const list = Array.isArray(result?.list) ? result.list : [];

    return { total, list };
  },
  getCustomerSalesReportTableData: async ({ match, skip, limit }, { SaleModel } = {}) => {
    const Model = getModel(SaleModel);

    const normalizedSaleTotalExpr = toNumberExpression({
      $ifNull: ['$sales_total', { $ifNull: ['$total', { $ifNull: ['$items_total', 0] }] }],
    });

    const normalizedRefundExpr = toNumberExpression({
      $ifNull: ['$items_return_total', { $ifNull: ['$return_total', 0] }],
    });

    const normalizedCustomerIdExpr = {
      $let: {
        vars: {
          candidate: {
            $ifNull: [
              '$customer',
              { $ifNull: ['$customer_id', { $ifNull: ['$customerId', null] }] },
            ],
          },
        },
        in: {
          $cond: [
            {
              $and: [{ $ne: ['$$candidate', null] }, { $ne: ['$$candidate', ''] }],
            },
            {
              $cond: [
                { $eq: [{ $type: '$$candidate' }, 'objectId'] },
                { $toString: '$$candidate' },
                '$$candidate',
              ],
            },
            null,
          ],
        },
      },
    };

    const pipeline = [
      { $match: match },
      {
        $addFields: {
          normalizedSaleTotal: normalizedSaleTotalExpr,
          normalizedRefundTotal: normalizedRefundExpr,
          normalizedCustomerId: normalizedCustomerIdExpr,
          normalizedCustomerName: {
            $ifNull: ['$customer_name', ''],
          },
          normalizedCustomerPhone: {
            $ifNull: ['$customer_phone', ''],
          },
        },
      },
      {
        $group: {
          _id: {
            customer_id: '$normalizedCustomerId',
            customer_name: '$normalizedCustomerName',
            customer_phone: '$normalizedCustomerPhone',
          },
          sales_payment: { $sum: '$normalizedSaleTotal' },
          refund_payment: { $sum: '$normalizedRefundTotal' },
          sales_count: { $sum: 1 },
          sales_avg: { $avg: '$normalizedSaleTotal' },
        },
      },
      {
        $sort: {
          sales_payment: -1,
          sales_count: -1,
          '_id.customer_name': 1,
        },
      },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
      {
        $project: {
          total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] },
          list: '$data',
        },
      },
    ];

    const [result] = await salesRepository.aggregate(pipeline, {
      SaleModel: Model,
    });
    const total = result?.total || 0;
    const list = Array.isArray(result?.list) ? result.list : [];

    return { total, list };
  },
  getItemGraphicalReportsData: async ({ match }, { SaleModel } = {}) => {
    const Model = getModel(SaleModel);

    const normalizedItemTotalExpr = toNumberExpression({
      $ifNull: [
        '$items.total',
        {
          $ifNull: ['$items.total_amount', { $ifNull: ['$items.items_total', 0] }],
        },
      ],
    });

    const normalizedQuantityExpr = toNumberExpression({
      $ifNull: [
        '$items.quantity',
        {
          $ifNull: [
            '$items.item_quantity',
            {
              $ifNull: ['$items.qty', { $ifNull: ['$items.number_of_items', 0] }],
            },
          ],
        },
      ],
    });

    const normalizedNameExpr = {
      $let: {
        vars: {
          base: {
            $ifNull: [
              '$items.name',
              {
                $ifNull: [
                  '$items.item_name',
                  {
                    $ifNull: [
                      '$items.title',
                      {
                        $cond: [
                          { $isArray: '$items.item' },
                          { $arrayElemAt: ['$items.item', 0] },
                          '$items.item',
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        in: {
          $cond: [
            {
              $and: [{ $ne: ['$$base', null] }, { $ne: ['$$base', ''] }],
            },
            {
              $cond: [
                { $eq: [{ $type: '$$base' }, 'object'] },
                {
                  $ifNull: ['$$base.name', { $ifNull: ['$$base.title', 'Unnamed Item'] }],
                },
                '$$base',
              ],
            },
            'Unnamed Item',
          ],
        },
      },
    };

    const pipeline = [
      { $match: match },
      { $unwind: '$items' },
      {
        $set: {
          normalizedItemTotal: normalizedItemTotalExpr,
          normalizedQuantity: normalizedQuantityExpr,
          normalizedItemName: normalizedNameExpr,
        },
      },
      {
        $group: {
          _id: '$normalizedItemName',
          total_amount: { $sum: '$normalizedItemTotal' },
          total_qty: { $sum: '$normalizedQuantity' },
        },
      },
      { $sort: { total_qty: -1, total_amount: -1, _id: 1 } },
      { $limit: 5 },
    ];

    const results = await salesRepository.aggregate(pipeline, {
      SaleModel: Model,
    });
    return results;
  },
  // Thin wrappers around legacy Sale model static report methods so that
  // controllers do not talk to the model layer directly. These preserve
  // the existing return shapes entirely and simply delegate the work to
  // the underlying model implementation.
  userReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.userReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  getUserGraphicalReports: async (data, { SaleModel } = {}) =>
    salesRepository.getUserGraphicalReports(data, {
      SaleModel: getModel(SaleModel),
    }),
  returnSalesReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.returnSalesReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  returnProductReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.returnProductReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  pendingProductReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.pendingProductReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  productBasedReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.productBasedReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  pendingSalesReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.pendingSalesReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  pendingCustomerReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.pendingCustomerReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  customerSaleDetailsPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.customerSaleDetailsPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  customerCategorySaleDetailsPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.customerCategorySaleDetailsPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  itemSaleDetailsPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.itemSaleDetailsPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  categorySaleDetailsPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.categorySaleDetailsPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  userSalesDetailsPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.userSalesDetailsPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  paymentSalesTransactionReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.paymentSalesTransactionReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  getPaymentSaleTypeReport: async (data, { SaleModel } = {}) =>
    salesRepository.getPaymentSaleTypeReport(data, {
      SaleModel: getModel(SaleModel),
    }),
  paymentReturnSalesTranscationReportTable: async (data, options, { SaleModel } = {}) =>
    salesRepository.paymentReturnSalesTranscationReportTable(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  getPaymentGraphicalReports: async (data, { SaleModel } = {}) =>
    salesRepository.getPaymentGraphicalReports(data, {
      SaleModel: getModel(SaleModel),
    }),
  // Generic helpers to fetch a sale by either Mongo _id or legacy sales_id,
  // used by email/print endpoints to keep DB access in the service layer.
  getSaleForReceipt: async (id, { SaleModel } = {}) => {
    if (!id) return null;
    return salesRepository.getSaleForReceipt(id, {
      SaleModel: getModel(SaleModel),
    });
  },
  getSaleForCustomerPrint: async (id, { SaleModel } = {}) => {
    if (!id) return null;
    return salesRepository.getSaleForCustomerPrint(id, {
      SaleModel: getModel(SaleModel),
    });
  },
  getSaleForPdf: async (id, { SaleModel } = {}) => {
    if (!id) return null;

    const Model = getModel(SaleModel);

    // Primary path: look up by MongoDB _id using the generic findById helper.
    let sale = await salesRepository.findById(id, {
      SaleModel: Model,
    });

    if (sale) {
      return sale;
    }

    // Backward-compatible fallback: allow legacy string-based sales_id
    // values that may be passed from older frontends.
    sale = await salesRepository.findOne({ sales_id: id }, null, { SaleModel: Model });

    return sale;
  },
  // Thin wrappers around additional legacy static helpers used by
  // the controller outside of the main reporting endpoints.
  returnSalesOrder: async (data, { SaleModel, deviceId } = {}) =>
    salesRepository.returnSalesOrder(data, {
      SaleModel: getModel(SaleModel),
      deviceId,
    }),
  exportSalesOrder: async (ids, { SaleModel } = {}) =>
    salesRepository.exportSalesOrder(ids, {
      SaleModel: getModel(SaleModel),
    }),
  getSalesDataChanges: async (from, { SaleModel } = {}) =>
    salesRepository.getSalesDataChanges(from, {
      SaleModel: getModel(SaleModel),
    }),
  getReturnSalesDetails: async (salesId, { SaleModel } = {}) =>
    salesRepository.getReturnSalesDetails(salesId, {
      SaleModel: getModel(SaleModel),
    }),
  getReturnPrintDetails: async (id, { SaleModel } = {}) =>
    salesRepository.getReturnPrintDetails(id, {
      SaleModel: getModel(SaleModel),
    }),
  returnProductViewPage: async (id, { SaleModel } = {}) =>
    salesRepository.returnProductViewPage(id, {
      SaleModel: getModel(SaleModel),
    }),
  getSalesAjaxList: async (query, { SaleModel } = {}) =>
    salesRepository.getSalesAjaxList(query, {
      SaleModel: getModel(SaleModel),
    }),
  getSaleQtyDetail: async (id, { SaleModel } = {}) =>
    salesRepository.getSaleQtyDetail(id, {
      SaleModel: getModel(SaleModel),
    }),
  sendDailySalesMail: async (input, { SaleModel, shopTransport } = {}) =>
    salesRepository.sendDailySalesMail(input, {
      SaleModel: getModel(SaleModel),
      shopTransport,
    }),
  salesPaymentCloseModel: async (data, { SaleModel } = {}) =>
    salesRepository.salesPaymentCloseModel(data, {
      SaleModel: getModel(SaleModel),
    }),
  fetchLastSaleModel: async (branchId, { SaleModel } = {}) =>
    salesRepository.fetchLastSaleModel(branchId, {
      SaleModel: getModel(SaleModel),
    }),
  itemExpiryReportPage: async (data, options, { SaleModel } = {}) =>
    salesRepository.itemExpiryReportPage(data, options, {
      SaleModel: getModel(SaleModel),
    }),
  salePage: async (filters, options, branchId, { SaleModel } = {}) =>
    salesRepository.salePage(filters, options, branchId, {
      SaleModel: getModel(SaleModel),
    }),
  // Keep existing methods to avoid breaking other routes (though createSale is superceded)
  createSale: async (data, { SaleModel } = {}) =>
    salesRepository.create(data, { SaleModel: getModel(SaleModel) }),
  listSales: async (filter, options, { SaleModel } = {}) =>
    salesRepository.paginate(filter, options, { SaleModel: getModel(SaleModel) }),
  getLegacySaleDetails: async (id, { SaleModel } = {}) =>
    salesRepository.getLegacyDetails(id, { SaleModel: getModel(SaleModel) }),
  deleteSales: async (ids, { SaleModel, requireRecycleBackup } = {}) =>
    salesRepository.deleteSales(ids, {
      SaleModel: getModel(SaleModel),
      ...(requireRecycleBackup ? { requireRecycleBackup: true } : {}),
    }),
};
