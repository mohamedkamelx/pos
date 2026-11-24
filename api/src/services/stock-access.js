'use strict';
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { fail, allowed } = require('../utils/branch-access');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};

async function context(req) {
  const t = req.tenantContext;
  if (!t?.branchId || !t?.licenseId) fail('Choose a branch before changing stock.', 403);
  const branch = await req.db
    .collection('branches')
    .findOne({ _id: new ObjectId(String(t.branchId)), license: new ObjectId(String(t.licenseId)) });
  if (!branch) fail('Branch not found.', 403);
  return {
    branch,
    license: new ObjectId(String(t.licenseId)),
    branchId: new ObjectId(String(t.branchId)),
    userId: new ObjectId(String(req.user._id)),
    shopId: hash(String(t.licenseId)).slice(0, 24),
  };
}

function mapItem(row, options = {}) {
  const price = Math.round(Number(row.selling_price || 0) * 100);
  return {
    id: String(row._id || ''),
    name: String(row.name || row.item_name || 'Item'),
    stockLocations: require('../helpers/stock-locations').read(row),
    ...(options.decimal && row.item_weight_machine_based
      ? {
          quantityScale: 1000,
          unit: String(row.unit || '')
            .trim()
            .slice(0, 30),
        }
      : {}),
    price: Number.isSafeInteger(price) && price >= 0 && price <= 99999999999 ? price : 0,
    code: /^\d{1,6}$/.test(String(row.plu_code || '')) ? String(row.plu_code) : '',
    barcode: String(row.barcode_id || ''),
    barcodes: require('../utils/item-barcodes').codes(row),
    category: String(row.category_name || 'Items'),
    visual: '■',
    active:
      row.available_for_sale !== false &&
      !row.is_deleted &&
      ![1, '1', true].includes(row.del_status) &&
      row.activate !== false &&
      row.active !== false &&
      row.status !== 'inactive',
  };
}

module.exports = { fail, allowed, hash, canonical, context, mapItem };
