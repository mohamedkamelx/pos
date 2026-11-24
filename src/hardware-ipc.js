const { ipcMain: rawIpcMain, app, BrowserWindow } = require('electron');
/*
 * Every handler below is registered through the guard, which refuses a message
 * from any frame that is not one of this application's own pages. See
 * ipc-guard.js for what counts as one.
 */
const ipcMain = require('./ipc-guard').guard(rawIpcMain);
const fs = require('fs');
const path = require('path');
const { EssaeWeightReader, ESSAE_DEFAULTS } = require('./essae-weight-reader');

// Network scale settings live beside the other app data so a shop keeps its
// configuration across updates.
let _essaeReader = null;
function essaeConfigPath() {
  return path.join(app.getPath('userData'), 'essae-scale.json');
}
function loadEssaeConfig() {
  try { return { ...ESSAE_DEFAULTS, ...JSON.parse(fs.readFileSync(essaeConfigPath(), 'utf8')) }; }
  catch { return { ...ESSAE_DEFAULTS }; }
}
function saveEssaeConfig(config) {
  try { fs.writeFileSync(essaeConfigPath(), JSON.stringify(config, null, 2)); }
  catch (err) { console.warn('[EssaeScale] could not save config:', err.message); }
}
function getEssaeReader() {
  if (!_essaeReader) _essaeReader = new EssaeWeightReader(loadEssaeConfig());
  return _essaeReader;
}

let _ipcSetupDone = false;

