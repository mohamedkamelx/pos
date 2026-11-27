'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  conceptsForProfiles,
  profileIdsForStoreType,
  rankCategories,
  storeTypeValues,
} = require('../src/ai/local/category-suggest');
const {
  loadStoreType,
  storeTypeFromBranch,
} = require('../src/ai/local/store-type');

const SHOP_CATEGORIES = [
  { id: 'mobile', name: 'موبايلات', itemCount: 12 },
  { id: 'clothes', name: 'ملابس', itemCount: 7 },
  { id: 'shoes', name: 'أحذية', itemCount: 4 },
  { id: 'food', name: 'مواد غذائية', itemCount: 30 },
];

test('the registered store type wins over category inference', () => {
  const electronics = rankCategories({
    name: 'iPhone 15 8 RAM 32GB',
    categories: SHOP_CATEGORIES,
    storeType: 'electronics',
  });
  assert.equal(electronics.storeConfidence, 'explicit');
  assert.deepEqual(electronics.storeProfiles, ['electronics']);
  assert.equal(electronics.recommended.name, 'موبايلات');
  assert.equal(electronics.confidence, 'high');

  const fashion = rankCategories({
    name: 'iPhone 15 8 RAM 32GB',
    categories: SHOP_CATEGORIES,
    storeType: 'fashion',
  });
  assert.equal(fashion.storeConfidence, 'explicit');
  assert.deepEqual(fashion.storeProfiles, ['fashion']);
  assert.equal(fashion.recommended, null);
  assert.deepEqual(fashion.candidates, []);
});

test('a one-letter brand slip still reaches the mobile category', () => {
  const ranking = rankCategories({
    name: 'iPhon 15',
    categories: SHOP_CATEGORIES,
    storeType: 'electronics',
  });
  assert.equal(ranking.confidence, 'high');
  assert.equal(ranking.recommended.name, 'موبايلات');
});

test('a supermarket is not offered a mobile category for a phone', () => {
  const ranking = rankCategories({
    name: 'iPhone 15 8 RAM 32GB',
    categories: SHOP_CATEGORIES,
    storeType: 'سوبر ماركت',
  });
  assert.equal(ranking.storeConfidence, 'explicit');
  assert.deepEqual(ranking.storeProfiles, ['supermarket']);
  assert.equal(ranking.recommended, null);
});

test('a registered type this vocabulary does not know is not replaced by inference', () => {
  const ranking = rankCategories({
    name: 'iPhone 15 8 RAM 32GB',
    categories: SHOP_CATEGORIES,
    storeType: 'retail',
  });
  assert.equal(ranking.storeConfidence, 'unmapped');
  assert.deepEqual(ranking.storeProfiles, []);
  assert.equal(ranking.recommended.name, 'موبايلات');
});

test('shops installed before the field existed still infer a profile', () => {
  const ranking = rankCategories({
    name: 'iPhone 15 8 RAM 32GB',
    categories: SHOP_CATEGORIES,
  });
  assert.equal(ranking.storeConfidence, 'high');
  assert.ok(ranking.storeProfiles.includes('electronics'));
  assert.equal(ranking.recommended.name, 'موبايلات');
});

test('profile ids accept labels, Arabic names and a comma-separated list', () => {
  assert.deepEqual(profileIdsForStoreType('Electronics'), ['electronics']);
  assert.deepEqual(profileIdsForStoreType('بقالة'), ['supermarket']);
  assert.deepEqual(profileIdsForStoreType('electronics, fashion'), ['electronics', 'fashion']);
  assert.deepEqual(profileIdsForStoreType('mobile shop'), ['electronics']);
  assert.deepEqual(profileIdsForStoreType('retail'), []);
});

test('store type values are split without keeping empty entries', () => {
  assert.deepEqual(storeTypeValues('electronics, fashion'), ['electronics', 'fashion']);
  assert.deepEqual(storeTypeValues(['fashion; supermarket']), ['fashion', 'supermarket']);
  assert.deepEqual(storeTypeValues('  '), []);
});

test('concepts are limited to the registered profile', () => {
  const electronics = conceptsForProfiles(['electronics']).map((concept) => concept.id);
  assert.ok(electronics.includes('mobile'));
  assert.ok(!electronics.includes('food'));

  const supermarket = conceptsForProfiles(['supermarket']).map((concept) => concept.id);
  assert.ok(supermarket.includes('food'));
  assert.ok(!supermarket.includes('mobile'));
});

test('the branch document is read through the field names the register may use', () => {
  assert.equal(storeTypeFromBranch({ business_type: 'electronics' }), 'electronics');
  assert.equal(storeTypeFromBranch({ data: { businessType: 'fashion' } }), 'fashion');
  assert.equal(storeTypeFromBranch({ store_type: 'pharmacy' }), 'pharmacy');
  assert.equal(storeTypeFromBranch({ data: { business_type: ['electronics', 'fashion'] } }).join(','), 'electronics,fashion');
  assert.equal(storeTypeFromBranch({}), '');
});

test('loading the store type uses the authenticated branch endpoint', async () => {
  const calls = [];
  const api = {
    async get(path, query) {
      calls.push({ path, query });
      return { data: { business_type: 'electronics' } };
    },
  };
  assert.equal(await loadStoreType(api, 'branch-1'), 'electronics');
  assert.deepEqual(calls, [{ path: 'branches/getOneStore', query: { id: 'branch-1' } }]);
});

test('a failed store type read falls back to an empty value', async () => {
  const api = {
    async get() {
      throw new Error('forbidden');
    },
  };
  assert.equal(await loadStoreType(api, 'branch-1'), '');
  assert.equal(await loadStoreType(null, 'branch-1'), '');
});
