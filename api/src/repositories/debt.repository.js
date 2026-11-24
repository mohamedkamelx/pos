// src/repositories/debt.repository.js
//
// Party debt is derived, never copied.
//
// A customer's debt is the unpaid balance already held on their sales; a
// supplier's is the unpaid balance held on received purchases.  Payments made
// after the document was saved live in `party_payments` and are subtracted at
// read time.  Keeping the ledger separate means an old sale or purchase is
// never rewritten by a collection: its total, the amount paid at the counter
// and its original payment status stay exactly as the day it was saved.
//
// The field names below are deliberately tolerant.  Sales written by this
// codebase and purchases written by the legacy PHP importer do not agree on
// `balance` / `payment_pending` / `due_amount`, and a shop upgrading in place
// has both shapes in the same collection.
const BaseModel = require('../models/base.model');
const { ObjectId } = require('mongodb');

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const firstNumber = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

/* The same unpaid-balance rules the aggregation uses, in JavaScript, for the
 * handful of documents a collection touches. Keeping the two in step matters:
 * the list says a sale owes 100, the payment allocates 100, and the document
 * must end at zero. */
const customerSaleDue = (doc = {}) => {
  const status = String(doc.payment_status || '').toLowerCase();
  if (status === 'paid' || status === 'completed') return 0;
  const total = firstNumber(
    doc.total,
    doc.total_amount,
    doc.sales_total,
    doc.items_total,
    doc.grand_total
  );
  const paid = firstNumber(doc.paid_amount, doc.partial_balance);
  const pending = firstNumber(doc.payment_pending);
  const balance = firstNumber(doc.balance);
  const due = firstNumber(doc.due_amount);
  if (pending > 0) return roundMoney(pending);
  if (balance > 0) return roundMoney(balance);
  if (due > 0) return roundMoney(due);
  const hasExplicit =
    Object.prototype.hasOwnProperty.call(doc, 'payment_pending') ||
    Object.prototype.hasOwnProperty.call(doc, 'balance') ||
    Object.prototype.hasOwnProperty.call(doc, 'due_amount');
  const unpaidStatus = ['unpaid', 'pending', 'partialy paid', 'partially paid'].includes(status);
  if (hasExplicit || unpaidStatus) return roundMoney(Math.max(0, total - paid));
  return 0;
};

const supplierReceivingDue = (doc = {}) => {
  const status = String(doc.payment_status || '').toLowerCase();
  if (status === 'paid' || status === 'completed') return 0;
  const amount = firstNumber(
    doc.invoice_total_declared,
    doc.total_amount,
    doc.items_total,
    doc.grand_total,
    doc.total
  );
  const paid = firstNumber(doc.paid_amount, doc.advance_amount);
  const balance = firstNumber(doc.balance);
  const due = firstNumber(doc.due_amount);
  if (balance > 0) return roundMoney(balance);
  if (due > 0) return roundMoney(due);
  // A zero balance left by the schema default is not proof that an old
  // purchase was settled. The amount actually paid is the only reliable
  // signal when the document predates paid_amount/balance.
  return roundMoney(Math.max(0, amount - paid));
};

const numeric = (expression) => ({
  $convert: {
    input: expression,
    to: 'double',
    onError: 0,
    onNull: 0,
  },
});

const nullableNumeric = (expression) => ({
  $convert: {
    input: expression,
    to: 'double',
    onError: null,
    onNull: null,
  },
});

const firstNumeric = (...fields) => {
  const expressions = fields.map((field) => nullableNumeric(field));
  return expressions.reduceRight((fallback, current) => ({ $ifNull: [current, fallback] }), 0);
};

const dateValue = (...fields) => {
  const converted = fields.map((field) => ({
    $convert: {
      input: field,
      to: 'date',
      onError: null,
      onNull: null,
    },
  }));
  return converted.reduceRight((fallback, current) => ({ $ifNull: [current, fallback] }), null);
};

class DebtRepository extends BaseModel {
  constructor() {
    super('party_payments');
  }

  licenseValues() {
    const license = BaseModel.license;
    if (!license) return [];
    const values = [license];
    const text = String(license);
    if (text && text !== '[object Object]' && text !== license) values.push(text);
    if (ObjectId.isValid(text)) {
      const objectId = new ObjectId(text);
      if (!values.some((value) => value instanceof ObjectId && value.equals(objectId))) {
        values.push(objectId);
      }
    }
    return values;
  }

