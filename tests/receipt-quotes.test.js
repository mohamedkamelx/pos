const test = require('node:test');
const assert = require('node:assert/strict');
const { select } = require('../api/src/helpers/receipt-quote');

test('quote selection defaults off, follows bill sequence and wraps', () => {
  assert.equal(select(undefined, 'S1'), null);
  assert.equal(select({ source: 'none' }, 'S1'), null);
  const p = { source: 'custom', order: 'sequential', quotes: ['One', 'Two'] };
  assert.equal(select(p, 'SB1D44-27-000001').text, 'One');
  assert.equal(select(p, 'SB1D44-27-000002').text, 'Two');
  assert.equal(select(p, 'SB1D44-27-000003').text, 'One');
  assert.equal(select(p, 'pending'), null);
});
test('saved selection survives settings changes, disablement and retries', () => {
  const p = { source: 'custom', order: 'random', quotes: ['First', 'Second'] };
  const saved = select(p, 'S123');
  assert.ok(['First', 'Second'].includes(saved.text));
  assert.deepEqual(select(p, 'S123'), saved);
  assert.deepEqual(select({ source: 'none' }, 'S123', saved), saved);
  assert.equal(select(p, 'S123', null), null); // old bills stay unchanged
});
