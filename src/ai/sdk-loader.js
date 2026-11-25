/*
 * Keep this file as plain JavaScript in the release package.
 *
 * The main process ships as V8 bytecode. A dynamic import inside a vm.Script
 * compiled from bytecode has no import callback, so it fails with "A dynamic
 * import callback was not specified." This tiny un-compiled bridge is the one
 * place that asks Node's ESM loader for the OpenCode SDK.
 */

'use strict';

module.exports = function loadOpenCodeSdk() {
  return import('@opencode/sdk');
};
