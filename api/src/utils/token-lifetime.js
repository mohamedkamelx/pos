'use strict';
/*
 * How long a freshly signed token is good for, in seconds.
 *
 * Its own file, with no dependencies, for two reasons. It is read by the
 * signers AND reported to clients, so the number in the token and the number
 * the client is told come from one place and cannot drift; and a pure function
 * about a string should not sit behind a require of jsonwebtoken, which is
 * what stopped it being tested without installing the whole API.
 *
 * A client that has to guess its own expiry either refreshes far more often
 * than it needs to, or finds out it has expired in the middle of taking an
 * order.
 */

/* The default has to match what signToken/signLegacyToken fall back to. */
const DEFAULT = '24h';
const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} seconds
 */
function jwtLifetimeSeconds(env = process.env) {
  // The embedded till keeps its login across restarts and days off. Its
  // rolling session/cookie uses Chromium's 400-day persistent-cookie limit.
  // Explicit logout and authVersion revocation still invalidate access.
  // Cloud browsers retain their existing configured lifetime.
  const raw = String(env.POSNIC_DESKTOP === '1' ? '400d' : env.JWT_EXPIRES_IN || DEFAULT).trim();
  /* The `jsonwebtoken` shorthand, because that is what the env var holds:
     "24h", "30m", "7d", or plain seconds. Anything else falls back rather
     than throwing - a malformed setting must not stop sign-in. */
  const match = raw.match(/^(\d+)\s*([smhd])?$/i);
  if (!match) return parseLifetime(DEFAULT);
  return Number(match[1]) * UNITS[(match[2] || 's').toLowerCase()];
}

function parseLifetime(value) {
  const match = String(value).match(/^(\d+)\s*([smhd])?$/i);
  return Number(match[1]) * UNITS[(match[2] || 's').toLowerCase()];
}

function loginCookieDays(env = process.env) {
  if (env.POSNIC_DESKTOP === '1') return 400;
  const days = Number(env.JWT_COOKIE_EXPIRES_IN || 7);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

module.exports = {
  loginCookieDays,
  jwtLifetimeSeconds,
  DEFAULT_LIFETIME: DEFAULT,
};
