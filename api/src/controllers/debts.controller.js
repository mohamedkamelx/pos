// src/controllers/debts.controller.js
const asyncHandler = require('express-async-handler');
const BaseController = require('./base.controller');
const BaseModel = require('../models/base.model');
const DebtService = require('../services/debt.service');
const { ObjectId } = require('mongodb');

const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'owner', 'admin']);

const parseList = (value) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(parseList);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        return parseList(JSON.parse(trimmed));
      } catch (error) {
        return [];
      }
    }
    return trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [value];
};

class DebtsController extends BaseController {
  constructor() {
    super();
    this.service = new DebtService();
  }

  setRequestContext(req) {
    this.user = req.user;
    if (!req.user) return;
    BaseModel.loggedUser = req.user._id;
    BaseModel.loggedUserName = req.user.username || req.user.name || '';
    BaseModel.license = req.tenantContext?.licenseId || req.license || req.user.license;
    BaseModel.currentBranch =
      req.tenantContext?.branchId ||
      req.session?.selectedBranchId ||
      req.session?.branch_id ||
      req.query?.branch_id ||
      req.user.branch_id ||
      (Array.isArray(req.user.branch_access) && req.user.branch_access[0]?.branch_id) ||
      null;
    BaseModel.currentBranchName =
      req.tenantContext?.branchName ||
      req.user.branch_name ||
      (Array.isArray(req.user.branch_access) && req.user.branch_access[0]?.branch_name) ||
      '';
  }

  response(res, data, message = 'success') {
    return res.status(200).json({ type: 'success', message, data });
  }

  error(res, message, status = 400, extra = {}) {
    return res.status(status).json({ type: 'error', message, data: null, ...extra });
  }

  branchIds(req) {
    const raw =
      req.query['branch[]'] ??
      req.query.branch ??
      req.query.branch_ids ??
      req.body?.['branch[]'] ??
      req.body?.branch ??
      req.body?.branch_ids;
    const requested = parseList(raw).map(String).filter(Boolean);

    if (requested.some((id) => !ObjectId.isValid(id))) {
      const error = new Error('Invalid branch ID');
      error.statusCode = 400;
      throw error;
    }

    const role = String(req.user?.usertype || req.user?.role || '').toLowerCase();
    const access = Array.isArray(req.user?.branch_access)
      ? req.user.branch_access
          .map((entry) => String(entry?.branch_id || entry || ''))
          .filter(Boolean)
      : [];
    const active = String(
      req.tenantContext?.branchId ||
        req.session?.selectedBranchId ||
        req.session?.branch_id ||
        req.user?.branch_id ||
        ''
    );

    if (!requested.length) {
      if (access.length) return [...new Set(access)];
      if (ADMIN_ROLES.has(role) || !active) return [];
      return [active];
    }

    if (access.length) {
      if (requested.some((id) => !access.includes(id))) {
        const error = new Error('You do not have access to one of the selected branches');
        error.statusCode = 403;
        throw error;
      }
      return [...new Set(requested)];
    }

    if (!ADMIN_ROLES.has(role) && active && requested.some((id) => id !== active)) {
      const error = new Error('You do not have access to one of the selected branches');
      error.statusCode = 403;
      throw error;
    }
    return [...new Set(requested)];
  }

  ensureReportAccess(req, res) {
    if (!this.checkPermission('report', 'read', req.user)) {
      this.error(res, 'Unauthorized', 403);
      return false;
    }
    return true;
  }

  ensurePartyWrite(req, res, partyType) {
    const resource = partyType === 'supplier' ? 'supplier' : 'customer';
    if (!this.checkPermission(resource, 'write', req.user)) {
      this.error(res, 'Unauthorized', 403);
      return false;
    }
    return true;
  }

  /*
   * A party's statement is opened from that party's own detail page, not only
   * from the Debts report. Requiring report access there made "Pay supplier"
   * fail for a user who could read suppliers but not reports. The statement
   * only exposes the party the caller already opened; writing money still
   * goes through ensurePartyWrite below.
   */
  ensurePartyRead(req, res, partyType) {
    const resource = partyType === 'supplier' ? 'supplier' : 'customer';
    if (!this.checkPermission(resource, 'read', req.user)) {
      this.error(res, 'Unauthorized', 403);
      return false;
    }
    return true;
  }

