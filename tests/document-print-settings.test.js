'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { blockAt } = require('./helpers/source-lookup');
const { documentPrintSettings, validateDocumentPrintSettings } = require('../src/device-preferences');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const initial = () => ({ sales: [{ name: 'Counter', pageSize: '80mm', copies: 1 }] });

test('printer profiles migrate current and legacy receipt settings', () => {
  const current = documentPrintSettings({ receipt_printers: JSON.stringify(initial().sales) });
  assert.deepEqual(current.sales, initial().sales);
  const old = documentPrintSettings({ receipt_printer: 'Till', print_width: '2inch' });
  assert.deepEqual(old.sales, [{ name: 'Till', pageSize: '58mm', copies: 1 }]);
  assert.doesNotThrow(() => documentPrintSettings({ receipt_printers: '{broken', document_print_profiles: '{broken' }));
});

test('profile validation refuses invalid copies, repeated printers and bad paper', () => {
  assert.deepEqual(validateDocumentPrintSettings(initial()), initial());
  for (const mutate of [v => { v.sales = []; }, v => { v.sales.push(v.sales[0]); },
    v => { v.sales[0].copies = 0; }, v => { v.sales[0].copies = 21; },
    v => { v.sales[0].pageSize = 'not-paper'; }, v => { v.sales[0].name = 'Counter\nOther'; }]) {
    const value = initial(); mutate(value);
    assert.throws(() => validateDocumentPrintSettings(value));
  }
});

function handlerAt(source, marker) {
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, `no handler for ${marker}`);
  const next = source.indexOf('\n  ipcMain.handle(', start + marker.length);
  return source.slice(start, next > -1 ? next : source.indexOf('\n  }', start));
}

