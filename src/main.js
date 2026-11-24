const electron = require('electron');

// Safety: if main.js is loaded as plain Node (not via Electron binary),
// `require('electron')` returns a string path. Detect and bail out clearly.
if (typeof electron === 'string') {
  console.error('❌ main.js was loaded as plain Node, not Electron.');
  console.error('   Please run via: npm run start  OR  electron .');
  process.exit(1);
}

const customUserData = require('./user-data-path').configure(electron.app);

const {
  app, BrowserWindow, ipcMain: rawIpcMain, Menu, Notification, session, dialog, shell, Tray,
  /* The OS keystore, used to unwrap the key that decrypts the database
     password. Available here because this is the main process of a real
     Electron application - a script run under ELECTRON_RUN_AS_NODE cannot even
     require('electron'), which is why scheduled work runs as the app. */
  safeStorage
} = electron;

/*
 * Every ipcMain handler in this file goes through the guard, which refuses a
 * message from any frame that is not one of this application's own pages.
 * rawIpcMain is kept for the places that need to pass the real object on -
 * pin-lock-ipc.js wraps it again itself.
 *
 * There were 78 handlers across this file and three others, and not one looked
 * at event.senderFrame. backup:restore and backup:delete were among them.
 */
const ipcMain = require('./ipc-guard').guard(rawIpcMain);
const {
  showSplash,
  closeSplash,
  splashIsOpen,
  showShutdown,
  setShutdownProgress,
  showWaitingForPrevious,
} = require('./splash');
const shutdownState = require('./shutdown-state');
const path = require('path');
const http = require('http');
const fs = require('fs');
const {
  hasUnexpiredAuthCookie,
  validateSavedLogin,
  clearStaleLogin
} = require('./startup-auth');

// === SINGLE INSTANCE PROTECTION ===
// Acquire this before loading hardware/database modules so a second launch
// exits before it can start another MongoDB or API server.
const hasSingleInstanceLock = app.requestSingleInstanceLock({
  startedAt: new Date().toISOString(),
  pid: process.pid
});

const profiles = new (require('./shop-profiles').ShopProfiles)(app.getPath('userData'));
const runningProfile = profiles.state.active;
let nextProfile = null;
process.env.POSNIC_MULTIPLE_SHOPS = profiles.state.shops.length > 1 ? '1' : '0';
process.env.POSNIC_ISOLATED_SHOP = runningProfile === 'original' ? '0' : '1';
if (runningProfile !== 'original') {
  const directory = profiles.directory(runningProfile);
  require('./user-data-path').configure(app, { POSNIC_USER_DATA: directory });
  process.env.POSNIC_UPLOADS_DIR = path.join(directory, 'uploads');
  process.env.FILE_UPLOAD_PATH = process.env.POSNIC_UPLOADS_DIR;
}

/*
 * Failing to get the lock means one of two very different things.
 *
 * Either another till is genuinely open - in which case the running instance
 * gets a 'second-instance' event, focuses itself, and this process should go
 * away - or the previous instance is still closing and has not let go yet.
 *
 * The second case used to be handled as if it were the first: exit(0), no
 * window, no message. Closing Posnic and immediately reopening it is an
 * ordinary thing to do, and for the ten seconds mongod takes to close its
 * files the icon simply did nothing. Clicking again did nothing again.
 *
 * So this asks which it is. The answer decides whether to leave, or to wait
 * and start - and waiting is handled after `ready`, because saying so needs a
 * window and there is no window before then.
 */
let waitingForPreviousShutdown = null;
if (!hasSingleInstanceLock) {
  try {
    waitingForPreviousShutdown = shutdownState.findInProgress(app.getPath('userData'));
  } catch (e) {
    waitingForPreviousShutdown = null;
  }

  if (!waitingForPreviousShutdown) {
    console.log('[Main] Another Posnic instance is already running');
    app.exit(0);
  } else {
    console.log(
      `[Main] The previous instance (pid ${waitingForPreviousShutdown.pid}) is still ` +
      'closing; waiting for it rather than exiting',
    );
  }
}

/*
 * posnic:// deep links ("Open my POS" on the website).
 *
 * Only from a packaged build. A development run registers process.execPath,
 * which is electron.exe - so the browser then asks "Open Electron?" and names
 * a program the shop has never heard of, for a link on their own account page.
 * Worse, it persists: the registry entry outlives the dev run, and the machine
 * keeps offering Electron until something overwrites it.
 *
 * The installer registers the scheme properly through build.protocols in
 * package.json, which is where a shop's machine gets it. This line is for the
 * case where the app has been moved or the registration lost, and it can only
 * ever point at a real installed Posnic.
 *
 * A second launch via the protocol lands in the existing second-instance
 * handler, which focuses the window; a cold start just opens the app normally.
 */
try {
  if (app.isPackaged && !customUserData) {
    app.setAsDefaultProtocolClient('posnic');
  }
} catch (err) {
  console.log('[Main] protocol registration skipped:', err.message);
}

// === CRYPTO POLYFILL (for MongoDB driver 7.x in Electron) ===
// Some Electron versions don't expose globalThis.crypto which mongodb 7.x needs
try {
  const nodeCrypto = require('crypto');
  if (!globalThis.crypto && nodeCrypto.webcrypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
  }
} catch (e) {
  console.error('Failed to polyfill crypto:', e.message);
}

const { HardwareManager } = require('./hardware-manager');
const { setupHardwareIPC } = require('./hardware-ipc');
const MongoDBManager = require('./mongodb-manager');
const { AssetUpdater } = require('./asset-updater');

// === FILE-BASED LOGGING (for packaged exe debugging) ===
// Title bar height in pixels. Windows draws its own at roughly 32 and
// shrinks it when maximised; 44 keeps the title readable either way.
const TITLEBAR_HEIGHT = Number(process.env.POSNIC_TITLEBAR_HEIGHT) || 44;
const LOG_FILE = path.join(app.getPath('userData'), 'app.log');
const OLD_LOG_FILE = path.join(app.getPath('userData'), 'app-old.log');
const LOG_DATE_FILE = path.join(app.getPath('userData'), '.app-log-date');
const HEALTH_FILE = path.join(app.getPath('userData'), 'health-status.json');
const crypto = require('crypto');
const { createCrashLog } = require('./crash-log');
const { installCrashGuards } = require('./crash-guard');
const diagnosticSession = require('./diagnostic-session');
const bytecodeRuntime = require('./bytecode-runtime');
const HEALTH_DISMISS_FILE = path.join(app.getPath('userData'), 'health-dismissed.json');
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

// Findings the shop chose not to be reminded about, keyed by a hash of the
// finding list, so anything new still surfaces. Errors are never suppressed.
function readHealthDismissals() {
  try { return JSON.parse(fs.readFileSync(HEALTH_DISMISS_FILE, 'utf8')); } catch { return []; }
}
function writeHealthDismissals(list) {
  try { fs.writeFileSync(HEALTH_DISMISS_FILE, JSON.stringify(list.slice(-20), null, 2)); }
  catch (e) { console.warn('[Health] could not save dismissal:', e.message); }
}
const WARNING_SUMMARY_INTERVAL_MS = 60 * 1000;
const WARNING_SUMMARY_COUNT = 25;
const repeatedWarnings = new Map();
const LOG_LEVELS = Object.freeze({
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50
});
const DEFAULT_LOG_LEVEL = app.isPackaged ? 'INFO' : 'DEBUG';
const REQUESTED_LOG_LEVEL = String(
  process.argv.includes('--debug-logs')
    ? 'DEBUG'
    : (process.env.POSNIC_LOG_LEVEL || DEFAULT_LOG_LEVEL)
).toUpperCase();
const ACTIVE_LOG_LEVEL = LOG_LEVELS[REQUESTED_LOG_LEVEL]
  ? REQUESTED_LOG_LEVEL
  : DEFAULT_LOG_LEVEL;
const ACTIVE_LOG_LEVEL_VALUE =
  LOG_LEVELS[ACTIVE_LOG_LEVEL];

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function redactSecrets(value) {
  return String(value)
    .replace(/(mongodb(?:\+srv)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/((?:register_userpassword|db_password|dbPassword|password|passphrase|access_token|refresh_token|api[_-]?key|gh_token|jwt_secret|session_secret|client_secret|cookie)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

function sanitizeLogText(value) {
  return redactSecrets(value)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function formatLogValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    const details = {
      name: value.name,
      message: value.message,
      code: value.code,
      errno: value.errno,
      syscall: value.syscall,
      path: value.path,
      url: value.url,
      stack: value.stack,
      cause: value.cause
    };
    return sanitizeLogText(JSON.stringify(details));
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return sanitizeLogText(JSON.stringify(value, (_key, nestedValue) => {
        if (typeof nestedValue === 'object' && nestedValue !== null) {
          if (seen.has(nestedValue)) return '[Circular]';
          seen.add(nestedValue);
        }
        return nestedValue;
      }));
    } catch (error) {
      return `[Unserializable ${value.constructor?.name || 'Object'}: ${error.message}]`;
    }
  }

  return sanitizeLogText(value);
}

function ensureDailyLog() {
  const today = getLocalDateKey();
  let activeDate = '';
  try {
    activeDate = fs.existsSync(LOG_DATE_FILE)
      ? fs.readFileSync(LOG_DATE_FILE, 'utf8').trim()
      : '';
  } catch (_) { }

  if (activeDate !== today || !fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(
      LOG_FILE,
      `=== Posnic Daily Log: ${today} ===\n`,
      'utf8'
    );
    fs.writeFileSync(LOG_DATE_FILE, today, 'utf8');
  }
}

function rotateLogIfNeeded(incomingBytes = 0) {
  try {
    if (!fs.existsSync(LOG_FILE)) return;

    const currentSize = fs.statSync(LOG_FILE).size;
    if (currentSize + incomingBytes <= MAX_LOG_SIZE_BYTES) return;

    if (fs.existsSync(OLD_LOG_FILE)) {
      fs.unlinkSync(OLD_LOG_FILE);
    }
    fs.renameSync(LOG_FILE, OLD_LOG_FILE);

    fs.writeFileSync(
      LOG_FILE,
      `=== Posnic Daily Log: ${getLocalDateKey()} ===\n` +
      `=== Log rotated at ${new Date().toISOString()} | previous=${path.basename(OLD_LOG_FILE)} | maxSizeMB=10 ===\n`,
      'utf8'
    );
  } catch (error) {
    try {
      // If Windows temporarily blocks rename, preserve logging by truncating
      // the active file and recording the rotation problem.
      fs.writeFileSync(
        LOG_FILE,
        `=== Posnic Daily Log: ${getLocalDateKey()} ===\n` +
        `=== Log rotation fallback at ${new Date().toISOString()} | error=${redactSecrets(error.message)} ===\n`,
        'utf8'
      );
    } catch (_) { }
  }
}

function shouldWriteLog(level) {
  return (LOG_LEVELS[level] || LOG_LEVELS.INFO) >= ACTIVE_LOG_LEVEL_VALUE;
}

function safeStringifyLogArg(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null) {
    // Null-prototype objects (e.g. req.query parsed by qs) have no
    // toString/valueOf, so String() throws "Cannot convert object to
    // primitive value". JSON.stringify works regardless of prototype.
    try {
      return JSON.stringify(value);
    } catch (_) {
      return Object.prototype.toString.call(value);
    }
  }
  try {
    return String(value);
  } catch (_) {
    return Object.prototype.toString.call(value);
  }
}

function inferInfoLevel(args) {
  const text = args
    .map(safeStringifyLogArg)
    .join(' ')
    .trim();

  const isVerboseDiagnostic =
    /(^|\s|\[)(debug|trace)(\]|\s|:|-)/i.test(text) ||
    /\[(dashboard context|pending activities)\]/i.test(text) ||
    /session filter|permission check result|session_applied/i.test(text);

  return isVerboseDiagnostic
    ? 'DEBUG'
    : 'INFO';
}

function getWarningKey(args) {
  const text = args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.name}:${arg.message}`;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch (_) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');

  return text
    .replace(/\bhttps?:\/\/[^\s"']+/gi, match => {
      try {
        const url = new URL(match.replace(/[),.;]+$/, ''));
        return `${url.origin}${url.pathname}`;
      } catch (_) {
        return match;
      }
    })
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, '<timestamp>')
    .replace(/\b\d{6,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function writeRepeatedWarningSummary(key, state) {
  if (!state || state.duplicateCount === 0) return;

  writeLog(
    'WARN',
    `${state.label} repeated ${state.duplicateCount} times`,
    {
      firstSeen: state.firstSeen,
      lastSeen: state.lastSeen,
      warningKey: key.slice(0, 300)
    }
  );
  state.duplicateCount = 0;
  state.lastSummaryAt = Date.now();
}

function flushRepeatedWarningSummaries() {
  for (const [key, state] of repeatedWarnings) {
    writeRepeatedWarningSummary(key, state);
  }
}

function writeWarningWithSuppression(args) {
  const key = getWarningKey(args);
  const now = Date.now();
  const existing = repeatedWarnings.get(key);

  if (!existing) {
    repeatedWarnings.set(key, {
      duplicateCount: 0,
      firstSeen: new Date(now).toISOString(),
      lastSeen: new Date(now).toISOString(),
      lastSummaryAt: now,
      label: String(args[0] || 'Warning').slice(0, 160)
    });
    writeLog('WARN', ...args);
    return;
  }

  existing.duplicateCount += 1;
  existing.lastSeen = new Date(now).toISOString();

  if (
    existing.duplicateCount >= WARNING_SUMMARY_COUNT ||
    now - existing.lastSummaryAt >= WARNING_SUMMARY_INTERVAL_MS
  ) {
    writeRepeatedWarningSummary(key, existing);
  }
}

try {
  if (!fs.existsSync(app.getPath('userData'))) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
  }
  ensureDailyLog();
  const sessionHeader =
    `\n=== Application session started at ${new Date().toISOString()} | version=${app.getVersion()} | packaged=${app.isPackaged} | pid=${process.pid} | logLevel=${ACTIVE_LOG_LEVEL} ===\n`;
  rotateLogIfNeeded(Buffer.byteLength(sessionHeader, 'utf8'));
  fs.appendFileSync(LOG_FILE, sessionHeader);
} catch (e) {
  // Ignore
}

function writeLog(level, ...args) {
  try {
    if (!shouldWriteLog(level)) return;
    ensureDailyLog();
    const msg = args.map(arg => formatLogValue(arg)).join(' ');
    const entry = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    rotateLogIfNeeded(Buffer.byteLength(entry, 'utf8'));
    fs.appendFileSync(LOG_FILE, entry);
  } catch (e) {
    // Ignore
  }
}

function updateHealthStatus(patch) {
  try {
    let current = {};
    if (fs.existsSync(HEALTH_FILE)) {
      try {
        current = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
      } catch (_) { }
    }

    const next = {
      ...current,
      version: app.getVersion(),
      packaged: app.isPackaged,
      pid: process.pid,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    const tempFile = `${HEALTH_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(next, null, 2), 'utf8');
    if (fs.existsSync(HEALTH_FILE)) {
      fs.unlinkSync(HEALTH_FILE);
    }
    fs.renameSync(tempFile, HEALTH_FILE);
  } catch (error) {
    console.warn('[Health] Could not update health status file:', error.message);
  }
}

// Override console methods to also write to log file
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const origDebug = console.debug;
console.log = (...args) => {
  origLog(...args);
  writeLog(inferInfoLevel(args), ...args);
};
console.info = (...args) => {
  origLog(...args);
  writeLog('INFO', ...args);
};
console.debug = (...args) => {
  origDebug(...args);
  writeLog('DEBUG', ...args);
};
console.error = (...args) => { origError(...args); writeLog('ERROR', ...args); };
console.warn = (...args) => {
  origWarn(...args);
  writeWarningWithSuppression(args);
};

/*
 * The durable trace of a crash.
 *
 * app.log is rotated by date and written from the same process that is
 * failing, so a crash at 23:56 leaves nothing once the till is opened again
 * after midnight. This file is appended to first, before any handler can
 * throw, and keeps the full stack and the end of app.log so the next report
 * starts with the real error instead of its last two frames.
 */
function readLogTail(maxBytes = 4000) {
  try {
    const size = fs.statSync(LOG_FILE).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  }
}

const crashLog = createCrashLog({ file: path.join(app.getPath('userData'), 'crash.log') });
process.env.POSNIC_CRASH_LOG = crashLog.file;
/* The API server runs inside this process. It used to install a second
   uncaught-exception listener that exits in production; this process already
   owns that decision, so tell the server not to install one of its own. */
process.env.POSNIC_MAIN_PROCESS = '1';

installCrashGuards({
  crashLog,
  context: () => ({
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    lastBytecode: bytecodeRuntime.lastBytecodeLoad(),
    recentLog: readLogTail(),
  }),
  onError: (kind, err) => {
    try {
      diagnosticSession.record('renderer', {
        stage: kind === 'unhandledRejection' ? 'main-unhandled-rejection' : 'main-uncaught-exception',
        success: false,
        code: err?.code,
        message: err?.message || String(err),
      });
    } catch (_) { /* recording a diagnosis must not become the failure */ }
    try {
      writeLog('FATAL', kind === 'unhandledRejection' ? 'Unhandled Rejection:' : 'Uncaught Exception:', err);
    } catch (_) { /* already guarded inside writeLog */ }
    try {
      console.error('FATAL', kind === 'unhandledRejection' ? 'Unhandled Rejection:' : 'Uncaught Exception:', err);
    } catch (_) { /* stderr can be gone during a session restart */ }
  },
});
process.on('warning', warning => {
  console.warn('PROCESS WARNING:', warning);
});

console.log(`📝 Log file: ${LOG_FILE}`);

console.log(`[Health] Status file: ${HEALTH_FILE}`);

updateHealthStatus({
  lastStartup: new Date().toISOString(),
  status: 'starting',
  mongodb: 'starting',
  api: 'pending',
  interface: 'pending',
  dashboard: 'pending',
  login: 'pending',
  lastError: null
});

// === SINGLE PORT CONFIGURATION ===
/*
 * Read the port when it is asked for, never at module load.
 *
 * This was `const API_PORT = process.env.PORT || 5555`. That line runs when
 * main.js is first required, which is long before app.whenReady calls
 * resolveLocalPorts - so PORT was unset and API_PORT froze at 5555 for the
 * life of the process. resolveLocalPorts then derived the real port from the
 * app name, wrote it to .ports.json, printed it at startup... and startServer()
 * set process.env.PORT back to the captured 5555 before handing over to
 * server.js. Stock Posnic advertised 42590 and served 5555.
 *
 * Two things fell out of that. Derived ports exist so two brands can be
 * installed side by side without colliding, and both would have collided on
 * 5555. And 5555 is a common development port, so anything else already using
 * it took the app down on a machine that had done nothing wrong.
 *
 * docs/DEVELOPMENT.md has warned about exactly this shape since three earlier
 * production failures: read process.env inside a function, because a module
 * scope const captures the fallback. This was the fourth.
 */
