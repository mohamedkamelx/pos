'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('../package.json');
const { installRuntimeAssetUpdater } = require('../scripts/after-pack.js');

const ASSET_UPDATER = 'src/asset-updater.js';

test('asset-updater is packaged inside app.asar and copied out for the API', (t) => {
  assert.ok(pkg.build.files.includes(ASSET_UPDATER), `${ASSET_UPDATER} must be in build.files`);
  assert.equal(
    (pkg.build.extraResources || []).some((entry) => entry.from === ASSET_UPDATER),
    false,
    `${ASSET_UPDATER} cannot be extraResources: that removes it from app.asar`,
  );

  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  const resourcesDir = path.join(appOutDir, 'resources');
  installRuntimeAssetUpdater({
    appOutDir,
    electronPlatformName: 'linux',
    packager: { getResourcesDir: () => resourcesDir },
  });

  const copied = path.join(resourcesDir, ASSET_UPDATER);
  assert.equal(
    fs.readFileSync(copied, 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', ASSET_UPDATER), 'utf8'),
  );
});
