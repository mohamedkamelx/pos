// src/services/debt.service.js
//
// Business rules for party debt and collections.
//
// Debt is read from the documents that created it (sales for customers,
// received purchases for suppliers).  A collection allocates oldest-first,
// moves the document's own paid/balance fields, and keeps the customer
// transaction's `pending` in step so existing outstanding reports agree.  The
// `party_payments` ledger is the audit trail that makes idempotency and
// reversal possible.  Sale totals, purchase totals, stock movements and
// register figures are never rewritten when money arrives later.
const { ObjectId } = require('mongodb');
const BaseModel = require('../models/base.model');
const DebtRepository = require('../repositories/debt.repository');

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const keyOf = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof ObjectId) return value.toString();
  if (value._bsontype === 'ObjectId' || typeof value.toHexString === 'function') {
    return value.toString();
  }
  return String(value);
};

const isoDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/*
 * Payments saved before the form carried a time were stored at midnight.
 * Their created_date is the only honest record of when the money was
 * actually entered, so use it instead of showing 00:00 for old rows.
 * A real timestamp, including a deliberate midnight, is left untouched.
 */
const paymentTimestamp = (payment = {}) => {
  const businessDate = payment.date ? new Date(payment.date) : null;
  const createdDate = payment.created_date ? new Date(payment.created_date) : null;
  if (!businessDate || Number.isNaN(businessDate.getTime())) return createdDate;
  if (
    createdDate &&
    !Number.isNaN(createdDate.getTime()) &&
    businessDate.getUTCHours() === 0 &&
    businessDate.getUTCMinutes() === 0 &&
    businessDate.getUTCSeconds() === 0 &&
    businessDate.getUTCMilliseconds() === 0
  ) {
    return createdDate;
  }
  return businessDate;
};

const lower = (value) => String(value || '').toLowerCase();

const normaliseInvoice = (row, partyType) => {
  const partyField = partyType === 'supplier' ? 'supplier_id' : 'customer_id';
  const nameField = partyType === 'supplier' ? 'supplier_name' : 'customer_name';
  const phoneField = partyType === 'supplier' ? 'supplier_phone' : 'customer_phone';
  const emailField = partyType === 'supplier' ? 'supplier_email' : 'customer_email';
  return {
    id: keyOf(row._id),
    party_id: keyOf(row[partyField]),
    party_name: row[nameField] || '',
    party_phone: row[phoneField] || '',
    party_email: row[emailField] || '',
    number: row.number || '',
    date: isoDate(row.date),
    total: roundMoney(row.total),
    paid: roundMoney(row.paid),
    balance: roundMoney(row.balance),
    payment_status: row.payment_status || '',
    kind: partyType === 'supplier' ? 'purchase' : 'sale',
  };
};

class DebtService {
  constructor() {
    this.repository = new DebtRepository();
  }