// Hardware Manager IPC Handlers
function setupHardwareIPC(hardwareManager) {
  if (_ipcSetupDone) {
    console.log('Hardware IPC handlers already registered, skipping duplicate call');
    return;
  }
  _ipcSetupDone = true;

  // Serial Port Handlers
  ipcMain.handle('hardware:scan-ports', async (event, enableSimulation = false) => {
    return await hardwareManager.scanSerialPorts(enableSimulation);
  });

  ipcMain.handle('hardware:connect-port', async (event, portPath, isMock = false) => {
    return await hardwareManager.connectPort(portPath, isMock);
  });

  ipcMain.handle('hardware:disconnect-port', async () => {
    return await hardwareManager.disconnectPort();
  });

  ipcMain.handle('hardware:get-status', () => {
    return hardwareManager.getConnectionStatus();
  });

  ipcMain.handle('hardware:broadcast-weight', () => {
    hardwareManager.broadcastLastWeight();
    return { success: true };
  });

  // Essae network scale (TCP/IP). Settings persist so a shop configures its
  // scale once; defaults match the device's factory address.
  ipcMain.handle('essae:connect', async (event, options = {}) => {
    try {
      const reader = getEssaeReader();
      if (options && Object.keys(options).length) {
        reader.configure(options);
      }
      reader.start();
      // Recorded so the scale comes back on its own after a restart. Saved
      // whether or not options came with this call: connecting with the
      // address already stored is still a shop saying "use this scale".
      saveEssaeConfig({ ...reader.getConfig(), enabled: true });
      return { success: true, status: reader.status() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('essae:disconnect', () => {
    if (_essaeReader) _essaeReader.stop();
    // Stays off across restarts, or auto-start would undo the disconnect the
    // next time the app opened.
    saveEssaeConfig({ ...loadEssaeConfig(), enabled: false });
    return { success: true };
  });

  ipcMain.handle('essae:status', () => getEssaeReader().status());

  ipcMain.handle('essae:save-config', (event, options = {}) => {
    const config = getEssaeReader().configure(options);
    saveEssaeConfig(config);
    return { success: true, config };
  });

  // Printer Handlers
  ipcMain.handle('printer:recovery-status', async () => {
    const environment = await require('./printer-environment').status();
    const queue = hardwareManager.getWindowsPrintQueue();
    let systemSettings;
    if (queue) {
      try { systemSettings = await queue.transport.systemSettings(); }
      catch (_) { systemSettings = { guidance: ['Windows power settings could not be checked. Review Sleep, Hibernate and USB selective suspend manually in Power Options.'] }; }
    }
    return queue ? { supported: true, environment, systemSettings, helper: require('./raw-print-service').status(), bindings: queue.bindings,
      health: [...queue.health.values()].map(item => item.value), keepAlive: queue.keepAlive, jobs: queue.list() } : { supported: false, environment };
  });
  ipcMain.handle('printer:recover-unsubmitted', async (_event, id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return { success: false, error: 'Invalid recovery job' };
    const queue = hardwareManager.getWindowsPrintQueue();
    if (!queue) return { success: false, error: 'Windows only' };
    try { return await queue.recoverUnsubmitted(id); }
    catch (error) { return { success: false, error: error.message }; }
  });
  ipcMain.handle('printer:recovery-configure', async (_event, printer, binding) => {
    const queue = hardwareManager.getWindowsPrintQueue();
    if (!queue) return { success: false, error: 'Windows only' };
    if (!(await hardwareManager.listPrinters({ fresh: true })).some(item => item.name === printer)) return { success: false, error: 'Printer queue not found' };
    try {
      queue.configure(printer, binding || {});
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });
  /* Hardware Manager's chooser, and anything else asking a person to pick:
     always the real list, never a remembered one. */
  ipcMain.handle('printer:list', async () => {
    return await hardwareManager.listPrinters({ fresh: true });
  });

  ipcMain.handle('printer:get-default', async () => {
    return await hardwareManager.getDefaultPrinter();
  });

  /* The paper catalogue, so the screen offers exactly what the print layer
     can honour. Sent over IPC rather than copied into the HTML, because two
     lists drift and the one that drifts is the one nobody tests. */
  ipcMain.handle('printer:get-paper-sizes', () => {
    const { PAPER_SIZES, DEFAULT_PAGE_SIZE, MAX_COPIES } = require('./printer-targets');
    return {
      sizes: Object.entries(PAPER_SIZES).map(([key, v]) => ({ key, label: v.label, roll: v.roll })),
      defaultSize: DEFAULT_PAGE_SIZE,
      maxCopies: MAX_COPIES,
    };
  });

  ipcMain.handle('printer:get-config', async () => {
    const defaultPrinter = await hardwareManager.getDefaultPrinter();
    const paperSize = preferences['paper_size'] || '3inch';
    return {
      printerName: defaultPrinter ? defaultPrinter.name : '',
      paperSize: paperSize
    };
  });

  /*
   * Print a receipt as ESC/POS rather than as a page.
   *
   * The browser keeps printing HTML, because its print dialog scales the page
   * to fit and that has worked for years. A silent print has no dialog and no
   * scaling, so the desktop app builds the receipt as characters and control
   * codes instead - the printer's own language, where a line either fits in 48
   * columns or it does not, and that is decidable before anything reaches the
   * paper.
   */
  // Render the same bytes for the tender preview without contacting a printer,
  // opening the drawer, or recording a print job.
  ipcMain.handle('printer:preview-receipt', async (_event, sale, options = {}) => {
    const { COLUMNS } = require('./escpos-receipt');
    const { renderReceipt } = require('./escpos-unicode');
    const { parse } = require('./escpos-preview');
    const { resolvePictures } = require('./escpos-logo');
    const paperWidth = ['58', '80', '112'].includes(options.paperWidth) ? options.paperWidth : '80';
    const prepared = await resolvePictures(sale, paperWidth);
    return parse(await renderReceipt(prepared, {
      paperWidth,
      symbolGlyphs: options.symbolGlyphs !== false,
    }), COLUMNS[paperWidth]);
  });

  ipcMain.handle('printer:print-receipt', async (event, sale, options = {}) => {
    /*
     * Every receipt is written down, printed or not.
     *
     * A failed receipt used to leave no answer at all. When a customer says
     * their bill never came out there was no way to tell whether the till had
     * tried, which printer it went to, or what the printer said back.
     *
     * TRIED is the half that matters. A receipt that failed is the one
     * somebody is asking about, and a log of successes only is silent at
     * exactly the moment it is needed.
     */
    const startedAt = Date.now();
    const receiptLog = require('./receipt-log');
    try {
      const { renderReceipt } = require('./escpos-unicode');
      const { normalizeTargets, columnsFor } = require('./printer-targets');

      /*
       * One receipt can now go to several printers, each with its own paper and
       * its own number of copies - a counter roll and a duplicate for the file,
       * or a second copy to the back office.
       *
       * normalizeTargets accepts the old { printerName, paperWidth } this used
       * to take, so the sale screen keeps working untouched while the Hardware
       * Manager starts sending a printers[] list.
       */
      const targets = normalizeTargets(
        options.printers && options.printers.length
          ? { printers: options.printers }
          : { printerName: options.printerName, paperSize: options.paperWidth },
        options.paperWidth
      );

      /*
       * A LOGO THE PAGE WAS NOT ALLOWED TO READ.
       *
       * receipt-data.js prepares the logo in the page, where the image is
       * already decoded and it costs nothing. When the canvas is tainted -
       * a logo served from another origin without CORS headers - it hands
       * over `{ src }` instead of dots, because a page can never read those
       * pixels however it asks.
       *
       * Here there is no origin and no canvas, only Chromium's decoder, so
       * the picture the page was refused is simply a file. Resolved once per
       * paper width rather than per target: two 80mm printers want the same
       * bitmap, and fetching it twice is a second round trip for nothing.
       */
      const madeAlready = new Map();

      /**
       * One picture, for one paper width.
       *
       * `which` is the field on the sale: the logo at the top, or whatever
       * the shop put under the total. They differ in one way that matters -
       * a logo is a picture and is dithered, a QR is data and must be
       * thresholded or a scanner cannot read it back.
       */
      async function pictureDots(which, paperWidth, dither) {
        const asked = sale && sale[which];
        if (!asked || asked.data || !asked.src) return asked || null;

        const key = which + ":" + paperWidth;
        if (madeAlready.has(key)) return madeAlready.get(key);

        const { rasterFor } = require('./escpos-logo');
        const { nativeImage, net } = require('electron');
        const raster = await rasterFor(asked.src, paperWidth, {
          decode: (buf) => nativeImage.createFromBuffer(buf),
          readFile: (file) => require('fs').readFileSync(file),
          get: (url, limits) =>
            new Promise((done) => {
              /* Never rejects: a logo is decoration and a receipt is not. */
              let finished = false;
              const settle = (v) => {
                if (!finished) { finished = true; done(v); }
              };
              const timer = setTimeout(() => settle(null), limits.timeout);
              try {
                const req = net.request(url);
                const chunks = [];
                let size = 0;
                req.on('response', (res) => {
                  res.on('data', (c) => {
                    size += c.length;
                    if (size > limits.limit) { req.abort(); settle(null); return; }
                    chunks.push(c);
                  });
                  res.on('end', () => { clearTimeout(timer); settle(Buffer.concat(chunks)); });
                  res.on('error', () => { clearTimeout(timer); settle(null); });
                });
                req.on('error', () => { clearTimeout(timer); settle(null); });
                req.end();
              } catch (e) {
                clearTimeout(timer);
                settle(null);
              }
            }),
        }, { dither, maxRows: which === 'footerImage' ? 384 : 240 });
        if (!raster) {
          console.warn('[Print] the ' + which + ' could not be read here either, printing without it');
        }
        madeAlready.set(key, raster);
        return raster;
      }

      const requestId = options.jobId || 'receipt:' + require('crypto').createHash('sha256').update(JSON.stringify(sale || {})).digest('hex');
      const results = [];
      for (const target of targets) {
        /* Rendered per target: an 80mm roll is 48 columns and a 58mm roll is
           32, so the same bytes cannot serve both. Getting this wrong wraps the
           total onto its own line, which looks like a rounding bug on paper. */
        const paperWidth = columnsFor(target.pageSize) <= 32 ? '58' : columnsFor(target.pageSize) === 69 ? '112' : '80';
        /* eslint-disable-next-line no-await-in-loop -- one fetch, cached
           per paper width, and the loop is serial anyway. */
        const logo = await pictureDots('logo', paperWidth, true);
        /* eslint-disable-next-line no-await-in-loop -- cached per width. */
        const footerImage = await pictureDots('footerImage', paperWidth, false);
        const bytes = await renderReceipt({ ...(sale || {}), logo, footerImage }, {
          paperWidth,
          /* A printer that cannot be taught a glyph spells the currency
             instead. Per machine, like the printer name. */
          symbolGlyphs: options.symbolGlyphs !== false,
          /* The drawer opens once, on the first sheet. Pulsing it per copy
             would have it kick three times for a three-copy receipt. */
          openDrawer: !!options.openDrawer && results.length === 0,
          drawerPin: options.drawerPin,
          cut: options.cut !== false,
        });

        for (let copy = 0; copy < target.copies; copy += 1) {
          const label = (options.docName || 'Posnic Receipt')
            + (target.copies > 1 ? ` (${copy + 1}/${target.copies})` : '');
          /* eslint-disable-next-line no-await-in-loop -- printers are serial
             devices; two jobs sent at once interleave on the same roll. */
          const r = await hardwareManager.sendRawToPrinter(target.name, bytes, label, { jobId: requestId + ":" + targets.indexOf(target) + ":" + copy });
          results.push({ printer: target.name || '(default)', copy: copy + 1, sent: bytes.length, ...r });
        }
      }

      /* One failed printer must not report the whole receipt as failed when the
         customer already has their copy, so success means at least one landed
         and the failures are named for the operator. */
      const failed = results.filter((r) => !r.success);
      /*
       * How much actually went down the wire.
       *
       * Hardware Manager's test print says "Sent N bytes", and N came back
       * undefined from the day this handler learned to drive several printers:
       * the old single-printer version answered { success, bytes } and the
       * rewrite answered a summary that forgot to carry it. The one screen
       * whose whole job is to prove the printer works was reporting
       * "Sent undefined bytes".
       */
      const sentBytes = results.reduce((n, r) => n + (r.success ? (r.sent || 0) : 0), 0);

      receiptLog.record({
        kind: options.kind || 'receipt',
        saleId: (sale && (sale.billNo || sale.sales_id || sale.invoice_number)) || '',
        title: (sale && sale.title) || options.docName || 'Receipt',
        total: sale && (sale.total ?? sale.sales_total),
        /* Who asked. The floor bill passes its own; anything else is somebody
           standing at the counter. */
        source: options.source || 'Till',
        ms: Date.now() - startedAt,
        printers: results.map((r) => ({
          name: r.printer,
          jobId: r.jobId,
          copy: r.copy,
          status: r.success ? 'success' : 'failed',
          reason: r.success ? undefined : (r.error || 'unknown'),
          bytes: r.sent,
        })),
      });

      return {
        success: results.some((r) => r.success),
        pending: results.some(r => r.pending),
        status: results.every(r => r.success) ? 'Sent to printer' : (results.find(r => !r.success)?.status || 'Failed'),
        jobs: results,
        bytes: sentBytes,
        printed: results.length - failed.length,
        attempted: results.length,
        failures: failed.map((r) => ({ printer: r.printer, error: r.error || 'unknown' })),
        error: failed.length && !results.some((r) => r.success)
          ? (failed[0].error || 'Print failed') : undefined,
      };
    } catch (err) {
      console.error('[Print] receipt render failed:', err.message);
      /*
       * A receipt that never reached a printer is the most important row in
       * the log, not the least. Without this the failures that happen BEFORE
       * any printer is touched - a layout that will not draw, a missing
       * setting - would leave no trace at all and look like the till simply
       * ignored the button.
       */
      receiptLog.record({
        kind: options.kind || 'receipt',
        saleId: (sale && (sale.billNo || sale.sales_id || sale.invoice_number)) || '',
        title: (sale && sale.title) || options.docName || 'Receipt',
        total: sale && (sale.total ?? sale.sales_total),
        source: options.source || 'Till',
        ms: Date.now() - startedAt,
        printers: [{ name: '(never reached a printer)', status: 'failed', reason: err.message }],
      });
      return { success: false, error: err.message };
    }
  });

  /* The day's receipts, for the Hardware Manager screen. */
  ipcMain.handle('receipt:get-logs', (event, date) => hardwareManager.reconcilePrintLogs(require('./receipt-log').forDate(date)));

  ipcMain.handle('receipt:delete-log', (event, date, id) => ({
    success: require('./receipt-log').remove(date, id),
  }));

  /*
   * A report on a roll, as ESC/POS.
   *
   * The renderer lives here rather than in the page because the page cannot
   * require it - and because the shape of a report is data, not markup. The
   * caller declares its sections and this decides how they land on the paper.
   */
  ipcMain.handle('printer:print-report', async (event, doc, options = {}) => {
    try {
      const { renderReport } = require('./escpos-report');
      const bytes = renderReport(doc || {}, {
        paperWidth: options.paperWidth || '80',
        cut: options.cut !== false,
      });
      return await hardwareManager.sendRawToPrinter(
        options.printerName, bytes, options.docName || 'Posnic Report', { jobId: options.jobId });
    } catch (err) {
      console.error('[Print] report render failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('printer:print', async (event, htmlContent, options) => {
    return await hardwareManager.printHTML(htmlContent, options);
  });

  ipcMain.handle('printer:print-pdf', async (event, bytes, kind, paperSize) => {
    const saved = require('./device-preferences').documentPrintSettings();
    const profile = kind === 'menu'
      ? { paperSize: ['a4', 'a5', 'letter'].includes(paperSize) ? paperSize : 'a4' }
      : {};
    if (profile.printerName && profile.printerName !== 'default') {
      const printers = await hardwareManager.listPrinters();
      if (!printers.some((printer) => printer.name === profile.printerName)) {
        return { success: false, error: 'The selected ' + kind + ' printer is unavailable. Check Print settings.' };
      }
    }
    return require('./print-pdf').printPdfDocument(bytes, {
      ...profile,
      parent: BrowserWindow.fromWebContents(event.sender),
    });
  });

  // Preferences Handlers (file-based persistence)
  const _prefsPath = path.join(app.getPath('userData'), 'preferences.json');

  function _loadPrefs(strict = false) {
    try {
      if (fs.existsSync(_prefsPath)) {
        return JSON.parse(fs.readFileSync(_prefsPath, 'utf8'));
      }
    } catch (e) { if (strict) throw e; }
    return {};
  }

  // Merge only the requested keys into the latest file. Other hardware modules
  // also write this file during the same app session.
  function _savePrefs(patch) {
    const next = { ..._loadPrefs(true), ...patch };
    require('./device-preferences').saveJson(_prefsPath, next);
    Object.assign(preferences, next);
  }

  const preferences = _loadPrefs();

  ipcMain.handle('printer:get-document-settings', () =>
    require('./device-preferences').documentPrintSettings(_loadPrefs()));
  ipcMain.handle('printer:save-document-settings', (_event, value) => {
    try {
      const settings = require('./device-preferences').validateDocumentPrintSettings(value);
      const current = _loadPrefs(true);
      const next = { item_print_languages: settings.itemLanguages || current.item_print_languages, receipt_printers: JSON.stringify(settings.sales),
        receipt_printer: settings.sales[0].name, print_width: settings.sales[0].pageSize };
      _savePrefs(next);
      return { success: true, settings };
    } catch (error) { return { success: false, error: error.message }; }
  });

  /*
   * Bring the shop's hardware back up by itself.
   *
   * Hardware Manager has always saved the chosen scale port, and the Essae
   * network scale has always saved its address - but nothing read either back
   * at startup. So every restart of the app left the till with no scale until
   * somebody went into Hardware Manager and pressed Connect, which is what a
   * shop describes as the weight machine "not working".
   *
   * Deferred a moment so a scale that is slow to enumerate over USB has
   * appeared before the first attempt, and failure is quiet: the till has to
   * open whether or not a scale is plugged in.
   */
  setTimeout(() => {
    const savedScale = preferences['hardware.weightMachine'];
    if (savedScale && savedScale.port) {
      hardwareManager.autoConnectSaved(savedScale).catch((err) =>
        console.warn('[Scale] auto-connect failed:', err.message));
    }

    const essaeConfig = loadEssaeConfig();
    if (essaeConfig && essaeConfig.enabled) {
      try {
        getEssaeReader().start();
        console.log('[EssaeScale] started from saved configuration');
      } catch (err) {
        console.warn('[EssaeScale] auto-start failed:', err.message);
      }
    }
  }, 3000);

  ipcMain.handle('preferences:get', (event, key) => {
    return _loadPrefs()[key] ?? null;
  });

  ipcMain.handle('preferences:set', (event, key, value) => {
    _savePrefs({ [key]: value });
    return { success: true };
  });

  // Printer set-default (saves to preferences)
  ipcMain.handle('printer:set-default', (event, printerName) => {
    _savePrefs({ defaultPrinter: printerName });
    return { success: true };
  });

  // ── Cash Drawer Handlers ─────────────────────────────
  ipcMain.handle('cashDrawer:load-config', () => {
    return hardwareManager.loadCashDrawerConfig();
  });

  ipcMain.handle('cashDrawer:save-config', (event, config) => {
    return hardwareManager.saveCashDrawerConfig(config);
  });

  ipcMain.handle('cashDrawer:open-via-printer', async (event, printerName, pin) => {
    return await hardwareManager.openCashDrawerViaPrinter(printerName, Number(pin) || 0);
  });

  console.log('Hardware IPC handlers registered');
}

module.exports = { setupHardwareIPC };