  getSummary = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    if (!this.ensureReportAccess(req, res)) return;
    try {
      const data = await this.service.summary(this.branchIds(req));
      return this.response(res, data);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  getCustomers = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    if (!this.ensureReportAccess(req, res)) return;
    try {
      const data = await this.service.listParties('customer', {
        branchIds: this.branchIds(req),
        search: req.query.search || req.query.q || '',
        page: req.query.page,
        limit: req.query.limit,
        sort: req.query.sort,
      });
      return this.response(res, data);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  getSuppliers = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    if (!this.ensureReportAccess(req, res)) return;
    try {
      const data = await this.service.listParties('supplier', {
        branchIds: this.branchIds(req),
        search: req.query.search || req.query.q || '',
        page: req.query.page,
        limit: req.query.limit,
        sort: req.query.sort,
      });
      return this.response(res, data);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  getCustomerStatement = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    if (!this.ensurePartyRead(req, res, 'customer')) return;
    try {
      const result = await this.service.partyStatement(
        'customer',
        req.params.id,
        this.branchIds(req)
      );
      if (!result.status) return this.error(res, result.message, 404);
      return this.response(res, result.data);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  getSupplierStatement = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    if (!this.ensurePartyRead(req, res, 'supplier')) return;
    try {
      const result = await this.service.partyStatement(
        'supplier',
        req.params.id,
        this.branchIds(req)
      );
      if (!result.status) return this.error(res, result.message, 404);
      return this.response(res, result.data);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  recordPayment = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    const partyType = String(req.body.party_type || req.body.partyType || '').toLowerCase();
    if (!['customer', 'supplier'].includes(partyType)) {
      return this.error(res, 'Choose a customer or a supplier.', 400);
    }
    if (!this.ensurePartyWrite(req, res, partyType)) return;
    try {
      const result = await this.service.recordPayment({
        partyType,
        partyId: req.body.party_id || req.body.partyId,
        amount: req.body.amount,
        date: req.body.date,
        note: req.body.note,
        reference: req.body.reference,
        requestId: req.body.request_id || req.body.requestId || req.headers['idempotency-key'],
        branchId: req.body.branch_id || req.body.branchId || null,
        branchIds: this.branchIds(req),
      });
      if (!result.status)
        return this.error(res, result.message, 400, {
          code: result.code,
          outstanding: result.outstanding,
        });
      return this.response(res, result.data, result.message);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  settleInvoice = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    const partyType = String(req.body.party_type || req.body.partyType || '').toLowerCase();
    if (!['customer', 'supplier'].includes(partyType)) {
      return this.error(res, 'Choose a customer or a supplier.', 400);
    }
    if (!this.ensurePartyWrite(req, res, partyType)) return;
    try {
      const result = await this.service.settleInvoice({
        partyType,
        partyId: req.body.party_id || req.body.partyId,
        recordId:
          req.body.record_id ||
          req.body.recordId ||
          req.body.sale_id ||
          req.body.saleId ||
          req.body.receiving_id ||
          req.body.receivingId,
        date: req.body.date,
        note: req.body.note,
        reference: req.body.reference,
        requestId: req.body.request_id || req.body.requestId || req.headers['idempotency-key'],
        branchId: req.body.branch_id || req.body.branchId || null,
        branchIds: this.branchIds(req),
      });
      if (!result.status)
        return this.error(res, result.message, 400, {
          code: result.code,
          outstanding: result.outstanding,
        });
      return this.response(res, result.data, result.message);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });

  deletePayment = asyncHandler(async (req, res) => {
    this.setRequestContext(req);
    try {
      const branchIds = this.branchIds(req);
      const existing = await this.service.repository.findPaymentById(req.params.id, branchIds);
      if (!existing) return this.error(res, 'Payment not found.', 404);
      if (!this.ensurePartyWrite(req, res, existing.party_type)) return;
      const result = await this.service.deletePayment(req.params.id, {
        branchIds,
      });
      if (!result.status) return this.error(res, result.message, 404);
      return this.response(res, result.data, result.message);
    } catch (error) {
      return this.error(res, error.message, error.statusCode || 500);
    }
  });
}

module.exports = new DebtsController();
