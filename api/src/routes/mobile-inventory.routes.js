'use strict';

const express = require('express');
const { protect } = require('../middleware/auth');
const inventory = require('../services/mobile-inventory');
const availability = require('../services/item-availability');

const router = express.Router();

const wrap = (fn) => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await fn(req));
  } catch (error) {
    if (!error.status) console.error('Mobile inventory:', error);
    const message = error.status
      ? error.message
      : 'The server could not complete this action. Please retry.';
    // The desktop list and modal callbacks read `message`; older mobile
    // clients read the nested error. Keep both shapes on one response.
    res.status(error.status || 500).json({ type: 'error', message, error: { message } });
  }
};

router.use(protect);

router.get('/availability-status', wrap(availability.status));

router.get('/inventory/policy', wrap(inventory.policy));
router.post('/inventory/policy', wrap(inventory.policy));
router.get('/inventory/catalogue', wrap(inventory.catalogue));
router.post('/inventory/availability', wrap(availability.change));
router.get('/inventory/items/:id/history', wrap(inventory.history));

router.get('/inventory/requests/:id', wrap(inventory.requestStatus));
router.post('/inventory/requests/:id/cancel', wrap(inventory.abandonRequest));

router.get('/inventory/operations', wrap(inventory.list));
router.post('/inventory/operations', wrap(inventory.prepare));
router.get('/inventory/operations/:id', wrap(inventory.get));
router.post('/inventory/operations/:id/confirm', wrap(inventory.confirm));
router.post('/inventory/operations/:id/cancel', wrap(inventory.cancel));

module.exports = router;
