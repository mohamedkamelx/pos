'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'languages');
const output = path.join(root, 'api/src/catalogs/wording-core.json');
const core = JSON.parse(fs.readFileSync(path.join(directory, '_english.json'), 'utf8'));
// Document wording is also printed outside the browser. These labels are
// referenced by the PDF generators but are not frontend markup, so the UI
// coverage map does not contain them. Keep them in the shared catalogue so a
// translated receipt still says "Bill to" and "Amount" in the shop's language.
const documentOnly = {
  lang_amount: 'Amount',
  lang_bill_to: 'Bill to',
  lang_invoice: 'INVOICE',
  lang_sales_receipt: 'SALES RECEIPT',
};
for (const [key, english] of Object.entries(documentOnly)) {
  if (!(key in core)) core[key] = english;
}
const locales = ['en', ...fs.readdirSync(directory).filter(x => /^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?\.json$/.test(x)).map(x => x.slice(0, -5))];
const compiled = JSON.stringify({ schemaVersion: 1, locales: [...new Set(locales)].sort(), labels: core }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== compiled) throw new Error('Run node scripts/build-wording-catalog.js before releasing changed language catalogs.');
} else { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, compiled); }
require('./build-document-wording-catalog');
