'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { harden } = require('./harden-package');

const APPSTREAM_FILENAME = 'com.posnic.app.metainfo.xml';
const APPIMAGE_APPDATA_FILENAME = 'com.posnic.app.appdata.xml';
const APPSTREAM_SOURCE = path.join(__dirname, '..', 'builds', 'linux', APPSTREAM_FILENAME);
const ASSET_UPDATER_SOURCE = path.join(__dirname, '..', 'src', 'asset-updater.js');

function platformName(context) {
  return context.electronPlatformName
    || (context.packager && context.packager.platform && context.packager.platform.name);
}

/* asset-updater.js has two consumers in a packaged build. The desktop main
   process requires it from inside app.asar, while the API runs outside the
   asar and reaches it at resources/src/asset-updater.js. It cannot be listed
   in extraResources: electron-builder excludes extraResources from the asar,
   which makes the main-process require fail. Keep it in the asar and place the
   external copy here, after app.asar has been written. */
function installRuntimeAssetUpdater(context) {
  if (!fs.existsSync(ASSET_UPDATER_SOURCE)) {
    throw new Error(`[runtime] asset updater is missing: ${ASSET_UPDATER_SOURCE}`);
  }

  const resourcesDir = context.packager
    && typeof context.packager.getResourcesDir === 'function'
    ? context.packager.getResourcesDir(context.appOutDir)
    : path.join(context.appOutDir, 'resources');
  const destination = path.join(resourcesDir, 'src', 'asset-updater.js');

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(ASSET_UPDATER_SOURCE, destination);
  console.log(`[runtime] Copied asset updater: ${destination}`);
}

function includesTarget(context, targetName) {
  return (context.targets || []).some(
    (target) => String(target && target.name).toLowerCase() === targetName.toLowerCase(),
  );
}

function installLinuxAppStreamMetadata(context) {
  if (platformName(context) !== 'linux' || !includesTarget(context, 'AppImage')) return;

  if (!fs.existsSync(APPSTREAM_SOURCE)) {
    throw new Error(`[linux] AppStream metadata is missing: ${APPSTREAM_SOURCE}`);
  }

  const destinationDir = path.join(context.appOutDir, 'usr', 'share', 'metainfo');
  // AppImage's current lint tooling still discovers the legacy .appdata.xml
  // filename. Debian keeps the modern .metainfo.xml name through its fpm map.
  const destination = path.join(destinationDir, APPIMAGE_APPDATA_FILENAME);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(APPSTREAM_SOURCE, destination);
  fs.chmodSync(destination, 0o644);
  console.log(`[linux] Embedded AppStream metadata: ${destination}`);
}

function adhocSignMac(context) {
  const platform = platformName(context);
  if (platform !== 'darwin' && platform !== 'mac') return;

  /* If a real identity was configured, electron-builder has already signed
     this properly and re-signing ad-hoc would replace a good signature with a
     worthless one. */
  const configured = context.packager
    && context.packager.config
    && context.packager.config.mac
    && context.packager.config.mac.identity;
  if (configured) {
    console.log('[mac] A signing identity is configured; leaving the signature alone');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    console.warn(`[mac] ${appPath} not found; nothing to sign`);
    return;
  }

  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
      { stdio: 'inherit' },
    );

    const info = execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      + execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`[mac] Ad-hoc signed ${appName}${/adhoc/i.test(info) ? ' (verified adhoc)' : ''}`);
  } catch (error) {
    /* Keep the previous unsigned-mac behaviour if ad-hoc signing itself fails;
       a macOS toolchain problem must not discard Windows and Linux artifacts. */
    console.warn('[mac] Ad-hoc signing failed; the build will be unsigned:', error.message);
  }
}

exports.default = async function afterPack(context) {
  installRuntimeAssetUpdater(context);
  await harden(context);
  installLinuxAppStreamMetadata(context);
  adhocSignMac(context);
};

exports.installRuntimeAssetUpdater = installRuntimeAssetUpdater;
exports.installLinuxAppStreamMetadata = installLinuxAppStreamMetadata;
