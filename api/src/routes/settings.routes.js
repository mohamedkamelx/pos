const { passwordResetLimiter } = require('../middleware/auth-rate-limit');
const express = require('express');
const router = express.Router();
router.use('/wording', require('./wording.routes'));
require('express-validator');
const { protect } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validation');
const authController = require('../controllers/auth.controller');
const upload = require('../middleware/upload');

// Import settings validation middleware
const {
  validateGeneralSetting,
  validateUnit,
  validateDenom,
  validateCommonSettings,
  validateChangePassword,
} = require('../middleware/settings.validation');

const settingController = require('../controllers/settings.controller');

// Helper to preserve controller context when used as route handlers
const bindController = (handler) => {
  if (typeof handler !== 'function') {
    throw new TypeError('Invalid controller handler supplied to router');
  }
  return (req, res, next) => handler.call(settingController, req, res, next);
};

// Reference data (country/state/currency/timezone lists): anonymous,
// byte-identical for every caller, changed only by a release. A day in the
// plain HTTP cache turns the repeat ~450ms fetch into 0ms for every browser,
// with or without the service worker (owner: "getJSONState this is not
// covered with service worker?" - it was, but the versioned SW cache resets
// on every deploy; the HTTP cache does not).
const referenceCache = (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  next();
};

// Use the controller instance methods
router.get('/getJSONCountry', referenceCache, bindController(settingController.getJSONCountry));
router.get('/getJSONState', referenceCache, bindController(settingController.getJSONState));
router.get('/getJSONCurrency', referenceCache, bindController(settingController.getJSONCurrency));
router.get('/getJSONTimeZone', referenceCache, bindController(settingController.getJSONTimeZone));

// Legacy unauthenticated endpoints expected under /setting
router.post(
  '/forgotPassword',
  passwordResetLimiter,
  bindController(settingController.forgotPassword)
);

// Routes below require authentication
router.use(protect);
router.post('/receiptDesignQr', bindController(settingController.previewReceiptQr));

router.get('/getDefaultCustomer', bindController(settingController.getDefaultCustomer));

router.get('/getDefaultSupplier', bindController(settingController.getDefaultSupplier));

router.get(
  '/getDefaultCustomerSupplier',
  bindController(settingController.getDefaultCustomerSupplier)
);

router.get('/backupTable', bindController(settingController.backupTable));

/*
 * The tills allowed to print this shop's bills.
 *
 * Behind `protect` like everything else here: allowing a machine to take this
 * shop's bills is a shopkeeper's decision, and the bills carry customer names
 * and totals. The key itself is stored as a digest and never comes back out,
 * so these read as "which machines", not "what are their keys".
 */
router.get('/printTills', bindController(settingController.listPrintTills));
router.post('/printTills', bindController(settingController.allowPrintTill));
router.delete('/printTills/:id', bindController(settingController.forgetPrintTill));

router.put('/starterLocale', bindController(settingController.updateStarterLocale));

// PUT /api/setting/general - Update general settings
router.put(
  '/general',
  validateGeneralSetting,
  handleValidationErrors,
  bindController(settingController.updateGeneralSetting)
);

// Legacy PHP endpoint - PUT /api/setting/updateGeneralSetting
router.put(
  '/updateGeneralSetting',
  validateGeneralSetting,
  handleValidationErrors,
  bindController(settingController.updateGeneralSetting)
);

// Also support POST for backward compatibility
router.post(
  '/updateGeneralSetting',
  validateGeneralSetting,
  handleValidationErrors,
  bindController(settingController.updateGeneralSetting)
);

router.post(
  '/updateCommonSettings',
  validateCommonSettings,
  handleValidationErrors,
  bindController(settingController.updateCommonSettings)
);

router.put(
  '/updateCommonSettings',
  validateCommonSettings,
  handleValidationErrors,
  bindController(settingController.updateCommonSettings)
);

// M4 branch selector: one branch's module switches, read before editing.
router.get('/branchModules', bindController(settingController.getBranchModules));

// Price lists (V4): customer-group pricing, one list per category.
router.get('/priceLists', bindController(settingController.getPriceLists));
router.post('/priceLists', bindController(settingController.savePriceList));
router.delete('/priceLists/:id', bindController(settingController.deletePriceList));

// Modifier groups: option sets with min/max + price deltas on sale lines.
router.get('/modifierGroups', bindController(settingController.getModifierGroups));
router.post('/modifierGroups', bindController(settingController.addModifierGroup));
router.put('/modifierGroups/:id', bindController(settingController.editModifierGroup));
router.delete('/modifierGroups/:id', bindController(settingController.deleteModifierGroup));

// PHP: Unit routes
router.get('/getUnitAll', bindController(settingController.getUnitAll));
router.get('/getUnitAjaxList', bindController(settingController.getUnitAjaxList));
router.post(
  '/addUnit',
  validateUnit,
  handleValidationErrors,
  bindController(settingController.addUnit)
);
router.post(
  '/editUnit',
  validateUnit,
  handleValidationErrors,
  bindController(settingController.editUnit)
);
router.put(
  '/editUnit',
  validateUnit,
  handleValidationErrors,
  bindController(settingController.editUnit)
);
router.delete('/deleteUnit', bindController(settingController.deleteUnit));

// PHP: Denom routes
router.post(
  '/addDenomForm',
  validateDenom,
  handleValidationErrors,
  bindController(settingController.addDenomForm)
);
router.post(
  '/addDenomData',
  validateDenom,
  handleValidationErrors,
  bindController(settingController.addDenomData)
);
router.get('/getDenomAll', bindController(settingController.getDenomAll));
router.put(
  '/editDenomForm',
  validateDenom,
  handleValidationErrors,
  bindController(settingController.editDenomForm)
);
router.delete('/deleteDenom', bindController(settingController.deleteDenom));

// PHP: Image routes
router.post(
  '/updateBranchLogo',
  upload.single('file'),
  bindController(settingController.updateBranchLogo)
);
router.post('/storedImageData', bindController(settingController.storedImageData));
router.put('/storedImageData', bindController(settingController.storedImageData));
router.delete('/branchImageDelete', bindController(settingController.branchImageDelete));

// PHP: Customer/Supplier Settings routes
router.get('/updateCustomerSettings', bindController(settingController.updateCustomerSettings));
router.get('/updateSupplierSettings', bindController(settingController.updateSupplierSettings));

// PHP: Password routes
router.post(
  '/changePassword',
  validateChangePassword,
  handleValidationErrors,
  bindController(settingController.changePassword)
);

// PHP: Data Management routes
router.delete('/deleteCollection', bindController(settingController.deleteCollection));
router.post(
  '/deleteAllSelectedCollection',
  bindController(settingController.deleteAllSelectedCollection)
);

// PHP: Backup routes
router.post('/restoreBackup', bindController(settingController.restoreBackup));

// PHP: Dashboard route
router.get('/getDasboardSalesCount', bindController(settingController.getDasboardSalesCount));

// PHP: Recycle Bin routes
router.get('/getRecycleBin', bindController(settingController.getRecycleBin));
router.get(
  '/autoSuggestionRecycleBinTableField',
  bindController(settingController.autoSuggestionRecycleBinTableField)
);

// PHP: Collection routes
router.get('/getAllCollectionTotal', bindController(settingController.getAllCollectionTotal));

// PHP: Theme Settings routes
router.get('/getThemeSettings', bindController(settingController.getThemeSettings));
router.post('/updateThemeSettings', bindController(settingController.updateThemeSettings));
router.put('/updateThemeSettings', bindController(settingController.updateThemeSettings));

module.exports = router;
