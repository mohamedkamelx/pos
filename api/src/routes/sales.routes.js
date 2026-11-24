const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const { protect } = require('../middleware/auth');
const salesController = require('../controllers/sales.controller');
const {
  validateCreateSale,
  validateUpdateSale,
  ensureValidSaleIdParam,
  validateInstantSaleDetailsQuery,
  validateDailyReportQuery,
  prepareItemExpiryReportQuery,
  validateSalesSummaryReportQuery,
  preparePaginatedDateRangeQuery,
  validateSalesReportsQuery,
  prepareUserReportTableQuery,
  prepareBranchPaginatedReportQuery,
  preparePaymentPaginatedReportQuery,
  prepareBranchReportQuery,
  prepareCreateSalePayload,
  prepareUpdateSalePayload,
  ensurePrintDevice,
} = require('../middleware/sales.validation');
const { handleValidationErrors } = require('../middleware/validation');
const bindController = (handler) => {
  if (typeof handler === 'function') {
    return handler.bind(salesController);
  }

  return (req, res, next) => {
    if (typeof salesController.error === 'function') {
      return salesController.error(res, 'Handler not implemented', 501);
    }

    res.status(501).json({
      success: false,
      message: 'Handler not implemented',
      data: null,
    });
  };
};

// Apply middleware if needed
// const { authenticate, authorize } = require('../middleware/auth');

/* THE PRINT QUEUE. A till asking what it should print, and saying what
   happened to it. Behind the installation key like every other printer route -
   this is a machine talking about its own hardware. */
router.post('/claimPrintJobs', ensurePrintDevice, bindController(salesController.claimPrintJobs));
router.post('/finishPrintJob', ensurePrintDevice, bindController(salesController.finishPrintJob));
router.post(
  '/printJobsNeedingAttention',
  ensurePrintDevice,
  bindController(salesController.printJobsNeedingAttention)
);
router.post('/resolvePrintJob', ensurePrintDevice, bindController(salesController.resolvePrintJob));

// Public customer receipt link: the encrypted id is the credential.
router.get(
  '/getCustomerPrint',
  require('../middleware/customer-receipt-link'),
  bindController(salesController.getCustomerPrint)
);

router.use(protect);

const businessDecisionLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || 'unknown'),
  handler: (_req, res) => res.status(429).json({ error: { code: 'decision_rate_limited' } }),
});
const businessDecisionCreateLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || 'unknown'),
  handler: (_req, res) => res.status(429).json({ error: { code: 'decision_rate_limited' } }),
});
router.post(
  '/business-decisions',
  businessDecisionCreateLimit,
  bindController(salesController.businessDiscountDecision)
);
router.get(
  '/business-decisions/operation/:operationId',
  businessDecisionLimit,
  bindController(salesController.businessDiscountDecision)
);
router.get(
  '/business-decisions/:requestId',
  businessDecisionLimit,
  bindController(salesController.businessDiscountDecision)
);
router.post(
  '/business-decisions/:requestId/cancel',
  businessDecisionLimit,
  bindController(salesController.businessDiscountDecision)
);

// POST /api/sales - Create a new sale
router.post(
  '/',
  validateCreateSale,
  handleValidationErrors,
  prepareCreateSalePayload,
  bindController(salesController.create)
);

// GET /api/sales - Get all sales with pagination
router.get('/', bindController(salesController.getAll));

router.get('/historyFilterOptions', bindController(salesController.historyFilterOptions));

// GET /api/sales/dailySalesReports - Legacy daily sales report endpoint
router.get(
  '/dailySalesReports',
  validateDailyReportQuery,
  bindController(salesController.dailySalesReports)
);

// GET /api/sales/dailyReportPdf - Daily sales report PDF generation
router.get(
  '/dailyReportPdf',
  validateDailyReportQuery,
  bindController(salesController.dailyReportPdf)
);

// Legacy sales chart endpoint
router.get('/salesGraphicalReports', bindController(salesController.salesGraphicalReports));
router.get(
  '/itemGraphicalReports',
  preparePaginatedDateRangeQuery,
  bindController(salesController.itemGraphicalReports)
);

