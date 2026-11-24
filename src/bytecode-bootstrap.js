'use strict';

/*
 * Packaged entry point. Development keeps package.json -> src/main.js.
 * electron-builder's extraMetadata points the packaged app here.
 */
require('./bytecode-runtime').register();
require('./main.jsc');
