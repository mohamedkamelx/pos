# Receipt text in different languages

Desktop receipts and queued bills automatically use printer graphics when
their text contains non-ASCII characters. Chromium shapes and wraps the text
before POSNIC sends ESC/POS raster strips through the usual printer queue.
The preview reads those same bytes. ASCII receipts retain the existing fast
text path, including the downloadable euro symbol.

The installer includes offline fonts for Latin, Arabic, Hebrew and Thai. Font
selection follows the characters in the receipt, so product names can mix
these scripts independently of the UI.

Unicode text is never flattened to ASCII on the graphics path. Scripts outside
the bundled coverage use Chromium's system font fallback; their fonts must be
present on the computer. This is not a claim that every Unicode script is
bundled. Roll reports have a separate renderer.

## Validation

- `node --test tests/escpos-unicode.test.js tests/receipt-fonts.test.js`
- `electron tests/tools/arabic-receipt-proof.js` checks the original Arabic
  receipt path.