function apiPort() {
  return Number(process.env.PORT) || 5555;
}

let mainWindow;
let apiServer;
let hardwareManager;
let hardwareWindow;
let backupWindow;
let mongoDBManager;
const supportDiagnostics = require('./diagnostics').setup({ ipcMain,
  hardware: () => hardwareManager });
let connectorSupervisor = null;
let pendingSecondInstanceFocus = false;
let shutdownInProgress = false;
/*
 * Set when the shop asked to restart rather than to quit.
 *
 * app.relaunch() only spawns the replacement on Electron's normal quit
 * sequence, and this application's shutdown ends with app.exit(0), which
 * bypasses it - so Restart App closed the till and started nothing. That is a
 * worse outcome than the button not existing. See the before-quit handler.
 */
let relaunchAfterQuit = false;
/* Set once the update IPC is wired. The quit handler needs it to ask whether a
   downloaded update should be applied as this process exits. */
let updateService = null;
const SHUTDOWN_TIMEOUTS = Object.freeze({
  backupScheduler: 1000,
  apiServer: 4000,
  mongoose: 4000,
  bundledMongoDB: 14000, // clean shutdown: admin command + wait for real exit
  total: 25000
});
const startupPerformance = {
  startedAt: Date.now(),
  mongoStartedAt: null,
  mongoReadyMs: null,
  apiModulesMs: null,
  databaseConnectMs: null,
  interfaceVisibleMs: null,
  summaryWritten: false
};
/*
 * Warm-boot marker. Deliberately NOT keyed on the app version any more: it
 * used to be `.startup-ready-<version>`, which forced the cold-boot experience
 * (visible loading window, slowest path) on the first launch after EVERY
 * update - the opposite of a seamless update. What actually makes a post-
 * update boot slow is the api-runtime re-extraction, and that is now keyed on
 * its own shipped fingerprint (api-runtime.js), so an update that does not
 * change the runtime boots warm. If extraction is needed after all, the
 * loading screen still appears via the reveal fallback with honest progress.
 */
const STARTUP_READY_FILE = path.join(app.getPath('userData'), '.startup-ready');

function focusPrimaryWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingSecondInstanceFocus = true;
    return;
  }

  // During warm startup the window intentionally stays hidden until the
  // dashboard/login DOM is ready. Do not reveal an empty window.
  if (!mainWindow.webContents.getURL()) {
    pendingSecondInstanceFocus = true;
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  pendingSecondInstanceFocus = false;
  console.info('[Main] Existing Posnic window focused');
}

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    /*
     * Not while closing. The other process is not a duplicate launch to be
     * turned away - it is somebody reopening the till, and it is already
     * waiting for this one to finish and let go. Focusing windows that are
     * hidden or half torn down would fight that, and could bring a dead window
     * back to the screen on the way out.
     */
    if (shutdownInProgress) {
      console.info('[Main] A launch arrived while closing; it will start once this one exits');
      return;
    }

    console.info('[Main] Duplicate launch prevented', {
      workingDirectory,
      requestedPid: additionalData?.pid,
      argumentsCount: Array.isArray(argv) ? argv.length : 0
    });
    global.__posnicStartHidden = false;
    focusPrimaryWindow();
    // Windows Jump List tasks arrive as args on the second instance
    const openArg = (argv || []).find((a) => a.startsWith('--open='));
    if (openArg) {
      const target = openArg.split('=')[1];
      if (target === 'hardware') openHardwareManager();
      else if (target === 'backup') openBackupManager();
      else if (target === 'update') openUpdateManager();
    }
  });
}

// Native right-click menus (cut/copy/paste) in every window - Electron
// ships without them, and their absence is the #1 "not a real app" tell.
app.on('web-contents-created', (_event, contents) => {
  contents.on('context-menu', (_e, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: 'copy' });
    }
    if (template.length) {
      Menu.buildFromTemplate(template).popup();
    }
  });
});

function isWarmStartup() {
  return fs.existsSync(STARTUP_READY_FILE);
}

function rememberSuccessfulStartup() {
  try {
    fs.writeFileSync(STARTUP_READY_FILE, `${app.getVersion()} ${new Date().toISOString()}`);
    // Sweep the old per-version markers this file replaces, so userData does
    // not accumulate one stale .startup-ready-1.2.3 per release forever.
    for (const name of fs.readdirSync(app.getPath('userData'))) {
      if (name.startsWith('.startup-ready-')) {
        try { fs.unlinkSync(path.join(app.getPath('userData'), name)); } catch (e) { /* best effort */ }
      }
    }
  } catch (error) {
    console.warn('[Main] Could not save startup state:', error.message);
  }
}

function formatStartupDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return 'not measured';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function writeStartupPerformanceSummary(interfaceName) {
  if (startupPerformance.summaryWritten) return;

  startupPerformance.interfaceVisibleMs =
    Date.now() - startupPerformance.startedAt;
  startupPerformance.summaryWritten = true;

  console.info('[Startup Performance Summary]');
  console.info(
    `  MongoDB ready: ${formatStartupDuration(startupPerformance.mongoReadyMs)}`
  );
  console.info(
    `  API modules loaded: ${formatStartupDuration(startupPerformance.apiModulesMs)}`
  );
  console.info(
    `  Database connected: ${formatStartupDuration(startupPerformance.databaseConnectMs)}`
  );
  console.info(
    `  ${interfaceName} visible: ${formatStartupDuration(startupPerformance.interfaceVisibleMs)}`
  );
  console.info(
    `  Total startup: ${formatStartupDuration(startupPerformance.interfaceVisibleMs)}`
  );
}

function markInterfaceReady(interfaceName) {
  const normalized = String(interfaceName).toLowerCase();
  updateHealthStatus({
    status: 'ready',
    interface: 'ready',
    dashboard: normalized.includes('dashboard') ? 'ready' : 'not-active',
    login: normalized.includes('login') ? 'ready' : 'not-active',
    installationWizard: normalized.includes('installation wizard')
      ? 'ready'
      : 'not-active',
    lastReadyAt: new Date().toISOString(),
    startupPerformance: {
      mongodbMs: startupPerformance.mongoReadyMs,
      apiModulesMs: startupPerformance.apiModulesMs,
      databaseConnectMs: startupPerformance.databaseConnectMs,
      totalMs: startupPerformance.interfaceVisibleMs
    }
  });
}

function withTimeout(label, operation, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const startedAt = Date.now();
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (status === 'timeout') {
        console.warn(`[Shutdown] ${label} timed out`, { timeoutMs, durationMs });
      } else if (status === 'error') {
        console.error(`[Shutdown] ${label} failed`, error);
      } else {
        console.info(`[Shutdown] ${label} completed`, { durationMs });
      }
      resolve({ label, status, durationMs });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    Promise.resolve()
      .then(operation)
      .then(() => finish('completed'))
      .catch(error => finish('error', error));
  });
}

function closeApiServer() {
  process.emit('posnic:api-shutdown');
  const server = global.apiServer || apiServer;
  if (!server || typeof server.close !== 'function') return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });

    // Stop waiting for persistent keep-alive connections where supported.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });
}

/*
 * The shutdown, as a list, so it can be walked and counted.
 *
 * It was five `await withTimeout(...)` calls in a row, which is the same work
 * but cannot be reported on: nothing could say which step was running or how
 * many were left. Written this way, the progress on screen is generated from
 * the same list that does the work, so the two cannot disagree about what
 * Posnic is doing - a screen that says "closing the database" while something
 * else is happening would be worse than no screen.
 *
 * The labels are what a shopkeeper would call these things. "Bundled MongoDB
 * process" is what the log says, and the log is for us.
 */
function shutdownSteps() {
  return [
    {
      label: 'Backup scheduler',
      says:  'Stopping scheduled backups...',
      ms:    SHUTDOWN_TIMEOUTS.backupScheduler,
      run:   () => { if (backupManager) backupManager.stopScheduler(); },
    },
    {
      label: 'Connectors',
      says:  'Stopping connectors...',
      ms:    SHUTDOWN_TIMEOUTS.backupScheduler,
      run:   () => connectorSupervisor?.stopAll(),
    },
    {
      label: 'API server',
      says:  'Finishing anything still in progress...',
      ms:    SHUTDOWN_TIMEOUTS.apiServer,
      run:   closeApiServer,
    },
    {
      label: 'MongoDB connection',
      says:  'Disconnecting from the database...',
      ms:    SHUTDOWN_TIMEOUTS.mongoose,
      run:   async () => {
        if (global.mongooseConnection) await global.mongooseConnection.close(false);
      },
    },
    {
      /* The long one, and the one that must not be interrupted: mongod is
         flushing its journal and checkpointing. Everything above it is
         milliseconds. */
      label: 'Bundled MongoDB process',
      says:  'Saving your data and closing the database safely...',
      ms:    SHUTDOWN_TIMEOUTS.bundledMongoDB,
      run:   async () => { if (mongoDBManager) await mongoDBManager.stop(); },
    },
  ];
}

/*
 * Make the application disappear, without ending it.
 *
 * hide() rather than destroy(): a destroyed window fires 'closed' handlers and
 * can re-enter the quit path, and there is nothing to gain from tearing down
 * renderers we are about to exit anyway. Hiding takes them off the screen and
 * out of the taskbar immediately, which is the whole point - the shop should
 * see the till close when they close it, not watch a frozen window for the ten
 * seconds mongod needs.
 */
function hideAllWindowsForQuit() {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      win.setSkipTaskbar(true);
      win.hide();
    } catch (e) { /* one window failing must not stop the others */ }
  }
  try {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  } catch (e) { /* not fatal */ }
}

async function performGracefulShutdown(onProgress) {
  const shutdownStartedAt = Date.now();
  console.info('[Shutdown] Graceful shutdown started');
  flushRepeatedWarningSummaries();

  const steps = shutdownSteps();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    /* Announced before it runs, not after: the step that takes ten seconds
       should be named while it is taking them. */
    if (onProgress) {
      try { onProgress(i, steps.length, step.says); } catch (e) { /* never stop a shutdown to draw */ }
    }
    const result = await withTimeout(step.label, step.run, step.ms);
    if (nextProfile && result.status !== 'completed') {
      nextProfile = null;
      relaunchAfterQuit = false;
    }
  }
  if (onProgress) {
    try { onProgress(steps.length, steps.length, 'Closed safely.'); } catch (e) { /* as above */ }
  }

  console.info('[Shutdown] Graceful shutdown finished', {
    totalDurationMs: Date.now() - shutdownStartedAt
  });
  updateHealthStatus({
    status: 'stopped',
    api: 'stopped',
    mongodb: 'stopped',
    interface: 'closed',
    lastShutdown: new Date().toISOString()
  });
  flushRepeatedWarningSummaries();
}

function isExpectedNavigationAbort(error) {
  return error &&
    (error.code === 'ERR_ABORTED' || error.errno === -3);
}

/**
 * Run one scheduled job with no window, then quit.
 *
 * Deliberately does not reuse the normal startup path. That path builds
 * windows, a tray, a menu, hardware IPC and the API server, and a backup needs
 * none of them - it needs MongoDB running and the credentials to reach it.
 * Threading a headless flag through all of that would put a second set of
 * conditions into the code that starts a shop's till every morning, which is
 * the last place to add branches.
 *
 * Exit codes matter here: Task Scheduler records them, and a scheduler that
 * reports success for a backup that did not happen is worse than no scheduler.
 */
async function runScheduledTaskAndExit(taskName) {
  const started = Date.now();
  console.log(`[scheduled] ${taskName} starting`);

  let mongo = null;
  let code = 0;

  try {
    if (taskName !== 'backup') {
      throw new Error(`unknown scheduled task "${taskName}"`);
    }

    mongo = new MongoDBManager();
    if (mongo.checkBundledMongoExists()) {
      await mongo.start();
      console.log('[scheduled] database started');
    } else {
      console.log('[scheduled] no bundled database; using whatever is already running');
      mongo = null;
    }

    /*
     * The credentials, read the way the application reads them.
     *
     * Not via setup-mongodb.js: that runs from resources/, outside the asar,
     * and main.js cannot require it by a relative path. credentials-store is
     * the thing that actually knows how to decrypt the password - which works
     * here precisely because this is a real Electron process with safeStorage,
     * and would not from a plain script.
     *
     * It lives in resources/ rather than the asar, and is reached by an
     * absolute path, because setup-mongodb.js and the API also require it and
     * electron-builder will not put one file on both sides of the asar
     * boundary: listing it in extraResources removes it from the archive.
     */
    const store = require(
      app.isPackaged
        ? path.join(process.resourcesPath, 'credentials-store')
        : path.join(__dirname, 'credentials-store')
    );
    const userData = app.getPath('userData');
    const creds = store.read(
      [
        path.join(userData, '.mongodb-credentials.json'),
        path.join(__dirname, '.mongodb-credentials.json'),
      ],
      userData,
      safeStorage
    );

    if (creds && creds.uri) {
      process.env.MONGODB_URI = creds.uri;
    } else if (!process.env.MONGODB_URI) {
      /* No stored credentials: an install where MongoDB runs without
         authentication. The derived port still has to be right. */
      process.env.MONGODB_URI = `mongodb://127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}/PosnicPro`;
    }

    const result = await getBackupManager().runBackup({
      force: true,
      _manual: true,
      reason: 'scheduled-task',
    });

    if (!result || result.success === false) {
      throw new Error(result && result.message ? result.message : 'backup reported failure');
    }
    console.log(`[scheduled] backup finished in ${Date.now() - started}ms`);
  } catch (error) {
    console.error(`[scheduled] ${taskName} failed: ${error.message}`);
    code = 1;
  } finally {
    if (mongo) {
      try {
        await mongo.stop();
        console.log('[scheduled] database stopped');
      } catch (stopError) {
        console.warn(`[scheduled] could not stop the database: ${stopError.message}`);
      }
    }
  }

  /* exit rather than quit: nothing is open to close, and quit would wait for
     window lifecycle events that will never arrive. */
  app.exit(code);
}

function loadPageAndReveal(url) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error('Main window is not available'));
      return;
    }

    /* Tell the loading-screen timer to stand down: the real interface is on its
       way, and a loading screen shown now would abort this navigation. */
    global.__posnicInterfaceLoading = true;

    let settled = false;
    const reveal = () => {
      if (settled || !mainWindow || mainWindow.isDestroyed()) return;
      settled = true;
      cleanup();
      rememberSuccessfulStartup();
      if (!global.__posnicStartHidden && !mainWindow.isVisible()) mainWindow.show();
      if (!global.__posnicStartHidden) mainWindow.focus();
      if (pendingSecondInstanceFocus) focusPrimaryWindow();
      resolve();
    };
    const fail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || settled || errorCode === -3) return;
      settled = true;
      cleanup();
      const error = new Error(`${errorDescription} (${errorCode}) loading '${validatedURL}'`);
      error.errno = errorCode;
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(fallback);
      /* Cleared here rather than in reveal(), because every way out of this
         promise - revealed, failed, rejected - passes through cleanup, and a
         flag left set would suppress the loading screen for the rest of the
         session. */
      global.__posnicInterfaceLoading = false;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.removeListener('dom-ready', revealIfCorrectPage);
      mainWindow.webContents.removeListener('did-fail-load', fail);
    };

    /*
     * dom-ready is enough to paint the application shell. Large dashboard
     * assets and data requests can continue after the user sees the window.
     *
     * But it has to be dom-ready for the page that was asked for. This listened
     * for any dom-ready at all, and the loading screen produces one: a timer
     * further down shows loading.html once startup passes 2.5 seconds, and that
     * aborts whatever navigation is in flight. When startup landed just the
     * wrong side of that line - 2.75s on the run that exposed it - the sequence
     * was:
     *
     *   loading.html replaces the dashboard navigation
     *   loading.html reaches dom-ready
     *   reveal fires and the promise resolves
     *   the log says "Dashboard visible" and "Saved login found"
     *   the till shows a spinner for ever
     *
     * The abort was invisible because did-fail-load ignores error -3, which is
     * exactly what an aborted navigation reports. So every signal said the
     * interface was ready while the user watched a progress ring.
     */
    const wantedPage = (() => {
      try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
      } catch {
        return url;
      }
    })();

    const isTheRequestedPage = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      try {
        const current = new URL(mainWindow.webContents.getURL());
        return `${current.origin}${current.pathname}` === wantedPage;
      } catch {
        return false;
      }
    };

    const revealIfCorrectPage = () => {
      if (settled) return;
      /* Something else got here first - almost always the loading screen. Keep
         waiting: either the requested page arrives, or the fallback below shows
         whatever is on screen, so the user is never left with nothing. */
      if (!isTheRequestedPage()) return;
      reveal();
    };

    mainWindow.webContents.on('dom-ready', revealIfCorrectPage);
    mainWindow.webContents.on('did-fail-load', fail);

    /* The safety net. If the requested page never arrives, show what there is
       rather than hanging - and say so, because it means this race, or
       something like it, happened again. */
    const fallback = setTimeout(() => {
      if (settled) return;
      if (!isTheRequestedPage()) {
        const showing = mainWindow && !mainWindow.isDestroyed()
          ? mainWindow.webContents.getURL()
          : 'none';
        console.warn(`[Startup] ${url} did not load within 3s; showing ${showing} instead`);
      }
      reveal();
    }, 3000);

    mainWindow.loadURL(url).catch(error => {
      if (!isExpectedNavigationAbort(error) && !settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
  });
}

const sendStartupProgress = require('./startup-progress').createStartupProgress();
function updateStartupStatus(stage, text, details, progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendStartupProgress(mainWindow.webContents, [stage, text, details, progress]);
}

// Startup-failure actions used by the loading screen's error state
ipcMain.handle('startup:retry', () => {
  app.relaunch();
  app.exit(0);
});
ipcMain.handle('startup:open-log', () => shell.openPath(LOG_FILE));

/*
 * White label. The shop's logo and name come from the cloud and are cached
 * here, so changing a logo costs a relaunch rather than a reinstall. The API
 * reads this folder and serves the images on the stock logo paths.
 *
 * Never allowed to break startup: a shop with no branding, or no internet, or
 * a cloud that is down, simply keeps whatever it already had.
 */
