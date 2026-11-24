const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('specialised Core Settings views hide only the duplicate outer footer', () => {
  const html = fs.readFileSync('frontend/modules/settings_write.html', 'utf8');
  const css = fs.readFileSync('frontend/static/style/css/receipt-designer.css', 'utf8');
  const dom = new JSDOM('<style>' + css + '</style>' + html);
  const { document, getComputedStyle } = dom.window;
  const footer = document.querySelector('#settings_edit_reset').parentElement;
  for (const sub of ['stock', 'expiry', 'mobile']) {
    document.querySelectorAll('[id^="core-tab-"], [id^="inv-sub-"]').forEach(node => node.classList.remove('active'));
    document.querySelector('#core-tab-inventory').classList.add('active');
    document.querySelector('#inv-sub-' + sub).classList.add('active');
    assert.equal(getComputedStyle(footer).display, 'none', 'inventory/' + sub);
  }
  assert.equal(document.querySelectorAll('[id^="pay-sub-"]').length, 0);
  assert.equal(document.querySelector('#core-tab-payments'), null);
  dom.window.close();
});
