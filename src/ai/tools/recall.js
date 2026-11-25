/*
 * Search this conversation's memory.
 *
 * The memory block in each prompt is deliberately short. When the user refers
 * to an earlier subject, or the assistant needs an exact detail from a previous
 * topic, this tool returns the matching topic summary, confirmed points,
 * records and plan previews without loading the whole conversation.
 */

'use strict';

const { text } = require('./values');

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 6;

function recallConversation(input, { memory, conversationId } = {}) {
  if (!memory || typeof memory.recall !== 'function') {
    return {
      kind: 'error',
      code: 'memory_unavailable',
      message: 'Conversation memory is not available.',
    };
  }
  const query = text(input && input.query, MAX_QUERY_CHARS);
  if (!query) {
    return {
      kind: 'error',
      code: 'invalid_query',
      message: 'Type the subject or detail you want to find.',
    };
  }
  const requested = Number(input && input.limit);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.trunc(requested), MAX_LIMIT))
    : DEFAULT_LIMIT;
  return memory.recall(conversationId, query, limit);
}

function formatForModel(result) {
  if (!result) return 'The conversation memory returned no result.';
  if (result.kind === 'error') {
    return `The conversation memory search failed: ${result.message} (code: ${result.code}).`;
  }
  if (!result.topics.length) {
    return `No earlier topic in this conversation matched "${result.query}".`;
  }
  const lines = [`Earlier conversation matches for "${result.query}":`];
  for (const topic of result.topics) {
    lines.push('');
    lines.push(`### ${topic.title} (${topic.status})`);
    if (topic.summary) lines.push(topic.summary);
    if (topic.points.length) {
      lines.push('Confirmed points:');
      for (const point of topic.points) lines.push(`- ${point}`);
    }
    if (topic.corrections.length) {
      lines.push('Corrections:');
      for (const correction of topic.corrections) lines.push(`- ${correction}`);
    }
    if (topic.products.length) {
      lines.push('Products:');
      for (const product of topic.products) {
        const parts = [product.name, product.id ? `id ${product.id}` : ''];
        if (Number.isFinite(Number(product.price))) parts.push(`price ${product.price}`);
        if (Number.isFinite(Number(product.stock))) parts.push(`stock ${product.stock}`);
        if (product.barcode) parts.push(`barcode ${product.barcode}`);
        if (product.sku) parts.push(`sku ${product.sku}`);
        lines.push(`- ${parts.filter(Boolean).join(' | ')}`);
      }
    }
    if (topic.categories.length) {
      lines.push('Categories:');
      for (const category of topic.categories) {
        lines.push(`- ${category.name}${category.id ? ` | id ${category.id}` : ''}`);
      }
    }
    if (topic.plans.length) {
      lines.push('Plan previews:');
      for (const plan of topic.plans) {
        const steps = (plan.steps || [])
          .map((step) => `${step.label}${step.name ? ` ${step.name}` : ''}`)
          .join('; ');
        lines.push(`- ${plan.id} | ${plan.status} | ${steps}`);
      }
    }
    if (topic.answered.length) {
      lines.push('Already answered:');
      for (const item of topic.answered) lines.push(`- ${item.question} -> ${item.answer}`);
    }
  }
  lines.push('');
  lines.push('Use this only as reference. Do not repeat a question the user already answered.');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_CHARS,
  formatForModel,
  recallConversation,
};