  async buildPartyMap(partyType, branchIds = []) {
    const [invoiceRows, paymentRows] = await Promise.all([
      partyType === 'supplier'
        ? this.repository.supplierInvoices(branchIds, true)
        : this.repository.customerInvoices(branchIds, true),
      this.repository.paymentTotals(partyType, branchIds),
    ]);

    const parties = new Map();
    for (const raw of invoiceRows) {
      const invoice = normaliseInvoice(raw, partyType);
      if (!invoice.party_id) continue;
      let party = parties.get(invoice.party_id);
      if (!party) {
        party = {
          id: invoice.party_id,
          name: '',
          phone: '',
          email: '',
          outstanding: 0,
          invoiced: 0,
          paid_at_sale: 0,
          collected: 0,
          invoice_count: 0,
          open_invoice_count: 0,
          oldest_due: null,
          last_document: null,
          numbers: [],
          invoices: [],
        };
        parties.set(invoice.party_id, party);
      }
      party.invoices.push(invoice);
      party.invoiced = roundMoney(party.invoiced + invoice.total);
      party.paid_at_sale = roundMoney(party.paid_at_sale + invoice.paid);
      party.outstanding = roundMoney(party.outstanding + invoice.balance);
      party.invoice_count += 1;
      if (invoice.balance > 0.004) party.open_invoice_count += 1;
      if (invoice.party_name) party.name = invoice.party_name;
      if (invoice.party_phone) party.phone = invoice.party_phone;
      if (invoice.party_email) party.email = invoice.party_email;
      // "Oldest due" is about money still owed, not the oldest invoice the
      // customer ever had. A settled 2024 bill must not outrank an open one.
      if (
        invoice.balance > 0.004 &&
        invoice.date &&
        (!party.oldest_due || invoice.date < party.oldest_due)
      ) {
        party.oldest_due = invoice.date;
      }
      if (invoice.date && (!party.last_document || invoice.date > party.last_document)) {
        party.last_document = invoice.date;
      }
      if (invoice.number && !party.numbers.includes(invoice.number)) {
        party.numbers.push(invoice.number);
      }
    }

    for (const party of parties.values()) {
      const paid = paymentRows.get(party.id);
      party.collected = paid ? roundMoney(paid.amount) : 0;
      party.allocated = paid ? roundMoney(paid.allocated) : 0;
      party.unapplied = paid ? roundMoney(paid.unapplied) : 0;
      party.payment_count = paid ? paid.count : 0;
      party.last_payment = paid ? isoDate(paid.last_payment) : null;
      /*
       * The payment has already moved the document's own balance down.  Only
       * the amount that could not be attached to a document (a rare race with
       * an edit) still has to be subtracted here.
       */
      party.outstanding = roundMoney(Math.max(0, party.outstanding - party.unapplied));
      party.paid_at_sale = roundMoney(
        Math.max(0, party.invoiced - party.outstanding - party.unapplied - party.allocated)
      );
    }
    return parties;
  }