const BRAND_DIR = path.join(app.getPath('userData'), 'brand');

/*
 * Frontend files applied after install, and the machinery to undo them.
 *
 * The public key is the whole security model: without it this refuses every
 * update rather than trusting them, so a build that ships without one is inert
 * rather than dangerous. Signing keys are generated per product and only the
 * public half is ever in the repository.
 */
const ASSET_PUBLIC_KEY_FILE = path.join(process.resourcesPath || __dirname, 'asset-signing-key.pub');
const assetUpdater = new AssetUpdater({
  updateGuard: () => require('./extension-update-policy').getExtensionUpdateHold(
    process.env.POSNIC_EXTENSIONS_ROOT || path.join(app.getPath('userData'), 'extensions')),
  root: path.join(app.getPath('userData'), 'assets'),
  baseline: path.join(process.resourcesPath || path.join(__dirname, '..'), 'frontend', 'public'),
  publicKey: (() => {
    try {
      return fs.existsSync(ASSET_PUBLIC_KEY_FILE)
        ? fs.readFileSync(ASSET_PUBLIC_KEY_FILE, 'utf8') : null;
    } catch (e) { return null; }
  })(),
  log: (m) => console.log(m),
});
const BRAND_FILE = path.join(BRAND_DIR, 'brand.json');


/*
 * The page telling the window what colour it just became.
 *
 * Called on every theme change and once on load, so the bar follows a theme
 * switched in Config without a restart.
 */
ipcMain.handle('theme:chrome', async (_event, theme) => applyWindowChrome(theme));

/*
 * What the settings windows ask for.
 *
 * Hardware Manager and friends are separate windows with their own stylesheets
 * and no sight of the app's, which is why they were fixed blue while the till
 * was dark. They read the palette the app last applied and dress themselves.
 */
/*
 * The title bar's buttons, now that the page draws them.
 *
 * close() honours the existing close handler, so it still hides to the tray and
 * still locks on the way out rather than quitting behind the shop's back.
 */
ipcMain.handle('window:minimize', async () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', async () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

/*
 * Whether the window is maximised, so the page can draw the right button.
 *
 * The title bar is drawn by the page, and its middle button was a fixed square
 * whatever the window was doing. Every other application on the machine shows
 * two overlapping squares once maximised, because that button then means
 * "restore", not "maximise" - so ours was telling the shop the wrong thing
 * about what the click would do.
 *
 * Asked for on load, and pushed on change, because a window can be maximised by
 * double-clicking the bar or by Windows snapping it - not only by this button.
 */
ipcMain.handle('window:is-maximized', async () => Boolean(mainWindow && mainWindow.isMaximized()));
ipcMain.handle('window:close', async () => { if (mainWindow) mainWindow.close(); });

ipcMain.handle('theme:palette', async () => {
  try {
    if (fs.existsSync(CHROME_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CHROME_FILE, 'utf8'));
      if (saved && saved.palette) return saved.palette;
    }
  } catch (err) { /* the window falls back to its own colours */ }
  return null;
});

/*
 * Connector runtime surface (I6 enable flow). The frontend's Integrations
 * screen mints the scoped token (it owns that flow already); THIS side only
 * stores the enable decision and supervises. The token is written to the
 * connector's config file, which is exactly as private as the rest of
 * userData - same trust level as the cloud device token beside it.
 */
const CONNECTOR_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

ipcMain.handle('connectors:status', async () => {
  try {
    return { ok: true, connectors: connectorSupervisor ? connectorSupervisor.status() : [] };
  } catch (error) {
    return { ok: false, error: error.message, connectors: [] };
  }
});

ipcMain.handle('connectors:enable', async (event, payload) => {
  try {
    const { name, token, settings } = payload || {};
    if (!CONNECTOR_NAME_RE.test(String(name || ''))) {
      return { ok: false, error: 'Not a valid connector name' };
    }
    if (typeof token !== 'string' || !token.startsWith('posnic_')) {
      return { ok: false, error: 'That does not look like a Posnic API token' };
    }
    if (!connectorSupervisor) return { ok: false, error: 'Connector runtime unavailable' };
    const file = path.join(app.getPath('userData'), 'connector-runtime', name + '.config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      enabled: true,
      token,
      settings: settings && typeof settings === 'object' ? settings : {},
      enabledAt: new Date().toISOString(),
    }, null, 2));
    connectorSupervisor.restart(name);
    return { ok: true, connectors: connectorSupervisor.status() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('connectors:disable', async (event, payload) => {
  try {
    const { name } = payload || {};
    if (!CONNECTOR_NAME_RE.test(String(name || ''))) {
      return { ok: false, error: 'Not a valid connector name' };
    }
    if (!connectorSupervisor) return { ok: false, error: 'Connector runtime unavailable' };
    const file = path.join(app.getPath('userData'), 'connector-runtime', name + '.config.json');
    /* Keep the token so re-enabling does not force a fresh mint; enabled:false
       is the whole decision - no config match, no start. */
    let fd;
    try {
      fd = fs.openSync(file, 'r+');
      const cfg = JSON.parse(fs.readFileSync(fd, 'utf8'));
      const disabled = JSON.stringify({ ...cfg, enabled: false }, null, 2);
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, disabled, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') fs.rmSync(file, { force: true });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    connectorSupervisor.stop(name);
    return { ok: true, connectors: connectorSupervisor.status() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Desktop tools — lets the web UI open the same managers the File menu and
// tray expose (discoverability; menu/tray remain the crash-safe fallback).
ipcMain.handle('desktop:open', (_event, target) => {
  if (typeof target === 'string' && /^hardware:(receipt|cash|weight|scanner)$/.test(target)) {
    openHardwareManager(target.split(':')[1]);
    return true;
  }
  if (['shop:print', 'shop:devices'].includes(target)) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    openAppSettings(target);
    return true;
  }
  switch (target) {
    case 'hardware': openHardwareManager(); break;
    case 'backup': openBackupManager(); break;
    case 'update': openUpdateManager(); break;
    /* The viewer rather than the file. shell.openPath handed a 40,000 line
       log to whatever the machine associates with .log - Notepad on Windows,
       often nothing at all on Linux - which is not a thing a shopkeeper can
       use. openLogViewer keeps a way out to the folder. */
    case 'log': openLogViewer(); break;
    /*
     * ABOUT, REACHABLE WITHOUT KNOWING ABOUT THE ALT KEY.
     *
     * This window has held the version, the platform and the cloud it
     * syncs with for as long as it has existed, and it sat behind a menu
     * bar that is hidden by default. Owner: "i asked which version using.
     * now way to tell." The window was never the problem; the only route
     * to it was.
     */
    case 'about': openAboutWindow(); break;
    /* The renderer names an intent and this decides the address. Letting a page
       pass its own URL here would turn an allowlist into an open redirect for
       anything that can reach this channel. */
    default: return false;
  }
  return true;
});
ipcMain.handle('desktop:capabilities', () => ({
  desktop: true,
  /*
   * THE NUMBER A SHOP IS ASKED FOR ON THE TELEPHONE.
   *
   * Owner, after a customer reported a printing fault: "i asked which
   * version using. now way to tell."
   *
   * It was here all along and nowhere a shopkeeper could see it: Help >
   * About holds it, and that menu bar is hidden until somebody presses
   * Alt. This bridge is already called on every desktop start, so the
   * page can put the number on screen without a new round trip.
   */
  version: app.getVersion(),
  backup: true
}));

// Startup is an operating-system preference, shared by Settings and the shell.
ipcMain.handle('desktop:behaviour-get', () => ({
  supported: process.platform === 'win32' || process.platform === 'darwin',
  openAtLogin: (process.platform === 'win32' || process.platform === 'darwin')
    ? app.getLoginItemSettings().openAtLogin : false,
}));
ipcMain.handle('desktop:behaviour-save', (_event, patch) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { success: false, error: 'Manage startup applications in your operating system settings.' };
  }
  if (!patch || typeof patch.openAtLogin !== 'boolean') {
    return { success: false, error: 'Choose whether to start Posnic at login.' };
  }
  app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, args: ['--hidden'] });
  return { success: true };
});

function openAppSettings(section = 'app') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('desktop:navigate', section);
}

async function clearStartupBrowserCache() {
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ['cachestorage']
    });
    console.log('[Main] Browser cache cleaned before startup');
  } catch (error) {
    console.warn('[Main] Browser cache cleanup skipped:', error.message);
  }
}

// Check if API server is ready
function waitForApiServer(callback, attempts = 0) {
  if (attempts === 0) {
    console.log('Waiting for API server to start...\n');
  }

  if (attempts >= 60) {
    console.error('\nERROR: API server failed to start after 60 attempts');
    console.error('Please check if MongoDB is running and accessible\n');
    return;
  }

  http.get(`http://localhost:${apiPort()}/api`, (res) => {
    if (res.statusCode === 200 || res.statusCode === 404) {
      console.log('\nAPI server is ready!');
      console.log(`API Endpoint: http://localhost:${apiPort()}/api\n`);
      callback();
    } else {
      setTimeout(() => waitForApiServer(callback, attempts + 1), 500);
    }
  }).on('error', () => {
    if (attempts === 0 || attempts % 10 === 0) {
      console.log(`Waiting for API server... (${attempts + 1}/60)`);
    }
    setTimeout(() => waitForApiServer(callback, attempts + 1), 500);
  });
}

// First successful launch shows progress. Later launches initialize in the
// background and reveal the window only when login/dashboard is ready.
function createWindow(showStartupLoader = !isWarmStartup()) {
  console.log('Creating Electron window...');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    /*
     * Opened in the colours this shop chose, not in white.
     *
     * The window is painted by Windows before a single line of the app runs,
     * so a default here is a white flash on every launch of a dark till - and
     * the window controls stayed white permanently, which read as a light
     * application wearing a dark skin. Remembered from the last run, because
     * the renderer that knows the theme has not started yet.
     */
    backgroundColor: rememberedChrome().background,
    autoHideMenuBar: true, // clean chrome; menu on Alt, tools in tray + in-app
    icon: appIconPath(),
    /*
     * Hidden, and with no overlay at all.
     *
     * The OS title bar is whatever height Windows decides and shrinks when
     * maximised, which is why no stylesheet ever changed it. Hiding it and
     * letting Windows overlay only the buttons handed the height back - but
     * that overlay is a surface Windows paints its own way, so the strip showed
     * two shades however carefully it was handed one colour, and a shop
     * reported it three times.
     *
     * The page draws the buttons instead, in PosnicPro.js, so the strip is one
     * element with one background and there is nothing left to disagree.
     */
    /*
     * On macOS this leaves the traffic lights in place and removes only the
     * title strip - which is why the window had two sets of controls: Apple's
     * three circles top-left, and ours top-right, drawn by the page because
     * Windows needed them.
     *
     * hiddenInset keeps the single-colour strip the comment above is about and
     * insets the native buttons so they sit level with the bar rather than
     * crowding its edge. The page hides its own set - see the
     * window:native-controls flag below - so there is one way to close the
     * window, in the place a Mac user already looks for it.
     */
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    /* Room for the traffic lights, so the page's own toolbar does not start
       underneath them. */
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: (TITLEBAR_HEIGHT - 16) / 2 } }
      : {}),
    show: showStartupLoader && !global.__posnicStartHidden,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      /* sandbox and webSecurity match the main window. They were absent here,
         which made these the weakest renderers in the application. */
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  /*
   * The splash goes as soon as there is a real window to look at.
   *
   * On 'show' rather than 'ready-to-show': a warm start creates the window
   * hidden and reveals it later, and taking the splash down at creation would
   * leave the screen empty again for the gap in between.
   *
   * The timeout is the backstop. If startup fails in a way that never shows a
   * window, a splash that sits there forever with a moving bar is a worse
   * failure than the one underneath it.
   */
  mainWindow.once('show', closeSplash);
  /* A cold start creates the window with show: true, so that event has
     already fired by the time this listener is attached. */
  if (mainWindow.isVisible()) closeSplash();
  setTimeout(closeSplash, 90 * 1000);

  /*
   * One set of window buttons on macOS, not two.
   *
   * The page draws minimise, maximise and close itself because Windows needed
   * that - see the titleBarStyle comment in createWindow. macOS keeps its own
   * traffic lights whatever the title bar style, so a Mac showed Apple's three
   * circles top-left and ours top-right, and neither looked like a mistake on
   * its own.
   *
   * Injected from here rather than changed in the page: the page is shared
   * with the browser build, where there is no native chrome to defer to and
   * its buttons are the only ones there are. A stylesheet applied only to this
   * window says "this window has native controls" without teaching the page
   * about operating systems.
   */
  if (process.platform === 'darwin') {
    const macChrome = `
      .posnic-window-controls { display: none !important; }
      /* Clear the traffic lights, which sit at the left of the same strip. */
      .posnic-titlebar, .posnic-topbar { padding-left: 78px !important; }
    `;
    const applyMacChrome = () => {
      mainWindow.webContents.insertCSS(macChrome).catch(() => { /* page gone */ });
    };
    /* Every navigation, not just the first: the till moves between pages and a
       stylesheet inserted once does not survive that. */
    mainWindow.webContents.on('dom-ready', applyMacChrome);
  }

  // Prevent "Not Responding" by responding to system events
  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[Renderer] Main window started loading:', mainWindow.webContents.getURL());
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) {
        console.log('[Renderer] Navigation replaced/aborted:', validatedURL);
        return;
      }
      console.error('[Renderer] Page load failed:', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      });
      crashLog.append('did-fail-load', null, {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      });
    }
  );

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Renderer] Preload script failed:', { preloadPath }, error);
    crashLog.append('preload-error', error, { preloadPath });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] Render process gone:', details);
    crashLog.append('render-process-gone', null, details);
  });

  mainWindow.webContents.on(
    'console-message',
    (event) => {
      const { level, message, lineNumber: line, sourceId } = event;
      if (level === 'warning' || level === 'error') {
        console.warn('[Renderer console]', { level, message, line, sourceId });
      }
    }
  );

  mainWindow.on('unresponsive', () => {
    console.error('[Renderer] Main window became unresponsive', {
      url: mainWindow?.webContents?.getURL()
    });
  });

  mainWindow.on('responsive', () => {
    console.log('[Renderer] Main window became responsive again');
  });

  // Close-to-tray (Slack behavior): X hides the window, the app and its
  // database keep running. Quit via tray or File menu performs the real
  // graceful shutdown.
  mainWindow.on('close', (event) => {
    if (shutdownInProgress) return; // real quit in progress - allow close
    event.preventDefault();

    /*
     * Lock on the way to the tray.
     *
     * Pressing X hides the window rather than quitting, so the page is never
     * reloaded and the lock that runs on load never gets a chance to. Somebody
     * stepping away and closing the till reasonably believes they have put it
     * away; without this anyone could restore it from the tray and carry on in
     * their session. The page ignores this when the shop has the lock off.
     */
    try { mainWindow.webContents.send('lock:now'); } catch (e) { /* window gone */ }

    mainWindow.hide();
    if (tray && !closeToTrayHintShown) {
      closeToTrayHintShown = true;
      try {
        tray.displayBalloon({
          title: 'Posnic is still running',
          content: 'Billing and sync continue in the background. Right-click this icon to open or quit.'
        });
      } catch (e) { /* balloon unsupported - fine */ }
    }
  });

  if (showStartupLoader) {
    mainWindow.loadFile('src/loading.html');
    console.log('Electron window created with loading screen\n');
  } else {
    console.log('Warm startup - checks running in background\n');

    /*
     * Do not stay invisible for a whole minute.
     *
     * A warm start keeps the window hidden and reveals it once login is
     * ready, which is fine when that takes a second. It does not: measured
     * startups here run 27 to 58 seconds, and every new build re-extracts the
     * dependency archive on top of that. All the shop sees in that time is a
     * tray icon, so the app looks like it failed to open - which is exactly
     * what it was reported as.
     *
     * If we are still hidden after a couple of seconds, show the loading
     * screen. Someone waiting on a progress bar is waiting; someone staring at
     * an empty desktop is filing a bug or double-clicking again.
     */
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() || global.__posnicStartHidden) return;

      /*
       * Not if the real interface is already on its way.
       *
       * The only guard here was isVisible(), and a page that is loading is not
       * yet visible - so when startup finished at almost exactly this timeout,
       * loading.html aborted the dashboard navigation, satisfied the dom-ready
       * that loadPageAndReveal was waiting for, and left the till showing a
       * spinner while every log line claimed success.
       *
       * loadPageAndReveal sets this before it navigates. If it is set, the
       * interface is seconds away and the loading screen would only get in
       * front of it.
       */
      if (global.__posnicInterfaceLoading) {
        console.log('Startup is taking a moment, but the interface is already loading');
        return;
      }

      mainWindow.loadFile('src/loading.html').catch(() => {});
      mainWindow.show();
      console.log('Startup is taking a moment; showing the loading screen');
    }, 2500);
  }

  // Initialize update system (production-only, electron-updater based)
  const { setupUpdateIPC } = require('./update-integration');
  /* Kept so the quit handler can ask whether an update is waiting. */
  updateService = setupUpdateIPC({
    beforeInstall: async () => {
      const result = await getBackupManager().runBackup({
        force: true,
        _manual: true,
        reason: 'before-update-install'
      });

      if (!result || !result.success) {
        throw new Error(result?.error || 'Backup failed before update install');
      }

      return result;
    },

    /* So the Updates window can offer "go back" beside the button that applied
       the update, rather than only from a menu a shopkeeper never opens. */
    assetUpdater,
  });

  // Make updateMenuBadge available globally for UpdateService
  global.updateMenuBadge = updateMenuBadge;

  // Handle new window requests - allow downloads but prevent empty windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // For PDF URLs, trigger download and prevent window
    if (url.includes('Pdf') || url.includes('pdf') || url.includes('PDF')) {
      // Download the file using Electron's download manager
      mainWindow.webContents.downloadURL(url);
      return { action: 'deny' };
    }

    let parsed = null;
    try { parsed = new URL(url); } catch (e) { parsed = null; }
    const isLocalApp =
      parsed && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

    // Internal app pages opened with target="_blank" (Customer Display,
    // Catalog Display, etc.) must open as a real second window pointing at
    // the bundled server instead of being blocked.
    if (isLocalApp) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024,
          height: 768,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            preload: path.join(__dirname, 'preload.js')
          }
        }
      };
    }

    // Any genuinely external link opens in the user's default browser.
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      shell.openExternal(url);
    }

    // Deny other popup windows
    return { action: 'deny' };
  });

  /*
   * Deny every permission, and every navigation away from our own pages.
   *
   * Neither of these existed. Electron's default is to hand a permission
   * request straight to Chromium's own logic, which for a desktop application
   * means a page could ask for the camera, the microphone, geolocation,
   * notifications or clipboard-read and get them - and the pages loaded here
   * include a legacy frontend served with 'unsafe-eval' in its CSP.
   *
   * A point of sale needs none of them. Printing goes through IPC to the main
   * process; it is not a browser permission.
   */
  const ALLOWED_PERMISSIONS = new Set([
    /* Fullscreen: the customer display uses it, and it grants no access to
       anything. */
    'fullscreen',
    /* Clipboard and notifications: a copy button or a toast is ordinary POS
       behaviour, and a library may reach for the permissioned API rather than
       document.execCommand. Neither can read anything the page cannot. */
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
    'pointerLock',
  ]);

  /*
   * What is deliberately NOT on that list: camera, microphone, geolocation,
   * display-capture, serial, usb, hid, midi and idle-detection. The scale and
   * printer are driven from the main process through IPC rather than through
   * the Web Serial API - denying 'serial' here does not touch them.
   *
   * Every refusal is logged with its name, so if some page turns out to need
   * one, it says so in app.log rather than failing silently.
   */

  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowed = ALLOWED_PERMISSIONS.has(permission);
      if (!allowed) {
        console.log(`[Security] denied permission request: ${permission}`);
      }
      callback(allowed);
    }
  );

  /* The synchronous sibling. Some permissions are checked rather than
     requested, and a handler that only covers the asynchronous path leaves
     those at Chromium's default. */
  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission) => ALLOWED_PERMISSIONS.has(permission)
  );

  /*
   * Top-level navigation may only go to pages this application serves. Without
   * this, one crafted link - or one injected script in a frontend that allows
   * inline JavaScript - can move the main window to a remote origin while
   * keeping the preload bridge alive.
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let parsed = null;
    try { parsed = new URL(url); } catch { parsed = null; }

    /* Any loopback port, not only the API's. A second local port - a customer
       display, a catalog window - is ordinary, and pinning this to one port
       would break it for no security gain: anything already running on this
       machine's loopback interface can reach the API anyway. */
    const local =
      parsed &&
      ((parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === '[::1]')) ||
        parsed.protocol === 'file:');

    if (!local) {
      console.log(`[Security] blocked navigation to ${url}`);
      event.preventDefault();
      /* Somewhere to go is better than a dead click: send it to the browser,
         which is where an external link belonged in the first place. */
      if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
        shell.openExternal(url).catch(() => {});
      }
    }
  });

  /* Attaching a webview would create a renderer this file never configured. */
  mainWindow.webContents.on('will-attach-webview', (event) => {
    console.log('[Security] blocked a webview attachment');
    event.preventDefault();
  });

  // Handle downloads - show save dialog
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Let Chromium own the asynchronous chooser. A synchronous dialog here
    // blocks the embedded API until somebody closes it.
    const filename = item.getFilename ? item.getFilename() : path.basename(item.getURL());
    const defaultPath = path.join(app.getPath('downloads'), filename || 'download');
    const ext = path.extname(filename || '').replace('.', '');
    const filters = ext
      ? [
          { name: `${ext.toUpperCase()} files`, extensions: [ext] },
          { name: 'All files', extensions: ['*'] }
        ]
      : [{ name: 'All files', extensions: ['*'] }];

    item.setSaveDialogOptions({
      title: 'Save file',
      defaultPath,
      buttonLabel: 'Save',
      filters
    });

    item.on('updated', (evt, state) => {
      if (state === 'interrupted') {
        console.warn('Download interrupted:', filename);
      }
    });

    item.once('done', (evt, state) => {
      if (state === 'completed') {
        console.log('Download completed:', item.getSavePath());
      } else {
        console.error('Download failed:', state);
      }
    });
  });

  // Chromium does not show its normal beforeunload prompt inside Electron.
  // Surface an explicit native warning for protected unsaved forms instead.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Stay', 'Leave'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved Changes',
      message: 'You have unsaved changes.',
      detail: 'Leave this page without saving your changes?',
      noLink: true,
    });
    if (choice === 1) {
      // In Electron, preventDefault here means ignore the renderer's block
      // and allow the requested close/navigation to continue.
      event.preventDefault();
    }
  });

  /*
   * Tell the page whenever the window is maximised or restored.
   *
   * Not only when its own button is pressed: double-clicking the title bar, the
   * Windows snap gesture and Win+Up all do it too, and a button that only knew
   * about its own clicks would go out of step the first time a shop used any of
   * them.
   */
  for (const [event, maximized] of [['maximize', true], ['unmaximize', false]]) {
    mainWindow.on(event, () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('window:maximize-changed', maximized);
        }
      } catch (e) { /* the page will ask again on its next load */ }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Redirect to installation wizard for first time setup
