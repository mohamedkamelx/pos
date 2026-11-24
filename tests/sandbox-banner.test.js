'use strict';

/*
 * The develop sandbox's banner must never cover a page's own bottom bar.
 *
 * It did: a fixed strip across the bottom with the highest z-index there
 * is, sitting on the ordering page's "View order" button, so nothing on
 * develop could be checked out. It is a mark on the right edge now, with
 * the message behind a tap.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const conf = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sandbox', 'nginx-develop.conf'), 'utf8');
const banner = conf.split('\n').find((line) => line.includes("sub_filter '</body>'")) || '';

test('the sandbox notice is a mark on the edge, not a bar across the bottom', () => {
  assert.ok(banner, 'the banner sub_filter is gone');
  assert.ok(!/left:0;right:0;bottom:0/.test(banner), 'the notice is a full-width bar over the bottom of the page again');
  assert.match(banner, /id="pz-sb"/, 'there is no mark to tap');
  assert.match(banner, /id="pz-sb-msg"/, 'there is no message to open');
  assert.match(banner, /sessionStorage/, 'the notice does not remember being read');
  /* nginx reads the value single-quoted; a single quote inside ends it. */
  const value = banner.slice(banner.indexOf("'</body>' '") + "'</body>' '".length);
  assert.ok(!value.slice(0, -2).includes("'"), 'a single quote inside the injected markup would end the nginx string');
});
