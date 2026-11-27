/*
 * One reading of a number the operator typed.
 *
 * The card shows the value, the bubble echoes it and the server stores it,
 * so all three must read the same string the same way - "1,500" is a
 * thousand and "1.500" is a decimal, and Arabic-Indic digits are digits.
 * This file is deliberately dependency-free and UMD: the page loads it with
 * a script tag before core/ai.js, and the server requires the very same
 * file, so there is exactly one copy of the rule.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PosnicNumeric = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseNumberInput(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\u0660-\u0669]/g, function (d) { return d.charCodeAt(0) - 0x0660; })
      .replace(/[\u06F0-\u06F9]/g, function (d) { return d.charCodeAt(0) - 0x06F0; })
      .replace(/\u066B/g, '.')                  // Arabic decimal separator
      .replace(/[\u066C\u060C]/g, ',')          // Arabic thousands sep / Arabic comma
      .replace(/[\s\u00A0\u202F']/g, '');
    if (/[-\u2212\u2013\u2012]/.test(s)) return { ok: false, reason: 'negative' };
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
      var dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      var thou = dec === ',' ? '.' : ',';
      s = s.split(thou).join('').replace(dec, '.');
    } else if (/^\d{1,3}(,\d{3})+$/.test(s)) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'format' };
    var n = Number(s);
    return isFinite(n) && n >= 0 ? { ok: true, value: s } : { ok: false, reason: 'range' };
  }

  return { parseNumberInput: parseNumberInput };
}));