function ipc(prefs, file, fileSystem = fs) {
  const handlers = {};
  const source = read('src/hardware-ipc.js');
  if (fileSystem === fs) {
    try { fs.writeFileSync(file, JSON.stringify(prefs), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const pieces = [
    blockAt(source, 'function _loadPrefs('),
    blockAt(source, 'function _savePrefs('),
    handlerAt(source, "ipcMain.handle('printer:get-document-settings'"),
    blockAt(source, "ipcMain.handle('printer:save-document-settings'") + ');',
    blockAt(source, "ipcMain.handle('preferences:get'") + ');',
    blockAt(source, "ipcMain.handle('preferences:set'") + ');',
    blockAt(source, "ipcMain.handle('printer:set-default'") + ');',
  ];
  const body = `const _prefsPath = ${JSON.stringify(file)};\nconst preferences = _loadPrefs();\n` + pieces.join('\n');
  new Function('ipcMain', 'require', 'fs', body)(
    { handle: (key, fn) => { handlers[key] = fn; } },
    () => ({ documentPrintSettings, validateDocumentPrintSettings,
      saveJson: fileSystem === fs ? require('../src/device-preferences').saveJson : fileSystem.writeFileSync }), fileSystem);
  return handlers;
}

test('saving profiles persists independently, survives reload and retains other device settings', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-profiles-')), file = path.join(dir, 'preferences.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const prefs = { 'hardware.weightMachine': { port: 'COM7' } }, h = ipc(prefs, file);
  assert.equal(h['printer:save-document-settings']({}, initial()).success, true);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted['hardware.weightMachine'].port, 'COM7');
  assert.equal(persisted.receipt_printer, 'Counter');
  assert.equal(persisted.print_width, '80mm');
  assert.deepEqual(documentPrintSettings(persisted), initial());
  assert.deepEqual(h['printer:get-document-settings'](), initial());
});

test('a failed settings write is reported and does not change active printer choices', () => {
  const prefs = { receipt_printer: 'Old' }, before = clone(prefs);
  const h = ipc(prefs, 'unused', { writeFileSync: () => { throw new Error('Disk full'); } });
  assert.equal(h['printer:save-document-settings']({}, initial()).success, false);
  assert.deepEqual(prefs, before);
});

test('PDF IPC leaves report printing to the chooser and carries menu paper size', async () => {
  const source = read('src/hardware-ipc.js'), captured = [], handlers = {};
  const from = source.indexOf("  ipcMain.handle('printer:print-pdf'");
  const end = source.indexOf('\n  });', from) + 6;
  new Function('ipcMain', 'require', 'BrowserWindow', 'hardwareManager', source.slice(from, end))(
    { handle: (key, fn) => { handlers[key] = fn; } },
    name => name === './device-preferences'
      ? { documentPrintSettings: () => initial() }
      : { printPdfDocument: async (_bytes, options) => { captured.push(options); return { success: true }; } },
    { fromWebContents: () => null }, { listPrinters: async () => [] });
  const print = handlers['printer:print-pdf'];
  await print({}, Buffer.from('%PDF-'), 'report');
  await print({}, Buffer.from('%PDF-'), 'menu', 'a5');
  assert.equal(captured[0].printerName, undefined);
  assert.equal(captured[1].paperSize, 'a5');
  assert.equal(captured[1].printerName, undefined);
});

function page(t, desktop = true) {
  const dom = new JSDOM('<div id="document-print-settings"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, $ = require('jquery')(w), store = {};
  w.$ = w.jQuery = $;
  w.PosnicPro = { escapeHtml: value => $('<i>').text(value).html(), i18n: { t: (_k, text) => text },
    isWalkInName: name => /^(?:walk[\s._-]?in\b[\s._-]*(?:customer|guest|client)?|زبون\s*(?:ال)?محل|(?:عميل|زبون)\s*عابر)$/i.test(String(name == null ? '' : name).trim()),
    local: { get: key => store[key], set: (key, value) => { store[key] = value; } } };
  let saved = initial();
  if (desktop) w.electronAPI = { preferences: {}, printer: {
    getDocumentSettings: async () => clone(saved),
    saveDocumentSettings: async value => { saved = validateDocumentPrintSettings(value); return { success: true, settings: clone(saved) }; },
    list: async () => [{ name: 'Counter' }, { name: 'Office' }, { name: 'Estimates' }],
  } };
  w.eval(read('frontend/static/script/js/core/print-settings.js'));
  return { w, $, store, settings: w.PosnicPro.printSettings, saved: () => clone(saved) };
}

test('settings save separate sales printers, paper and copies and reload the saved values', async (t) => {
  const p = page(t);
  await p.settings.mount({});
  p.$('[data-print-add]').trigger('click');
  const rows = p.$('[data-profile="sales"]');
  assert.equal(rows.length, 2);
  rows.eq(0).find('[data-setting="printer"]').val('Counter');
  rows.eq(0).find('[data-setting="paper"]').val('80mm');
  rows.eq(1).find('[data-setting="printer"]').val('Office');
  rows.eq(1).find('[data-setting="paper"]').val('a5');
  rows.eq(1).find('[data-setting="copies"]').val('3');
  await p.settings.save();
  assert.equal(p.saved().sales[0].name, 'Counter');
  assert.equal(p.saved().sales[1].name, 'Office');
  assert.equal(p.saved().sales[1].pageSize, 'a5');
  assert.equal(p.saved().sales[1].copies, 3);
  await p.settings.mount({});
  assert.equal(p.$('[data-profile="sales"]').eq(1).find('[data-setting="paper"]').val(), 'a5');
  assert.match(p.store.receipt_printers, /Office/);
});

test('browser settings do not promise printer selection and preserve paper choices', async (t) => {
  const p = page(t, false);
  await p.settings.mount({});
  assert.equal(p.$('[data-setting="printer"]').length, 0);
  assert.equal(p.$('[data-profile="sales"] [data-setting="copies"]').prop('disabled'), true);
  p.$('[data-profile="sales"] [data-setting="paper"]').val('a5');
  await p.settings.save();
  await p.settings.ready();
  assert.equal(p.settings.get('sales')[0].pageSize, 'a5');
});

test('sales send each saved layout and copy count only to its configured printer', async (t) => {
  const p = page(t), prints = [], errors = [];
  const values = initial(); values.sales.push({ name: 'Office', pageSize: 'a5', copies: 2 });
  p.w.electronAPI.printer.getDocumentSettings = async () => clone(values);
  p.w.electronAPI.printer.print = async (html, options) => { prints.push({ html, options: clone(options) }); return { success: true }; };
  p.w.PosnicPro.alert = (_level, msg) => errors.push(msg);
  p.w.PosnicPro.afterPrint = () => {};
  p.w.eval(read('api/src/helpers/receipt-design.js'));
  p.w.eval(read('frontend/static/script/js/core/receipt-designer.js'));
  await p.w.PosnicPro.receiptDesigner.printSale({ branch_name: 'Test Shop', items: [{ item_name: 'Cup', item_price: 20, item_quantity: 1 }], items_total: 20 });
  assert.deepEqual(errors, []);
  assert.deepEqual(prints.map(x => [x.options.printerName, x.options.pageSize, x.options.copies]), [['Counter', '80mm', 1], ['Office', 'a5', 2]]);
  assert.match(prints[0].html, /data-receipt-design="80"/);
  assert.match(prints[1].html, /data-receipt-design="a5"/);
  assert.equal(prints[0].options.strictPrinter, true);
  assert.equal(prints[0].options.thermalRaster, true);
  assert.equal(prints[1].options.thermalRaster, false);
});

test('A4 override uses a configured sales sheet target instead of the thermal printer', async t => {
  const p = page(t), prints = [], errors = [];
  p.w.electronAPI.printer.print = async (_html, options) => { prints.push(clone(options)); return { success: true }; };
  p.w.PosnicPro.alert = (_level, message) => errors.push(message);
  p.w.PosnicPro.afterPrint = () => {};
  p.w.eval(read('api/src/helpers/receipt-design.js'));
  p.w.eval(read('frontend/static/script/js/core/receipt-designer.js'));
  const sale = { branch_name: 'Shop', items: [{ item_name: 'Tea', item_quantity: 1, item_price: 200 }], items_total: 200 };
  await p.w.PosnicPro.receiptDesigner.printSale(sale, 'a4');
  assert.equal(prints.length, 0);
  assert.match(errors[0], /Choose a sheet printer/);
  const values = initial(); values.sales.push({ name: 'Office', pageSize: 'a4', copies: 1 });
  p.w.electronAPI.printer.getDocumentSettings = async () => clone(values);
  await p.w.PosnicPro.receiptDesigner.printSale(sale, 'a4');
  assert.equal(prints.length, 1);
  assert.equal(prints[0].printerName, 'Office');
  assert.equal(prints[0].thermalRaster, false);
  assert.equal(prints[0].pageSize, 'a4');
});

test('an explicitly chosen sales printer never falls back to the system default', async () => {
  const source = read('src/hardware-manager.js');
  const start = source.indexOf('  async printHTML('), end = source.indexOf('\n  async getDefaultPrinter', start);
  const names = [];
  class Window {
    constructor() { this.webContents = { executeJavaScript: async () => {} }; }
    async loadURL() {}
    isDestroyed() { return true; }
  }
  const method = vm.runInNewContext('({' + source.slice(start, end) + '}).printHTML', {
    BrowserWindow: Window, prepareDocument: require('../src/receipt-page-layout').prepareDocument, hardenPrintWindow() {}, setTimeout() {}, console: { log() {}, warn() {}, error() {} },
  });
  const context = {
    _resolvePrintRoute: () => ({ url: 'data:text/html,test', secure: false }),
    _resolvePrinterName: async () => 'Counter', _waitForPrintPage: async () => {},
    _sendPrintJob: async (_win, opts) => { names.push(opts.deviceName); return { success: false, error: 'Offline' }; },
    _printViaPdfFallback: async (_win, name) => { names.push(name); return { success: false, error: 'Offline' }; },
    _printWithSystemDefaultFallback: async () => { throw new Error('wrong printer'); },
  };
  const result = await method.call(context, '<p>Sample</p>', { printerName: 'Counter', strictPrinter: true });
  assert.equal(result.success, false);
  assert.equal(result.error, 'Offline');
  assert.deepEqual(names, ['Counter', 'Counter', 'Counter']);
});

test('item print languages persist independently of each other and printer destinations', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'item-print-languages-')), file = path.join(dir, 'preferences.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const policy = { receipt:'nl', bilingual:true };
  const profiles = {...initial(),itemLanguages:policy};
  const prefs = {}, handlers = ipc(prefs,file);
  assert.equal(handlers['printer:save-document-settings']({},profiles).success,true);
  assert.deepEqual(documentPrintSettings(JSON.parse(fs.readFileSync(file,'utf8'))).itemLanguages,policy);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).receipt_printer,'Counter');
  assert.equal(handlers['printer:save-document-settings']({},initial()).success,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).item_print_languages,policy,'saving from an older screen preserves language choices');
  assert.throws(()=>validateDocumentPrintSettings({...profiles,itemLanguages:{...policy,receipt:'../bad'}}));
});


