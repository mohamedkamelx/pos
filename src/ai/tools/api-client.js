/*
 * The local API client used by the assistant's tools.
 *
 * Every request carries the signed-in user's Bearer token and the active
 * branch header, so the API applies the same branch scope and ACL checks it
 * applies to the rest of the application. The assistant never calls the API
 * as a privileged service; it borrows the user's own session.
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 15000;

function apiError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function errorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const value = payload.message || payload.error;
  const first = Array.isArray(payload.errors) && payload.errors.length
    ? payload.errors[0]
    : null;
  const detail = first && typeof first.msg === 'string' && first.msg.trim()
    ? first.msg.trim()
    : '';
  if (typeof value === 'string' && value.trim()) {
    const message = value.trim();
    return detail && detail !== message ? `${message}: ${detail}` : message;
  }
  if (detail) return detail;
  return fallback;
}

function createApiClient({ baseUrl, token, branchId, fetchImpl, timeoutMs } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const request = fetchImpl || (typeof fetch === 'function' ? fetch : null);

  if (!root) throw apiError('configuration_error', 'The local shop service address is missing.');
  if (!request) throw apiError('configuration_error', 'The local shop service is not available.');

  async function call(method, pathname, query, body) {
    if (!token) {
      throw apiError('auth_required', 'Your session has ended. Sign in again to use shop data.');
    }

    let url;
    try {
      url = new URL(root + '/api/' + String(pathname || '').replace(/^\/+/, ''));
    } catch (error) {
      throw apiError('configuration_error', 'The local shop service address is invalid.');
    }
    for (const [name, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(name, String(value));
    }

    const headers = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token,
      ...(branchId ? { 'X-Branch-Id': branchId } : {}),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), wait);
    let response;
    try {
      response = await request(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
        throw apiError('timeout', 'The shop data request took too long. Try again.');
      }
      throw apiError('network_error', 'Could not reach the local shop data service. Try again.');
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw apiError('auth_required', 'Your session has ended. Sign in again to use shop data.', 401);
      }
      if (response.status === 403) {
        throw apiError('forbidden', errorMessage(payload, 'You do not have permission to do that.'), 403);
      }
      if (response.status === 404) {
        throw apiError('not_found', errorMessage(payload, 'That record was not found in this branch.'), 404);
      }
      if (response.status === 409) {
        throw apiError('duplicate', errorMessage(payload, 'That record already exists.'), 409);
      }
      if (response.status === 429) {
        throw apiError('rate_limited', 'Too many requests. Wait a moment and try again.', 429);
      }
      if (response.status >= 500) {
        throw apiError('server_error', 'The shop data service returned an error. Try again.', response.status);
      }
      throw apiError('request_failed', errorMessage(payload, 'The shop data request failed.'), response.status);
    }

    return payload;
  }

  async function get(pathname, query) {
    return call('GET', pathname, query);
  }

  async function post(pathname, body, query) {
    return call('POST', pathname, query, body === undefined ? {} : body);
  }

  async function put(pathname, body, query) {
    return call('PUT', pathname, query, body === undefined ? {} : body);
  }

  async function remove(pathname, body, query) {
    return call('DELETE', pathname, query, body === undefined ? {} : body);
  }

  return { get, post, put, delete: remove };
}

module.exports = { DEFAULT_TIMEOUT_MS, apiError, createApiClient };
