import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const dbPath=process.env.DB_PATH ? path.resolve(process.cwd(),process.env.DB_PATH) : path.join(__dirname,'inventory.auth-demo.db');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const SQL=await initSqlJs();
const raw=fs.existsSync(dbPath)?new SQL.Database(new Uint8Array(fs.readFileSync(dbPath))):new SQL.Database();
raw.run('PRAGMA foreign_keys=ON');raw.run(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
// Additive migrations preserve the existing demo database and transaction rows.
const userColumns=raw.exec('PRAGMA table_info(users)')[0]?.values.map(row=>row[1])||[];
if(!userColumns.includes('password_hash'))raw.run('ALTER TABLE users ADD COLUMN password_hash TEXT');
if(!userColumns.includes('active'))raw.run('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))');
const productColumns=raw.exec('PRAGMA table_info(products)')[0]?.values.map(row=>row[1])||[];
if(!productColumns.includes('unit_cost')){
 raw.run('ALTER TABLE products ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost >= 0)');
 raw.run(`UPDATE products SET unit_cost=COALESCE((SELECT i.unit_cost FROM purchase_order_items i JOIN purchase_orders po ON po.id=i.purchase_order_id WHERE i.product_id=products.id AND i.unit_cost>=0 ORDER BY po.created_at DESC,po.id DESC,i.id DESC LIMIT 1),0)`);
}
const warehouseColumns=raw.exec('PRAGMA table_info(warehouses)')[0]?.values.map(row=>row[1])||[];
if(!warehouseColumns.includes('active'))raw.run('ALTER TABLE warehouses ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))');
raw.run(`CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS warehouse_assignments(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, PRIMARY KEY(user_id,warehouse_id));
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchase_order_receipts(id INTEGER PRIMARY KEY, purchase_order_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE, quantity INTEGER NOT NULL CHECK(quantity > 0), received_by INTEGER NOT NULL REFERENCES users(id), received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_purchase_order_receipts_item ON purchase_order_receipts(purchase_order_item_id,received_at);
CREATE INDEX IF NOT EXISTS idx_purchase_order_receipts_user ON purchase_order_receipts(received_by,received_at DESC);`);
let inTransaction=false;function save(){if(inTransaction)return;const tempPath=`${dbPath}.${process.pid}.tmp`;try{fs.writeFileSync(tempPath,Buffer.from(raw.export()));fs.renameSync(tempPath,dbPath)}catch(error){try{fs.rmSync(tempPath,{force:true})}catch{}throw error}}
function statement(sql){return{
 all(...args){const s=raw.prepare(sql);try{s.bind(args);const rows=[];while(s.step())rows.push(s.getAsObject());return rows}finally{s.free()}},
 get(...args){return this.all(...args)[0]},
 run(...args){raw.run(sql,args);const res={changes:raw.getRowsModified(),lastInsertRowid:raw.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0]??0};save();return res}
}}
export const db={prepare:statement,exec(sql){raw.run(sql);save()},pragma(value){raw.run(`PRAGMA ${value}`)},health(){return true},transaction(fn){return(...args)=>{if(inTransaction)throw new Error('Nested database transactions are not supported.');raw.run('BEGIN IMMEDIATE');inTransaction=true;const finish=()=>{raw.run('COMMIT');inTransaction=false;save()};const rollback=error=>{try{raw.run('ROLLBACK')}finally{inTransaction=false}save();throw error};try{const result=fn(...args);return result&&typeof result.then==='function'?result.then(value=>{finish();return value},rollback):(finish(),result)}catch(e){return rollback(e)}}}};
const count=db.prepare('SELECT COUNT(*) n FROM products').get().n;
if(!count){
 const seedDemoData=db.transaction(()=>{
 const insertSupplier=db.prepare('INSERT INTO suppliers(name,contact_name,email,phone) VALUES(?,?,?,?)');
 const suppliers=[insertSupplier.run('Northstar Supply Co.','Maya Patel','orders@northstar.example','+1 555 0101').lastInsertRowid,insertSupplier.run('Atlas Components','Chris Wong','sales@atlas.example','+1 555 0102').lastInsertRowid,insertSupplier.run('Evergreen Packaging','Sam Rivera','hello@evergreen.example','+1 555 0103').lastInsertRowid];
 const insertWarehouse=db.prepare('INSERT INTO warehouses(name,location,manager) VALUES(?,?,?)');
 const wh=[insertWarehouse.run('Central Distribution','Chicago, IL','Jordan Lee').lastInsertRowid,insertWarehouse.run('West Coast Hub','Ontario, CA','Taylor Reed').lastInsertRowid,insertWarehouse.run('East Fulfillment','Newark, NJ','Morgan Chen').lastInsertRowid];
 const products=[['SKU-1001','Wireless Barcode Scanner','Electronics','pcs',15,suppliers[0]],['SKU-1002','Thermal Label Roll','Packaging','roll',25,suppliers[2]],['SKU-1003','Handheld RF Terminal','Electronics','pcs',8,suppliers[1]],['SKU-1004','Shipping Carton — Medium','Packaging','box',40,suppliers[2]],['SKU-1005','Pallet Jack Wheel Kit','Equipment','set',12,suppliers[1]],['SKU-1006','Protective Foam Insert','Packaging','pcs',30,suppliers[0]],['SKU-1007','Dock Safety Vest','Safety','pcs',20,suppliers[0]],['SKU-1008','Conveyor Belt Motor','Equipment','pcs',5,suppliers[1]]];
 const ip=db.prepare('INSERT INTO products(sku,name,category,unit,reorder_level,supplier_id) VALUES(?,?,?,?,?,?)');
 const inv=db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,?)'); const tx=db.prepare("INSERT INTO stock_transactions(product_id,warehouse_id,type,quantity,reference,note,user_id,created_at) VALUES(?,?,?,?,?,?,NULL,datetime('now',?))");
 for(let i=0;i<products.length;i++){const pid=ip.run(...products[i]).lastInsertRowid; const amounts=[[42,18,9],[86,24,12],[7,4,6],[130,65,42],[11,6,3],[58,22,17],[34,12,8],[3,2,1]][i]; for(let j=0;j<3;j++){inv.run(pid,wh[j],amounts[j]); tx.run(pid,wh[j],'stock_in',amounts[j],'PO-240'+(i+1),'Opening stock',`-${8+i} days`);}}
 });
 seedDemoData();
}
save();


