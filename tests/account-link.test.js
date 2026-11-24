'use strict';

/*
 * The link to a shop's Posnic account, and who is allowed to see it.
 *
 * Two mistakes are easy here and both are silent.
 *
 * SHOWING IT TO THE WRONG SHOP. A community install has no account. Sending
 * its owner to posnic.com/account to be told "no account found" is worse than
 * never offering the link, and it is the sort of thing nobody reports - they
 * just decide the software is confused.
 *
 * HIDING IT FROM THE RIGHT ONE. resolveMode() answers 'desktop' before it looks
 * at anything else, so a till PAIRED TO CLOUD - a paying customer, standing at
 * their own counter - reports edition 'community'. A frontend test on edition
 * would hide the link from precisely the people it exists for. That is why the
 * decision is a server-side flag and not a string comparison in the browser.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { buildRuntimeInfo, hasAccount } = require(
  path.join(ROOT, 'api', 'src', 'utils', 'runtime-info'));

const features = (env) => buildRuntimeInfo(env).features;

test('the removed account link is not offered anywhere in the frontend', () => {
  /* The visible Posnic account link was intentionally removed. The server
     flag stays as the authority for other clients, but the shop menu must
     not quietly grow the link back. */
  const header = fs.readFileSync(
    path.join(ROOT, 'frontend', 'layouts', 'header.html'), 'utf8');
  assert.doesNotMatch(header, /id="posnic_account_item"/,
    'the removed account item is back in the header');
  assert.doesNotMatch(header, /https:\/\/www\.posnic\.com\/account/,
    'the header still sends shops to the Posnic account page');

  const dash = fs.readFileSync(
    path.join(ROOT, 'frontend', 'static', 'script', 'js', 'modules', 'js', 'dashboard.js'), 'utf8');
  assert.doesNotMatch(dash, /showAccountLink/,
    'dashboard.js still wires the removed account link');
});

test('a provisioned cloud shop is offered its account', () => {
  assert.equal(features({ POSNIC_KEY: 'shop-key' }).account, true);
  assert.equal(features({ POSNIC_CLOUD: '1' }).account, true);
});

test('a till paired to cloud is offered it, even though its mode says desktop', () => {
  /* The case the whole flag exists for. */
  const info = buildRuntimeInfo({ POSNIC_DESKTOP: '1', POSNIC_SYNC_PAIRED: '1' });
  assert.equal(info.mode, 'desktop', 'a paired till still runs in desktop mode');
  assert.equal(info.edition, 'community', 'and still reports the community edition');
  assert.equal(info.features.account, true,
    'but it belongs to a paying customer, and the link is for them');
});

test('a community install is never sent to an account page', () => {
  assert.equal(features({ POSNIC_DESKTOP: '1' }).account, false, 'unpaired desktop');
  assert.equal(features({}).account, false, 'self-hosted server');
  assert.equal(features({ POSNIC_SYNC_PAIRED: '0' }).account, false, 'explicitly not paired');
});

test('a white-labelled build never mentions Posnic', () => {
  /*
   * That shop was sold something with somebody else's name on it. Sending its
   * owner to posnic.com would undo the rebrand they paid for.
   */
  assert.equal(features({ POSNIC_KEY: 'k', WHITE_LABEL_NAME: 'Acme POS' }).account, false);
  assert.equal(features({ POSNIC_DESKTOP: '1', POSNIC_SYNC_PAIRED: '1', WHITE_LABEL_NAME: 'Acme POS' }).account, false);
  /* An empty or whitespace value is not a white label. */
  assert.equal(features({ POSNIC_KEY: 'k', WHITE_LABEL_NAME: '   ' }).account, true);
});

test('the flag is readable without knowing it exists', () => {
  /* features has always shipped as an object so clients can read it
     unconditionally; a missing flag must read as false, not throw. */
  const info = buildRuntimeInfo({});
  assert.equal(typeof info.features, 'object');
  assert.ok(!info.features.somethingWeHaveNotBuiltYet);
});

test('hasAccount is pure and takes its environment', () => {
  /* So it can be reasoned about and tested without a process. */
  assert.equal(hasAccount({}, 'cloud'), true);
  assert.equal(hasAccount({}, 'desktop'), false);
  assert.equal(hasAccount({ POSNIC_SYNC_PAIRED: '1' }, 'desktop'), true);
});

/* ------------------------------------------------------------ the shell --- */

test('the desktop shell no longer claims a cloud pairing', () => {
  /*
   * Cloud pairing was removed with the offline-only till. A POSNIC_SYNC_PAIRED
   * flag in the shell would make other clients believe this machine belongs to
   * a cloud account when no such link exists.
   */
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /process\.env\.POSNIC_SYNC_PAIRED\s*=\s*'1'/,
    'main.js still claims a cloud pairing that no longer exists');
});
