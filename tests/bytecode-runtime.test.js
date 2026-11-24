'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const COMPILER = path.join(ROOT, 'scripts', 'compile-bytecode.js');
const RUNTIME = path.join(ROOT, 'src', 'bytecode-runtime.js');

test('bytecode compiler and runtime load CommonJS modules without source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-bytecode-test-'));
  try {
    const dep = path.join(dir, 'dep.js');
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(dep, 'module.exports = function (name) { return "hello " + name; };\n');
    fs.writeFileSync(
      entry,
      [
        "'use strict';",
        "const dep = require('./dep');",
        'exports.answer = 42;',
        'exports.add = (n) => n + 1;',
        'exports.greet = (name) => dep(name);',
      ].join('\n'),
    );

    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        files: [dep, entry].map((file) => ({
          input: file,
          output: file.replace(/\.js$/, '.jsc'),
          filename: `/posnic/test/${path.basename(file)}`,
        })),
      }),
    );

    const compiled = spawnSync(process.execPath, [COMPILER, '--manifest', manifest], {
      encoding: 'utf8',
    });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal(fs.existsSync(dep), false);
    assert.equal(fs.existsSync(entry), false);
    assert.ok(fs.statSync(path.join(dir, 'dep.jsc')).size > 0);

    require(RUNTIME).register();
    const loaded = require(path.join(dir, 'entry.jsc'));
    assert.equal(loaded.answer, 42);
    assert.equal(loaded.add(1), 2);
    assert.equal(loaded.greet('posnic'), 'hello posnic');
    const last = require(RUNTIME).lastBytecodeLoad();
    assert.equal(last.phase, 'loaded');
    assert.equal(last.filename, path.join(dir, 'entry.jsc'));
    assert.ok(last.cachedDataBytes > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime rejects bytecode whose cached data was changed or cut short', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-bytecode-corrupt-'));
  try {
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(entry, 'exports.value = 7;\n');
    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        files: [{ input: entry, output: entry.replace(/\.js$/, '.jsc'), filename: '/posnic/test/entry.js' }],
      }),
    );
    const compiled = spawnSync(process.execPath, [COMPILER, '--manifest', manifest], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);

    const file = entry.replace(/\.js$/, '.jsc');
    const original = fs.readFileSync(file);
    const damaged = Buffer.from(original);
    damaged[damaged.length - 1] ^= 0xff;
    fs.writeFileSync(file, damaged);

    require(RUNTIME).register();
    assert.throws(() => require(file), /cache checksum mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bytecode survives V8 flushing a function that has not run', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-bytecode-flush-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'entry.js');
  fs.writeFileSync(
    entry,
    [
      "'use strict';",
      'exports.early = () => "early";',
      'exports.late = () => "late";',
    ].join('\n'),
  );

  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      files: [{ input: entry, output: entry.replace(/\.js$/, '.jsc'), filename: '/posnic/test/flush.js' }],
    }),
  );
  const compiled = spawnSync(process.execPath, [COMPILER, '--manifest', manifest], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);

  require(RUNTIME).register();
  const loaded = require(entry.replace(/\.js$/, '.jsc'));
  assert.equal(loaded.early(), 'early');

  /* Flush every function that has not run, then call one of them. Without
     --no-flush-bytecode V8 recompiles it from the dummy source and throws
     "SyntaxError: Unexpected end of input". */
  const v8 = require('node:v8');
  v8.setFlagsFromString('--stress-flush-code');
  v8.setFlagsFromString('--allow-natives-syntax');
  try {
    for (let i = 0; i < 12; i += 1) eval('%CollectGarbage(null)');
    assert.equal(loaded.late(), 'late');
  } finally {
    v8.setFlagsFromString('--no-stress-flush-code');
  }
});

test('runtime rejects a cache from a different V8 version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-bytecode-bad-'));
  try {
    const file = path.join(dir, 'bad.jsc');
    const metadata = Buffer.from(JSON.stringify({ source: '/posnic/bad.js', v8: '0.0.0' }));
    const header = Buffer.alloc(20);
    Buffer.from('POSNICBC').copy(header, 0);
    header.writeUInt32LE(1, 8);
    header.writeUInt32LE(1, 12);
    header.writeUInt32LE(metadata.length, 16);
    fs.writeFileSync(file, Buffer.concat([header, metadata, Buffer.alloc(4)]));

    require(RUNTIME).register();
    assert.throws(() => require(file), /compiled for V8 0\.0\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
