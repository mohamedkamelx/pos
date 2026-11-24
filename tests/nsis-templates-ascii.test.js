'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEMPLATES = path.join(
  ROOT,
  'node_modules',
  'app-builder-lib',
  'templates',
  'nsis'
);

function nshFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return nshFiles(full);
    return entry.name.endsWith('.nsh') ? [full] : [];
  });
}

test('installed NSIS templates are ASCII so the ANSI compiler can read them', (t) => {
  if (!fs.existsSync(TEMPLATES)) {
    t.skip('electron-builder is not installed');
    return;
  }

  const files = nshFiles(TEMPLATES);
  assert.ok(files.length > 0, 'no NSIS templates were found');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(
      /^[\x00-\x7F]*$/.test(text),
      `${path.relative(ROOT, file)} contains non-ASCII characters`
    );
  }
});
