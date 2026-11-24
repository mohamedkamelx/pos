'use strict';

/*
 * A deploy must not break the tabs that are already open.
 *
 * Owner: "mobile view add category shown and page broken. crashed." The
 * beacon log told the real story: no JS error at all - the page had lost
 * style/dashboard.<oldhash>.css with a 404. Ten deploys shipped that day;
 * each one ran rsync --delete on the tenant instance, so every deploy
 * deleted the bundles every already-open tab still referenced. The page
 * kept running, unstyled - which a person reads as "broken. crashed."
 *
 * The browser-side layers are pinned here: the service worker answers a
 * 404'd hashed bundle with the CURRENT build's file of the same family, and
 * the page and worker tolerate a broken cache layer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the service worker answers a dead hashed bundle with its current sibling', () => {
  const sw = read('frontend/sw-template.js');
  assert.match(sw, /function familyFallback\(pathname\)/);
  /* only precached families are eligible - guessing at others would serve
     wrong bytes with confidence */
  assert.match(sw, /for \(const entry of PRECACHE\)/);
  /* wired on BOTH failure paths: http error and network throw */
  const hits = sw.match(/familyFallback\(url\.pathname\)/g) || [];
  assert.ok(hits.length >= 2, 'the fallback lost one of its two failure paths');
});

test('phantom images heal themselves instead of burning the beacon budget', () => {
  /* src='' or src='undefined' resolves to the page URL and "fails" - our
     own template bug, six of which once consumed the whole per-IP beacon
     window while a real stylesheet 404 waited behind them. The watchdog
     swaps them to the placeholder pixel and keeps them out of the journal. */
  const dash = read('frontend/dashboard.html');
  const at = dash.indexOf("tagName === 'IMG'");
  assert.ok(at > -1, 'the phantom-image healer is gone');
  const block = dash.slice(at, at + 700);
  assert.match(block, /data:image\/gif;base64/);
  assert.match(block, /return;/);
  assert.match(block, /\(undefined\|null\)/);
});

test('the worker steps aside when its cache layer is wedged', () => {
  /* A full or corrupt Cache Storage made caches.open reject, the
     respondWith promise reject with it, and EVERY asset request die -
     a phone that "does not even open" while the origin is perfectly
     healthy. Each cached branch now ends by falling back to a plain
     network fetch, so a broken cache never outranks a working network. */
  const sw = read('frontend/sw-template.js');
  const fallthroughs = sw.match(/\)\.catch\(\(\) => fetch\(request\)\)/g) || [];
  assert.ok(fallthroughs.length >= 3,
    'a cached branch lost its network fall-through (' + fallthroughs.length + '/3)');
  /* and a failed cache WRITE never takes the answer with it */
  const putGuards = sw.match(/cache\.put\(request, response\.clone\(\)\)\.catch/g) || [];
  assert.ok(putGuards.length >= 2, 'a cache.put lost its guard');
});

test('a page that watches its own stylesheet die reloads once to re-pair', () => {
  const dash = read('frontend/dashboard.html');
  const at = dash.indexOf('posnic_repair_reload');
  assert.ok(at > -1, 'the one-shot repair reload is gone');
  const block = dash.slice(at - 700, at + 400);
  /* own bundles only, and exactly once per tab session */
  assert.match(block, /(dashboard\|login)/);
  assert.match(block, /sessionStorage\.getItem\('posnic_repair_reload'\)/);
  assert.match(block, /location\.reload\(\)/);
});
