/*
 * Product list for the assistant.
 *
 * The search tool needs a keyword. "Which products do I have?" and "show me
 * everything in Drinks" do not have one, so they use the normal paginated item
 * route instead of forcing the user to invent a search word.
 */

'use strict';

const { clampLimit, number, text } = require('./values');
const { mapItem } = require('./search-products');

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

async function listProducts(input, { api } = {}) {
  if (!api || typeof api.get !== 'function') {
    return {
      kind: 'error',
      code: 'configuration_error',
      message: 'The shop data service is not available.',
    };
  }

  const query = text(input && input.query, MAX_QUERY_CHARS);
  const categoryId = text(input && input.categoryId, 80);
  const categoryName = text(input && input.categoryName, 160);
  const limit = clampLimit(input && input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const page = Math.max(1, parseInt(input && input.page, 10) || 1);

  let payload;
  try {
    if (query) {
      payload = await api.get('items/search', { q: query, limit: Math.min(limit, 50) });
    } else {
      const filters = {};
      if (categoryId) filters.category_id = categoryId;
      payload = await api.get('items', {
        limit,
        page,
        sort: 'name',
        ...(Object.keys(filters).length ? { filters: JSON.stringify(filters) } : {}),
      });
    }
  } catch (error) {
    return {
      kind: 'error',
      code: (error && error.code) || 'request_failed',
      message: (error && error.message) || 'The product list failed.',
    };
  }

  const data = payload && payload.data;
  let list = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
  if (query && categoryId) {
    list = list.filter((row) => String(row && row.category_id) === categoryId);
  }
  const results = list.slice(0, limit).map(mapItem).filter((item) => item.name);
  const total = query
    ? results.length
    : number(data && data.total, results.length);
  const totalPages = number(data && data.total_pages, 1);

  return {
    kind: 'product_list',
    query,
    categoryId,
    categoryName,
    count: results.length,
    total,
    page,
    totalPages,
    hasMore: query ? false : page < totalPages,
    results,
  };
}

function formatForModel(result) {
  if (!result) return 'The product list returned no result.';
  if (result.kind === 'error') {
    return `The product list failed: ${result.message} (code: ${result.code}).`;
  }
  const scope = result.categoryName
    ? ` in the category "${result.categoryName}"`
    : '';
  if (!result.count) {
    return result.query
      ? `No products in the current branch matched "${result.query}"${scope}.`
      : `No products were found in the current branch${scope}.`;
  }
  const heading = result.query
    ? `Products in the current branch matching "${result.query}"${scope}:`
    : `Products in the current branch${scope}:`;
  const lines = result.results.map((item, index) => {
    const parts = [
      `${index + 1}. ${item.name}`,
      item.id ? `id: ${item.id}` : '',
      item.category ? `category: ${item.category}` : '',
      `price: ${item.sellingPrice}`,
      /* See search-products: cost is in the mapped row and must reach the
         model or no margin question can be answered. Zero is "not set", so
         it stays out of the row instead of looking like a real cost. */
      Number(item.costPrice) > 0 ? `cost: ${item.costPrice}` : '',
      `stock: ${item.stock}`,
      item.unit ? `unit: ${item.unit}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  });
  const suffix = result.hasMore
    ? `Showing ${result.count} of ${result.total}. Ask for the next page or open the Items page for the full list.`
    : `Products returned: ${result.count}${result.total > result.count ? ` of ${result.total}` : ''}.`;
  return [heading, ...lines, suffix].join('\n');
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  formatForModel,
  listProducts,
};
