'use strict';
const fs=require('node:fs');
const path=require('node:path');
// Production: better-sqlite3. Node >=22 fallback: permits database tests without npm install.
let Better;
try { Better=require('better-sqlite3'); } catch (_) { Better=null; }
function openDb(file){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 let db;
 if(Better){ db=new Better(file); db.__driver='better'; }
 else {const {DatabaseSync}=require('node:sqlite'); db=new DatabaseSync(file); db.__driver='node'; }
 db.pragma ? (db.pragma('journal_mode = WAL'),db.pragma('synchronous = FULL'),db.pragma('foreign_keys = ON'),db.pragma('busy_timeout = 5000')):
 (db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'));
 migrate(db);
 return db;
}
function transaction(db,fn){
 db.exec('BEGIN IMMEDIATE');
 try {const result=fn();db.exec('COMMIT');return result;}
 catch(e){try{db.exec('ROLLBACK');}catch(_){}throw e;}
}
function integrity(db){const v=db.prepare('PRAGMA integrity_check').get();return Object.values(v)[0]==='ok';}
function migrate(db){
 db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
 const cur=db.prepare('SELECT max(version) AS v FROM schema_version').get()?.v||0;
 if(cur>=1)return;
 transaction(db,()=>{
 db.exec(`
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','manager','cashier')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,brand TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',unit TEXT NOT NULL DEFAULT 'pcs',barcode TEXT UNIQUE,sku TEXT UNIQUE,aliases TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',cost_price INTEGER NOT NULL DEFAULT 0,retail_price INTEGER NOT NULL DEFAULT 0,min_price INTEGER NOT NULL DEFAULT 0,reorder_level REAL NOT NULL DEFAULT 0,stock_qty REAL NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_by INTEGER);
 CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
 CREATE TABLE IF NOT EXISTS price_history(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),old_cost INTEGER,old_price INTEGER,new_cost INTEGER NOT NULL,new_price INTEGER NOT NULL,user_id INTEGER,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stock_movements(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),type TEXT NOT NULL,qty_change REAL NOT NULL,unit_cost INTEGER NOT NULL,ref_type TEXT,ref_id INTEGER,reason TEXT,user_id INTEGER,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_movements(product_id,created_at);
 CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT DEFAULT '',address TEXT DEFAULT '',notes TEXT DEFAULT '',created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),subtotal INTEGER NOT NULL,discount INTEGER NOT NULL DEFAULT 0,freight INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,paid INTEGER NOT NULL,payment_method TEXT NOT NULL DEFAULT 'cash',created_at TEXT NOT NULL,user_id INTEGER);
 CREATE TABLE IF NOT EXISTS purchase_items(id INTEGER PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),product_id INTEGER NOT NULL REFERENCES products(id),qty REAL NOT NULL,unit_cost INTEGER NOT NULL,line_total INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS supplier_payments(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),purchase_id INTEGER REFERENCES purchases(id),amount INTEGER NOT NULL,method TEXT NOT NULL,created_at TEXT NOT NULL,user_id INTEGER);
 CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',credit_limit INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
 CREATE TABLE IF NOT EXISTS customer_ledger(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),type TEXT NOT NULL,amount INTEGER NOT NULL,reference TEXT,method TEXT DEFAULT 'cash',created_at TEXT NOT NULL,user_id INTEGER);
 CREATE INDEX IF NOT EXISTS idx_customer_ledger ON customer_ledger(customer_id,created_at);
 CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY,bill_no TEXT NOT NULL UNIQUE,draft_id INTEGER UNIQUE,customer_id INTEGER REFERENCES customers(id),user_id INTEGER NOT NULL REFERENCES users(id),subtotal INTEGER NOT NULL,discount INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,paid INTEGER NOT NULL,outstanding INTEGER NOT NULL DEFAULT 0,printed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'completed',created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at); CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
 CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL REFERENCES sales(id),product_id INTEGER NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,qty REAL NOT NULL,unit_price INTEGER NOT NULL,unit_cost INTEGER NOT NULL,discount INTEGER NOT NULL DEFAULT 0,line_total INTEGER NOT NULL,warranty_months INTEGER NOT NULL DEFAULT 0,serial TEXT);
 CREATE TABLE IF NOT EXISTS sale_payments(id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL REFERENCES sales(id),method TEXT NOT NULL,amount INTEGER NOT NULL,tendered INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL REFERENCES sales(id),customer_id INTEGER REFERENCES customers(id),reason TEXT NOT NULL,refund_method TEXT NOT NULL,total INTEGER NOT NULL,user_id INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS return_items(id INTEGER PRIMARY KEY,return_id INTEGER NOT NULL REFERENCES returns(id),sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),product_id INTEGER NOT NULL REFERENCES products(id),qty REAL NOT NULL,refund_amount INTEGER NOT NULL,unit_cost INTEGER NOT NULL,restock INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY,category TEXT NOT NULL,amount INTEGER NOT NULL,payment_method TEXT NOT NULL DEFAULT 'cash',note TEXT NOT NULL DEFAULT '',spent_at TEXT NOT NULL,user_id INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cash_sessions(id INTEGER PRIMARY KEY,opened_at TEXT NOT NULL,closed_at TEXT,opening INTEGER NOT NULL,closing_expected INTEGER,closing_counted INTEGER,opened_by INTEGER NOT NULL,closed_by INTEGER);
 CREATE TABLE IF NOT EXISTS cash_moves(id INTEGER PRIMARY KEY,session_id INTEGER REFERENCES cash_sessions(id),kind TEXT NOT NULL CHECK(kind IN('in','out')),amount INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,user_id INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS drafts(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),label TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,held INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
 CREATE TABLE IF NOT EXISTS warranties(id INTEGER PRIMARY KEY,sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),serial TEXT NOT NULL,months INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS warranty_claims(id INTEGER PRIMARY KEY,warranty_id INTEGER NOT NULL REFERENCES warranties(id),status TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(name,brand,model,category,aliases,content='products',content_rowid='id',prefix='2 3 4');
 CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON products BEGIN INSERT INTO products_fts(rowid,name,brand,model,category,aliases) VALUES(new.id,new.name,new.brand,new.model,new.category,new.aliases);END;
 CREATE TRIGGER IF NOT EXISTS fts_delete AFTER DELETE ON products BEGIN INSERT INTO products_fts(products_fts,rowid,name,brand,model,category,aliases) VALUES('delete',old.id,old.name,old.brand,old.model,old.category,old.aliases);END;
 CREATE TRIGGER IF NOT EXISTS fts_update AFTER UPDATE OF name,brand,model,category,aliases ON products BEGIN INSERT INTO products_fts(products_fts,rowid,name,brand,model,category,aliases) VALUES('delete',old.id,old.name,old.brand,old.model,old.category,old.aliases);INSERT INTO products_fts(rowid,name,brand,model,category,aliases) VALUES(new.id,new.name,new.brand,new.model,new.category,new.aliases);END;
 `);
 db.prepare('INSERT INTO schema_version(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
 });
}
module.exports={openDb,transaction,integrity};
