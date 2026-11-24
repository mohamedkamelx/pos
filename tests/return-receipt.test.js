'use strict';

/*
 * A return receipt is a receipt too.
 *
 * The sale receipt prints through the receipt designer in the shop's
 * language. The return slip used to take the legacy English template, so an
 * Arabic shop handed the customer an Arabic bill and an English return.
 * These tests hold the return to the same document, layout and language.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function designer() {
    const dom = new JSDOM('<div id="receipt-designer"></div>', {
        url: 'http://localhost/',
        runScripts: 'outside-only'
    });
    const w = dom.window;
    w.$ = w.jQuery = require('jquery')(w);
    w.PosnicPro = {
        escapeHtml: (value) => w.$('<i>').text(value).html(),
        local: { get: (key) => (key === 'currencySign' ? '$' : ''), set: () => {} },
        i18n: { t: (_key, text) => text },
        isWalkInName: () => false,
        BRAND_URL: 'https://www.posnic.com'
    };
    w.eval(read('api/src/helpers/sale-payment-summary.js'));
    w.eval(read('api/src/helpers/receipt-design.js'));
    w.eval(read('src/receipt-page-layout.js'));
    w.eval(read('frontend/static/script/js/core/receipt-designer.js'));
    w.eval(read('frontend/static/script/js/core/receipt-design-labels.js'));
    return { dom, w, engine: w.PosnicPro.receiptDesigner };
}

function branchWithDesign(engine, w) {
    const branch = {
        branch_name: 'مطعم النيل',
        print_width: '80',
        print_logoimg: false,
        customer_print: false,
        footer_print: 'شكراً لزيارتكم'
    };
    branch.receipt_designs = engine.defaults(branch);
    w.PosnicPro.i18n.t = (key, text) => (key === 'lang_return_title' ? 'إرجاع' : text);
    return branch;
}

function returned(custom) {
    return Object.assign({
        sales_id: 'S100',
        return_id: 'RFS24',
        date: '24/11/2026',
        customer_name: '',
        customer_print: false,
        discount: 0
    }, custom || {});
}

test('a return becomes a designer document with the refund on it, not the sale', (t) => {
    const { dom, w, engine } = designer();
    t.after(() => dom.window.close());
    const branch = branchWithDesign(engine, w);
    const doc = engine.returnDocument(branch, returned(), [
        {
            item_name: 'شاي',
            item_quantity: 2,
            item_price: 15,
            item_unit: 'qty',
            item_total_amount: 30,
            item_discount: 0,
            item_discount_percentage: 0,
            extraDiscount: 5,
            roundOff: 0,
            itemsTotalAmount: 25
        }
    ]);

    assert.equal(doc.document_title, 'إرجاع');
    assert.equal(doc.branch_name, 'مطعم النيل');
    assert.equal(doc.receipt_date, '24/11/2026');
    assert.equal(doc.sales_id, 'S100');
    assert.deepEqual(
        doc.items.map((item) => [item.item_name, item.item_quantity, item.total_amount]),
        [['شاي', 2, 30]]
    );
    // The refund, not the original sale's payable total.
    assert.equal(doc.items_subtotal, 30);
    assert.equal(doc.sale_extra_discount, 5);
    assert.equal(doc.items_total, 25);
    assert.equal(doc.receipt_designs, branch.receipt_designs);
});

test('the return slip carries the Arabic title, item and refund on thermal paper', (t) => {
    const { dom, w, engine } = designer();
    t.after(() => dom.window.close());
    const branch = branchWithDesign(engine, w);
    const doc = engine.returnDocument(branch, returned(), [
        {
            item_name: 'شاي',
            item_quantity: 2,
            item_price: 15,
            item_unit: 'qty',
            item_total_amount: 30,
            item_discount: 0,
            item_discount_percentage: 0,
            extraDiscount: 5,
            roundOff: 0,
            itemsTotalAmount: 25
        }
    ]);

    const text = w.$('<div>').html(engine.render(doc, '80', false)).text();
    assert.match(text, /إرجاع/);
    assert.match(text, /شاي/);
    assert.match(text, /25\.00/);
    // The default thermal layout hides the title for ordinary receipts; a
    // return still has to identify itself.
    assert.match(text, /S100/);
    assert.doesNotMatch(text, /Receipt/);
});

test('the return print action hands the branch design and return lines to the designer', (t) => {
    const dom = new JSDOM('<div id="receipt_wrapper"></div>', {
        url: 'http://localhost/',
        runScripts: 'outside-only'
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.$ = w.jQuery = require('jquery')(w);
    const requests = [];
    const printed = [];
    w.PosnicPro = {
        realtime: null,
        local: { get: (key) => (key === 'branch_id_set' ? 'branch-1' : '') },
        receiptDesigner: {
            printReturn: function () {
                printed.push(Array.from(arguments));
            }
        },
        sales: { view: { _layoutOverride: 'a4' } },
        get: function (options, success) {
            requests.push(options);
            if (options.url === 'sales/returnPrintDetails') {
                success({
                    type: 'success',
                    data: {
                        custom_data: { sales_id: 'S100', return_id: 'RFS24', date: '24/11/2026' },
                        return_data: [{ item_name: 'Tea', item_quantity: 1, item_total_amount: 10 }]
                    }
                });
            } else if (options.url === 'branches/getOneStore') {
                success({ type: 'success', data: { branch_name: 'Shop', receipt_designs: { version: 1 } } });
            }
        }
    };

    w.eval(read('frontend/static/script/js/modules/js/sales_view.js'));
    w.PosnicPro.sales.view._layoutOverride = 'a4';
    w.PosnicPro.sales.view.returnPrintSales('return-1');

    assert.equal(requests[0].url, 'sales/returnPrintDetails');
    assert.equal(requests[1].url, 'branches/getOneStore');
    assert.equal(printed.length, 1);
    const [branch, custom, lines, layout] = printed[0];
    assert.equal(branch.branch_name, 'Shop');
    assert.equal(custom.sales_id, 'S100');
    assert.deepEqual(lines.map((line) => line.item_name), ['Tea']);
    assert.equal(layout, 'a4');
    // One print, one paper choice: the next receipt follows the shop setting.
    assert.equal(w.PosnicPro.sales.view._layoutOverride, null);
});

test('a branch read that fails still prints the return through the designer', (t) => {
    const dom = new JSDOM('<div id="receipt_wrapper"></div>', {
        url: 'http://localhost/',
        runScripts: 'outside-only'
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.$ = w.jQuery = require('jquery')(w);
    const printed = [];
    w.PosnicPro = {
        realtime: null,
        local: { get: () => '' },
        receiptDesigner: {
            printReturn: function () {
                printed.push(Array.from(arguments));
            }
        },
        sales: { view: { _layoutOverride: null } },
        get: function (options, success, failure) {
            if (options.url === 'sales/returnPrintDetails') {
                success({
                    type: 'success',
                    data: {
                        custom_data: { sales_id: 'S100' },
                        return_data: [{ item_name: 'Tea', item_quantity: 1, item_total_amount: 10 }]
                    }
                });
            } else if (options.url === 'branches/getOneStore') {
                failure(new Error('offline'));
            }
        }
    };

    w.eval(read('frontend/static/script/js/modules/js/sales_view.js'));
    w.PosnicPro.sales.view.returnPrintSales('return-1');

    assert.equal(printed.length, 1);
    assert.equal(Object.keys(printed[0][0]).length, 0);
    assert.equal(printed[0][2][0].item_name, 'Tea');
});
