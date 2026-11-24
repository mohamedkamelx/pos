'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const PDFDocument = require('node:module').createRequire(require.resolve('../api/src/utils/pdfGenerator'))('pdfkit');
const { generateInvoicePDF, generateReceivingPDF } = require('../api/src/utils/pdfGenerator');

test('invoice PDF resolves registered headings without rewriting customer data or amounts', async () => {
  const texts = [], chunks = [];
  const original = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (text, ...args) {
    texts.push(String(text)); return original.call(this, text, ...args);
  };
  const res = new Writable({ write(chunk, encoding, cb) { chunks.push(chunk); cb(); } });
  res.setHeader = () => {};
  try {
    generateInvoicePDF({
      data: {
        sales_id: 'S001', date: '2026-10-20', customer_name: 'Subtotal',
        items: [{ name: 'PAYMENT', quantity: 1, price: 100 }],
        items_subtotal: 100, items_total: 90, sale_extra_discount: 10,
        partial_check: true, partial_balance: 50, payment_pending: 40
      },
      branch: { branch_name: 'Store', currency_type: 'EGP' }, res,
      wording: { values: {
        lang_sales_receipt: 'CUSTOM RECEIPT', lang_bill_to: 'Recipient',
        lang_item: 'Article', lang_qty_title: 'Count',
        lang_price_title: 'Unit value', lang_amount: 'Line value',
        lang_subtotal: 'Before discount', lang_extra_discount: 'Adjustment', lang_bill_print_total_qty: 'Units',
        lang_total: 'Payable', lang_paid: 'Received',
        lang_balance_due_2: 'Outstanding'
      } }
    });
    await finished(res);
    for (const label of ['CUSTOM RECEIPT','Recipient','Article','Count','Units','Before discount','Adjustment','Payable','Received','Outstanding'])
      assert.ok(texts.includes(label), 'missing label ' + label);
    assert.ok(texts.includes('Subtotal'), 'customer name must remain literal');
    assert.ok(texts.includes('PAYMENT'), 'product name must remain literal');
    assert.ok(texts.includes('EGP 90.00'), 'grand total is unchanged');
    assert.ok(Buffer.concat(chunks).subarray(0, 4).equals(Buffer.from('%PDF')));
  } finally {
    PDFDocument.prototype.text = original;
  }
});

test('purchase PDF resolves wording and retains supplier text and saved totals', async () => {
  const texts = [];
  const original = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (text, ...args) {
    texts.push(String(text)); return original.call(this, text, ...args);
  };
  const res = new Writable({ write(chunk, encoding, cb) { cb(); } });
  res.setHeader = () => {};
  try {
    generateReceivingPDF({
      data: { receiving_id: 'P001', date: '2026-10-20', supplier_name: 'Quantity',
        items: [], subtotal: 100, items_total: 100 },
      branch: { branch_name: 'Store', currency_type: 'EGP' }, res,
      wording: { values: { lang_description: 'Article', lang_quantity: 'Count',
        lang_price_title: 'Unit value', lang_amount: 'Line value', lang_subtotal: 'Net',
        lang_total: 'Payable', lang_paid: 'Received',
        lang_bill_print_total_qty: 'Units' } }
    });
    await finished(res);
    for (const label of ['Article', 'Count', 'Unit value', 'Line value', 'Net:', 'Payable:', 'Received:', 'Units:'])
      assert.ok(texts.includes(label), 'missing label ' + label);
    assert.ok(texts.includes('Quantity'), 'supplier name must remain literal');
    assert.ok(texts.includes('EGP 100.00'));
  } finally { PDFDocument.prototype.text = original; }
});
