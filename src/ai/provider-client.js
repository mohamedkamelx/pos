/*
 * Small provider-key checks used before saving a chat token.
 *
 * This does not send a chat message and does not cost tokens. A provider that
 * does not expose a key-check endpoint is marked unverified rather than
 * rejecting an otherwise usable token.
 */

'use strict';

const { getProvider } = require('./provider-registry');

const MAX_KEY_LENGTH = 256;

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function validateProviderKey(providerID, key, fetchImpl) {
  const provider = getProvider(providerID);
  if (!provider) {
    return { success: false, code: 'provider_invalid', error: 'Choose a supported model provider.' };
  }
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY_LENGTH) {
    return { success: false, code: 'provider_key_invalid', error: 'Enter a valid provider token.' };
  }

  const fetch = fetchImpl || global.fetch;
  try {
    const response = await fetch(provider.modelsURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: timeoutSignal(20000),
    });
    if (response.status === 401 || response.status === 403) {
      return { success: false, code: 'provider_key_invalid', status: response.status,
        error: 'The provider did not accept that token.' };
    }
    if (response.status === 429) {
      return { success: false, code: 'rate_limited', status: response.status,
        error: 'The provider is rate limiting key checks. Wait a minute and try again.' };
    }
    if (response.status === 404 || response.status === 405) {
      /* Some compatible endpoints do not publish a model list. The token is
         stored and the first real chat request becomes the final check. */
      return { success: true, unverified: true };
    }
    if (!response.ok) {
      return { success: false, code: 'provider_error', status: response.status,
        error: `The provider returned ${response.status}.` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, code: 'network_error',
      error: 'Could not reach the provider to check the token. Check the internet connection.' };
  }
}

module.exports = {
  MAX_KEY_LENGTH,
  validateProviderKey,
};
