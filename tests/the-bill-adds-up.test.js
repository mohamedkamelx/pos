'use strict';

/*
 * A bill has to agree with itself.
 *
 * The numbers a customer checks are the rate, the quantity and the line
 * amount, the subtotal those lines add up to, and the final payable. The bill
 * carries the price the sale was saved with; it does not invent a new one while
 * it is being printed.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { renderSale } = require(path.join(ROOT, 'src', 'escpos-receipt.js'));
const { buildBillPayload } = require(path.join(ROOT, 'api', 'src', 'helpers', 'bill-payload.js'));

const SALE = {
  sales_id: 'SB1D14-000051',
  date: new Date('2026-09-14T11:35:00Z'),
  customer_name: 'Ramesh Kumar',
  items: [
    { name: 'Sona Masoori Rice', item_quantity: 2, item_base_price: 120 },
    { name: 'Cooking Oil', item_quantity: 3, item_base_price: 45 },
  ],
  sales_sub_total: 375,
  sales_total: 375,
};
const BRANCH = { branch_name: 'Sri Balaji Stores' };

/*
 * What actually comes off the roll, printer commands stripped.
 *
 * The commands have to be PARSED, not filtered by byte range: `ESC a 1` is
 * 0x1b 0x61 0x01, and 0x61 is a perfectly printable lowercase a. Dropping only
 * the control bytes leaves a stray letter glued to the front of the next line,
 * which then measures one character too wide and fails an overflow check that
 * has nothing wrong with it.
 */
const ARGS = { 0x40: 0, 0x74: 1, 0x61: 1, 0x45: 1, 0x64: 1, 0x70: 3 }; // after ESC
const GS_ARGS = { 0x21: 1, 0x56: 2 }; //                                 after GS

function paper(payload) {
  const bytes = renderSale(payload, { paperWidth: '48' });
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 0x1b || b === 0x1d) {
      const table = b === 0x1b ? ARGS : GS_ARGS;
      const cmd = bytes[i + 1];
      i += 1 + (table[cmd] == null ? 1 : table[cmd]);
      continue;
    }
    if (b === 10) text += '\n';
    else if (b >= 32 && b <= 126) text += String.fromCharCode(b);
  }
  return text;
}

/* ----------------------------------------------------------- the arithmetic */

test('THE LINE MULTIPLIES OUT, and it multiplies out to the subtotal', () => {
  const bill = buildBillPayload(SALE, BRANCH);
  for (const it of bill.items) {
    const rate = Number(it.rate);
    const qty = Number(String(it.qty).split(' ')[0]);
    assert.ok(rate > 0, it.name + ' printed no unit price, the number a customer checks');
    assert.strictEqual(
      Math.round(rate * qty * 100) / 100,
      Number(it.amount),
      it.name + ': ' + rate + ' x ' + qty + ' does not come to ' + it.amount
    );
  }
  const summed = bill.items.reduce((s, it) => s + Number(it.amount), 0);
  assert.strictEqual(
    Math.round(summed * 100) / 100,
    bill.subTotal,
    'the lines do not add up to the subtotal printed under them'
  );
});

test('the rate is the stored unit price, not the line total', () => {
  const bill = buildBillPayload(SALE, BRANCH);
  const rice = bill.items.find((i) => i.name === 'Sona Masoori Rice');
  assert.strictEqual(rice.rate, '120.00', 'the rate is not the saved unit price');
  assert.strictEqual(rice.amount, 240, 'the line amount is not rate times quantity');
});

test('the saved final price is the total printed on the bill', () => {
  const bill = buildBillPayload(SALE, BRANCH);
  assert.strictEqual(bill.total, SALE.sales_total, 'the bill recomputed a price the sale did not have');
  assert.strictEqual(bill.taxes, undefined, 'the bill invented tax fields the sale did not record');
  assert.deepStrictEqual(bill.charges, [], 'the bill invented charges the sale did not record');
});

test('the rate reaches the paper, under a column that says what it is', () => {
  const text = paper({ ...buildBillPayload(SALE, BRANCH), title: 'BILL' });
  assert.match(text, /ITEM\s+RATE\s+QUANTITY\s+AMOUNT/, 'the rate column is not headed');
  assert.match(
    text,
    /Sona Masoori Rice\s+120\.00\s+2\s+240\.00/,
    'the line does not read as rate, quantity, amount'
  );
  assert.match(text, /Subtotal\s+375\.00/);
  assert.match(text, /TOTAL\s+375\.00/);
});

/* ------------------------------------------------- what it no longer prints */

test('it does not say UNPAID', () => {
  assert.ok(!/UNPAID/.test(paper({ ...buildBillPayload(SALE, BRANCH), title: 'BILL' })));
});

test('it does not say where the order came from', () => {
  const bill = buildBillPayload(SALE, BRANCH);
  assert.strictEqual(bill.source, undefined, 'the payload still carries a source');
  assert.ok(!/From:/.test(paper({ ...bill, title: 'BILL' })));
});

test('it does not carry service rows the sale never asked for', () => {
  const bill = buildBillPayload(SALE, BRANCH);
  const text = paper({ ...bill, title: 'BILL' });
  assert.deepStrictEqual(bill.serviceRows, [], 'the bill still carries the shop rows');
  assert.strictEqual(bill.itemCount, undefined);
  for (const gone of [/Table/, /Order type/, /Covers/, /No\. of items/, /Steward/]) {
    assert.ok(!gone.test(text), 'the bill still prints ' + gone);
  }
});

/* ------------------------------------------------ and receipts are untouched */

test('a receipt with no rates prints exactly as it did, no empty column', () => {
  /*
   * itemTable is shared. A counter receipt passes no rate, and reserving five
   * characters of a 48-character line to head a column of blanks would be a
   * regression paid for by every shop.
   */
  const text = paper({
    title: 'RECEIPT',
    billNo: 'SB1D14-000052',
    items: [{ name: 'Sona Masoori Rice', qty: '5 kg', amount: 480 }],
    subTotal: 480,
    total: 480,
  });
  assert.ok(!/RATE/.test(text), 'a receipt with no rates grew a rate column');
  assert.match(text, /Sona Masoori Rice\s+5 kg\s+480/, 'the receipt line stopped laying out');
});

test('no line is wider than the paper', () => {
  /* A line one character too long wraps on the printer and takes the column
     with it, which is how a tidy table becomes unreadable on real paper. */
  const text = paper({ ...buildBillPayload(SALE, BRANCH), title: 'BILL' });
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 48, 'overflows the roll: ' + JSON.stringify(line));
  }
});

test('nothing from the bill leaks into a plain counter receipt', () => {
  const text = paper({
    title: 'RECEIPT',
    billNo: 'SB1D15-000100',
    items: [{ name: 'Sona Masoori Rice', qty: '5 kg', amount: 480 }],
    subTotal: 480,
    total: 480,
  });
  for (const gone of [/From:/, /Table/, /Covers/, /Session/]) {
    assert.ok(!gone.test(text), 'a plain receipt grew ' + gone);
  }
});
