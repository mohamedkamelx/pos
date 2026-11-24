const express = require('express');
const router = express.Router();
const itemsController = require('../controllers/items.controller');
const { protect } = require('../middleware/auth');
const {
  validateCreateItem,
  validateUpdateItem,
  ensureValidItemIdParam,
} = require('../middleware/items.validation');

const bindController = (handler, controller = itemsController) => {
  if (typeof handler === 'function') {
    return handler.bind(controller);
  }

  return (req, res, next) => {
    if (typeof controller.error === 'function') {
      return controller.error(res, 'Handler not implemented', 501);
    }

    return res.status(501).json({
      success: false,
      message: 'Handler not implemented',
      data: null,
    });
  };
};

// Protect all remaining item routes to ensure req.user context is available
router.use(protect);
router.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && req.catalogueSharingConflicts) {
      body.branchSharingConflicts = req.catalogueSharingConflicts;
      body.message =
        (body.message || 'Saved.') +
        ' ' +
        req.catalogueSharingConflicts +
        ' branch updates need review. Open Items → Apply to branches to review and retry.';
    } else if (body && req.catalogueSharingQueued) {
      body.branchSharingQueued = true;
      body.message =
        (body.message || 'Saved.') + ' Updates to other branches will run in cloud after sync.';
    }
    return json(body);
  };
  next();
});
const catalogueSharing = require('../services/catalogue-sharing');
const catalogueAction = (fn) => async (req, res) => {
  try {
    res.json({ type: 'success', data: await fn(req) });
  } catch (e) {
    res.status(400).json({ type: 'error', message: e.message });
  }
};
router.get('/catalogue-sharing', catalogueAction(catalogueSharing.policy));
router.put('/catalogue-sharing', catalogueAction(catalogueSharing.policy));
router.post(
  '/catalogue-sharing',
  catalogueAction(async (req) => {
    const c = await catalogueSharing.context(req);
    const db = await require('../models/base.model').getDb();
    const rows = await db
      .collection('items')
      .find(
        {
          branch_id: new (require('mongodb').ObjectId)(c.branchId),
          license: new (require('mongodb').ObjectId)(c.licenseId),
          is_deleted: { $ne: true },
          del_status: { $nin: [1, '1', true] },
        },
        { projection: { _id: 1 } }
      )
      .limit(2001)
      .toArray();
    return catalogueSharing.distribute(
      req,
      req.body.ids || rows.map((r) => r._id),
      req.body.branches || 'all'
    );
  })
);
const stockPreference = require('../services/item-stock-preference');
const preferenceHandler = (fn) => async (req, res, next) => {
  try {
    res.json({ type: 'success', data: await fn(req) });
  } catch (error) {
    next(error);
  }
};
router.get('/stockPreference', preferenceHandler(stockPreference.read));
router.put('/stockPreference', preferenceHandler(stockPreference.save));
const expiryReminders = require('../services/item-expiry-reminders');
router.get('/expiryReminders/preference', preferenceHandler(expiryReminders.read));
router.put('/expiryReminders/preference', preferenceHandler(expiryReminders.save));
router.get('/expiryReminders', preferenceHandler(expiryReminders.list));
router.get('/expiryReport', preferenceHandler(expiryReminders.report));

// GET /api/items - Get paginated items (legacy default endpoint)
router.get('/', bindController(itemsController.getAll));

// Legacy low stock endpoint expected by frontend dashboard
router.get('/itemLowStockTable', bindController(itemsController.itemLowStockTable));

// Item autocomplete used by barcode lookup, invoices and settings.
router.get('/getOnlineItemsAjaxList', bindController(itemsController.getOnlineItemsAjaxList));

// The sale screen's paged product shelf.
router.get('/onlineSalesItemsAjaxLists', bindController(itemsController.onlineSalesItemsAjaxLists));

// Legacy instant item creation endpoint
router.post('/instanceItemInsert', bindController(itemsController.instanceItemInsert));

// Legacy instant delete endpoint - support both POST and DELETE verbs
router
  .route('/deleteInstant')
  .post(bindController(itemsController.deleteInstant))
  .delete(bindController(itemsController.deleteInstant));

// Legacy item details endpoint
// GET /api/items/category/:categoryId - Get items by category
router.get('/category/:categoryId', bindController(itemsController.getByCategory));

// GET /api/items/search - Search items by name or barcode
router.get('/search', bindController(itemsController.search));

// GET /api/items/quantityCount - Get count of items by quantity range
router.get('/quantityCount', bindController(itemsController.quantityCount));

// PHP: getDataChanges() - Data sync
router.get('/getDataChanges', bindController(itemsController.getDataChanges));

// PHP: itemsImport() - Bulk import
router.post('/itemsImport', bindController(itemsController.itemsImport));

// PHP: exportItems() - Excel export
router.post('/exportItems', bindController(itemsController.exportItems));

// GET /api/items/export/jsonld - the catalogue as schema.org JSON-LD.
// A different SHAPE of what /items already returns, gated on the same
// item:read. See docs PRODUCT_EXPORT_FORMATS.md.
router.get('/export/jsonld', bindController(itemsController.exportCatalogueJsonLd));

