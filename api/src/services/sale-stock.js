'use strict';

/*
 * Stock validation for every sale write.
 *
 * A sale line is quoted in the unit the cashier chose, while the item stores
 * its stock in the base unit. `stockQuantity` converts the requested line to
 * base units; this module then aggregates every line for the same product so
 * two clicks on the same item cannot each pass against the same quantity.
 *
 * The reservation is a condition on the item row itself, not a read followed
 * by an update, so two tills cannot both take the last unit.
 */

const { stockQuantity } = require('../helpers/selling-units');

function isTrue(value) {
  return value === true || value === 'true';
}

function tracksStock(document) {
  return !!document && isTrue(document.track_inventory);
}

function allowsNegative(document) {
  return !!document && isTrue(document.negative_stock);
}

function lineQuantity(line) {
  if (!line) return 0;
  if (line.stock_quantity !== undefined && line.stock_quantity !== null) {
    const quoted = Number(line.stock_quantity);
    if (Number.isFinite(quoted)) return quoted;
  }
  return Number(stockQuantity({ unit_conversion: line.unit_conversion }, line.item_quantity));
}

function aggregate(lines) {
  const requests = new Map();
  for (const line of lines || []) {
    const itemId = line && line.item_id != null ? String(line.item_id) : '';
    if (!itemId) continue;
    const quantity = lineQuantity(line);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const request = requests.get(itemId) || {
      itemId,
      lineId: line.line_id || line.id || itemId,
      quantity: 0,
      itemName: '',
    };
    request.quantity += quantity;
    request.itemName = request.itemName || line.item_name || line.name || '';
    requests.set(itemId, request);
  }
  return requests;
}

function shortage(document, request, latest) {
  const available = Number(
    latest && latest.available_quantity != null
      ? latest.available_quantity
      : document && document.available_quantity
  );
  return {
    item_id: String(request.itemId),
    line_id: request.lineId,
    item_name: (document && document.name) || request.itemName || '',
    requested_quantity: request.quantity,
    available_quantity: Number.isFinite(available) ? available : 0,
  };
}

async function inspect(lines, itemRepository) {
  const shortages = [];
  for (const request of aggregate(lines).values()) {
    const document = await itemRepository.findItemById(request.itemId);
    if (!document || !tracksStock(document) || allowsNegative(document)) continue;
    const available = Number(document.available_quantity);
    if (!Number.isFinite(available) || available + 1e-9 < request.quantity) {
      shortages.push(shortage(document, request, document));
    }
  }
  return shortages;
}

async function release(reservations, itemRepository) {
  for (const reservation of reservations.values()) {
    try {
      await itemRepository.updateStock(reservation.itemId, reservation.quantity, 'sale_rollback');
    } catch (error) {
      /* A failed rollback must not hide the original save failure. The
         periodic sync scan still reports the row, and the caller logs it. */
      console.error('[SALE STOCK] Could not release reservation:', error.message);
    }
  }
  reservations.clear();
}

async function reserve(lines, itemRepository) {
  const reservations = new Map();
  for (const request of aggregate(lines).values()) {
    const document = await itemRepository.findItemById(request.itemId);
    if (!document || !tracksStock(document) || allowsNegative(document)) continue;

    const reserved = await itemRepository.deductStockIfAvailable(document._id, request.quantity);
    if (!reserved) {
      const latest = await itemRepository.findItemById(request.itemId);
      await release(reservations, itemRepository);
      return {
        reservations: new Map(),
        shortages: [shortage(document, request, latest)],
      };
    }

    const remaining = Number(reserved.available_quantity);
    reservations.set(request.itemId, {
      itemId: document._id,
      quantity: request.quantity,
      opening: remaining + request.quantity,
      closing: remaining,
    });
  }
  return { reservations, shortages: [] };
}

function message(shortages) {
  const first = (shortages || [])[0];
  if (!first) return 'Stock is no longer available. Please refresh the item and try again.';
  const available = Number(first.available_quantity);
  const name = first.item_name || 'This item';
  if (Number.isFinite(available) && available > 0) {
    return `${name} only has ${available} left. Refresh the item and try again.`;
  }
  return `${name} is out of stock. Refresh the item and try again.`;
}

module.exports = {
  aggregate,
  allowsNegative,
  inspect,
  lineQuantity,
  message,
  release,
  reserve,
  tracksStock,
};
