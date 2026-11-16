'use strict';
const crypto=require('node:crypto');
const {transaction,integrity}=require('./db.cjs');
let bcrypt;try{bcrypt=require('bcryptjs');}catch(_){bcrypt=null;}
const iso=()=>new Date().toISOString();
const str=(v,max=250)=>String(v??'').trim().slice(0,max);
const pos=(n,label='Amount')=>{if(!Number.isSafeInteger(Number(n))||Number(n)<0)throw Error(`${label} must be a non-negative whole number of paisa`);return Number(n);};
const qty=(n)=>{n=Number(n);if(!Number.isFinite(n)||n<=0||n>1e7)throw Error('Quantity must be greater than zero');return Math.round(n*1000)/1000;};
const must=(c,msg)=>{if(!c)throw Error(msg);};
const row=(db,sql,...params)=>db.prepare(sql).get(...params);
const all=(db,sql,...params)=>db.prepare(sql).all(...params);
const run=(db,sql,...params)=>db.prepare(sql).run(...params);
const moneyFromQty=(q,p)=>Math.round(q*p);
const hash=(v)=>{if(bcrypt)return bcrypt.hashSync(v,12); const salt=crypto.randomBytes(16).toString('hex');return `scrypt$${salt}$${crypto.scryptSync(v,salt,64).toString('hex')}`;};
const verify=(v,h)=>{if(h.startsWith('scrypt$')){const a=h.split('$');return crypto.timingSafeEqual(Buffer.from(a[2],'hex'),crypto.scryptSync(v,a[1],64));}return !!bcrypt&&bcrypt.compareSync(v,h);};
const roles={owner:['*'],manager:['catalog','stock','purchases','customers','sale','returns','expenses','cash','reports','warranty'],cashier:['sale','customers','returns_request','warranty']};
const perm={
 'products:list':'sale','products:search':'sale','products:save':'catalog','products:archive':'catalog','products:import':'catalog','inventory:movements':'stock','inventory:adjust':'stock',
 'suppliers:list':'purchases','suppliers:save':'purchases','purchases:list':'purchases','purchases:save':'purchases','suppliers:pay':'purchases',
 'customers:list':'customers','customers:save':'customers','customers:ledger':'customers','customers:pay':'customers',
 'sales:save':'sale','sales:list':'sale','sales:detail':'sale','drafts:list':'sale','drafts:save':'sale','drafts:delete':'sale',
 'returns:save':'returns','returns:list':'sale','expenses:list':'expenses','expenses:save':'expenses',
 'reports:summary':'reports','reports:breakdown':'reports','dashboard:get':'sale',
 'cash:current':'cash','cash:open':'cash','cash:close':'cash','cash:move':'cash',
 'warranty:search':'warranty','warranty:claim':'warranty',
 'settings:get':'sale','settings:save':'owner','users:list':'owner','users:save':'owner','audit:list':'owner',
 'system:check':'owner','search:rebuild':'owner'
};
class ShopService{
 constructor(db){this.db=db;this.user=null;this.failed=new Map();}
 _audit(action,details={},user=this.user){run(this.db,'INSERT INTO audit_log(user_id,action,details,created_at) VALUES(?,?,?,?)',user?.id||null,action,JSON.stringify(details),iso());}
 _check(action){must(this.user,'Please log in.');const p=perm[action];must(p,'Unknown action');const allowed=roles[this.user.role]||[];must(allowed.includes('*')||allowed.includes(p),'You do not have permission for this action');}
 _cost(){return this.user?.role==='owner'||this.user?.role==='manager';}
 _productSafe(p){if(!p)return p;if(this._cost())return p;const {cost_price,min_price,...safe}=p;return safe;}
 _saleSafe(s){if(!s)return s;if(this._cost())return s;const {unit_cost,...safe}=s;return safe;}
 _balance(id){return row(this.db,'SELECT COALESCE(SUM(amount),0) AS v FROM customer_ledger WHERE customer_id=?',id)?.v||0;}
 _supplierBalance(id){return (row(this.db,'SELECT COALESCE(SUM(total-paid),0) AS v FROM purchases WHERE supplier_id=?',id)?.v||0)-(row(this.db,'SELECT COALESCE(SUM(amount),0) AS v FROM supplier_payments WHERE supplier_id=?',id)?.v||0);}
 _stock(productId,delta,type,cost,refType,refId,reason=''){
   const p=row(this.db,'SELECT id,stock_qty FROM products WHERE id=?',productId);must(p,'Product not found');
   const next=Math.round((p.stock_qty+delta)*1000)/1000;
   must(next>=-0.000001,'Insufficient stock');
   run(this.db,'UPDATE products SET stock_qty=?,updated_at=? WHERE id=?',next,iso(),productId);
   run(this.db,'INSERT INTO stock_movements(product_id,type,qty_change,unit_cost,ref_type,ref_id,reason,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',productId,type,delta,cost,refType,refId,reason,this.user?.id||null,iso());
 }
 _product(x,id){const name=str(x.name,200);must(name,'Product name required');
   const cost=pos(x.cost_price||0),price=pos(x.retail_price||0),min=pos(x.min_price||0);
   must(min<=price,'Minimum price cannot exceed retail price');
   return [name,str(x.brand,120),str(x.model,120),str(x.category,120),str(x.unit,24)||'pcs',str(x.barcode,100)||null,str(x.sku,100)||null,str(x.aliases,1000),str(x.description,2000),cost,price,min,Math.max(0,Number(x.reorder_level)||0)];
 }
 _saveProduct(x){const a=this._product(x);const now=iso();let id=Number(x.id)||0;
   if(id){const old=row(this.db,'SELECT * FROM products WHERE id=?',id);must(old,'Product not found');
      run(this.db,`UPDATE products SET name=?,brand=?,model=?,category=?,unit=?,barcode=?,sku=?,aliases=?,description=?,cost_price=?,retail_price=?,min_price=?,reorder_level=?,updated_at=? WHERE id=?`,...a,now,id);
      if(old.cost_price!==a[9]||old.retail_price!==a[10])run(this.db,'INSERT INTO price_history(product_id,old_cost,old_price,new_cost,new_price,user_id,created_at) VALUES(?,?,?,?,?,?,?)',id,old.cost_price,old.retail_price,a[9],a[10],this.user.id,now);
   }else{
      const r=run(this.db,`INSERT INTO products(name,brand,model,category,unit,barcode,sku,aliases,description,cost_price,retail_price,min_price,reorder_level,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,...a,now,now,this.user.id);
      id=Number(r.lastInsertRowid);
      if(x.opening_qty&&Number(x.opening_qty)>0)this._stock(id,qty(x.opening_qty),'opening',a[9],'product',id);
   }
   this._audit(id?'product.save':'product.create',{id});return row(this.db,'SELECT * FROM products WHERE id=?',id);
 }
 _saveCustomer(x){const name=str(x.name,150);must(name,'Customer name required');if(this.user?.role==='cashier')must(!x.id&&!Number(x.credit_limit),'Cashiers may only add customers, not change credit limits');const lim=pos(x.credit_limit||0);
   if(x.id){run(this.db,'UPDATE customers SET name=?,phone=?,address=?,notes=?,credit_limit=? WHERE id=?',name,str(x.phone,60),str(x.address,250),str(x.notes,500),lim,Number(x.id));return Number(x.id);}
   return Number(run(this.db,'INSERT INTO customers(name,phone,address,notes,credit_limit,created_at) VALUES(?,?,?,?,?,?)',name,str(x.phone,60),str(x.address,250),str(x.notes,500),lim,iso()).lastInsertRowid);
 }
 _customerList(){return all(this.db,`SELECT c.*,COALESCE((SELECT SUM(amount) FROM customer_ledger l WHERE l.customer_id=c.id),0) AS balance FROM customers c ORDER BY c.name`);}
 _search(text,limit=70){const query=str(text,120).toLowerCase();let results=[];
  if(!query)return all(this.db,'SELECT * FROM products WHERE is_active=1 ORDER BY name LIMIT ?',Math.min(250,limit)).map(p=>this._productSafe(p));
  const tokens=(query.match(/[\p{L}\p{N}]+/gu)||[]).slice(0,8);
  if(tokens.length){try{const matches=all(this.db,`SELECT p.*,bm25(products_fts) AS score FROM products_fts JOIN products p ON p.id=products_fts.rowid WHERE products_fts MATCH ? AND p.is_active=1 ORDER BY score LIMIT 100`,tokens.map(t=>`"${t.replaceAll('"','')}"*`).join(' ')); results.push(...matches);}catch(_){}}
  if(results.length<limit){const seen=new Set(results.map(x=>x.id));const candidates=all(this.db,'SELECT * FROM products WHERE is_active=1 ORDER BY id DESC LIMIT 5000');
   const dist=(a,b)=>{if(a===b)return 0;if(Math.abs(a.length-b.length)>3)return 5;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const cur=[i];for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}return prev[b.length];};
   const scored=[];for(const p of candidates){if(seen.has(p.id))continue;const hay=[p.name,p.brand,p.model,p.category,p.aliases,p.barcode,p.sku].filter(Boolean).join(' ').toLowerCase();let score=hay.includes(query)?0.5:100;const words=hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);for(const t of tokens){let best=9;for(const w of words){if(w.startsWith(t)){best=0;break;}if(t.length>2&&Math.abs(w.length-t.length)<3)best=Math.min(best,dist(t,w));}score=Math.min(score,best===0?1:best<=2?3+best:100);}if(score<10)scored.push({...p,_rank:score});}
   scored.sort((a,b)=>a._rank-b._rank||b.stock_qty-a.stock_qty);results.push(...scored.slice(0,limit-results.length));
  }
  return results.slice(0,limit).map(x=>{const {score,_rank,...p}=x;return this._productSafe(p);});
 }
 _addSale(input){const draftId=Number(input.draft_id)||null;if(draftId){const existing=row(this.db,'SELECT id,bill_no,total FROM sales WHERE draft_id=?',draftId);if(existing)return existing;}const items=input.items||[];must(items.length&&items.length<=200,'Add products to the bill');
  const customerId=Number(input.customer_id)||null;
  const customer=customerId?row(this.db,'SELECT * FROM customers WHERE id=?',customerId):null;
  if(customerId)must(customer,'Customer not found');
  const parsed=[];let sub=0;
  for(const x of items){const p=row(this.db,'SELECT * FROM products WHERE id=? AND is_active=1',Number(x.product_id));must(p,`Product ${x.product_id} was not found`);
    const q=qty(x.qty);const price=pos(x.unit_price??p.retail_price),discount=pos(x.discount||0);
    const line=moneyFromQty(q,price)-discount;
    must(line>=0,`Invalid discount on ${p.name}`);
    must(this.user.role==='owner'||price>=p.min_price,`Below-minimum price requires owner approval: ${p.name}`);
    must(this.user.role==='owner'||price>=p.cost_price,`Below-cost price requires owner approval: ${p.name}`);
    must(this.user.role!=='cashier'||price===p.retail_price,'Cashiers cannot edit prices');
    must(p.stock_qty>=q,`Not enough stock for ${p.name} (available ${p.stock_qty})`);
    if(this.user.role==='cashier')must(discount<=Math.floor(q*price*0.10),'Cashier discount exceeds 10%');
    parsed.push({p,q,price,discount,line,serial:str(x.serial,120)||null,warranty_months:Math.max(0,Math.floor(Number(x.warranty_months)||0))});sub+=line;
  }
  const discount=pos(input.discount||0);must(discount<=sub,'Bill discount exceeds subtotal');if(this.user.role==='cashier')must(discount<=Math.floor(sub*0.1),'Cashier bill discount exceeds 10%');
  const total=sub-discount;const payments=(input.payments||[]).filter(x=>Number(x.amount)>0).map(p=>({method:str(p.method,40),amount:pos(p.amount),tendered:pos(p.tendered??p.amount)}));
  must(payments.length,'Add a payment method');
  must(payments.every(p=>['cash','bank','wallet','card','credit'].includes(p.method)),'Invalid payment method');
  must(payments.reduce((a,p)=>a+p.amount,0)===total,'Payments plus credit must exactly equal bill total');
  must(payments.filter(p=>p.method==='cash').every(p=>p.tendered>=p.amount),'Cash received is less than amount due');
  const credit=payments.filter(p=>p.method==='credit').reduce((a,p)=>a+p.amount,0);
  must(!credit||customer,'Choose a customer for an udhaar sale');
  if(credit&&customer.credit_limit>0)must(this._balance(customer.id)+credit<=customer.credit_limit,`Credit limit exceeded for ${customer.name}`);
  const now=iso();const year=now.substring(0,4);const next=(row(this.db,'SELECT MAX(CAST(SUBSTR(bill_no,6) AS INTEGER)) AS v FROM sales WHERE bill_no LIKE ?',`${year}-%`)?.v||0)+1;
  const billNo=`${year}-${String(next).padStart(6,'0')}`;
  const paid=total-credit;const id=Number(run(this.db,'INSERT INTO sales(bill_no,draft_id,customer_id,user_id,subtotal,discount,total,paid,outstanding,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',billNo,draftId,customerId,this.user.id,sub,discount,total,paid,credit,now).lastInsertRowid);
  for(const it of parsed){const lineId=Number(run(this.db,'INSERT INTO sale_items(sale_id,product_id,product_name,qty,unit_price,unit_cost,discount,line_total,warranty_months,serial) VALUES(?,?,?,?,?,?,?,?,?,?)',id,it.p.id,it.p.name,it.q,it.price,it.p.cost_price,it.discount,it.line,it.warranty_months,it.serial).lastInsertRowid);
     this._stock(it.p.id,-it.q,'sale',it.p.cost_price,'sale',id);
     if(it.warranty_months>0&&it.serial)run(this.db,'INSERT INTO warranties(sale_item_id,serial,months,created_at) VALUES(?,?,?,?)',lineId,it.serial,it.warranty_months,now);
  }
  for(const p of payments){run(this.db,'INSERT INTO sale_payments(sale_id,method,amount,tendered,created_at) VALUES(?,?,?,?,?)',id,p.method,p.amount,p.tendered,now);}
  if(credit)run(this.db,'INSERT INTO customer_ledger(customer_id,type,amount,reference,method,created_at,user_id) VALUES(?,?,?,?,?,?,?)',customer.id,'credit_sale',credit,billNo,'credit',now,this.user.id);
  if(draftId)run(this.db,'DELETE FROM drafts WHERE id=? AND user_id=?',draftId,this.user.id);
  this._audit('sale.create',{id,billNo,total,credit});return {id,bill_no:billNo,total,paid,change:payments.filter(p=>p.method==='cash').reduce((s,p)=>s+p.tendered-p.amount,0)};
 }
 _addReturn(input){const sale=row(this.db,'SELECT * FROM sales WHERE id=? AND status=?',Number(input.sale_id),'completed');must(sale,'Sale not found');
  const reason=str(input.reason,400);must(reason,'A return reason is required');
  const method=str(input.refund_method);must(['cash','credit_adjustment','store_credit'].includes(method),'Select a valid refund method');
  if(method!=='cash')must(sale.customer_id,'Customer account required for account adjustment');
  const lines=[];let total=0;
  for(const x of input.items||[]){const it=row(this.db,'SELECT * FROM sale_items WHERE id=? AND sale_id=?',Number(x.sale_item_id),sale.id);must(it,'Original bill item not found');const returned=row(this.db,'SELECT COALESCE(SUM(qty),0) AS qty,COALESCE(SUM(refund_amount),0) AS refunded FROM return_items WHERE sale_item_id=?',it.id);
    const q=qty(x.qty);must(q<=it.qty-returned.qty+1e-8,`Return quantity exceeds sold quantity for ${it.product_name}`);
    const fullRefund=sale.subtotal?Math.round(it.line_total*sale.total/sale.subtotal):0;
    const amount=Math.min(fullRefund-returned.refunded,Math.round(fullRefund*q/it.qty));must(amount>=0,'Invalid refund calculation');
    lines.push({it,q,amount,restock:!!x.restock});total+=amount;
  }
  must(lines.length&&total>0,'Choose items to return');
  if(method==='credit_adjustment')must(this._balance(sale.customer_id)>=total,'Refund exceeds the amount the customer owes. Use store credit or cash instead.');
  const id=Number(run(this.db,'INSERT INTO returns(sale_id,customer_id,reason,refund_method,total,user_id,created_at) VALUES(?,?,?,?,?,?,?)',sale.id,sale.customer_id,reason,method,total,this.user.id,iso()).lastInsertRowid);
  for(const it of lines){run(this.db,'INSERT INTO return_items(return_id,sale_item_id,product_id,qty,refund_amount,unit_cost,restock) VALUES(?,?,?,?,?,?,?)',id,it.it.id,it.it.product_id,it.q,it.amount,it.it.unit_cost,it.restock?1:0);
    if(it.restock)this._stock(it.it.product_id,it.q,'return',it.it.unit_cost,'return',id,reason);
  }
  if(method!=='cash')run(this.db,'INSERT INTO customer_ledger(customer_id,type,amount,reference,method,created_at,user_id) VALUES(?,?,?,?,?,?,?)',sale.customer_id,'return',-total,`Return #${id}`,method,iso(),this.user.id);
  this._audit('sale.return',{id,sale_id:sale.id,total,method});return {id,total};
 }
 _dateRange(x){const from=str(x.from,10),to=str(x.to,10);must(/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to),'Please select both dates');must(from<=to,'From date cannot be after To date');
  const start=new Date(`${from}T00:00:00+05:00`),last=new Date(`${to}T00:00:00+05:00`),end=new Date(last.getTime()+86400000);must(Number.isFinite(+start)&&Number.isFinite(+end)&&new Date(start.getTime()+5*3600e3).toISOString().slice(0,10)===from&&new Date(last.getTime()+5*3600e3).toISOString().slice(0,10)===to,'Invalid date');return [start.toISOString(),end.toISOString()];}
 _report(x){const [start,end]=this._dateRange(x);
  const sales=row(this.db,`SELECT COALESCE(SUM(total),0) revenue,COALESCE(SUM(subtotal),0) subtotal,COALESCE(SUM(discount),0) discounts,COUNT(*) bills FROM sales WHERE status='completed' AND created_at>=? AND created_at<?`,start,end);
  const costs=row(this.db,`SELECT COALESCE(SUM(si.qty*si.unit_cost),0) cogs FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND s.created_at>=? AND s.created_at<?`,start,end);
  const returns=row(this.db,`SELECT COALESCE(SUM(ri.refund_amount),0) refunds,COALESCE(SUM(ri.qty*ri.unit_cost),0) returned_cost FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE r.created_at>=? AND r.created_at<?`,start,end);
  const expenses=row(this.db,'SELECT COALESCE(SUM(amount),0) amount FROM expenses WHERE spent_at>=? AND spent_at<?',start,end);
  const revenue=sales.revenue-returns.refunds,cogs=Math.round(costs.cogs-returns.returned_cost),grossProfit=revenue-cogs,expenseAmount=x.include_expenses===false?0:expenses.amount;
  return {from:x.from,to:x.to,revenue,subtotal:sales.subtotal,discounts:sales.discounts,returns:returns.refunds,cogs,gross_profit:grossProfit,expenses:expenseAmount,net_profit:grossProfit-expenseAmount,margin_percent:revenue?Math.round(grossProfit/revenue*10000)/100:0,bills:sales.bills};
 }
 _saleDetail(id){const s=row(this.db,`SELECT s.*,c.name customer_name,u.username cashier_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?`,id);must(s,'Sale not found');let items=all(this.db,'SELECT * FROM sale_items WHERE sale_id=?',id).map(x=>this._saleSafe(x));const payments=all(this.db,'SELECT * FROM sale_payments WHERE sale_id=?',id);const returns=all(this.db,'SELECT * FROM returns WHERE sale_id=? ORDER BY id DESC',id);return {...s,items,payments,returns};}
 _cashCurrent(){const s=row(this.db,'SELECT * FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');if(!s)return null;
  const cashSale=row(this.db,`SELECT COALESCE(SUM(sp.amount),0) v FROM sale_payments sp JOIN sales sa ON sa.id=sp.sale_id WHERE sp.method='cash' AND sa.created_at>=?`,s.opened_at).v;
  const creditCash=row(this.db,`SELECT COALESCE(SUM(-amount),0) v FROM customer_ledger WHERE type='payment' AND method='cash' AND created_at>=?`,s.opened_at).v;
  const expense=row(this.db,`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE payment_method='cash' AND spent_at>=?`,s.opened_at).v;
  const refund=row(this.db,`SELECT COALESCE(SUM(total),0) v FROM returns WHERE refund_method='cash' AND created_at>=?`,s.opened_at).v;
  const supplierCash=row(this.db,`SELECT COALESCE(SUM(paid),0) v FROM purchases WHERE payment_method='cash' AND created_at>=?`,s.opened_at).v+row(this.db,`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE method='cash' AND created_at>=?`,s.opened_at).v;
  const moves=row(this.db,`SELECT COALESCE(SUM(CASE WHEN kind='in' THEN amount ELSE -amount END),0) v FROM cash_moves WHERE session_id=?`,s.id).v;
  return {...s,expected:s.opening+cashSale+creditCash-expense-refund-supplierCash+moves,cash_sale:cashSale,credit_cash:creditCash,expense,refund,supplier_cash:supplierCash,moves};
 }
 _settings(){return Object.fromEntries(all(this.db,'SELECT key,value FROM settings').map(x=>[x.key,x.value]));}
 async action(action,x={}){
  if(action==='system:bootstrap')return {needs_setup:row(this.db,'SELECT COUNT(*) n FROM users').n===0,integrity:integrity(this.db),shop:this._settings().shop_name||'Electric Store POS'};
  if(action==='auth:setup'){must(row(this.db,'SELECT COUNT(*) n FROM users').n===0,'Setup is already complete');const name=str(x.username,40),password=String(x.password||'');must(name.length>=3&&password.length>=8,'Username must have 3+ characters and password 8+ characters');
   const key=crypto.randomBytes(18).toString('hex').toUpperCase();transaction(this.db,()=>{run(this.db,'INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',name,hash(password),'owner',iso());run(this.db,'INSERT INTO settings(key,value) VALUES(?,?)','recovery_hash',hash(key));run(this.db,'INSERT INTO settings(key,value) VALUES(?,?)','shop_name',str(x.shop_name,100)||'Electric Store');this._audit('system.setup',{username:name},null);});return {recovery_key:key};
  }
  if(action==='auth:login'){const name=str(x.username,40),attempt=this.failed.get(name)||{count:0,until:0};must(attempt.until<Date.now(),'Too many attempts. Try again in one minute.');const u=row(this.db,'SELECT * FROM users WHERE username=? AND active=1',name);
    if(!u||!verify(String(x.password||''),u.password_hash)){const count=attempt.count+1;this.failed.set(name,{count,until:count>=5?Date.now()+60000:0});throw Error('Invalid username or password');}
    this.failed.delete(name);this.user={id:u.id,username:u.username,role:u.role};this._audit('auth.login');return this.user;}
  if(action==='auth:recover'){const settings=this._settings();must(settings.recovery_hash&&verify(String(x.key||'').trim().toUpperCase(),settings.recovery_hash),'Invalid recovery key');const pass=String(x.password||'');must(pass.length>=8,'Password must have 8+ characters');transaction(this.db,()=>{run(this.db,"UPDATE users SET password_hash=? WHERE role='owner'",hash(pass));this._audit('owner.recovered',{},null);});return {ok:true};}
  if(action==='auth:session')return this.user;
  if(action==='auth:logout'){this.user=null;return {ok:true};}
  this._check(action);
  switch(action){
   case 'products:list':return all(this.db,`SELECT * FROM products ORDER BY is_active DESC,name ASC LIMIT 10000`).map(p=>this._productSafe(p));
   case 'products:search':return this._search(x.query,Math.max(1,Math.min(200,Number(x.limit)||70)));
   case 'products:save':return transaction(this.db,()=>this._saveProduct(x));
   case 'products:archive':return transaction(this.db,()=>{run(this.db,'UPDATE products SET is_active=?,updated_at=? WHERE id=?',x.active?1:0,iso(),Number(x.id));this._audit('product.archive',{id:x.id,active:!!x.active});return {ok:true};});
   case 'products:import':return transaction(this.db,()=>{must(Array.isArray(x.rows)&&x.rows.length<=5000,'Import up to 5,000 products at a time');let count=0;for(const r of x.rows){const match=(!r.id&&r.barcode)?row(this.db,'SELECT id FROM products WHERE barcode=?',r.barcode):null;this._saveProduct({...r,id:r.id||match?.id});count++;}this._audit('products.import',{count});return {count};});
   case 'inventory:movements':return all(this.db,`SELECT m.*,p.name product_name,u.username FROM stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 500`);
   case 'inventory:adjust':return transaction(this.db,()=>{const p=row(this.db,'SELECT * FROM products WHERE id=?',Number(x.product_id));must(p,'Choose a product');const reason=str(x.reason,250);must(reason,'Adjustment reason is required');const newQty=Number(x.new_qty);must(Number.isFinite(newQty)&&newQty>=0,'Count cannot be negative');const delta=Math.round((newQty-p.stock_qty)*1000)/1000;must(delta,'No stock difference');this._stock(p.id,delta,'adjustment',p.cost_price,'adjustment',null,reason);this._audit('stock.adjust',{id:p.id,delta,reason});return {new_qty:newQty};});
   case 'suppliers:list':return all(this.db,'SELECT * FROM suppliers ORDER BY name').map(s=>({...s,balance:this._supplierBalance(s.id)}));
   case 'suppliers:save':return transaction(this.db,()=>{const name=str(x.name,140);must(name,'Supplier name required');let id;if(x.id){id=Number(x.id);run(this.db,'UPDATE suppliers SET name=?,phone=?,address=?,notes=? WHERE id=?',name,str(x.phone),str(x.address),str(x.notes),id);}else{id=Number(run(this.db,'INSERT INTO suppliers(name,phone,address,notes,created_at) VALUES(?,?,?,?,?)',name,str(x.phone),str(x.address),str(x.notes),iso()).lastInsertRowid);}this._audit('supplier.save',{id});return {id};});
   case 'purchases:list':return all(this.db,`SELECT p.*,s.name supplier_name,(p.total-p.paid-COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.purchase_id=p.id),0)) balance FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC LIMIT 500`);
   case 'purchases:save':return transaction(this.db,()=>{const supplier=row(this.db,'SELECT * FROM suppliers WHERE id=?',Number(x.supplier_id));must(supplier,'Select a supplier');let subtotal=0;const lines=[];for(const a of x.items||[]){const p=row(this.db,'SELECT * FROM products WHERE id=?',Number(a.product_id));must(p,'Product missing');const q=qty(a.qty),cost=pos(a.unit_cost),amount=moneyFromQty(q,cost);lines.push({p,q,cost,amount});subtotal+=amount;}must(lines.length,'Add purchase items');const discount=pos(x.discount||0),freight=pos(x.freight||0);must(discount<=subtotal,'Invalid discount');const total=subtotal-discount+freight,paid=pos(x.paid||0);must(paid<=total,'Paid amount cannot exceed total');const id=Number(run(this.db,'INSERT INTO purchases(supplier_id,subtotal,discount,freight,total,paid,payment_method,created_at,user_id) VALUES(?,?,?,?,?,?,?,?,?)',supplier.id,subtotal,discount,freight,total,paid,str(x.payment_method)||'cash',iso(),this.user.id).lastInsertRowid);
    for(const it of lines){run(this.db,'INSERT INTO purchase_items(purchase_id,product_id,qty,unit_cost,line_total) VALUES(?,?,?,?,?)',id,it.p.id,it.q,it.cost,it.amount);const fresh=row(this.db,'SELECT * FROM products WHERE id=?',it.p.id);const average=Math.round((fresh.stock_qty*fresh.cost_price+it.q*it.cost)/(fresh.stock_qty+it.q));this._stock(it.p.id,it.q,'purchase',it.cost,'purchase',id);run(this.db,'UPDATE products SET cost_price=? WHERE id=?',average,it.p.id);run(this.db,'INSERT INTO price_history(product_id,old_cost,old_price,new_cost,new_price,user_id,created_at) VALUES(?,?,?,?,?,?,?)',it.p.id,fresh.cost_price,fresh.retail_price,average,fresh.retail_price,this.user.id,iso());}
    this._audit('purchase.create',{id,total,paid});return {id,total};});
   case 'suppliers:pay':return transaction(this.db,()=>{const supplierId=Number(x.supplier_id),amount=pos(x.amount);must(amount>0&&row(this.db,'SELECT id FROM suppliers WHERE id=?',supplierId),'Select supplier and payment amount');must(amount<=this._supplierBalance(supplierId),'Payment exceeds supplier balance');const purchaseId=Number(x.purchase_id)||null;if(purchaseId)must(row(this.db,'SELECT id FROM purchases WHERE supplier_id=? AND id=?',supplierId,purchaseId),'Purchase does not belong to supplier');const purchases=all(this.db,`SELECT p.id,(p.total-p.paid-COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.purchase_id=p.id),0)) due FROM purchases p WHERE p.supplier_id=? ${purchaseId?'AND p.id=?':''} ORDER BY p.id`,...(purchaseId?[supplierId,purchaseId]:[supplierId]));let rest=amount;for(const p of purchases){if(rest<=0)break;const part=Math.min(rest,p.due);if(part<=0)continue;run(this.db,'INSERT INTO supplier_payments(supplier_id,purchase_id,amount,method,created_at,user_id) VALUES(?,?,?,?,?,?)',supplierId,p.id,part,str(x.method)||'cash',iso(),this.user.id);rest-=part;}must(rest===0,'Payment is greater than the selected purchase balance');this._audit('supplier.payment',{supplierId,amount});return {ok:true};});
   case 'customers:list':return this._customerList();
   case 'customers:save':return transaction(this.db,()=>{const id=this._saveCustomer(x);this._audit('customer.save',{id});return {id};});
   case 'customers:ledger':return {customer:row(this.db,'SELECT * FROM customers WHERE id=?',Number(x.id)),balance:this._balance(Number(x.id)),entries:all(this.db,'SELECT * FROM customer_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 300',Number(x.id))};
   case 'customers:pay':return transaction(this.db,()=>{const id=Number(x.customer_id),amount=pos(x.amount);must(amount>0,'Payment amount required');must(amount<=this._balance(id),'Payment is more than customer owes');const method=str(x.method)||'cash';must(['cash','bank','wallet','card'].includes(method),'Invalid payment method');run(this.db,'INSERT INTO customer_ledger(customer_id,type,amount,reference,method,created_at,user_id) VALUES(?,?,?,?,?,?,?)',id,'payment',-amount,str(x.reference,100),method,iso(),this.user.id);this._audit('customer.payment',{id,amount});return {balance:this._balance(id)};});
   case 'drafts:list':return all(this.db,'SELECT * FROM drafts WHERE user_id=? ORDER BY updated_at DESC',this.user.id).map(d=>({...d,body:JSON.parse(d.body)}));
   case 'drafts:save':return transaction(this.db,()=>{const body=JSON.stringify(x.body||{});must(body.length<200000,'Bill draft is too large');let id=Number(x.id)||0;if(id){must(row(this.db,'SELECT id FROM drafts WHERE id=? AND user_id=?',id,this.user.id),'Draft not found');run(this.db,'UPDATE drafts SET body=?,label=?,held=?,updated_at=? WHERE id=?',body,str(x.label,100),x.held?1:0,iso(),id);}else{id=Number(run(this.db,'INSERT INTO drafts(user_id,label,body,held,updated_at) VALUES(?,?,?,?,?)',this.user.id,str(x.label,100),body,x.held?1:0,iso()).lastInsertRowid);}return {id};});
   case 'drafts:delete':return transaction(this.db,()=>{run(this.db,'DELETE FROM drafts WHERE id=? AND user_id=?',Number(x.id),this.user.id);return {ok:true};});
   case 'sales:save':return transaction(this.db,()=>this._addSale(x));
   case 'sales:list':return all(this.db,`SELECT s.id,s.bill_no,s.total,s.paid,s.outstanding,s.created_at,s.printed,s.status,c.name customer_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT 600`);
   case 'sales:detail':return this._saleDetail(Number(x.id));
   case 'returns:save':return transaction(this.db,()=>this._addReturn(x));
   case 'returns:list':return all(this.db,`SELECT r.*,s.bill_no FROM returns r JOIN sales s ON s.id=r.sale_id ORDER BY r.id DESC LIMIT 300`);
   case 'expenses:list':return all(this.db,'SELECT * FROM expenses ORDER BY id DESC LIMIT 500');
   case 'expenses:save':return transaction(this.db,()=>{const amount=pos(x.amount),category=str(x.category,80);must(amount>0&&category,'Category and amount required');const id=Number(run(this.db,'INSERT INTO expenses(category,amount,payment_method,note,spent_at,user_id) VALUES(?,?,?,?,?,?)',category,amount,str(x.payment_method)||'cash',str(x.note,400),iso(),this.user.id).lastInsertRowid);this._audit('expense.create',{id,amount});return {id};});
   case 'cash:current':return this._cashCurrent();
   case 'cash:open':return transaction(this.db,()=>{must(!this._cashCurrent(),'Close the current cash session first');const id=Number(run(this.db,'INSERT INTO cash_sessions(opened_at,opening,opened_by) VALUES(?,?,?)',iso(),pos(x.opening||0),this.user.id).lastInsertRowid);this._audit('cash.open',{id});return {id};});
   case 'cash:move':return transaction(this.db,()=>{const s=this._cashCurrent();must(s,'Open a cash session');const kind=str(x.kind),reason=str(x.reason);must(['in','out'].includes(kind)&&reason,'Select direction and enter reason');run(this.db,'INSERT INTO cash_moves(session_id,kind,amount,reason,created_at,user_id) VALUES(?,?,?,?,?,?)',s.id,kind,pos(x.amount),reason,iso(),this.user.id);this._audit('cash.move',{kind,amount:x.amount});return this._cashCurrent();});
   case 'cash:close':return transaction(this.db,()=>{const s=this._cashCurrent();must(s,'No open cash session');const counted=pos(x.counted);run(this.db,'UPDATE cash_sessions SET closed_at=?,closing_expected=?,closing_counted=?,closed_by=? WHERE id=?',iso(),s.expected,counted,this.user.id,s.id);this._audit('cash.close',{id:s.id,expected:s.expected,counted,difference:counted-s.expected});return {difference:counted-s.expected};});
   case 'reports:summary':return this._report(x);
   case 'reports:breakdown':{const [start,end]=this._dateRange(x);const col=({product:'si.product_name',category:'p.category',customer:'COALESCE(c.name,\'Walk-in\')',cashier:'u.username'})[x.by]||'si.product_name';return all(this.db,`SELECT ${col} label,SUM(si.qty) quantity,SUM(si.line_total) sales,SUM(si.line_total-si.qty*si.unit_cost) profit FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id LEFT JOIN customers c ON c.id=s.customer_id JOIN users u ON u.id=s.user_id WHERE s.status='completed' AND s.created_at>=? AND s.created_at<? GROUP BY ${col} ORDER BY sales DESC LIMIT 200`,start,end);}
   case 'dashboard:get':{const now=new Date(Date.now()+5*3600e3).toISOString().slice(0,10);const today=this.user.role==='cashier'?null:this._report({from:now,to:now});const p=row(this.db,'SELECT COUNT(*) product_count,COALESCE(SUM(CASE WHEN stock_qty<=reorder_level THEN 1 ELSE 0 END),0) low_stock FROM products WHERE is_active=1');const [start,end]=this._dateRange({from:now,to:now});const s=row(this.db,'SELECT COUNT(*) bills,COALESCE(SUM(total),0) sales FROM sales WHERE created_at>=? AND created_at<?',start,end);const debt=row(this.db,'SELECT COALESCE(SUM(amount),0) balance FROM customer_ledger');return {...p,bills:s.bills,sales:s.sales,customer_debt:debt.balance,today};}
   case 'settings:get':{const {recovery_hash,...publicSettings}=this._settings();return publicSettings;}
   case 'settings:save':return transaction(this.db,()=>{const allowed=['shop_name','shop_phone','shop_address','shop_tax','receipt_footer','currency','backup_external_path','receipt_width'];for(const [k,v] of Object.entries(x)){if(allowed.includes(k))run(this.db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,str(v,1200));}this._audit('settings.save',{keys:Object.keys(x)});return this._settings();});
   case 'users:list':return all(this.db,'SELECT id,username,role,active,created_at FROM users ORDER BY id');
   case 'users:save':return transaction(this.db,()=>{const username=str(x.username,40),role=str(x.role),password=String(x.password||'');must(username.length>=3&&['owner','manager','cashier'].includes(role),'Invalid username or role');if(x.id){must(Number(x.id)!==this.user.id||x.active!==false,'Cannot deactivate yourself');const updates=['username=?','role=?','active=?'],args=[username,role,x.active===false?0:1];if(password){must(password.length>=8,'Password must be 8+ characters');updates.push('password_hash=?');args.push(hash(password));}args.push(Number(x.id));run(this.db,`UPDATE users SET ${updates.join(',')} WHERE id=?`,...args);}else{must(password.length>=8,'Password must have 8+ characters');run(this.db,'INSERT INTO users(username,role,password_hash,created_at) VALUES(?,?,?,?)',username,role,hash(password),iso());}must(row(this.db,"SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").n>0,'At least one active owner is required');this._audit('user.save',{username,role});return {ok:true};});
   case 'audit:list':return all(this.db,`SELECT a.*,u.username FROM audit_log a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.id DESC LIMIT 500`);
   case 'warranty:search':{const query=`%${str(x.query,100)}%`;return all(this.db,`SELECT w.*,si.product_name,s.bill_no,s.created_at sale_date,c.name customer_name,c.phone FROM warranties w JOIN sale_items si ON si.id=w.sale_item_id JOIN sales s ON s.id=si.sale_id LEFT JOIN customers c ON c.id=s.customer_id WHERE w.serial LIKE ? OR s.bill_no LIKE ? OR c.phone LIKE ? ORDER BY w.id DESC LIMIT 100`,query,query,query);}
   case 'warranty:claim':return transaction(this.db,()=>{const id=Number(x.warranty_id);must(row(this.db,'SELECT id FROM warranties WHERE id=?',id),'Warranty not found');run(this.db,'INSERT INTO warranty_claims(warranty_id,status,description,created_at,updated_at) VALUES(?,?,?,?,?)',id,str(x.status)||'received',str(x.description,1000),iso(),iso());this._audit('warranty.claim',{id});return {ok:true};});
   case 'system:check':{const discrepancies=all(this.db,`SELECT p.id,p.name,p.stock_qty,COALESCE(SUM(m.qty_change),0) calculated FROM products p LEFT JOIN stock_movements m ON m.product_id=p.id GROUP BY p.id HAVING ABS(stock_qty-calculated)>0.0001 LIMIT 50`);return {integrity:integrity(this.db),discrepancies};}
   case 'search:rebuild':this.db.exec("INSERT INTO products_fts(products_fts) VALUES('rebuild')");return {ok:true};
  }
 }
}
module.exports={ShopService,roles};
