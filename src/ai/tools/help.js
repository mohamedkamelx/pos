/*
 * The assistant's how-to tool.
 *
 * It reads the packaged markdown reference and the structured navigation
 * catalog. It never guesses a screen name: if neither source covers the
 * question, the tool says so and the model is instructed to stop rather than
 * invent a control.
 */

'use strict';

const reference = require('../reference');

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 6;
const MAX_MODEL_BODY = 1200;

function text(value, max) {
  const string = typeof value === 'string' ? value.trim() : '';
  return string.length > max ? string.slice(0, max).trim() : string;
}

function compactDestination(destination) {
  if (!destination) return null;
  return {
    id: destination.id,
    label: destination.label,
    labelAr: destination.labelAr,
    menu: destination.menu,
    menuAr: destination.menuAr,
    route: destination.route,
    page: destination.page,
    description: destination.description,
    permission: destination.permission,
    actions: (destination.actions || []).slice(0, 5).map((action) => ({
      id: action.id,
      label: action.label,
      labelAr: action.labelAr,
      route: action.route,
      location: action.location,
      permission: action.permission,
    })),
  };
}

function searchHelp(input) {
  const query = text(input && input.query, 200);
  if (!query) {
    return {
      kind: 'error',
      code: 'invalid_query',
      message: 'Type the task or screen you want help with.',
    };
  }

  const requested = Number(input && input.limit);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.trunc(requested), MAX_LIMIT))
    : DEFAULT_LIMIT;

  const sections = reference.search(query, { limit }).map((section) => ({
    id: section.id,
    title: section.title,
    file: section.file,
    body: section.body,
    truncated: section.truncated,
  }));
  const destinations = reference.navigation.search(query, { limit: 3 }).map(compactDestination);

  return {
    kind: 'help',
    query,
    sections,
    destinations,
  };
}

function formatForModel(result) {
  if (!result) return 'The reference search returned no result.';
  if (result.kind === 'error') {
    return `The reference search failed: ${result.message} (code: ${result.code}).`;
  }
  if (!result.sections.length && !result.destinations.length) {
    return `No Posnic reference section matched "${result.query}". Do not invent a screen or control; say the reference does not cover it and point to the closest real page if one is known.`;
  }

  const lines = [`Posnic reference matches for "${result.query}":`];
  for (const section of result.sections) {
    lines.push('');
    lines.push(`### ${section.title} (${section.file})`);
    lines.push(text(section.body, MAX_MODEL_BODY));
    if (section.truncated) lines.push('(Section shortened.)');
  }
  if (result.destinations.length) {
    lines.push('');
    lines.push('Destinations:');
    for (const destination of result.destinations) {
      lines.push(`- ${destination.label}: ${destination.menu.join(' → ')} (${destination.route}). ${destination.description}`);
      for (const action of destination.actions) {
        lines.push(`  - ${action.label}: ${action.location} (${action.route})`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  compactDestination,
  formatForModel,
  searchHelp,
};
