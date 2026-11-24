'use strict';

/*
 * The app can only be fixed from a crash that left a stack behind.
 *
 * The idle crash was reported as the last two frames of a SyntaxError, from a
 * log file that had already been replaced at midnight. These tests keep the
 * first writer on the crash path independent of the application handler, keep
 * a throwing handler from taking the process down, and keep both new modules
 * inside the packaged app.asar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCrashLog } = require('../src/crash-log');
const { installCrashGuards } = require('../src/crash-guard');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-crash-'));

function readEntries(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('the crash log keeps the full stack and the tail of app.log', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crash.log');
  const log = createCrashLog({ file, now: () => new Date('2026-11-24T00:21:18.594Z') });

  const error = new SyntaxError('Unexpected end of input');
  assert.equal(log.append('uncaughtExceptionMonitor', error, {
    origin: 'uncaughtException',
    recentLog: '[Renderer] Main window started loading: #/inventorycounts',
  }), true);

  const [entry] = readEntries(file);
  assert.equal(entry.at, '2026-11-24T00:21:18.594Z');
  assert.equal(entry.kind, 'uncaughtExceptionMonitor');
  assert.equal(entry.error.name, 'SyntaxError');
  assert.equal(entry.error.message, 'Unexpected end of input');
  assert.match(entry.error.stack, /^SyntaxError: Unexpected end of input/);
  assert.equal(entry.context.origin, 'uncaughtException');
  assert.match(entry.context.recentLog, /inventorycounts/);
  assert.ok(entry.process.node);
});

test('the crash log redacts credentials but keeps the error', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crash.log');
  const log = createCrashLog({ file });

  log.append('uncaughtException', new Error('cannot reach mongodb://shop:supersecret@127.0.0.1:27017'), {
    authorization: 'Bearer abc123',
    password: 'hunter2',
  });

  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\[REDACTED\]/);
  assert.ok(!text.includes('supersecret'));
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('hunter2'));
  assert.match(text, /cannot reach mongodb:\/\/shop:\[REDACTED\]@127\.0\.0\.1/);
});

test('the crash log rotates instead of growing without limit', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crash.log');
  const log = createCrashLog({ file, maxBytes: 200 });

  log.append('first', new Error('one'));
  log.append('second', new Error('two'));

  assert.ok(fs.existsSync(`${file}.old`));
  assert.equal(readEntries(file).at(-1).kind, 'second');
});

test('a throwing application handler cannot take the process down', () => {
  const processLike = new EventEmitter();
  const guards = installCrashGuards({
    processObject: processLike,
    crashLog: { append() { throw new Error('disk full'); } },
    context() { throw new Error('no context'); },
    onError() { throw new Error('handler failed'); },
  });

  assert.doesNotThrow(() => processLike.emit('uncaughtExceptionMonitor', new SyntaxError('first'), 'uncaughtException'));
  assert.doesNotThrow(() => processLike.emit('uncaughtException', new SyntaxError('second')));
  assert.doesNotThrow(() => processLike.emit('unhandledRejection', new Error('third'), Promise.resolve()));

  guards.uninstall();
  assert.equal(processLike.listenerCount('uncaughtException'), 0);
  assert.equal(processLike.listenerCount('unhandledRejection'), 0);
  assert.equal(processLike.listenerCount('exit'), 0);
});

test('a non-zero exit is recorded and a normal exit is not', () => {
  const calls = [];
  const processLike = new EventEmitter();
  const guards = installCrashGuards({
    processObject: processLike,
    crashLog: { append: (...args) => calls.push(args) },
  });

  processLike.emit('exit', 0);
  assert.equal(calls.length, 0);
  processLike.emit('exit', 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'processExit');
  assert.equal(calls[0][2].code, 1);
  guards.uninstall();
});

test('a real uncaught error is recorded and the process survives', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crash.log');
  const script = `
    const { createCrashLog } = require(${JSON.stringify(path.join(ROOT, 'src', 'crash-log.js'))});
    const { installCrashGuards } = require(${JSON.stringify(path.join(ROOT, 'src', 'crash-guard.js'))});
    installCrashGuards({
      crashLog: createCrashLog({ file: ${JSON.stringify(file)} }),
      onError: (kind) => console.log('HANDLED ' + kind),
    });
    setTimeout(() => { throw new SyntaxError('Unexpected end of input'); }, 10);
    setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 200);
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /HANDLED uncaughtException/);
  assert.match(child.stdout, /ALIVE/);
  assert.ok(!child.stderr.includes('Unexpected end of input'), child.stderr);

  const entries = readEntries(file);
  const monitor = entries.find((entry) => entry.kind === 'uncaughtExceptionMonitor');
  const uncaught = entries.find((entry) => entry.kind === 'uncaughtException');
  assert.ok(monitor, 'the monitor entry must be written before the handler');
  assert.equal(monitor.context.origin, 'uncaughtException');
  assert.match(monitor.error.stack, /Unexpected end of input/);
  assert.ok(uncaught, 'the handler entry must be written too');
});

test('the crash path ships and the desktop server does not own process errors', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('src/crash-log.js'), 'crash-log.js is missing from app.asar');
  assert.ok(pkg.build.files.includes('src/crash-guard.js'), 'crash-guard.js is missing from app.asar');

  const main = read('src/main.js');
  assert.match(main, /installCrashGuards\s*\(/);
  assert.ok(!/process\.on\(['"]uncaughtException['"]/.test(main), 'main.js registers a raw uncaught handler again');
  assert.ok(!/process\.on\(['"]unhandledRejection['"]/.test(main), 'main.js registers a raw rejection handler again');
  assert.match(main, /uncaughtExceptionMonitor|crash\.log|POSNIC_CRASH_LOG/, 'main.js does not name the crash log');

  const logger = read('api/src/utils/logger.js');
  assert.match(logger, /POSNIC_MAIN_PROCESS/);
  assert.match(logger, /mainOwnsProcessErrors/);
});
