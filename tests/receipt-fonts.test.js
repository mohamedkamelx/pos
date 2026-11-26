'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fonts, covers, fontsFor } = require('../src/receipt-fonts');
const { needsRaster, layout } = require('../src/escpos-unicode');
const samples = require('./fixtures/receipt-languages.json');
const { shippedLanguages } = require('../frontend/gulpfile.js/config');
const root = path.join(__dirname, '..');

test('every shipped UI language has a receipt regression sample', () => {
  for (const language of shippedLanguages) {
    assert.ok(samples.some(sample => sample.code === language.code),
      `${language.code} has no receipt sample`);
  }
});

for (const sample of samples) {
  test(`${sample.code}: receipt text survives and every character has a bundled glyph`, () => {
    const selected = fontsFor(sample.text);
    for (const character of sample.text) {
      assert.ok(selected.some(font => covers(font, character.codePointAt(0))), `${sample.code}: missing ${character}`);
    }
    assert.equal(needsRaster({ items: [{ name: sample.text }] }), /[^\x00-\x7f\u20ac]/u.test(sample.text));
    for (const paperWidth of ['58', '80']) {
      const plan = layout({ items: [{ name: sample.text, qty: 2, amount: 10 }], total: 10 }, { paperWidth });
      assert.ok(plan.body.includes(sample.text));
    }
  });
}

test('mixed base scripts select their own manifest fonts regardless of UI language', () => {
  const selected = fontsFor('Café العربية עברית ชานม');
  for (const family of ['NotoSans', 'NotoSansArabic', 'NotoSansHebrew', 'NotoSansThai']) {
    assert.ok(selected.some(font => font.family === family), family);
  }
});

test('manifest fonts cover the letters, marks and numbers in the shipped UI packs', () => {
  for (const { code } of shippedLanguages) {
    const file = code === 'en' ? '_english' : code;
    const text = fs.readFileSync(path.join(root, 'languages', file + '.json'), 'utf8');
    for (const character of new Set(text)) {
      if (!/[\p{L}\p{M}\p{N}]/u.test(character)) continue;
      assert.ok(fonts.some(font => covers(font, character.codePointAt(0))), `${code}: missing glyph for ${character}`);
    }
  }
});

test('combining marks, RTL, non-Latin and supplementary characters select the graphics path', () => {
  for (const text of ['Cafe\u0301', 'עברית', 'العربية', 'ไทย', '中文', '𐐷']) {
    assert.equal(needsRaster({ footer: text }), true, text);
    assert.ok(layout({ footer: text, total: 1 }).body.includes(text));
  }
});

function assertManifest(font) {
  for (const name of [font.file, font.license]) {
    assert.ok(fs.statSync(path.join(root, 'src/fonts', name)).size > 0, name);
  }
  const bytes = fs.readFileSync(path.join(root, 'src/fonts', font.file));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), font.sha256, font.file);
  assert.match(fs.readFileSync(path.join(root, 'src/fonts', font.license), 'utf8'), /SIL OPEN FONT LICENSE/);
  for (let i = 0; i < font.ranges.length; i++) {
    const [first, last] = font.ranges[i];
    assert.ok(first <= last && (!i || first > font.ranges[i - 1][1]));
  }
}

test('the four bundled receipt fonts and their original licences ship in the installer', () => {
  const { build } = require('../package.json');
  assert.deepEqual(fonts.map((font) => font.family).sort(),
    ['NotoSans', 'NotoSansArabic', 'NotoSansHebrew', 'NotoSansThai']);
  for (const font of fonts) {
    for (const name of [font.file, font.license]) {
      assert.ok(build.files.includes('src/fonts/' + name), `${name} missing from installer`);
    }
    assertManifest(font);
  }
});

test('the manifest no longer declares optional font packs', () => {
  const manifest = require('../src/fonts/manifest.json');
  assert.equal(manifest.packs, undefined);
  assert.deepEqual(manifest.fonts.map((font) => font.family).sort(),
    ['NotoSans', 'NotoSansArabic', 'NotoSansHebrew', 'NotoSansThai']);
});
