const { reportableSales } = require('../helpers/reportable-sales');
// src/controllers/sales_controller.js
const BaseController = require('./base.controller');
const { clientIp } = require('../utils/client-ip');
const { currentConnection } = require('../db/tenant-context');
const Sale = require('../models/sale.model');
const BaseModel = require('../models/base.model');
const mongoose = require('mongoose');
const salesService = require('../services/sale.service');
const DebtService = require('../services/debt.service');

/* The branch doc carries the shop's own SMTP settings; owner rule is
   theirs first, the platform chain otherwise. Absent config, bad ids
   and read errors all fall through to the platform transport. */
async function shopTransportOf(req) {
  const { resolveConfiguredShopTransport } = require('../utils/email');
  let branchDoc = null;
  try {
    const { ObjectId } = require('mongodb');
    const bid = req.user && req.user.branch_id;
    if (bid && req.db && ObjectId.isValid(String(bid))) {
      branchDoc = await req.db.collection('branches').findOne({ _id: new ObjectId(String(bid)) });
    }
  } catch (e) {
    /* platform chain covers it */
  }
  /* The branch rides along: the mail LAYOUT needs the same document the
     transport was resolved from (shop name, address, white-label). */
  return { ...(await resolveConfiguredShopTransport(branchDoc)), branch: branchDoc };
}
const ItemService = require('../services/item.service');
const { createActivityLog } = require('../utils/activityLogger');
const { AuditService, AUDIT_EVENTS } = require('../services/audit.service');
const { canPos } = require('../utils/pos-permission.util');
const { isApprovedFor } = require('../utils/approval-token.util');
const sessionFilterUtil = require('../utils/session-filter.util');
const { SALE_STATUS } = require('../constants');
const {
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  GRAPH_ALLOWED_SALE_PROCESSES,
} = require('../constants/sales.constants');
const { safeJsonParse, formatDate } = require('../utils/helpers');
const {
  roundToTwo,
  numberOrZero,
  normalizeToMongooseId,
  resolveBranchId,
  parseSaleDate,
  normalizeRangeDate,
  calculateInstantMetrics,
  normalizeSaleItems,
  resolveTimeZonePreference,
  parseSalesFilters,
  parseBranchIdsFromRequest,
  formatSaleListEntry,
  formatDateForTimezone,
} = require('../helpers/sales.helper');
const path = require('path');
const fs = require('fs');
const { getRequestDeviceId } = require('../utils/device-id.util');

/*
 * The sale screen sends several of these fields as DISPLAY text, straight out
 * of the totals row - "1,459.00", not 1459. Number.parseFloat stops at the
 * thousands separator and returns 1, which made a 34-rupee discount look like
 * 3400% of the bill and tripped the manager-approval cap on every discounted
 * sale over a thousand rupees. The role's discount cap was therefore broken
 * for exactly the bills big enough to need it.
 *
 * So: strip anything that is not part of a number, then work out which
 * separator is the decimal one. The rightmost of '.' and ',' wins when both
 * appear ("1,459.00" and "1.459,00" both parse); a lone comma is a thousands
 * group only when every group is three digits, otherwise it is a decimal
 * comma. NaN is preserved for genuinely non-numeric text because
 * auditFirstNumber relies on it to fall through to the next candidate field.
 */
