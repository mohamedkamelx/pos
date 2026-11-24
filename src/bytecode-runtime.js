'use strict';

/*
 * Loads the V8 code-cache files produced by scripts/compile-bytecode.js.
 *
 * This is the same mechanism bytenode uses: compile a CommonJS wrapper with
 * vm.Script, save createCachedData(), and load that cache with a source string
 * of the same length. V8 verifies the source length, not its contents, so the
 * original source never has to ship. Functions must be compiled eagerly
 * (--no-lazy), otherwise a lazily-compiled function would need its source when
 * it is first called.
 *
 * Only Node/Electron main-process code can use this. Chromium renderer and
 * preload scripts are executed by the browser engine, not Node.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const v8 = require('v8');
const Module = require('module');

const MAGIC = Buffer.from('POSNICBC', 'ascii');
const VERSION = 1;
const FIXED_HEADER = 20;
let registered = false;
let lastLoad = null;

/*
 * V8 drops bytecode that has not run for several garbage collections and
 * recompiles it from source on the next call. A .jsc has no real source - the
 * loader passes spaces of the right length - so a flushed function fails with
 * "SyntaxError: Unexpected end of input" the first time it is used again.
 * That is how an idle till died the moment a settings page called a handler
 * that had not run since startup. The compile step sets this same flag so the
 * cache it writes is accepted here.
 */
v8.setFlagsFromString('--no-flush-bytecode');

/*
 * A read that returns fewer bytes than the file has is a real failure mode on
 * a FUSE mount that is being torn down (the AppImage runtime on Linux). A
 * short cache starts with a valid header and ends in the middle of V8's data;
 * the failure then depends on where the truncation fell. Retry a few times,
 * then refuse the file with a message that names the file and both sizes.
 */
function readStable(filename) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const expected = fs.statSync(filename).size;
    const buffer = fs.readFileSync(filename);
    if (buffer.length === expected) return buffer;
    last = { expected, actual: buffer.length };
    /* Synchronous retry: this runs during require, before the module exists. */
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(
    `[bytecode] incomplete read (${last ? last.actual : 0}/${last ? last.expected : 0} bytes): ${filename}`,
  );
}

function readHeader(buffer, filename) {
  if (buffer.length < FIXED_HEADER || !buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error(`[bytecode] not a Posnic bytecode file: ${filename}`);
  }
  const version = buffer.readUInt32LE(8);
  if (version !== VERSION) {
    throw new Error(`[bytecode] unsupported bytecode version ${version}: ${filename}`);
  }
  const sourceLength = buffer.readUInt32LE(12);
  const metadataLength = buffer.readUInt32LE(16);
  const dataStart = FIXED_HEADER + metadataLength;
  if (dataStart > buffer.length) {
    throw new Error(`[bytecode] truncated header: ${filename}`);
  }

  let metadata = {};
  try {
    metadata = JSON.parse(buffer.subarray(FIXED_HEADER, dataStart).toString('utf8'));
  } catch (_) {
    throw new Error(`[bytecode] invalid metadata: ${filename}`);
  }

  if (metadata.v8 && metadata.v8 !== process.versions.v8) {
    throw new Error(
      `[bytecode] compiled for V8 ${metadata.v8}, running V8 ${process.versions.v8}: ${filename}. Rebuild the package with this Electron version.`,
    );
  }

  return {
    sourceLength,
    metadata,
    cachedData: buffer.subarray(dataStart),
  };
}

function verifyCache(header, filename) {
  const expected = header.metadata.cacheSha256;
  if (!expected) return;
  const actual = crypto.createHash('sha256').update(header.cachedData).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `[bytecode] cache checksum mismatch (${header.cachedData.length} bytes): ${filename}`,
    );
  }
}

function loadBytecode(module, filename) {
  lastLoad = { filename, phase: 'reading', at: Date.now() };
  const buffer = readStable(filename);
  lastLoad = { filename, phase: 'reading', at: Date.now(), bytes: buffer.length };
  const header = readHeader(buffer, filename);
  lastLoad = {
    filename,
    phase: 'compiling',
    at: Date.now(),
    bytes: buffer.length,
    sourceLength: header.sourceLength,
    cachedDataBytes: header.cachedData.length,
  };
  verifyCache(header, filename);

  const virtualFilename =
    header.metadata.source || filename.replace(/\.jsc$/, '.js');
  const dummySource = ' '.repeat(header.sourceLength);

  let script;
  /*
   * Keep --no-lazy set while the cache is instantiated and run. The cache was
   * created under the same flag, and any function V8 still treats as lazy
   * would be parsed from the dummy source instead of its real body.
   */
  v8.setFlagsFromString('--no-lazy');
  try {
    script = new vm.Script(dummySource, {
      filename: virtualFilename,
      cachedData: header.cachedData,
    });

    if (script.cachedDataRejected) {
      throw new Error(
        `[bytecode] V8 rejected the cache for ${filename}. Rebuild with the Electron runtime that runs the app.`,
      );
    }

    const compiled = script.runInThisContext();
    if (typeof compiled !== 'function') {
      throw new Error(`[bytecode] compiled module did not return a function: ${filename}`);
    }

    const actualJs = filename.replace(/\.jsc$/, '.js');
    module.filename = actualJs;
    module.id = actualJs;
    module.path = path.dirname(actualJs);
    module.paths = Module._nodeModulePaths(path.dirname(actualJs));

    const localRequire = (request) => module.require(request);
    localRequire.resolve = (request) => Module._resolveFilename(request, module);
    localRequire.main = process.mainModule;
    localRequire.extensions = Module._extensions;
    localRequire.cache = Module._cache;

    compiled.call(
      module.exports,
      module.exports,
      localRequire,
      module,
      virtualFilename,
      path.dirname(actualJs),
    );
  } finally {
    v8.setFlagsFromString('--lazy');
  }
  lastLoad = {
    filename,
    phase: 'loaded',
    at: Date.now(),
    bytes: buffer.length,
    sourceLength: header.sourceLength,
    cachedDataBytes: header.cachedData.length,
  };
}

function lastBytecodeLoad() {
  return lastLoad ? { ...lastLoad } : null;
}

function register() {
  if (registered) return;
  require.extensions['.jsc'] = loadBytecode;
  registered = true;
}

module.exports = { register, readHeader, readStable, lastBytecodeLoad };
