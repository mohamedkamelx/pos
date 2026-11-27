const { contextBridge, ipcRenderer } = require('electron');
// Capture failure metadata, never event arguments, DOM content or request bodies.
window.addEventListener('error', event => {
  ipcRenderer.invoke('diagnostics:event', 'renderer', { stage: 'javascript-error', status: 'error', message: event.message }).catch(() => {});
});
window.addEventListener('unhandledrejection', event => {
  ipcRenderer.invoke('diagnostics:event', 'renderer', { stage: 'unhandled-rejection', status: 'error', message: event.reason?.message || 'Unhandled renderer rejection' }).catch(() => {});
});

// Expose hardware and printer APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  diagnostics: {
    state: () => ipcRenderer.invoke('diagnostics:state'),
    start: () => ipcRenderer.invoke('diagnostics:start'),
    stop: () => ipcRenderer.invoke('diagnostics:stop'),
    capture: value => ipcRenderer.invoke('diagnostics:capture', value),
    snapshot: () => ipcRenderer.invoke('diagnostics:snapshot'),
    report: () => ipcRenderer.invoke('diagnostics:report'),
    preview: () => ipcRenderer.invoke('diagnostics:preview'),
    export: () => ipcRenderer.invoke('diagnostics:export'),
    connect: value => ipcRenderer.invoke('diagnostics:connect', value),
    upload: () => ipcRenderer.invoke('diagnostics:upload'),
    event: (type, fields) => ipcRenderer.invoke('diagnostics:event', type, fields),
  },
  /*
   * Which operating system this is.
   *
   * The pages had no way to ask, so they assumed. The hardware screen offered
   * "Windows default printer" on a Mac, and warned that a receipt could not be
   * sent to "the Windows default" - naming a thing that does not exist there,
   * which makes a shop wonder what else the software has misunderstood about
   * their machine.
   *
   * A plain string rather than a boolean, so a page can say the right word for
   * each of the three rather than "Windows or not".
   */
  platform: process.platform,          // 'win32' | 'darwin' | 'linux'

  startup: {
    retry:   () => ipcRenderer.invoke('startup:retry'),
    openLog: () => ipcRenderer.invoke('startup:open-log')
  },
  // The setup wizard needs this machine's own install key: the API refuses
  // /api/install/* without one, and it is generated per installation rather
  // than shipped in the source.
  install: {
    currentShop: () => ipcRenderer.invoke('shops:current'),
    manageShops: () => ipcRenderer.invoke('shops:manage'),
    shops: () => ipcRenderer.invoke('shops:list'),
    openShop: id => ipcRenderer.invoke('shops:open', id),
    credentials: () => ipcRenderer.invoke('install:credentials'),
    state: () => ipcRenderer.invoke('install:state'),
    continueExisting: () => ipcRenderer.invoke('install:continue'),
    startFresh: (options) => ipcRenderer.invoke('install:fresh', options)
  },
  desktop: {
    open:         (target) => ipcRenderer.invoke('desktop:open', target),
    capabilities: () => ipcRenderer.invoke('desktop:capabilities'),
    getBehaviour: () => ipcRenderer.invoke('desktop:behaviour-get'),
    saveBehaviour: (patch) => ipcRenderer.invoke('desktop:behaviour-save', patch),
    onNavigate: (callback) => {
      const handler = (_event, section) => callback(section);
      ipcRenderer.on('desktop:navigate', handler);
      return () => ipcRenderer.removeListener('desktop:navigate', handler);
    }
  },
  /* The log viewer reads the file through the main process rather than a
     file:// URL, so the page keeps the same sandbox as every other window. */
  logs: {
    read:   () => ipcRenderer.invoke('logs:read'),
    reveal: () => ipcRenderer.invoke('logs:reveal')
  },
  /* Contact support from inside the till. context() gathers what the machine
     can say about itself so the shop can copy one complete report. */
  support: {
    context:   () => ipcRenderer.invoke('support:context')
  },
  tray: {
    setBranches: (data) => ipcRenderer.invoke('tray:set-branches', data),
    onSwitchBranch: (callback) => ipcRenderer.on('tray:switch-branch', (_e, id) => callback(id))
  },
  hardware: {
    scanSerialPorts: (enableSimulation) => ipcRenderer.invoke('hardware:scan-ports', enableSimulation),
    connectPort: (portPath, isMock) => ipcRenderer.invoke('hardware:connect-port', portPath, isMock),
    disconnectPort: () => ipcRenderer.invoke('hardware:disconnect-port'),
    getStatus: () => ipcRenderer.invoke('hardware:get-status'),
    broadcastWeight: () => ipcRenderer.invoke('hardware:broadcast-weight'),
    onScaleRaw: (callback) => {
      const handler = (event, raw) => callback(raw);
      ipcRenderer.on('scale-raw', handler);
      return () => ipcRenderer.removeListener('scale-raw', handler);
    },
    // Returns an unsubscribe function: a page that asks for one weight must be
    // able to stop listening, or every reading piles up another handler.
    onUsbData: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('usb-data', handler);
      return () => ipcRenderer.removeListener('usb-data', handler);
    },
    // Essae network scale (TCP/IP)
    essae: {
      connect: (options) => ipcRenderer.invoke('essae:connect', options),
      disconnect: () => ipcRenderer.invoke('essae:disconnect'),
      status: () => ipcRenderer.invoke('essae:status'),
      saveConfig: (options) => ipcRenderer.invoke('essae:save-config', options),
    },
    onPortError: (callback) => {
      const handler = (event, error) => callback(error);
      ipcRenderer.on('port-error', handler);
      return () => ipcRenderer.removeListener('port-error', handler);
    }
  },
  printer: {
    recoveryStatus: () => ipcRenderer.invoke('printer:recovery-status'),
    recoverUnsubmitted: (id) => ipcRenderer.invoke('printer:recover-unsubmitted', id),
    configureRecovery: (printer, binding) => ipcRenderer.invoke('printer:recovery-configure', printer, binding),
    onJobStatus: callback => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('printer:job-status', handler);
      return () => ipcRenderer.removeListener('printer:job-status', handler);
    },
    list:       () => ipcRenderer.invoke('printer:list'),
    getDefault: () => ipcRenderer.invoke('printer:get-default'),
    getPaperSizes: () => ipcRenderer.invoke('printer:get-paper-sizes'),
    setDefault: (name) => ipcRenderer.invoke('printer:set-default', name),
    print:      (htmlContent, options) => ipcRenderer.invoke('printer:print', htmlContent, options),
    printPdf:   (bytes, kind, paperSize) => ipcRenderer.invoke('printer:print-pdf', bytes, kind, paperSize),
    getDocumentSettings: () => ipcRenderer.invoke('printer:get-document-settings'),
    saveDocumentSettings: (settings) => ipcRenderer.invoke('printer:save-document-settings', settings),
    // Receipts go as ESC/POS on the desktop: no page, no scaling, no driver
    // rendering. The browser keeps using print() above.
    printReceipt: (sale, options) => ipcRenderer.invoke('printer:print-receipt', sale, options),
    previewReceipt: (sale, options) => ipcRenderer.invoke('printer:preview-receipt', sale, options),
    // Roll reports declare their sections; sheet PDFs use printPdf above.
    printReport: (doc, options) => ipcRenderer.invoke('printer:print-report', doc, options)
  },
  /*
   * The PIN lock. Everything about the PIN - the encrypted session, the key
   * derivation, the attempt limit - stays in the main process; a page can ask
   * to unlock and is given a session or refused, never anything it could use
   * to guess faster.
   */
  lock: {
    users:      () => ipcRenderer.invoke('lock:users'),
    isEnrolled: (username) => ipcRenderer.invoke('lock:is-enrolled', username),
    enroll:     (details) => ipcRenderer.invoke('lock:enroll', details),
    unlock:     (details) => ipcRenderer.invoke('lock:unlock', details),
    forget:     (username) => ipcRenderer.invoke('lock:forget', username),
    forgetAll:  () => ipcRenderer.invoke('lock:forget-all'),

    /*
     * The main process asking the page to lock.
     *
     * Needed because closing the window hides it to the tray rather than
     * quitting: the page is never reloaded, so nothing that runs on load can
     * notice. Without this, pressing X looked like putting the till away and
     * anybody could bring it back from the tray untouched.
     */
    onLockRequest: (handler) => ipcRenderer.on('lock:now', () => handler())
  },
  /*
   * Telling the window what colour the app just became.
   *
   * The title bar is drawn by Windows before any of this runs, so it has to be
   * told rather than asked. Colours only - nothing here can move, resize or
   * close the window.
   */
  theme: {
    setChrome: (theme) => ipcRenderer.invoke('theme:chrome', theme),
    /* The palette the app is wearing, for the settings windows, which have
       their own stylesheets and cannot see the app's. */
    palette: () => ipcRenderer.invoke('theme:palette'),
    onChange: (callback) => {
      const handler = (_event, palette) => callback(palette);
      ipcRenderer.on('theme:changed', handler);
      return () => ipcRenderer.removeListener('theme:changed', handler);
    },
  },
  /*
   * The title bar's own buttons.
   *
   * The page draws minimise, maximise and close itself so the strip is one
   * surface in one colour; these are the only three things it needs to be able
   * to do to the window, and nothing here can move or resize it arbitrarily.
   */
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close:    () => ipcRenderer.invoke('window:close'),
    // So the title bar can draw "restore" rather than "maximise" once the
    // window is maximised, the way every other application on the machine does.
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (handler) => {
      const h = (_e, maximized) => handler(maximized);
      ipcRenderer.on('window:maximize-changed', h);
      return () => ipcRenderer.removeListener('window:maximize-changed', h);
    }
  },
  preferences: {
    get: (key) => ipcRenderer.invoke('preferences:get', key),
    set: (key, value) => ipcRenderer.invoke('preferences:set', key, value)
  },
  /*
   * AI assistant. The key, the Groq requests and the chat-history bound stay
   * in the main process; the renderer only gets a status, a save/clear result,
   * a transcript and a reply.
   */
  ai: {
    setEnabled: (enabled) => ipcRenderer.invoke('ai:set-enabled', !!enabled),
    keyStatus: () => ipcRenderer.invoke('ai:key-status'),
    validateKey: (key) => ipcRenderer.invoke('ai:validate-key', key),
    saveKey: (key) => ipcRenderer.invoke('ai:save-key', key),
    clearKey: () => ipcRenderer.invoke('ai:clear-key'),
    transcribe: (payload) => ipcRenderer.invoke('ai:transcribe', payload),
    chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
    validateProviderKey: (provider, key) => ipcRenderer.invoke('ai:validate-provider-key', { provider, key }),
    saveProviderKey: (provider, key, options) => ipcRenderer.invoke('ai:save-provider-key', {
      provider,
      key,
      ...(options && typeof options === 'object'
        ? options
        : (typeof options === 'number'
          ? { index: options }
          : (options ? { index: 1 } : {}))),
    }),
    clearProviderKey: (provider, options) => ipcRenderer.invoke('ai:clear-provider-key', {
      provider,
      ...(options && typeof options === 'object'
        ? options
        : (typeof options === 'number'
          ? { index: options }
          : (options ? { index: 1 } : {}))),
    }),
    setActiveProviderKey: (provider, index) => ipcRenderer.invoke('ai:set-active-provider-key', { provider, index }),
    setProviderModel: (provider, model) => ipcRenderer.invoke('ai:set-provider-model', { provider, model }),
    setReasoning: (reasoning) => ipcRenderer.invoke('ai:set-reasoning', { reasoning }),
    resetChat: (payload) => ipcRenderer.invoke('ai:reset-chat', payload),
    attach: (payload) => ipcRenderer.invoke('ai:attach', payload),
    removeAttachment: (payload) => ipcRenderer.invoke('ai:remove-attachment', payload),
    confirmPlan: (payload) => ipcRenderer.invoke('ai:confirm-plan', payload),
    cancelPlan: (payload) => ipcRenderer.invoke('ai:cancel-plan', payload),
    onPlanProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('ai:plan-progress', handler);
      return () => ipcRenderer.removeListener('ai:plan-progress', handler);
    },
    onChatProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('ai:chat-progress', handler);
      return () => ipcRenderer.removeListener('ai:chat-progress', handler);
    }
  },
  connectors: {
    status:  () => ipcRenderer.invoke('connectors:status'),
    enable:  (name, token, settings) => ipcRenderer.invoke('connectors:enable', { name, token, settings }),
    disable: (name) => ipcRenderer.invoke('connectors:disable', { name })
  },
  cashDrawer: {
    loadConfig:     () => ipcRenderer.invoke('cashDrawer:load-config'),
    saveConfig:     (config) => ipcRenderer.invoke('cashDrawer:save-config', config),
    openViaPrinter: (printerName, pin) => ipcRenderer.invoke('cashDrawer:open-via-printer', printerName, pin)
  },
  /*
   * The receipt printing key and log, for the Hardware Manager screen.
   */
  bill: {
    /* This machine's own key, for pasting into the shop so it will accept
       receipt jobs from here. See api/src/models/print-till.model.js. */
    /* A day of receipt prints, tried as well as done. */
    getReceiptLogs: (date) => ipcRenderer.invoke('receipt:get-logs', date),
    deleteReceiptLog: (date, id) => ipcRenderer.invoke('receipt:delete-log', date, id)
  },
});

