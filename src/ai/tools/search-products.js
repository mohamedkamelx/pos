/*
 * Product search for the assistant.
 *
 * This is the first read tool. It deliberately reuses the existing
 * `GET /api/items/search` route, so branch scope and `item.read` are enforced
 * by the same controller the item list uses. That route now ranks exact
 * names/codes first and tolerates small spelling differences, partial words
 * and Arabic/English variants; the handler keeps a stable shape so the UI card
 * and the model contract do not change.
 */

'use strict';

const { clampLimit, number, text } = require('./values');

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function mapItem(item) {
  const stock = Number.isFinite(Number(item.available_quantity))
    ? Number(item.available_quantity)
    : number(item.quantity);
  return {
    id: String(item.id || item._id || ''),
    name: text(item.name, 200),
    category: text(item.category_name, 120),
    sellingPrice: number(item.selling_price),
    costPrice: number(item.company_price || item.cost_price),
    stock,
    trackInventory: item.track_inventory === true || item.track_inventory === 'true',
    unit: text(item.unit, 40),
    barcode: text(item.barcode_id, 80),
    sku: text(item.sku, 80),
    description: text(item.description, 300),
  };
}

async function searchProducts(input, { api } = {}) {
  if (!api || typeof api.get !== 'function') {
    return {
      kind: 'error',
      code: 'configuration_error',
      message: 'The shop data service is not available.',
    };
  }

  const query = text(input && input.query, MAX_QUERY_CHARS);
  if (!query) {
    return {
      kind: 'error',
      code: 'invalid_query',
      message: 'Type a product name, barcode or SKU to search.',
    };
  }

  const limit = clampLimit(input && input.limit, DEFAULT_LIMIT, MAX_LIMIT);

  let payload;
  try {
    payload = await api.get('items/search', { q: query, limit });
  } catch (error) {
    return {
      kind: 'error',
      code: (error && error.code) || 'request_failed',
      message: (error && error.message) || 'The product search failed.',
    };
  }

  const data = payload && payload.data;
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
  const results = list.slice(0, limit).map(mapItem).filter((item) => item.name);

  return {
    kind: 'product_search',
    query,
    count: results.length,
    results,
  };
}

function formatForModel(result) {
  if (!result) return 'The product search returned no result.';
  if (result.kind === 'error') {
    return `The product search failed: ${result.message} (code: ${result.code}).`;
  }
  if (!result.count) {
    return `No products in the current branch matched "${result.query}".`;
  }
  const lines = [
    `Products in the current branch matching "${result.query}":`,
    ...result.results.map((item, index) => {
      const parts = [
        `${index + 1}. ${item.name}`,
        item.id ? `id: ${item.id}` : '',
        item.category ? `category: ${item.category}` : '',
        `price: ${item.sellingPrice}`,
        `stock: ${item.stock}`,
        item.unit ? `unit: ${item.unit}` : '',
        item.barcode ? `barcode: ${item.barcode}` : '',
        item.sku ? `sku: ${item.sku}` : '',
      ].filter(Boolean);
      return parts.join(' | ');
    }),
    `Matches returned: ${result.count}.`,
  ];
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  formatForModel,
  mapItem,
  searchProducts,
};