async function redirectToWizard() {
  if (mainWindow) {
    // Use the current display's usable area (already adjusted for Windows DPI
    // scaling and taskbar), rather than leaving setup in the fixed 800px shell.
    if (!mainWindow.isMaximized()) {
      const area = electron.screen.getDisplayMatching(mainWindow.getBounds()).workArea;
      const width = Math.min(1200, area.width - 24);
      const height = Math.min(960, area.height - 24);
      mainWindow.setMinimumSize(Math.min(760, width), Math.min(540, height));
      mainWindow.setBounds({ x: area.x + Math.floor((area.width - width) / 2),
        y: area.y + Math.floor((area.height - height) / 2), width, height });
    }
    await mainWindow.loadFile('src/install-wizard.html');
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    writeStartupPerformanceSummary('Installation wizard');
    markInterfaceReady('Installation wizard');
    console.log('Redirected to installation wizard\n');

    // Print setup message
    console.log('=======================================================');
    console.log('   FIRST TIME SETUP - INSTALLATION WIZARD');
    console.log('=======================================================');
    console.log(`Server:          http://localhost:${apiPort()}`);
    console.log(`  - API Endpoint:  http://localhost:${apiPort()}/api`);
    console.log('Please complete the installation wizard to continue');
    console.log('=======================================================\n');
  }
}

// Redirect to login page when server is ready
async function redirectToLogin() {
  if (mainWindow) {
    const origin = `http://localhost:${apiPort()}`;
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    const hasSavedCookie = hasUnexpiredAuthCookie(cookies);
    const hasSavedLogin = hasSavedCookie
      ? await validateSavedLogin(origin, cookies)
      : false;

    if (hasSavedCookie && hasSavedLogin === false) {
      console.warn('[Auth] Saved login is no longer valid; clearing stale session');
      await clearStaleLogin(session.defaultSession.cookies, origin, console);
    }

    const targetUrl = hasSavedLogin
      ? `${origin}/public/dashboard.html#/dashboard`
      : `${origin}/public/login.html`;

    await loadPageAndReveal(targetUrl);
    if (hasSavedLogin === false) {
      require('./startup-progress').clearLoginRenderer(mainWindow.webContents, targetUrl, console);
    }
    writeStartupPerformanceSummary(hasSavedLogin ? 'Dashboard' : 'Login');
    markInterfaceReady(hasSavedLogin ? 'Dashboard' : 'Login');
    console.log(hasSavedLogin
      ? 'Saved login found - redirected directly to dashboard\n'
      : 'Redirected to login page\n');

    // Start backup scheduler now that everything is ready
    try {
      const mgr = getBackupManager();
      const config = mgr.loadConfig();
      if (config.enabled) {
        mgr.startScheduler();
        console.log('📦 Backup scheduler started');
      } else {
        console.log('📦 Backup scheduler disabled in config');
      }
    } catch (e) {
      console.error('Failed to start backup scheduler:', e.message);
    }

    // Print success message
    console.log('=======================================================');
    console.log('   APPLICATION STARTED SUCCESSFULLY!');
    console.log('=======================================================');
    console.log(`Server:          http://localhost:${apiPort()}`);
    console.log(`  - API Endpoint:  http://localhost:${apiPort()}/api`);
    console.log(`  - web:      http://localhost:${apiPort()}/public/login.html`);
    console.log('Database:        PosnicPro');
    console.log('=======================================================\n');
  }
}

// Stop servers
function stopServers() {
  console.log('\nStopping servers...');
  if (apiServer && apiServer.close) {
    apiServer.close(() => {
      console.log('Server stopped');
    });
  }
}

// Global variable to track update status for menu badge
let _updateMenuStatus = {
  available: false,
  downloaded: false,
  version: null
};

// Create application menu
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Shops on this computer', click: openShopProfiles },
        { label: 'App Settings', click: () => openAppSettings('app') },
        { type: 'separator' },
        {
          label: 'Hardware Manager',
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            openHardwareManager();
          }
        },
        // A connected desktop still holds local data and unsent work. Backups
        // remain available when cloud access expires or the network is down.
        {
          label: 'Backup Manager',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            openBackupManager();
          }
        },
        {
          label: getUpdateMenuLabel(),
          accelerator: 'CmdOrCtrl+U',
          click: () => {
            openUpdateManager();
          }
        },
        // Cache, sign-out, DevTools and the reset now live under Maintenance,
        // together, rather than scattered down File where nobody found them.
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: (item, focusedWindow) => {
            if (focusedWindow) focusedWindow.reload();
          }
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'F5',
          click: (item, focusedWindow) => {
            if (focusedWindow) focusedWindow.reload();
          }
        },
        {
          label: 'Toggle Full Screen',
          accelerator: 'F11',
          click: (item, focusedWindow) => {
            if (focusedWindow) {
              focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
            }
          }
        }
      ]
    },
    {
      /*
       * Maintenance lives in the shell, not in a page.
       *
       * Every item here is for the case where the app itself is misbehaving -
       * a stuck cache, a window dragged off a screen that is no longer
       * attached, a log somebody needs to send. A page inside the app cannot
       * be relied on to open at exactly the moment these are wanted.
       */
      label: 'Maintenance',
      submenu: [
        {
          label: 'Clear Cache',
          click: () => { clearHistoryAndCache(); }
        },
        {
          label: 'Clear Cookies && Sign-in',
          click: () => { clearCookiesAndStorage(); }
        },
        { type: 'separator' },
        {
          label: 'Open Log Folder',
          click: () => { openLogFolder(); }
        },
        {
          label: 'Copy Diagnostics',
          click: () => {
            const { clipboard, dialog } = require('electron');
            clipboard.writeText(JSON.stringify(collectDiagnostics(), null, 2));
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Diagnostics Copied',
              message: 'System information copied to the clipboard.',
              detail: 'Paste it into your support message. It contains the app '
                + 'version, this machine\'s details and its device id - no sales, '
                + 'customer or item data.',
            });
          }
        },
        {
          /*
           * One file to attach to a support message.
           *
           * The alternative is asking a shopkeeper to find %APPDATA%, copy a
           * log, and separately describe their version and platform. This is
           * the offline half of reporting a problem: it works with no cloud
           * account and no network, and the shop can read the file before
           * sending it, which is the honest way to ask for someone's logs.
           */
          label: 'Save Support Bundle...',
          click: async () => {
            const { dialog } = require('electron');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
              title: 'Save Support Bundle',
              defaultPath: path.join(app.getPath('desktop'), `support-${stamp}.txt`),
              filters: [{ name: 'Text', extensions: ['txt'] }],
            });
            if (canceled || !filePath) return;
            try {
              const body = '=== SYSTEM INFORMATION ===\n'
                + JSON.stringify(collectDiagnostics(), null, 2)
                + '\n\n=== APPLICATION LOG (most recent) ===\n'
                + tailLog();
              fs.writeFileSync(filePath, body, 'utf8');
              require('electron').shell.showItemInFolder(filePath);
            } catch (e) {
              dialog.showErrorBox('Could not save', e.message);
            }
          }
        },
        {
          label: 'Toggle DevTools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: (item, focusedWindow) => {
            if (focusedWindow) focusedWindow.webContents.toggleDevTools();
          }
        },
        { type: 'separator' },
        {
          /*
           * Undo the last update, without needing a network.
           *
           * A pointer move and a restart. The machine most likely to need this
           * is the one that cannot reach us, so it must not depend on being
           * able to download anything.
           */
          label: 'Revert Last Update',
          click: async () => {
            const { dialog } = require('electron');
            const status = assetUpdater.status();
            if (!status.active) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Nothing to Revert',
                message: 'This installation is running the version it was installed with.',
              });
              return;
            }
            const target = status.previous || 'the installed version';
            const answer = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Revert & Restart', 'Cancel'],
              defaultId: 1,
              title: 'Revert Last Update',
              message: `Go back to ${target}?`,
              detail: `Currently running ${status.active}.\n\n`
                + 'Only the application files change. Sales, items, customers '
                + 'and settings are not touched.',
            });
            if (answer.response !== 0) return;
            const result = assetUpdater.revert();
            if (!result.ok) {
              dialog.showErrorBox('Could not revert', result.reason || 'unknown');
              return;
            }
            app.relaunch();
            app.exit(0);
          }
        },
        {
          label: 'Reset Window Size && Position',
          click: () => { resetWindowState(); }
        },
        {
          label: 'Remove Account && Reset Installation',
          click: () => { confirmFullAccountRemoval(); }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Contact Support…',
          click: () => { openSupportRequest(); }
        },
        { label: 'Support diagnostics…', click: () => supportDiagnostics.open() },
        {
          /* The first thing support asks for, so it is one click from the
             menu bar rather than a path somebody has to be talked through. */
          label: 'View Application Log',
          click: () => { openLogViewer(); }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => { openAboutWindow(); }
        }
      ]
    }
  ];

  // Keep the independent tools available when the page fails, in one place.
  const fileMenu = template.find(item => item.label === 'File');
  const recoveryMenu = template.find(item => item.label === 'Maintenance');
  const recoveryItems = fileMenu.submenu.filter(item => item.label && !['App Settings', 'Exit'].includes(item.label));
  fileMenu.submenu = fileMenu.submenu.filter(item => ['App Settings', 'Exit'].includes(item.label));
  recoveryMenu.label = 'Help && Recovery';
  recoveryMenu.submenu.unshift(...recoveryItems, { type: 'separator' });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Get dynamic label for Software Updates menu item
function getUpdateMenuLabel() {
  if (_updateMenuStatus.downloaded) {
    return `Software Updates  🔄 Restart to Update`;
  } else if (_updateMenuStatus.available) {
    return `Software Updates  🔴 New Version Available`;
  } else {
    return 'Software Updates';
  }
}

// Update menu when update status changes
function updateMenuBadge(status) {
  _updateMenuStatus.available = (status === 'available' || status === 'downloading' || status === 'downloaded');
  _updateMenuStatus.downloaded = (status === 'downloaded');

  // Recreate menu with new badge
  createMenu();
}

/* ------------------------------------------------------------------ *
 * Window chrome that follows the shop's theme
 *
 * The title bar is drawn by Windows, before the app has run, so it cannot ask
 * the page what colour to be. It is told after each theme change and remembers
 * the answer for next launch - which is why a dark till now opens dark instead
 * of flashing white and then settling.
 * ------------------------------------------------------------------ */

const CHROME_FILE = path.join(app.getPath('userData'), 'window-chrome.json');
const { chromeFor, CHROME_FALLBACK } = require('./window-chrome');

function rememberedChrome() {
  try {
    if (fs.existsSync(CHROME_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CHROME_FILE, 'utf8'));
      if (saved && saved.color && saved.symbolColor) {
        return { ...CHROME_FALLBACK, ...saved };
      }
    }
  } catch (err) { /* first run, or unreadable - the default is fine */ }
  return CHROME_FALLBACK;
}

/*
 * Take the colours the page just applied.
 *
 * Wrapped so that a theme this cannot parse leaves the window exactly as it
 * was. A wrong-coloured title bar is a blemish; a crash here would be a till
 * that will not open, and the two are not close.
 */
function applyWindowChrome(theme) {
  try {
    const chrome = chromeFor(theme || {});
    // This window uses custom controls, not a native titlebar overlay.
    fs.writeFileSync(CHROME_FILE, JSON.stringify({ ...chrome, palette: theme || null }));
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('theme:changed', theme || null);
    }
    return { ok: true, ...chrome };
  } catch (err) {
    console.warn('[chrome] could not apply theme to the window:', err.message);
    return { ok: false, error: err.message };
  }
}

/*
 * About: what build is this, and where do I get help.
 *
 * The old one was a hardcoded "Posnic" gradient with a version number, which
 * told a white-labelled shop the wrong product name and told support nothing
 * it could act on. This carries the brand the build actually shipped with, the
 * numbers a support call opens with, and the one button that saves the call
 * ten minutes.
 */
/* ---- asking for help, from inside the till ------------------------------
 *
 * Reports are gathered locally and copied out by the shop. Nothing is sent to
 * a vendor endpoint from this build.
 */
/*
 * What the machine can say about itself, so the shop does not have to.
 *
 * Asking a shopkeeper for their operating system version and how much memory
 * they have is asking them to do our job badly. This is the same information
 * we would end up requesting over three emails, gathered in one step - and
 * shown to them before it is sent, because a support form that quietly
 * collects things is not one people should trust.
 */
