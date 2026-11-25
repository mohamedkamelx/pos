/*
 * Category list for the assistant.
 *
 * Reuses `GET /api/categories`, so `category.read`, branch scope and the
 * shop's own item counts come from the same controller the Categories page
 * uses. The tool is read-only and returns a small, stable shape for the card
 * and the model.
 */

'use strict';

const { clampLimit, number, text } = require('./values');

const MAX_QUERY_CHARS = 120;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function mapCategory(row) {
  const count = Number(row && row.items_count);
  return {
    id: String((row && (row.id || row._id)) || ''),
    name: text(row && row.name, 160),
    description: text(row && row.description, 300),
    itemCount: Number.isFinite(count) ? count : null,
    active: !(row && row.is_active === false),
  };
}

async function listCategories(input, { api } = {}) {
  if (!api || typeof api.get !== 'function') {
    return {
      kind: 'error',
      code: 'configuration_error',
      message: 'The shop data service is not available.',
    };
  }

  const query = text(input && input.query, MAX_QUERY_CHARS);
  const limit = clampLimit(input && input.limit, DEFAULT_LIMIT, MAX_LIMIT);

  let payload;
  try {
    payload = await api.get('categories', { limit, search: query, status: 'active' });
  } catch (error) {
    return {
      kind: 'error',
      code: (error && error.code) || 'request_failed',
      message: (error && error.message) || 'The category list failed.',
    };
  }

  const data = payload && payload.data;
  const list = Array.isArray(data) ? data : data && Array.isArray(data.list) ? data.list : [];
  const categories = list.slice(0, limit).map(mapCategory).filter((category) => category.name);

  return {
    kind: 'category_list',
    query,
    count: categories.length,
    total: number(data && data.total, categories.length),
    categories,
  };
}

function formatForModel(result) {
  if (!result) return 'The category list returned no result.';
  if (result.kind === 'error') {
    return `The category list failed: ${result.message} (code: ${result.code}).`;
  }
  if (!result.count) {
    return result.query
      ? `No categories in the current branch matched "${result.query}".`
      : 'No categories were found in the current branch.';
  }
  const heading = result.query
    ? `Categories in the current branch matching "${result.query}":`
    : 'Categories in the current branch:';
  const lines = result.categories.map((category, index) => {
    const parts = [
      `${index + 1}. ${category.name}`,
      category.itemCount == null ? '' : `${category.itemCount} items`,
      category.active ? '' : 'inactive',
      category.description || '',
    ].filter(Boolean);
    return parts.join(' | ');
  });
  return [
    heading,
    ...lines,
    `Categories returned: ${result.count} of ${result.total}.`,
  ].join('\n');
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  formatForModel,
  listCategories,
  mapCategory,
};
