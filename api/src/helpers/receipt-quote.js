const crypto = require('crypto');

// No shared counter: offline tills follow their existing bill-number sequence.
// Persist this snapshot with the sale, so later settings edits cannot alter it.
function select(policy, saleNumber, existing) {
  if (existing !== undefined) return existing;
  if (!policy || policy.source !== 'custom' || !Array.isArray(policy.quotes)) return null;
  const entries = policy.quotes
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => ({ text: q.trim() }));
  if (!entries.length) return null;
  const sequence = String(saleNumber || '').match(/(\d+)$/);
  if (!saleNumber || (policy.order === 'sequential' && !sequence)) return null;
  const index =
    policy.order === 'sequential'
      ? Number((BigInt(sequence[1]) + BigInt(entries.length) - 1n) % BigInt(entries.length))
      : crypto.createHash('sha256').update(String(saleNumber)).digest().readUInt32BE(0) %
        entries.length;
  return { source: 'custom', version: '2026-11-20', ...entries[index] };
}

module.exports = { select };