function supportSystemInfo() {
  const os = require('os');

  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} ${os.release()} (${process.arch})`,
    osName: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform,
    memoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    locale: app.getLocale(),
    uptimeMinutes: Math.round(process.uptime() / 60),
  };
}

const SUPPORT_LOG_LINES = 300;

ipcMain.handle('support:context', () => {
  let logTail = [];
  try {
    if (fs.existsSync(LOG_FILE)) {
      const text = fs.readFileSync(LOG_FILE, 'utf8');
      logTail = text.split(/\r?\n/).filter(Boolean).slice(-SUPPORT_LOG_LINES);
    }
  } catch (err) { /* a missing log must not stop somebody asking for help */ }

  const system = supportSystemInfo();

  return {
    system,
    logTail,
    logLines: logTail.length,
  };
});

let supportWindow = null;

function openSupportRequest() {
  if (supportWindow && !supportWindow.isDestroyed()) {
    supportWindow.focus();
    return;
  }
  supportWindow = new BrowserWindow({
    width: 760,
    height: 700,
    icon: appIconPath(),
    title: 'Copy Support Report',
    autoHideMenuBar: true,
    parent: mainWindow || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  supportWindow.setMenuBarVisibility(false);
  supportWindow.loadFile('src/support-request.html');
  supportWindow.on('closed', () => { supportWindow = null; });
}

/*
 * Somewhere a shop can read their own log.
 *
 * The only route in was "Open Log", which called shell.openPath on a file that
 * can be tens of thousands of lines. On Windows that is Notepad; on a Linux
 * desktop with no handler for .log it is nothing at all, so the button did
 * visibly nothing. Neither helps somebody trying to tell us what went wrong.
 *
 * The window reads the file through IPC rather than loading it with a file://
 * URL, so the page keeps the same restrictions as every other window here -
 * no node integration, sandboxed, and a preload that exposes two calls.
 */
let logWindow = null;

function openLogViewer() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 900,
    height: 640,
    icon: appIconPath(),
    title: 'Application Log',
    autoHideMenuBar: true,
    parent: mainWindow || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  logWindow.setMenuBarVisibility(false);
  logWindow.loadFile('src/log-viewer.html');
  logWindow.on('closed', () => { logWindow = null; });
}

/*
 * Hand the log to the viewer.
 *
 * Capped rather than streamed: a log that has been running for months is
 * larger than a renderer should be asked to hold, and the part anybody wants
 * is the end. The cap is reported so the page can say it is showing a portion
 * rather than implying the file is short.
 */
const LOG_VIEW_MAX_BYTES = 2 * 1024 * 1024;

ipcMain.handle('logs:read', () => {
  let fd;
  try {
    fd = fs.openSync(LOG_FILE, 'r');
    const size = fs.fstatSync(fd).size;
    const truncated = size > LOG_VIEW_MAX_BYTES;
    const bytes = truncated ? LOG_VIEW_MAX_BYTES : size;
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, truncated ? size - bytes : 0);
    let text = buf.toString('utf8');
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
    return {
      ok: true,
      path: LOG_FILE,
      truncated,
      lines: text.split(/\r?\n/).filter((l) => l.length),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: true, lines: [], path: LOG_FILE, truncated: false };
    }
    return { ok: false, error: err.message };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
});

ipcMain.handle('logs:reveal', () => {
  try {
    shell.showItemInFolder(LOG_FILE);
    return true;
  } catch (err) {
    return false;
  }
});

function openAboutWindow() {
  const d = collectDiagnostics();
  const win = new BrowserWindow({
    width: 480,
    /* Taller than it was: the content is grouped into three sections now, and
       a fixed window that clips its own footer is worse than one extra inch. */
    height: 660,
    icon: appIconPath(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;

  /* Inlined: this window is a data: URL, so it has no origin to resolve a
     file path against. */
  let logoTag = '';
  try {
    const mark = path.join(__dirname, '..', 'builds', 'icon-256.png');
    if (fs.existsSync(mark)) {
      logoTag = `<img alt="" src="data:image/png;base64,${fs.readFileSync(mark).toString('base64')}">`;
    }
  } catch (e) { /* the window is still useful without the mark */ }

  /* This window has a preload and displays only generated content. Never let
     it navigate or open another window. */
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  /*
   * Grouped rather than one flat table.
   *
   * It was eight rows of unlabelled facts, which reads as a debug dump: the
   * version a shop is asked for on the phone sat between "Electron" and
   * "Build", equally weighted, so the one number that matters was the hardest
   * to find. Now the version is the headline, the rest is grouped under what
   * it is about, and the repository address is shown in full and copyable -
   * a link is no use to somebody reading it out or typing it on another
   * machine, which is exactly what an AGPL notice is for.
   */
  /* A value is escaped unless it is explicitly marked as markup we built
     ourselves - which is only ever the status pills below. Escaping by
     default and opting out once is safer than escaping and then unescaping
     with a regular expression, which is how a shop's own brand name could
     end up as markup in this window. */
  const asHtml = (markup) => ({ __html: markup });
  const rows = (pairs) => pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const cell = v && v.__html !== undefined ? v.__html : esc(v);
      return `<tr><th>${esc(k)}</th><td>${cell}</td></tr>`;
    })
    .join('');

  const REPO = '';

  // About has no privileged preload. Inline only bundled styles and validated
  // colour tokens so it still follows the shop without granting it IPC access.
  let aboutStyles = '';
  try {
    aboutStyles = fs.readFileSync(path.join(__dirname, 'window-theme.css'), 'utf8')
      + fs.readFileSync(path.join(__dirname, 'desktop-design.css'), 'utf8').replace(/@font-face\s*\{[^}]*\}/g, '');
    const palette = JSON.parse(fs.readFileSync(CHROME_FILE, 'utf8')).palette || {};
    const tokens = { bodyBg: 'body-bg', cardBg: 'card-bg', topbarBg: 'header-bg', textPrimary: 'text', textSecondary: 'muted', borderColor: 'border', primaryColor: 'accent' };
    const declarations = Object.entries(tokens).filter(([key]) => /^#[0-9a-f]{6}$/i.test(palette[key] || ''))
      .map(([key, token]) => `--w-${token}:${palette[key]};`).join('');
    aboutStyles += `:root{${declarations}--w-raised:color-mix(in srgb,var(--w-card-bg) 92%,var(--w-text) 8%);}`;
  } catch (_) { /* Bundled default styles remain useful before the first login. */ }

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0;
             background: #0f1420; color: #e8ecf5; font-size: 13px; }

      .hero { padding: 26px 24px 22px; text-align: center;
              background: linear-gradient(160deg, #223055, #131a2b);
              border-bottom: 1px solid rgba(255,255,255,.07); }
      .hero img { width: 58px; height: 58px; margin-bottom: 11px; background: #fff;
                  border-radius: 15px; padding: 7px; }
      .hero h1 { margin: 0; font-size: 23px; letter-spacing: -.01em; font-weight: 650; }
      .hero .ver { display: inline-block; margin-top: 8px; padding: 3px 12px;
                   border-radius: 999px; background: rgba(127,178,232,.16);
                   color: #9ec9f2; font-size: 12.5px; font-weight: 600;
                   font-variant-numeric: tabular-nums; }
      .hero .by { margin: 9px 0 0; font-size: 11.5px; opacity: .5; }

      .body { padding: 4px 0 0; }
      .sec { padding: 14px 24px 4px; }
      .sec h2 { margin: 0 0 7px; font-size: 10.5px; letter-spacing: .09em;
                text-transform: uppercase; color: #7f8ba3; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 5px 0; vertical-align: top; }
      th { color: #97a1b5; font-weight: 400; width: 44%; }
      td { font-variant-numeric: tabular-nums; }

      .pill { display: inline-block; padding: 1px 9px; border-radius: 999px;
              font-size: 11.5px; font-weight: 600; }
      .pill.on  { background: rgba(52,199,123,.16); color: #6ee7a8; }
      .pill.off { background: rgba(255,255,255,.08); color: #a9b3c6; }

      .repo { margin: 6px 24px 0; padding: 10px 12px; border-radius: 9px;
              background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); }
      .repo .u { font-family: ui-monospace, Consolas, monospace; font-size: 12px;
                 color: #9ec9f2; user-select: all; word-break: break-all; }
      .repo .n { margin-top: 5px; font-size: 11.5px; color: #8d97ab; line-height: 1.5; }

      .links { display: flex; flex-wrap: wrap; gap: 6px 16px;
               padding: 16px 24px 6px; border-top: 1px solid rgba(255,255,255,.07);
               margin-top: 14px; }
      .links a { color: #7fb2e8; text-decoration: none; font-size: 12.5px; }
      .links a:hover { text-decoration: underline; }

      .foot { padding: 6px 24px 22px; font-size: 11.5px; color: #8d97ab; line-height: 1.6; }
    </style><style>${aboutStyles}</style></head><body class="desktop-window" data-desktop-window="about">
    <div class="hero">
      ${logoTag}
      <h1>${esc(d.app.name)}</h1>
      <div class="ver">Version ${esc(d.app.version)}</div>
      ${d.app.name === 'Posnic'
        ? '<p class="by">by Posnic Innovations Private Limited &middot; Tamil Nadu, India</p>'
        : `<p class="by">powered by Posnic</p>`}
    </div>

    <div class="body">
      <div class="sec">
        <h2>Your licence</h2>
        <table>${rows([
          ['Edition', 'Local'],
        ])}</table>
      </div>

      <div class="sec">
        <h2>This computer</h2>
        <table>${rows([
          ['Operating system', d.machine.platform + ' ' + d.machine.release + ' (' + d.machine.arch + ')'],
          ['Timezone', d.machine.timezone],
          ['Build', d.app.packaged ? 'packaged release' : 'development'],
          ['Electron / Node', d.app.electron + ' / ' + d.app.node],
        ])}</table>
      </div>

      <div class="sec">
        <h2>Source code</h2>
      </div>
      <div class="repo">
        <div class="u">Posnic open source</div>
        <div class="n">Posnic is free software under the <b>GNU AGPL-3.0</b>. The source code
          for this build is supplied with the application.</div>
      </div>
      <div class="foot">
        Your sales and customers stay on this computer. Nothing here is sent
        anywhere.<br>
        <b>Help &rarr; Contact Support</b> gathers all of this for you when you report a problem.
      </div>
    </div>
  </body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/*
 * What a support person needs before they can help.
 *
 * A shop reporting "it stopped working" cannot be expected to find a version
 * number, a log file and a device id. This gathers the things that are asked
 * for on every single support call, so the answer to "what have you got?" is
 * one button rather than a conversation.
 *
 * Deliberately does not include the database, customer records or anything a
 * shop would be uncomfortable sending: version, platform, and its own settings.
 */
function collectDiagnostics() {
  const os = require('os');
  let brand = {};
  try {
    if (fs.existsSync(BRAND_FILE)) brand = JSON.parse(fs.readFileSync(BRAND_FILE, 'utf8'));
  } catch (e) { /* unbranded build */ }

  let assets = null;
  try { assets = assetUpdater.status(); } catch (e) { /* never blocks a report */ }

  return {
    app: {
      name: brand.name || app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
    },
    // Which frontend is actually running, which is not always the one the
    // installer put there - the first question worth asking about a bug that
    // only one shop can reproduce.
    assets: assets && {
      active: assets.active || '(as installed)',
      previous: assets.previous,
      verifiesSignatures: assets.verifies,
      bootAttempts: assets.boot && assets.boot.attempts,
    },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      locale: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    paths: { userData: app.getPath('userData'), log: LOG_FILE },
    collectedAt: new Date().toISOString(),
  };
}

/* The last of the log, capped so a report stays sendable. */
function tailLog(bytes = 200_000) {
  let fd;
  try {
    fd = fs.openSync(LOG_FILE, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '(no log file)';
    return '(log unreadable: ' + e.message + ')';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/*
 * Show the folder the log lives in.
 *
 * Support asks for the log on most calls, and talking somebody through
 * %APPDATA% over the phone is its own small ordeal.
 */
function openLogFolder() {
  const { shell } = require('electron');
  try {
    if (fs.existsSync(LOG_FILE)) shell.showItemInFolder(LOG_FILE);
    else shell.openPath(app.getPath('userData'));
  } catch (e) {
    console.warn('[Maintenance] could not open log folder:', e.message);
  }
}

/*
 * Put the window back to a sane size and position.
 *
 * For the case where a till is left with a window dragged half off a screen
 * that is no longer attached, which cannot be fixed from inside the window.
 */
function resetWindowState() {
  if (!mainWindow) return;
  try {
    mainWindow.unmaximize();
    mainWindow.setFullScreen(false);
    mainWindow.setSize(1280, 800);
    mainWindow.center();
    mainWindow.show();
    mainWindow.focus();
  } catch (e) {
    console.warn('[Maintenance] could not reset window:', e.message);
  }
}

/*
 * Sign this machine out without touching anything else.
 *
 * Separate from Clear History & Cache because the two are wanted at different
 * times: cache is a "it is behaving oddly" fix, cookies is "somebody else needs
 * to sign in here".
 */
function clearCookiesAndStorage() {
  const { dialog, session } = require('electron');
  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Clear & Restart', 'Cancel'],
    defaultId: 1,
    title: 'Clear Cookies & Sign-in',
    message: 'Sign this machine out?',
    detail: 'Clears cookies and stored sign-in for this device.\n\n'
      + 'Sales, items and settings are NOT affected - nothing is deleted from '
      + 'the database. Whoever uses the till next will need to sign in.',
  }).then(async (result) => {
    if (result.response !== 0) return;
    try {
      await session.defaultSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers'],
      });
      console.log('[Maintenance] cookies and storage cleared');
    } catch (e) {
      console.error('[Maintenance] clear failed:', e.message);
    }
    app.relaunch();
    app.exit(0);
  });
}

// Clear history and cache (only Electron cache, NOT database)
function clearHistoryAndCache() {
  const { dialog } = require('electron');

  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Clear & Restart', 'Cancel'],
    defaultId: 1,
    title: 'Clear History & Cache',
    message: 'Clear application cache?',
    detail: 'This will:\n• Clear application cache\n• Clear local storage\n• Clear session data\n• Restart the application\n\nNote: Database will NOT be affected.'
  }).then(async result => {
    if (result.response !== 0) return;

    // User clicked "Clear & Restart"
    try {
      console.log('🧹 Clearing cache and local storage...');
      await clearRendererStorage();
      console.log('✅ Cache and storage cleared');

      // app.exit() below skips 'before-quit', so the API server, mongoose
      // connection and bundled MongoDB process are never released here.
      // The relaunched instance then fails to rebind those same ports.
      // Run the same graceful shutdown used by account reset / app quit
      // before relaunching so the new instance starts on a clean slate.
      console.log('🛑 Shutting down services before restart...');
      await performGracefulShutdown();

      console.log('🔄 Restarting application...');
      app.relaunch();
      app.exit(0);
    } catch (error) {
      console.error('❌ Error clearing history:', error);
      dialog.showErrorBox('Error', 'Failed to clear history and cache: ' + error.message);
    }
  });
}

function removePathIfExists(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return false;
  fs.rmSync(targetPath, { recursive: true, force: true });
  return true;
}

function assertResetPathIsSafe(targetPath, allowedRoots) {
  const resolvedTarget = path.resolve(targetPath);
  const isAllowed = allowedRoots
    .filter(Boolean)
    .map(root => path.resolve(root))
    .some(root => resolvedTarget === root || resolvedTarget.startsWith(root + path.sep));

  if (!isAllowed) {
    throw new Error(`Refusing to remove unexpected path: ${resolvedTarget}`);
  }
}

async function clearRendererStorage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  await Promise.all([
    mainWindow.webContents.session.clearCache(),
    mainWindow.webContents.session.clearStorageData({
      storages: ['appcache', 'cookies', 'localstorage', 'sessionstorage', 'websql', 'indexdb']
    })
  ]);
}

async function dropPosnicDatabase(resetUri) {
  const { MongoClient } = require('mongodb');
  const uri = resetUri || process.env.MONGODB_URI || `mongodb://127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}/PosnicPro`;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000
  });

  await client.connect();
  try {
    await client.db('PosnicPro').dropDatabase();
  } finally {
    await client.close();
  }
}

async function removeFullAccountData(resetUri) {
  console.log('[AccountReset] Full account removal started');

  if (backupManager) backupManager.stopScheduler();
  await clearRendererStorage();
  await withTimeout(
    'Account reset API server',
    closeApiServer,
    SHUTDOWN_TIMEOUTS.apiServer
  );

  if (global.mongooseConnection) {
    await withTimeout(
      'Account reset MongoDB connection',
      () => global.mongooseConnection.close(false),
      SHUTDOWN_TIMEOUTS.mongoose
    );
  }

  try {
    await dropPosnicDatabase(resetUri);
    console.log('[AccountReset] PosnicPro database dropped');
  } catch (error) {
    if (resetUri) throw error;
    console.warn('[AccountReset] Database drop failed; local data files will still be removed if available:', error.message);
  }

  if (mongoDBManager) {
    await withTimeout(
      'Account reset bundled MongoDB process',
      () => mongoDBManager.stop(),
      SHUTDOWN_TIMEOUTS.bundledMongoDB
    );
  }

  const userDataPath = app.getPath('userData');
  const safeRoots = [
    path.join(userDataPath, 'mongodb'),
    path.join(__dirname, '..', 'mongodb')
  ];

  const pathsToRemove = [
    path.join(userDataPath, '.mongodb-credentials.json'),
    path.join(userDataPath, '.mongodb-setup-done'),
    path.join(__dirname, '.mongodb-credentials.json'),
    path.join(__dirname, '.mongodb-setup-done'),
    path.join(__dirname, '..', 'api', '.mongodb-credentials.json'),
    mongoDBManager?.dataPath,
    mongoDBManager?.logPath ? path.dirname(mongoDBManager.logPath) : null
  ].filter(Boolean);

  for (const targetPath of pathsToRemove) {
    const isMongoFolder = targetPath.includes(`${path.sep}mongodb${path.sep}`);
    if (isMongoFolder) {
      assertResetPathIsSafe(targetPath, safeRoots);
    }

    if (removePathIfExists(targetPath)) {
      console.log('[AccountReset] Removed:', targetPath);
    }
  }

  console.log('[AccountReset] Full account removal finished; relaunching');
}

function confirmFullAccountRemoval() {
  const { dialog } = require('electron');
  const focused = BrowserWindow.getFocusedWindow() || mainWindow;

  dialog.showMessageBox(focused, {
    type: 'warning',
    buttons: ['Cancel', 'Continue'],
    defaultId: 0,
    cancelId: 0,
    title: 'Remove Account & Reset Installation',
    message: 'Remove this Posnic account and database?',
    detail: 'This will permanently remove the local Posnic database, login/session data, and installation setup state. Backup folders in Documents\\Posnic-Backups will not be deleted.'
  }).then(first => {
    if (first.response !== 1) return;

    return dialog.showMessageBox(focused, {
      type: 'error',
      buttons: ['Cancel', 'Remove Account'],
      defaultId: 0,
      cancelId: 0,
      title: 'Final Confirmation',
      message: 'This action cannot be undone.',
      detail: 'After removal, Posnic will restart and show the installation wizard again. Use this only when you intentionally want a fresh account.'
    });
  }).then(second => {
    if (!second || second.response !== 1) return;

    removeFullAccountData()
      .then(() => {
        app.relaunch();
        app.exit(0);
      })
      .catch(error => {
        console.error('[AccountReset] Failed:', error);
        dialog.showErrorBox('Account Removal Failed', error.message);
      });
  }).catch(error => {
    console.error('[AccountReset] Confirmation failed:', error);
    dialog.showErrorBox('Account Removal Failed', error.message);
  });
}

