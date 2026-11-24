/*
 * Module On/Off persistence drift guard.
 *
 * The Modules tab saves through setting.model updateCommonSettings - which
 * silently DROPPED every workforce/till/module toggle key, so "switch
 * everything off, refresh, everything is back on" shipped to the field:
 * nothing was written, and the default-ON read refilled the gaps.
 *
 * This pins the seam the bug lived in: every toggle key the frontend's
 * updateCommonSetting payload sends must appear in the api model function
 * that persists that payload. A key added client-side without its server
 * write fails here, in CI, instead of in a shop.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', 'frontend', 'static', 'script', 'js', 'modules', 'js', 'settings.js');
const API_MODEL = path.join(__dirname, '..', 'api', 'src', 'models', 'setting.model.js');

const TOGGLE_RE = /(module_[a-z_]+_enable|staff_[a-z]+_enable|cash_register_enable|till_lock_enable|till_lock_idle_minutes)/g;

function fnBody(source, name) {
  const start = source.indexOf(`async ${name}(`);
  assert.ok(start >= 0, `${name} not found in setting.model.js`);
  // Good enough for a guard: the function runs until the next `async ` at
  // the same nesting depth; scan braces.
  let depth = 0;
  // The body's opening brace is the one after the signature's ') {' - a
  // default parameter like (data = {}) plants an earlier, wrong '{'.
  let i = source.indexOf(') {', start) + 2;
  assert.ok(i > start, `${name} body not found`);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) break;
  }
  return source.slice(open, i);
}

test('every toggle the client payload sends is persisted through updateCommonSettings', () => {
  const client = fs.readFileSync(FRONTEND, 'utf8');
  const model = fs.readFileSync(API_MODEL, 'utf8');

  /*
   * The client builds its save payload from _moduleToggleIds rather than
   * spelling every switch out beside the request. Read that list directly;
   * a literal scan of the payload block only sees the two keys in the array
   * itself and silently misses the rest.
   */
  const idsStart = client.indexOf('_moduleToggleIds: [');
  assert.ok(idsStart >= 0, 'client _moduleToggleIds list not found');
  const idsBlock = client.slice(idsStart, client.indexOf(']', idsStart));
  const sent = [...new Set(idsBlock.match(/'([a-z_]+)'/g) || [])].map((key) => key.slice(1, -1));
  assert.ok(sent.length >= 10, `expected the payload to carry the toggle keys, found ${sent.length}`);

  const common = fnBody(model, 'updateCommonSettings');
  assert.ok(common.includes('updateBranchModules'),
    'updateCommonSettings no longer routes a modules-only payload to updateBranchModules');

  const mapStart = model.indexOf('static moduleToggleMap()');
  assert.ok(mapStart >= 0, 'moduleToggleMap not found in setting.model.js');
  const map = model.slice(mapStart, model.indexOf('\n  }', mapStart));
  const missing = sent.filter((key) => !map.includes(`${key}: { parse:`));
  assert.deepStrictEqual(
    missing,
    [],
    `moduleToggleMap drops toggle key(s) the client sends: ${missing.join(', ')} - ` +
      'updateBranchModules would silently ignore them'
  );
});
