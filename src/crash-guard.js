'use strict';

/*
 * Last-resort process handlers.
 *
 * Node runs every uncaughtException listener. If one of them throws, Node
 * prints that second error as a fatal exception and exits, which hides the
 * original error and looks exactly like a crash in the listener. Our handler
 * used to do real work - a lazy require, log writes, console writes - on the
 * exception path, so a damaged file read or a logger failure during a routine
 * error could become the crash.
 *
 * Here the crash log is written first, from a function that never throws, and
 * the application handler runs behind the same guard. Nothing on this path is
 * allowed to become the failure.
 */

function installCrashGuards({ processObject = process, crashLog, context, onError } = {}) {
  if (!processObject || typeof processObject.on !== 'function' || typeof processObject.removeListener !== 'function') {
    throw new TypeError('installCrashGuards needs a process-like event emitter');
  }
  if (!crashLog || typeof crashLog.append !== 'function') {
    throw new TypeError('installCrashGuards needs a crash log');
  }

  const readContext = () => {
    try {
      const value = typeof context === 'function' ? context() : context;
      return value && typeof value === 'object' ? value : {};
    } catch (error) {
      return { contextError: `${error && error.name}: ${error && error.message}` };
    }
  };

  const write = (kind, error, extra = {}) => {
    try {
      crashLog.append(kind, error, { ...readContext(), ...extra });
    } catch (_) {
      /* The crash log must never be the reason the process dies. */
    }
  };

  const report = (kind, error) => {
    try {
      if (typeof onError === 'function') onError(kind, error);
    } catch (_) {
      /* The application's error handler is allowed to fail. The process is not. */
    }
  };

  /* This event fires before Node applies the uncaughtException decision, so it
     records an error even if a later listener throws. */
  const monitor = (error, origin) => write('uncaughtExceptionMonitor', error, { origin });
  const uncaught = (error) => {
    write('uncaughtException', error);
    report('uncaughtException', error);
  };
  const rejection = (reason) => {
    write('unhandledRejection', reason);
    report('unhandledRejection', reason);
  };
  /* Node gives us no stack for a native death, but a non-zero exit from JS is
     still a fact worth keeping: it distinguishes process.exit(1) from a
     signal, a segfault, or the window simply closing. */
  const exit = (code) => {
    if (Number(code) !== 0) write('processExit', null, { code });
  };

  processObject.on('uncaughtExceptionMonitor', monitor);
  processObject.on('uncaughtException', uncaught);
  processObject.on('unhandledRejection', rejection);
  processObject.on('exit', exit);

  return {
    uninstall() {
      processObject.removeListener('uncaughtExceptionMonitor', monitor);
      processObject.removeListener('uncaughtException', uncaught);
      processObject.removeListener('unhandledRejection', rejection);
      processObject.removeListener('exit', exit);
    },
  };
}

module.exports = { installCrashGuards };