// Expose navigation API for install wizard + backup APIs
contextBridge.exposeInMainWorld('electron', {
  loadPage: (page) => ipcRenderer.send('load-page', page),
  getApiPort: () => ipcRenderer.invoke('get-api-port'),

  // Backup-related APIs
  getDefaultBackupPath: () => ipcRenderer.invoke('backup:get-default-path'),
  browseBackupFolder: () => ipcRenderer.invoke('backup:browse-folder'),
  saveBackupConfig: (config) => ipcRenderer.invoke('backup:save-config', config),
  getBackupConfig: () => ipcRenderer.invoke('backup:get-config'),
  runBackupNow: (force) => ipcRenderer.invoke('backup:run-now', force),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  restoreBackup: (folderPath, options) => ipcRenderer.invoke('backup:restore', folderPath, options),
  deleteBackup: (folderPath) => ipcRenderer.invoke('backup:delete', folderPath),
  getBackupHistory: () => ipcRenderer.invoke('backup:get-history'),
  // The operating-system scheduler commands, with this machine's real paths in
  // them. Backups only run while Posnic is open; this is how a shop that closes
  // the till every evening still gets an overnight one.
  getScheduleInstructions: (options) => ipcRenderer.invoke('backup:schedule-instructions', options),

  // Subscribe to scheduled backup events
  onBackupResult: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on('backup:result', handler);
    return () => ipcRenderer.removeListener('backup:result', handler);
  },

  // Update-related APIs (electron-updater based)
  update: {
    getStatus:  () => ipcRenderer.invoke('update:get-status'),
    check:      () => ipcRenderer.invoke('update:check'),
    download:   () => ipcRenderer.invoke('update:download'),
    install:    () => ipcRenderer.invoke('update:install'),
    getConfig:  () => ipcRenderer.invoke('update:config-get'),
    saveConfig: (patch) => ipcRenderer.invoke('update:config-save', patch),
    // No token bridge. Releases are public, and a point of sale should never
    // be asking a shopkeeper for a GitHub credential. See update-service.js.
    // Going back to the previous version: a pointer move and a restart, so it
    // works on a machine that cannot reach the network.
    revertStatus: () => ipcRenderer.invoke('update:revert-status'),
    revert:       () => ipcRenderer.invoke('update:revert'),

    onStatus: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:status', h);
      return () => ipcRenderer.removeListener('update:status', h);
    },
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:progress', h);
      return () => ipcRenderer.removeListener('update:progress', h);
    }
  }
});
