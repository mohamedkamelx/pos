'use strict';

const Money = require('../utils/currency');
const { isWalkIn } = require('../utils/walk-in');
const { snapshot } = require('../utils/item-localization');
const combineBillLines = require('./combine-bill-lines');

/*
 * A sale, turned into the view model the receipt renderer expects.
 *
 * The renderer takes `{ storeName, items: [{ name, qty, amount }], total, ... }`,
 * not a Mongo document. Building the view model on the server means a queued
 * print job carries everything it needs: the till can print it after the
 * network is gone, even when it is paired to a shop whose database it cannot
 * read directly.
 *
 * Prices on the sale are final amounts. This module only maps stored values
 * into printer fields.
 */

function wants(branch, key) {
  const v = branch && branch[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stamp(date) {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function qtyText(value) {
  const rounded = Math.round(num(value) * 1e6) / 1e6;
  return String(rounded);
}

function billable(line) {
  if (!line || line.item_status === 'Return') return false;
  return num(line.item_quantity ?? line.quantity ?? line.qty) !== 0;
}

function itemLines(sale = {}, branch = {}, _allocation = null, combine = true) {
  const monetary = Money.policy(branch || {});
  const rows = Array.isArray(sale.items) ? sale.items : [];
  const billRows = rows.filter(
    (it) => billable(it) && String(it.name || it.item_name || '').trim()
  );
  const displayed = billRows.map((it) => {
    const qty = num(
      it.quantity != null ? it.quantity : it.item_quantity != null ? it.item_quantity : it.qty
    );
    const rate = num(
      it.unit_price != null
        ? it.unit_price
        : it.item_base_price != null
          ? it.item_base_price
          : it.item_price
    );
    const amount = num(it.total_amount ?? it.total ?? it.item_total ?? rate * qty);
    return {
      name: String(it.name || it.item_name).trim(),
      unit: String(it.item_unit || it.unit || ''),
      ...snapshot(it),
      rate: rate > 0 ? rate.toFixed(monetary.currencyDigits) : '',
      qty: qtyText(qty),
      amount: Money.fromMinor(Money.toMinor(amount, monetary), monetary),
    };
  });
  return combine ? combineBillLines(billRows, displayed, monetary) : displayed;
}

/* A dialable phone number, or an empty placeholder that should not be printed. */
function isDialable(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (/(\d)\1{7,}/.test(digits)) return false;
  return true;
}

function customerLines(sale) {
  const out = [];
  const name = String((sale && sale.customer_name) || '').trim();
  const phone = String((sale && sale.customer_phone) || '').trim();
  if (name && !isWalkIn(name)) out.push(name);
  if (phone && isDialable(phone)) out.push(phone);
  return out;
}

function totalQuantity(branch, items) {
  if (!wants(branch, 'bill_print_total_qty')) return '';
  const qty = (items || []).reduce(
    (sum, it) => sum + num(String(it.qty == null ? '' : it.qty).split(' ')[0]),
    0
  );
  return qty > 0 ? String(Math.round(qty * 1000) / 1000) : '';
}

function buildBillPayload(sale = {}, branch = {}, options = {}) {
  const items = itemLines(sale, branch, null, options.combineItems !== false);
  const subTotal =
    sale.sales_sub_total != null && sale.sales_sub_total !== ''
      ? num(sale.sales_sub_total)
      : items.reduce((sum, it) => sum + num(it.amount), 0);
  const phones = [branch.store_telephone, branch.store_alternativephone]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  const footer = String((branch && branch.footer_print) || '')
    .trim()
    .split(String.fromCharCode(10))
    .slice(0, 4)
    .map((line) => line.trim().slice(0, 64))
    .filter(Boolean)
    .join(String.fromCharCode(10));
  const footerImageCaption = String((branch && branch.footer_image_caption) || '')
    .trim()
    .split(String.fromCharCode(10))
    .slice(0, 2)
    .map((line) => line.trim().slice(0, 64))
    .filter(Boolean)
    .join(String.fromCharCode(10));
  const policy = Money.policy(branch || {});

  return {
    storeName: String(branch.branch_name || sale.branch_name || '').trim(),
    storeAddress: String(branch.store_address || '').trim(),
    storePhone: phones.join(' / '),
    storeEmail: String(branch.store_email || '').trim(),
    fssai:
      wants(branch, 'bill_print_fssai') && branch.branch_fssai_number
        ? String(branch.branch_fssai_number).trim()
        : '',
    footer,
    currencyCode: policy.currencyCode,
    currencyDigits: policy.currencyDigits,
    currency: String((branch && branch.currency) || '')
      .trim()
      .slice(0, 4),
    footerImage: branch && branch.footer_image ? { src: String(branch.footer_image) } : null,
    footerImageCaption,
    title: 'BILL',
    billNo: String(sale.sales_id || '').trim(),
    date: stamp(sale.date || sale.created_at),
    customer: customerLines(sale),
    totalQty: totalQuantity(branch, items),
    items,
    subTotal,
    charges: (sale.charges || []).map((c) => ({ name: c.name, amount: num(c.amount) })),
    discount: num(sale.discount),
    roundOff: num(sale.round_off || sale.sales_round_off),
    total: num(sale.sales_total != null ? sale.sales_total : sale.total),
    serviceRows: [],
    extras: [],
    receiptDocument: receiptDocument(sale, branch, {
      storeName: String(branch.branch_name || sale.branch_name || '').trim(),
      storeAddress: String(branch.store_address || '').trim(),
      date: stamp(sale.date || sale.created_at),
      subTotal,
      total: num(sale.sales_total != null ? sale.sales_total : sale.total),
      discount: num(sale.discount),
      roundOff: num(sale.round_off || sale.sales_round_off),
      items,
      currency: String((branch && branch.currency) || '')
        .trim()
        .slice(0, 4),
    }),
  };
}

function receiptDocument(sale = {}, branch = {}, bill = {}) {
  const doc = {};
  for (const key of [
    'receipt_designs',
    'branch_name',
    'printing_address',
    'store_telephone',
    'store_email',
    'logo',
    'country',
    'website',
    'header_print',
    'footer_print',
    'footer_image',
    'footer_image_caption',
    'footer_qr_url',
    'print_logoimg',
    'customer_print',
    'receipt_barcode',
    'print_sale_notes',
    'print_url',
    'print_type',
    'print_width',
  ]) {
    if (branch[key] !== undefined) doc[key] = branch[key];
  }
  for (const key of [
    'sales_id',
    'created_by',
    'customer_name',
    'customer_phone',
    'customer_address',
    'customer_email',
    'sales_description',
    'payment_mode',
    'payment_status',
    'paid_amount',
    'multi_payment',
    'partial_check',
    'partial_balance',
    'payment_pending',
  ]) {
    if (sale[key] !== undefined) doc[key] = sale[key];
  }
  // The placeholder belongs in the database, not on the printed bill.
  if (isWalkIn(doc.customer_name)) doc.customer_name = '';
  doc.branch_name = bill.storeName;
  doc.printing_address = doc.printing_address || bill.storeAddress;
  doc.created_date = bill.date;
  doc.currency_type = bill.currency;
  doc.items_subtotal = bill.subTotal;
  doc.items_total = bill.total;
  doc.receipt_line_rows = bill.items;
  doc.discount = bill.discount;
  doc.sale_extra_discount = num(sale.sale_extra_discount);
  doc.round_off = bill.roundOff;
  doc.charges = Array.isArray(sale.charges)
    ? sale.charges.map((c) => ({ name: c.name, source: c.source, amount: c.amount }))
    : [];
  doc.items = (sale.items || []).filter(billable).map((item) => ({
    item_name: item.item_name || item.name,
    item_quantity: num(item.item_quantity ?? item.quantity ?? item.qty),
    item_price: num(item.item_price ?? item.unit_price ?? item.item_base_price ?? item.price),
    item_unit: item.item_unit || item.unit || '',
    total_amount: num(item.total_amount ?? item.total ?? item.item_total),
    item_discount: num(item.item_discount),
    item_discount_percentage: num(item.item_discount_percentage),
    ...snapshot(item),
  }));
  return doc;
}

module.exports = { buildBillPayload, receiptDocument, isDialable, itemLines };
