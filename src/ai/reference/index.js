/*
 * The assistant's built-in reference.
 *
 * The markdown files beside this module are shipped inside the application.
 * They are the only source the assistant is allowed to use for "how do I"
 * answers, so a wrong menu path is a documentation bug, not a model guess.
 *
 * Sections are split on level-two headings. Each section is searchable by its
 * title and body; the help tool returns the best matches and the navigation
 * catalog supplies exact routes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const navigation = require('./navigation');

const FILES = ['CAPABILITIES.md', 'BEHAVIOR.md', 'NAVIGATION.md', 'USER_PROFILE.md'];
const MAX_BODY_CHARS = 1600;

let cached = null;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(value) {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !navigation.STOP_WORDS.has(token));
}

function slug(value) {
  return normalize(value).replace(/\s+/g, '-').slice(0, 80) || 'section';
}

function parseFile(file) {
  const raw = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const lines = raw.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = {
        id: `${file}#${slug(heading[1])}`,
        title: heading[1].trim(),
        file,
        lines: [],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  return sections
    .map((section) => {
      const body = section.lines.join('\n').trim();
      return {
        id: section.id,
        title: section.title,
        file: section.file,
        body,
        searchText: normalize(`${section.title}\n${body}`),
      };
    })
    .filter((section) => section.body || section.title);
}

function load() {
  if (cached) return cached;
  cached = FILES.flatMap(parseFile);
  return cached;
}

function excerpt(body, max = MAX_BODY_CHARS) {
  const text = String(body || '').trim();
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', max);
  return {
    text: text.slice(0, cut > max * 0.6 ? cut : max).trim(),
    truncated: true,
  };
}

function search(query, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 6)) : 3;
  const phrase = normalize(query);
  const words = tokens(query);
  if (!phrase) return [];

  const scored = load().map((section) => {
    const title = normalize(section.title);
    let score = 0;
    if (title.includes(phrase)) score += 30;
    if (section.searchText.includes(phrase)) score += 8;
    for (const word of words) {
      if (title.includes(word)) score += 12;
      else if (section.searchText.includes(word)) score += 3;
    }
    return { section, score };
  }).filter((entry) => entry.score > 0);

  scored.sort((left, right) => right.score - left.score || left.section.title.localeCompare(right.section.title));
  return scored.slice(0, limit).map(({ section }) => {
    const body = excerpt(section.body);
    return {
      id: section.id,
      title: section.title,
      file: section.file,
      body: body.text,
      truncated: body.truncated,
    };
  });
}

function index() {
  return load().map((section) => ({ id: section.id, title: section.title, file: section.file }));
}

module.exports = {
  FILES,
  index,
  load,
  navigation,
  normalize,
  search,
  tokens,
};
