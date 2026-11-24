/*
 * NO IPC CHANNEL IS REGISTERED TWICE.
 *
 * `ipcMain.handle` THROWS on a duplicate channel: "Attempted to register a
 * second handler for 'x'". Inside setupHardwareIPC that is not a warning in a
 * log - it aborts the function, so every handler AFTER the duplicate is never
 * registered at all. The screens that call them then fail with "No handler
 * registered", which reads like a broken screen rather than a line of
 * registration that never ran.
 *
 * It happened: `bill:get-printing-key` went in twice, because a patch script
 * was run twice after a mid-way failure. It shipped in beta.847, and it took
 * the print log handlers, the reprint handler and the scale down with it.
 *
 * The same file is scanned for duplicate `ipcMain.on` channels, which do not
 * throw but silently double-fire - the quieter half of the same mistake.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');

/** Every .js file in src/, where the main process registers its handlers. */
function mainProcessFiles() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(ROOT, e.name));
}

/** channel -> how many times this file registers it. */
function channels(source, call) {
  const found = new Map();
  const pattern = new RegExp(`ipcMain\\.${call}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  for (const m of source.matchAll(pattern)) {
    found.set(m[1], (found.get(m[1]) || 0) + 1);
  }
  return found;
}

test('no file registers the same ipcMain.handle channel twice', () => {
  const offences = [];
  for (const file of mainProcessFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [channel, count] of channels(source, 'handle')) {
      if (count > 1) offences.push(`${path.basename(file)}: '${channel}' x${count}`);
    }
  }
  assert.deepStrictEqual(offences, [],
    'ipcMain.handle throws on a duplicate, and everything registered after it in that '
    + 'function never runs:\n  ' + offences.join('\n  '));
});

test('no channel is handled by two different files either', () => {
  /*
   * Two files registering one channel is the same throw, just harder to see -
   * and whichever file is required second is the one that dies.
   */
  const owners = new Map();
  for (const file of mainProcessFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const channel of channels(source, 'handle').keys()) {
      const list = owners.get(channel) || [];
      list.push(path.basename(file));
      owners.set(channel, list);
    }
  }
  const shared = [...owners.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([channel, files]) => `'${channel}' in ${files.join(' and ')}`);
  assert.deepStrictEqual(shared, []);
});

test('no file listens on the same ipcMain.on channel twice', () => {
  /* These do not throw. They fire twice, which is worse: a print handler
     registered twice prints two copies of everything. */
  const offences = [];
  for (const file of mainProcessFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [channel, count] of channels(source, 'on')) {
      if (count > 1) offences.push(`${path.basename(file)}: '${channel}' x${count}`);
    }
  }
  assert.deepStrictEqual(offences, []);
});
