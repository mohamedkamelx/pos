const express = require('express');
const router = express.Router();
const debtsController = require('../controllers/debts.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/summary', debtsController.getSummary);
router.get('/customers', debtsController.getCustomers);
router.get('/suppliers', debtsController.getSuppliers);
router.get('/customers/:id/statement', debtsController.getCustomerStatement);
router.get('/suppliers/:id/statement', debtsController.getSupplierStatement);
router.get('/customers/:id', debtsController.getCustomerStatement);
router.get('/suppliers/:id', debtsController.getSupplierStatement);
router.post('/payments', debtsController.recordPayment);
router.post('/settle', debtsController.settleInvoice);
router.delete('/payments/:id', debtsController.deletePayment);

module.exports = router;
