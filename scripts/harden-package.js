'use strict';

/*
 * Release hardening that runs after electron-builder has written the app:
 *   - compile Node/Electron main-process and API JavaScript to V8 bytecode
 *   - remove source maps and sourceMappingURL comments
 *   - minify the few scripts the print renderer reads as text
 *
 * Browser/renderer/preload code cannot execute V8 bytecode, so those files
 * stay JavaScript. They are minified or already minified and never carry maps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const RUNTIME_SOURCE = path.join(ROOT, 'src', 'bytecode-runtime.js');
const COMPILER = path.join(__dirname, 'compile-bytecode.js');

// Scripts loaded by Chromium HTML pages or as Electron preload scripts.
// They are discovered from the packaged HTML below; this list also covers
// preload.js, which is referenced from main-process code, not HTML.
const APP_RENDERER_FILES = new Set([
  'src/bytecode-runtime.js',
  'src/bytecode-bootstrap.js',
  'src/preload.js',
]);

// The crash path stays readable JavaScript. A .jsc has no source to recompile
// from if V8 flushes its bytecode, so a crash handler compiled to bytecode can
// itself throw "Unexpected end of input" while recording an unrelated failure.
// Keeping these two plain means the next crash still leaves a full stack.
const APP_KEEP_JS = new Set([
  'src/crash-log.js',
  'src/crash-guard.js',
  /* Dynamic import from a vm.Script has no import callback, so the ESM bridge
     must stay a normal module. */
  'src/ai/sdk-loader.js',
]);

// These two are also read as text and executed inside the hidden print window.
// Bytecode would make them unreadable to that renderer.
const API_KEEP_JS = new Set([
  'src/helpers/receipt-design.js',
  'src/helpers/sale-payment-summary.js',
  /* The assistant loads the one shared search module from the API resource,
     so it must stay plain JavaScript in the packaged API as well. */
  'src/utils/smart-search.js',
]);

/* Native files cannot be loaded from inside an asar archive. The repack below
   rebuilds the archive, so every runtime native library - not only the
   serialport binding - has to be named here. The embedded OpenCode SDK pulls
   in the TUI renderer and PTY helper even for chat-only use. */
const ASAR_UNPACK = '**/node_modules/{@serialport/bindings-cpp,@opentui/core-linux-x64,@opencode/pty-linux-x64-gnu,@ff-labs/fff-bin-linux-x64-gnu,bun-pty,@number0/iroh-linux-x64-gnu}/**';

function walk(dir, predicate = () => true) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, predicate));
    else if (entry.isFile() && predicate(full)) found.push(full);
  }
  return found;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function stripSourceMapComments(text) {
  return text
    .replace(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=.*$/gm, '')
    .replace(/\/\*[#@][ \t]*sourceMappingURL=[\s\S]*?\*\//g, '');
}

function stripMaps(dir) {
  let deleted = 0;
  let cleaned = 0;
  for (const file of walk(dir)) {
    if (file.endsWith('.map')) {
      fs.unlinkSync(file);
      deleted++;
      continue;
    }
    if (!/\.(?:js|css|html)$/i.test(file)) continue;
    const before = readText(file);
    const after = stripSourceMapComments(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      cleaned++;
    }
  }
  return { deleted, cleaned };
}

function htmlScripts(dir) {
  const names = new Set();
  for (const file of walk(dir, (name) => name.endsWith('.html'))) {
    const html = readText(file);
    for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      const raw = match[1].split('?')[0].replace(/\\/g, '/');
      const base = path.posix.basename(raw);
      if (base.endsWith('.js')) names.add(base);
    }
  }
  return names;
}

function addFile(files, input, virtualName) {
  const output = input.replace(/\.js$/, '.jsc');
  files.push({ input, output, filename: virtualName });
}

function targetArch(context) {
  const names = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  return typeof context.arch === 'number' ? names[context.arch] : String(context.arch || '');
}

function platformName(context) {
  return context.electronPlatformName
    || (context.packager && context.packager.platform && context.packager.platform.name);
}

function resourcesDir(context) {
  return context.packager && typeof context.packager.getResourcesDir === 'function'
    ? context.packager.getResourcesDir(context.appOutDir)
    : path.join(context.appOutDir, 'resources');
}

function electronBinary() {
  const electron = require('electron');
  const candidate = typeof electron === 'string' ? electron : '';
  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error('[bytecode] could not find the Electron runtime. Install dev dependencies first.');
  }
  return candidate;
}

