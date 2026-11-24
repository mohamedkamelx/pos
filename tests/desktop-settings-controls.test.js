const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(t, changes = {}) {
  const dom = new JSDOM(['hardware', 'app', 'updates', 'backups', 'cloudsync', 'systemstatus'].map(key => `<div data-desktop-page="${key}"></div>`).join(''), { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  const w = dom.window, $ = require('jquery')(w), calls = [];
  w.$ = w.jQuery = $;
  w.PosnicPro = { escapeHtml: text => $('<i>').text(text).html(), i18n: { t: (_key, fallback) => fallback }, userACL: { branch: { write: true } } };
  const capture = name => async data => { calls.push([name, JSON.parse(JSON.stringify(data))]); return { success: true }; };
  w.electronAPI = {
    platform: 'linux', desktop: { capabilities: async () => ({ version: '1.8.0', backup: true }), open: capture('open'), getBehaviour: async () => ({ supported: false }), saveBehaviour: capture('behaviour') },
    printer: { list: async () => [{ name: 'Back office' }, { name: 'Counter' }] },
    cashDrawer: { loadConfig: async () => ({ method: 'printer', printerName: 'Counter', pin: 1, autoOpenOnSale: true, existingField: 'kept' }), saveConfig: capture('drawer') },
    cloud: { status: async () => ({ connected: true, sync: { online: false, lastError: '<img src=x onerror=alert(1)>' } }) }
  };
  w.electron = {
    update: { getConfig: async () => ({ success: true, config: { channel: 'stable', autoCheck: false, checkFrequency: 'weekly', installOnQuit: true } }), saveConfig: capture('updates') },
    getBackupConfig: async () => ({ success: true, config: { enabled: true, path: 'D:/Backups', frequency: 'weekly', time: '03:15', dayOfWeek: 2, retentionDays: 14 } }), saveBackupConfig: capture('backups'),
    browseBackupFolder: async () => 'E:/Shop backups', runBackupNow: async () => ({ success: true })
  };
  if (changes.setup) changes.setup(w);
  w.eval(read('frontend/static/script/js/modules/js/desktop-settings.js'));
  return { w, $, calls, load: key => w.PosnicPro.desktopSettings.load(key), click: async action => { $(`[data-desktop-action="${action}"]`).trigger('click'); await tick(); await tick(); } };
}

test('printer settings and design are separate panes without disclosure controls', () => {
  const dom = new JSDOM(read('frontend/modules/settings_write.html'));
  const d = dom.window.document;
  assert.equal(d.querySelector('#document-print-settings').closest('[role="tabpanel"]').id, 'print-printers');
  assert.equal(d.querySelector('#receipt-designer').closest('[role="tabpanel"]').id, 'print-design');
  assert.equal(d.querySelector('#print-printers-tab').getAttribute('aria-controls'), 'print-printers');
  assert.equal(d.querySelector('#print-design-tab').getAttribute('aria-controls'), 'print-design');
  assert.equal(d.querySelector('#receipt-print-behaviour').closest('[role="tabpanel"]').id, 'print-printers');
  assert.equal(d.querySelectorAll('#core-tab-print details').length, 0);
  dom.window.close();
});

test('the cash drawer uses existing persisted field names and preserves other configuration', async t => {
  const p = page(t); await p.load('hardware');
  assert.equal(p.$('[data-field="drawerAuto"]').prop('checked'), true);
  p.$('[data-field="drawerAuto"]').prop('checked', false);
  await p.click('save-devices');
  assert.deepEqual(p.calls[0], ['drawer', { method: 'printer', printerName: 'Counter', pin: 1, autoOpenOnSale: false, existingField: 'kept' }]);
});

test('changing automatic drawer opening keeps an existing serial connection', async t => {
  const original = { method: 'serial', port: 'COM4', baudRate: 9600, printerName: 'Counter', pin: 0, autoOpenOnSale: false };
  const p = page(t, { setup: w => { w.electronAPI.cashDrawer.loadConfig = async () => original; } });
  await p.load('hardware');
  p.$('[data-field="drawerAuto"]').prop('checked', true);
  await p.click('save-devices');
  assert.deepEqual(p.calls[0], ['drawer', { ...original, autoOpenOnSale: true }]);
  p.$('[data-field="drawerPrinter"]').val('Back office');
  await p.click('save-devices');
  assert.equal(p.calls[1][1].method, 'printer');
  assert.equal(p.calls[1][1].port, 'COM4');
});

test('update settings use the shared configuration API and respect disabled automatic checking', async t => {
  const p = page(t); await p.load('updates');
  assert.equal(p.$('[data-field="checkFrequency"]').prop('disabled'), true);
  await p.click('save-updates');
  assert.deepEqual(p.calls[0], ['updates', { autoCheck: false, checkFrequency: 'weekly', installOnQuit: true, channel: 'stable' }]);
});

test('backup schedule retains day, time and folder; invalid retention does not save', async t => {
  const p = page(t); await p.load('backups');
  p.$('[data-field="backupRetention"]').val('0'); await p.click('save-backups');
  assert.deepEqual(p.calls, []);
  p.$('[data-field="backupRetention"]').val('14'); await p.click('save-backups');
  assert.deepEqual(p.calls[0], ['backups', { enabled: true, path: 'D:/Backups', frequency: 'weekly', time: '03:15', dayOfWeek: 2, retentionDays: 14 }]);
});

test('cloud installations do not offer local backup or restore controls', async t => {
  const p = page(t, { setup: w => { w.electronAPI.desktop.capabilities = async () => ({ backup: false }); } });
  await p.load('backups');
  assert.equal(p.$('[data-desktop-action="save-backups"]').length, 0);
  assert.equal(p.$('[data-desktop-open="backup"]').length, 0);
});

test('Linux does not offer an unsupported start-at-login switch', async t => {
  const p = page(t); await p.load('app');
  assert.equal(p.$('[data-field="openAtLogin"]').length, 0);
  assert.match(p.$('[data-desktop-page="app"]').text(), /operating system settings/);
});

test('unprivileged users cannot load or save desktop configuration', async t => {
  const p = page(t, { setup: w => { w.PosnicPro.userACL.branch.write = false; } });
  await p.load('hardware');
  assert.match(p.$('[data-desktop-page="hardware"]').text(), /administrator/);
  assert.equal(p.$('[data-desktop-action="save-devices"]').length, 0);
  assert.deepEqual(p.calls, []);
});

test('cloud sync settings are not exposed', async t => {
  const p = page(t); await p.load('cloudsync');
  const pane = p.$('[data-desktop-page="cloudsync"]');
  assert.equal(pane.text().trim(), '');
  assert.equal(pane.find('[data-desktop-action], [data-field]').length, 0);
});

test('standalone hardware navigation supports programmatic and keyboard entry without a global event', t => {
  const html = read('src/hardware-manager.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/hardware-manager.html' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const from = html.indexOf('        function switchTab('), to = html.indexOf('        // ===========================', from);
  w.eval(html.slice(from, to));
  w.switchTab('cash');
  assert.equal(w.document.querySelector('.tab-content.active').id, 'cashTab');
  w.switchTab('receipt');
  assert.equal(w.document.querySelector('.tab-content.active').id, 'receiptTab');
  w.switchTab('not-a-tab');
  assert.equal(w.document.querySelector('.tab-content.active').id, 'receiptTab');
});
