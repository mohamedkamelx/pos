'use strict';
/*
 * What this machine was told about its own hardware.
 *
 * Printer choices are per machine, not per shop, and deliberately so: two
 * tills in one shop have different printers attached, and a setting that
 * synced would have them fighting over one name. They live in
 * `userData/preferences.json`, written by Hardware Manager.
 *
 * That file was read in exactly one place, inside setupHardwareIPC, as a
 * local. Anything outside that closure had no way to ask which printer the
 * shop chose - which is how a receipt came to be sent to "whatever Windows
 * calls the default" instead of the receipt printer the shop selected.
 *
 * Read on every call rather than cached. These are answered when a printer is
 * about to be used, which is rare and slow anyway, and a cache here would mean
 * a shop that changed its receipt printer had to restart the till.
 */
const fs = require('fs');
const path = require('path');

function prefsPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'preferences.json');
  } catch (e) {
    /* No electron app object: a test, or a script. */
    return '';
  }
}

/** Everything this machine was told. Never throws; an unreadable file is {}. */
// Replace only after the complete JSON is durable. An interrupted save must
// leave the previous configuration readable, not a truncated preferences file.
function saveJson(file, value) {
  const temp = file + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) { /* renamed, or never created */ }
  }
}

function all(strict = false) {
  const file = prefsPath();
  if (!file) return {};
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    if (strict) throw e;
    console.error('[prefs] could not be read:', e.message);
  }
  return {};
}

/** One answer, or null. */
function get(key) {
  const prefs = all();
  return prefs[key] === undefined ? null : prefs[key];
}

/**
 * The printer the shop chose for receipts, or null to mean "nobody chose".
 *
 * `receipt_printers` is the current shape, a list of targets each with its own
 * copies and paper; `receipt_printer` is the single name older builds wrote
 * and is still kept in step by Hardware Manager. The FIRST target is the
 * receipt printer: the rest are extra copies of the same document, and a
 * document that must go to one counter goes to the first.
 *
 * Null is meaningful and must not be turned into a guess by the caller unless
 * it has decided that guessing is right. The till receipt falls back to the
 * Windows default because every shop predates this setting and refusing to
 * print would break them on upgrade. A document that must land on a
 * particular counter should say so instead.
 */
function receiptPrinterName() {
  const prefs = all();
  const list = Array.isArray(prefs.receipt_printers) ? prefs.receipt_printers : [];
  for (const target of list) {
    const name = target && typeof target === 'object' ? target.name : target;
    if (name && String(name).trim() && String(name).trim() !== 'default') {
      return String(name).trim();
    }
  }
  const single = prefs.receipt_printer;
  if (single && String(single).trim() && String(single).trim() !== 'default') {
    return String(single).trim();
  }
  return null;
}

function documentPrintSettings(prefs = all()) {
  const parse = (value, fallback) => {
    try { return (typeof value === 'string' ? JSON.parse(value) : value) || fallback; }
    catch (_) { return fallback; }
  };
  const { normalizeTargets } = require('./printer-targets');
  return {
    sales: normalizeTargets({ printers: parse(prefs.receipt_printers, []),
      printerName: prefs.receipt_printer || 'default', pageSize: prefs.print_width || '80mm' })
      .map((target) => ({ ...target, name: target.name || 'default' })),
    ...(prefs.item_print_languages ? { itemLanguages: prefs.item_print_languages } : {}),
  };
}

function validateDocumentPrintSettings(value) {
  const { PAPER_SIZES } = require('./printer-targets');
  const copies = (n) => Number.isInteger(n) && n >= 1 && n <= 20;
  const name = (v) => typeof v === 'string' && v.length <= 256 && !/[\r\n\0]/.test(v);
  if (!value || !Array.isArray(value.sales) || !value.sales.length || value.sales.length > 10) throw new Error('Choose at least one sales printer (up to 10).');
  const seen = new Set();
  for (const target of value.sales) {
    if (!target || !name(target.name) || !target.name.trim() || !PAPER_SIZES[target.pageSize] || !copies(target.copies)) throw new Error('Invalid sales printer settings.');
    if (target.printMode !== undefined && !['fast', 'exact', 'driver'].includes(target.printMode)) throw new Error('Invalid receipt print mode.');
    if (target.printMode === 'fast' && !['58mm', '80mm', '112mm'].includes(target.pageSize)) throw new Error('Fast receipt requires thermal paper.');
    const key = target.name.trim().toLowerCase();
    if (seen.has(key)) throw new Error('Choose each sales printer once. Use Copies for additional copies.');
    seen.add(key);
  }
  const itemLanguages = value.itemLanguages;
  if (itemLanguages) {
    const locale = require('./item-localization').locale;
    if ((itemLanguages.receipt && !locale(itemLanguages.receipt)) || typeof itemLanguages.bilingual !== 'boolean') throw new Error('Choose valid item print languages.');
  }
  return documentPrintSettings({ receipt_printers: value.sales,
    item_print_languages: itemLanguages ? { receipt: itemLanguages.receipt || '', bilingual: itemLanguages.bilingual } : undefined });
}

module.exports = {
  saveJson,
  all,
  get,
  receiptPrinterName,
  prefsPath,
  documentPrintSettings,
  validateDocumentPrintSettings,
};
