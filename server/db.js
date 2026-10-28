import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const dbPath=process.env.DB_PATH ? path.resolve(process.cwd(),process.env.DB_PATH) : path.join(__dirname,'inventory.db');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const SQL=await initSqlJs();
const raw=fs.existsSync(dbPath)?new SQL.Database(new Uint8Array(fs.readFileSync(dbPath))):new SQL.Database();
raw.run('PRAGMA foreign_keys=ON');raw.run(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
let inTransaction=false;function save(){if(!inTransaction)fs.writeFileSync(dbPath,Buffer.from(raw.export()));}
function statement(sql){return{
 all(...args){const s=raw.prepare(sql);try{s.bind(args);const rows=[];while(s.step())rows.push(s.getAsObject());return rows}finally{s.free()}},
 get(...args){return this.all(...args)[0]},
 run(...args){raw.run(sql,args);const res={changes:raw.getRowsModified(),lastInsertRowid:raw.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0]??0};save();return res}
}}
export const db={prepare:statement,exec(sql){raw.run(sql);save()},pragma(value){raw.run(`PRAGMA ${value}`)},transaction(fn){return(...args)=>{raw.run('BEGIN');inTransaction=true;try{const result=fn(...args);raw.run('COMMIT');inTransaction=false;save();return result}catch(e){raw.run('ROLLBACK');inTransaction=false;save();throw e}}}};
const count=db.prepare('SELECT COUNT(*) n FROM products').get().n;
if(!count){
 const insertUser=db.prepare('INSERT INTO users(name,email,role) VALUES(?,?,?)');
 insertUser.run('Alex Morgan','admin@stockflow.demo','admin'); insertUser.run('Jordan Lee','staff@stockflow.demo','staff');
 const insertSupplier=db.prepare('INSERT INTO suppliers(name,contact_name,email,phone) VALUES(?,?,?,?)');
 const suppliers=[insertSupplier.run('Northstar Supply Co.','Maya Patel','orders@northstar.example','+1 555 0101').lastInsertRowid,insertSupplier.run('Atlas Components','Chris Wong','sales@atlas.example','+1 555 0102').lastInsertRowid,insertSupplier.run('Evergreen Packaging','Sam Rivera','hello@evergreen.example','+1 555 0103').lastInsertRowid];
 const insertWarehouse=db.prepare('INSERT INTO warehouses(name,location,manager) VALUES(?,?,?)');
 const wh=[insertWarehouse.run('Central Distribution','Chicago, IL','Jordan Lee').lastInsertRowid,insertWarehouse.run('West Coast Hub','Ontario, CA','Taylor Reed').lastInsertRowid,insertWarehouse.run('East Fulfillment','Newark, NJ','Morgan Chen').lastInsertRowid];
 const products=[['SKU-1001','Wireless Barcode Scanner','Electronics','pcs',15,suppliers[0]],['SKU-1002','Thermal Label Roll','Packaging','roll',25,suppliers[2]],['SKU-1003','Handheld RF Terminal','Electronics','pcs',8,suppliers[1]],['SKU-1004','Shipping Carton — Medium','Packaging','box',40,suppliers[2]],['SKU-1005','Pallet Jack Wheel Kit','Equipment','set',12,suppliers[1]],['SKU-1006','Protective Foam Insert','Packaging','pcs',30,suppliers[0]],['SKU-1007','Dock Safety Vest','Safety','pcs',20,suppliers[0]],['SKU-1008','Conveyor Belt Motor','Equipment','pcs',5,suppliers[1]]];
 const ip=db.prepare('INSERT INTO products(sku,name,category,unit,reorder_level,supplier_id) VALUES(?,?,?,?,?,?)');
 const inv=db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,?)'); const tx=db.prepare("INSERT INTO stock_transactions(product_id,warehouse_id,type,quantity,reference,note,user_id,created_at) VALUES(?,?,?,?,?,?,?,datetime('now',?))");
 for(let i=0;i<products.length;i++){const pid=ip.run(...products[i]).lastInsertRowid; const amounts=[[42,18,9],[86,24,12],[7,4,6],[130,65,42],[11,6,3],[58,22,17],[34,12,8],[3,2,1]][i]; for(let j=0;j<3;j++){inv.run(pid,wh[j],amounts[j]); tx.run(pid,wh[j],'stock_in',amounts[j],'PO-240'+(i+1),'Opening stock',1,`-${8+i} days`);}}
}
save();


