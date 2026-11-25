/*
 * Small value helpers shared by the assistant's read tools.
 *
 * The tools receive model-generated input, so every field is treated as
 * untrusted: text is trimmed and capped, numbers are finite, and limits are
 * clamped before they reach the local API.
 */

'use strict';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, max = 300) {
  const string = typeof value === 'string' ? value.trim() : '';
  return string.length > max ? string.slice(0, max).trim() : string;
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

module.exports = { clampLimit, number, text };
