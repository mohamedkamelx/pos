'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(
  path.join(__dirname, '../frontend/static/script/js/modules/js/sales.js'),
  'utf8'
);

function setup() {
  const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  const alerts = [];
  const gets = [];
  const posts = [];
  let history = 0;
  let pendingGet = null;
  let pendingPost = null;
  let confirmText = '';

  win.confirm = (message) => {
    confirmText = message;
    return true;
  };
  win.PosnicPro = {
    local: {
      get: (key) => {
        if (key === 'currencySign') return '$';
        if (key === 'branch_id_set') return '507f1f77bcf86cd799439011';
        return '';
      },
    },
    i18n: { t: (_key, fallback) => fallback },
    alert: (type, message) => alerts.push({ type, message }),
    aclLoaded: () => false,
    checkAccess: () => true,
    sales: {
      _settling: {},
      loadHistory: () => {
        history += 1;
      },
    },
    get: (url, success) => {
      gets.push(url);
      pendingGet = success;
    },
    post: (options, success) => {
      posts.push(options);
      pendingPost = success;
    },
  };

  const start = source.indexOf('    showPayment: function');
  const end = source.indexOf('\n    },', start);
  assert.ok(start >= 0 && end > start, 'showPayment is missing from sales.js');
  win.eval(
    'PosnicPro.sales.showPayment = ' +
      source.slice(source.indexOf('function', start), end + 6) +
      ';'
  );

  return {
    dom,
    win,
    sales: win.PosnicPro.sales,
    alerts,
    gets,
    posts,
    history: () => history,
    confirmText: () => confirmText,
    replyGet: (response) => pendingGet(response),
    replyPost: (response) => pendingPost(response),
  };
}

const SALE = {
  _id: '507f1f77bcf86cd799439012',
  sales_id: 'S-12',
  customer_id: '507f1f77bcf86cd799439013',
  branch_id: '507f1f77bcf86cd799439011',
  total: 262.5,
  payment_pending: 162.5,
  debt_account: {
    party_id: '507f1f77bcf86cd799439013',
    invoice_remaining: 162.5,
  },
};

test('Settle Bill records the bill balance without asking for an amount', () => {
  const page = setup();
  page.sales.showPayment(SALE._id);
  assert.deepEqual(page.gets, ['sales/' + SALE._id]);

  page.replyGet({ type: 'success', data: SALE });
  assert.match(page.confirmText(), /\$?162\.50/);
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].url, 'debts/settle');
  const body = JSON.parse(page.posts[0].data);
  assert.equal(body.party_type, 'customer');
  assert.equal(body.party_id, SALE.customer_id);
  assert.equal(body.record_id, SALE._id);
  assert.equal(body.branch_id, SALE.branch_id);
  assert.equal(body.note, 'Bill settled from sales history');
  assert.match(body.request_id, new RegExp('^settle:' + SALE._id + ':162\\.50:'));
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'amount'), false);

  page.replyPost({ type: 'success', data: {} });
  assert.equal(page.history(), 1);
  assert.deepEqual(page.alerts, [{ type: 'success', message: 'Bill settled.' }]);
  page.dom.window.close();
});

test('a bill with nothing left does not post a payment', () => {
  const page = setup();
  page.sales.showPayment(SALE._id);
  page.replyGet({
    type: 'success',
    data: { ...SALE, debt_account: { party_id: SALE.customer_id, invoice_remaining: 0 } },
  });
  assert.equal(page.posts.length, 0);
  assert.deepEqual(page.alerts, [
    { type: 'warning', message: 'There is no outstanding balance for this party.' },
  ]);
  page.dom.window.close();
});

test('a repeated click while the bill loads is ignored', () => {
  const page = setup();
  page.sales.showPayment(SALE._id);
  page.sales.showPayment(SALE._id);
  assert.equal(page.gets.length, 1);
  page.replyGet({ type: 'success', data: { ...SALE, debt_account: { invoice_remaining: 0 } } });
  page.sales.showPayment(SALE._id);
  assert.equal(page.gets.length, 2);
  page.dom.window.close();
});

test('cancelling the confirmation sends nothing', () => {
  const page = setup();
  page.win.confirm = () => false;
  page.sales.showPayment(SALE._id);
  page.replyGet({ type: 'success', data: SALE });
  assert.equal(page.posts.length, 0);
  page.dom.window.close();
});
