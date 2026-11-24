'use strict';

/*
 * Make every sale line's `company_price_total` the cost of the WHOLE line.
 *
 * The Node till used to put the per-unit cost in that field, while legacy PHP
 * sales put the line total there and reports trusted whichever they found.
 * The result was a 3 x 900 line reported as 900 of cost instead of 2,700.
 *
 * New sales are written as line totals from now on. This migration rewrites
 * the Node rows written before that change. It is deliberately limited to
 * sales this till created (idempotency key / submission hash); imported PHP
 * rows already hold totals and are left untouched.
 */

const round = (value, decimals = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
};

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const quantityOf = (line = {}) =>
  numberOrNull(line.quantity) ??
  numberOrNull(line.item_quantity) ??
  numberOrNull(line.qty) ??
  numberOrNull(line.number_of_items) ??
  0;

const near = (a, b) => Math.abs(a - b) <= 0.011;

function lineTotalToLineCost(line, treatAsUnit) {
  const quantity = quantityOf(line);
  const stored = numberOrNull(line.company_price_total);
  const existingUnit = numberOrNull(line.unit_company_price);
  let total;

  if (treatAsUnit && stored !== null) {
    // Old Node shape: the stored number was one unit's cost.
    total = stored * quantity;
  } else if (stored !== null) {
    // PHP shape and new Node shape: already a line total.
    total = stored;
  } else if (existingUnit !== null) {
    total = existingUnit * quantity;
  } else {
    const unit = numberOrNull(line.company_price) ?? numberOrNull(line.item_company_price) ?? 0;
    total = unit * quantity;
  }

  return {
    ...line,
    company_price_total: round(total, 2),
    unit_company_price: quantity > 0 ? round(total / quantity, 4) : round(existingUnit ?? 0, 4),
  };
}

module.exports = async function saleLineCostTotal(db) {
  if (!db) throw new Error('sale-line-cost-total needs a database handle');

  const sales = db.collection('sales');
  const cursor = sales.find(
    {
      $or: [
        { idempotency_key: { $exists: true, $nin: [null, ''] } },
        { submission_payload_hash: { $exists: true, $nin: [null, ''] } },
      ],
      company_cost_basis: { $ne: 'line-total' },
    },
    {
      projection: {
        items: 1,
        items_return: 1,
        total_companyprice: 1,
        sale_process: 1,
      },
    }
  );

  let operations = [];
  const flush = async () => {
    if (!operations.length) return;
    await sales.bulkWrite(operations, { ordered: false });
    operations = [];
  };

  for await (const sale of cursor) {
    const lines = Array.isArray(sale.items) ? sale.items : [];
    if (!lines.length) {
      // A fully returned sale has no remaining cost to repair, but mark it so
      // a later run does not revisit it forever.
      operations.push({
        updateOne: {
          filter: { _id: sale._id },
          update: { $set: { company_cost_basis: 'line-total' } },
        },
      });
      if (operations.length >= 400) await flush();
      continue;
    }

    const sumStored = lines.reduce(
      (sum, line) => sum + (numberOrNull(line.company_price_total) ?? 0),
      0
    );
    const sumQuantityCost = lines.reduce((sum, line) => {
      const stored = numberOrNull(line.company_price_total) ?? 0;
      return sum + stored * quantityOf(line);
    }, 0);
    const storedDocumentTotal =
      numberOrNull(sale.total_companyprice) ?? numberOrNull(sale.total_company_price);
    const isReturnDocument = ['PartialReturn', 'FullReturn'].includes(sale.sale_process);

    /*
     * A return rewrites its remaining lines with real totals, so never scale
     * those again. For ordinary old Node sales, the document total matched
     * the sum of the per-unit fields, not the quantity-extended sum.
     */
    const quantitiesChangeTheAnswer = !near(sumStored, sumQuantityCost);
    const storedMatchesUnits = storedDocumentTotal === null || near(storedDocumentTotal, sumStored);
    const treatAsUnit = !isReturnDocument && quantitiesChangeTheAnswer && storedMatchesUnits;

    const repairedItems = lines.map((line) => lineTotalToLineCost(line, treatAsUnit));
    const totalCompanyPrice = round(
      repairedItems.reduce((sum, line) => sum + (numberOrNull(line.company_price_total) ?? 0), 0),
      2
    );

    const update = {
      $set: {
        items: repairedItems,
        total_companyprice: totalCompanyPrice,
        company_cost_basis: 'line-total',
      },
    };

    // Return blocks are already line totals. Give their lines the unit value
    // so an edit or a future report never has to infer it from quantity.
    if (Array.isArray(sale.items_return) && sale.items_return.length) {
      update.$set.items_return = sale.items_return.map((block) => {
        if (!block || !block.returnArray) return block;
        const values = Array.isArray(block.returnArray.returnValue)
          ? block.returnArray.returnValue
          : [];
        return {
          ...block,
          returnArray: {
            ...block.returnArray,
            returnValue: values.map((line) => lineTotalToLineCost(line, false)),
          },
        };
      });
    }

    operations.push({
      updateOne: {
        filter: { _id: sale._id },
        update,
      },
    });
    if (operations.length >= 400) await flush();
  }

  await flush();
};
