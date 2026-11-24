'use strict';

/*
 * One door for purchasing.
 *
 * Owner: "i see new purchase, purchase history duplicated in purchase order
 * page... have only one option... options like quote we need filter
 * typeahead and etc you need improve and then remove old add purchase
 * purchase history."
 *
 * The system: the sidebar carries ONE entry (Purchases). The page behind it
 * reaches every flow - ordering, receiving stock, the history - and the
 * history's filter bar offers this shop's own suppliers, the same way the
 * quotes bar offers customers. The old ROUTES stay alive (deep links, the
 * desktop), only the duplicate menu doors are gone.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'frontend', rel), 'utf8');
const sidebar = read('layouts/sidebar.html');
const poPage = read('modules/purchaseOrders.html');
const receivingJs = read('static/script/js/modules/js/receiving_add.js');

test('the sidebar has exactly ONE purchasing entry', () => {
    assert.ok(sidebar.includes('id="view_purchaseorders_page"'), 'the Purchases entry is gone');
    assert.ok(!sidebar.includes('id="view_receiving_page"'), 'the New Purchase menu entry is back');
    assert.ok(!sidebar.includes('id="view_receivings_page"'), 'the Purchase History menu entry is back');
});

test('the one door reaches every flow the old doors reached', () => {
    assert.match(poPage, /href="#\/receivings\/new"/);
    /* Purchase History is RETIRED (owner, 2026-08-27: "delete existing
       routes and html and etc") - nothing may link to it, and the old route
       redirects to the one surface instead of a page that no longer exists. */
    assert.ok(!poPage.includes('href="#/receivings"'), 'a link points at the retired archive');
    const shower = receivingJs.slice(
        receivingJs.indexOf('showDataTablePage: function'),
        receivingJs.indexOf('},', receivingJs.indexOf('showDataTablePage: function')),
    );
    assert.match(shower, /setHash\('purchaseorders'\)/, 'the old route must redirect, not 404');
});

test('the history filter offers suppliers, like quotes offers customers', () => {
    const mount = receivingJs.slice(
        receivingJs.indexOf("key: 'receivings'"),
        receivingJs.indexOf('onChange', receivingJs.indexOf("key: 'receivings'"))
    );
    assert.match(mount, /typeahead: 'supplier'/);
    assert.match(mount, /typeaheadField: 'supplier_name'/);
});

test('nothing still lights the removed menu ids', () => {
    for (const f of ['items.js', 'receiving_add.js']) {
        const src = read('static/script/js/modules/js/' + f);
        assert.ok(!src.includes("a#view_receiving_page')"), f + ' still targets the removed entry');
        assert.ok(!src.includes(".view_receivings_page')"), f + ' still targets the removed class');
    }
});

test('purchases are recorded immediately; legacy orders stay read-only', () => {
    /* Owner: record the purchase when the bill is entered. There is no
       ordered -> received step left, and a legacy purchase order can only
       be read (or have its labels printed), never received, edited or
       deleted. */
    const html = read('modules/purchaseOrders.html');
    assert.match(html, /href="#\/receivings\/new"/);
    assert.ok(!html.includes('id="po_receive_section"'), 'the ordered -> received panel is back');
    assert.ok(!html.includes('id="po_form_section"'), 'the legacy create/edit form is back');
    assert.ok(!html.includes('Receive into stock'), 'the receive panel copy is back');

    for (const dead of [
        'receive: function',
        'openReceive: function',
        'saveReceive: function',
        'receiveAll: function',
        '_postReceive: function',
        'openForm: function',
        'po_receive_',
        'po_form_',
    ]) {
        assert.ok(!receivingJs.includes(dead), 'legacy purchase-order code is back: ' + dead);
    }

    assert.match(receivingJs, /showAdd: function \(\) \{ hasher\.setHash\('receivings\/new'\); \}/);
    assert.match(receivingJs, /receivingStatus: 'Received'/);
    const received = receivingJs.match(/status: PosnicPro\.receivings\.receivingStatus \|\| 'Received'/g) || [];
    assert.ok(received.length >= 2, 'the receiving form must record both create and edit as Received');

    const view = receivingJs.slice(
        receivingJs.indexOf('openView: function'),
        receivingJs.indexOf('printLabels: function'),
    );
    assert.match(view, /data-act="labels"/);
    assert.ok(!/data-act="(?:edit|delete|receive)"/.test(view), 'a legacy order still offers a write action');
    assert.match(receivingJs, /ordered: \['lang_legacy_order', 'Legacy order'\]/);
});