// Legacy sales report listing endpoint
router.get(
  '/salesReports',
  validateSalesReportsQuery,
  bindController(salesController.salesReports)
);
router.get(
  '/itemSalesReportTable',
  preparePaginatedDateRangeQuery,
  bindController(salesController.itemSalesReportTable)
);
router.get(
  '/categorySalesReportTable',
  preparePaginatedDateRangeQuery,
  bindController(salesController.categorySalesReportTable)
);
router.get(
  '/supplierSalesReportTable',
  preparePaginatedDateRangeQuery,
  bindController(salesController.supplierSalesReportTable)
);
router.get(
  '/customerSalesReportTable',
  preparePaginatedDateRangeQuery,
  bindController(salesController.customerSalesReportTable)
);
router.get(
  '/salesSummaryReports',
  validateSalesSummaryReportQuery,
  bindController(salesController.salesSummaryReports)
);

// Instant sales reports endpoints
router.get(
  '/instantSalesReports',
  preparePaginatedDateRangeQuery,
  bindController(salesController.instantSalesReports)
);
router.get(
  '/instantSaleDetails',
  validateInstantSaleDetailsQuery,
  bindController(salesController.instantSaleDetails)
);

// Legacy endpoint: GET /sales/getLatestSales
router.get('/getLatestSales', bindController(salesController.getLatestSales));
router.post('/parked/clear', bindController(salesController.clearParkedSales));

// Legacy user report routes that frontend still requests under /sales
router.get(
  '/userReportTable',
  prepareUserReportTableQuery,
  bindController(salesController.userReportTable)
);
router.get('/userGraphicalReports', bindController(salesController.userGraphicalReports));

// Legacy return report routes that frontend still requests under /sales
router.get(
  '/returnSalesReportTable',
  prepareBranchPaginatedReportQuery,
  bindController(salesController.returnSalesReportTable)
);
router.get('/productBasedReturnDetails', bindController(salesController.productBasedReturnDetails));

// Legacy pending report routes that frontend still requests under /sales
router.get(
  '/pendingSalesReportTable',
  prepareBranchPaginatedReportQuery,
  bindController(salesController.pendingSalesReportTable)
);
router.get(
  '/pendingCustomerReportTable',
  prepareBranchPaginatedReportQuery,
  bindController(salesController.pendingCustomerReportTable)
);

// Legacy payment report routes that frontend still requests under /sales
router.get(
  '/paymentSalesTranscationReportTable',
  preparePaymentPaginatedReportQuery,
  bindController(salesController.paymentSalesTranscationReportTable)
);
router.get(
  '/paymentSaleTypeReport',
  prepareBranchReportQuery,
  bindController(salesController.paymentSaleTypeReport)
);
router.get(
  '/paymentReturnSalesTranscationReportTable',
  preparePaymentPaginatedReportQuery,
  bindController(salesController.paymentReturnSalesTranscationReportTable)
);
router.get(
  '/paymentGraphicalReports',
  prepareBranchReportQuery,
  bindController(salesController.paymentGraphicalReports)
);

// Frontend: sales_view.js expects this endpoint for PDF open
router.get('/salesPdf', bindController(salesController.salesPdf));

// PHP: returnSales() - Process sales return
router.post('/returnSales', bindController(salesController.returnSales));

// PHP: exportSales() - Export sales data
router.post('/exportSales', bindController(salesController.exportSales));

// Frontend POSTs to lowercase /exportsales (from PosnicPro.getExportValue)
router.post('/exportsales', bindController(salesController.exportSales));

// Frontend sometimes opens this legacy path in a new tab
// Controller now handles both GET (with query params) and POST (with body)
router.get('/exportsales', bindController(salesController.exportSales));

// PHP: getDataChanges() - Get data changes for sync
router.get('/getDataChanges', bindController(salesController.getDataChanges));

// PHP: getReturnSalesDetails() - Get return sales details
router.get('/getReturnSalesDetails', bindController(salesController.getReturnSalesDetails));

// PHP: returnPrintDetails() - Get return print details
router.get('/returnPrintDetails', bindController(salesController.returnPrintDetails));