// Only the local setup page can initiate a fresh setup. No business data is synced
// by these handlers; recovery files stay local and outside the active database.
let setupExistingShop = false;
function assertSetupPage(event) {
  let page;
  try { page = require('url').fileURLToPath(event.senderFrame.url); } catch { /* refused below */ }
  if (page !== path.join(__dirname, 'install-wizard.html')) throw new Error('Open setup to continue.');
}
ipcMain.handle('install:state', async event => {
  assertSetupPage(event);
  return { existing: setupExistingShop, addingShop: runningProfile !== 'original' };
});
ipcMain.handle('install:continue', async event => {
  assertSetupPage(event);
  if (!setupExistingShop) return { ok: false };
  fs.rmSync(path.join(app.getPath('userData'), '.setup-review'), { force: true });
  setupExistingShop = false;
  // Restart normal startup so sync and connectors resume only after this choice.
  relaunchAfterQuit = true;
  app.quit();
  return { ok: true };
});
async function saveAndResetLocalSetup(keepHardware, resetUri) {
    if (!mongoDBManager || mongoDBManager.usingExternal) throw new Error('Fresh setup requires this application’s own database.');
    const uri = resetUri || process.env.MONGODB_URI;
    await require('./local-reset').verifyLocalDatabase({ uri, dataPath: mongoDBManager.dataPath, MongoClient: require('mongodb').MongoClient });
    if (backupManager) backupManager.stopScheduler();
    if (connectorSupervisor) await connectorSupervisor.stopAll();
    await closeApiServer();
    if (global.mongooseConnection) await global.mongooseConnection.close(false);
    const databaseProcess = mongoDBManager.mongoProcess;
    await mongoDBManager.stop();
    if (!databaseProcess || (databaseProcess.exitCode === null && databaseProcess.signalCode === null)) throw new Error('The database is still closing. Restart and retry.');
    const userData = app.getPath('userData');
    const recovery = await require('./setup-recovery').resetSavedData({
      userData, recoveryRoot: path.join(app.getPath('documents'), app.getName() + '-Recovery'), keepHardware,
      verifyRestore: archive => require('./verify-shop-recovery').verifyShopRecovery({
        archive, binary: mongoDBManager.mongoPath, uri, MongoClient: require('mongodb').MongoClient
      })
    });
    await clearRendererStorage();
    fs.rmSync(path.join(userData, '.setup-review'), { force: true });
    console.log('[Setup] Recovery copy verified:', recovery);
}
ipcMain.handle('install:fresh', async (event, options = {}) => {
  assertSetupPage(event);
  if (!setupExistingShop || typeof options.keepHardware !== 'boolean') return { ok: false, error: 'Setup is not ready. Please retry.' };
  try {
    await saveAndResetLocalSetup(options.keepHardware);
    relaunchAfterQuit = true;
    app.quit();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message + ' Close and reopen the app before retrying.' };
  }
});

// IPC handler for page navigation from install wizard
ipcMain.on('load-page', (event, page) => {
  if (page === 'login' && mainWindow) {
    fs.rmSync(path.join(app.getPath('userData'), '.setup-review'), { force: true });
    redirectToLogin();
  }
});

// IPC handler to expose API port to renderer
ipcMain.handle('get-api-port', () => apiPort());

// =====================================================
// BACKUP MANAGER - Initialize and IPC handlers
// =====================================================
const BackupManager = require('./backup-manager');

let backupManager = null;

function getBackupManager() {
  if (!backupManager) {
    backupManager = new BackupManager({
      userDataPath: app.getPath('userData'),
      getMongoUri: () => process.env.MONGODB_URI || `mongodb://127.0.0.1:${process.env.POSNIC_MONGO_PORT || 47017}/PosnicPro`,
      dbName: 'PosnicPro'
    });

    // Wrap runBackup to add notifications for scheduled (auto) backups
    const originalRunBackup = backupManager.runBackup.bind(backupManager);
    backupManager.runBackup = async function (options = {}) {
      const isManual = !!options._manual;
      const result = await originalRunBackup(options);

      // Only show OS notification for scheduled (non-manual) backups
      // Manual backups get toast in the backup-manager.html
      if (!isManual) {
        try {
          showBackupNotification(result);
        } catch (e) {
          console.error('Failed to show backup notification:', e.message);
        }
      }

      // Broadcast to backup window if open (to refresh UI)
      try {
        if (backupWindow && !backupWindow.isDestroyed()) {
          backupWindow.webContents.send('backup:result', result);
        }
      } catch (e) { }

      return result;
    };
  }
  return backupManager;
}

function showBackupNotification(result) {
  if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;

  let title, body, icon;
  if (result.success) {
    if (result.skipped) {
      title = '💾 Backup Skipped';
      body = 'No data changes since last backup (deduplication)';
    } else {
      title = '✅ Backup Complete';
      const sizeMB = ((result.size || 0) / 1024 / 1024).toFixed(2);
      body = `${result.collections} collections, ${result.totalDocuments} docs, ${sizeMB} MB`;
    }
  } else {
    title = '❌ Backup Failed';
    body = result.error || 'Unknown error';
  }

  const notification = new Notification({ title, body, silent: false });
  notification.show();
}

