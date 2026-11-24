'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

test('Windows-only jump-list registration never runs on Linux', () => {
  /*
   * Electron 43 implements app.setUserTasks only on Windows. Calling it on
   * Linux used to trap the main process before the window appeared, which made
   * the hardened package look like a bytecode failure.
   */
  assert.match(
    MAIN,
    /if \(process\.platform === 'win32' && !customUserData\) app\.setUserTasks\(\[/,
    'app.setUserTasks must stay behind the win32 guard',
  );
});
