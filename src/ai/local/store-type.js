/*
 * The shop type chosen at registration.
 *
 * The assistant must not guess a shop's type from the categories it happens
 * to have: a new clothing shop may have created a "Mobile accessories"
 * category for a side rack, and that should not turn its whole vocabulary
 * into electronics. The registration answer is authoritative. This module
 * reads it from the branch document the rest of the app already exposes.
 *
 * Older shops have no value. The caller gets an empty string and the local
 * category ranking falls back to reading their own category names.
 */

'use strict';

const STORE_TYPE_KEYS = [
  'business_type',
  'businessType',
  'store_type',
  'storeType',
  'shop_type',
  'shopType',
  'store_profile',
  'storeProfile',
];

function valueFromEntry(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string' || typeof entry === 'number') {
    return String(entry).trim();
  }
  if (Array.isArray(entry)) {
    return entry.map(valueFromEntry).filter(Boolean);
  }
  if (typeof entry === 'object') {
    return valueFromEntry(
      entry.id || entry.value || entry.name || entry.label || entry.key || '',
    );
  }
  return '';
}

function storeTypeFromBranch(branch) {
  if (!branch || typeof branch !== 'object') return '';
  const data = branch.data && typeof branch.data === 'object' ? branch.data : branch;
  for (const key of STORE_TYPE_KEYS) {
    const value = valueFromEntry(data[key]);
    if (Array.isArray(value) ? value.length : value) return value;
  }
  return '';
}

/*
 * The branch endpoint is the same one Settings uses. It is authenticated and
 * branch-scoped, so a user who can use the assistant can read the shop type
 * without a new permission. A failed read is not an error for the assistant:
 * it simply falls back to the shop's categories.
 */
async function loadStoreType(api, branchId) {
  if (!api || typeof api.get !== 'function') return '';
  try {
    const payload = await api.get('branches/getOneStore', {
      id: branchId || undefined,
    });
    return storeTypeFromBranch(payload);
  } catch (error) {
    return '';
  }
}

module.exports = {
  STORE_TYPE_KEYS,
  loadStoreType,
  storeTypeFromBranch,
};
