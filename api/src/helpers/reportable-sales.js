'use strict';

const { GRAPH_ALLOWED_SALE_PROCESSES } = require('../constants/sales.constants');

/**
 * Posted retail sales keep their existing report semantics. Do not infer
 * settlement from a tender method. The nested $and composes safely with
 * report-specific $or filters.
 */
function reportableSales(processes = GRAPH_ALLOWED_SALE_PROCESSES) {
  return {
    $and: [
      {
        $or: [{ sale_process: { $in: [...processes] } }],
      },
      { payment_status: { $ne: 'Cancelled' } },
    ],
  };
}

// The saved payable total is authoritative. Older item-total snapshots can
// be absent or stale after editing a sale. Preserve zero and use legacy aliases
// only when the canonical bill total is absent.
function reportSaleTotal() {
  const original = {
    $ifNull: ['$sales_total', { $ifNull: ['$total', { $ifNull: ['$items_total', 0] }] }],
  };
  return {
    $toDouble: {
      $cond: [
        { $in: ['$sale_process', ['PartialReturn', 'FullReturn']] },
        { $ifNull: ['$items_total', original] },
        original,
      ],
    },
  };
}

// Tax totals are read from the stored sale. Older imports used more than one
// spelling, and a return is already stored with its own sign - do not negate a
// second time. Missing values contribute zero instead of failing the whole
// dashboard aggregation.
function reportSaleTax() {
  const value = {
    $ifNull: ['$tax_amount', { $ifNull: ['$sales_tax', { $ifNull: ['$total_tax', 0] }] }],
  };
  return { $convert: { input: value, to: 'double', onError: 0, onNull: 0 } };
}

// Returns retain the original invoice for the audit ledger. Remaining-item
// views and net sales reports must use the separately persisted balance.
function remainingSaleTotal(sale) {
  if (['PartialReturn', 'FullReturn'].includes(sale.sale_process) && sale.items_total != null)
    return sale.items_total;
  return sale.sales_total ?? sale.total ?? sale.items_total ?? 0;
}

module.exports = { reportableSales, reportSaleTotal, reportSaleTax, remainingSaleTotal };
