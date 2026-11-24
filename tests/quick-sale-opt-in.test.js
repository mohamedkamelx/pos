/*
 * Quick Sale is back, but it is opt-in.
 *
 * The owner asked for the pad to return and to stay off until a shop switches
 * it on. A feature that is "off" only in one of the four places that gate it
 * is worse than no switch at all: the button can appear for a cashier whose
 * shop never asked for it, or vanish after a settings refresh despite the
 * switch being on. These checks pin all four decisions:
 *
 *   - the sale button starts hidden in the markup;
 *   - the gate reads the shop setting as strictly true;
 *   - the Features card is a normal switch and is saved with the other ones;
 *   - a new shop and an absent stored value both mean off.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function loadGate() {
  const source = read('frontend/static/script/js/modules/js/sales.js');
  const start = source.indexOf('PosnicPro.sales.applyQuickSaleGate = function');
  const end = source.indexOf('/*\n * Quick Sale (Square study Q1)', start);
  assert.ok(start > -1 && end > start, 'the Quick Sale gate is missing');

  const makeContext = (settings, pos) => {
    const toggles = [];
    const context = {
      PosnicPro: {
        sales: {},
        local: { get: () => settings },
        userACL: { pos },
      },
      $: () => ({ toggle: (on) => toggles.push(on) }),
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    return { gate: context.PosnicPro.sales.applyQuickSaleGate, toggles };
  };
  return makeContext;
}

test('without a saved switch the Quick Sale button stays hidden', () => {
  const makeContext = loadGate();
  const { gate, toggles } = makeContext('{}', { quick_sale: true });

  assert.equal(gate(), false, 'an absent setting must mean off');
  assert.deepEqual(toggles, [false]);
});

test('the shop switch alone turns the pad on for a permitted cashier', () => {
  const makeContext = loadGate();
  const { gate, toggles } = makeContext(
    JSON.stringify({ quick_sale_enable: true }),
    { quick_sale: true },
  );

  assert.equal(gate(), true);
  assert.deepEqual(toggles, [true]);
});

test('an explicit false, a denied cashier or a broken cache keeps it hidden', () => {
  const makeContext = loadGate();

  const off = makeContext(JSON.stringify({ quick_sale_enable: false }), {
    quick_sale: true,
  });
  assert.equal(off.gate(), false);

  const denied = makeContext(JSON.stringify({ quick_sale_enable: true }), {
    quick_sale: false,
  });
  assert.equal(denied.gate(), false);

  const broken = makeContext('{not json', { quick_sale: true });
  assert.equal(broken.gate(), false);
});

test('the sale screen never paints the button before the gate decides', () => {
  const markup = read('frontend/modules/sales_write.html');
  assert.match(
    markup,
    /id="quick_sale_btn"[\s\S]{0,220}display:none/,
    'the button must start hidden, not flash on and disappear',
  );
});

test('Features owns the switch and saves it with the other module switches', () => {
  const markup = read('frontend/modules/settings_write.html');
  const settings = read('frontend/static/script/js/modules/js/settings.js');

  assert.match(markup, /id="quick_sale_enable"/);
  assert.doesNotMatch(
    markup,
    /id="quick_sale_enable"[^>]*\bchecked\b/,
    'the markup must not pre-check a switch that is off by default',
  );
  assert.match(settings, /'quick_sale_enable'/);
  assert.match(settings, /data\.quick_sale_enable === true/);
  assert.doesNotMatch(settings, /quick_sale_enable !== false/);
});

test('a new shop and an absent stored value both default to off', () => {
  const model = read('api/src/models/setting.model.js');
  const install = read('api/src/services/install.service.js');

  assert.match(
    model,
    /quick_sale_enable: \{ parse: onOnly, dflt: false \}/,
    'the shared read must treat an absent value as off',
  );
  assert.match(install, /quick_sale_enable: false/);
});

test('the cashier grant is still a grantable till action', () => {
  const roles = read('frontend/static/script/js/modules/js/roles.js');
  const users = read('frontend/static/script/js/modules/js/users.js');
  const userModal = read('frontend/modals/user.html');

  assert.match(roles, /"quick_sale"/);
  assert.match(roles, /quick_sale: "Quick sale \/ instant items"/);
  assert.match(users, /'quick_sale'/);
  assert.match(userModal, /id="pos_quick_sale"/);
});
