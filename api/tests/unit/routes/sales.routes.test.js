'use strict';

jest.mock('../../../src/controllers/sales.controller', () => ({
  getTablesWithActiveOrders: jest.fn(),
  kioskOrder: jest.fn(),
  fetchLastSale: jest.fn(),
  kitchenPrint: jest.fn(),
  multiKitchenPrint: jest.fn(),
  markKitchenPrinted: jest.fn(),
  qrOrder: jest.fn(),
  getNewSale: jest.fn(),
  getOrderHistory: jest.fn(),
  updateOrder: jest.fn(),
  searchProducts: jest.fn(),
  getFrequentItems: jest.fn(),
  getListKot: jest.fn(),
  create: jest.fn(),
  getAll: jest.fn(),
  dailySalesReports: jest.fn(),
  dailyReportPdf: jest.fn(),
  salesGraphicalReports: jest.fn(),
  itemGraphicalReports: jest.fn(),
  salesReports: jest.fn(),
  itemSalesReportTable: jest.fn(),
  categorySalesReportTable: jest.fn(),
  supplierSalesReportTable: jest.fn(),
  customerSalesReportTable: jest.fn(),
  salesSummaryReports: jest.fn(),
  instantSalesReports: jest.fn(),
  instantSaleDetails: jest.fn(),
  getLatestSales: jest.fn(),
  userReportTable: jest.fn(),
  userGraphicalReports: jest.fn(),
  returnSalesReportTable: jest.fn(),
  productBasedReturnDetails: jest.fn(),
  pendingSalesReportTable: jest.fn(),
  pendingCustomerReportTable: jest.fn(),
  taxSalesReports: jest.fn(),
  paymentSalesTranscationReportTable: jest.fn(),
  paymentSaleTypeReport: jest.fn(),
  paymentReturnSalesTranscationReportTable: jest.fn(),
  paymentGraphicalReports: jest.fn(),
  salesReceipt: jest.fn(),
  getCustomerPrint: jest.fn(),
  salesPdf: jest.fn(),
  createInvoiceLink: jest.fn(),
  salesMailPdf: jest.fn(),
  returnSales: jest.fn(),
  exportSales: jest.fn(),
  getDataChanges: jest.fn(),
  getReturnSalesDetails: jest.fn(),
  returnPrintDetails: jest.fn(),
  getSalesAjaxList: jest.fn(),
  getSaleQtyDetail: jest.fn(),
  ServerStatus: jest.fn(),
  customerSaleDetails: jest.fn(),
  customerCategorySaleDetails: jest.fn(),
  itemSaleDetails: jest.fn(),
  categorySaleDetails: jest.fn(),
  userSalesDetails: jest.fn(),
  returnProductDetails: jest.fn(),
  returnProductView: jest.fn(),
  pendingProductDetails: jest.fn(),
  gstOneReportTable: jest.fn(),
  gstThreeReportTable: jest.fn(),
  gstOneReportTableJson: jest.fn(),
  dailySalesMail: jest.fn(),
  salesPaymentClose: jest.fn(),
  qrCodeClose: jest.fn(),
}));

jest.mock('../../../src/middleware/auth', () => ({
  protect: jest.fn((req, res, next) => next()),
  optionalProtect: jest.fn((req, res, next) => next()),
}));

jest.mock('../../../src/middleware/sales.validation', () => ({
  /*
   * protectOrKioskKey guards the routes a kitchen display or table tablet
   * reaches without a login session. They previously ran behind optionalProtect
   * alone, which never refuses, so an anonymous caller could name any branch of
   * any shop in the request body and read - or, through updateOrder, rewrite -
   * that shop's orders. Omitting it here leaves those routes with an undefined
   * handler and Express throws while the file is still being required.
   */
  protectOrKioskKey: jest.fn((req, res, next) => next()),
  validateCreateSale: [],
  validateUpdateSale: [],
  ensureValidSaleIdParam: jest.fn((req, res, next) => next()),
  validateInstantSaleDetailsQuery: jest.fn((req, res, next) => next()),
  validateDailyReportQuery: jest.fn((req, res, next) => next()),
  prepareItemExpiryReportQuery: jest.fn((req, res, next) => next()),
  validateSalesSummaryReportQuery: jest.fn((req, res, next) => next()),
  preparePaginatedDateRangeQuery: jest.fn((req, res, next) => next()),
  validateSalesReportsQuery: jest.fn((req, res, next) => next()),
  prepareUserReportTableQuery: jest.fn((req, res, next) => next()),
  prepareBranchPaginatedReportQuery: jest.fn((req, res, next) => next()),
  preparePaymentPaginatedReportQuery: jest.fn((req, res, next) => next()),
  prepareBranchReportQuery: jest.fn((req, res, next) => next()),
  prepareGstOneReportContext: jest.fn((req, res, next) => next()),
  prepareGstThreeReportContext: jest.fn((req, res, next) => next()),
  prepareKioskPaginatedReportQuery: jest.fn((req, res, next) => next()),
  prepareKioskReportQuery: jest.fn((req, res, next) => next()),
  prepareCreateSalePayload: jest.fn((req, res, next) => next()),
  prepareUpdateSalePayload: jest.fn((req, res, next) => next()),
  ensureKioskKey: jest.fn((req, res, next) => next()),
  ensurePrintDevice: jest.fn((req, res, next) => next()),
}));

jest.mock('../../../src/middleware/validation', () => ({
  handleValidationErrors: jest.fn((req, res, next) => next()),
}));

const router = require('../../../src/routes/sales.routes');

describe('sales.routes', () => {
  test('exposes sale routes', () => {
    const paths = router.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'post /',
        'get /',
        'get /dailySalesReports',
        'post /claimPrintJobs',
        'post /finishPrintJob',
      ])
    );
  });

  test('the print queue is reachable only with the print-device key', () => {
    /* A till has no browser session. These routes sit before router.use(protect)
       and must still refuse anybody without the installation's device key. */
    const { ensurePrintDevice } = require('../../../src/middleware/sales.validation');
    const layers = router.stack.filter((l) => l.route || l.name === 'protect');
    const protect = layers.findIndex((l) => !l.route && l.name === 'protect');
    for (const path of ['/claimPrintJobs', '/finishPrintJob', '/resolvePrintJob']) {
      const index = layers.findIndex(
        (l) => l.route && l.route.path === path && l.route.methods.post
      );
      expect(index).toBeGreaterThan(-1);
      if (protect > -1) expect(index).toBeLessThan(protect);
      expect(layers[index].route.stack.map((h) => h.handle)).toContain(ensurePrintDevice);
    }
  });
});
