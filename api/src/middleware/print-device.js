'use strict';
/*
 * The guard for the print-queue endpoints a till reaches without a browser
 * session.
 *
 * Those routes used to run behind optionalProtect alone, which authenticates
 * when it can and never refuses - so a caller who simply did not authenticate
 * carried on as anonymous. Anyone able to reach the API could then claim or
 * resolve another shop's print jobs. The key check closes that.
 *
 * Kept in its own file, with no service or model imports, so an authentication
 * guard is not reachable only by loading the whole validation layer and the
 * rule is testable without standing up a database. Requiring it must never
 * open a connection.
 */

const crypto = require('crypto');
const { currentSecret } = require('../db/tenant-context');

/*
 * Read inside the function, not at module load. Startup sets this while the
 * process begins, so a const evaluated at require time would capture nothing.
 */
function printDeviceApiKey() {
  // The older header and variable names are accepted so tills already shipped
  // keep printing after the rename; no new client needs them.
  const key = currentSecret('PRINT_DEVICE_API_KEY', process.env.PRINT_DEVICE_API_KEY);
  if (key) return key;
  return currentSecret('KIOSK_API_KEY', process.env.KIOSK_API_KEY) || null;
}

function keyMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch; compare b with itself to
  // spend the same time, then refuse.
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function refuse(res, ERROR_MESSAGES) {
  return res.status(401).json({
    type: 'error',
    status: false,
    message: (ERROR_MESSAGES && ERROR_MESSAGES.UNAUTHORIZED) || 'Unauthorized',
    data: null,
  });
}

/**
 * This installation's own key, OR a till this shop has allowed.
 *
 * ONLY for the print-queue routes. An allowed till may take print jobs and
 * report what happened to them, and nothing else.
 */
function makeEnsurePrintDevice(ERROR_MESSAGES) {
  return function ensurePrintDevice(req, res, next) {
    const supplied =
      req.headers['printdevicekey'] ||
      req.headers['PRINTDEVICEKEY'] ||
      req.headers['kioskkey'] ||
      req.headers['KIOSKKEY'];
    const expected = printDeviceApiKey();

    /* This machine's own, checked first and without touching the database. */
    if (expected && keyMatches(supplied, expected)) return next();

    const { tillIsAllowed } = require('../repositories/print-till.repository');
    const deny = () => refuse(res, ERROR_MESSAGES);
    return Promise.resolve(tillIsAllowed(supplied))
      .then((ok) => (ok ? next() : deny()))
      .catch(deny);
  };
}

module.exports = {
  makeEnsurePrintDevice,
};