// PHP: getSalesAjaxList() - Get sales list for autocomplete
router.get('/getSalesAjaxList', bindController(salesController.getSalesAjaxList));

// PHP: getSaleQtyDetail() - Get sale quantity detail
router.get('/getSaleQtyDetail', bindController(salesController.getSaleQtyDetail));

// PHP: ServerStatus() - Server status check
router.get('/ServerStatus', bindController(salesController.ServerStatus));

// PHP: customerSaleDetails() - Get customer sale details
router.get('/customerSaleDetails', bindController(salesController.customerSaleDetails));

// PHP: customerCategorySaleDetails() - Get customer category sale details
router.get(
  '/customerCategorySaleDetails',
  bindController(salesController.customerCategorySaleDetails)
);

// PHP: itemSaleDetails() - Get item sale details
router.get('/itemSaleDetails', bindController(salesController.itemSaleDetails));

// PHP: categorySaleDetails() - Get category sale details
router.get('/categorySaleDetails', bindController(salesController.categorySaleDetails));

// PHP: userSalesDetails() - Get user sales details
router.get('/userSalesDetails', bindController(salesController.userSalesDetails));

// PHP: returnProductDetails() - Get return product details
router.get('/returnProductDetails', bindController(salesController.returnProductDetails));

// PHP: returnProductView() - Get return product view
router.get('/returnProductView', bindController(salesController.returnProductView));

// PHP: pendingProductDetails() - Get pending product details
router.get('/pendingProductDetails', bindController(salesController.pendingProductDetails));

// PHP: salesPaymentClose() - Close sales payment
router.post('/salesPaymentClose', bindController(salesController.salesPaymentClose));

// PHP: itemExpiryReportTable() - Get item expiry report
router.get(
  '/itemExpiryReportTable',
  prepareItemExpiryReportQuery,
  bindController(salesController.itemExpiryReportTable)
);

// Legacy bulk delete endpoint used by frontend: DELETE /sales/delete
router.delete('/delete', bindController(salesController.delete));

// Legacy hold endpoint - support creating and updating hold sales
router
  .route('/hold')
  .post(prepareCreateSalePayload, bindController(salesController.holdSale))
  .put(prepareCreateSalePayload, bindController(salesController.holdSale));

/*
 * Cancelling a sale must not be a GET.
 *
 * A GET is meant to be safe to repeat and safe for anything to follow.
 * Browsers prefetch them, link scanners and antivirus fetch them, and - the
 * part that matters - a bare `<img src="https://.../sales/cancel/ID">` on any
 * page reached while logged in fires one WITH cookies, because SameSite=Lax
 * still sends them on top-level GETs. That is a working CSRF vector against a
 * destructive operation.
 *
 * POST is the real route now. The GET stays only because tills already
 * deployed still call it, and it is hardened so
 * it cannot be triggered from another site: X-Requested-With is a header no
 * <img>, <script>, form or navigation can set, and cross-origin XHR cannot
 * set it either - the CORS allowlist refuses the preflight. So the legacy path
 * keeps working for real clients and is dead to an attacker page.
 *
 * Remove the GET once no shipped till calls it.
 */
const requireXhrForLegacyCancel = (req, res, next) => {
  if (String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest') {
    return next();
  }
  return res.status(405).json({
    type: 'error',
    message: 'Cancelling a sale requires POST',
    data: null,
  });
};

router.post('/cancel/:id', ensureValidSaleIdParam, bindController(salesController.cancel));
router.get(
  '/cancel/:id',
  requireXhrForLegacyCancel,
  ensureValidSaleIdParam,
  bindController(salesController.cancel)
);

// Single sale routes
// Legacy edit screens request /sales/:id/edit expecting same payload as /sales/:id
router.get('/:id/edit', ensureValidSaleIdParam, bindController(salesController.getOne));
router.get('/:id', ensureValidSaleIdParam, bindController(salesController.getOne));
router.put(
  '/:id',
  ensureValidSaleIdParam,
  validateUpdateSale,
  handleValidationErrors,
  prepareUpdateSalePayload,
  bindController(salesController.update)
);
// router.delete("/:id", salesController.delete);

module.exports = router;
