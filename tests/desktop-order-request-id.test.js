'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('frontend/static/script/js/modules/js/sales.js','utf8');
function state(localHttp = false) {
 let number=0;
 const PosnicPro={sales:{_idempotencyKey:null}};
 const window={crypto:localHttp ? {getRandomValues:bytes=>bytes.fill(++number)} : {randomUUID:()=>`request-${++number}`}};
 new Function('PosnicPro','window',source.slice(0,source.indexOf('    lineTotals:'))+'};')(PosnicPro,window);
 return PosnicPro.sales;
}
test('repeated sends and failed-request retries keep the same identity',()=>{
 const sales=state();const first=sales.idempotencyKey();
 assert.equal(sales.idempotencyKey(),first);
 assert.equal(sales.idempotencyKey(),first);
 sales.resetIdempotencyKey();assert.notEqual(sales.idempotencyKey(),first);
});
test('new desktop sales clear identity only on confirmation or explicit no-write rejection',()=>{
 const start=source.indexOf("            var params = {\n                url: 'sales',");
 const send=source.slice(start,source.indexOf('    sendSalesReceipt: function (sales_id) {',start));
 assert.match(send,/idempotencyKey:\s*PosnicPro\.sales\.idempotencyKey\(\)/);
 assert.ok(send.indexOf('submissionJournal().confirm(savedSubmission, response)') < send.indexOf('resetIdempotencyKey()'));
 assert.equal((send.match(/resetIdempotencyKey\(\)/g)||[]).length,2);
 assert.match(send,/if \(PosnicPro\.sales\.submissionJournal\(\)\.reject\(savedSubmission, response\)\) \{\s*PosnicPro\.sales\.resetIdempotencyKey\(\)/);
 assert.match(source,/showAdd: function \(\) \{\s*PosnicPro\.sales\.resetIdempotencyKey\(\);/);
 assert.match(source,/clear\.cartItems = function \(isFalse\) \{\s*PosnicPro\.sales\.resetIdempotencyKey\(\);/);
});

test('local HTTP uses secure random bytes when randomUUID is unavailable',()=>{
 const sales=state(true);const first=sales.idempotencyKey();assert.match(first,/^[a-f0-9]{32}$/);
 assert.equal(sales.idempotencyKey(),first);sales.resetIdempotencyKey();assert.notEqual(sales.idempotencyKey(),first);
});
