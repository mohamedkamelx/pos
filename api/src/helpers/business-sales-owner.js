'use strict';
const { recordedUserName } = require('../utils/recorded-user-name');

const identity = (value) => {
  if (value && typeof value.toHexString === 'function') return value.toHexString();
  return typeof value === 'string' ? value.trim().slice(0, 254) : '';
};

/** Prefer the original order taker; payment and handover must not change it. */
module.exports = function businessSalesOwner(sale) {
  const candidates = [
    [identity(sale.user_id), recordedUserName(sale.user_name)],
    [identity(sale.created_by_id), recordedUserName(sale.created_by)],
    [identity(sale.origin?.actor_id), recordedUserName(sale.origin?.actor_name)],
  ];
  const id = candidates.find(([candidateId]) => candidateId)?.[0] || '';
  const name =
    candidates.find(
      ([candidateId, candidateName]) => candidateName && (!candidateId || !id || candidateId === id)
    )?.[1] || '';
  // An identity without a name must not inherit a later cashier's display name.
  return {
    id: id || (name ? `name:${name}` : 'unassigned'),
    name: name ? name.slice(0, 254) : id ? 'Staff name unavailable' : 'Unassigned',
  };
};
