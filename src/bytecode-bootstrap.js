'use strict';

/*
 * Packaged entry point. Development keeps package.json -> src/main.js.
 * electron-builder's extraMetadata points the packaged app here.
 *
 * This file, the runtime and the crash modules are shipped as plain JavaScript
 * rather than bytecode, so a failure while loading main.jsc still leaves a
 * readable record.
 */

const path = require('path');

try {
  require('./bytecode-runtime').register();
  require('./main.jsc');
} catch (error) {
  try {
    const { app } = require('electron');
    const { createCrashLog } = require('./crash-log');
    createCrashLog({ file: path.join(app.getPath('userData'), 'crash.log') })
      .append('bootstrap', error, { phase: 'require-main' });
  } catch (_) {
    /* Recording must never replace the original failure. */
  }
  throw error;
}