function compileManifest(files, label) {
  if (!files.length) return;
  const manifestPath = path.join(os.tmpdir(), `posnic-bytecode-${process.pid}-${label}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 2));
  try {
    const result = spawnSync(electronBinary(), [COMPILER, '--manifest', manifestPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`[bytecode] compiler failed for ${label} with exit code ${result.status}`);
    }
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }
}

async function minify(file) {
  if (!fs.existsSync(file)) return false;
  let terser;
  try {
    terser = require(path.join(ROOT, 'frontend', 'node_modules', 'terser'));
  } catch (_) {
    console.warn(`[harden] terser unavailable; leaving ${file} unminified`);
    return false;
  }
  const result = await terser.minify(readText(file), {
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  if (result.error) throw result.error;
  if (result.code) {
    fs.writeFileSync(file, result.code);
    return true;
  }
  return false;
}

async function harden(context) {
  const setting = String(process.env.POSNIC_BYTECODE || '').toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(setting)) {
    console.log('[bytecode] disabled by POSNIC_BYTECODE');
    return;
  }

  const platform = platformName(context);
  if (platform !== 'win32' && platform !== 'linux') {
    console.log(`[bytecode] skipped for ${platform}; Windows and Linux are the protected release targets`);
    return;
  }
  if (platform !== process.platform) {
    throw new Error(
      `[bytecode] ${platform} packages must be built on ${platform} so the cache matches the bundled V8. ` +
        'Build on that OS, or set POSNIC_BYTECODE=0 for an unprotected cross-build.',
    );
  }
  const arch = targetArch(context);
  if (arch && arch !== process.arch) {
    throw new Error(
      `[bytecode] target ${arch} does not match build host ${process.arch}. ` +
        'Build for that architecture on a matching runner, or set POSNIC_BYTECODE=0.',
    );
  }

  const resources = resourcesDir(context);
  const asarPath = path.join(resources, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    throw new Error(`[bytecode] app.asar not found: ${asarPath}`);
  }

  fs.mkdirSync(path.join(resources, 'src'), { recursive: true });
  for (const destination of [
    path.join(resources, 'bytecode-runtime.js'),
    path.join(resources, 'src', 'bytecode-runtime.js'),
  ]) {
    fs.copyFileSync(RUNTIME_SOURCE, destination);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-asar-'));
  try {
    asar.extractAll(asarPath, tempDir);
    fs.copyFileSync(RUNTIME_SOURCE, path.join(tempDir, 'src', 'bytecode-runtime.js'));
    fs.copyFileSync(
      path.join(ROOT, 'src', 'bytecode-bootstrap.js'),
      path.join(tempDir, 'src', 'bytecode-bootstrap.js'),
    );

    const renderers = htmlScripts(tempDir);
    const appFiles = [];
    for (const file of walk(path.join(tempDir, 'src'), (name) => name.endsWith('.js'))) {
      const rel = path.relative(tempDir, file).replace(/\\/g, '/');
      if (APP_RENDERER_FILES.has(rel)) continue;
      if (APP_KEEP_JS.has(rel)) continue;
      if (renderers.has(path.basename(file))) continue;
      if (rel === 'src/server.js') continue;
      addFile(appFiles, file, `/posnic/app/${rel}`);
    }
    compileManifest(appFiles, 'app');

    const apiRoot = path.join(resources, 'api');
    const apiFiles = [];
    for (const file of walk(apiRoot, (name) => name.endsWith('.js'))) {
      const rel = path.relative(apiRoot, file).replace(/\\/g, '/');
      if (!rel.startsWith('src/') && rel !== 'app.js') continue;
      if (API_KEEP_JS.has(rel)) continue;
      addFile(apiFiles, file, `/posnic/api/${rel}`);
    }
    compileManifest(apiFiles, 'api');

    const extraRoot = path.join(resources, 'src');
    const extraFiles = [];
    for (const file of walk(extraRoot, (name) => name.endsWith('.js'))) {
      const rel = path.relative(extraRoot, file).replace(/\\/g, '/');
      if (rel === 'bytecode-runtime.js') continue;
      addFile(extraFiles, file, `/posnic/ext/${rel}`);
    }
    compileManifest(extraFiles, 'ext');

    const pkgPath = path.join(tempDir, 'package.json');
    const packaged = JSON.parse(readText(pkgPath));
    packaged.main = 'src/bytecode-bootstrap.js';
    fs.writeFileSync(pkgPath, `${JSON.stringify(packaged, null, 2)}\n`);

    const stripped = [
      stripMaps(tempDir),
      stripMaps(path.join(resources, 'frontend')),
      stripMaps(path.join(resources, 'api')),
      stripMaps(path.join(resources, 'src')),
    ];

    await minify(path.join(resources, 'api', 'src', 'helpers', 'receipt-design.js'));
    await minify(path.join(resources, 'api', 'src', 'helpers', 'sale-payment-summary.js'));
    await minify(path.join(resources, 'frontend', 'static', 'script', 'js', 'core', 'receipt-designer.js'));

    fs.rmSync(asarPath, { force: true });
    fs.rmSync(`${asarPath}.unpacked`, { recursive: true, force: true });
    await asar.createPackageWithOptions(tempDir, asarPath, {
      unpack: ASAR_UNPACK,
    });
    asar.uncacheAll();

    const listed = asar.listPackage(asarPath).map((name) => name.replace(/\\/g, '/'));
    if (!listed.includes('/src/bytecode-bootstrap.js')) {
      throw new Error('[bytecode] bootstrap missing from repacked app.asar');
    }
    if (!listed.includes('/src/main.jsc') || listed.includes('/src/main.js')) {
      throw new Error('[bytecode] main.js was not replaced by bytecode');
    }
    if (listed.some((name) => name.endsWith('.map'))) {
      throw new Error('[bytecode] source maps remain in app.asar');
    }
    for (const name of APP_KEEP_JS) {
      if (!listed.includes(`/${name}`) || listed.includes(`/${name.replace(/\.js$/, '.jsc')}`)) {
        throw new Error(`[bytecode] ${name} must ship as plain JavaScript`);
      }
    }
    if (walk(path.join(resources, 'frontend')).some((name) => name.endsWith('.map'))) {
      throw new Error('[bytecode] source maps remain beside the frontend');
    }

    const mapCount = stripped.reduce((sum, item) => sum + item.deleted, 0);
    const commentCount = stripped.reduce((sum, item) => sum + item.cleaned, 0);
    console.log(
      `[bytecode] app ${appFiles.length}, api ${apiFiles.length}, extra ${extraFiles.length} modules; ` +
        `removed ${mapCount} maps and ${commentCount} source-map comments`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    asar.uncacheAll();
  }
}

module.exports = { APP_KEEP_JS, harden };
