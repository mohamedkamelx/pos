'use strict';
const { BadRequestError } = require('../utils/appError');
module.exports = function salesListCriteria(query, user) {
  const clauses = [];
  if (query.seller || query.customerLookup) {
    for (const [key, field] of [
      ['seller', 'user_id'],
      ['customerLookup', 'customer_id'],
    ]) {
      if (!query[key]) continue;
      const id = key === 'seller' && query[key] === 'me' ? String(user._id || user.id) : query[key];
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))
        throw new BadRequestError('Invalid filter ID');
      const source =
        key === 'seller' ? require('../helpers/sales-history-options').sellerIdentity : '$' + field;
      clauses.push({
        $expr: {
          $eq: [{ $convert: { input: source, to: 'string', onError: '', onNull: '' } }, id],
        },
      });
    }
  }
  return clauses;
};
