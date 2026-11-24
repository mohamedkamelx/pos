'use strict';
// A portable support candidate, never a tag, installer rollout or published update.
const { build, Platform, Arch } = require('electron-builder');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const endpoint = process.env.POSNIC_DIAGNOSTIC_ENDPOINT || '';
if (!endpoint) throw Error('POSNIC_DIAGNOSTIC_ENDPOINT is required for a diagnostic build');
const url = new URL(endpoint);
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('POSNIC_DIAGNOSTIC_ENDPOINT must be an HTTPS origin');
const root = path.join(__dirname, '..');
/* A diagnostic build is a support artifact whose whole value is that its
   packaged source can be compared with the checkout. V8 bytecode removes those
   sources by design, so this one build stays readable. */
process.env.POSNIC_BYTECODE = '0';
const files = ['src/bill-design.js', 'api/src/helpers/bill-payload.js', 'src/diagnostics.js', 'src/diagnostic-session.js', 'src/diagnostic-health.js', 'src/diagnostic-splash.bmp', 'src/diagnostics.html', 'src/diagnostics-ui.js', 'src/preload.js', 'src/ipc-guard.js', 'src/hardware-manager.js', 'src/escpos-unicode.js', 'src/main.js', 'frontend/static/script/js/core/ajax.js', 'frontend/static/script/js/core/receipt-designer.js', 'frontend/static/script/js/modules/js/sales_view.js', 'frontend/static/script/js/modules/js/receiving_view.js', 'api/src/repositories/sale.repository.js', 'api/src/services/sale.service.js', 'frontend/static/script/js/modules/js/sales.js', 'src/hardware-ipc.js', 'src/hardware-manager.html'];
const digest = crypto.createHash('sha256');
for (const file of files) digest.update(file).update(fs.readFileSync(path.join(root, file)));
const marker = { enabled: true, endpoint: url.origin,
  buildId: new Date().toISOString().replace(/[:.]/g, '-'),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), sourceDigest: digest.digest('hex'), sourceDigestFiles: files };
build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), publish: 'never',
  config: { compression: 'store', extraMetadata: { posnicDiagnostic: marker }, portable: { splashImage: path.join(root, 'src/diagnostic-splash.bmp'), artifactName: 'Posnic-${version}-diagnostic-' + marker.buildId + '.exe' } } })
  .then(() => { fs.writeFileSync(path.join(root, 'dist/DIAGNOSTIC-BUILD.json'), JSON.stringify(marker, null, 2)); console.log('Private diagnostic portable built. Nothing published.'); })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
