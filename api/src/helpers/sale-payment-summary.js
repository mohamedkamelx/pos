/* One presentation of recorded tender amounts for sale details and receipts. */
/* global window */
(function (root) {
  'use strict';
  function rows(sale) {
    function parse(value) {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch (_) {
        return null;
      }
    }
    function collect(value) {
      const result = new Map();
      function add(method, amount) {
        // A saved payment journal may be mixed with branch settings;
        // only numeric tender amounts are collected.
        if (typeof amount !== 'number' && typeof amount !== 'string') return;
        method = String(method || '').trim();
        amount = Number(amount);
        if (!method || !Number.isFinite(amount) || amount <= 0) return;
        const rawKey = method.toLowerCase();
        const key = /^(credit[ _-]?card|debit[ _-]?card)$/.test(rawKey) ? 'card' : rawKey;
        const label = { cash: 'Cash', card: 'Card', upi: 'Digital payment' }[key] || method;
        const entry = result.get(key) || { method: label, amount: 0 };
        entry.amount += amount;
        result.set(key, entry);
      }
      function visit(value) {
        value = parse(value);
        if (Array.isArray(value))
          value.forEach(function (entry) {
            if (!entry || typeof entry !== 'object') return;
            if (Array.isArray(entry.tenders) && entry.tenders.length) visit(entry.tenders);
            else add(entry.method || entry.payment_mode || entry.label, entry.amount);
          });
        else if (value && typeof value === 'object')
          Object.keys(value).forEach(function (method) {
            const entry = value[method];
            add(method, entry && typeof entry === 'object' ? entry.amount : entry);
          });
      }
      visit(value);
      return Array.from(result.values());
    }
    let result = collect(sale.multi_payment);
    if (!result.length && Array.isArray(parse(sale.captain_payments)))
      result = collect(sale.captain_payments);
    if (result.length) return result;
    const method = String(sale.payment_mode || '').trim();
    // A legacy mixed label does not contain enough information to invent a split.
    if (!method || /[,;+]|\bmixed\b|\bsplit\b/i.test(method)) return [];
    let amount = sale.paid_amount;
    if (amount == null && (sale.partial_check === true || sale.partial_check === 'true'))
      amount = sale.partial_balance;
    if (amount == null && /^paid$/i.test(String(sale.payment_status || '')))
      amount = sale.items_total == null ? sale.sales_total : sale.items_total;
    return collect([{ method: method, amount: amount }]);
  }
  // Only explicitly opted-in references belong on a guest receipt. Reports keep
  // their original method grouping and money; the saved sale drives reprints.
  function receiptRows(sale) {
    const key = (method) =>
      String(method || '')
        .trim()
        .toLowerCase()
        .replace(/^(credit[ _-]?card|debit[ _-]?card)$/, 'card');
    const references = new Map();
    let payments = sale.captain_payments;
    if (typeof payments === 'string') {
      try {
        payments = JSON.parse(payments);
      } catch (_) {
        payments = [];
      }
    }
    for (const payment of Array.isArray(payments) ? payments : []) {
      for (const tender of Array.isArray(payment?.tenders) && payment.tenders.length
        ? payment.tenders
        : [payment]) {
        if (tender?.printReference !== true || typeof tender.reference !== 'string') continue;
        const reference = Array.from(tender.reference, (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character
        )
          .join('')
          .trim()
          .slice(0, 100);
        if (!reference) continue;
        const method = key(tender.method);
        const values = references.get(method) || new Set();
        values.add(reference);
        references.set(method, values);
      }
    }
    return rows(sale).map((row) => {
      const values = references.get(key(row.method));
      return {
        ...row,
        method: values?.size ? row.method + ' · ' + Array.from(values).join(', ') : row.method,
      };
    });
  }
  /*
   * The till records an amount, not a tender type. Sales, reprints and reports
   * show that amount; legacy method rows are only used to recover the total.
   */
  function amount(sale) {
    let paid = Number(sale.paid_amount);
    if (!(Number.isFinite(paid) && paid > 0)) {
      paid = rows(sale).reduce(function (sum, row) {
        return sum + (Number(row.amount) || 0);
      }, 0);
    }
    if (!(paid > 0)) {
      if (sale.partial_check === true || String(sale.partial_check) === 'true') {
        paid = Number(sale.partial_balance) || 0;
      } else if (/^paid$/i.test(String(sale.payment_status || ''))) {
        paid = Number(sale.items_total == null ? sale.sales_total : sale.items_total) || 0;
      }
    }
    return Number.isFinite(paid) && paid > 0 ? paid : 0;
  }
  const api = { rows: rows, receiptRows: receiptRows, amount: amount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PosnicSalePayments = api;
})(typeof window !== 'undefined' ? window : globalThis);
