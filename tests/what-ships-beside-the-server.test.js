/*
 * A MODULE FLATTENED OUT OF THE ASAR STILL NEEDS ITS NEIGHBOURS.
 *
 * Several `src/` files are not in `build.files`. They are in `extraResources`,
 * copied to the resources root and FLATTENED:
 *
 *     { "from": "src/server.js", "to": "server.js" }
 *
 * So at runtime it is `resources/server.js`, and a `require('./local-crypto')`
 * inside it resolves to `resources/local-crypto.js` - not to
 * `resources/app.asar/src/local-crypto.js`, which is a different directory that
 * a relative require cannot reach.
 *
 * Every flattened module therefore needs its own relative requires copied to
 * that same level. Asserting that a filename appears somewhere in `build.files`
 * would be green for the entire life of a packaging bug, because a module in
 * the asar is not beside a module at the resources root. This file DERIVES the
 * requirement from what each flattened file actually requires instead.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const extra = ((pkg.build && pkg.build.extraResources) || []).filter(
  (e) => e && typeof e === 'object' && typeof e.from === 'string' && typeof e.to === 'string'
);

/** The files copied out of src/ and landed at the resources root. */
const flattened = extra.filter(
  (e) => e.from.startsWith('src/') && e.from.endsWith('.js') && !e.to.includes('/')
);

/** Everything that ends up at the resources root, by the name it lands under. */
const landed = new Set(extra.filter((e) => !e.to.includes('/')).map((e) => e.to.replace(/\.js$/, '')));

/** The relative requires in a file, without its comments. */
function relativeRequires(file) {
  const source = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
  const found = new Set();
  const pattern = /require\(\s*['"]\.\/([A-Za-z0-9._-]+)['"]\s*\)/g;
  let m;
  while ((m = pattern.exec(source)) !== null) found.add(m[1].replace(/\.js$/, ''));
  return [...found];
}

test('there are flattened resources to check at all', () => {
  /* An assertion over an empty list passes for ever, which is exactly the
     failure this file exists because of. */
  assert.ok(flattened.length >= 5, `expected the flattened src/ resources, found ${flattened.length}`);
  assert.ok(
    flattened.some((e) => e.from === 'src/server.js'),
    'server.js is no longer flattened to the resources root; this whole file assumes it is'
  );
});

test('EVERYTHING A FLATTENED FILE REQUIRES IS FLATTENED BESIDE IT', () => {
  const missing = [];
  for (const entry of flattened) {
    const file = path.join(ROOT, entry.from);
    if (!fs.existsSync(file)) {
      missing.push(`${entry.from} is in extraResources and not on disk`);
      continue;
    }
    for (const needed of relativeRequires(file)) {
      if (!landed.has(needed)) {
        missing.push(
          `${entry.to} requires ./${needed}, which is not copied to the resources root - ` +
            'at runtime that is MODULE_NOT_FOUND, and inside the server it is a request that is never answered'
        );
      }
    }
  }
  assert.deepStrictEqual(missing, [], missing.join('\n'));
});

test('a flattened file does not quietly reach up out of its directory', () => {
  /* `require('../something')` works from src/ and cannot work from the
     resources root, where there is no src/ above it. */
  for (const entry of flattened) {
    const file = path.join(ROOT, entry.from);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const climbs = [...source.matchAll(/require\(\s*['"](\.\.\/[A-Za-z0-9._/-]+)['"]\s*\)/g)].map(
      (m) => m[1]
    );
    assert.deepStrictEqual(
      climbs,
      [],
      `${entry.to} requires ${climbs.join(', ')}, which resolves differently once it is flattened to the resources root`
    );
  }
});