test('API-side bill workers can load device preferences without an Electron dependency', () => {
  const loaded = {exports:{}};
  new Function('require','module','exports',read('src/device-preferences.js'))(name => {
    if (name === 'electron') throw Object.assign(new Error('No Electron in API runtime'), {code:'MODULE_NOT_FOUND'});
    return require(name);
  },loaded,loaded.exports);
  assert.deepEqual(loaded.exports.all(),{});
  assert.equal(loaded.exports.get('item_print_languages'),null);
});


test('unrelated hardware settings survive printer saves and restarts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-writers-'));
  const file = path.join(dir, 'preferences.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = ipc({ receipt_printer: 'Old' }, file);
  fs.writeFileSync(file, JSON.stringify({ receipt_printer: 'Changed', 'hardware.weightMachine': { port: 'COM9' } }));
  assert.equal(h['printer:get-document-settings']().sales[0].name, 'Changed');
  assert.equal(h['printer:save-document-settings']({}, initial()).success, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved['hardware.weightMachine'].port, 'COM9');
  h['preferences:set']({}, 'print_width', '58mm');
  h['printer:set-default']({}, 'Counter');
  assert.equal(h['preferences:get']({}, 'hardware.weightMachine').port, 'COM9');
  const restarted = ipc({}, file);
  assert.equal(restarted['printer:get-document-settings']().sales[0].name, 'Counter');
  assert.equal(restarted['preferences:get']({}, 'hardware.weightMachine').port, 'COM9');
});

test('an unreadable preferences file is not replaced with defaults on printer save', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-corrupt-'));
  const file = path.join(dir, 'preferences.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = ipc({}, file);
  fs.writeFileSync(file, '{interrupted');
  assert.equal(h['printer:save-document-settings']({}, initial()).success, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{interrupted');
});