// Raise/lower prices across many items at once; and a per-item price history.
// V1 variant families: all-or-nothing creation of linked variant items,
// and the members of one family for the edit page's strip.
router.post('/createFamily', bindController(itemsController.createFamily));
router.get('/family', bindController(itemsController.getFamily));
router.get('/priceGrid', bindController(itemsController.priceGrid));
router.post('/priceSheet', bindController(itemsController.priceSheet));
router.post('/priceSheetImport', (req, res, next) => {
  if (!itemsController.checkPermission('item', 'write', req.user))
    return res.status(403).json({ type: 'error', message: 'Item write permission required' });
  const multer = require('multer');
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
  }).single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ type: 'error', message: err.message });
    req.body.action = 'import';
    return bindController(itemsController.priceSheet)(req, res, next);
  });
});
router.post('/priceGrid', bindController(itemsController.savePriceGrid));
router.post('/bulkUpdatePrices', bindController(itemsController.bulkUpdatePrices));
router.post('/bulkPricePreview', bindController(itemsController.bulkPricePreview));
router.post('/bulkSetMargin', bindController(itemsController.bulkSetMargin));
router.post('/marginPreview', bindController(itemsController.marginPreview));
router.get('/priceHistory/:id', bindController(itemsController.getPriceHistory));
router.get('/bulkPriceHistory', bindController(itemsController.getBulkPriceUpdates));

// Add/remove stock across many items at once, with a note, audited to stocklogs.
router.post('/bulkUpdateStock', bindController(itemsController.bulkUpdateStock));
router.post('/bulkStockPreview', bindController(itemsController.bulkStockPreview));
router.get('/bulkStockHistory', bindController(itemsController.getBulkStockUpdates));

// PHP: categoryItemsReportTable() - Category report
router.get('/categoryItemsReportTable', bindController(itemsController.categoryItemsReportTable));

// PHP: supplierItemsReportTable() - Supplier report
router.get('/supplierItemsReportTable', bindController(itemsController.supplierItemsReportTable));

// Live price preview for the item form.
router.post('/pricePreview', bindController(itemsController.pricePreview));

// PHP: itemReportTable() - Items report
router.get('/itemReportTable', bindController(itemsController.itemReportTable));

// PHP: uploadItemMultiImage() - Upload images
router.post('/uploadItemMultiImage', bindController(itemsController.uploadItemMultiImage));

// PHP: getReceivingItemsAjaxList() - Receiving autocomplete
router.get('/getReceivingItemsAjaxList', bindController(itemsController.getReceivingItemsAjaxList));

// All (or only low-stock) items of one supplier - the receiving autofill.
router.get('/bySupplier', bindController(itemsController.getItemsBySupplier));

// Reasoned per-item stock adjustment: count sets, loss/damage subtract.
router.post('/stockAdjustment', bindController(itemsController.stockAdjustment));

// PHP: getItemsByCategoryId() - Get items by category
router.get('/getItemsByCategoryId', bindController(itemsController.getItemsByCategoryId));

// PHP: itemSearchTable() - Search items with price range
router.get('/itemSearchTable', bindController(itemsController.itemSearchTable));

// PHP: updateItemQuantity() - Update item quantity
router.post('/updateItemQuantity', bindController(itemsController.updateItemQuantity));

// Sale-screen inline edit: targeted money-field patch (write ACL)
router.post('/quickPatch', bindController(itemsController.quickPatch));

// PHP: categoryProductDetails() - Category product details
router.get('/categoryProductDetails', bindController(itemsController.categoryProductDetails));

// PHP: supplierProductDetails() - Supplier product details
router.get('/supplierProductDetails', bindController(itemsController.supplierProductDetails));

// PHP: getCustomerSearchItemsAjaxList() - Customer search autocomplete
router.get(
  '/getCustomerSearchItemsAjaxList',
  bindController(itemsController.getCustomerSearchItemsAjaxList)
);

// PHP: itemStockReportTable() - Item stock report
router.get('/itemStockReportTable', bindController(itemsController.itemStockReportTable));

// PHP: add() - Create new item (POST /items)
router.post('/', validateCreateItem, bindController(itemsController.add));

// PHP: delete() - Delete items (DELETE /items)
router.delete('/', bindController(itemsController.delete));

// Legacy bulk delete endpoint used by frontend: DELETE /items/delete
router.delete('/delete', bindController(itemsController.delete));

// Legacy edit endpoint: GET /items/getItemDetails?id={id}
router.get('/getItemDetails', bindController(itemsController.getItemDetails));

// PHP: getOne() - Get single item by ID
router.get('/:id', ensureValidItemIdParam, bindController(itemsController.getOne));

// The new editor continues a saved item without rewriting its live stock.
// A separate route fails safely if frontend assets arrive before the API deploy.
router.put(
  '/:id/details',
  ensureValidItemIdParam,
  (req, res, next) => {
    if (req.body) delete req.body.available_quantity;
    next();
  },
  validateUpdateItem,
  bindController(itemsController.edit)
);

// PHP: edit() - Update existing item (PUT /items/:id)
router.put(
  '/:id',
  ensureValidItemIdParam,
  validateUpdateItem,
  bindController(itemsController.edit)
);

module.exports = router;