  branchValues(branchIds = []) {
    const values = [];
    for (const id of branchIds || []) {
      if (!id) continue;
      if (id instanceof ObjectId) {
        values.push(id);
        continue;
      }
      const text = String(id);
      if (ObjectId.isValid(text)) values.push(new ObjectId(text));
      values.push(text);
    }
    return values;
  }

  branchCondition(branchIds = []) {
    const values = this.branchValues(branchIds);
    if (!values.length) return {};
    // Legacy rows without a branch belong to the shop, not to another outlet.
    // They remain visible to a permitted report reader so an upgrade cannot
    // silently hide money that is genuinely owed.
    return {
      $or: [{ branch_id: { $in: values } }, { branch_id: null }, { branch_id: { $exists: false } }],
    };
  }

  baseMatch(branchIds = []) {
    const licenses = this.licenseValues();
    const match = {};
    if (licenses.length) match.license = { $in: licenses };
    const branch = this.branchCondition(branchIds);
    if (branch.$or) match.$and = [branch];
    return match;
  }

  customerBalanceExpression() {
    return {
      $let: {
        vars: {
          pending: numeric('$payment_pending'),
          balance: numeric('$balance'),
          due: numeric('$due_amount'),
          total: firstNumeric(
            '$total',
            '$total_amount',
            '$sales_total',
            '$items_total',
            '$grand_total'
          ),
          paid: firstNumeric('$paid_amount', '$partial_balance'),
          status: { $toLower: { $ifNull: ['$payment_status', ''] } },
          hasExplicit: {
            $or: [
              { $ne: [{ $type: '$payment_pending' }, 'missing'] },
              { $ne: [{ $type: '$balance' }, 'missing'] },
              { $ne: [{ $type: '$due_amount' }, 'missing'] },
            ],
          },
        },
        in: {
          $round: [
            {
              $cond: [
                { $in: ['$$status', ['paid', 'completed']] },
                0,
                {
                  $cond: [
                    { $gt: ['$$pending', 0] },
                    '$$pending',
                    {
                      $cond: [
                        { $gt: ['$$balance', 0] },
                        '$$balance',
                        {
                          $cond: [
                            { $gt: ['$$due', 0] },
                            '$$due',
                            {
                              $cond: [
                                {
                                  $or: [
                                    '$$hasExplicit',
                                    {
                                      $in: [
                                        '$$status',
                                        ['unpaid', 'pending', 'partialy paid', 'partially paid'],
                                      ],
                                    },
                                  ],
                                },
                                { $max: [0, { $subtract: ['$$total', '$$paid'] }] },
                                0,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            2,
          ],
        },
      },
    };
  }

  supplierAmountExpression() {
    // The printed invoice total is what the supplier is owed. Older rows do
    // not have it and fall back to the computed line/charge total.
    return firstNumeric(
      '$invoice_total_declared',
      '$total_amount',
      '$items_total',
      '$grand_total',
      '$total'
    );
  }

  supplierBalanceExpression() {
    return {
      $let: {
        vars: {
          amount: this.supplierAmountExpression(),
          paid: firstNumeric('$paid_amount', '$advance_amount'),
          balance: numeric('$balance'),
          due: numeric('$due_amount'),
          status: { $toLower: { $ifNull: ['$payment_status', ''] } },
        },
        in: {
          $round: [
            {
              $cond: [
                { $in: ['$$status', ['paid', 'completed']] },
                0,
                {
                  $cond: [
                    { $gt: ['$$balance', 0] },
                    '$$balance',
                    {
                      $cond: [
                        { $gt: ['$$due', 0] },
                        '$$due',
                        // A schema default of zero is not a settled purchase.
                        // Without a positive balance/due, amount minus paid is
                        // the only honest reading of an old document.
                        { $max: [0, { $subtract: ['$$amount', '$$paid'] }] },
                      ],
                    },
                  ],
                },
              ],
            },
            2,
          ],
        },
      },
    };
  }

  customerInvoiceAggregation(branchIds = [], includeSettled = false) {
    const match = this.baseMatch(branchIds);
    match.is_deleted = { $ne: true };
    match.sale_process = { $in: ['Add', 'Edit', 'PartialReturn'] };
    const stages = [
      { $match: match },
      {
        $project: {
          _id: 1,
          customer_id: 1,
          customer_name: { $ifNull: ['$customer_name', ''] },
          customer_phone: { $ifNull: ['$customer_phone', ''] },
          customer_email: { $ifNull: ['$customer_email', ''] },
          number: { $ifNull: ['$sales_id', { $toString: '$_id' }] },
          date: dateValue('$created_date', '$updated_date'),
          total: firstNumeric(
            '$total',
            '$total_amount',
            '$sales_total',
            '$items_total',
            '$grand_total'
          ),
          paid: firstNumeric('$paid_amount', '$partial_balance'),
          balance: this.customerBalanceExpression(),
          payment_status: { $ifNull: ['$payment_status', ''] },
        },
      },
      { $match: { customer_id: { $ne: null } } },
    ];
    if (!includeSettled) stages.push({ $match: { balance: { $gt: 0.004 } } });
    stages.push({ $sort: { date: 1, _id: 1 } });
    return stages;
  }

  supplierInvoiceAggregation(branchIds = [], includeSettled = false) {
    const match = this.baseMatch(branchIds);
    match.is_deleted = { $ne: true };
    match.$and = match.$and || [];
    match.$and.push({
      $or: [
        {
          receiving_status: {
            $in: ['Received', 'received', 'PartialReturn', 'partialreturn', 'Partial', 'partial'],
          },
        },
        {
          receiving_status: { $exists: false },
          status: { $in: ['Received', 'received', 'PartialReturn', 'partialreturn'] },
        },
        {
          receiving_status: { $exists: false },
          status: { $exists: false },
        },
      ],
    });
    const stages = [
      { $match: match },
      {
        $project: {
          _id: 1,
          supplier_id: { $ifNull: ['$supplier_id', '$supplier'] },
          supplier_name: { $ifNull: ['$supplier_name', ''] },
          supplier_phone: { $ifNull: ['$supplier_phone', ''] },
          supplier_email: { $ifNull: ['$supplier_email', ''] },
          number: {
            $ifNull: ['$receiving_id', { $ifNull: ['$receiving_number', { $toString: '$_id' }] }],
          },
          date: dateValue('$created_date', '$date', '$updated_date'),
          total: this.supplierAmountExpression(),
          paid: firstNumeric('$paid_amount', '$advance_amount'),
          balance: this.supplierBalanceExpression(),
          payment_status: { $ifNull: ['$payment_status', ''] },
        },
      },
      { $match: { supplier_id: { $ne: null } } },
    ];
    if (!includeSettled) stages.push({ $match: { balance: { $gt: 0.004 } } });
    stages.push({ $sort: { date: 1, _id: 1 } });
    return stages;
  }

  async customerInvoices(branchIds = [], includeSettled = false) {
    const collection = await this.getCollection('sales');
    return collection
      .aggregate(this.customerInvoiceAggregation(branchIds, includeSettled))
      .toArray();
  }

  async supplierInvoices(branchIds = [], includeSettled = false) {
    const collection = await this.getCollection('receivings');
    return collection
      .aggregate(this.supplierInvoiceAggregation(branchIds, includeSettled))
      .toArray();
  }

  async rawCustomerSales(partyId, branchIds = []) {
    const collection = await this.getCollection('sales');
    const match = this.baseMatch(branchIds);
    match.is_deleted = { $ne: true };
    match.sale_process = { $in: ['Add', 'Edit', 'PartialReturn'] };
    const values = [partyId];
    if (ObjectId.isValid(String(partyId))) values.push(new ObjectId(String(partyId)));
    match.customer_id = { $in: values };
    return collection.find(match).sort({ created_date: 1, _id: 1 }).toArray();
  }

  async rawSupplierReceivings(partyId, branchIds = []) {
    const collection = await this.getCollection('receivings');
    const match = this.baseMatch(branchIds);
    match.is_deleted = { $ne: true };
    match.$and = match.$and || [];
    match.$and.push({
      $or: [
        {
          receiving_status: {
            $in: ['Received', 'received', 'PartialReturn', 'partialreturn', 'Partial', 'partial'],
          },
        },
        {
          receiving_status: { $exists: false },
          status: { $in: ['Received', 'received', 'PartialReturn', 'partialreturn'] },
        },
        {
          receiving_status: { $exists: false },
          status: { $exists: false },
        },
      ],
    });
    const values = [partyId];
    if (ObjectId.isValid(String(partyId))) values.push(new ObjectId(String(partyId)));
    match.$and.push({ $or: [{ supplier_id: { $in: values } }, { supplier: { $in: values } }] });
    return collection.find(match).sort({ created_date: 1, _id: 1 }).toArray();
  }

  async updateCustomerSale(saleId, amount, now = new Date()) {
    const collection = await this.getCollection('sales');
    const id = saleId instanceof ObjectId ? saleId : new ObjectId(String(saleId));
    const doc = await collection.findOne({ _id: id, ...this.baseMatch() });
    if (!doc) return null;
    const total = firstNumber(
      doc.total,
      doc.total_amount,
      doc.sales_total,
      doc.items_total,
      doc.grand_total
    );
    const due = customerSaleDue(doc);
    const applied = roundMoney(Math.min(amount, due));
    if (applied <= 0) return { amount: 0, before: due, after: due };
    const paid = Math.max(firstNumber(doc.paid_amount, doc.partial_balance), total - due);
    const nextDue = roundMoney(Math.max(0, due - applied));
    const nextPaid = roundMoney(paid + applied);
    const nextPending = roundMoney(Math.max(0, firstNumber(doc.payment_pending, due) - applied));
    const nextPartial = roundMoney(firstNumber(doc.partial_balance) + applied);
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          paid_amount: nextPaid,
          partial_balance: nextPartial,
          payment_pending: nextPending,
          balance: nextDue,
          payment_status: nextDue <= 0.004 ? 'Paid' : 'Partialy Paid',
          updated_date: now,
        },
      }
    );
    await this.adjustCustomerTransactions(id, -applied, now);
    return { amount: applied, before: due, after: nextDue };
  }

  async updateSupplierReceiving(receivingId, amount, now = new Date()) {
    const collection = await this.getCollection('receivings');
    const id = receivingId instanceof ObjectId ? receivingId : new ObjectId(String(receivingId));
    const doc = await collection.findOne({ _id: id, ...this.baseMatch() });
    if (!doc) return null;
    const total = firstNumber(
      doc.invoice_total_declared,
      doc.total_amount,
      doc.items_total,
      doc.grand_total,
      doc.total
    );
    const due = supplierReceivingDue(doc);
    const applied = roundMoney(Math.min(amount, due));
    if (applied <= 0) return { amount: 0, before: due, after: due };
    const paid = Math.max(firstNumber(doc.paid_amount, doc.advance_amount), total - due);
    const nextDue = roundMoney(Math.max(0, due - applied));
    const nextPaid = roundMoney(paid + applied);
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          paid_amount: nextPaid,
          balance: nextDue,
          payment_status: nextDue <= 0.004 ? 'paid' : 'partial',
          updated_date: now,
        },
      }
    );
    return { amount: applied, before: due, after: nextDue };
  }

  async restoreCustomerSale(saleId, amount, now = new Date()) {
    const collection = await this.getCollection('sales');
    const id = saleId instanceof ObjectId ? saleId : new ObjectId(String(saleId));
    const doc = await collection.findOne({ _id: id, ...this.baseMatch() });
    if (!doc) return null;
    const total = firstNumber(
      doc.total,
      doc.total_amount,
      doc.sales_total,
      doc.items_total,
      doc.grand_total
    );
    const due = customerSaleDue(doc);
    const paid = firstNumber(doc.paid_amount, doc.partial_balance);
    const partial = firstNumber(doc.partial_balance);
    const nextDue = roundMoney(Math.min(total, due + amount));
    const nextPaid = roundMoney(Math.max(0, paid - amount));
    const nextPartial = roundMoney(Math.max(0, partial - amount));
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          paid_amount: nextPaid,
          partial_balance: nextPartial,
          payment_pending: nextDue,
          balance: nextDue,
          payment_status: nextDue <= 0.004 ? 'Paid' : nextPaid > 0.004 ? 'Partialy Paid' : 'Unpaid',
          updated_date: now,
        },
      }
    );
    await this.adjustCustomerTransactions(id, amount, now);
    return { before: due, after: nextDue };
  }

  async restoreSupplierReceiving(receivingId, amount, now = new Date()) {
    const collection = await this.getCollection('receivings');
    const id = receivingId instanceof ObjectId ? receivingId : new ObjectId(String(receivingId));
    const doc = await collection.findOne({ _id: id, ...this.baseMatch() });
    if (!doc) return null;
    const total = firstNumber(
      doc.invoice_total_declared,
      doc.total_amount,
      doc.items_total,
      doc.grand_total,
      doc.total
    );
    const due = supplierReceivingDue(doc);
    const paid = firstNumber(doc.paid_amount, doc.advance_amount);
    const nextDue = roundMoney(Math.min(total, due + amount));
    const nextPaid = roundMoney(Math.max(0, paid - amount));
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          paid_amount: nextPaid,
          balance: nextDue,
          payment_status: nextDue <= 0.004 ? 'paid' : nextPaid > 0.004 ? 'partial' : 'pending',
          updated_date: now,
        },
      }
    );
    return { before: due, after: nextDue };
  }

  /*
   * A partial sale also carries a `transaction` row whose `pending` is what
   * the customer outstanding report sums.  A collection moves both sides so
   * the debt page and that report cannot disagree.  The row is optional:
   * older and fully-paid sales do not have one.
   */
  async adjustCustomerTransactions(saleId, amountDelta, now = new Date()) {
    const collection = await this.getCollection('transaction');
    const values = [saleId];
    if (ObjectId.isValid(String(saleId))) values.push(new ObjectId(String(saleId)));
    const query = { sale_id: { $in: values } };
    if (amountDelta < 0) {
      query.pending = { $gt: 0 };
    }
    const rows = await collection.find(query).sort({ _id: 1 }).toArray();
    if (!rows.length) return 0;
    let remaining = Math.abs(amountDelta);
    let changed = 0;
    for (const row of rows) {
      if (remaining <= 0.004) break;
      const pending = firstNumber(row.pending);
      if (amountDelta < 0) {
        const take = Math.min(pending, remaining);
        const next = roundMoney(pending - take);
        await collection.updateOne(
          { _id: row._id },
          { $set: { pending: next, updated_date: now } }
        );
        remaining = roundMoney(remaining - take);
        changed = roundMoney(changed + take);
      } else {
        const next = roundMoney(pending + remaining);
        await collection.updateOne(
          { _id: row._id },
          { $set: { pending: next, updated_date: now } }
        );
        changed = roundMoney(changed + remaining);
        remaining = 0;
      }
    }
    return changed;
  }

  /*
   * Allocate oldest-first.  Each update is guarded by reading the document
   * immediately before writing, so a payment never writes a negative balance.
   * The returned allocations are the audit trail stored on the payment.
   */
  async allocateCustomerPayment(
    partyId,
    amount,
    branchIds = [],
    now = new Date(),
    recordId = null
  ) {
    const docs = (await this.rawCustomerSales(partyId, branchIds)).filter(
      (doc) => !recordId || String(doc._id) === String(recordId)
    );
    let remaining = roundMoney(amount);
    const allocations = [];
    for (const doc of docs) {
      if (remaining <= 0.004) break;
      const due = customerSaleDue(doc);
      if (due <= 0.004) continue;
      const take = roundMoney(Math.min(due, remaining));
      const updated = await this.updateCustomerSale(doc._id, take, now);
      const applied = updated ? updated.amount : 0;
      if (applied <= 0.004) continue;
      allocations.push({
        record_id: doc._id,
        record_type: 'sale',
        amount: applied,
        document_number: doc.sales_id || String(doc._id),
      });
      remaining = roundMoney(remaining - applied);
    }
    return { allocations, unapplied: roundMoney(Math.max(0, remaining)) };
  }

  async allocateSupplierPayment(
    partyId,
    amount,
    branchIds = [],
    now = new Date(),
    recordId = null
  ) {
    const docs = (await this.rawSupplierReceivings(partyId, branchIds)).filter(
      (doc) => !recordId || String(doc._id) === String(recordId)
    );
    let remaining = roundMoney(amount);
    const allocations = [];
    for (const doc of docs) {
      if (remaining <= 0.004) break;
      const due = supplierReceivingDue(doc);
      if (due <= 0.004) continue;
      const take = roundMoney(Math.min(due, remaining));
      const updated = await this.updateSupplierReceiving(doc._id, take, now);
      const applied = updated ? updated.amount : 0;
      if (applied <= 0.004) continue;
      allocations.push({
        record_id: doc._id,
        record_type: 'receiving',
        amount: applied,
        document_number: doc.receiving_id || String(doc._id),
      });
      remaining = roundMoney(remaining - applied);
    }
    return { allocations, unapplied: roundMoney(Math.max(0, remaining)) };
  }

  async restorePaymentAllocations(payment, now = new Date()) {
    const allocations = Array.isArray(payment.allocations) ? payment.allocations : [];
    for (const allocation of allocations) {
      const amount = firstNumber(allocation.amount);
      if (amount <= 0) continue;
      if (allocation.record_type === 'receiving') {
        await this.restoreSupplierReceiving(allocation.record_id, amount, now);
      } else {
        await this.restoreCustomerSale(allocation.record_id, amount, now);
      }
    }
  }

  paymentMatch(partyType, branchIds = [], partyId = null) {
    const match = this.baseMatch(branchIds);
    match.party_type = partyType;
    match.is_deleted = { $ne: true };
    if (partyId) match.party_id = partyId;
    return match;
  }

  async paymentTotals(partyType, branchIds = []) {
    const collection = await this.getCollection(this.collectionName);
    const totals = await collection
      .aggregate([
        { $match: this.paymentMatch(partyType, branchIds) },
        {
          $group: {
            _id: '$party_id',
            amount: { $sum: numeric('$amount') },
            allocated: { $sum: { $sum: '$allocations.amount' } },
            unapplied: { $sum: numeric('$unapplied_amount') },
            count: { $sum: 1 },
            last_payment: { $max: '$date' },
          },
        },
      ])
      .toArray();
    const result = new Map();
    for (const row of totals) {
      const key = row._id === null || row._id === undefined ? '' : String(row._id);
      if (!key) continue;
      result.set(key, {
        amount: roundMoney(row.amount),
        allocated: roundMoney(row.allocated),
        unapplied: roundMoney(row.unapplied),
        count: row.count || 0,
        last_payment: row.last_payment || null,
      });
    }
    return result;
  }

  async paymentsForParty(partyType, partyId, branchIds = []) {
    const collection = await this.getCollection(this.collectionName);
    const query = this.paymentMatch(partyType, branchIds, partyId);
    return collection.find(query).sort({ date: 1, _id: 1 }).toArray();
  }

  async partyPayments(partyType, branchIds = []) {
    const collection = await this.getCollection(this.collectionName);
    return collection
      .find(this.paymentMatch(partyType, branchIds))
      .sort({ date: -1, _id: -1 })
      .toArray();
  }

  async findPaymentById(id, branchIds = []) {
    if (!ObjectId.isValid(String(id))) return null;
    const collection = await this.getCollection(this.collectionName);
    return collection.findOne({
      _id: new ObjectId(String(id)),
      ...this.baseMatch(branchIds),
      is_deleted: { $ne: true },
    });
  }

  async findPaymentByRequestId(requestId) {
    if (!requestId) return null;
    const collection = await this.getCollection(this.collectionName);
    return collection.findOne({
      request_id: String(requestId),
      ...this.baseMatch(),
      is_deleted: { $ne: true },
    });
  }

  async createPayment(document) {
    const collection = await this.getCollection(this.collectionName);
    const result = await collection.insertOne(document);
    return { ...document, _id: result.insertedId };
  }

  async softDeletePayment(id, audit = {}, branchIds = []) {
    if (!ObjectId.isValid(String(id))) return null;
    const collection = await this.getCollection(this.collectionName);
    return collection.findOneAndUpdate(
      {
        _id: new ObjectId(String(id)),
        ...this.baseMatch(branchIds),
        is_deleted: { $ne: true },
      },
      {
        $set: {
          is_deleted: true,
          deleted_date: audit.date || new Date(),
          deleted_by: audit.by || null,
          deleted_by_name: audit.byName || '',
          updated_date: audit.date || new Date(),
        },
      },
      { returnDocument: 'after' }
    );
  }

  async findParty(partyType, partyId, branchIds = []) {
    if (!ObjectId.isValid(String(partyId))) return null;
    const collectionName = partyType === 'supplier' ? 'suppliers' : 'customers';
    const collection = await this.getCollection(collectionName);
    const query = {
      ...this.baseMatch(branchIds),
      _id: new ObjectId(String(partyId)),
      is_deleted: { $ne: true },
    };
    return collection.findOne(query);
  }
}

module.exports = DebtRepository;