const parseAuditNumber = (value) => {
  if (typeof value === 'number') return value;
  let s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return NaN;
  s = s.replace(/[^\d.,-]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  return Number.parseFloat(s);
};
const auditNumber = (value) => {
  const parsed = parseAuditNumber(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const auditFirstNumber = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined || value === '' || value === 'undefined') continue;
    const parsed = parseAuditNumber(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const auditItems = (payload) => {
  let items = payload?.items || [];
  if (typeof items === 'string') items = safeJsonParse(items, []);
  return Array.isArray(items) ? items : [];
};

const auditItemId = (item) => String(item?.item_id?._id || item?.item_id || item?._id || '');
const auditItemPrice = (item) =>
  auditFirstNumber(
    item?.sale_inline_item_price,
    item?.item_price_total,
    item?.item_price,
    item?.selling_price
  );
const auditItemDiscount = (item) => ({
  amount: auditFirstNumber(
    item?.sale_inline_discount_value,
    item?.item_discount,
    item?.discount_amount
  ),
  percentage: auditFirstNumber(
    item?.sale_inline_discount_pervalue,
    item?.item_discount_percentage,
    item?.discount_percentage
  ),
});

// Best-effort percent estimate of a sale's manual discount, for the role's
// discount_max_percent cap: the larger of (total discount amount / subtotal)
// and any raw percent entered on a line or the extra discount. Mirrors the
// till's estimate (sales.js _manualDiscountPct).
const estimateManualDiscountPct = (payload) => {
  const subtotal = auditFirstNumber(payload?.sales_sub_total, payload?.sales_total);
  let amount = 0;
  let maxPct = 0;
  auditItems(payload).forEach((item) => {
    const d = auditItemDiscount(item);
    amount += d.amount;
    if (d.percentage > maxPct) maxPct = d.percentage;
  });
  const extra = auditNumber(payload?.extra_discount);
  if (extra > 0) {
    if ((payload?.extra_discount_type || 'price') === 'percent') {
      if (extra > maxPct) maxPct = extra;
    } else {
      amount += extra;
    }
  }
  if (subtotal > 0) {
    const pctOfBill = (amount / subtotal) * 100;
    if (pctOfBill > maxPct) maxPct = pctOfBill;
  }
  return maxPct;
};

const collectSaleAuditChanges = async (payload, existingSale = null) => {
  const incoming = auditItems(payload);
  const oldItems = auditItems(existingSale);
  const oldById = new Map(oldItems.map((item) => [auditItemId(item), item]));
  const priceChanges = [];
  const discounts = [];

  incoming.forEach((item) => {
    const id = auditItemId(item);
    const oldItem = oldById.get(id);
    const oldPrice = oldItem
      ? auditItemPrice(oldItem)
      : auditFirstNumber(item?.audit_original_price);
    const newPrice = auditItemPrice(item);
    if (oldPrice > 0 && Math.abs(oldPrice - newPrice) > 0.0001) {
      priceChanges.push({
        type: 'price_change',
        item_id: id,
        item_name: item.item_name || oldItem?.item_name || '',
        old_price: oldPrice,
        new_price: newPrice,
      });
    }

    const newDiscount = auditItemDiscount(item);
    const oldDiscount = oldItem ? auditItemDiscount(oldItem) : { amount: 0, percentage: 0 };
    if (
      (newDiscount.amount > 0 || newDiscount.percentage > 0) &&
      (newDiscount.amount !== oldDiscount.amount ||
        newDiscount.percentage !== oldDiscount.percentage)
    ) {
      discounts.push({
        type: 'inline_discount',
        discount_type: newDiscount.percentage > 0 ? 'percent' : 'price',
        item_id: id,
        item_name: item.item_name || oldItem?.item_name || '',
        old_value: newDiscount.percentage > 0 ? oldDiscount.percentage : oldDiscount.amount,
        new_value: newDiscount.percentage > 0 ? newDiscount.percentage : newDiscount.amount,
        old_amount: oldDiscount.amount,
        new_amount: newDiscount.amount,
        old_percentage: oldDiscount.percentage,
        new_percentage: newDiscount.percentage,
      });
    }
  });

  const oldExtra = auditNumber(existingSale?.extra_discount);
  const newExtra = auditNumber(payload?.extra_discount);
  if (newExtra > 0 && newExtra !== oldExtra) {
    discounts.push({
      type: 'extra_discount',
      old_value: oldExtra,
      new_value: newExtra,
      discount_type: payload?.extra_discount_type || existingSale?.extra_discount_type || 'price',
    });
  }
  return { priceChanges, discounts };
};

// Sensitive sale actions also belong in the canonical accountability trail
// (audit_log) that the shift / payout reports read - separate from the activity
// feed written by createActivityLog. Map the activity action -> AUDIT_EVENTS.
const SALE_AUDIT_EVENT = {
  delete: AUDIT_EVENTS.SALE_VOID,
  cancel: AUDIT_EVENTS.SALE_VOID,
  refund: AUDIT_EVENTS.SALE_REFUND,
  discount: AUDIT_EVENTS.DISCOUNT_APPLIED,
  price_change: AUDIT_EVENTS.PRICE_OVERRIDE,
};

const writeSaleAudit = async (req, action, entityId, description, changes) => {
  const user = req.user || {};
  await createActivityLog({
    user: user._id,
    userName: user.username || user.name || user.email || 'System',
    action,
    entity: 'sale',
    entityId,
    description,
    changes,
    branch: resolveBranchId(user, req.session) || BaseModel.currentBranch,
    license: user.license || user.licenseId || BaseModel.license,
    ipAddress: clientIp(req),
    userAgent: typeof req.get === 'function' ? req.get('user-agent') : req.headers?.['user-agent'],
  });

  // Mirror sensitive actions into the append-only accountability trail. Actor +
  // tenant are passed explicitly (same source as the activity log) so this does
  // not depend on the per-request context being set. Fail-safe: record() never
  // throws, so an audit failure can never break the sale operation.
  const event = SALE_AUDIT_EVENT[action];
  if (event) {
    await new AuditService().record(event, {
      entity: 'sale',
      entity_id: entityId,
      actor_user_id: user._id,
      actor_name: user.username || user.name || user.email || null,
      license: user.license || user.licenseId || BaseModel.license,
      branch_id: resolveBranchId(user, req.session) || BaseModel.currentBranch,
      amount: changes && typeof changes.total === 'number' ? changes.total : undefined,
      reason: description,
      details: changes && typeof changes === 'object' ? changes : undefined,
    });
  }
};

const duplicateSaleData = (sale) => ({
  _id: sale._id,
  sales_id: sale._id,
  sale_number: sale.sales_id || '',
  duplicate: true,
  print: false,
  mail: false,
  waring: 'success',
  name: sale.customer_name || '',
  phone: sale.customer_phone || '',
  customer_balance: 0,
  country_sort: sale.country_sort || 'in',
});

const findSaleByBillingTransaction = async (license, transactionId) => {
  const query = Sale.findOne({
    license,
    billing_transaction_id: transactionId,
  });
  return query && typeof query.lean === 'function' ? query.lean() : query;
};

const dejavuSansCondensedPath = path.join(
  __dirname,
  '../../../Api/src/vendor/mpdf/mpdf/ttfonts/DejaVuSansCondensed.ttf'
);
const windowsFontDir =
  process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts') : '';
const reportUnicodeFontPath = windowsFontDir ? path.join(windowsFontDir, 'segoeui.ttf') : '';
const reportUnicodeBoldFontPath = windowsFontDir ? path.join(windowsFontDir, 'segoeuib.ttf') : '';

class SalesController extends BaseController {
  constructor() {
    super(Sale);
    this.model = Sale;
    this.itemService = new ItemService();
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.getAll = this.getAll.bind(this);
    this.dailySalesReports = this.dailySalesReports.bind(this);
    this.salesGraphicalReports = this.salesGraphicalReports.bind(this);
    this.salesReports = this.salesReports.bind(this);
    this.salesSummaryReports = this.salesSummaryReports.bind(this);
    this.instantSalesReports = this.instantSalesReports.bind(this);
    this.instantSaleDetails = this.instantSaleDetails.bind(this);
    this.categorySalesReportTable = this.categorySalesReportTable.bind(this);
    this.getLatestSales = this.getLatestSales.bind(this);
    this.holdSale = this.holdSale.bind(this);
    this.delete = this.delete.bind(this);
    this.resolveBranchContext = this.resolveBranchContext.bind(this);
  }

  /**
   * Set branch / license / user context on BaseModel so that legacy-
   * style static model methods (sales_model.php parity) can read the same
   * globals as the PHP code did.
   */
  setRequestContext(req) {
    const user = req.user || {};
    const sessionBranch =
      req.tenantContext?.branchId || req.session?.selectedBranchId || req.session?.branch_id;
    const branchAccessEntry = Array.isArray(user.branch_access) ? user.branch_access[0] : null;

    const branchParam =
      sessionBranch ||
      req.query?.branch_id ||
      req.query?.branch ||
      req.body?.branch_id ||
      req.body?.branch ||
      user.branch_id ||
      (user.branch && (user.branch._id || user.branch.id)) ||
      user.default_branch_id ||
      (branchAccessEntry && (branchAccessEntry.branch_id || branchAccessEntry._id)) ||
      null;

    if (branchParam) {
      const raw = Array.isArray(branchParam) ? branchParam[0] : branchParam;
      if (raw instanceof mongoose.Types.ObjectId) {
        BaseModel.currentBranch = raw;
      } else if (mongoose.Types.ObjectId.isValid(String(raw))) {
        BaseModel.currentBranch = new mongoose.Types.ObjectId(String(raw));
      } else {
        BaseModel.currentBranch = raw;
      }
    }

    const licenseParam =
      req.tenantContext?.licenseId ||
      user.license ||
      user.license_id ||
      req.query?.license_id ||
      req.body?.license_id ||
      null;

    if (licenseParam) {
      if (licenseParam instanceof mongoose.Types.ObjectId) {
        BaseModel.license = licenseParam;
      } else if (mongoose.Types.ObjectId.isValid(String(licenseParam))) {
        BaseModel.license = new mongoose.Types.ObjectId(String(licenseParam));
      } else {
        BaseModel.license = licenseParam;
      }
    }

    if (user._id) {
      if (user._id instanceof mongoose.Types.ObjectId) {
        BaseModel.loggedUser = user._id;
      } else if (mongoose.Types.ObjectId.isValid(String(user._id))) {
        BaseModel.loggedUser = new mongoose.Types.ObjectId(String(user._id));
      } else {
        BaseModel.loggedUser = user._id;
      }
    }

    // Prefer login identifier (username/email) for audit trails like stock logs
    const userName = user.username || user.email || user.name;
    if (userName) {
      BaseModel.loggedUserName = userName;
    }

    BaseModel.loggedUserDetails = user;
  }

  async ensureContext(req) {
    this.setRequestContext(req);
  }

  resolveBranchContext(req) {
    const branchId = resolveBranchId(req.user, req.session) || BaseModel.currentBranch;

    let branchName = req.session?.selectedBranchName || null;
    if (!branchName) {
      const branchCandidate = req.user?.branch;
      if (branchCandidate && typeof branchCandidate === 'object') {
        branchName =
          branchCandidate.branch_name || branchCandidate.name || branchCandidate.store_name || null;
      }
    }

    const normalizedBranchId =
      branchId instanceof mongoose.Types.ObjectId
        ? branchId
        : branchId && mongoose.Types.ObjectId.isValid(String(branchId))
          ? new mongoose.Types.ObjectId(String(branchId))
          : null;

    return {
      branch_id: normalizedBranchId,
      branch_name: branchName,
    };
  }

  // Shared internal implementation for creating or holding a sale (PHP salesInsertUpdate parity)
  // A manual discount (line or extra) detected on this sale is a restricted
  // till action. If this user can't apply discounts on their own, a valid
  // manager-approval token is required - the same server-side gate as
  // void/refund. Fails open for unconfigured users so existing tills are never
  // blocked.
  discountNeedsApproval(req, payload, auditChanges) {
    if (!auditChanges || !Array.isArray(auditChanges.discounts) || !auditChanges.discounts.length) {
      return false;
    }
    if (canPos(req.user, 'discount_apply')) {
      // Allowed to discount - but the role may cap how deep (0 = no cap).
      const pos = (req.user && req.user.access && req.user.access.pos) || {};
      const cap = Number(pos.discount_max_percent) || 0;
      if (cap <= 0 || estimateManualDiscountPct(payload) <= cap) return false;
    }
    const token =
      (payload && payload.approval_token) || (req.body && req.body.approval_token) || null;
    return !isApprovedFor(token, 'discount_apply', req.user && req.user._id);
  }

  canOverrideCounterPrice(req, payload = {}) {
    if (!req.user?._id) return false;
    const token = payload.price_override_approval_token || payload.approval_token;
    return (
      canPos(req.user, 'price_override') || isApprovedFor(token, 'price_override', req.user._id)
    );
  }

  async buildSaleContext(req) {
    const { branch_id, branch_name } = this.resolveBranchContext(req);
    const user = req.user || {};
    return salesService.enrichSaleContext({
      branchId: branch_id,
      branchName: branch_name,
      licenseId: BaseModel.license || user.license || user.license_id,
      userId: user._id,
      userName: user.username || user.name || 'System',
      deviceId: getRequestDeviceId(req),
      salesPrefix: 'INV',
      stockManagement: true,
      stockLogStatus: true,
      roundOff: true,
      branchSettings: {},
      branchState: '',
      seatingProtocol: true,
    });
  }

  async businessDiscountDecision(req, res, next) {
    try {
      await this.ensureContext(req);
      if (
        req.params.requestId === 'capabilities' &&
        req.method === 'GET' &&
        !require('../services/business-checkout-transport').checkoutMode()
      )
        return res.json({
          data: {
            enabled: false,
            branchId: String(this.resolveBranchContext(req).branch_id || ''),
            requesterId: String(req.user?._id || ''),
          },
        });
      const context = await this.buildSaleContext(req);
      const decisions = require('../services/business-checkout-decisions').createCheckoutDecisions(
        await BaseModel.getDb()
      );
      let record;
      if (req.params.operationId && req.method === 'GET') {
        record = await decisions.lookup(context, req.user, req.params.operationId);
      } else if (req.params.requestId === 'capabilities' && req.method === 'GET') {
        record = await decisions.capabilities(context, req.user);
      } else if (req.params.requestId === 'recoveries' && req.method === 'GET') {
        record = await decisions.recoveries(
          context,
          req.user,
          req.query?.cursor,
          req.query?.requests === '1'
        );
      } else if (req.method === 'GET') {
        record = await decisions.read(context, req.user, req.params.requestId);
      } else if (req.params.requestId) {
        record = await decisions.cancel(context, req.user, req.params.requestId);
      } else {
        record = await decisions.request(context, req.user, req.body?.sale, req.body?.reason);
      }
      return res.json({ data: record });
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({ error: { code: error.code } });
      next(error);
    }
  }

  async createOrHoldInternal(
    req,
    res,
    next,
    { processOverride = null, successMessage = SUCCESS_MESSAGES.SALE_ADDED } = {}
  ) {
    try {
      let payload = req.createSalePayload || req.body;
      if (typeof payload === 'string') {
        payload = safeJsonParse(payload, req.body);
      } else if (payload && typeof payload.data === 'string') {
        // Handle "data" wrapper (legacy PHP structure)
        payload = safeJsonParse(payload.data, payload);
      }

      await this.ensureContext(req); // Ensure BaseModel globals are set
      const user = req.user || {};
      const billingTransactionId = String(payload.billing_transaction_id || '').trim();
      if (billingTransactionId) {
        payload.billing_transaction_id = billingTransactionId.slice(0, 128);
        const existingSale = await findSaleByBillingTransaction(
          BaseModel.license || user.license || user.license_id,
          payload.billing_transaction_id
        );
        if (existingSale) {
          return this.success(
            res,
            duplicateSaleData(existingSale),
            'Sale already saved. Duplicate billing prevented.',
            200
          );
        }
      }

      // Build Context for Service
      const context = await this.buildSaleContext(req);
      context.allowCounterPriceOverride = this.canOverrideCounterPrice(req, payload);

      // Delegate core Add / Hold business logic to salesService.processSale,
      // which is a line-by-line port of PHP sales_model::salesInsertUpdate.
      const processValue =
        processOverride != null && processOverride !== undefined ? processOverride : 'Add';
      const auditChanges =
        processValue === 'Hold'
          ? { priceChanges: [], discounts: [] }
          : await collectSaleAuditChanges(payload);

      if (payload.business_decision_id && processValue !== 'Add') {
        return res.status(422).json({ error: { code: 'unsupported_discount_combination' } });
      }
      if (
        processValue !== 'Hold' &&
        !payload.business_decision_id &&
        this.discountNeedsApproval(req, payload, auditChanges)
      ) {
        return this.error(res, ERROR_MESSAGES.DISCOUNT_NEEDS_APPROVAL, 403);
      }

      let decisionOptions;
      if (payload.business_decision_id) {
        const decisions =
          require('../services/business-checkout-decisions').createCheckoutDecisions(
            await BaseModel.getDb()
          );
        decisionOptions = { beforeCommit: await decisions.gate(context, user, payload) };
      }
      const result = decisionOptions
        ? await salesService.processSale(payload, '', processValue, context, decisionOptions)
        : await salesService.processSale(payload, '', processValue, context);

      if (!result || typeof result !== 'object') {
        return this.error(res, ERROR_MESSAGES.FAILED_TO_SAVE_SALE_UNEXPECTED, 500);
      }

      if (result.status !== true) {
        if (decisionOptions && result.decisionError) {
          return res
            .status(result.decisionError.status)
            .json({ error: { code: result.decisionError.code } });
        }
        if (billingTransactionId && /duplicate key|E11000/i.test(result.message || '')) {
          const existingSale = await findSaleByBillingTransaction(
            BaseModel.license || user.license || user.license_id,
            payload.billing_transaction_id
          );
          if (existingSale) {
            return this.success(
              res,
              duplicateSaleData(existingSale),
              'Sale already saved. Duplicate billing prevented.',
              200
            );
          }
        }
        // Mirror PHP controller behaviour: bubble up model message and data
        // when salesInsertUpdate fails.
        return this.error(res, result.message || ERROR_MESSAGES.SALES_NOT_ADDED, 400, result.data);
      }

      const message =
        processValue === 'Hold'
          ? 'Sales has been successfully hold'
          : result.message || successMessage;

      const auditSaleId =
        result.data?.sale_number ||
        result.data?.sales_id ||
        result.data?.sale_id ||
        result.data?._id ||
        result.data?.id ||
        'new-sale';
      if (auditChanges.priceChanges.length) {
        await writeSaleAudit(
          req,
          'price_change',
          auditSaleId,
          'Item price changed during sale',
          auditChanges.priceChanges
        );
      }
      if (auditChanges.discounts.length) {
        await writeSaleAudit(
          req,
          'discount',
          auditSaleId,
          'Discount applied during sale',
          auditChanges.discounts
        );
      }

      return this.success(res, result.data, message, 200);
    } catch (error) {
      if (Number.isInteger(error.status) && typeof error.code === 'string')
        return res.status(error.status).json({ error: { code: error.code } });
      next(error);
    }
  }

  // Create a new sale
  async create(req, res, next) {
    return this.createOrHoldInternal(req, res, next, {
      processOverride: null,
      successMessage: SUCCESS_MESSAGES.SALE_ADDED,
    });
  }

  async update(req, res, next) {
    try {
      if (!this.checkPermission('sales', 'write', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED_UPDATE_SALES, 403);
      }

      const { id } = req.params;
      let payload = req.updateSalePayload;
      let normalizedItems = req.updateSaleItems;

      if (!payload) {
        payload = req.body;
        if (typeof payload === 'string') {
          payload = safeJsonParse(payload, null);
        }

        if (!payload || typeof payload !== 'object') {
          return this.error(res, ERROR_MESSAGES.INVALID_SALE_PAYLOAD, 400);
        }

        let rawItems = payload.items;
        if (typeof rawItems === 'string') {
          rawItems = safeJsonParse(rawItems, []);
        }

        normalizedItems = normalizeSaleItems(rawItems);

        if (!normalizedItems.length) {
          return this.error(res, ERROR_MESSAGES.AT_LEAST_ONE_VALID_SALE_ITEM_REQUIRED, 400);
        }
      }

      await this.ensureContext(req);
      const { branch_id, branch_name } = this.resolveBranchContext(req);
      const user = req.user || {};

      let context = {
        branchId: branch_id,
        branchName: branch_name,
        licenseId: BaseModel.license || user.license || user.license_id,
        userId: user._id,
        userName: user.username || user.name || 'System',
        deviceId: getRequestDeviceId(req),
        salesPrefix: 'INV',
        stockManagement: true,
        stockLogStatus: true,
        roundOff: true,
        branchSettings: {},
        branchState: '',
      };

      if (!branch_id) {
        return this.error(res, ERROR_MESSAGES.BRANCH_CONTEXT_REQUIRED_UPDATE, 400);
      }

      const SaleModel = this.model || Sale;
      // Verify the sale exists via the service helper to keep DB access
      // out of the controller layer while preserving the 404 behaviour.
      const existingSale = await salesService.getSaleById(id, { SaleModel });

      if (!existingSale) {
        return this.error(res, ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 404);
      }

      const auditChanges = await collectSaleAuditChanges(payload, existingSale);

      if (this.discountNeedsApproval(req, payload, auditChanges)) {
        return this.error(res, ERROR_MESSAGES.DISCOUNT_NEEDS_APPROVAL, 403);
      }

      // Delegate Edit business logic to salesService.processSale (PHP
      // salesInsertUpdate parity for $process = 'Edit').
      // Enrich the context with branch-specific settings via the service
      context = await salesService.enrichSaleContext(context);
      context.allowCounterPriceOverride = this.canOverrideCounterPrice(req, payload);

      const result = payload.paid_bill_correction
        ? await require('../services/paid-bill-edit').amend(req, payload, context)
        : await salesService.processSale(payload, id, 'Edit', context);

      if (!result || typeof result !== 'object') {
        return this.error(res, ERROR_MESSAGES.FAILED_TO_UPDATE_SALE_UNEXPECTED, 500);
      }

      if (result.status !== true) {
        return this.error(
          res,
          result.message || ERROR_MESSAGES.SALES_NOT_UPDATED,
          400,
          result.data
        );
      }

      if (auditChanges.priceChanges.length) {
        await writeSaleAudit(
          req,
          'price_change',
          existingSale.sales_id || id,
          'Item price changed while editing sale',
          auditChanges.priceChanges
        );
      }
      if (auditChanges.discounts.length) {
        await writeSaleAudit(
          req,
          'discount',
          existingSale.sales_id || id,
          'Discount changed while editing sale',
          auditChanges.discounts
        );
      }

      // PHP sales.php::edit() forwards the model message directly.
      return this.success(res, result.data, result.message || SUCCESS_MESSAGES.SALE_UPDATED, 200);
    } catch (error) {
      // Paid-bill correction uses branch-access errors with a numeric status.
      // Return expected refusals to the till instead of masking them as a 500.
      const status = error.statusCode || error.status;
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return this.error(res, error.message, status);
      }
      next(error);
    }
  }

  // Get all sales with filtering and pagination (legacy frontend-compatible)
  async getAll(req, res, next) {
    try {
      if (!this.checkPermission('sales', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED_VIEW_SALES, 403);
      }

      await this.ensureContext(req);

      const { page = 1, limit = 10, filters: rawFilters } = req.query;

      const numericLimit = Math.max(1, parseInt(limit, 10) || 10);
      const numericPage = Math.max(1, parseInt(page, 10) || 1);

      const SaleModel = this.model || Sale;

      // Parse legacy filters coming from the frontend (date range, sale_process, etc.)
      const parsedFilters = parseSalesFilters(rawFilters || {});

      // Apply session filtering to sales filters if user has permission
      const filteredSalesFilters = await sessionFilterUtil.applySessionFilterToSalesFilters(
        req,
        parsedFilters
      );

      // Apply branch scoping similar to PHP behaviour
      const { validBranchIds } = parseBranchIdsFromRequest(req);
      const filter = { ...filteredSalesFilters };
      if (validBranchIds.length) {
        // PHP sales list historically filters on branch_id; mirror that
        // here so we correctly match both legacy PHP documents (which
        // only had branch_id) and new Node sales (where branch_id is
        // synced from branch in the pre-save hook).
        filter.branch_id = { $in: validBranchIds };
      }

      // License scoping: in the PHP code, almost all sales queries
      // include the current license as part of the match filter. The
      // BaseModel.license value is set in ensureContext, so
      // enforce the same constraint here to avoid cross-license or
      // cross-branch bleed-through.
      if (BaseModel.license) {
        filter.license = BaseModel.license;
      }

      // By default, hide cancelled sales in history unless explicitly requested
      if (!Object.prototype.hasOwnProperty.call(filter, 'status')) {
        filter.status = { $ne: SALE_STATUS.CANCELLED };
      }

      // Sort the same sale timestamp shown in Sales History, including time of day.
      const options = {
        page: numericPage,
        limit: numericLimit,
        sortBy: 'date:desc,_id:desc',
      };

      /*
       * Sort, whitelisted (owner: highest bill, most items, date). Only
       * these names reach the query - a raw client-supplied field would
       * sort by anything on the document.
       */
      const SALE_SORTS = {
        recent: 'created_date:desc,_id:desc',
        date_desc: 'date:desc,_id:desc',
        date_asc: 'date:asc,_id:asc',
        updated_desc: 'updated_date:desc,_id:desc',
        total_desc: 'sales_total:desc,_id:desc',
        total_asc: 'sales_total:asc,_id:desc',
        items_desc: 'number_of_items:desc,_id:desc',
      };
      if (SALE_SORTS[req.query.sort]) {
        options.sortBy = SALE_SORTS[req.query.sort];
      }

      filter.$and = [
        ...(filter.$and || []),
        ...require('../helpers/sales-list-criteria')(req.query, req.user),
      ];
      if (!filter.$and.length) delete filter.$and;
      const result = await salesService.listSales(filter, options, { SaleModel });

      const docs = Array.isArray(result?.results) ? result.results : [];
      const list = docs.map((doc) => formatSaleListEntry(doc)).filter(Boolean);

      const total = typeof result?.totalResults === 'number' ? result.totalResults : list.length;
      const totalPages =
        typeof result?.totalPages === 'number' && result.totalPages > 0
          ? result.totalPages
          : Math.max(1, Math.ceil(total / numericLimit));

      const payload = {
        list,
        current_page: result?.page || numericPage,
        per_page: result?.limit || numericLimit,
        total_pages: totalPages,
        total,
      };

      if (req.query.include_summary === 'true') {
        // Reuse the fully scoped and filtered history query, including session restrictions.
        payload.summary = await require('../services/sales-history-summary')(
          SaleModel,
          filter
        ).catch(() => null);
      }

      return this.success(res, payload, SUCCESS_MESSAGES.SALES_RETRIEVED, 200);
    } catch (error) {
      next(error);
    }
  }

  async getOne(req, res, next) {
    try {
      if (!this.checkPermission('sales', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED_VIEW_SALES, 403);
      }

      const { id } = req.params;

      await this.ensureContext(req);

      const SaleModel = this.model || Sale;
      const result = await salesService.getLegacySaleDetails(id, { SaleModel });

      if (
        result &&
        typeof result === 'object' &&
        Object.prototype.hasOwnProperty.call(result, 'status')
      ) {
        if (result.status === true && result.data != null) {
          /*
           * A bill and the customer's account are one story. Attach the
           * current debt position for this sale (paid at the counter, every
           * later collection allocated to it, and what is still owed) so the
           * bill can show the payment history under its total and link to the
           * full statement. Failure to read the ledger never hides the bill.
           */
          try {
            const sale = result.data;
            const customerId = sale.customer_id || sale.customer;
            if (customerId) {
              const branchIds = BaseModel.currentBranch ? [BaseModel.currentBranch] : [];
              const statement = await new DebtService().partyStatement(
                'customer',
                String(customerId),
                branchIds
              );
              if (statement && statement.status) {
                const invoice = (statement.data.invoices || []).find(
                  (row) => String(row.id) === String(sale._id)
                );
                sale.debt_account = {
                  party_type: 'customer',
                  party_id: String(customerId),
                  party_name: statement.data.party?.name || sale.customer_name || '',
                  outstanding: Math.round((Number(statement.data.outstanding) || 0) * 100) / 100,
                  invoice_total: invoice
                    ? Math.round((Number(invoice.total) || 0) * 100) / 100
                    : null,
                  invoice_remaining: invoice
                    ? Math.round((Number(invoice.remaining) || 0) * 100) / 100
                    : null,
                  paid_at_sale: invoice
                    ? Math.round((Number(invoice.paid_at_sale) || 0) * 100) / 100
                    : null,
                  paid_later: invoice
                    ? Math.round((Number(invoice.paid_later) || 0) * 100) / 100
                    : 0,
                  payments: (statement.data.payments || [])
                    .map((payment) => {
                      const allocation = (payment.allocations || []).find(
                        (row) => String(row.record_id) === String(sale._id)
                      );
                      if (!allocation) return null;
                      return {
                        date: payment.date,
                        amount: Math.round((Number(allocation.amount) || 0) * 100) / 100,
                        note: payment.note || '',
                        reference: payment.reference || '',
                      };
                    })
                    .filter(Boolean),
                };
              }
            }
          } catch (error) {
            console.error('Error attaching customer debt to sale:', error.message);
          }
          return this.success(res, result.data, SUCCESS_MESSAGES.GET_SUCCESSFULLY);
        }
        return this.error(res, ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 404, result);
      }

      if (!result) {
        return this.error(res, ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 404);
      }

      return this.success(res, result, SUCCESS_MESSAGES.GET_SUCCESSFULLY);
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      if (String(req.user?.usertype || req.user?.role || '').toLowerCase() !== 'super_admin') {
        return this.error(res, 'Only super admins can hard delete sales', 403);
      }
      if (!this.checkPermission('sales', 'delete', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED_DELETE_SALES, 403);
      }

      // A sale delete is a void. If this user can't void on their own, require a
      // valid manager-approval token (minted by /authorizations/verify-pin|card).
      // Fails open for unconfigured users so existing tills are never blocked.
      if (!canPos(req.user, 'void_sale')) {
        const approved = isApprovedFor(
          req.body && req.body.approval_token,
          'void_sale',
          req.user && req.user._id
        );
        if (!approved) {
          return this.error(res, 'Voiding a sale needs manager approval', 403);
        }
      }

      // Ensure BaseModel branch / license / user context is set for
      // deleteSaleCollectionData side-effects (stock, wallet, logs, etc.).
      await this.ensureContext(req);

      const rawBody = req.body || {};

      const deleteSettings = await salesService.getBranchById(BaseModel.currentBranch);
      if (!deleteSettings || ![true, 'true'].includes(deleteSettings.allow_sale_hard_delete)) {
        return this.error(res, 'Hard delete of sales is disabled in Sales settings', 403);
      }
      if (![true, 'true'].includes(deleteSettings.module_recyclebin_enable)) {
        return this.error(res, 'Enable Recycle Bin before deleting sales', 403);
      }

      const extractIds = (body) => {
        if (!body) return [];

        // Most common case (current frontend): { data: ["<_id>", ...] }
        if (Array.isArray(body.data)) {
          return body.data;
        }

        // data might be a JSON stringified array
        if (typeof body.data === 'string') {
          const trimmed = body.data.trim();
          if (trimmed) {
            try {
              const parsed = JSON.parse(trimmed);
              if (Array.isArray(parsed)) return parsed;
            } catch {
              // fall through to legacy handling
            }
          }
        }

        // Legacy shapes: ids / sales_ids / sale_ids / selected_ids / selected
        const { ids, sales_ids, sale_ids, selected_ids, selected } = body;
        let rawIds = ids || sales_ids || sale_ids || selected_ids || selected;

        if (typeof rawIds === 'string') {
          const parsed = safeJsonParse(rawIds, null);
          if (Array.isArray(parsed)) {
            rawIds = parsed;
          } else {
            rawIds = rawIds
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
          }
        } else if (rawIds && typeof rawIds === 'object' && !Array.isArray(rawIds)) {
          rawIds = Object.values(rawIds);
        }

        if (Array.isArray(rawIds)) {
          return rawIds;
        }

        // Fallback: body itself may be an array or an object like
        // { "0": "id1", "1": "id2" } - treat all string values as IDs.
        if (Array.isArray(body)) {
          return body;
        }

        const values = Object.values(body);
        if (values.length && values.every((v) => typeof v === 'string')) {
          return values;
        }

        return [];
      };

      const rawIds = extractIds(rawBody);

      const validIds = rawIds
        .map((value) => (value && value._id ? value._id : value))
        .map((value) => (value != null ? String(value).trim() : ''))
        .filter((value) => !!value && mongoose.Types.ObjectId.isValid(value));

      if (!validIds.length) {
        return this.error(res, ERROR_MESSAGES.NO_VALID_SALE_IDS_FOR_DELETE, 400);
      }

      const SaleModel = this.model || Sale;
      const deletedSales = await Promise.all(
        validIds.map((id) => salesService.getSaleById(id, { SaleModel }))
      );
      const result = await salesService.deleteSales(validIds, {
        SaleModel,
        requireRecycleBackup: true,
      });

      // Mirror PHP sales.php::delete behaviour, which calls
      // SalesModel::deleteSaleCollectionData and forwards its
      // status + data into response('success', 'Sales deleted successfully', $data, 200)
      // or response('error', 'Sales Not deleted', $data, 404).
      if (!result || typeof result !== 'object') {
        return this.error(res, ERROR_MESSAGES.SALES_NOT_DELETED, 500);
      }

      if (result.status === true) {
        await Promise.all(
          validIds.map((id, index) =>
            writeSaleAudit(req, 'delete', deletedSales[index]?.sales_id || id, 'Sale deleted', {
              sales_id: deletedSales[index]?.sales_id || '',
              total: deletedSales[index]?.sales_total || deletedSales[index]?.total || 0,
            })
          )
        );
        return this.success(res, result.data, SUCCESS_MESSAGES.SALES_DELETED, 200);
      }

      // Known domain conflicts explain the required next action. Unexpected
      // database failures keep the generic message rather than exposing internals.
      const statusCode = Number(result.statusCode);
      const domainError = [400, 403, 404, 409, 422].includes(statusCode);
      return this.error(
        res,
        domainError && result.message ? result.message : ERROR_MESSAGES.SALES_NOT_DELETED,
        domainError ? statusCode : statusCode >= 500 ? 500 : 404,
        result.data
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * Legacy endpoint: GET /sales/getLatestSales
   * Returns the latest 6 sales for the current branch.
   */
  async clearParkedSales(req, res, next) {
    try {
      if (!this.checkPermission('sales', 'write', req.user))
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      if (req.body?.confirmed !== true)
        return this.error(res, 'Confirm clearing parked sales first.', 400);
      await this.ensureContext(req);
      const result = await require('../services/parked-sales').clearAll(await BaseModel.getDb(), {
        branchId: resolveBranchId(req.user, req.session) || BaseModel.currentBranch,
        licenseId: BaseModel.license,
        userId: req.user?._id,
      });
      return this.success(res, result, 'Parked sales cleared');
    } catch (error) {
      next(error);
    }
  }

  async getLatestSales(req, res) {
    try {
      // PHP controller uses sales write access for this endpoint
      // (Sales::getLatestSales) and returns
      //   response('success', 'Recent Sales Retrived', $data, 200)
      // or
      //   response('error', 'Recent Sales Not Retrived ', $data, 404).
      if (!this.checkPermission('sales', 'write', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // Ensure BaseModel context (license, branch) is initialised
      await this.ensureContext(req);

      const SaleModel = this.model || Sale;

      // Resolve branch similar to PHP: use current branch / branch_id
      const branchId = resolveBranchId(req.user, req.session) || BaseModel.currentBranch;

      const latestSales = await salesService.getLatestSales(
        {
          branchId,
          licenseId: BaseModel.license,
          // type=hold: the sale screen's Parked tab - holds only, more rows.
          holdOnly: req.query?.type === 'hold',
        },
        { SaleModel }
      );

      // PHP model encodes the array as JSON string or returns 0
      const latestSaleJson = latestSales.length > 0 ? JSON.stringify(latestSales) : 0;

      return res.status(200).json({
        type: 'success',
        message: SUCCESS_MESSAGES.RECENT_SALES_RETRIEVED,
        data: latestSaleJson,
      });
    } catch (error) {
      console.error('Error in getLatestSales:', error);
      return res.status(500).json({
        type: 'error',
        message: ERROR_MESSAGES.RECENT_SALES_NOT_RETRIEVED,
        data: null,
      });
    }
  }

  async historyFilterOptions(req, res) {
    try {
      if (!this.checkPermission('sales', 'read', req.user))
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      const branchId = req.query.branch || resolveBranchId(req.user, req.session);
      const licenseId =
        req.tenantContext?.licenseId ||
        req.user?.license ||
        req.user?.license_id ||
        req.user?.licenseId;
      const pipeline = require('../helpers/sales-history-options')({
        branchId,
        licenseId,
        field: req.query.field,
        query: req.query.query || '',
      });
      const db = currentConnection(mongoose.connection).db;
      const recorded = await db
        .collection('sales')
        .aggregate(pipeline, { maxTimeMS: 5000 })
        .toArray();
      let options = recorded;
      if (['staff', 'seller'].includes(req.query.field)) {
        const branch = new mongoose.Types.ObjectId(String(branchId));
        const match = {
          license: new mongoose.Types.ObjectId(String(licenseId)),
          $or: [{ branch_id: branch }, { 'branch_access.branch_id': branch }],
        };
        const term = (req.query.query || '').trim();
        if (term) {
          const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          match.$and = [
            {
              $or: ['username', 'email', 'name', 'firstname', 'lastname'].map((key) => ({
                [key]: pattern,
              })),
            },
          ];
        }
        const employees = await db
          .collection('users')
          .find(match, {
            projection: { username: 1, email: 1, name: 1, firstname: 1, lastname: 1 },
          })
          .sort({ username: 1, _id: 1 })
          .limit(25)
          .toArray();
        const roster = employees.map((user) => {
          const name =
            user.name ||
            [user.firstname, user.lastname].filter(Boolean).join(' ') ||
            user.username ||
            user.email;
          return {
            value: (req.query.field === 'staff' ? 'employee:' : '') + String(user._id),
            label: user.email && user.email !== name ? name + ' · ' + user.email : name,
          };
        });
        options = roster.concat(
          recorded.filter((option) => !roster.some((user) => user.value === option.value))
        );
      }
      return this.success(res, options, 'Filter options loaded');
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  }
  async dailySalesReports(req, res) {
    try {
      // ---- Access check (null-safe) ----
      const hasReportAccess = this.checkPermission('report', 'read', req.user);

      if (!hasReportAccess) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // ---- Read & sanitize inputs ----
      const { branch, type } = req.query;

      // Normalize type to allowlist
      const allowedTypes = ['VIEW', 'CSV', 'PDF'];
      let normalizedType = type ? type.toUpperCase().trim() : 'VIEW';
      if (!allowedTypes.includes(normalizedType)) {
        normalizedType = 'VIEW';
      }

      // ---- Verify branch exists ----
      const branchDoc = await salesService.getBranchById(branch);
      if (!branchDoc) {
        return this.error(res, ERROR_MESSAGES.BRANCH_NOT_FOUND, 404);
      }

      const period = require('../helpers/daily-report-period').dailyReportPeriod(
        req.query,
        branchDoc.time_zone || process.env.DEFAULT_TIMEZONE || 'UTC'
      );
      const start = period.start,
        end = period.end;
      const filteredDateRange = await sessionFilterUtil.applySessionFilter(req, {
        start_date: start,
        end_date: end,
      });

      const SaleModel = this.model || Sale;
      const branchObjectId = new mongoose.Types.ObjectId(branch);

      // Use the same posted-sale rule as the dashboard and report exports.
      const match = {
        $and: [
          reportableSales(),
          period.match('date', filteredDateRange.start_date),
          { branch_id: branchObjectId },
        ],
      };

      const { productAgg, paymentAgg, salesPayments } =
        await salesService.getDailySalesReportAggregates({ match }, { SaleModel });

      const closingBalances = await require('../services/report-closing-stock').closingStock(
        await BaseModel.getDb(),
        {
          branch,
          license: BaseModel.license || req.user.license || req.user.license_id,
          end,
          itemIds: productAgg.map((item) => item._id?.item_id).filter(Boolean),
        }
      );
      const productDetails = productAgg.map((item) => {
        const subtotal = item.subtotal ?? 0;
        const totalAmount = item.totalAmount ?? 0;
        const totalQty = item.totalQty ?? 0;
        const totalCompanyPrice = item.totalCompanyPrice ?? 0;
        return {
          product_name: item._id?.name || item._id?.item_name || 'Unknown',
          product_sku: item._id?.sku || '',
          product_qty: totalQty,
          closing_stock: closingBalances.get(String(item._id?.item_id)) ?? null,
          product_total: roundToTwo(totalAmount),
          product_subtotal: roundToTwo(subtotal),
          product_profit: roundToTwo(subtotal - totalCompanyPrice),
          product_discount: roundToTwo(item.totalDiscount ?? 0),
          product_avg: roundToTwo(totalQty ? subtotal / totalQty : 0),
        };
      });

      const paymentDetails = paymentAgg.map((item) => ({
        sale_payment: roundToTwo(item.total ?? 0),
      }));

      // Payment aggregation is provided
      // via salesService.getDailySalesReportAggregates above.

      // Build extra_discount
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
        extra_discount_total: roundToTwo(data.extra_discount_total),
        sale_extra_discount_total: roundToTwo(data.sale_extra_discount_total),
        count_sales: data.count_sales,
      }));

      const timeZone = branchDoc.time_zone || process.env.DEFAULT_TIMEZONE || 'UTC';

      const branchDetails = {
        date: formatDateForTimezone(new Date(), timeZone),
        from_date: formatDateForTimezone(start, timeZone),
        to_date: formatDateForTimezone(new Date(end.getTime() - 1), timeZone),
        branch_name: branchDoc.branch_name,
        branch_address: branchDoc.store_address || '',
        branch_phone: branchDoc.store_telephone || '',
        branch_email: branchDoc.store_email || '',
        sales_type: normalizedType,
        period_label: period.label,
      };

      // ---- Build response data ----
      const spoilageService = require('../services/spoilage');
      const spoilageDetails = await spoilageService.daily(await BaseModel.getDb(), {
        branch,
        license: BaseModel.license || req.user.license || req.user.license_id,
        from: spoilageService.dateAt(start, branchDoc.time_zone || 'UTC'),
        to: spoilageService.dateAt(new Date(+new Date(end) - 1), branchDoc.time_zone || 'UTC'),
      });
      const spoilageBalances = await require('../services/report-closing-stock').reconciliation(
        await BaseModel.getDb(),
        {
          branch,
          license: BaseModel.license || req.user.license || req.user.license_id,
          start: new Date(start),
          end: new Date(end),
          itemIds: spoilageDetails.flatMap((entry) => entry.lines.map((line) => line.itemId)),
        }
      );
      for (const entry of spoilageDetails)
        for (const line of entry.lines)
          line.stockSummary = spoilageBalances.get(String(line.itemId)) || null;
      const responseData = {
        spoilage_details: spoilageDetails,
        branch_details: branchDetails,
        product_details: productDetails,
        payment_details: paymentDetails,
        extra_discount: {
          total_extra_discount: roundToTwo(totalExtraDiscount),
          total_sale_extra_discount: roundToTwo(totalSaleExtraDiscount),
          by_type: extraDiscountByType,
        },
      };

      // ---- Return success response ----
      return this.success(res, responseData, SUCCESS_MESSAGES.GET_SUCCESSFULLY_LOWER, 200);
    } catch (error) {
      // Last-resort safety net
      console.error('Error generating daily sales report:', error);
      return this.error(
        res,
        error.statusCode === 400 ? error.message : ERROR_MESSAGES.SERVER_ERROR,
        error.statusCode || 500,
        error.message
      );
    }
  }

  /**
   * PHP: returnProductDetails()
   * Get return product details for a single sale (used by return report sidebar)
   */
  async returnProductDetails(req, res) {
    try {
      const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
      const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
      const options = { limit, page };

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        branchid: Array.isArray(branches) ? branches : [branches],
        sales_id: req.query.sales_id,
      };

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.returnProductReportPage(data, options, {
        SaleModel,
      });

      if (result.status === true) {
        const { status: _ignoredStatus, ...payload } = result;
        return this.success(res, payload, SUCCESS_MESSAGES.GET_SUCCESSFULLY, 200);
      }

      return this.error(res, ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 404);
    } catch (error) {
      console.error('Error in SalesController.returnProductDetails:', error);
      return this.error(res, error.message || ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 500);
    }
  }

  /**
   * PHP: returnProductViewPage()
   * Get detailed view data for a specific return (used by Return Reports modal)
   */
  async returnProductView(req, res) {
    try {
      // Permissions: same as other report endpoints
      const hasReportAccess = this.checkPermission('report', 'read', req.user);
      if (!hasReportAccess) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      await this.ensureContext(req);

      const id = req.query.id || req.body?.id || null;
      if (!id) {
        return this.error(res, 'Return id is required', 400);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.returnProductViewPage(id, { SaleModel });

      if (result && result.status === true) {
        // Frontend expects data to be the raw productValues array
        return this.success(res, result.data, result.message || SUCCESS_MESSAGES.GET_SUCCESSFULLY);
      }

      return this.error(
        res,
        (result && result.message) || ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND,
        404,
        result && result.data
      );
    } catch (error) {
      console.error('Error in SalesController.returnProductView:', error);
      return this.error(res, error.message || ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 500);
    }
  }

  /**
   * Daily Sales Report PDF Generation
   * GET /sales/dailyReportPdf
   */
  async dailyReportPdf(req, res) {
    try {
      // ---- Access check (null-safe) ----
      const hasReportAccess = this.checkPermission('report', 'read', req.user);

      if (!hasReportAccess) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // ---- Read & sanitize inputs ----
      const { branch, type } = req.query;

      // Validate before database access; resolve actual windows in the shop timezone below.
      require('../helpers/daily-report-period').dailyReportPeriod(req.query, 'UTC');
      const branchDoc = await salesService.getBranchById(branch);
      if (!branchDoc) return this.error(res, ERROR_MESSAGES.BRANCH_NOT_FOUND, 404);
      const period = require('../helpers/daily-report-period').dailyReportPeriod(
        req.query,
        branchDoc.time_zone || process.env.DEFAULT_TIMEZONE || 'UTC'
      );
      const start = period.start,
        end = period.end;
      const filteredDateRange = await sessionFilterUtil.applySessionFilter(req, {
        start_date: start,
        end_date: end,
      });

      const SaleModel = this.model || Sale;
      const branchObjectId = new mongoose.Types.ObjectId(branch);
      const match = {
        $and: [
          reportableSales(),
          {
            $or: [{ branch: branchObjectId }, { branch_id: branchObjectId }],
          },
          period.match('date', filteredDateRange.start_date),
        ],
        status: { $ne: SALE_STATUS.CANCELLED },
      };

      const { productAgg, paymentAgg, extraDiscountSummary } =
        await salesService.getDailyReportPdfAggregates({ match }, { SaleModel });
      const closingBalances = await require('../services/report-closing-stock').closingStock(
        await BaseModel.getDb(),
        {
          branch,
          license: BaseModel.license || req.user.license || req.user.license_id,
          end,
          itemIds: productAgg.map((item) => item._id?.item_id).filter(Boolean),
        }
      );

      const timeZone = branchDoc.time_zone || process.env.DEFAULT_TIMEZONE || 'UTC';

      // Currency symbol from branch settings. Some legacy data contains
      // mojibake, so normalize it before writing the PDF.
      const normalizeCurrency = (value) => {
        const raw = (value || 'EGP').toString().trim();
        if (!raw || raw.includes('\u20b9') || raw.includes('\u00e2')) return '$';
        return raw;
      };
      const currency = normalizeCurrency(branchDoc.currency_type || branchDoc.currency_symbol);

      // Generate PDF using pdfkit
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({
        margin: 40,
        size: 'A4',
      });

      // Try to register DejaVuSansCondensed so phone/email icons match PHP
      let hasDejavu = false;
      if (fs.existsSync(dejavuSansCondensedPath)) {
        try {
          doc.registerFont('DejaVuSansCondensed', dejavuSansCondensedPath);
          hasDejavu = true;
        } catch (e) {
          console.log('DejaVuSansCondensed font load failed:', e.message);
        }
      } else {
        console.log(
          'DejaVuSansCondensed font not found, using Helvetica fallback:',
          dejavuSansCondensedPath
        );
      }

      let currencyFont = 'Helvetica';
      let currencyBoldFont = 'Helvetica-Bold';
      if (reportUnicodeFontPath && fs.existsSync(reportUnicodeFontPath)) {
        try {
          doc.registerFont('ReportCurrency', reportUnicodeFontPath);
          currencyFont = 'ReportCurrency';
        } catch (e) {
          console.log('Report currency font load failed:', e.message);
        }
      }
      if (reportUnicodeBoldFontPath && fs.existsSync(reportUnicodeBoldFontPath)) {
        try {
          doc.registerFont('ReportCurrencyBold', reportUnicodeBoldFontPath);
          currencyBoldFont = 'ReportCurrencyBold';
        } catch (e) {
          console.log('Report currency bold font load failed:', e.message);
        }
      }

      const formatMoney = (value) => `${currency} ${(Number(value) || 0).toFixed(2)}`;
      const writeMoney = (value, x, y, options = {}, isBold = false) => {
        doc.font(isBold ? currencyBoldFont : currencyFont).text(formatMoney(value), x, y, {
          align: 'right',
          lineBreak: false,
          ...options,
        });
      };

      // Set response headers for PDF
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=daily-sales-report-${Date.now()}.pdf`
      );

      // Pipe PDF to response
      doc.pipe(res);

      // Pre-resolve logo paths used in header/footer
      const defaultStoreLogo = path.join(__dirname, '../img/store.png');
      const defaultPosnicLogo = path.join(__dirname, '../img/posnicicon.png');
      // Footer branding: the white-label brand logo when this install has one,
      // so a shop's daily report never carries our mark; posnic only as a last
      // resort for an unbranded install.
      const footerBrandLogo = require('../helpers/brand').brandLogoPath() || defaultPosnicLogo;

      // Match the logo resolution behaviour used by the shared
      // pdfGenerator utilities so branch logos load reliably for
      // values such as "uploads/branches/logo.png", full URLs, or
      // absolute filesystem paths. When anything goes wrong we fall
      // back to the bundled store.png.
      const resolveBranchLogoPath = () => {
        let branchImagePath = defaultStoreLogo;

        if (branchDoc && typeof branchDoc.logo === 'string') {
          const rawLogo = branchDoc.logo.trim();

          if (rawLogo && rawLogo !== 'store.png') {
            if (rawLogo.startsWith('http://') || rawLogo.startsWith('https://')) {
              branchImagePath = rawLogo;
            } else if (path.isAbsolute(rawLogo)) {
              branchImagePath = rawLogo;
            } else {
              // Relative path such as "uploads/branches/logo.png" -
              // resolve from ApiV2/src to keep parity with other PDFs.
              branchImagePath = path.join(__dirname, '..', rawLogo);
            }
          }
        }

        return branchImagePath;
      };

      let currentPageNumber = 1;

      const drawHeader = () => {
        // Layout similar to PHP header: 3 columns inside [50, 50 + 515]
        const contentLeft = 50;
        const contentWidth = 515;

        const leftWidth = 180; // ~30%
        const middleWidth = 200; // ~40%
        const rightWidth = contentWidth - leftWidth - middleWidth; // rest

        const leftX = contentLeft;
        const middleX = leftX + leftWidth;
        const rightX = middleX + middleWidth;

        // Branch name and address block (left column)
        doc
          .fontSize(16)
          .font('Helvetica-Bold')
          .text(branchDoc.branch_name, leftX, 50, { width: leftWidth });
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(branchDoc.store_address || 'nagapattinam', leftX, 70, {
            width: leftWidth,
          });

        const phoneFont = hasDejavu ? 'DejaVuSansCondensed' : 'Helvetica';
        doc
          .fontSize(9)
          .font(phoneFont)
          .text(`\u260E ${branchDoc.store_telephone || '+919999999999'}`, leftX, 85, {
            width: leftWidth,
          });

        const emailFont = hasDejavu ? 'DejaVuSansCondensed' : 'Helvetica';
        doc
          .fontSize(9)
          .font(emailFont)
          .text(`\u0040 ${branchDoc.store_email || 'example@gmail.com'}`, leftX, 100, {
            width: leftWidth,
          });

        // Date range in the middle column (center-aligned)
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(`From date : ${formatDateForTimezone(start, timeZone)}`, middleX, 50, {
            width: middleWidth,
            align: 'center',
          });
        doc.text(
          `To date : ${formatDateForTimezone(new Date(end.getTime() - 1), timeZone)}`,
          middleX,
          65,
          {
            width: middleWidth,
            align: 'center',
          }
        );

        doc
          .font(emailFont)
          .fontSize(8)
          .text(period.label, middleX, 80, { width: middleWidth, align: 'center' });

        // Branch shop icon/logo on the right column (top-right). Use a
        // slightly smaller icon and drop it a little below the top margin so
        // it matches the clean spacing of the legacy PHP PDF and never looks
        // cropped against the page edge.
        const branchImagePath = resolveBranchLogoPath();
        try {
          const logoSize = 40;
          const logoX = contentLeft + contentWidth - logoSize; // right edge
          const logoY = 45;
          doc.image(branchImagePath, logoX, logoY, {
            width: logoSize,
            height: logoSize,
          });
        } catch (err) {
          // Fallback to default store logo if the branch-specific logo fails
          try {
            const logoSize = 40;
            const logoX = contentLeft + contentWidth - logoSize;
            const logoY = 45;
            doc.image(defaultStoreLogo, logoX, logoY, {
              width: logoSize,
              height: logoSize,
            });
          } catch (fallbackErr) {
            // Suppress logo errors entirely to avoid breaking the PDF
          }
        }

        // Title and report date in the right half (middle + right columns),
        // aligned to the right so the text does not wrap awkwardly.
        const titleAreaX = middleX;
        const titleAreaWidth = middleWidth + rightWidth;
        const titleY = 80;

        doc
          .fontSize(14)
          .font('Helvetica-Bold')
          .text(`${type || 'This Year'} Sale Report`, titleAreaX, titleY, {
            width: titleAreaWidth,
            align: 'right',
          });

        doc
          .fontSize(9)
          .font('Helvetica')
          .text(
            `Date: ${new Date().toLocaleString('en-US', {
              month: '2-digit',
              day: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })}`,
            titleAreaX,
            titleY + 18,
            {
              width: titleAreaWidth,
              align: 'right',
            }
          );
      };

      const drawFooter = () => {
        const page = doc.page || {};
        const pageWidth = page.width || 595.28; // A4 default width
        const pageHeight = page.height || 841.89;
        const margins = page.margins || { left: 40, right: 40, bottom: 40 };

        const contentBottomY = pageHeight - margins.bottom;
        const footerHeight = 24; // total vertical space reserved for footer
        const footerTopY = contentBottomY - footerHeight;
        const footerLineY = footerTopY;
        const footerContentY = footerTopY + 6;

        // Horizontal line above footer
        doc
          .moveTo(margins.left, footerLineY)
          .lineTo(pageWidth - margins.right, footerLineY)
          .stroke();

        try {
          doc.image(footerBrandLogo, margins.left, footerContentY, {
            width: 35,
            height: 15,
          });
        } catch (err) {
          // Fallback to text when logo image is not available
          doc
            .fontSize(10)
            .font('Helvetica')
            .fillColor('#0066CC')
            /*
             * The brand this installation goes by, never the product name.
             *
             * This is a receipt the shop hands to its own customers, so a
             * white-labelled install printing "Posnic" here is the most visible
             * leak there is - worse than an error message, because it leaves
             * the building. Blank when there is no brand: an empty space is
             * right for every brand, and a wrong name is right for none.
             */
            .text(require('../helpers/brand').brandName(), margins.left, footerContentY + 2, {
              lineBreak: false,
            });
        }

        // Page number on the right side, same line as logo
        doc
          .fontSize(9)
          .font('Helvetica')
          .fillColor('#000000')
          .text(`Page ${currentPageNumber}`, pageWidth - margins.right - 80, footerContentY + 2, {
            width: 80,
            align: 'right',
            lineBreak: false,
          });
      };

      // Draw the initial header on the first page
      drawHeader();

      // -------------------------------------------------------------------
      // Items table
      // -------------------------------------------------------------------
      const tableLeft = 40;
      const tableWidth = 515;
      const tableTop = 214;
      const headerHeight = 24;
      const rowHeight = 24;
      const colWidths = [25, 110, 48, 38, 65, 65, 75, 89];
      const cellPad = 5;
      let xPos = tableLeft;

      const getContentMaxY = () => {
        const page = doc.page || {};
        const pageHeight = page.height || 841.89;
        const margins = page.margins || { bottom: 40 };
        return pageHeight - margins.bottom - 48;
      };

      const cleanCellText = (value, maxChars) => {
        const text = (value || '')
          .toString()
          .replace(/[\r\n\t]+/g, ' ')
          .trim();
        return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
      };

      const drawItemsHeader = () => {
        doc
          .fontSize(12)
          .font('Helvetica-Bold')
          .fillColor('#1f2937')
          .text('Items Sold', tableLeft, tableTop - 24, { width: tableWidth });

        const columns = [
          ['#', 'center'],
          ['Item', 'left'],
          ['Item code', 'left'],
          ['Quantity', 'center'],
          ['Price', 'right'],
          ['Discount', 'right'],
          ['Amount', 'right'],
          ['Closing stock', 'right'],
        ];

        let headerX = tableLeft;
        doc.rect(tableLeft, tableTop, tableWidth, headerHeight).fillAndStroke('#e8eef7', '#7f8ea3');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#111827');
        columns.forEach(([label, align], idx) => {
          doc.text(label, headerX + cellPad, tableTop + 8, {
            width: colWidths[idx] - cellPad * 2,
            align,
            lineBreak: false,
          });
          headerX += colWidths[idx];
        });
      };

      drawItemsHeader();

      // Helper to format quantity
      const formatQty = (value) => {
        const num = Number(value) || 0;
        return Number.isInteger(num) ? num.toString() : num.toFixed(3);
      };

      // Item rows
      let yPos = tableTop + headerHeight;
      let totalQty = 0;
      let totalUnitPrice = 0;
      let totalDiscount = 0;
      let totalAmount = 0;

      productAgg.forEach((item, index) => {
        if (yPos + rowHeight > getContentMaxY()) {
          drawFooter();
          doc.addPage();
          currentPageNumber += 1;
          drawHeader();
          drawItemsHeader();
          yPos = tableTop + headerHeight;
        }

        xPos = tableLeft;
        const qty = item.totalQty || 0;
        const unitPrice = item.unitPrice || 0;
        const discount = item.totalDiscount || 0;
        const amount = item.totalAmount || 0;

        totalQty += qty;
        totalUnitPrice += unitPrice;
        totalDiscount += discount;
        totalAmount += amount;

        const rowFill = index % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(tableLeft, yPos, tableWidth, rowHeight).fillAndStroke(rowFill, '#d8dee8');
        doc.fontSize(8).font('Helvetica').fillColor('#111827');
        doc.text(String(index + 1), xPos + cellPad, yPos + 8, {
          width: colWidths[0] - cellPad * 2,
          align: 'center',
          lineBreak: false,
        });
        xPos += colWidths[0];

        // Description: single line, truncated
        const rawName = (item._id.name || 'Unknown').toString();
        const maxNameChars = 30;
        const displayName =
          rawName.length > maxNameChars ? `${rawName.slice(0, maxNameChars - 1)}…` : rawName;
        doc.text(cleanCellText(rawName, 21), xPos + cellPad, yPos + 8, {
          width: colWidths[1] - cellPad * 2,
          lineBreak: false,
        });
        xPos += colWidths[1];

        // SKU: sanitized single line, truncated
        const rawSku = (item._id.sku || '').toString();
        const sanitizedSku = rawSku.replace(/[\r\n\t]+/g, ' ').trim();
        const maxSkuChars = 12;
        const displaySku =
          sanitizedSku.length > maxSkuChars
            ? `${sanitizedSku.slice(0, maxSkuChars - 1)}…`
            : sanitizedSku;
        doc.text(cleanCellText(rawSku, 12), xPos + cellPad, yPos + 8, {
          width: colWidths[2] - cellPad * 2,
          lineBreak: false,
        });
        xPos += colWidths[2];

        // QTY, PRICE, DISCOUNT, AMOUNT
        doc.text(formatQty(qty), xPos + cellPad, yPos + 8, {
          width: colWidths[3] - cellPad * 2,
          align: 'center',
          lineBreak: false,
        });
        xPos += colWidths[3];

        writeMoney(unitPrice, xPos + cellPad, yPos + 8, { width: colWidths[4] - cellPad * 2 });
        xPos += colWidths[4];

        writeMoney(discount, xPos + cellPad, yPos + 8, { width: colWidths[5] - cellPad * 2 });
        xPos += colWidths[5];

        writeMoney(amount, xPos + cellPad, yPos + 8, { width: colWidths[6] - cellPad * 2 });

        xPos += colWidths[6];
        const closing = closingBalances.get(String(item._id?.item_id));
        doc.text(
          closing === undefined ? 'Unavailable' : formatQty(closing),
          xPos + cellPad,
          yPos + 8,
          { width: colWidths[7] - cellPad * 2, align: 'right', lineBreak: false }
        );
        yPos += rowHeight;
      });

      // Totals row
      if (yPos + rowHeight > getContentMaxY()) {
        drawFooter();
        doc.addPage();
        currentPageNumber += 1;
        drawHeader();
        drawItemsHeader();
        yPos = tableTop + headerHeight;
      }

      xPos = tableLeft;
      doc.fontSize(8).font('Helvetica-Bold');
      doc.rect(tableLeft, yPos, tableWidth, rowHeight).fillAndStroke('#e8eef7', '#7f8ea3');
      doc.fillColor('#111827').text('Total', xPos + cellPad, yPos + 8, {
        width: colWidths[0] + colWidths[1] + colWidths[2],
        align: 'center',
        lineBreak: false,
      });
      xPos += colWidths[0] + colWidths[1] + colWidths[2];
      doc.text(formatQty(totalQty), xPos + cellPad, yPos + 8, {
        width: colWidths[3] - cellPad * 2,
        align: 'center',
        lineBreak: false,
      });
      xPos += colWidths[3];
      writeMoney(
        totalUnitPrice,
        xPos + cellPad,
        yPos + 8,
        { width: colWidths[4] - cellPad * 2 },
        true
      );
      xPos += colWidths[4];
      writeMoney(
        totalDiscount,
        xPos + cellPad,
        yPos + 8,
        { width: colWidths[5] - cellPad * 2 },
        true
      );
      xPos += colWidths[5];
      writeMoney(
        totalAmount,
        xPos + cellPad,
        yPos + 8,
        { width: colWidths[6] - cellPad * 2 },
        true
      );

      // Determine if we actually have any summary content to show. If there
      // is no Extra Discount or Tender Type data, we keep the report to the
      // items pages only and avoid adding an extra blank page.
      const totalSaleExtraDiscount =
        extraDiscountSummary && typeof extraDiscountSummary.total_sale_extra_discount === 'number'
          ? extraDiscountSummary.total_sale_extra_discount
          : 0;

      const paymentsReceived = Array.isArray(paymentAgg)
        ? paymentAgg.reduce((sum, payment) => sum + (Number(payment.total) || 0), 0)
        : 0;
      const hasSummarySections = totalSaleExtraDiscount > 0 || paymentsReceived > 0;

      // After finishing the items table, either finalize the current page
      // (when there is no summary content) or start a dedicated summary page
      // that begins below the header area.
      if (!hasSummarySections) {
        drawFooter();
        doc.end();
        return;
      }

      drawFooter();
      doc.addPage();
      currentPageNumber += 1;
      drawHeader();
      yPos = 200; // start summaries below the header + title row

      // -------------------------------------------------------------------
      // Extra Discount (only when there is a non-zero total)
      // -------------------------------------------------------------------

      if (totalSaleExtraDiscount > 0) {
        yPos += 20;
        doc.fontSize(11).font('Helvetica-Bold').text('Extra Discount', 50, yPos);

        yPos += 20;
        const extraTableTop = yPos;

        doc.fontSize(9);
        doc.rect(50, extraTableTop, 515, 20).fillAndStroke('#e0e0e0', '#000');
        doc.fillColor('#000').text('Extra Discount', 55, extraTableTop + 5, {
          width: 360,
          lineBreak: false,
        });
        doc.text('Amount', 425, extraTableTop + 5, {
          width: 130,
          align: 'right',
          lineBreak: false,
        });

        yPos = extraTableTop + 20;
        doc.font('Helvetica');

        // For now mirror the legacy PDF: single row with total extra discount
        doc.rect(50, yPos, 515, 20).stroke();
        doc.text('Amount Discount', 55, yPos + 5, {
          width: 360,
          lineBreak: false,
        });
        writeMoney(totalSaleExtraDiscount, 425, yPos + 5, { width: 130 });

        yPos += 20;
        doc.font('Helvetica-Bold');
        doc.rect(50, yPos, 515, 20).fillAndStroke('#f0f0f0', '#000');
        doc.fillColor('#000').text('Total', 55, yPos + 5, {
          width: 360,
          lineBreak: false,
        });
        writeMoney(totalSaleExtraDiscount, 425, yPos + 5, { width: 130 }, true);

        yPos += 40; // space before Tender Type section
      }

      if (paymentsReceived > 0) {
        yPos += 50;
        doc.fontSize(11).font('Helvetica-Bold').text('Payments received', 50, yPos);
        yPos += 20;

        doc.fontSize(9);
        doc.rect(50, yPos, 515, 20).fillAndStroke('#e0e0e0', '#000');
        doc.fillColor('#000').text('Payments recorded', 55, yPos + 5, {
          width: 360,
          lineBreak: false,
        });
        doc.text('Amount', 425, yPos + 5, {
          width: 130,
          align: 'right',
          lineBreak: false,
        });
        yPos += 20;

        doc.font('Helvetica');
        doc.rect(50, yPos, 515, 20).stroke();
        doc.text('Amount received', 55, yPos + 5, {
          width: 360,
          lineBreak: false,
        });
        writeMoney(paymentsReceived, 425, yPos + 5, { width: 130 });
        yPos += 20;

        doc.font('Helvetica-Bold');
        doc.rect(50, yPos, 515, 20).fillAndStroke('#f0f0f0', '#000');
        doc.fillColor('#000').text('Total', 55, yPos + 5, {
          width: 360,
          lineBreak: false,
        });
        writeMoney(paymentsReceived, 425, yPos + 5, { width: 130 }, true);
      }

      // Finalize PDF with footer on the last page
      drawFooter();
      doc.end();
    } catch (error) {
      console.error('Error generating daily sales PDF:', error);

      if (!res.headersSent) {
        return this.error(
          res,
          error.statusCode === 400 ? error.message : ERROR_MESSAGES.SERVER_ERROR,
          error.statusCode || 500,
          error.message
        );
      }
    }
  }

  /**
   * Legacy endpoint: GET /sales/salesReports
   * Returns paginated sales summary filtered by branch and date range.
   */
  async salesGraphicalReports(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const parseBranchValue = (value) => {
        if (!value && value !== 0) {
          return [];
        }
        if (Array.isArray(value)) {
          return value.flatMap((entry) => parseBranchValue(entry));
        }
        if (typeof value === 'object') {
          const candidates = [value.branch_id, value.branchId, value._id, value.id, value.$oid];
          return candidates.filter(Boolean).map((entry) => String(entry));
        }
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) {
            return [];
          }
          if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || trimmed.includes(',')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (Array.isArray(parsed)) {
                return parsed.flatMap((entry) => parseBranchValue(entry));
              }
            } catch {
              return trimmed
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            }
          }
          return [trimmed];
        }
        return [String(value)];
      };

      const branchInputs = [
        req.query.branch,
        req.query['branch[]'],
        req.query.branch_id,
        req.query.branchId,
      ];

      let branchIds = branchInputs
        .flatMap((value) => parseBranchValue(value))
        .filter((value) => typeof value === 'string' && value.trim());

      if (!branchIds.length) {
        const fallbackBranch = resolveBranchId(req.user, req.session);
        if (fallbackBranch) {
          branchIds = [String(fallbackBranch)];
        }
      }

      const uniqueBranchIds = [...new Set(branchIds.map((id) => id.trim()).filter(Boolean))];

      if (!uniqueBranchIds.length) {
        return this.error(res, ERROR_MESSAGES.AT_LEAST_ONE_BRANCH_ID_REQUIRED, 400);
      }

      const validBranchIds = uniqueBranchIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (!validBranchIds.length) {
        return this.error(res, ERROR_MESSAGES.NO_VALID_BRANCH_IDS_PROVIDED, 400);
      }

      const startDate = normalizeRangeDate(req.query.starting_date);
      const endDate = normalizeRangeDate(req.query.ending_date, {
        endOfDay: true,
      });

      // Initialize match variable outside the if block
      const match = {
        branch_id: { $in: validBranchIds },
        ...reportableSales(),
        status: { $ne: SALE_STATUS.CANCELLED },
      };

      // Apply session filtering if user has permission (same as salesSummaryReports)
      if (startDate || endDate) {
        const originalDateRange = {
          start_date: startDate || new Date(0),
          end_date: endDate || new Date(),
        };

        const filteredDateRange = await sessionFilterUtil.applySessionFilter(
          req,
          originalDateRange
        );

        // Use filtered dates
        const filteredStartDate = filteredDateRange.start_date;
        const filteredEndDate = filteredDateRange.end_date;

        if (filteredStartDate || filteredEndDate) {
          match.date = {};
          if (filteredStartDate) {
            match.date.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            match.date.$lte = filteredEndDate;
          }
          if (!match.date.$gte && !match.date.$lte) {
            delete match.date;
          }
        }
      }

      const SaleModel = this.model || Sale;

      const chartData = await salesService.getSalesGraphicalReportData(
        { match, validBranchIds },
        { SaleModel }
      );

      return this.success(
        res,
        chartData,
        chartData.length
          ? 'Graphical report generated successfully'
          : 'No sales data found for the selected range'
      );
    } catch (error) {
      console.error('Error generating sales graphical report:', error);
      return this.error(res, 'Failed to generate sales graphical report', 500, error.message);
    }
  }

  /**
   * Legacy endpoint: GET /sales/salesSummaryReports
   * Returns aggregate totals for the selected branches/date range.
   */
  async salesSummaryReports(req, res) {
    try {
      const role = (req.user?.usertype || req.user?.role || '').toLowerCase();
      const hasPermission =
        req.user?.access?.report?.read === true ||
        ['super_admin', 'admin', 'manager', 'api'].includes(role);

      if (!hasPermission) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const startingDate = req.query.starting_date ? parseSaleDate(req.query.starting_date) : null;
      const endingDate = req.query.ending_date ? parseSaleDate(req.query.ending_date) : null;

      let uniqueBranchIds;
      let validBranchIds;

      if (
        req.salesSummaryBranchContext &&
        Array.isArray(req.salesSummaryBranchContext.uniqueBranchIds) &&
        Array.isArray(req.salesSummaryBranchContext.validBranchIds)
      ) {
        ({ uniqueBranchIds, validBranchIds } = req.salesSummaryBranchContext);
      } else {
        ({ uniqueBranchIds, validBranchIds } = parseBranchIdsFromRequest(req));

        if (!uniqueBranchIds.length) {
          return this.error(res, ERROR_MESSAGES.AT_LEAST_ONE_BRANCH_ID_REQUIRED, 400);
        }

        if (!validBranchIds.length) {
          return this.error(res, ERROR_MESSAGES.NO_VALID_BRANCH_IDS_PROVIDED, 400);
        }
      }

      // Convert branch IDs to ObjectId for MongoDB matching
      const { ObjectId } = require('mongodb');
      const branchObjectIds = validBranchIds.map((id) =>
        typeof id === 'string' ? new ObjectId(id) : id
      );

      const match = {
        branch_id: { $in: branchObjectIds },
        ...reportableSales([...GRAPH_ALLOWED_SALE_PROCESSES, 'FullReturn']),
      };

      // Apply session filtering if user has permission and dates are provided
      if (startingDate || endingDate) {
        const originalDateRange = {
          start_date: startingDate || new Date(0),
          end_date: endingDate || new Date(),
        };

        const filteredDateRange = await sessionFilterUtil.applySessionFilter(
          req,
          originalDateRange
        );

        match.date = {};

        if (filteredDateRange.start_date && !Number.isNaN(filteredDateRange.start_date.valueOf())) {
          match.date.$gte = filteredDateRange.start_date;
        }
        if (filteredDateRange.end_date && !Number.isNaN(filteredDateRange.end_date.valueOf())) {
          const end = new Date(filteredDateRange.end_date);
          end.setHours(23, 59, 59, 999);
          match.date.$lte = end;
        }
        if (!Object.keys(match.date).length) {
          delete match.date;
        }
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.getSalesSummaryReportsData(
        { match, branchObjectIds },
        { SaleModel }
      );

      return this.success(res, result, 'Sales summary report retrieved successfully');
    } catch (error) {
      if (error.statusCode) return this.error(res, error.message, error.statusCode);
      console.error('Error in salesSummaryReports:', error);
      return this.error(res, 'Failed to load sales summary report. Please try again later.', 500);
    }
  }

  async salesReports(req, res) {
    try {
      // Permission check matching PHP controller line 445
      const role = (req.user?.usertype || req.user?.role || '').toLowerCase();

      const hasPermission =
        req.user?.access?.report?.read === true ||
        ['super_admin', 'admin', 'manager', 'api'].includes(role);

      if (!hasPermission) {
        return res.status(403).json({
          type: 'error',
          message: ERROR_MESSAGES.UNAUTHORIZED,
          data: null,
        });
      }

      const { ObjectId } = require('mongodb');

      // Parse query params matching PHP controller lines 439-444
      const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
      const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;

      let branchObjectIds;
      let startDate;
      let endDate;

      if (req.salesReportsFilters && Array.isArray(req.salesReportsFilters.branchObjectIds)) {
        branchObjectIds = req.salesReportsFilters.branchObjectIds;
        startDate = req.salesReportsFilters.startDate;
        endDate = req.salesReportsFilters.endDate;

        // Apply session filtering if user has permission (same as salesSummaryReports)
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate,
            end_date: endDate,
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          startDate = filteredDateRange.start_date;
          endDate = filteredDateRange.end_date;
        }
      } else {
        // Parse branch IDs (can be single string or array)
        let branchIds = req.query.branch || req.query.branchid;

        if (!branchIds) {
          return res.status(400).json({
            type: 'error',
            message: 'Branch ID is required',
            data: null,
          });
        }

        // Convert to array if single string
        if (!Array.isArray(branchIds)) {
          branchIds = [branchIds];
        }

        // Convert to ObjectIds
        branchObjectIds = branchIds
          .filter((id) => id && ObjectId.isValid(id))
          .map((id) => new ObjectId(id));

        if (!branchObjectIds.length) {
          return res.status(400).json({
            type: 'error',
            message: ERROR_MESSAGES.NO_VALID_BRANCH_IDS_PROVIDED,
            data: null,
          });
        }

        // Parse dates matching PHP model lines 1054-1055
        const startingDate = req.query.starting_date;
        const endingDate = req.query.ending_date;

        if (!startingDate || !endingDate) {
          return res.status(400).json({
            type: 'error',
            message: 'Date range is required',
            data: null,
          });
        }

        // Create date range (assuming dates come as 'YYYY-MM-DD' from frontend)
        startDate = new Date(startingDate);
        startDate.setHours(0, 0, 0, 0);

        endDate = new Date(endingDate);
        endDate.setHours(23, 59, 59, 999);

        // Apply session filtering if user has permission (same as salesSummaryReports)

        const originalDateRange = {
          start_date: startDate,
          end_date: endDate,
        };

        const filteredDateRange = await sessionFilterUtil.applySessionFilter(
          req,
          originalDateRange
        );

        // Use filtered dates
        const oldStartDate = startDate;
        const oldEndDate = endDate;
        startDate = filteredDateRange.start_date;
        endDate = filteredDateRange.end_date;
      }

      // Build filter matching PHP model lines 1062-1068
      const match = {
        $and: [
          { branch_id: { $in: branchObjectIds } },
          reportableSales(),
          {
            date: { $gte: startDate, $lte: endDate },
            license: new ObjectId(req.user.license || req.user.licenseId),
          },
        ],
      };

      /*
       * The branch whose report this is, for its date order and its clock.
       *
       * Read once here rather than per row. A failure to find it is not worth
       * failing the report over - the defaults are the ones nearly every shop
       * would have chosen anyway.
       */
      match.$and.push(...require('../helpers/sales-list-criteria')(req.query, req.user));
      if (typeof req.query.receipt === 'string' && req.query.receipt.trim()) {
        const literal = new RegExp(
          req.query.receipt
            .trim()
            .slice(0, 120)
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'i'
        );
        match.$and.push({
          $or: [{ sales_id: literal }, { invoice_number: literal }, { customer_name: literal }],
        });
      }
      let branch = null;
      try {
        branch = await currentConnection(mongoose.connection)
          .db.collection('branches')
          .findOne(
            { _id: branchObjectIds[0] },
            { projection: { client_dateformat: 1, time_zone: 1 } }
          );
      } catch (err) {
        console.warn('Sales report: could not read branch date settings:', err.message);
      }

      const SaleModel = this.model || Sale;
      const responseData = await salesService.getSalesReportsData(
        { match, page, limit, branch },
        { SaleModel }
      );

      // Return PHP-compatible response structure
      return res.status(200).json({
        type: 'success',
        message: SUCCESS_MESSAGES.GENERIC_SUCCESS_LOWER,
        data: responseData,
      });
    } catch (error) {
      if (error.statusCode) return this.error(res, error.message, error.statusCode);
      console.error('Error in salesReports:', error);
      return res.status(500).json({
        type: 'error',
        message: error.message || 'Failed to generate sales report',
        data: null,
      });
    }
  }

  async instantSalesReports(req, res) {
    try {
      const role = (req.user?.usertype || req.user?.role || '').toLowerCase();
      const hasPermission =
        req.user?.access?.report?.read === true ||
        ['super_admin', 'admin', 'manager', 'api'].includes(role);

      if (!hasPermission) {
        return this.error(res, 'Unauthorized', 403);
      }

      let limit;
      let page;

      if (req.reportParams && typeof req.reportParams.limit === 'number') {
        ({ limit, page } = req.reportParams);
      } else {
        const limitCandidate = parseInt(req.query.limit, 10);
        const pageCandidate = parseInt(req.query.page, 10);

        limit = limitCandidate > 0 ? limitCandidate : 5;
        page = pageCandidate > 0 ? pageCandidate : 1;
      }

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      const dateFilter = {};

      if (req.reportParams && (req.reportParams.startDate || req.reportParams.endDate)) {
        // Apply session filtering if user has permission and dates are provided
        if (req.reportParams.startDate || req.reportParams.endDate) {
          const originalDateRange = {
            start_date: req.reportParams.startDate || new Date(0),
            end_date: req.reportParams.endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          if (filteredDateRange.start_date) {
            dateFilter.$gte = filteredDateRange.start_date;
          }
          if (filteredDateRange.end_date) {
            dateFilter.$lte = filteredDateRange.end_date;
          }
        } else {
          if (req.reportParams.startDate) {
            dateFilter.$gte = req.reportParams.startDate;
          }
          if (req.reportParams.endDate) {
            dateFilter.$lte = req.reportParams.endDate;
          }
        }
      } else {
        const startDate = parseSaleDate(req.query.starting_date);
        const endDate = parseSaleDate(req.query.ending_date);

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          if (filteredDateRange.start_date) {
            const start = new Date(filteredDateRange.start_date);
            start.setHours(0, 0, 0, 0);
            dateFilter.$gte = start;
          }
          if (filteredDateRange.end_date) {
            const end = new Date(filteredDateRange.end_date);
            end.setHours(23, 59, 59, 999);
            dateFilter.$lte = end;
          }
        } else {
          if (startDate && !Number.isNaN(startDate.valueOf())) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            dateFilter.$gte = start;
          }
          if (endDate && !Number.isNaN(endDate.valueOf())) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.$lte = end;
          }
        }
      }

      // PHP uses ONLY 'date' field - NOT createdAt or other fields
      // Match PHP sales_model.php:2312-2322
      const matchConditions = [
        { branch_id: { $in: branchIds } },
        { 'items.item_status': 'instant' }, // Exact match, not regex
        { ...reportableSales(['Add', 'Edit', 'PartialReturn', 'Partial']) },
      ];

      if (Object.keys(dateFilter).length) {
        matchConditions.push({ date: dateFilter }); // ONLY date field
      }

      const match = { $and: matchConditions };

      const SaleModel = this.model || Sale;
      const timeZone = resolveTimeZonePreference(req.user);
      console.log('🕐 instantSalesReports - Resolved timezone:', timeZone);
      console.log('🕐 instantSalesReports - User timezone sources:', {
        preferences_time_zone: req.user?.preferences?.time_zone,
        user_time_zone: req.user?.time_zone,
        user_timezone: req.user?.timezone,
        env_timezone: process.env.APP_TIMEZONE,
      });
      const { itemsList, total } = await salesService.getInstantSalesReportsData(
        { match, page, limit },
        { SaleModel }
      );

      // Map to match PHP response format (sales_model.php:2366-2386)
      // PHP line 2368: isset($doc->string_date) ? $doc->string_date : formatDate($doc->date)
      const list = itemsList.map((doc) => {
        const formattedDate = doc.string_date || formatDate(doc.date);

        return {
          _id: doc._id ? String(doc._id) : '',
          sales_id: doc.sales_id || '',
          date: formattedDate,
          item_name: doc.item_name || '',
          customer_name: doc.customer_name || '',
          user_name: doc.user_name || '',
          item_quantity: doc.item_quantity || 0,
          total_qty: doc.item_quantity || 0, // PHP maps item_quantity to total_qty
          total_amount: doc.total_amount || 0,
        };
      });

      return this.success(
        res,
        {
          total,
          total_pages: Math.ceil(total / limit) || 0,
          current_page: page,
          per_page: limit,
          list,
        },
        'Instant sales report retrieved successfully'
      );
    } catch (error) {
      if (error.statusCode) return this.error(res, error.message, error.statusCode);
      console.error('Error in instantSalesReports:', error);
      return this.error(res, 'Unable to load instant sales report. Please try again later.', 500, {
        error: error.message,
      });
    }
  }

  async instantSaleDetails(req, res) {
    try {
      const role = (req.user?.usertype || req.user?.role || '').toLowerCase();
      const hasPermission =
        req.user?.access?.report?.read === true ||
        ['super_admin', 'admin', 'manager', 'api'].includes(role);

      if (!hasPermission) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const limitCandidate = parseInt(req.query.limit, 10);
      const pageCandidate = parseInt(req.query.page, 10);

      const limit = limitCandidate > 0 ? limitCandidate : 5;
      const page = pageCandidate > 0 ? pageCandidate : 1;

      const instantId = req.query.instant_id || req.query.sale_id || req.query.id;

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      const SaleModel = this.model || Sale;
      const sale = await salesService.getSaleById(instantId, { SaleModel });

      if (!sale) {
        return this.error(res, ERROR_MESSAGES.SALE_NOT_FOUND, 404);
      }

      const saleBranchCandidate =
        (sale.branch && (sale.branch._id || sale.branch.id)) || sale.branch;
      const saleBranchId =
        saleBranchCandidate && saleBranchCandidate.toString
          ? saleBranchCandidate.toString()
          : saleBranchCandidate
            ? String(saleBranchCandidate)
            : null;

      if (
        saleBranchId &&
        branchIds.length &&
        !branchIds.some((branchId) => branchId.toString() === saleBranchId)
      ) {
        return this.error(res, ERROR_MESSAGES.SALE_NOT_FOUND_FOR_SELECTED_BRANCH, 404);
      }

      const { instantItems } = calculateInstantMetrics(sale.items || []);
      const sortedItems = [...instantItems].sort((a, b) => {
        const amountA = numberOrZero(
          a?.total ?? a?.total_amount ?? a?.line_total ?? a?.items_total ?? 0,
          0
        );
        const amountB = numberOrZero(
          b?.total ?? b?.total_amount ?? b?.line_total ?? b?.items_total ?? 0,
          0
        );
        return amountB - amountA;
      });

      const total = sortedItems.length;
      const perPage = limit;
      const totalPages = perPage ? Math.ceil(total / perPage) : 0;
      const startIndex = (page - 1) * perPage;
      const pagedItems =
        perPage > 0 ? sortedItems.slice(startIndex, startIndex + perPage) : sortedItems;

      const saleIdentifier =
        sale.sales_id ||
        sale.invoice_number ||
        sale.alternative_id ||
        (sale._id && sale._id.toString ? sale._id.toString() : '');

      const list = pagedItems.map((item) => {
        const amount = roundToTwo(
          numberOrZero(
            item?.total ?? item?.total_amount ?? item?.line_total ?? item?.items_total ?? 0,
            0
          )
        );
        const quantity = numberOrZero(
          item?.quantity ?? item?.item_quantity ?? item?.qty ?? item?.count ?? 0,
          0
        );
        const itemIdCandidate =
          (item.item && (item.item._id || item.item.id)) ||
          item.item ||
          item.item_id ||
          item._id ||
          null;
        const itemId =
          itemIdCandidate && itemIdCandidate.toString
            ? itemIdCandidate.toString()
            : itemIdCandidate;

        return {
          _id: itemId,
          name: item.name || item.item_name || item.description || '',
          sales_id: saleIdentifier,
          total_amount: amount,
          item_quantity: quantity,
        };
      });

      return this.success(
        res,
        {
          total,
          current_page: page,
          total_pages: totalPages,
          per_page: perPage,
          list,
        },
        'Instant sale details retrieved successfully'
      );
    } catch (error) {
      console.error('Error in instantSaleDetails:', error);
      return this.error(res, 'Unable to load instant sale details. Please try again later.', 500, {
        error: error.message,
      });
    }
  }

  async itemSalesReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let limit;
      let page;
      let skip;
      const dateFilter = {};

      if (req.reportParams && typeof req.reportParams.limit === 'number') {
        ({ limit, page, skip } = req.reportParams);
        const { startDate, endDate } = req.reportParams;

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      } else {
        const limitCandidate = parseInt(req.query.limit, 10);
        const pageCandidate = parseInt(req.query.page, 10);
        limit = limitCandidate > 0 ? limitCandidate : 5;
        page = pageCandidate > 0 ? pageCandidate : 1;
        skip = (page - 1) * limit;

        const startDate = normalizeRangeDate(req.query.starting_date);
        const endDate = normalizeRangeDate(req.query.ending_date, {
          endOfDay: true,
        });

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      }

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      // PHP uses ONLY branch_id and updated_date - sales_model.php:3867-3874
      const matchConditions = [{ branch_id: { $in: branchIds } }, reportableSales()];

      // PHP uses ONLY updated_date field (line 3871)
      if (Object.keys(dateFilter).length) {
        matchConditions.push({ updated_date: dateFilter });
      }

      const match = { $and: matchConditions };

      const SaleModel = this.model || Sale;

      // Family view (V1 tail): optional and off by default; the export
      // path never sends it, so exports stay per-item per the invariant.
      const groupByFamily = req.query.group_by_family === 'true';

      const itemId = req.query.item_id;
      if (itemId !== undefined && (typeof itemId !== 'string' || !/^[a-f0-9]{24}$/i.test(itemId))) {
        return this.error(res, 'Invalid item ID', 400);
      }
      const { total, list: rawList } = await salesService.getItemSalesReportTableData(
        { match, skip, limit, groupByFamily, itemId },
        { SaleModel }
      );

      const formatId = (value) => {
        if (!value && value !== 0) {
          return null;
        }
        if (typeof value === 'string') {
          return value;
        }
        if (value && typeof value === 'object' && value.toString) {
          return value.toString();
        }
        return String(value);
      };

      const list = rawList.map((entry) => ({
        _id: formatId(entry.item_id || entry._id || null),
        name: entry.name || '',
        total_amount: roundToTwo(entry.total_amount || 0),
        sales_avg: roundToTwo(entry.sales_avg || 0),
        sales_count: entry.sales_count || 0,
        item_quantity: roundToTwo(entry.item_quantity || 0),
        sales_profit: roundToTwo(entry.sales_profit || 0),
        ...(groupByFamily ? { family_members: entry.family_members || 1 } : {}),
      }));

      return this.success(
        res,
        {
          total,
          total_pages: Math.ceil(total / limit) || 0,
          current_page: page,
          per_page: limit,
          list,
        },
        'Item sales report retrieved successfully'
      );
    } catch (error) {
      console.error('Error in itemSalesReportTable:', error);
      return this.error(res, 'Unable to load item sales report. Please try again later.', 500, {
        error: error.message,
      });
    }
  }

  async categorySalesReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let limit;
      let page;
      let skip;
      const dateFilter = {};

      if (req.reportParams && typeof req.reportParams.limit === 'number') {
        ({ limit, page, skip } = req.reportParams);
        const { startDate, endDate } = req.reportParams;

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      } else {
        const limitCandidate = parseInt(req.query.limit, 10);
        const pageCandidate = parseInt(req.query.page, 10);
        limit = limitCandidate > 0 ? limitCandidate : 5;
        page = pageCandidate > 0 ? pageCandidate : 1;
        skip = (page - 1) * limit;

        const startDate = normalizeRangeDate(req.query.starting_date);
        const endDate = normalizeRangeDate(req.query.ending_date, {
          endOfDay: true,
        });

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      }

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      const matchConditions = [
        {
          $or: [
            { branch: { $in: branchIds } },
            { branch_id: { $in: branchIds } },
            { branchId: { $in: branchIds } },
            { 'branch._id': { $in: branchIds } },
          ],
        },
        reportableSales(),
        { status: { $ne: SALE_STATUS.CANCELLED } },
      ];

      if (Object.keys(dateFilter).length) {
        matchConditions.push({
          $or: [
            { updatedAt: dateFilter },
            { createdAt: dateFilter },
            { updated_date: dateFilter },
            { date: dateFilter },
          ],
        });
      }

      const requestedCategoryIdInput = normalizeToMongooseId(
        req.query.field_input || req.query.category_id || req.query.categoryId
      );
      const requestedCategoryId =
        requestedCategoryIdInput && requestedCategoryIdInput.toString
          ? requestedCategoryIdInput.toString()
          : null;

      const SaleModel = this.model || Sale;

      const match = { $and: matchConditions };

      const { total, list: rawList } = await salesService.getCategorySalesReportTableData(
        { match, skip, limit, requestedCategoryId },
        { SaleModel }
      );

      const list = rawList.map((entry) => ({
        category_id: entry.category_id || null,
        name: entry.category_name || '',
        total_amount: roundToTwo(entry.total_amount || 0),
        sales_avg: roundToTwo(entry.sales_avg || 0),
        sales_count: entry.sales_count || 0,
        item_quantity: roundToTwo(entry.item_quantity || 0),
        sales_profit: roundToTwo(entry.sales_profit || 0),
      }));

      return this.success(
        res,
        {
          total,
          total_pages: Math.ceil(total / limit) || 0,
          current_page: page,
          per_page: limit,
          list,
        },
        'Category sales report retrieved successfully'
      );
    } catch (error) {
      console.error('Error in categorySalesReportTable:', error);
      return this.error(res, 'Unable to load category sales report. Please try again later.', 500, {
        error: error.message,
      });
    }
  }

  async supplierSalesReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let limit;
      let page;
      let skip;
      const dateFilter = {};

      if (req.reportParams && typeof req.reportParams.limit === 'number') {
        ({ limit, page, skip } = req.reportParams);
        const { startDate, endDate } = req.reportParams;

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      } else {
        const limitCandidate = parseInt(req.query.limit, 10);
        const pageCandidate = parseInt(req.query.page, 10);
        limit = limitCandidate > 0 ? limitCandidate : 5;
        page = pageCandidate > 0 ? pageCandidate : 1;
        skip = (page - 1) * limit;

        const normalizeRangeDate = (value, { endOfDay = false } = {}) => {
          if (!value) return null;
          const parsed = parseSaleDate(value);
          if (!parsed) return null;
          const normalized = new Date(parsed);
          normalized.setHours(0, 0, 0, 0);
          if (endOfDay) {
            normalized.setHours(23, 59, 59, 999);
          }
          return normalized;
        };

        const startDate = normalizeRangeDate(req.query.starting_date);
        const endDate = normalizeRangeDate(req.query.ending_date, {
          endOfDay: true,
        });

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      }

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      const matchConditions = [{ branch_id: { $in: branchIds } }, reportableSales()];

      if (Object.keys(dateFilter).length) {
        matchConditions.push({ updated_date: dateFilter });
      }

      const licenseId = req.user?.license || req.user?.licenseId;
      if (licenseId) {
        matchConditions.push({
          license: mongoose.Types.ObjectId.isValid(String(licenseId))
            ? new mongoose.Types.ObjectId(String(licenseId))
            : licenseId,
        });
      }

      const requestedSupplierIdInput = normalizeToMongooseId(
        req.query.field_input || req.query.supplier_id || req.query.supplierId
      );
      const requestedSupplierId =
        requestedSupplierIdInput && requestedSupplierIdInput.toString
          ? requestedSupplierIdInput.toString()
          : null;

      const match = matchConditions.length > 1 ? { $and: matchConditions } : matchConditions[0];

      const SaleModel = this.model || Sale;

      const { total, list: rawList } = await salesService.getSupplierSalesReportTableData(
        { match, skip, limit, requestedSupplierId },
        { SaleModel }
      );

      const list = rawList.map((entry) => ({
        supplier_id: entry.supplier_id || null,
        name: entry.supplier_name || '',
        total_amount: roundToTwo(entry.total_amount || 0),
        sales_avg: roundToTwo(entry.sales_avg || 0),
        sales_count: entry.sales_count || 0,
        item_quantity: roundToTwo(entry.item_quantity || 0),
        sales_profit: roundToTwo(entry.sales_profit || 0),
      }));

      return this.success(
        res,
        {
          total,
          total_pages: Math.ceil(total / limit) || 0,
          current_page: page,
          per_page: limit,
          list,
        },
        'Supplier sales report retrieved successfully'
      );
    } catch (error) {
      console.error('Error in supplierSalesReportTable:', error);
      return this.error(res, 'Unable to load supplier sales report. Please try again later.', 500, {
        error: error.message,
      });
    }
  }

  async customerSalesReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let limit;
      let page;
      let skip;
      const dateFilter = {};

      if (req.reportParams && typeof req.reportParams.limit === 'number') {
        ({ limit, page, skip } = req.reportParams);
        const { startDate, endDate } = req.reportParams;

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      } else {
        const limitCandidate = parseInt(req.query.limit, 10);
        const pageCandidate = parseInt(req.query.page, 10);
        limit = limitCandidate > 0 ? limitCandidate : 5;
        page = pageCandidate > 0 ? pageCandidate : 1;
        skip = (page - 1) * limit;

        const normalizeRangeDate = (value, { endOfDay = false } = {}) => {
          if (!value) return null;
          const parsed = parseSaleDate(value);
          if (!parsed) return null;
          const normalized = new Date(parsed);
          normalized.setHours(0, 0, 0, 0);
          if (endOfDay) {
            normalized.setHours(23, 59, 59, 999);
          }
          return normalized;
        };

        const startDate = normalizeRangeDate(req.query.starting_date);
        const endDate = normalizeRangeDate(req.query.ending_date, {
          endOfDay: true,
        });

        // Apply session filtering if user has permission and dates are provided
        if (startDate || endDate) {
          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Use filtered dates
          const filteredStartDate = filteredDateRange.start_date;
          const filteredEndDate = filteredDateRange.end_date;

          if (filteredStartDate) {
            dateFilter.$gte = filteredStartDate;
          }
          if (filteredEndDate) {
            dateFilter.$lte = filteredEndDate;
          }
        } else {
          if (startDate) {
            dateFilter.$gte = startDate;
          }
          if (endDate) {
            dateFilter.$lte = endDate;
          }
        }
      }

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      const matchConditions = [
        {
          $or: [
            { branch: { $in: branchIds } },
            { branch_id: { $in: branchIds } },
            { branchId: { $in: branchIds } },
            { 'branch._id': { $in: branchIds } },
          ],
        },
        reportableSales(),
        { status: { $ne: SALE_STATUS.CANCELLED } },
      ];

      if (Object.keys(dateFilter).length) {
        matchConditions.push({
          $or: [
            { updatedAt: dateFilter },
            { createdAt: dateFilter },
            { updated_date: dateFilter },
            { date: dateFilter },
          ],
        });
      }

      const requestedCustomerId = normalizeToMongooseId(
        req.query.field_input || req.query.customer_id
      );
      if (requestedCustomerId) {
        matchConditions.push({
          $or: [
            { customer: requestedCustomerId },
            { customer_id: requestedCustomerId },
            { customerId: requestedCustomerId },
            { 'customer._id': requestedCustomerId },
          ],
        });
      }

      const match = matchConditions.length > 1 ? { $and: matchConditions } : matchConditions[0];

      const SaleModel = this.model || Sale;

      const { total, list: rawList } = await salesService.getCustomerSalesReportTableData(
        { match, skip, limit },
        { SaleModel }
      );

      const formatId = (value) => {
        if (!value && value !== 0) {
          return null;
        }
        if (typeof value === 'string') {
          return value;
        }
        if (value && typeof value === 'object' && value.toString) {
          return value.toString();
        }
        return String(value);
      };

      const list = rawList.map((entry) => ({
        customer_id: formatId(entry._id?.customer_id || null),
        customer_name: entry._id?.customer_name || '',
        customer_phone: entry._id?.customer_phone || '',
        sales_payment: roundToTwo(entry.sales_payment || 0),
        refund_payment: roundToTwo(entry.refund_payment || 0),
        sales_count: entry.sales_count || 0,
        sales_avg: roundToTwo(entry.sales_avg || 0),
      }));

      return this.success(
        res,
        {
          total,
          total_pages: Math.ceil(total / limit) || 0,
          current_page: page,
          per_page: limit,
          list,
        },
        'Customer sales report retrieved successfully'
      );
    } catch (error) {
      console.error('Error in customerSalesReportTable:', error);
      return this.error(res, 'Unable to load customer sales report. Please try again later.', 500, {
        error: error.message,
      });
    }
  }

  /**
   * Legacy endpoint: GET /sales/itemGraphicalReports
   * Returns top 5 selling items (quantity + amount string) for the date range.
   */
  async itemGraphicalReports(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const statuses = [...GRAPH_ALLOWED_SALE_PROCESSES, 'FullReturn'];

      const { branchIds, error: branchError } = this.extractBranchObjectIds(req);
      if (branchError) {
        return this.error(res, branchError, 400);
      }

      let startDate;
      let endDate;

      if (req.reportParams && (req.reportParams.startDate || req.reportParams.endDate)) {
        startDate = req.reportParams.startDate || null;
        endDate = req.reportParams.endDate || null;
      } else {
        startDate = normalizeRangeDate(req.query.starting_date);
        endDate = normalizeRangeDate(req.query.ending_date, {
          endOfDay: true,
        });
      }

      // Apply session filtering if user has permission and dates are provided
      if (startDate || endDate) {
        const originalDateRange = {
          start_date: startDate || new Date(0),
          end_date: endDate || new Date(),
        };

        const filteredDateRange = await sessionFilterUtil.applySessionFilter(
          req,
          originalDateRange
        );

        // Use filtered dates
        startDate = filteredDateRange.start_date;
        endDate = filteredDateRange.end_date;
      }

      const dateFilter = {};
      if (startDate) {
        dateFilter.$gte = startDate;
      }
      if (endDate) {
        dateFilter.$lte = endDate;
      }

      const matchConditions = [
        {
          $or: [
            { branch: { $in: branchIds } },
            { branch_id: { $in: branchIds } },
            { branchId: { $in: branchIds } },
            { 'branch._id': { $in: branchIds } },
          ],
        },
        { ...reportableSales(statuses) },
        { status: { $ne: SALE_STATUS.CANCELLED } },
      ];

      if (Object.keys(dateFilter).length) {
        matchConditions.push({
          $or: [
            { updatedAt: dateFilter },
            { createdAt: dateFilter },
            { updated_date: dateFilter },
            { date: dateFilter },
          ],
        });
      }

      const match = matchConditions.length > 1 ? { $and: matchConditions } : matchConditions[0];

      const SaleModel = this.model || Sale;

      const results = await salesService.getItemGraphicalReportsData({ match }, { SaleModel });

      const currencySymbol =
        req.user?.settings?.currency_symbol ||
        req.user?.settings?.currency ||
        req.user?.branch?.currency ||
        req.user?.branch?.currency_type ||
        'EGP';

      const formatted = results.map((entry) => {
        const total = roundToTwo(entry.total_amount || 0);
        const qty = roundToTwo(entry.total_qty || 0);
        return {
          name: entry._id || 'Unnamed Item',
          amount: `${currencySymbol} ${total.toFixed(2)} (Quantity: ${qty})`,
        };
      });

      return this.success(res, formatted, 'Item graphical report retrieved successfully');
    } catch (error) {
      console.error('Error in itemGraphicalReports:', error);
      return this.error(res, 'Failed to load item graphical report. Please try again later.', 500);
    }
  }

  extractBranchObjectIds(req) {
    const parseBranchValue = (value) => {
      if (value === undefined || value === null || value === '') {
        return [];
      }
      if (Array.isArray(value)) {
        return value.flatMap((entry) => parseBranchValue(entry));
      }
      if (typeof value === 'object') {
        const candidates = [
          value.branch_id,
          value.branchId,
          value._id,
          value.id,
          value.$oid,
        ].filter(Boolean);
        return candidates.map((entry) => String(entry));
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
          return [];
        }
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || trimmed.includes(',')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              return parsed.flatMap((entry) => parseBranchValue(entry));
            }
          } catch {
            return trimmed
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean);
          }
        }
        return [trimmed];
      }
      return [String(value)];
    };

    const branchInputs = [
      req?.query?.branch,
      req?.query?.['branch[]'],
      req?.query?.branch_id,
      req?.query?.branchId,
    ];

    let branchIds = branchInputs
      .flatMap((value) => parseBranchValue(value))
      .filter((value) => typeof value === 'string' && value.trim());

    if (!branchIds.length) {
      const fallbackBranch = resolveBranchId(req.user, req.session);
      if (fallbackBranch) {
        branchIds = [String(fallbackBranch)];
      }
    }

    const normalized = [...new Set(branchIds.map((id) => id.trim()).filter(Boolean))];

    if (!normalized.length) {
      return { branchIds: [], error: 'At least one branch id is required' };
    }

    const validBranchIds = normalized
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (!validBranchIds.length) {
      return { branchIds: [], error: 'No valid branch ids provided' };
    }

    return { branchIds: validBranchIds };
  }

  async holdSale(req, res, next) {
    try {
      if (!this.checkPermission('sales', 'write', req.user)) {
        return this.error(res, 'You do not have permission to hold sales', 403);
      }

      const { customer_name: customerName, items } = req.body || {};

      if (!customerName || !customerName.trim()) {
        return this.error(res, ERROR_MESSAGES.CUSTOMER_NAME_REQUIRED, 400);
      }

      if (!Array.isArray(items) || items.length === 0) {
        return this.error(res, 'At least one item is required to put a sale on hold', 400);
      }

      return this.createOrHoldInternal(req, res, next, {
        processOverride: 'Hold',
        successMessage: SUCCESS_MESSAGES.SALE_HOLD_SUCCESS,
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Get user sales report table data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async userReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let options;
      let data;

      if (req.userReportParams && req.userReportParams.options && req.userReportParams.data) {
        options = req.userReportParams.options;
        data = req.userReportParams.data;

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } else {
        }
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
          user_id: req.query.field_input || '',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } else {
        }
      }

      const SaleModel = this.model || Sale;

      // Delegate to service wrapper so controller does not talk to model directly
      const result = await salesService.userReportPage(data, options, {
        SaleModel,
      });

      if (result.status === true) {
        // Model already returns properly formatted data, no need for mongoIDFilter
        const list = result.list || [];

        // Ensure pagination has proper values (no NaN)
        const pagination = result.pagination || {};
        const total = pagination.total || 0;
        // limit and page are const-declared inside an else block further up, so
        // they are not in scope here - this fell back to a ReferenceError
        // rather than to a default. options carries the same two values and
        // is declared in the enclosing scope.
        const currentLimit = pagination.limit || options?.limit || 5;
        const safePages = Math.max(Math.ceil(total / currentLimit), 1);

        // PHP format: flatten pagination to top level
        return this.success(
          res,
          {
            total,
            summary: result.summary,
            current_page: pagination.page || options?.page || 1,
            total_pages: safePages,
            per_page: currentLimit,
            list,
          },
          list.length > 0 ? SUCCESS_MESSAGES.GET_SUCCESSFULLY : SUCCESS_MESSAGES.NO_RECORDS_FOUND
        );
      } else {
        // Even on error, return empty list with PHP format
        return this.success(
          res,
          {
            total: 0,
            current_page: options.page,
            total_pages: 0,
            per_page: options.limit,
            list: [],
          },
          SUCCESS_MESSAGES.NO_RECORDS_FOUND
        );
      }
    } catch (error) {
      console.error('Error in SalesController.userReportTable:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_USER_SALES_REPORT_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Get user graphical reports data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async userGraphicalReports(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        branchid: Array.isArray(branches) ? branches : [branches],
        starting_date: req.query.starting_date || '',
        ending_date: req.query.ending_date || '',
        user_id: req.query.field_input || '',
      };

      // Apply session filtering if user has permission and dates are provided
      if (data.starting_date || data.ending_date) {
        const startDate = data.starting_date ? new Date(data.starting_date) : null;
        const endDate = data.ending_date ? new Date(data.ending_date) : null;

        const originalDateRange = {
          start_date: startDate || new Date(0),
          end_date: endDate || new Date(),
        };

        const filteredDateRange = await sessionFilterUtil.applySessionFilter(
          req,
          originalDateRange
        );

        // Update data with filtered dates
        data.starting_date = filteredDateRange.start_date;
        data.ending_date = filteredDateRange.end_date;
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.getUserGraphicalReports(data, {
        SaleModel,
      });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, result.message, 404, result.data);
      }
    } catch (error) {
      console.error('Error in SalesController.userGraphicalReports:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_USER_GRAPHICAL_REPORTS_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Get return sales report table data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async returnSalesReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let options;
      let data;

      if (
        req.branchPaginatedReportParams &&
        req.branchPaginatedReportParams.options &&
        req.branchPaginatedReportParams.data
      ) {
        ({ options, data } = req.branchPaginatedReportParams);
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        }
      }

      const SaleModel = this.model || Sale;

      data.license = req.user.license || req.user.licenseId;
      data.search =
        typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
      data.customer = req.query.customerLookup;
      options.sort = req.query.sort;
      const result = await salesService.returnSalesReportPage(data, options, {
        SaleModel,
      });
      return this.formatReportResponse(res, result, options);
    } catch (error) {
      console.error('Error in SalesController.returnSalesReportTable:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_RETURN_SALES_REPORT_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Get product based return details data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async productBasedReturnDetails(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = { limit, page };

      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        branchid: Array.isArray(branches) ? branches : [branches],
        starting_date: req.query.starting_date || '',
        ending_date: req.query.ending_date || '',
      };

      const SaleModel = this.model || Sale;
      const result = await salesService.productBasedReportPage(data, options, {
        SaleModel,
      });

      if (result.status === true) {
        const pagination = result.pagination || {};
        const list = this.mongoIDFilter(result.list || []);
        const payload = {
          status: true,
          total: pagination.total || 0,
          current_page: pagination.page || page,
          total_pages:
            pagination.pages ||
            Math.max(Math.ceil((pagination.total || 0) / (pagination.limit || limit || 1)), 1),
          per_page: pagination.limit || limit,
          list,
        };

        return this.success(
          res,
          payload,
          list.length ? SUCCESS_MESSAGES.GET_SUCCESSFULLY : SUCCESS_MESSAGES.NO_RECORDS_FOUND
        );
      } else {
        return this.error(res, ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 404, result);
      }
    } catch (error) {
      console.error('Error in SalesController.productBasedReturnDetails:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_PRODUCT_BASED_RETURN_DETAILS_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Filter MongoDB ObjectIDs to strings (similar to PHP MongoIDFilter)
   * @param {Array} data - Array of documents to filter
   * @returns {Array} - Filtered array with ObjectIDs converted to strings
   */
  mongoIDFilter(data) {
    if (!Array.isArray(data)) return data;

    const serializeValue = (value) => {
      if (value === null || value === undefined) {
        return value;
      }

      // Dates -> Mongo extended JSON
      if (value instanceof Date) {
        return {
          $date: {
            $numberLong: value.getTime().toString(),
          },
        };
      }

      // ObjectId-like instances
      if (
        value &&
        typeof value === 'object' &&
        value.constructor &&
        value.constructor.name === 'ObjectId' &&
        typeof value.toString === 'function'
      ) {
        return value.toString();
      }

      if (Array.isArray(value)) {
        return value.map((entry) => serializeValue(entry));
      }

      if (typeof value === 'object') {
        const output = {};
        Object.keys(value).forEach((key) => {
          if (key === '_id' && value[key] && typeof value[key].toString === 'function') {
            output[key] = value[key].toString();
          } else {
            output[key] = serializeValue(value[key]);
          }
        });
        return output;
      }

      return value;
    };

    return data.map((item) => serializeValue({ ...item }));
  }

  /**
   * Get pending sales report table data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async pendingSalesReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let options;
      let data;

      if (
        req.branchPaginatedReportParams &&
        req.branchPaginatedReportParams.options &&
        req.branchPaginatedReportParams.data
      ) {
        ({ options, data } = req.branchPaginatedReportParams);
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        }
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.pendingSalesReportPage(data, options, {
        SaleModel,
      });
      return this.formatReportResponse(res, result, options);
    } catch (error) {
      console.error('Error in SalesController.pendingSalesReportTable:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_PENDING_SALES_REPORT_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Get pending customer report table data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async pendingCustomerReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let options;
      let data;

      if (
        req.branchPaginatedReportParams &&
        req.branchPaginatedReportParams.options &&
        req.branchPaginatedReportParams.data
      ) {
        ({ options, data } = req.branchPaginatedReportParams);
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        }
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.pendingCustomerReportPage(data, options, { SaleModel });
      return this.formatReportResponse(res, result, options);
    } catch (error) {
      console.error('Error in SalesController.pendingCustomerReportTable:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_PENDING_CUSTOMER_REPORT_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Get payment sales transaction report table data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async paymentSalesTranscationReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let options;
      let data;

      if (
        req.paymentReportParams &&
        req.paymentReportParams.options &&
        req.paymentReportParams.data
      ) {
        ({ options, data } = req.paymentReportParams);

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } else {
        }
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        // Handle both 'branch' and 'branch[]' query params
        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
          payment_mode: req.query.payment_mode || 'All',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } else {
        }
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.paymentSalesTransactionReportPage(data, options, {
        SaleModel,
      });
      return this.formatReportResponse(res, result, options);
    } catch (error) {
      console.error('Error in SalesController.paymentSalesTranscationReportTable:', error);
      return this.error(
        res,
        'Failed to retrieve payment sales transaction report: ' + error.message,
        500
      );
    }
  }

  /**
   * Get payment sale type report data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async paymentSaleTypeReport(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let data;

      if (req.branchReportParams && req.branchReportParams.data) {
        ({ data } = req.branchReportParams);

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } else {
        }
      } else {
        // Handle both 'branch' and 'branch[]' query params
        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } else {
        }
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.getPaymentSaleTypeReport(data, {
        SaleModel,
      });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, result.message, 404, result.data);
      }
    } catch (error) {
      console.error('Error in SalesController.paymentSaleTypeReport:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_PAYMENT_SALE_TYPE_REPORT_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * Get payment return sales transaction report table data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async paymentReturnSalesTranscationReportTable(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      let options;
      let data;

      if (
        req.paymentReportParams &&
        req.paymentReportParams.options &&
        req.paymentReportParams.data
      ) {
        ({ options, data } = req.paymentReportParams);
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        // Handle both 'branch' and 'branch[]' query params
        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date || '',
          ending_date: req.query.ending_date || '',
          payment_mode: req.query.payment_mode || 'All',
        };

        // Apply session filtering if user has permission and dates are provided
        if (data.starting_date || data.ending_date) {
          const startDate = data.starting_date ? new Date(data.starting_date) : null;
          const endDate = data.ending_date ? new Date(data.ending_date) : null;

          const originalDateRange = {
            start_date: startDate || new Date(0),
            end_date: endDate || new Date(),
          };

          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        }
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.paymentReturnSalesTranscationReportTable(data, options, {
        SaleModel,
      });
      return this.formatReportResponse(res, result, options);
    } catch (error) {
      console.error('Error in SalesController.paymentReturnSalesTranscationReportTable:', error);
      return this.error(
        res,
        'Failed to retrieve payment return sales transaction report: ' + error.message,
        500
      );
    }
  }

  /**
   * Get payment graphical reports data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async paymentGraphicalReports(req, res) {
    try {
      if (!this.checkPermission('report', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        branchid: Array.isArray(branches) ? branches : [branches],
        starting_date: req.query.starting_date || '',
        ending_date: req.query.ending_date || '',
      };

      // Apply session filtering if user has permission and dates are provided
      if (data.starting_date || data.ending_date) {
        const startDate = data.starting_date ? new Date(data.starting_date) : null;
        const endDate = data.ending_date ? new Date(data.ending_date) : null;

        const originalDateRange = {
          start_date: startDate || new Date(0),
          end_date: endDate || new Date(),
        };

        const filteredDateRange = await sessionFilterUtil.applySessionFilter(
          req,
          originalDateRange
        );

        // Update data with filtered dates
        data.starting_date = filteredDateRange.start_date;
        data.ending_date = filteredDateRange.end_date;
      }

      const SaleModel = this.model || Sale;

      const result = await salesService.getPaymentGraphicalReports(data, {
        SaleModel,
      });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, result.message, 404, result.data);
      }
    } catch (error) {
      console.error('Error in SalesController.paymentGraphicalReports:', error);
      return this.error(
        res,
        ERROR_MESSAGES.FAILED_TO_RETRIEVE_PAYMENT_GRAPHICAL_REPORTS_PREFIX + error.message,
        500
      );
    }
  }

  /**
   * PHP: getCustomerPrint()
   * Get customer print details for receipt/invoice
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async getCustomerPrint(req, res) {
    try {
      let salesId = req.query.customer_id || req.query.id || req.params.id;

      if (!salesId) {
        return this.error(res, ERROR_MESSAGES.SALES_ID_REQUIRED, 400);
      }

      // The customer receipt link (customersMailPrint.html?id=...) carries an
      // AES-encrypted id (matching PHP getCustomerPrintDetails). Decrypt it back
      // to the real Mongo ObjectId before lookup. A plain ObjectId is passed
      // through unchanged so direct calls still work.
      if (!mongoose.Types.ObjectId.isValid(salesId)) {
        try {
          const Encryption = require('../utils/encryption');
          const decrypted = Encryption.decryptId(salesId);
          if (decrypted) salesId = decrypted;
        } catch (e) {
          console.error('getCustomerPrint: failed to decrypt id:', e.message);
        }
      }

      const SaleModel = this.model || Sale;

      // Get sale with full details via service helper
      const sale = await salesService.getSaleForCustomerPrint(salesId, {
        SaleModel,
      });

      if (!sale) {
        return this.error(res, ERROR_MESSAGES.SALE_NOT_FOUND, 404);
      }

      // Format print details - must match PHP getCustomerPrintDetails() exactly,
      // because the frontend (customer_mail.js) reads these precise field names
      // and calls .toFixed()/loops on them. A missing field (e.g. sales_sub_total)
      // throws in the browser and blanks the whole receipt below the header.
      const moment = require('moment-timezone');
      const branch = sale.branch_id || {};
      const tz = branch.time_zone || 'Africa/Cairo';
      const saleMoment = sale.date ? moment(sale.date).tz(tz) : null;
      const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v) || 0);

      const branchDetails = {
        branch_image: branch.logo,
        branch_name: branch.branch_name,
        branch_address: branch.store_address,
        branch_phone: branch.store_telephone,
        branch_email: branch.store_email,
        branch_currency: branch.currency_type,
      };

      const salesDetails = {
        sales_id: sale.sales_id,
        customer_name: sale.customer_name,
        customer_address: sale.customer_address,
        customer_phone: sale.customer_phone,
        customer_email: sale.customer_email,
        date: saleMoment ? saleMoment.format('DD-MMM-YYYY') : '',
        time: saleMoment ? saleMoment.format('hh:mm a') : '',
        payment_mode: sale.payment_mode,
        total_amount: num(sale.sales_total),
        sales_sub_total: num(sale.sales_sub_total),
        total_items: parseInt(sale.number_of_items, 10) || (sale.items || []).length,
        discount: num(sale.discount),
        items: sale.items || [], // raw items, exactly as PHP returns $sale['items']
        payment_status: sale.payment_status,
        partial_balance: num(sale.partial_balance),
        payment_pending: num(sale.payment_pending),
        partial_check: sale.partial_check,
        round_off: Math.round(num(sale.round_off) * 100) / 100,
      };

      const printDetails = { ...branchDetails, ...salesDetails };

      return this.success(res, printDetails, 'success');
    } catch (error) {
      console.error('Error in getCustomerPrint:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: salesPdf()
   * Generate PDF invoice for viewing/downloading
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async salesPdf(req, res) {
    try {
      if (!this.checkPermission('sales', 'read', req.user)) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const id = req.query?.id;
      if (!id) {
        return this.error(res, ERROR_MESSAGES.SALE_ID_IS_REQUIRED, 400);
      }

      const { generateInvoicePDF } = require('../utils/pdfGenerator');

      const SaleModel = this.model || Sale;

      // Get sale details via service helper
      const sale = await salesService.getSaleForPdf(id, { SaleModel });

      if (!sale) {
        return this.error(res, ERROR_MESSAGES.SALE_NOT_FOUND, 404);
      }

      // Get branch/store details via existing service helper
      const branchId = sale.branch || sale.branch_id || sale.branchId;
      const branch = branchId ? await salesService.getBranchById(branchId) : null;

      // Generate PDF using reusable utility
      generateInvoicePDF({
        data: sale,
        branch: branch,
        res: res,
        wording: await require('../services/document-wording').loadDocumentWording({
          document: sale,
          branchId,
          licenseId: sale.license,
          locale: 'en',
        }),
        config: {
          title: 'Sales Invoice.',
          idField: 'sales_id',
          itemsField: 'items',
          customerField: 'customer',
          dateField: 'date',
        },
      });
    } catch (error) {
      console.error('Error in salesPdf:', error);
      return this.error(res, ERROR_MESSAGES.UNABLE_TO_GENERATE_PDF, 500, { error: error.message });
    }
  }

  /**
   * PHP: returnSales()
   * Process sales return
   */
  async returnSales(req, res) {
    try {
      const userAccess = req.user?.access?.sales?.write;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // Refund enforcement (mirrors the void gate). Require a valid manager
      // approval token when this user can't refund on their own; fails open for
      // unconfigured users so existing tills keep working.
      if (!canPos(req.user, 'refund')) {
        const approved = isApprovedFor(
          req.body && req.body.approval_token,
          'refund',
          req.user && req.user._id
        );
        if (!approved) {
          return this.error(res, 'A refund needs manager approval', 403);
        }
      }

      await this.ensureContext(req);

      const data = req.body;
      const SaleModel = this.model || Sale;
      const result = await salesService.returnSalesOrder(data, {
        SaleModel,
        deviceId: getRequestDeviceId(req),
      });

      if (result.status === true) {
        const returnedItems = Array.isArray(result.data?.returned_items)
          ? result.data.returned_items
          : [];
        const refundAmount = auditNumber(result.data?.return_amount);
        const refundReason =
          result.data?.refund_reason ||
          data.reason ||
          data.sales_description ||
          data.payment_description ||
          '';
        const auditSaleId =
          data.sales_id ||
          data.id ||
          data.sale_id ||
          data.sales_document_id ||
          result.data?.sale_id ||
          '';

        await writeSaleAudit(
          req,
          'refund',
          auditSaleId,
          `Refund processed${result.data?.return_id ? ` (${result.data.return_id})` : ''}`,
          {
            return_id: result.data?.return_id || '',
            amount: refundAmount,
            reason: refundReason,
            items: returnedItems,
          }
        );

        return this.success(res, result.data, SUCCESS_MESSAGES.RETURN_SALES_UPDATED_SUCCESSFULLY);
      } else {
        return this.error(res, result.message, result.statusCode || 404);
      }
    } catch (error) {
      console.error('Error in returnSales:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: exportSales()
   * Export sales data
   */
  async exportSales(req, res) {
    try {
      const userAccess = req.user?.access?.sales?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      await this.ensureContext(req);

      // Frontend sends JSON.stringify(selectedTableRow) which is an array: ["id1", "id2", "id3"]
      // Express body-parser with application/json parses this into req.body as an array
      let ids;

      if (req.method === 'POST') {
        // Check if body is array FIRST (most common case from frontend)
        if (Array.isArray(req.body)) {
          ids = req.body;
        } else if (req.body?.data) {
          ids = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
        } else if (typeof req.body === 'string') {
          // In case body-parser didn't parse it
          try {
            ids = JSON.parse(req.body);
          } catch (e) {
            ids = req.body;
          }
        } else if (req.body && typeof req.body === 'object') {
          // Body is an object but not array - might be single ID or wrapped format
          const keys = Object.keys(req.body);
          if (keys.length > 0) {
            // Try to extract IDs from object values
            ids = Object.values(req.body);
          } else {
            ids = [];
          }
        } else {
          ids = [];
        }
      } else if (req.method === 'GET' && req.query) {
        // GET: parse from query params
        if (req.query.data) {
          try {
            ids = typeof req.query.data === 'string' ? JSON.parse(req.query.data) : req.query.data;
          } catch (e) {
            ids = req.query.data;
          }
        } else if (req.query.ids) {
          try {
            ids = typeof req.query.ids === 'string' ? JSON.parse(req.query.ids) : req.query.ids;
          } catch (e) {
            ids = req.query.ids;
          }
        }
      }

      if (!ids || (Array.isArray(ids) && ids.length === 0)) {
        return this.error(res, ERROR_MESSAGES.NO_SALES_IDS_FOR_EXPORT, 400);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.exportSalesOrder(ids, { SaleModel });

      if (result.status === true) {
        // Frontend expects an array of objects and generates CSV client-side.
        return this.success(res, result.data, SUCCESS_MESSAGES.SALES_EXPORTED);
      }

      return this.error(res, ERROR_MESSAGES.SALES_EXPORTED_UNSUCCESSFULLY, 404);
    } catch (error) {
      console.error('Error in exportSales:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: getDataChanges()
   * Get data changes for synchronization
   */
  async getDataChanges(req, res) {
    try {
      const from = req.query.from || '';
      const SaleModel = this.model || Sale;
      const result = await salesService.getSalesDataChanges(from, { SaleModel });

      if (result.status === true) {
        return this.success(res, result.data, SUCCESS_MESSAGES.CHANGES_RETRIEVED);
      } else {
        return res.status(200).json({
          type: 'error',
          message: ERROR_MESSAGES.NOT_VALID_INPUT,
          data: result.data,
        });
      }
    } catch (error) {
      console.error('Error in getDataChanges:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: getReturnSalesDetails()
   * Get return sales details
   */
  async getReturnSalesDetails(req, res) {
    try {
      const userAccess = req.user?.access?.sales?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      await this.ensureContext(req);

      const salesId = req.query.id;
      const SaleModel = this.model || Sale;
      const result = await salesService.getReturnSalesDetails(salesId, {
        SaleModel,
      });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, result.message, 404);
      }
    } catch (error) {
      console.error('Error in getReturnSalesDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: returnPrintDetails()
   * Get return print details
   */
  async returnPrintDetails(req, res) {
    try {
      await this.ensureContext(req);

      const id = req.query.id;
      const SaleModel = this.model || Sale;
      const result = await salesService.getReturnPrintDetails(id, { SaleModel });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, result.message, 404);
      }
    } catch (error) {
      console.error('Error in returnPrintDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: getSalesAjaxList()
   * Get sales list for autocomplete
   */
  async getSalesAjaxList(req, res) {
    try {
      const query = req.query.query || '';
      const SaleModel = this.model || Sale;
      const result = await salesService.getSalesAjaxList(query, { SaleModel });

      if (result.status === true) {
        return res.status(200).json({
          query: query,
          suggestions: result.data,
        });
      } else {
        return this.error(res, ERROR_MESSAGES.SALES_NOT_FOUND_ALT, 404);
      }
    } catch (error) {
      console.error('Error in getSalesAjaxList:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: getSaleQtyDetail()
   * Get sale quantity detail
   */
  async getSaleQtyDetail(req, res) {
    try {
      const id = req.query.sale_id;
      if (!id) {
        return this.error(res, ERROR_MESSAGES.SALE_ID_REQUIRED_CAP, 400);
      }

      const userAccess = req.user?.access?.sales?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.getSaleQtyDetail(id, { SaleModel });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, result.message, 404);
      }
    } catch (error) {
      console.error('Error in getSaleQtyDetail:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: ServerStatus()
   * Server status check
   */
  async ServerStatus(req, res) {
    return res.status(200).json({
      type: 'success',
      message: SUCCESS_MESSAGES.SERVER_IS_RUNNING,
      data: true,
    });
  }

  /**
   * PHP: customerSaleDetails()
   * Get customer sale details
   */
  async customerSaleDetails(req, res) {
    try {
      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = { limit, page, sort: { _id: 1 } };

      // Legacy frontend sends branch as `branch[]=`; newer code may send `branch` or `branch_id`
      const branchParam =
        req.query.branch ||
        req.query['branch[]'] ||
        req.query.branch_id ||
        req.query['branch_id[]'] ||
        null;

      const branchIds = Array.isArray(branchParam) ? branchParam : branchParam ? [branchParam] : [];

      const data = {
        customer_id: req.query.customer_id,
        branchid: branchIds,
      };

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.customerSaleDetailsPage(data, options, { SaleModel });

      if (result.status === true) {
        // PHP line 2767-2768: Apply MongoIDFilter + MongoDateFilter
        if (result.data?.table?.data?.list) {
          result.data.table.data.list = this.mongoDateFilter(result.data.table.data.list);
        }
        return this.success(res, result.data, result.message);
      } else {
        // Preserve model message when available for easier debugging
        const message = result.message || ERROR_MESSAGES.DETAILS_NOT_FOUND;
        return this.error(res, message, 404);
      }
    } catch (error) {
      console.error('Error in customerSaleDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: customerCategorySaleDetails()
   * Get customer category sale details
   */
  async customerCategorySaleDetails(req, res) {
    try {
      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = { limit, page, sort: { _id: 1 } };

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        category_id: req.query.category_id,
        branchid: Array.isArray(branches) ? branches : [branches],
      };

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.customerCategorySaleDetailsPage(data, options, {
        SaleModel,
      });

      if (result.status === true) {
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, ERROR_MESSAGES.DETAILS_NOT_FOUND, 404);
      }
    } catch (error) {
      console.error('Error in customerCategorySaleDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: itemSaleDetails()
   * Get item sale details
   */
  async itemSaleDetails(req, res) {
    try {
      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = { limit, page, sort: { _id: 1 } };

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        item_id: req.query.item_id,
        branchid: Array.isArray(branches) ? branches : [branches],
      };

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.itemSaleDetailsPage(data, options, {
        SaleModel,
      });

      if (result.status === true) {
        // Normalize string_date for frontend Item Details Activities table,
        // similar to categorySaleDetails. Use the stored sale date when
        // available instead of any fallback/current time.
        if (result.data?.table?.data?.list) {
          result.data.table.data.list = result.data.table.data.list.map((sale) => {
            const saleDate = sale.date || sale.updated_date || new Date();
            const dateObj = saleDate instanceof Date ? saleDate : new Date(saleDate);

            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            const year = dateObj.getFullYear();
            let hours = dateObj.getHours();
            const minutes = String(dateObj.getMinutes()).padStart(2, '0');
            const ampm = hours >= 12 ? 'pm' : 'am';
            hours = hours % 12 || 12;

            return {
              ...sale,
              string_date: `${month}/${day}/${year} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`,
            };
          });
        }
        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, ERROR_MESSAGES.DETAILS_NOT_FOUND, 404);
      }
    } catch (error) {
      console.error('Error in itemSaleDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: categorySaleDetails()
   * Get category sale details
   */
  async categorySaleDetails(req, res) {
    try {
      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = { limit, page, sort: { _id: 1 } };

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        category_id: req.query.category_id,
        branchid: Array.isArray(branches) ? branches : [branches],
      };

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const result = await salesService.categorySaleDetailsPage(data, options, { SaleModel });

      if (result.status === true) {
        // Format the list dates to use stored date instead of current time
        if (result.data?.table?.data?.list) {
          result.data.table.data.list = result.data.table.data.list.map((sale) => {
            const saleDate = sale.date || sale.updated_date || new Date();
            const dateObj = saleDate instanceof Date ? saleDate : new Date(saleDate);

            // Format as MM/DD/YYYY HH:mm am/pm
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            const year = dateObj.getFullYear();
            let hours = dateObj.getHours();
            const minutes = String(dateObj.getMinutes()).padStart(2, '0');
            const ampm = hours >= 12 ? 'pm' : 'am';
            hours = hours % 12 || 12;

            return {
              ...sale,
              string_date: `${month}/${day}/${year} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`,
            };
          });
        }

        return this.success(res, result.data, result.message);
      } else {
        return this.error(res, ERROR_MESSAGES.DETAILS_NOT_FOUND, 404);
      }
    } catch (error) {
      console.error('Error in categorySaleDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: userSalesDetails()
   * Get user sales details
   */
  async userSalesDetails(req, res) {
    try {
      // PHP lines 2839-2843: Parse limit, page, and data
      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = {
        limit,
        page,
        license: req.user.license,
      };

      // Ensure branch is an array - handle both branch[] and branch formats
      let branchArray = [];

      // Check for branch[] format (e.g., branch[]=id1&branch[]=id2)
      if (req.query['branch[]']) {
        branchArray = Array.isArray(req.query['branch[]'])
          ? req.query['branch[]']
          : [req.query['branch[]']];
      }
      // Check for branch format (e.g., branch=id1 or branch=id1,id2)
      else if (req.query.branch) {
        branchArray = Array.isArray(req.query.branch) ? req.query.branch : [req.query.branch];
      }

      const data = {
        user_id: req.query.user_id,
        branchid: branchArray,
      };

      // PHP line 2844-2845: Check permission
      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // PHP line 2846: Call model method
      const SaleModel = this.model || Sale;
      const result = await salesService.userSalesDetailsPage(data, options, { SaleModel });

      // PHP lines 2847-2850: Apply filters and return success
      if (result.status === true) {
        // PHP line 2848: Apply MongoIDFilter
        if (result.data?.table?.data?.list) {
          result.data.table.data.list = this.mongoIDFilter(result.data.table.data.list);
          // PHP line 2849: Apply MongoDateFilter
          result.data.table.data.list = this.mongoDateFilter(result.data.table.data.list);
        }
        return this.success(res, result.data, result.message, 200);
      } else {
        // PHP line 2852: Return error
        return this.error(res, ERROR_MESSAGES.DETAILS_NOT_FOUND, 404, result.data);
      }
    } catch (error) {
      console.error('Error in userSalesDetails:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * PHP: pendingProductDetails()
   * Get pending product details
   */
  async pendingProductDetails(req, res) {
    try {
      const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
      const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
      const options = { limit, page };

      // Handle both 'branch' and 'branch[]' query params
      const branches = req.query['branch[]'] || req.query.branch || [];
      const data = {
        branchid: Array.isArray(branches) ? branches : [branches],
        sales_id: req.query.sales_id,
      };

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const response = await salesService.pendingProductReportPage(data, options, { SaleModel });

      if (response.status === true) {
        const { status: _ignoredStatus, ...payload } = response;
        return this.success(res, payload, SUCCESS_MESSAGES.GET_SUCCESSFULLY, 200);
      } else {
        return this.error(res, ERROR_MESSAGES.SALES_DETAILS_NOT_FOUND, 404);
      }
    } catch (error) {
      console.error('Error in pendingProductDetails:', error);
      return this.error(res, error.message, 500);
    }
  }
  /**
   * PHP: salesPaymentClose()
   * Close sales payment
   */
  async salesPaymentClose(req, res) {
    try {
      const userAccess = req.user?.access?.customer?.write;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      // Add context to request body
      const dataWithContext = {
        ...req.body,
        license: req.user?.license,
        branch_id: req.user?.branch_id,
        loggedUserName: req.user?.name,
        loggedUserId: req.user?._id,
      };

      const SaleModel = this.model || Sale;
      const response = await salesService.salesPaymentCloseModel(dataWithContext, { SaleModel });

      if (response.status === true) {
        return this.success(res, response.data, response.message);
      }

      /*
       * A CONFLICT IS NOT A MISSING ORDER.
       *
       * Somebody else saved this order while the caller was looking at it.
       * The order is there, the caller is welcome, and the request is simply
       * out of date - which is 409, not 404. The client keys on the status
       * rather than on the spelling of a message, so this stays true when
       * somebody rewords it.
       */
      if (response.message === 'order_changed') {
        return this.error(res, response.message, 409);
      }

      return this.error(res, response.message, 404);
    } catch (error) {
      console.error('Error in salesPaymentClose:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * Fetch the most recent sale for this branch.
   */
  async fetchLastSale(req, res) {
    try {
      const SaleModel = this.model || Sale;
      const response = await salesService.fetchLastSaleModel(req.body.branchId, { SaleModel });

      if (response.status === true) {
        return this.success(res, response.data, response.message);
      } else {
        return this.error(res, response.message, 404);
      }
    } catch (error) {
      console.error('Error in fetchLastSale:', error);
      return this.error(res, error.message, 500);
    }
  }

  // Receipt print queue shared by the till and the shop's cloud service.
  async claimPrintJobs(req, res) {
    try {
      const { claimPrintJobs } = require('../repositories/print-job.repository');
      const {
        pacingFor,
        waitForJob,
        worthHolding,
        seenOnTheFloor,
      } = require('../helpers/print-pace');

      const ask = {
        branchId: req.body.branchId,
        tillId: req.body.tillId || req.body.till_id || '',
        kind: req.body.kind || 'bill',
        limit: req.body.limit,
      };

      /* A till that is claiming jobs is, by definition, on the floor. The
         active-till signal is what this pace actually needs. */
      seenOnTheFloor(ask.branchId);
      let out = await claimPrintJobs(ask);
      if (out.status !== true) {
        return this.error(res, out.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG, 500);
      }

      // Hold only for an active till. An idle shop is answered immediately and
      // told to come back; an active till may receive a bill in the next few
      // seconds, so waiting beats polling again.
      const waitAsked = req.body.wait === true || req.body.wait === 'true';
      if (waitAsked && !(out.data || []).length && worthHolding(ask.branchId)) {
        const arrived = await waitForJob(ask.branchId);
        if (arrived) out = await claimPrintJobs(ask);
      }

      const jobs = this.mongoDateFilter(this.mongoIDFilter(out.data || []));
      return this.success(res, { jobs, poll: pacingFor(ask.branchId, jobs.length) }, 'success');
    } catch (error) {
      console.error('Error in claimPrintJobs:', error);
      return this.error(res, ERROR_MESSAGES.SOMETHING_WENT_WRONG, 500);
    }
  }

  async finishPrintJob(req, res) {
    try {
      const { finishPrintJob } = require('../repositories/print-job.repository');
      const out = await finishPrintJob(req.body.id || req.body.jobId, {
        ok: req.body.ok !== false,
        error: req.body.error || '',
      });
      if (out.status !== true) {
        return this.error(res, out.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG, 400);
      }
      return this.success(res, out.data, 'success');
    } catch (error) {
      console.error('Error in finishPrintJob:', error);
      return this.error(res, ERROR_MESSAGES.SOMETHING_WENT_WRONG, 500);
    }
  }

  /*
   * THE BILLS THAT NEVER CAME OUT, and the only screen that can say so.
   *
   * A job whose till took it and never reported back, or that failed its
   * attempts, is moved to `needs_attention` - "where a person decides", as the
   * queue's own comment puts it. There was no way for a person to decide:
   * `jobsNeedingAttention` and `resolveAttention` were written, exported, and
   * reachable from nowhere at all. So a bill a guest was waiting for sat in a
   * status nobody could read, and the counter's only clue was paper that never
   * arrived.
   *
   * Behind the same door the till already uses, because it is the till's own
   * Hardware Manager that shows it and the till already holds that key.
   */
  async printJobsNeedingAttention(req, res) {
    try {
      const { jobsNeedingAttention } = require('../repositories/print-job.repository');
      const out = await jobsNeedingAttention({
        branchId: req.body.branchId || req.query.branchId,
        limit: Number(req.body.limit) || 20,
      });
      if (out.status !== true) {
        return this.error(res, out.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG, 400);
      }
      /* Only what a person needs to decide: what it was, when, and why it is
         here. Never the payload - that is a whole bill, and this is a list. */
      const rows = (out.data || []).map((job) => ({
        id: String(job._id),
        label: String(job.label || ''),
        kind: String(job.kind || ''),
        at: job.created_at || null,
        attempts: Number(job.attempts) || 0,
        why: String(job.last_error || ''),
      }));
      return this.success(res, rows, 'success');
    } catch (error) {
      console.error('Error in printJobsNeedingAttention:', error);
      return this.error(res, ERROR_MESSAGES.SOMETHING_WENT_WRONG, 500);
    }
  }

  /**
   * A person answering "did this print?".
   *
   * `printed: true` closes it. Anything else puts it back on the queue, which
   * is the only kind of retry this design allows: a deliberate one, by
   * somebody who has looked at the printer and knows what came out of it.
   */
  async resolvePrintJob(req, res) {
    try {
      const { resolveAttention } = require('../repositories/print-job.repository');
      const out = await resolveAttention(req.body.id || req.body.jobId, {
        printed: req.body.printed === true || req.body.printed === 'true',
        by: req.body.by || '',
      });
      if (out.status !== true) {
        return this.error(res, out.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG, 400);
      }
      return this.success(res, out.data, out.message || 'success');
    } catch (error) {
      console.error('Error in resolvePrintJob:', error);
      return this.error(res, ERROR_MESSAGES.SOMETHING_WENT_WRONG, 500);
    }
  }

  /**
   * PHP: itemExpiryReportTable()
   * Get item expiry report
   */
  async itemExpiryReportTable(req, res) {
    try {
      // Build data/options from pre-normalised middleware output when present,
      // otherwise fall back to the legacy inline construction to avoid any
      // behaviour changes for direct/internal callers.
      let data;
      let options;

      if (
        req.itemExpiryReportParams &&
        req.itemExpiryReportParams.data &&
        req.itemExpiryReportParams.options
      ) {
        ({ data, options } = req.itemExpiryReportParams);
      } else {
        const limit = parseInt(req.query.limit, 10) > 0 ? parseInt(req.query.limit, 10) : 5;
        const page = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
        options = { limit, page };

        const branches = req.query['branch[]'] || req.query.branch || [];
        data = {
          branchid: Array.isArray(branches) ? branches : [branches],
          starting_date: req.query.starting_date,
          ending_date: req.query.ending_date,
        };
      }

      // Apply session filtering if user has permission and dates are provided
      if (data.starting_date || data.ending_date) {
        // Debug user permissions

        const startDate = data.starting_date ? new Date(data.starting_date) : null;
        const endDate = data.ending_date ? new Date(data.ending_date) : null;

        const originalDateRange = {
          start_date: startDate || new Date(0),
          end_date: endDate || new Date(),
        };

        try {
          const filteredDateRange = await sessionFilterUtil.applySessionFilter(
            req,
            originalDateRange
          );

          // Debug date comparison

          // Update data with filtered dates
          data.starting_date = filteredDateRange.start_date;
          data.ending_date = filteredDateRange.end_date;
        } catch (error) {
          throw error;
        }
      } else {
      }

      const userAccess = req.user?.access?.report?.read;
      if (userAccess !== true) {
        return this.error(res, ERROR_MESSAGES.UNAUTHORIZED, 403);
      }

      const SaleModel = this.model || Sale;
      const response = await salesService.itemExpiryReportPage(data, options, { SaleModel });

      if (response.status === true) {
        return res.status(200).json({
          type: 'success',
          message: SUCCESS_MESSAGES.GET_SUCCESSFULLY,
          data: {
            total: response.total,
            current_page: response.current_page,
            total_pages: response.total_pages,
            per_page: response.per_page,
            list: response.list,
          },
        });
      }
    } catch (error) {
      console.error('Error in itemExpiryReportTable:', error);
      return this.error(res, error.message, 500);
    }
  }

  /**
   * Cancel a sale
   * Frontend: PosnicPro.get('sales/cancel/' + saleId)
   * Sets the sale status to 'Cancelled' and reverses stock/wallet changes
   *
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async cancel(req, res) {
    try {
      const saleId = req.params.id;

      if (!this.checkPermission('sales', 'delete', req.user)) {
        return this.error(res, 'You do not have permission to cancel sales', 403);
      }

      await this.ensureContext(req);

      const SaleModel = this.model || Sale;
      const sale = await salesService.getSaleById(saleId, { SaleModel });

      if (!sale) {
        return this.error(res, 'Sale not found', 404);
      }

      if (sale.status === SALE_STATUS.CANCELLED) {
        return this.error(res, 'Sale is already cancelled', 400);
      }

      // Use the delete service which handles stock reversal and wallet updates
      const result = await salesService.deleteSales([saleId], { SaleModel });

      if (result && result.status === true) {
        await writeSaleAudit(req, 'cancel', sale.sales_id || saleId, 'Sale cancelled', {
          sales_id: sale.sales_id || '',
          total: sale.sales_total || sale.total || 0,
          sale_process: sale.sale_process || '',
        });
        return this.success(res, result.data, 'Sale cancelled');
      } else {
        return this.error(res, result?.message || 'Failed to cancel sale', 500);
      }
    } catch (error) {
      console.error('Error in cancel:', error);
      return this.error(res, error.message, 500);
    }
  }
}

module.exports = new SalesController();
/*
 * Exposed for tests: the discount-cap estimate decides whether a sale is
 * refused for want of manager approval, and it is worth pinning directly
 * rather than only through a full request.
 */
module.exports.estimateManualDiscountPct = estimateManualDiscountPct;
module.exports.auditNumber = auditNumber;