function requireBackupWindow(event, managerOnly = false) {
  // Setup and desktop settings live in the main window. Restore and deletion
  // belong exclusively to the dedicated manager; subframes never qualify.
  const windows = managerOnly ? [backupWindow] : [backupWindow, mainWindow];
  const allowed = windows.some(win => win && !win.isDestroyed() &&
    event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  if (!allowed) throw new Error('Open Backup Manager to use this action');
}

// Get default backup path (Documents/Posnic-Backups)
ipcMain.handle('backup:get-default-path', (event) => {
  requireBackupWindow(event);
  try {
    const documentsPath = app.getPath('documents');
    return path.join(documentsPath, 'Posnic-Backups');
  } catch (e) {
    return path.join(app.getPath('userData'), 'backups');
  }
});

// Open folder picker
ipcMain.handle('backup:browse-folder', async (event) => {
  requireBackupWindow(event);
  const { dialog } = require('electron');
  const focused = BrowserWindow.getFocusedWindow() || mainWindow;

  const result = await dialog.showOpenDialog(focused, {
    title: 'Select Backup Folder',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use This Folder'
  });

  if (result.canceled || !result.filePaths.length) return null;

  /*
   * Remember that the person at the keyboard chose this folder.
   *
   * Restore reads a database out of whatever folder it is handed and writes it
   * over the shop's data, and it is reachable from renderer IPC - so a page
   * that managed to run someone else's script could point it at a prepared
   * folder and replace the till's books. Restricting it to the configured
   * backup root would close that, and would also stop the legitimate case this
   * dialog exists for: restoring from a USB stick after a machine dies.
   *
   * So the main process keeps the paths that came back from its own dialog.
   * A renderer cannot add to this list; it can only name something already on
   * it. See backupManager.grantRestorePath.
   */
  getBackupManager().grantRestorePath(result.filePaths[0]);
  getBackupManager().grantBackupPath(result.filePaths[0]);
  return result.filePaths[0];
});

// Save backup config
ipcMain.handle('backup:save-config', (event, config) => {
  requireBackupWindow(event);
  try {
    const mgr = getBackupManager();
    const saved = mgr.saveConfig(config);

    // Restart scheduler with new config
    mgr.stopScheduler();
    if (saved.enabled) {
      mgr.startScheduler();
    }

    return { success: true, config: saved };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get backup config
ipcMain.handle('backup:get-config', (event) => {
  requireBackupWindow(event);
  try {
    return { success: true, config: getBackupManager().loadConfig() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/*
 * The commands for scheduling a backup with the operating system, with this
 * machine's real paths already in them.
 *
 * Backups are a timer inside the application, so a shop that shuts the till
 * down every evening never gets an overnight one. The scheduler is the only
 * thing that can run it with the app closed, and "point a scheduled task at
 * your Node installation" is not an instruction a shopkeeper can follow - so
 * the exact line is generated here to be copied rather than typed.
 */
ipcMain.handle('backup:schedule-instructions', (event, options) => {
  requireBackupWindow(event);
  try {
    const scheduled = require('./scheduled-task');
    const config = getBackupManager().loadConfig();

    /* Default to whatever the shop already chose for the in-app schedule, so
       the printed command and the setting on screen agree. */
    const described = scheduled.describe({
      task: 'backup',
      frequency: (options && options.frequency) || config.frequency || 'daily',
      time: (options && options.time) || config.time || '22:00',
    });

    return {
      success: true,
      instructions: { ...described, destination: config.path },
      text: scheduled.asText(described),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Run backup now (manual trigger)
ipcMain.handle('backup:run-now', async (event, force) => {
  requireBackupWindow(event);
  try {
    return await getBackupManager().runBackup({ force: !!force, _manual: true });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List all backups
ipcMain.handle('backup:list', (event) => {
  requireBackupWindow(event);
  try {
    return { success: true, backups: getBackupManager().listBackups() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Restore from backup
ipcMain.handle('backup:restore', async (event, folderPath, options) => {
  requireBackupWindow(event, true);
  try {
    const result = await getBackupManager().restoreBackup(folderPath, options || {});

    // After successful restore: full app restart for a clean state.
    // Why a full restart? Because the live app has cached state at multiple layers:
    //   • web: JWT token in localStorage, in-memory React/JS state
    //   • API server: Mongoose connection pool, query caches, schema validators
    //   • Auth: JWT tokens signed pre-restore that reference old user IDs
    // Clearing only browser storage is not enough; the API server keeps stale
    // mongoose models/connections that cause 401s and crashes.
    // A clean restart guarantees everything reloads with the restored data.
    if (result.success) {
      // Schedule restart AFTER returning the success response to the renderer,
      // so the UI can show the success toast first.
      setTimeout(() => {
        try {
          console.log('🔄 Restore complete - restarting app for clean state...');

          // Clear all storage caches just to be safe
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.session.clearStorageData({
              storages: ['localstorage', 'sessionstorage', 'cookies', 'indexdb', 'cachestorage']
            }).catch(() => { });
          }

          app.relaunch();
          app.exit(0);
        } catch (e) {
          console.error('Failed to restart app:', e.message);
        }
      }, 2000); // 2 second delay so user sees the success toast
    }

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Delete a backup
ipcMain.handle('backup:delete', (event, folderPath) => {
  requireBackupWindow(event, true);
  try {
    return getBackupManager().deleteBackup(folderPath);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get backup history
ipcMain.handle('backup:get-history', (event) => {
  requireBackupWindow(event);
  try {
    return { success: true, history: getBackupManager().loadHistory() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open backup manager window
let tray = null;
let trayBranches = { branches: [], currentName: null };
let closeToTrayHintShown = false;
global.__posnicStartHidden = process.argv.includes('--hidden');

function showMainWindowIfAllowed() {
  if (global.__posnicStartHidden) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

// The web UI reports the logged-in user's branch list (and reacts to switch
// requests) so the tray can offer one-click branch switching.
ipcMain.handle('tray:set-branches', (_event, data) => {
  trayBranches = {
    branches: Array.isArray(data?.branches) ? data.branches.slice(0, 20) : [],
    currentName: data?.currentName || null
  };
  if (tray && tray.rebuildMenu) tray.rebuildMenu();
  return true;
});

/*
 * The application icon, in a format this operating system can read.
 *
 * .ico is a Windows container. macOS and Linux cannot load one, so every place
 * that asked for app.ico got nothing off Windows - the tray silently failed
 * with "Failed to load image from path", and the windows fell back to a
 * generic icon. A shop on Ubuntu had an unbranded application and no tray at
 * all, which is also how the "close to tray" behaviour quietly stopped
 * existing there.
 *
 * PNG works on all three, so only Windows needs the .ico - and it genuinely
 * does, because that is what Windows wants for a taskbar and tray at multiple
 * sizes from one file.
 */
function appIconPath() {
  const file = process.platform === 'win32' ? 'app.ico' : 'app.png';
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, file), path.join(process.resourcesPath, 'app.ico')]
    : [
        path.join(__dirname, '..', 'builds', file === 'app.png' ? 'icon-256.png' : 'app.ico'),
        path.join(__dirname, '..', 'builds', 'app.ico'),
      ];
  /* The .ico is kept as a last resort rather than returning nothing: a wrong
     icon is better than a missing window. */
  return candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || candidates[0];
}

function createTray() {
  try {
    const iconPath = appIconPath();
    if (!fs.existsSync(iconPath)) return;

    tray = new Tray(iconPath);
    tray.setToolTip('Posnic');

    const rebuild = () => {
      const branchItems = trayBranches.branches.length
        ? [
            {
              label: trayBranches.currentName
                ? `Branch: ${trayBranches.currentName}`
                : 'Switch Branch',
              submenu: trayBranches.branches.map((b) => ({
                label: b.name,
                type: 'radio',
                checked: !!b.current,
                click: () => {
                  if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                    mainWindow.webContents.send('tray:switch-branch', b.id);
                  }
                }
              }))
            },
            { type: 'separator' }
          ]
        : [];

      tray.setContextMenu(Menu.buildFromTemplate([
        {
          label: 'Open Posnic',
          click: () => { global.__posnicStartHidden = false; if (mainWindow) { mainWindow.show(); mainWindow.focus(); } }
        },
        { type: 'separator' },
        ...branchItems,
        { label: 'App Settings', click: () => openAppSettings('app') },
        { label: 'Hardware Manager', click: () => openHardwareManager() },
        { label: 'Backup Manager', click: () => openBackupManager() },
        { label: 'Updates & Recovery', click: () => openUpdateManager() },
        { type: 'separator' },
        {
          label: 'Restart App',
          /* The flag rather than app.relaunch() here: the graceful shutdown has to
             run first, stopping the API and the database, and the relaunch is armed
             at the end of it on the quit path that actually honours it. */
          click: () => { relaunchAfterQuit = true; app.quit(); }
        },
        { label: 'Quit Posnic', click: () => app.quit() }
      ]));
    };
    rebuild();
    tray.rebuildMenu = rebuild;
    tray.on('click', () => { global.__posnicStartHidden = false; if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch (err) {
    console.warn('[Tray] Could not create tray icon:', err.message);
  }
}

let profilesWindow = null;
function openShopProfiles() {
  if (profilesWindow && !profilesWindow.isDestroyed()) return profilesWindow.focus();
  profilesWindow = new BrowserWindow({ width: 640, height: 570, title: 'Shops on this computer', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  profilesWindow.on('closed', () => { profilesWindow = null; });
  profilesWindow.loadFile(path.join(__dirname, 'shop-profiles.html'));
}
function assertProfilesWindow(event) {
  if (!profilesWindow || event.sender !== profilesWindow.webContents || event.senderFrame !== event.sender.mainFrame ||
      require('url').fileURLToPath(event.senderFrame.url) !== path.join(__dirname, 'shop-profiles.html')) throw new Error('Open Shops on this computer.');
}
async function currentShopName() {
  const db = global.mongooseConnection?.db;
  if (db) {
    const branch = await db.collection('branches').findOne({}, { projection: { branch_name: 1 } });
    profiles.rename(branch?.branch_name);
  }
  return profiles.state.shops.find(shop => shop.id === runningProfile).name;
}
ipcMain.handle('shops:current', async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Open the main shop window.');
  return { name: await currentShopName(), multiple: profiles.state.shops.length > 1 };
});
ipcMain.handle('shops:manage', event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Open the main shop window.');
  openShopProfiles();
});
ipcMain.handle('shops:list', async event => {
  assertProfilesWindow(event);
  await currentShopName();
  return { ...profiles.state };
});
ipcMain.handle('shops:open', async (event, id) => {
  assertProfilesWindow(event);
  if (nextProfile || id === runningProfile) throw new Error('Shop switch unavailable.');
  if (id === 'add' && (mongoDBManager?.usingExternal || !mongoDBManager?.mongoProcess)) {
    throw new Error('A separate shop requires the desktop-managed database.');
  }
  if (id !== 'add') profiles.directory(id);
  nextProfile = id === 'add' ? profiles.add() : id;
  relaunchAfterQuit = true;
  app.quit();
});
function openBackupManager() {
  if (backupWindow) {
    backupWindow.focus();
    return;
  }

  backupWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: appIconPath(),
    title: 'Backup Manager',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      /* sandbox and webSecurity match the main window. They were absent here,
         which made these the weakest renderers in the application. */
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  backupWindow.setMenuBarVisibility(false);

  backupWindow.loadFile('src/backup-manager.html').catch((error) => {
    console.error('Failed to load Backup Manager:', error);
    if (backupWindow && !backupWindow.isDestroyed()) {
      backupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <html>
          <body style="font-family:Arial;padding:40px;background:#f5f6fa">
            <h2>Backup Manager could not be opened</h2>
            <p>${String(error.message || error)}</p>
            <p>Please install the latest Posnic build.</p>
          </body>
        </html>
      `)}`);
    }
  });

  backupWindow.on('closed', () => {
    backupWindow = null;
  });
}

// Open hardware manager window
function openHardwareManager(section) {
  if (hardwareWindow) {
    if (section) hardwareWindow.webContents.send('desktop:navigate', section);
    hardwareWindow.focus();
    return;
  }

  hardwareWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      /* sandbox and webSecurity match the main window. They were absent here,
         which made these the weakest renderers in the application. */
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  hardwareWindow.setMenuBarVisibility(false);

  hardwareWindow.loadFile('src/hardware-manager.html', section ? { hash: section } : {});

  hardwareWindow.on('closed', () => {
    hardwareWindow = null;
  });

  if (hardwareManager) {
    hardwareManager.setMainWindow(hardwareWindow);
  }
}

// Open update manager window
let updateWindow = null;
function openUpdateManager() {
  if (updateWindow) {
    updateWindow.focus();
    return;
  }

  updateWindow = new BrowserWindow({
    width: 700,
    height: 800,
    icon: appIconPath(),
    title: 'Software Update Manager',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      /* sandbox and webSecurity match the main window. They were absent here,
         which made these the weakest renderers in the application. */
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js')
    },
    parent: mainWindow,
    modal: false
  });
  updateWindow.setMenuBarVisibility(false);

  updateWindow.loadFile('src/update-manager.html');

  updateWindow.on('closed', () => {
    updateWindow = null;
  });
}

// App ready
/**
 * Wait for the closing instance to actually go, then take the lock.
 *
 * @returns {Promise<boolean>} true if this process may now start
 *
 * Two things have to become true, and they are not the same thing: the old
 * process has to exit, and this one has to succeed in acquiring the lock it
 * previously failed to get. Checking only the pid would race - the process can
 * be gone a moment before the lock is released - so this asks for the lock
 * each time round and only believes it when it is granted.
 */
async function awaitPreviousShutdown(previous) {
  showWaitingForPrevious(require('electron'));

  const deadline = Date.now() + 45_000;   // longer than the 25s shutdown budget
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));

    if (app.requestSingleInstanceLock({ startedAt: new Date().toISOString(), pid: process.pid })) {
      const waited = Math.round((45_000 - (deadline - Date.now())) / 100) / 10;
      console.log(`[Main] The previous instance has closed after ${waited}s; starting`);
      return true;
    }

    /* If the old process has gone but the lock is still not ours, something
       else holds it - a genuinely separate instance - and waiting longer will
       not help. */
    if (!shutdownState.isAlive(previous.pid)) {
      console.log('[Main] The previous process has gone but the lock is held elsewhere');
      return false;
    }
  }
  return false;
}

app.whenReady().then(async () => {
  require('./print-temp-files').cleanup(app.getPath('temp'));
  console.log('='.repeat(55));
  /* Named the platform it is actually on. The banner said "Windows" in
     every log, including the ones a Linux and macOS shop send us when
     something is wrong - which is a small thing that makes a support
     reader doubt everything under it. */
  const PLATFORM_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform]
    || process.platform;
  console.log(`   Posnic for ${PLATFORM_NAME}`);
  console.log('='.repeat(55));
  console.log('');

  /*
   * Before anything else, so a double-click has something to show for itself.
   *
   * Ports, the database and the API take a few seconds, and with nothing on
   * screen the shop assumes the click missed and clicks again. It is closed by
   * closeSplash() as soon as a real window is up - see createWindow.
   */
  showSplash(require('electron'), {
    /* Not for a scheduled backup, which runs with nobody watching and must
       not put a window on the screen of whoever is logged in at ten at
       night; nor for a start minimised to the tray. */
    hidden: global.__posnicStartHidden
      || process.argv.some((a) => a.startsWith('--scheduled-task=')),
  });

  /*
   * If the last session is still closing, wait for it here.
   *
   * Nothing below this can run until it has finished: it still holds the
   * database files and the ports. So this blocks startup deliberately - but it
   * blocks it with a window on screen saying why, which is the entire
   * difference between this and what happened before.
   */
  if (waitingForPreviousShutdown) {
    const opened = await awaitPreviousShutdown(waitingForPreviousShutdown);
    if (!opened) {
      /* It never let go. Two instances sharing one database is far worse than
         a launch that gives up, so this gives up - loudly, in the log, and
         with the splash taken down rather than left spinning. */
      console.error('[Main] The previous instance never released the lock; exiting');
      closeSplash();
      app.exit(0);
      return;
    }
  }

  /*
   * Settle the local ports before anything tries to bind one.
   *
   * Everything downstream - the bundled database, the API, the sync agent and
   * the saved credentials - reads these from the environment, so this is the
   * only place the numbers are decided.
   */
  try {
    const { resolveLocalPorts, resolveSyncStatusPort } = require('./local-ports');
    const ports = await resolveLocalPorts({
      appName: app.getName(),
      userDataPath: app.getPath('userData'),
    });
    process.env.SYNC_AGENT_PORT = String(await resolveSyncStatusPort(ports));
    process.env.POSNIC_MONGO_PORT = String(ports.mongoPort);
    process.env.PORT = String(ports.apiPort);
    if (!process.env.MONGODB_URI) {
      /* mongod is deliberately bound to IPv4 loopback only. `localhost` may
         resolve to ::1 first on Linux, which leaves a healthy bundled database
         unreachable and makes first launch look like an installation failure. */
      process.env.MONGODB_URI = `mongodb://127.0.0.1:${ports.mongoPort}/PosnicPro`;
    }
    console.log(`  - database port: ${ports.mongoPort}${ports.reused ? ' (as before)' : ''}`);
    console.log(`  - application port: ${ports.apiPort}`);
    if (ports.movedFromPreferred) {
      console.log('    (something else held the usual port, so a free one was taken)');
    }
  } catch (err) {
    // Nothing can work without ports, so say so plainly and stop rather than
    // failing later with a stack trace about a socket.
    //
    // Only a genuine port clash gets the "close the other program" advice.
    // Everything else that can go wrong here - a module missing from the
    // package, a read-only data folder - is our problem, not the shop's, and
    // telling them to close another program sends them hunting for something
    // that is not there.
    console.error('[startup] ' + (err && err.stack ? err.stack : err));
    const isPortClash = err && err.code === 'NO_FREE_PORT';
    dialog.showErrorBox(
      'Cannot start',
      isPortClash
        ? `${err.message}\n\nClose the other program and start again, or contact support.`
        : `${err && err.message ? err.message : err}\n\nThis is a fault in the application, not ` +
          `something you can fix. Please contact support and quote the message above.`
    );
    app.quit();
    return;
  }
  console.log('');
  console.log('Environment:');
  console.log('  - isPackaged:', app.isPackaged);
  console.log('  - __dirname:', __dirname);
  console.log('  - process.resourcesPath:', process.resourcesPath);
  console.log('  - app.getAppPath():', app.getAppPath());
  console.log('');

  // Clearing cache every time forces the frontend to reload every asset.
  // Keep it available as an opt-in troubleshooting operation.
  if (process.env.POSNIC_CLEAR_CACHE === '1') {
    await clearStartupBrowserCache();
  }

  // POS product names trigger squiggles everywhere - not a document editor
  try { session.defaultSession.setSpellCheckerEnabled(false); } catch (e) { /* older electron */ }

  // Windows taskbar Jump List (right-click the taskbar icon)
  try {
    if (process.platform === 'win32' && !customUserData) app.setUserTasks([
      { program: process.execPath, arguments: '--open=hardware', title: 'Hardware Manager', description: 'Printers, scanners, scales', iconPath: process.execPath, iconIndex: 0 },
      { program: process.execPath, arguments: '--open=backup', title: 'Backup Manager', description: 'Local backups', iconPath: process.execPath, iconIndex: 0 },
      { program: process.execPath, arguments: '--open=update', title: 'Software Update', description: 'Check for updates', iconPath: process.execPath, iconIndex: 0 },
    ]);
  } catch (e) { /* non-Windows or unsupported */ }

  /*
   * A scheduled run: do the job and leave, without ever showing a window.
   *
   * Backups are a setInterval inside this application, so they only happen
   * while it is open. A shop that closes at nine and opens at nine gets no
   * overnight backup, and the morning that matters is the one where the disk
   * does not come back. The Cloud edition has no such problem - that work runs
   * on the server - so this is for the local edition, where the operating
   * system's scheduler is the only thing that can do it.
   *
   * It runs as the real application rather than as a bare script, and that is
   * the point. ELECTRON_RUN_AS_NODE would be lighter, but under it
   * require('electron') fails, so safeStorage is unreachable - and the database
   * password is wrapped with safeStorage. A plain script could not decrypt its
   * own credentials. Started this way, everything that normally works works.
   *
   * scheduled-task.js generates the exact command with the real paths filled
   * in; docs/USER_GUIDE.md explains it for a shopkeeper.
   */
  const scheduledArg = process.argv.find((a) => a.startsWith('--scheduled-task='));
  if (scheduledArg) {
    await runScheduledTaskAndExit(scheduledArg.split('=')[1]);
    return;
  }

  // Show UI immediately while MongoDB and the API initialize.
  createWindow();
  createMenu();
  createTray();

  // Initialize MongoDB manager
  mongoDBManager = new MongoDBManager();
  startupPerformance.mongoStartedAt = Date.now();
  updateStartupStatus('mongo', 'Starting database...', 'Preparing local data', 15);

  // Try to start bundled MongoDB first
  if (mongoDBManager.checkBundledMongoExists()) {
    console.log(' Bundled MongoDB found');
    try {
      await mongoDBManager.start();
      startupPerformance.mongoReadyMs =
        Date.now() - startupPerformance.mongoStartedAt;
      updateHealthStatus({
        mongodb: 'ready',
        mongodbReadyAt: new Date().toISOString(),
        mongodbReadyMs: startupPerformance.mongoReadyMs,
        api: 'starting'
      });
      updateStartupStatus('api', 'Starting API Server...', 'Loading application services', 45);
      console.log(' Bundled MongoDB is running\n');
    } catch (error) {
      updateHealthStatus({
        status: 'error',
        mongodb: 'failed',
        lastError: {
          name: error.name,
          message: error.message,
          code: error.code
        }
      });
      console.error('  Failed to start bundled MongoDB:', error.message);
      console.log('Checking for a system MongoDB service...\n');
      // Fail fast with an actionable screen instead of hanging on a dead DB.
      const systemMongoAvailable = profiles.state.shops.length === 1 && !customUserData && await mongoDBManager.isPortOpen(2000);
      if (!systemMongoAvailable) {
        updateStartupStatus(
          'error',
          'Database could not be started',
          error.code === 'MONGODB_PROFILE_MISMATCH' ? error.message :
            'Automatic repair was attempted. Click Restart App; if this repeats, open the log file and contact Posnic support.'
        );
        return; // do not start the API against a dead database
      }
      console.log(` System MongoDB responding on ${process.env.POSNIC_MONGO_PORT} - continuing\n`);
    }
    // If the database process dies mid-session (power event, OOM), restart it
    // once automatically instead of leaving the POS frozen.
    mongoDBManager.onUnexpectedExit = async () => {
      updateHealthStatus({ mongodb: 'crashed', mongodbCrashedAt: new Date().toISOString() });
      try {
        await mongoDBManager.start();
        updateHealthStatus({ mongodb: 'ready', mongodbRestartedAt: new Date().toISOString() });
        console.log('MongoDB restarted after unexpected exit');
      } catch (restartError) {
        console.error('MongoDB restart failed:', restartError.message);
        updateHealthStatus({ status: 'error', mongodb: 'failed' });
        dialog.showErrorBox(
          'Posnic - Database stopped',
          'The local database stopped and could not be restarted automatically.\n' +
          'Please close and reopen Posnic. If the problem repeats, contact support.'
        );
      }
    };
  } else {
    console.log(' Bundled MongoDB not found');
    const systemMongoAvailable = profiles.state.shops.length === 1 && !customUserData && await mongoDBManager.isPortOpen(2000);
    if (!systemMongoAvailable) {
      updateStartupStatus(
        'error',
        'Database not found',
        'This installation is missing its database component. Please reinstall Posnic.'
      );
      return;
    }
    console.log(` Using system MongoDB on ${process.env.POSNIC_MONGO_PORT}\n`);
  }

  // Initialize hardware manager
  hardwareManager = new HardwareManager();
  if (process.platform === 'win32') {
    try { hardwareManager.getWindowsPrintQueue(); }
    catch (error) { console.error('[Print] Recovery state needs attention:', error.message); }
  }
  console.log('HardwareManager initialized');

  /*
   * Start the raw print helper before the first sale, not on it.
   *
   * Starting PowerShell and compiling its interop class costs 350 to 550 ms.
   * Paid here it is paid once, while nobody is waiting; paid on the first
   * receipt it is paid in front of a customer. Failure is not fatal: the
   * print path falls back to a per-job spawn exactly as it always did.
   */
  require('./raw-print-service').warm().then((ok) => {
    console.log(ok ? 'Raw print helper warm' : 'Raw print helper unavailable; pending jobs remain in recovery');
  });

  // Setup IPC handlers
  setupHardwareIPC(hardwareManager);
  console.log('Hardware IPC handlers registered');

  // Start server
  startServer();
});

/*
 * Put the brand shipped inside the installer in place, once.
 *
 * An offline branded build carries its logo and names inside the installer.
 * Without this a customer who paid for white label still met a Posnic sign-in
 * screen, the first thing their staff ever see. This copies the seed across on
 * first launch.
 *
 * Only when there is nothing there already: a shop may have adjusted its own
 * brand, and an installer update must not overwrite that with artwork baked in
 * months ago.
 */
function seedBrandFromBuild() {
  try {
    const seedDir = app.isPackaged
      ? path.join(process.resourcesPath, 'brand-seed')
      : path.join(__dirname, '..', 'builds', 'brand-seed');
    if (!fs.existsSync(path.join(seedDir, 'brand.json'))) return;   // stock build

    /*
     * Re-seed when the installer carries different artwork to what is on disk.
     *
     * This used to return the moment a brand file existed, so reinstalling
     * with corrected logos changed nothing: the first install's artwork stayed
     * for ever and the only way out was deleting the folder by hand.
     *
     * A brand fetched from the cloud still wins and is never touched. The
     * cloud is the authority once a shop connects, and its descriptor is
     * recognisable: it carries a numeric version and an updatedAt, where a
     * seed's version is the string written when the installer was branded.
     */
    if (fs.existsSync(BRAND_FILE)) {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(BRAND_FILE, 'utf8')); } catch { /* rewrite it */ }

      const fromCloud = current && (typeof current.version === 'number' || current.updatedAt);
      if (fromCloud) return;

      const seeded = JSON.parse(fs.readFileSync(path.join(seedDir, 'brand.json'), 'utf8'));
      const sameArtwork = ['brand-logo.png', 'brand-login-logo.png'].every((f) => {
        const a = path.join(seedDir, f);
        const b = path.join(BRAND_DIR, f);
        if (fs.existsSync(a) !== fs.existsSync(b)) return false;
        if (!fs.existsSync(a)) return true;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
      });
      if (sameArtwork && current && current.name === seeded.name && current.version === seeded.version) {
        return;
      }
      console.log('[Brand] installer carries different artwork; re-seeding');
    }

    fs.mkdirSync(BRAND_DIR, { recursive: true });
    for (const f of ['brand.json', 'brand-logo.png', 'brand-login-logo.png']) {
      const from = path.join(seedDir, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(BRAND_DIR, f));
    }
    console.log('[Brand] applied the brand shipped with this installer');
  } catch (err) {
    // Branding must never be the reason a till fails to start.
    console.warn('[Brand] seed failed:', err.message);
  }
}

/*
 * Credentials for this machine's own setup endpoint.
 *
 * /api/install/add seeds a shop and /api/install/cleanup erases one, so the
 * API refuses both unless a key and secret are configured. That is right for
 * the cloud - the previous build shipped a fixed key in a public repository,
 * which meant anyone who read it could wipe any shop - but the desktop had no
 * key at all, so the API turned away its own setup wizard with "Installation
 * is not configured on this server" and no shop could be created.
 *
 * Generate a pair per installation and keep it in userData. Random, so it is
 * useless anywhere else, and never in the repository.
 */
function getInstallCredentials() {
  const file = path.join(app.getPath('userData'), '.install-credentials.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.key && saved.secret) return saved;
  } catch (e) { /* first run, or the file was removed */ }

  const crypto = require('crypto');
  const creds = {
    key: crypto.randomBytes(24).toString('hex'),
    secret: crypto.randomBytes(24).toString('hex'),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(creds), { mode: 0o600 });
  } catch (e) {
    // Not fatal: the pair still works for this run, it just is not reused.
    console.warn('[install] could not persist setup credentials:', e.message);
  }
  return creds;
}

// The wizard runs in a renderer and has to send the same pair the API checks.
ipcMain.handle('install:credentials', () => getInstallCredentials());

/*
 * Secrets this installation signs and encrypts with.
 *
 * These used to be constants in api/src/config/config.js, which meant every
 * Posnic in the world signed its tokens with the same string and guarded its
 * local print-queue endpoints with the same key. Anyone reading the source could mint a
 * valid session for any till. Publishing the repository turns that from a
 * latent problem into an open door.
 *
 * Generated once per machine, kept beside the install credentials. Nothing to
 * configure, nothing shared between shops, and a copy of the source tells an
 * attacker nothing about anybody's installation.
 */
function getLocalSecrets() {
  const file = path.join(app.getPath('userData'), '.local-secrets.json');
  const NEEDED = ['jwtSecret', 'sessionSecret', 'encryptionKey', 'encryptionIv', 'kioskKey'];

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && NEEDED.every((k) => saved[k])) return saved;
  } catch (e) { /* first run, or the file was removed */ }

  const crypto = require('crypto');
  const secrets = {
    jwtSecret: crypto.randomBytes(48).toString('hex'),
    sessionSecret: crypto.randomBytes(48).toString('hex'),
    // AES-256-CBC wants a 32 byte key and a 16 byte IV. The shipped defaults
    // were an 18 character word and a 12 character one - the IV was not even a
    // legal length, so something downstream must have been padding it.
    encryptionKey: crypto.randomBytes(16).toString('hex'),
    encryptionIv: crypto.randomBytes(8).toString('hex'),
    kioskKey: crypto.randomBytes(32).toString('hex'),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  } catch (e) {
    // Not fatal, but worth saying: regenerating these on every launch signs
    // every device out each time the app restarts.
    console.warn('[secrets] could not persist local secrets:', e.message);
  }
  return secrets;
}

function startServer() {
  // process.env.PORT already holds the port resolveLocalPorts derived and wrote
  // to .ports.json. It used to be overwritten here with a constant captured at
  // module load, which is how a build that advertised 42590 served 5555.

  // The setup endpoint checks these; without them it refuses every request,
  // including the wizard's own.
  const installCreds = getInstallCredentials();
  process.env.POSNIC_KEY = installCreds.key;
  process.env.POSNIC_SECRET = installCreds.secret;

  /*
   * Hand this machine's own secrets to the API before it reads its config.
   *
   * Set here rather than shipped in the source, so no two installations share
   * a signing key and reading the published repository reveals nothing about
   * any running till.
   */
  const localSecrets = getLocalSecrets();
  process.env.JWT_SECRET = localSecrets.jwtSecret;
  process.env.SESSION_SECRET = localSecrets.sessionSecret;
  process.env.ENCRYPTION_KEY = localSecrets.encryptionKey;
  process.env.ENCRYPTION_IV = localSecrets.encryptionIv;
  process.env.KIOSK_API_KEY = localSecrets.kioskKey;

  /*
   * The PIN lock, tied to this machine.
   *
   * The install secret goes into the key derivation, so the encrypted session
   * blob carried to another computer decrypts to nothing there even with the
   * right PIN.
   */
  /* rawIpcMain, not the guarded one: pin-lock-ipc.js wraps what it is given,
     and wrapping a wrapper would only validate the same frame twice. */
  require('./pin-lock-ipc').registerPinLockIPC(rawIpcMain, app, localSecrets.encryptionKey);

  // Where the API looks for this shop's white-label logo and name. Seeded
  // before the API reads it, so the very first page load is already branded.
  seedBrandFromBuild();
  process.env.POSNIC_BRAND_DIR = BRAND_DIR;

  /*
   * Record urgent sync work as it happens.
   *
   * When a sale changes stock the API writes a marker into a local collection,
   * so the agent can push that row within seconds instead of waiting for its
   * lane timer - 15 seconds for the sale, 60 for the item whose quantity
   * changed. See api/src/sync/outbox.js.
   *
   * Set here because this process is a till. The same API code also runs in the
   * cloud serving many shops from one process, where there is nobody to upload
   * to and the markers would be noise - that side is already refused by
   * multi-tenant mode, so this is the second of two independent reasons it
   * stays off there.
   *
   * Left overridable so support can switch it off on one machine without
   * waiting for an installer. Turning it off costs only speed: the periodic
   * scan still finds every change, which is exactly how every till works today.
   */
  process.env.SYNC_OUTBOX_ENABLED = process.env.SYNC_OUTBOX_ENABLED || 'true';

  /*
   * Runtime identity for the in-process API (GET /api/runtime-info): this
   * process IS the desktop shell, and the version users and the updater see is
   * the root app version - the api's own package version is meaningless here.
   */
  process.env.POSNIC_DESKTOP = '1';
  process.env.POSNIC_APP_VERSION = app.getVersion();

  /*
   * Decide which frontend to serve, before the API starts serving it.
   *
   * beginBoot counts this start. A version that has already failed to reach a
   * working state twice is put back here, before any of its code runs - which
   * is the only recovery a shop staring at a blank till actually has, because
   * there is nothing on the screen for them to click.
   *
   * With no update ever applied, activeDir() is the directory that shipped in
   * the installer and this changes nothing.
   */
  try {
    // A fresh installer's baseline must never be shadowed by assets staged
    // from an older release (asset-channel.js explains the ordering).
    const { reconcileWithInstaller } = require('./asset-channel');
    reconcileWithInstaller(assetUpdater, app.getVersion(), console.log);

    const boot = assetUpdater.beginBoot();
    if (boot.reverted) {
      console.warn(`[assets] ${boot.from} would not start - reverted to `
        + (boot.to || 'the installed version'));
    }
    process.env.POSNIC_ASSET_DIR = assetUpdater.activeDir() || '';
  } catch (err) {
    // Never let the update mechanism be the reason a till will not open.
    console.error('[assets] boot check failed, serving installed assets:', err.message);
    process.env.POSNIC_ASSET_DIR = '';
  }
  console.log('Starting api Node.js Server...');
  console.log('MongoDB URI: ' + (process.env.MONGODB_URI || '(not set)'));
  console.log('Connecting to local database...\n');

  // Determine correct path to server.js (now in extraResources)
  let serverPath;
  if (app.isPackaged) {
    // server.js stays outside ASAR; api dependencies use a dedicated archive.
    serverPath = path.join(process.resourcesPath, 'server.js');
    console.log('Loading server from extraResources:', serverPath);

    if (!require('fs').existsSync(serverPath)) {
      console.error('ERROR: server.js not found at:', serverPath);
      console.error('Trying fallback locations...');
      const candidates = [
        path.join(process.resourcesPath, 'app', 'server.js'),
        path.join(process.resourcesPath, 'app.asar', 'server.js'),
        path.join(__dirname, 'server.js')
      ];
      serverPath = candidates.find(p => require('fs').existsSync(p)) || serverPath;
      console.log('Using fallback:', serverPath);
    }
  } else {
    // In dev mode, use relative path
    serverPath = './server';
  }

  // Server startup is now async due to MongoDB setup
  const startServerFn = require(serverPath);
  startServerFn({
    onProgress: ({ stage, text, details, progress }) => {
      if (stage === 'timing' && details) {
        if (details.name === 'apiModulesLoaded') {
          startupPerformance.apiModulesMs = details.durationMs;
          updateHealthStatus({
            api: 'loading-modules',
            apiModulesMs: details.durationMs
          });
        } else if (details.name === 'databaseConnected') {
          startupPerformance.databaseConnectMs = details.durationMs;
          updateHealthStatus({
            database: 'ready',
            databaseConnectMs: details.durationMs
          });
        }
        return;
      }
      if (stage === 'database-health-result' && details) {
        updateHealthStatus({ databaseHealth: details });
        updateStartupStatus(
          stage,
          text,
          details.status === 'healthy'
            ? 'Connection, indexes and settings verified'
            : `${details.warnings.length} warning(s), ${details.errors.length} error(s)`,
          progress
        );
        return;
      }
      updateStartupStatus(stage, text, details, progress);
    }
  }).then(async (result) => {
    if (result && result.success) {
      if (!shutdownInProgress) {
      }
      updateHealthStatus({
        api: 'ready',
        apiReadyAt: new Date().toISOString()
      });

      /*
       * This version works. Clear its strikes.
       *
       * Recorded here rather than when the window opens, because a version
       * that paints a blank screen and then dies would otherwise clear its own
       * record and never be abandoned. The API answering means the app got far
       * enough to actually be a till.
       */
      try { assetUpdater.markHealthy(); } catch (e) { /* not fatal */ }

      /*
       * Silent asset updates between installer releases (asset-channel.js):
       * checked shortly after a healthy boot and daily after that, staged in
       * the background, live on the next launch. Packaged builds only - dev
       * trees serve their own working copy.
       */
      if (app.isPackaged) {
        const runAssetCheck = () => {
          try {
            const { checkAndApply } = require('./asset-channel');
            checkAndApply({
              assetUpdater,
              appVersion: app.getVersion(),
              sevenZipPath: path.join(
                process.resourcesPath,
                'tools',
                process.platform === 'win32' ? '7za.exe' : '7za',
              ),
              log: console.log,
            }).then((r) => {
              if (r.applied) {
                BrowserWindow.getAllWindows().forEach((w) => {
                  if (!w.isDestroyed()) w.webContents.send('update:assets-ready', { version: r.version });
                });
              }
            }).catch((e) => console.warn('[assets] check failed:', e.message));
          } catch (e) {
            console.warn('[assets] check could not start:', e.message);
          }
        };
        setTimeout(runAssetCheck, 2 * 60 * 1000);
        setInterval(runAssetCheck, 24 * 60 * 60 * 1000);
      }

      /*
       * Connector runtime (I5): signed sidecar integrations. Inert until a
       * connector is installed AND the shop enabled it - which today is
       * nobody; the runtime ships ahead of its first connector so the
       * trust chain is proven before anything rides it.
       */
      try {
        const { ConnectorSupervisor } = require('./connector-runtime');
        const resourcesRoot = app.isPackaged ? process.resourcesPath : __dirname;
        const connectorKeyFile = path.join(resourcesRoot, 'asset-signing-key.pub');
        connectorSupervisor = new ConnectorSupervisor({
          root: path.join(app.getPath('userData'), 'connector-runtime'),
          publicKey: fs.existsSync(connectorKeyFile)
            ? fs.readFileSync(connectorKeyFile, 'utf8')
            : null,
          apiPort: () => apiPort(),
          appVersion: app.getVersion(),
          log: (m) => console.log(m),
        });
        const sevenZip = path.join(
          resourcesRoot, 'tools', process.platform === 'win32' ? '7za.exe' : '7za'
        );
        const { extractZip, loadTree } = require('./asset-channel');
        const adopt = fs.existsSync(sevenZip)
          ? { extract: (zip, dest) => extractZip(sevenZip, zip, dest), loadTree: (d) => loadTree(d, d) }
          : {};
        if (!fs.existsSync(path.join(app.getPath('userData'), '.setup-review'))) Promise.resolve(connectorSupervisor.startAll(adopt)).catch((e) =>
          console.warn('[connectors] failed to start:', e.message)
        );
      } catch (connErr) {
        console.warn('[connectors] runtime unavailable:', connErr.message);
      }
      // Check if installation wizard is needed
      if (result.needsWizard) {
        console.log('\n First time setup - showing installation wizard...\n');
        await redirectToWizard();
      } else {
        updateStartupStatus('ready', 'Loading Interface...', 'Preparing login screen', 95);
        if (fs.existsSync(path.join(app.getPath('userData'), '.setup-review'))) {
          setupExistingShop = true;
          await redirectToWizard();
        } else await redirectToLogin();
      }
      if (result.databaseHealth && result.databaseHealth.status !== 'healthy') {
        const health = result.databaseHealth;
        const lines = [
          ...health.errors.map((entry) => `Error: ${entry}`),
          ...health.warnings.map((entry) => `Warning: ${entry}`),
          ...health.repairs.filter((entry) => entry.repaired).map((entry) => `Repaired: ${entry.repaired} ${entry.type}`),
        ];
        const summary = lines.slice(0, 8).join('\n');

        // Some findings (legacy duplicate bill numbers, for instance) are real
        // but not actionable day to day. Once the shop has dismissed a given
        // set of findings, stay quiet unless something new appears. Errors are
        // never silenced.
        const fingerprint = health.findingFingerprint || crypto.createHash('sha1')
          .update(lines.slice().sort().join('|')).digest('hex');
        const dismissed = health.errors.length ? [] : (readHealthDismissals() || []);
        if (!dismissed.includes(fingerprint)) {
          const buttons = health.errors.length
            ? ['OK', 'Open Diagnostic File']
            : ['OK', 'Open Diagnostic File', "Don't show this again"];
          const response = await dialog.showMessageBox(mainWindow, {
            type: health.errors.length ? 'error' : 'warning',
            title: 'Database Health Diagnostic',
            message: health.errors.length ? 'Database requires attention' : 'Database check completed with warnings',
            detail: `${summary}\n\nFull diagnostic: ${HEALTH_FILE}`,
            buttons,
            defaultId: 0,
            cancelId: 0,
          });
          if (response.response === 1) shell.showItemInFolder(HEALTH_FILE);
          if (response.response === 2) {
            writeHealthDismissals([...dismissed, fingerprint]);
            console.log('[Health] findings dismissed; new problems will still be reported');
          }
        } else {
          console.log('[Health] known findings, dialog suppressed:', fingerprint.slice(0, 8));
        }
      }
    } else {
      updateHealthStatus({
        status: 'error',
        api: 'failed',
        lastError: 'API server failed to start'
      });
      console.error(' Server failed to start - MongoDB not available');
      if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.loadFile(path.join(__dirname, 'loading.html'), {
          query: { startupError: 'Posnic could not start its local database', details: 'Posnic includes its own database. Your data has not been removed. Open Log for details or restart Posnic to try again.' }
        }).catch(error => console.error('Could not display startup recovery:', error));
      }
    }
  }).catch((error) => {
    if (isExpectedNavigationAbort(error)) {
      console.log('[Main] Expected page redirect completed');
      return;
    }
    updateHealthStatus({
      status: 'error',
      api: 'failed',
      lastError: {
        name: error.name,
        message: error.message,
        code: error.code
      }
    });
    console.error('Failed to start server:', error);
    console.error('Error stack:', error.stack);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.loadFile(path.join(__dirname, 'loading.html'), {
        query: { startupError: 'Posnic could not start', details: String(error.message || error) }
      }).catch(loadError => console.error('Could not display startup recovery:', loadError));
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('child-process-gone', (_event, details) => {
  console.error('[Electron] Child process gone:', details);
  crashLog.append('child-process-gone', null, details);
});

app.on('before-quit', async event => {
  if (shutdownInProgress) return;

  event.preventDefault();
  shutdownInProgress = true;

  /*
   * Say something, because this takes a while.
   *
   * Stopping the API and closing mongod cleanly is the better part of a
   * minute. Restart was the worst of it: the window vanished, nothing happened
   * for thirty or forty seconds, and then the till came back - which reads as a
   * crash, and invites clicking the icon again in the middle of it.
   *
   * The main window is already going, so this is its own small window. It dies
   * with the process, so nothing has to remember to close it.
   */
  /* Asked before the shutdown runs, because prepareQuitInstall is what clears
     it - by the time the installer is actually handed control this would
     answer false and the screen would have said the wrong thing for the whole
     of the wait. */
  const installingOnQuit = !!(updateService && updateService.shouldInstallOnQuit());

  /*
   * Closing shows nothing. Restarting and updating show everything.
   *
   * They are different acts. Somebody closing the till has finished with it and
   * wants it gone - a window that hangs around afterwards saying "closing down
   * safely" is asking them to watch a progress bar for something they have
   * already stopped caring about. The work still has to finish, but it can
   * finish out of sight; the windows are gone, the taskbar entry is gone, and
   * the process exits when mongod has closed its files.
   *
   * Restarting is the opposite. The till is expected back, and between the
   * window going and the window returning there is half a minute of nothing.
   * That is when people conclude it has crashed and start clicking, so that is
   * where the screen and the step-by-step progress go.
   *
   * Updating always shows, whichever way it was triggered. Replacing the
   * application is the one thing here where turning the machine off at the
   * wrong moment does real damage, so it says so.
   *
   * Nothing is silent about the *work*: the shutdown is identical either way,
   * and the marker below is written either way. Only the window differs.
   */
  const showProgress = relaunchAfterQuit || installingOnQuit;

  try {
    if (showProgress) {
      showShutdown(require('electron'), {
        restarting: relaunchAfterQuit,
        updating: installingOnQuit
      });
    } else {
      /*
       * Take the windows away now, so closing feels like closing.
       *
       * Without this the main window lingers, unresponsive, for as long as the
       * database takes - which is the thing that gets a till force-quit
       * mid-checkpoint.
       */
      hideAllWindowsForQuit();
    }
  } catch (e) { /* never let this stop the shutdown */ }

  /*
   * Leave a note for the next launch, whether or not anything is on screen.
   *
   * This is what stops the icon looking broken. The lock is held until this
   * process actually exits, so a double-click during the wait would otherwise
   * open nothing and say nothing.
   */
  try {
    shutdownState.begin(app.getPath('userData'));
  } catch (e) { /* the launch simply behaves as it did before */ }

  const forceExitTimer = setTimeout(() => {
    console.error('[Shutdown] Total shutdown timeout reached - forcing exit', {
      timeoutMs: SHUTDOWN_TIMEOUTS.total
    });
    flushRepeatedWarningSummaries();
    /* The note has to go even on the way out badly. findInProgress would
       eventually discard it anyway once it saw the pid was gone, but a pid the
       operating system has since reused would read as alive and make the next
       launch wait forty-five seconds for a process that is not Posnic. */
    try { shutdownState.clear(app.getPath('userData')); } catch (e) { /* best effort */ }
    app.exit(0);
  }, SHUTDOWN_TIMEOUTS.total);

  /*
   * If an update is downloaded and waiting, this is the moment to apply it.
   *
   * The order matters and is the whole reason this is not left to
   * electron-updater's autoInstallOnAppQuit. The pre-update backup has to run
   * while the database is still up; the shutdown below stops it. Doing this
   * afterwards would produce a backup that fails, or - worse - one that looks
   * like it worked and holds nothing.
   *
   * A failed backup cancels the update rather than the shutdown. The shop keeps
   * the version it has and is asked again tomorrow, which is the safe
   * direction to fail in.
   */
  const installOnQuit = !nextProfile && updateService && updateService.shouldInstallOnQuit();
  const readyToInstall = installOnQuit
    ? (async () => {
        const prepared = await updateService.prepareQuitInstall();
        if (!prepared.ok) {
          console.warn('[Shutdown] Update not applied this time:', prepared.error);
        }
        return prepared.ok;
      })()
    : Promise.resolve(false);

  readyToInstall
    .catch(() => false)
    .then((install) =>
      performGracefulShutdown(
        showProgress
          ? (done, total, says) => setShutdownProgress(done, total, says)
          : null,
      )
        .catch(error => {
          console.error('[Shutdown] Unexpected shutdown coordinator error', error);
        })
        .finally(() => {
          clearTimeout(forceExitTimer);
          flushRepeatedWarningSummaries();

          /* The work is done, so the note goes. A launch from here on is a
             normal cold start, not a wait. */
          try { shutdownState.clear(app.getPath('userData')); } catch (e) { /* best effort */ }

          /* Hand over to the installer as the last thing this process does.
             Silent and without relaunching - the shop closed the application,
             so it stays closed and opens next time on the new version. */
          if (install) {
            const handed = updateService.finishQuitInstall();
            if (handed.ok) return; // quitAndInstall ends the process itself
          }
          /*
           * Restarting takes the long way round on purpose.
           *
           * app.exit() does not emit 'quit', and Electron spawns the replacement process
           * from that event - so relaunching through app.exit() closes the till and
           * starts nothing. Quitting again instead re-enters this handler, which returns
           * early because shutdownInProgress is set, and the quit then proceeds normally
           * with the relaunch armed. Everything is already stopped by this point, so the
           * second pass has nothing left to do.
           */
          if (relaunchAfterQuit) {
              if (nextProfile) {
                profiles.activate(nextProfile);
                for (const name of ['MONGODB_URI', 'POSNIC_SYNC_PAIRED', 'POSNIC_EXTENSIONS_ROOT', 'POSNIC_KEY', 'POSNIC_SECRET',
                  'JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_IV', 'KIOSK_API_KEY', 'POSNIC_BRAND_DIR', 'POSNIC_ASSET_DIR',
                  'POSNIC_UPLOADS_DIR', 'FILE_UPLOAD_PATH']) delete process.env[name];
              }
              console.log('[Shutdown] Restarting');
              app.relaunch();
              app.quit();
              return;
          }
          app.exit(0);
        })
    );
  /*
   * Legacy shutdown sequence retained only as historical context.
   * The timeout-bounded coordinator above replaces it.

  // Stop backup scheduler
  if (backupManager) {
    backupManager.stopScheduler();
    console.log('✅ Backup scheduler stopped');
  }

  // Stop API server
  if (global.apiServer) {
    global.apiServer.close(() => {
      console.log('✅ API server stopped');
    });
  }

  // Close mongoose connection
  if (global.mongooseConnection) {
    await global.mongooseConnection.close();
    console.log('✅ MongoDB connection closed');
  }

  // Stop bundled MongoDB if running
  if (mongoDBManager) {
    await mongoDBManager.stop();
  }

  // Stop any other servers
  stopServers();
  */
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

/*
 * The 'open-hardware-manager' channel was here, with a comment saying it was
 * for opening the window from a renderer. No renderer could send it: preload.js
 * never exposed it, and context isolation means a page has no ipcRenderer of
 * its own. It was a door with no handle on the outside.
 *
 * Nothing was lost by removing it. The Hardware Manager is reachable from the
 * application menu, from the settings deep-link target, and from the tray, all
 * of which call openHardwareManager() directly.
 *
 * tests/every-handler-has-a-door.test.js now refuses a handler nothing can
 * reach, because "it exists but nobody can call it" is how a switch and the
 * sold-out endpoint both sat finished and unusable.
 */
