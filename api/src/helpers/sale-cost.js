'use strict';

/*
 * The Mongo conversion expression sales.helper also exposes. It lives here so
 * a repository can price sale lines without loading the whole sales helper,
 * which pulls in the user model and its mongoose schema as a side effect.
 */
const toNumberExpression = (expression, fallback = 0) => ({
  $convert: {
    input: expression,
    to: 'double',
    onError: fallback,
    onNull: fallback,
  },
});

/*
 * What a sale line cost.
 *
 * `company_price_total` is the cost of the WHOLE line: quantity x unit cost.
 * It has not always meant that. Sales written by the Node till used to carry
 * the per-unit cost in this field while legacy PHP sales carried the line
 * total, so a report could not tell 3 x 900 from one 900 line. The sale write
 * path now stores the line total, the migration that ships with it rewrites
 * the old Node rows, and every report reads it the same way here.
 *
 * A missing field falls back to the item's unit cost x quantity. Zero is a
 * real value and is preserved: a free line has no cost, not an unknown one.
 */
function lineQuantityExpression(prefix = '$items') {
  return toNumberExpression({
    $ifNull: [
      `${prefix}.quantity`,
      {
        $ifNull: [
          `${prefix}.item_quantity`,
          {
            $ifNull: [`${prefix}.qty`, { $ifNull: [`${prefix}.number_of_items`, 0] }],
          },
        ],
      },
    ],
  });
}

function lineCostExpression({ prefix = '$items', fallbackUnit = null, legacyAware = false } = {}) {
  const quantity = lineQuantityExpression(prefix);
  const storedTotal = { $ifNull: [`${prefix}.company_price_total`, null] };
  const legacyUnit = {
    $ifNull: [
      `${prefix}.company_price`,
      {
        $ifNull: [`${prefix}.item_company_price`, fallbackUnit === null ? 0 : fallbackUnit],
      },
    ],
  };

  if (!legacyAware) {
    return {
      $cond: [
        { $ne: [storedTotal, null] },
        toNumberExpression(storedTotal),
        { $multiply: [quantity, toNumberExpression(legacyUnit)] },
      ],
    };
  }

  /*
   * Some old Node sales stored one unit's cost in company_price_total. The
   * migration marks repaired rows with company_cost_basis='line-total'; until
   * a row is repaired, a Node-marked sale with no basis is treated as a unit
   * cost. Legacy PHP rows have no Node marker and already store a line total.
   *
   * Prefer an explicit unit_company_price whenever it exists. New sales write
   * both the unit and the line total, so the basis check uses the line total
   * and preserves its exact rounded value.
   */
  const storedUnit = { $ifNull: [`${prefix}.unit_company_price`, null] };
  const unitCost = { $ifNull: [storedUnit, legacyUnit] };
  const lineTotalBasis = {
    $eq: [{ $ifNull: ['$company_cost_basis', ''] }, 'line-total'],
  };
  const nodeSale = {
    $or: [
      { $ne: [{ $ifNull: ['$idempotency_key', ''] }, ''] },
      { $ne: [{ $ifNull: ['$submission_payload_hash', ''] }, ''] },
    ],
  };

  return {
    $cond: [
      lineTotalBasis,
      {
        $cond: [
          { $ne: [storedTotal, null] },
          toNumberExpression(storedTotal),
          { $multiply: [quantity, toNumberExpression(unitCost)] },
        ],
      },
      {
        $cond: [
          { $ne: [storedUnit, null] },
          { $multiply: [quantity, toNumberExpression(storedUnit)] },
          {
            $cond: [
              { $ne: [storedTotal, null] },
              {
                $cond: [
                  nodeSale,
                  { $multiply: [quantity, toNumberExpression(storedTotal)] },
                  toNumberExpression(storedTotal),
                ],
              },
              { $multiply: [quantity, toNumberExpression(unitCost)] },
            ],
          },
        ],
      },
    ],
  };
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lineQuantity(line = {}) {
  return (
    numeric(line.quantity) ??
    numeric(line.item_quantity) ??
    numeric(line.qty) ??
    numeric(line.number_of_items) ??
    0
  );
}

/** JavaScript twin of lineCostExpression, for migrations and summaries. */
function lineCost(line = {}) {
  const storedTotal = numeric(line.company_price_total);
  if (storedTotal !== null) return storedTotal;
  const unit = numeric(line.company_price) ?? numeric(line.item_company_price) ?? 0;
  return lineQuantity(line) * unit;
}

module.exports = {
  lineQuantityExpression,
  lineCostExpression,
  lineQuantity,
  lineCost,
};
