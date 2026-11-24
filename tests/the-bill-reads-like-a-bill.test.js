/*
 * THE COUNT BELONGS WITH THE MONEY, NOT IN THE HEADER.
 *
 * Total quantity is part of the arithmetic - how many things, what they came
 * to - so it prints immediately above the subtotal, where the guest checks
 * the money.
 */

const test = require('node:test');
const assert = require('node:assert');

const { renderSale } = require('../src/escpos-receipt');
const { parse, asLines } = require('../src/escpos-preview');

const SALE = {
  shopName: 'Azure Coastal Store',
  title: 'BILL',
  billNo: 'SB1D19-27-000001',
  date: '16/09/2026 18:50',
  totalQty: '5',
  items: [{ name: 'Pallipalayam Chicken', rate: '280.00', qty: '1', amount: '280.00' }],
  subTotal: 2290,
  total: 2404.5,
};

const linesOf = (sale, width = '80') => asLines(parse(renderSale(sale, { paperWidth: width })));

test('THE COUNT PRINTS IMMEDIATELY ABOVE THE SUBTOTAL', () => {
  const lines = linesOf(SALE);
  const qtyAt = lines.findIndex((l) => /Total Quantity/.test(l));
  const subtotalAt = lines.findIndex((l) => /Subtotal/.test(l));

  assert.notStrictEqual(qtyAt, -1, 'the total quantity stopped printing altogether');
  assert.notStrictEqual(subtotalAt, -1, 'the subtotal is gone');
  assert.ok(qtyAt < subtotalAt, 'the count should sit immediately above the subtotal it belongs to');
  assert.strictEqual(subtotalAt - qtyAt, 1, 'something was printed between the count and the subtotal');
});

test('AND IT LINES UP WITH THE QUANTITIES IT TOTALS', () => {
  /*
   * Owner, on a printed bill: "total quantity just make it same alignment of
   * quantity column. not to the last. i think its better."
   *
   * A count printed hard against the right edge sits under AMOUNT - the one
   * column on a bill where a number must not be mistaken for money. Under the
   * quantities it is obviously a count of them.
   *
   * Asserted by column index rather than by eye, because a layout that looks
   * right in one sample and drifts on another is exactly what this grid was
   * rebuilt to stop.
   */
  const lines = linesOf({
    ...SALE,
    items: [
      { name: 'Pallipalayam Chicken', rate: '280.00', qty: '1', amount: '280.00' },
      { name: 'Sunset Cooler', rate: '130.00', qty: '2', amount: '260.00' },
    ],
  });

  const itemRow = lines.find((l) => /Sunset Cooler/.test(l));
  const totalRow = lines.find((l) => /Total Quantity/.test(l));
  assert.ok(itemRow && totalRow, 'the rows this compares are not both printed');

  const itemQtyAt = itemRow.indexOf('2', itemRow.indexOf('130.00'));
  const totalQtyAt = totalRow.lastIndexOf('5');
  assert.strictEqual(
    totalQtyAt,
    itemQtyAt,
    'the total sits in a different column from the quantities it adds up:' +
      String.fromCharCode(10) + itemRow + String.fromCharCode(10) + totalRow
  );

  /*
   * And emphatically NOT in the money column. Compared against the subtotal's
   * own digits rather than against the end of the string: the preview trims
   * trailing spaces, so "last character" is not "right edge of the paper".
   */
  const subtotalRow = lines.find((l) => /Subtotal/.test(l));
  assert.ok(subtotalRow, 'there is no subtotal to compare against');
  assert.notStrictEqual(
    totalQtyAt,
    subtotalRow.length - 1,
    'the count is back under the amount column, where it reads as money'
  );
});

test('a sale without a total quantity prints no count', () => {
  const bare = { ...SALE, totalQty: '' };
  const lines = linesOf(bare);
  assert.ok(!lines.some((l) => /Total Quantity/.test(l)), 'an empty total quantity still printed');
  assert.ok(lines.some((l) => /Subtotal/.test(l)), 'the bill stopped printing its subtotal');
});
