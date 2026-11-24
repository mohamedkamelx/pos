const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const jquery=require('jquery');
const sales=fs.readFileSync('frontend/static/script/js/modules/js/sales.js','utf8');
function env(html='') {
 const dom=new JSDOM(html,{runScripts:'outside-only'});const w=dom.window;w.$=jquery(w);
 w.PosnicPro={sales:{},i18n:{t:(k,f)=>f},local:{get:()=> 'EGP'},get:()=>{},post:()=>{},alert:()=>{}};
 return {dom,w,$:w.$};
}
test('missing product discounts render zero and valid percentage/amount discounts remain intact',()=>{
 const {dom,w}=env();
 try {
  const a=sales.indexOf('        // Imported/catalogue products');
  const b=sales.indexOf('        var id = params.id ? params.id : params.item_id;',a);
  for(const [fields,display,discount] of [[{},'0%',0],[{discount_percentage:'10'},'10%',2],[{discount_amount:'3'},'EGP3',3]]) {
   w.params={selling_price:20,...fields};w.eval(sales.slice(a,b));
   assert.equal(w.discountDisplay,display);assert.equal(w.Discount,discount);
  }
 } finally {dom.window.close();}
});

test('cart quantity counts units rather than lines and handles fractional quantities',()=>{
 const {dom,w,$}=env('<span class="sale-cart-quantity"></span><span class="sale-cart-lines"></span>');
 try {
  const a=sales.indexOf('        var cartQuantity =');const b=sales.indexOf('        var addSalesSubTotal',a);
  w.PosnicPro.sales.addLineTable=[{item_id:'a',item_quantity:1},{item_id:'b',item_quantity:1},{item_id:'c',item_quantity:3}];w.eval(sales.slice(a,b));
  assert.equal($('.sale-cart-quantity').text(),'5');assert.equal($('.sale-cart-lines').text(),'3');
  w.PosnicPro.sales.addLineTable=[{item_id:'a',item_quantity:0.1},{item_id:'b',item_quantity:0.2}];w.eval(sales.slice(a,b));assert.equal($('.sale-cart-quantity').text(),'0.3');
  w.PosnicPro.sales.addLineTable=[{item_id:'',item_quantity:undefined}];w.eval(sales.slice(a,b));assert.equal($('.sale-cart-lines').text(),'0');assert.equal($('.sale-cart-quantity').text(),'0');
  w.PosnicPro.sales.addLineTable=[];w.eval(sales.slice(a,b));assert.equal($('.sale-cart-quantity').text(),'0');
 } finally {dom.window.close();}
});
test('typing a bill-only name clears the selected account and personal details without creating a customer', () => {
 const fields=['id','name','phone','email','address','state','country','partial_balance'];
 const {dom,w,$}=env(fields.map(f=>'<input id="sales_new_customer_'+f+'" value="old">').join('')+'<input id="customer_current_balance" value="50">');
 try {
  w.PosnicPro.local.set=()=>{};
  w.PosnicPro.sales.refreshCustomerAccount=()=>{};
  const a=sales.indexOf('// A typed name is a sale snapshot');
  w.eval(sales.slice(a,sales.indexOf("$('#sales_new_customer_name').click",a)));
  $('#sales_new_customer_name').val('Bharat visitor').trigger('input');
  assert.equal($('#sales_new_customer_name').val(),'Bharat visitor');
  for(const f of fields.filter(f=>f!=='name')) assert.equal($('#sales_new_customer_'+f).val(),'');
  assert.equal($('#customer_current_balance').val(),'');
  $('#sales_new_customer_phone').val('12345');
  $('#sales_new_customer_name').val('Bharat visitor 2').trigger('input');
  assert.equal($('#sales_new_customer_phone').val(),'12345','bill-only details survive further typing');
 } finally {dom.window.close();}
});


test('a late default-customer lookup cannot replace a typed or chosen customer', () => {
 const source=fs.readFileSync('frontend/static/script/js/core/PosnicPro.js','utf8');
 const start=source.indexOf('defaultcustomerSet: function () {');
 const callback=source.indexOf('PosnicPro.get(params, function (response)',start);
 const end=source.indexOf("}, function () { /* same: absent default",callback);
 const {dom,w,$}=env('<input id="sales_new_customer_name" value="Typed customer"><input id="sales_new_customer_id" value="chosen">');
 try {
  w.PosnicPro.local.set=()=>{};
  w.PosnicPro.get=(_p,done)=>done({type:'success',data:{customer:{customer_id:'default',customer_name:'Walk-in'}}});
  w.eval('var params={};'+source.slice(callback,end)+'});');
  assert.equal($('#sales_new_customer_name').val(),'Typed customer');
  assert.equal($('#sales_new_customer_id').val(),'chosen');
 } finally {dom.window.close();}
});
