'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function wizard(t) {
  const html = fs.readFileSync(path.join(__dirname, '../src/install-wizard.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/install-wizard.html',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const script of [...w.document.querySelectorAll('script:not([src])')]) {
    w.eval(script.textContent);
  }
  t.after(() => dom.window.close());
  return { dom, w, doc: w.document };
}

test('a rejected signup puts the server message beside the email field', (t) => {
  const { w, doc } = wizard(t);
  w.applyInstallErrors(
    {
      type: 'error',
      status: false,
      message: 'Please check the highlighted fields and try again.',
      data: {
        fields: [
          {
            field: 'register_useremail',
            message: 'This email address (owner@example.com) is already in use.',
          },
        ],
      },
    },
    'quick'
  );

  assert.equal(doc.getElementById('stepQuick').style.display, 'block');
  assert.equal(doc.getElementById('qEmail').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.getElementById('qEmailError').hidden, false);
  assert.match(doc.getElementById('qEmailError').textContent, /already in use/);
  assert.equal(doc.getElementById('qError').textContent, 'Please correct the highlighted fields.');
  assert.equal(doc.activeElement.id, 'qEmail');
});

test('an advanced-form error opens the step that owns the field', (t) => {
  const { w, doc } = wizard(t);
  w.applyInstallErrors(
    {
      type: 'error',
      status: false,
      message: 'Please check the highlighted fields and try again.',
      data: {
        fields: [
          {
            field: 'register_companyname',
            message: 'Shop name must be between 3 and 160 characters.',
          },
        ],
      },
    },
    'full'
  );

  assert.equal(doc.getElementById('step2').style.display, 'block');
  assert.equal(doc.getElementById('step1').style.display, 'none');
  assert.equal(doc.getElementById('branchName').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.getElementById('branchNameError').hidden, false);
  assert.match(doc.getElementById('branchNameError').textContent, /between 3 and 160/);
  assert.equal(doc.getElementById('errorMessage').textContent, 'Please correct the highlighted fields.');
});

test('a generic validation failure still reads as a friendly summary', (t) => {
  const { w, doc } = wizard(t);
  w.applyInstallErrors(
    {
      type: 'error',
      status: false,
      message: 'Validation Error',
      data: { errors: [{ param: 'license_id', msg: 'License ID is required' }] },
    },
    'quick'
  );

  assert.equal(doc.getElementById('qError').textContent, 'Please check the highlighted fields and try again.');
  assert.equal(doc.getElementById('qError').style.display, 'block');
});