  async listParties(partyType, options = {}) {
    const branchIds = Array.isArray(options.branchIds) ? options.branchIds : [];
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit, 10) || 20));
    const search = lower(options.search).trim();
    const sort = options.sort || 'outstanding';

    const parties = await this.buildPartyMap(partyType, branchIds);
    let rows = [...parties.values()].filter((party) => party.outstanding > 0.004);

    if (search) {
      rows = rows.filter((party) => {
        const haystack = [party.name, party.phone, party.email, party.id, ...(party.numbers || [])]
          .map(lower)
          .join(' ');
        return haystack.includes(search);
      });
    }

    const sorters = {
      outstanding: (a, b) =>
        b.outstanding - a.outstanding || lower(a.name).localeCompare(lower(b.name)),
      name: (a, b) => lower(a.name).localeCompare(lower(b.name)) || b.outstanding - a.outstanding,
      oldest: (a, b) => String(a.oldest_due || '').localeCompare(String(b.oldest_due || '')),
      newest: (a, b) => String(b.last_document || '').localeCompare(String(a.last_document || '')),
      last_payment: (a, b) =>
        String(b.last_payment || '').localeCompare(String(a.last_payment || '')),
    };
    rows.sort(sorters[sort] || sorters.outstanding);

    const total = rows.length;
    const totalOutstanding = roundMoney(rows.reduce((sum, party) => sum + party.outstanding, 0));
    const totalPages = Math.ceil(total / limit);
    // A search or a branch change can leave the requested page past the end.
    // Settle on the last real page instead of returning an empty list beside
    // a non-zero total.
    const safePage = Math.min(page, Math.max(1, totalPages));
    const start = (safePage - 1) * limit;
    const paged = rows.slice(start, start + limit).map((party) => ({
      id: party.id,
      name: party.name || party.phone || '',
      phone: party.phone || '',
      email: party.email || '',
      outstanding: party.outstanding,
      invoiced: party.invoiced,
      paid_at_sale: party.paid_at_sale,
      collected: party.collected,
      invoice_count: party.open_invoice_count,
      payment_count: party.payment_count,
      oldest_due: party.oldest_due,
      last_document: party.last_document,
      last_payment: party.last_payment,
      references: party.numbers.slice(0, 5),
    }));

    return {
      data: paged,
      total,
      page: safePage,
      limit,
      totalPages,
      totals: {
        outstanding: totalOutstanding,
      },
    };
  }

  async summary(branchIds = []) {
    const [customers, suppliers] = await Promise.all([
      this.listParties('customer', { branchIds, page: 1, limit: 1 }),
      this.listParties('supplier', { branchIds, page: 1, limit: 1 }),
    ]);
    const receivables = customers.totals.outstanding;
    const payables = suppliers.totals.outstanding;
    return {
      receivables,
      payables,
      net: roundMoney(receivables - payables),
      customers: customers.total,
      suppliers: suppliers.total,
      as_of: new Date().toISOString(),
    };
  }

  async partyStatement(partyType, partyId, branchIds = []) {
    if (!ObjectId.isValid(String(partyId))) {
      return { status: false, message: 'Invalid party ID', code: 'INVALID_PARTY' };
    }
    if (!['customer', 'supplier'].includes(partyType)) {
      return { status: false, message: 'Invalid party type', code: 'INVALID_PARTY_TYPE' };
    }

    const [invoiceRows, paymentRows, partyDoc] = await Promise.all([
      partyType === 'supplier'
        ? this.repository.supplierInvoices(branchIds, true)
        : this.repository.customerInvoices(branchIds, true),
      this.repository.paymentsForParty(partyType, new ObjectId(String(partyId)), branchIds),
      this.repository.findParty(partyType, partyId, branchIds),
    ]);

    const id = String(partyId);
    const invoices = invoiceRows
      .map((row) => normaliseInvoice(row, partyType))
      .filter((invoice) => invoice.party_id === id)
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const payments = paymentRows
      .filter((payment) => !payment.is_deleted)
      .map((payment) => {
        const allocations = Array.isArray(payment.allocations)
          ? payment.allocations.map((allocation) => ({
              record_id: keyOf(allocation.record_id),
              record_type: allocation.record_type || '',
              amount: roundMoney(allocation.amount),
              document_number: allocation.document_number || '',
            }))
          : [];
        return {
          id: keyOf(payment._id),
          date: isoDate(paymentTimestamp(payment)),
          amount: roundMoney(payment.amount),
          unapplied_amount: roundMoney(payment.unapplied_amount),
          allocations,
          note: payment.note || payment.description || '',
          reference: payment.reference || '',
          created_by: payment.created_by_name || payment.created_by || '',
          request_id: payment.request_id || '',
        };
      })
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const allocatedByRecord = new Map();
    let unappliedPayment = 0;
    for (const payment of payments) {
      unappliedPayment = roundMoney(unappliedPayment + payment.unapplied_amount);
      for (const allocation of payment.allocations) {
        const key = allocation.record_id;
        allocatedByRecord.set(
          key,
          roundMoney((allocatedByRecord.get(key) || 0) + allocation.amount)
        );
      }
    }

    const detailedInvoices = invoices.map((invoice) => {
      const paidLater = roundMoney(allocatedByRecord.get(invoice.id) || 0);
      const remaining = roundMoney(invoice.balance);
      const paidAtSale = roundMoney(Math.max(0, invoice.total - remaining - paidLater));
      return {
        ...invoice,
        paid_at_sale: paidAtSale,
        paid_later: paidLater,
        remaining,
      };
    });

    const outstandingBeforeCredit = roundMoney(
      detailedInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0)
    );
    const outstanding = roundMoney(Math.max(0, outstandingBeforeCredit - unappliedPayment));
    const invoiced = roundMoney(invoices.reduce((sum, invoice) => sum + invoice.total, 0));
    const paidAtSale = roundMoney(
      detailedInvoices.reduce((sum, invoice) => sum + invoice.paid_at_sale, 0)
    );
    const collected = roundMoney(payments.reduce((sum, payment) => sum + payment.amount, 0));
    const firstInvoice = invoices[0];
    const oldestDue = detailedInvoices.find((invoice) => invoice.remaining > 0.004);
    const lastPayment = payments[payments.length - 1];

    /*
     * One chronological account, not two lists that leave the reader to work
     * out the balance. Every charge is a debit; money paid at the counter and
     * every later collection/payment is a credit. The running balance is what
     * the party actually owes after each line, so a conversation can start at
     * the top and finish at the closing figure.
     */
    const ledger = [];
    for (const invoice of detailedInvoices) {
      ledger.push({
        date: invoice.date,
        sort_key: 0,
        kind: invoice.kind,
        record_id: invoice.id,
        number: invoice.number,
        reference: invoice.number,
        description: '',
        debit: invoice.total,
        credit: 0,
        payment_id: '',
        note: '',
      });
      if (invoice.paid_at_sale > 0) {
        ledger.push({
          date: invoice.date,
          sort_key: 1,
          kind: 'paid_at_sale',
          record_id: invoice.id,
          number: invoice.number,
          reference: invoice.number,
          description: '',
          debit: 0,
          credit: invoice.paid_at_sale,
          payment_id: '',
          note: '',
        });
      }
    }
    for (const payment of payments) {
      const appliedTo = payment.allocations
        .map((allocation) => allocation.document_number)
        .filter(Boolean);
      ledger.push({
        date: payment.date,
        sort_key: 2,
        kind: 'payment',
        record_id: '',
        number: payment.reference || '',
        reference: payment.reference || '',
        description:
          appliedTo.length > 0
            ? appliedTo.join(', ')
            : payment.unapplied_amount > 0
              ? 'On account'
              : '',
        debit: 0,
        credit: payment.amount,
        payment_id: payment.id,
        note: payment.note || '',
      });
    }
    ledger.sort((a, b) => {
      const byDate = String(a.date || '').localeCompare(String(b.date || ''));
      if (byDate !== 0) return byDate;
      if (a.sort_key !== b.sort_key) return a.sort_key - b.sort_key;
      return String(a.reference || '').localeCompare(String(b.reference || ''));
    });
    let running = 0;
    const ledgerRows = ledger.map((row) => {
      running = roundMoney(running + row.debit - row.credit);
      return {
        date: row.date,
        kind: row.kind,
        record_id: row.record_id,
        number: row.number,
        reference: row.reference,
        description: row.description,
        debit: roundMoney(row.debit),
        credit: roundMoney(row.credit),
        balance: running,
        payment_id: row.payment_id,
        note: row.note,
      };
    });

    return {
      status: true,
      data: {
        party: {
          id,
          type: partyType,
          name:
            (partyDoc && (partyDoc.name || partyDoc.supplier_name)) ||
            (firstInvoice && firstInvoice.party_name) ||
            '',
          phone:
            (partyDoc && (partyDoc.phone || partyDoc.mobile)) ||
            (firstInvoice && firstInvoice.party_phone) ||
            '',
          email: (partyDoc && partyDoc.email) || (firstInvoice && firstInvoice.party_email) || '',
          address: (partyDoc && (partyDoc.address || partyDoc.street)) || '',
        },
        summary: {
          invoiced,
          paid_at_sale: paidAtSale,
          collected,
          outstanding,
          credit: roundMoney(Math.max(0, unappliedPayment - outstandingBeforeCredit)),
          unapplied: roundMoney(unappliedPayment),
          invoice_count: invoices.length,
          payment_count: payments.length,
          oldest_due: oldestDue ? oldestDue.date : null,
          last_payment: lastPayment ? lastPayment.date : null,
          last_document: firstInvoice ? invoices[invoices.length - 1].date : null,
          opening_balance: 0,
          closing_balance: running,
        },
        invoices: detailedInvoices,
        payments,
        ledger: ledgerRows,
      },
    };
  }

  async partyDebt(partyType, partyId, branchIds = []) {
    const statement = await this.partyStatement(partyType, partyId, branchIds);
    if (!statement.status) return statement;
    return {
      status: true,
      data: {
        ...statement.data.party,
        outstanding: statement.data.summary.outstanding,
        credit: statement.data.summary.credit,
      },
    };
  }

  /*
   * Settle one bill from the sale/purchase screen. The cashier has already
   * chosen the bill by opening it; asking them to type the amount they just
   * read is both redundant and a chance to mistype. Read the outstanding
   * figure from the same statement the Debts page shows, then hand that exact
   * amount to recordPayment so it still goes through the normal allocation,
   * ledger and reversal path.
   */
  async settleInvoice(input = {}) {
    const partyType = String(input.partyType || '').toLowerCase();
    const partyId = String(input.partyId || '');
    const recordId = String(input.recordId || '');
    const branchIds = Array.isArray(input.branchIds) ? input.branchIds : [];

    if (!['customer', 'supplier'].includes(partyType)) {
      return {
        status: false,
        message: 'Choose a customer or a supplier.',
        code: 'INVALID_PARTY_TYPE',
      };
    }
    if (!ObjectId.isValid(partyId)) {
      return { status: false, message: 'Choose a valid party.', code: 'INVALID_PARTY' };
    }
    if (!ObjectId.isValid(recordId)) {
      return { status: false, message: 'Choose a valid bill.', code: 'INVALID_RECORD' };
    }

    const requestedBranch = input.branchId ? String(input.branchId) : '';
    const paymentBranchIds = requestedBranch
      ? [requestedBranch]
      : branchIds.length === 1
        ? [String(branchIds[0])]
        : [];
    if (!paymentBranchIds.length) {
      return {
        status: false,
        message: 'Select one branch to record a payment.',
        code: 'BRANCH_REQUIRED',
      };
    }
    if (!ObjectId.isValid(paymentBranchIds[0])) {
      return { status: false, message: 'Choose a valid branch.', code: 'INVALID_BRANCH' };
    }
    if (branchIds.length && !branchIds.map(String).includes(paymentBranchIds[0])) {
      return {
        status: false,
        message: 'You do not have access to the selected branch',
        code: 'BRANCH_FORBIDDEN',
      };
    }

    const statement = await this.partyStatement(partyType, partyId, paymentBranchIds);
    if (!statement.status) return statement;
    const invoice = (statement.data.invoices || []).find((row) => String(row.id) === recordId);
    if (!invoice) {
      return { status: false, message: 'Bill not found.', code: 'RECORD_NOT_FOUND' };
    }
    const remaining = roundMoney(invoice.remaining);
    if (remaining <= 0.004) {
      return {
        status: false,
        message: 'This bill has no outstanding balance.',
        code: 'NOTHING_OUTSTANDING',
      };
    }

    return this.recordPayment({
      partyType,
      partyId,
      amount: remaining,
      date: input.date,
      note: input.note,
      reference: input.reference || invoice.number,
      requestId: input.requestId,
      branchId: paymentBranchIds[0],
      branchIds,
      recordId,
    });
  }

  async recordPayment(input = {}) {
    const partyType = String(input.partyType || '').toLowerCase();
    const partyId = String(input.partyId || '');
    const amount = roundMoney(input.amount);
    const branchIds = Array.isArray(input.branchIds) ? input.branchIds : [];
    const requestId = String(input.requestId || '').trim();
    const recordId = String(input.recordId || '').trim();

    if (!['customer', 'supplier'].includes(partyType)) {
      return {
        status: false,
        message: 'Choose a customer or a supplier.',
        code: 'INVALID_PARTY_TYPE',
      };
    }
    if (!ObjectId.isValid(partyId)) {
      return { status: false, message: 'Choose a valid party.', code: 'INVALID_PARTY' };
    }
    if (recordId && !ObjectId.isValid(recordId)) {
      return { status: false, message: 'Choose a valid bill.', code: 'INVALID_RECORD' };
    }
    if (!(amount > 0)) {
      return {
        status: false,
        message: 'Enter a payment amount greater than zero.',
        code: 'INVALID_AMOUNT',
      };
    }

    /*
     * A collection moves one party's invoices and creates one ledger row. The
     * row carries one branch_id, so it must apply to exactly one branch: an
     * allocation spread over several branches would leave the other branch's
     * statement with a reduced invoice and no matching payment. The UI asks
     * for one branch; this is the server-side backstop for stale clients.
     */
    const requestedBranch = input.branchId ? String(input.branchId) : '';
    const paymentBranchIds = requestedBranch
      ? [requestedBranch]
      : branchIds.length === 1
        ? [String(branchIds[0])]
        : [];
    if (!paymentBranchIds.length) {
      return {
        status: false,
        message: 'Select one branch to record a payment.',
        code: 'BRANCH_REQUIRED',
      };
    }
    if (!ObjectId.isValid(paymentBranchIds[0])) {
      return { status: false, message: 'Choose a valid branch.', code: 'INVALID_BRANCH' };
    }
    if (branchIds.length && !branchIds.map(String).includes(paymentBranchIds[0])) {
      return {
        status: false,
        message: 'You do not have access to the selected branch',
        code: 'BRANCH_FORBIDDEN',
      };
    }

    if (requestId) {
      const existing = await this.repository.findPaymentByRequestId(requestId);
      if (existing) {
        if (existing.party_type !== partyType || keyOf(existing.party_id) !== partyId) {
          return {
            status: false,
            message: 'This request was already used for another payment.',
            code: 'IDEMPOTENCY_CONFLICT',
          };
        }
        const summary = await this.partyDebt(partyType, partyId, paymentBranchIds);
        return {
          status: true,
          duplicate: true,
          data: {
            payment: this.serialisePayment(existing),
            party: summary.status ? summary.data : null,
          },
          message: 'Payment already recorded',
        };
      }
    }

    const debt = await this.partyDebt(partyType, partyId, paymentBranchIds);
    if (!debt.status) return debt;
    if (debt.data.outstanding <= 0) {
      return {
        status: false,
        message: 'There is no outstanding balance for this party.',
        code: 'NOTHING_OUTSTANDING',
      };
    }
    if (amount > debt.data.outstanding + 0.004) {
      return {
        status: false,
        message: 'The amount is more than the outstanding balance.',
        code: 'AMOUNT_EXCEEDS_BALANCE',
        outstanding: debt.data.outstanding,
      };
    }

    const now = new Date();
    const paymentDate = input.date ? new Date(input.date) : now;
    if (Number.isNaN(paymentDate.getTime())) {
      return { status: false, message: 'Enter a valid payment date.', code: 'INVALID_DATE' };
    }

    const branchId = paymentBranchIds[0];
    const licenses = this.repository.licenseValues();
    const license = licenses.find((value) => value instanceof ObjectId) || BaseModel.license;
    if (!license) {
      return { status: false, message: 'Shop context is missing.', code: 'NO_LICENSE' };
    }

    const allocationArgs = [partyId, amount, paymentBranchIds, now];
    if (recordId) allocationArgs.push(recordId);
    const allocation =
      partyType === 'supplier'
        ? await this.repository.allocateSupplierPayment(...allocationArgs)
        : await this.repository.allocateCustomerPayment(...allocationArgs);
    if (!allocation.allocations.length) {
      return {
        status: false,
        message: 'The outstanding balance changed before the payment could be saved. Try again.',
        code: 'ALLOCATION_FAILED',
      };
    }
    if (recordId && allocation.unapplied > 0.004) {
      // A settle action names one bill. If that bill changed while the cashier
      // was confirming, put the allocation back and ask again rather than
      // leave part of the money as an unapplied credit.
      await this.repository.restorePaymentAllocations({ allocations: allocation.allocations }, now);
      return {
        status: false,
        message: 'The bill changed before it could be settled. Try again.',
        code: 'RECORD_CHANGED',
      };
    }

    const document = {
      party_type: partyType,
      party_id: new ObjectId(partyId),
      party_name: debt.data.name || '',
      party_phone: debt.data.phone || '',
      amount,
      date: paymentDate,
      note: String(input.note || '')
        .trim()
        .slice(0, 500),
      reference: String(input.reference || '')
        .trim()
        .slice(0, 120),
      branch_id: branchId ? new ObjectId(String(branchId)) : null,
      branch_name: BaseModel.currentBranchName || '',
      license,
      source: 'debt',
      allocations: allocation.allocations,
      unapplied_amount: allocation.unapplied,
      created_by: BaseModel.loggedUser || null,
      created_by_name: BaseModel.loggedUserName || '',
      created_date: now,
      updated_date: now,
      is_deleted: false,
    };
    if (requestId) document.request_id = requestId;

    let payment;
    try {
      payment = await this.repository.createPayment(document);
    } catch (error) {
      // The sale/purchase balances were moved before the ledger row existed.
      // Put them back rather than leave money recorded nowhere.
      await this.repository.restorePaymentAllocations(document, now);
      throw error;
    }
    const updated = await this.partyDebt(partyType, partyId, paymentBranchIds);
    return {
      status: true,
      data: {
        payment: this.serialisePayment(payment),
        party: updated.status ? updated.data : null,
      },
      message: 'Payment recorded',
    };
  }

  serialisePayment(payment) {
    return {
      id: keyOf(payment._id),
      party_type: payment.party_type,
      party_id: keyOf(payment.party_id),
      party_name: payment.party_name || '',
      amount: roundMoney(payment.amount),
      unapplied_amount: roundMoney(payment.unapplied_amount),
      allocations: Array.isArray(payment.allocations)
        ? payment.allocations.map((allocation) => ({
            record_id: keyOf(allocation.record_id),
            record_type: allocation.record_type || '',
            amount: roundMoney(allocation.amount),
            document_number: allocation.document_number || '',
          }))
        : [],
      date: isoDate(paymentTimestamp(payment)),
      note: payment.note || '',
      reference: payment.reference || '',
      branch_id: keyOf(payment.branch_id),
      branch_name: payment.branch_name || '',
      created_by_name: payment.created_by_name || '',
      created_date: isoDate(payment.created_date),
    };
  }

  async deletePayment(id, input = {}) {
    const branchIds = Array.isArray(input.branchIds) ? input.branchIds : [];
    const existing = await this.repository.findPaymentById(id, branchIds);
    if (!existing) {
      return { status: false, message: 'Payment not found.', code: 'PAYMENT_NOT_FOUND' };
    }
    await this.repository.restorePaymentAllocations(existing, new Date());
    const deleted = await this.repository.softDeletePayment(
      id,
      {
        date: new Date(),
        by: BaseModel.loggedUser || null,
        byName: BaseModel.loggedUserName || '',
      },
      branchIds
    );
    if (!deleted) {
      return { status: false, message: 'Payment not found.', code: 'PAYMENT_NOT_FOUND' };
    }
    const debt = await this.partyDebt(existing.party_type, keyOf(existing.party_id), branchIds);
    return {
      status: true,
      data: {
        payment: this.serialisePayment(deleted),
        party: debt.status ? debt.data : null,
      },
      message: 'Payment removed',
    };
  }
}

module.exports = DebtService;
