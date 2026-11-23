import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { rowsToCsv } from '../src/csv.js';
import {filterTransactions,summarizeTransactions} from '../src/transaction-utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockflow-rdbms-'));

async function verifyDatabase(sourceName) {
  const copy = path.join(temp, sourceName);
  fs.copyFileSync(path.join(serverDir, sourceName), copy);
  process.env.DB_PATH = copy;
  const { db } = await import(`${pathToFileURL(path.join(serverDir, 'db.js')).href}?test=${encodeURIComponent(sourceName)}`);
  const scalar=(sql,...args)=>db.prepare(sql).get(...args);
  const rows=(sql,...args)=>db.prepare(sql).all(...args);
  const counts=()=>Object.fromEntries(['products','warehouses','inventory','stock_transactions','suppliers','purchase_orders','purchase_order_items'].map(t=>[t,scalar(`SELECT COUNT(*) n FROM ${t}`).n]));
  const before=counts();

  assert.equal(scalar('SELECT COALESCE(SUM(quantity),0) n FROM inventory').n,645);
  assert.equal(scalar('PRAGMA integrity_check').integrity_check,'ok');
  assert.equal(rows('PRAGMA foreign_key_check').length,0);
  assert.equal(scalar('SELECT COUNT(*) n FROM v_current_stock_by_warehouse').n,before.inventory);
  const low=rows('SELECT * FROM v_low_stock_products');
  for(const item of low)assert.ok(item.total_quantity<=item.reorder_level);
  const movement=rows('SELECT * FROM v_product_stock_movement_totals');
  for(const item of movement){
    const d=scalar("SELECT COALESCE(SUM(CASE WHEN type='stock_in' THEN quantity ELSE 0 END),0) stock_in, COALESCE(SUM(CASE WHEN type='stock_out' THEN quantity ELSE 0 END),0) stock_out, COALESCE(SUM(CASE WHEN type='adjustment' THEN quantity ELSE 0 END),0) adjustment,COALESCE(SUM(quantity),0) total, COUNT(*) n FROM stock_transactions WHERE product_id=?",item.product_id);
    assert.equal(item.stock_in_quantity,d.stock_in);assert.equal(item.stock_out_quantity,d.stock_out);assert.equal(item.adjustment_quantity,d.adjustment);assert.equal(item.total_movement_quantity,d.total);assert.equal(item.movement_count,d.n);
  }
  const po=rows('SELECT * FROM v_purchase_order_summary');
  for(const item of po){const d=scalar('SELECT COUNT(*) item_count,COALESCE(SUM(quantity),0) total_quantity FROM purchase_order_items WHERE purchase_order_id=?',item.id);assert.equal(item.item_count,d.item_count);assert.equal(item.total_quantity,d.total_quantity);}

  const plans={
    stock:rows('EXPLAIN QUERY PLAN SELECT * FROM v_current_stock_by_warehouse WHERE warehouse_id=?',scalar('SELECT id FROM warehouses LIMIT 1').id).map(x=>x.detail).join(' '),
    movement:rows('EXPLAIN QUERY PLAN SELECT * FROM stock_transactions WHERE product_id=? AND type=? ORDER BY created_at DESC',scalar('SELECT id FROM products LIMIT 1').id,'stock_in').map(x=>x.detail).join(' '),
    orders:rows('EXPLAIN QUERY PLAN SELECT * FROM purchase_order_items WHERE purchase_order_id=?',1).map(x=>x.detail).join(' '),
  };
  assert.match(plans.stock,/idx_inventory_warehouse_product|sqlite_autoindex_inventory/);
  assert.match(plans.movement,/idx_stock_transactions_product_type/);
  assert.match(plans.orders,/idx_purchase_order_items_order/);

  const pid=scalar('SELECT id FROM products LIMIT 1').id,wid=scalar('SELECT id FROM warehouses LIMIT 1').id;
  assert.throws(()=>db.prepare('UPDATE inventory SET quantity=-1 WHERE product_id=? AND warehouse_id=?').run(pid,wid));
  assert.throws(()=>db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,0)').run(pid,wid));
  assert.throws(()=>db.prepare('INSERT INTO stock_transactions(product_id,warehouse_id,type,quantity) VALUES(?,?,?,?)').run(pid,wid,'bogus',1));
  assert.throws(()=>db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,0)').run(987654,987654));
  const poId=scalar('SELECT id FROM purchase_orders LIMIT 1')?.id;
  const itemId=scalar('SELECT id FROM purchase_order_items LIMIT 1')?.id;
  if(poId)assert.throws(()=>db.prepare('UPDATE purchase_orders SET total=-1 WHERE id=?').run(poId));
  if(itemId)assert.throws(()=>db.prepare('UPDATE purchase_order_items SET unit_cost=-1 WHERE id=?').run(itemId));
  assert.throws(()=>db.transaction(()=>{
    db.prepare("INSERT INTO suppliers(name) VALUES('Rollback probe')").run();
    db.prepare('INSERT INTO products(sku,name,category,unit,supplier_id) VALUES(?,?,?,?,?)').run('rollback-probe','Probe','Test','unit',987654);
  })());
  assert.equal(scalar("SELECT COUNT(*) n FROM suppliers WHERE name='Rollback probe'").n,0);
  assert.deepEqual(counts(),before);
  const createFixture=db.transaction(()=>{
    const supplierId=db.prepare("INSERT INTO suppliers(name) VALUES('Transaction probe supplier')").run().lastInsertRowid;
    const productId=db.prepare("INSERT INTO products(sku,name,category,unit,supplier_id) VALUES('transaction-probe','Transaction probe','Test','unit',?)").run(supplierId).lastInsertRowid;
    const insertInventory=db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,0)');
    for(const warehouse of rows('SELECT id FROM warehouses'))insertInventory.run(productId,warehouse.id);
    return productId;
  });
  const probeId=createFixture();
  const reopened=await import(`${pathToFileURL(path.join(serverDir, 'db.js')).href}?verify=${encodeURIComponent(sourceName)}`);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM inventory WHERE product_id=?').get(probeId).n,before.warehouses);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM products WHERE sku=?').get('transaction-probe').n,1);
  return {counts:before,units:scalar('SELECT COALESCE(SUM(quantity),0) n FROM inventory').n,views:{stock:scalar('SELECT COUNT(*) n FROM v_current_stock_by_warehouse').n,low_stock:low.length,movement:movement.length,purchase_orders:po.length},plans};
}

test('schema views, indexes, constraints and rollback work on a copy of inventory.db', async () => {
  const report=await verifyDatabase('inventory.db');
  assert.equal(report.units,645);
  assert.equal(report.views.stock,report.counts.inventory+report.counts.warehouses);
  console.log('inventory.db copy verified:',JSON.stringify(report));
});

test('CSV export data quotes commas, quotes, newlines, and empty values', () => {
  const csv=rowsToCsv([{product:'Tape, wide',note:'said "ready"\nnow',quantity:4,empty:null}]);
  assert.ok(csv.startsWith('\uFEFF"product","note","quantity","empty"\r\n'));
  assert.ok(csv.includes('"Tape, wide","said ""ready""\nnow","4",""'));
  assert.throws(()=>rowsToCsv([]),/no report data/);
});

test('schema views, indexes, constraints and rollback work on a copy of inventory.auth-demo.db', async () => {
  const report=await verifyDatabase('inventory.auth-demo.db');
  assert.equal(report.units,645);
  assert.equal(report.views.stock,report.counts.inventory+report.counts.warehouses);
  console.log('inventory.auth-demo.db copy verified:',JSON.stringify(report));
});

test('analytics, purchase-order receiving and warehouse deactivation API workflows', async () => {
  const copy=path.join(temp,'api-integration.db');
  fs.copyFileSync(path.join(serverDir,'inventory.auth-demo.db'),copy);
  // A developer's root .env may select PostgreSQL; this API test must stay on
  // its isolated SQLite copy so it never reads or writes the configured DB.
  process.env.DB_DRIVER='sqlite';
  process.env.DB_PATH=copy;
  process.env.STOCKFLOW_NO_LISTEN='1';
  const {db}=await import(pathToFileURL(path.join(serverDir,'db.js')).href);
  const temporaryPassword=randomBytes(24).toString('base64url');
  const salt=randomBytes(16);
  const passwordHash=`scrypt$${salt.toString('hex')}$${scryptSync(temporaryPassword,salt,64,{N:16384,r:8,p:1}).toString('hex')}`;
  const temporaryEmail=`api-test-${randomBytes(8).toString('hex')}@example.invalid`;
  const temporaryAdminId=db.prepare('INSERT INTO users(name,email,role,password_hash) VALUES(?,?,?,?)').run('Temporary API Test',temporaryEmail,'admin',passwordHash).lastInsertRowid;
  const token='stockflow-isolated-integration-test-token';
  const tokenHash=createHash('sha256').update(token).digest('hex');
  const admin=temporaryAdminId;
  const staff=db.prepare("SELECT id FROM users WHERE role='staff' LIMIT 1").get().id;
  db.prepare('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)').run(admin,tokenHash,new Date(Date.now()+3600000).toISOString());
  db.prepare('INSERT INTO warehouse_assignments(user_id,warehouse_id) VALUES(?,?)').run(staff,db.prepare('SELECT id FROM warehouses LIMIT 1').get().id);
  const staffToken='stockflow-isolated-staff-token';
  db.prepare('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)').run(staff,createHash('sha256').update(staffToken).digest('hex'),new Date(Date.now()+3600000).toISOString());
  const app=(await import(`${pathToFileURL(path.join(serverDir,'index.js')).href}?api-test`)).default;
  const server=app.listen(0);
  await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const request=async(route,options={},asStaff=false)=>{
    const response=await fetch(base+route,{...options,headers:{cookie:`stockflow.sid=${asStaff?staffToken:token}`,...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});
    const body=await response.json();
    return {status:response.status,body};
  };
  try {
    const loginResponse=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:temporaryEmail,password:temporaryPassword})});
    const loginBody=await loginResponse.json();
    assert.equal(loginResponse.status,200);
    assert.equal(loginBody.user.role,'admin');
    const authenticatedCookie=loginResponse.headers.get('set-cookie')?.split(';')[0];
    assert.ok(authenticatedCookie);
    const whoami=await fetch(base+'/auth/me',{headers:{cookie:authenticatedCookie}});
    assert.equal(whoami.status,200);
    assert.equal((await whoami.json()).user.email,temporaryEmail);
    const logoutResponse=await fetch(base+'/auth/logout',{method:'POST',headers:{cookie:authenticatedCookie}});
    assert.equal(logoutResponse.status,200);
    const afterLogout=await fetch(base+'/auth/me',{headers:{cookie:authenticatedCookie}});
    assert.equal(afterLogout.status,401);

    const products=db.prepare('SELECT id,sku,name,category,unit,reorder_level,supplier_id,unit_cost FROM products ORDER BY id').all();
    const warehouses=db.prepare('SELECT id,name FROM warehouses ORDER BY id').all();
    const supplier=db.prepare('SELECT id FROM suppliers LIMIT 1').get().id;
    const product=products[0],warehouse=warehouses[0];
    const added=await request('/products',{method:'POST',body:JSON.stringify({sku:`SKU-UI-TEST-${Date.now()}`,name:'Modal Workflow Test Product',category:'Packaging',unit:'box',reorder_level:6,unit_cost:2.5,supplier_id:supplier})});
    assert.equal(added.status,201);
    assert.equal(added.body.name,'Modal Workflow Test Product');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory WHERE product_id=?').get(added.body.id).n,warehouses.length);
    const editedAdded=await request(`/products/${added.body.id}`,{method:'PUT',body:JSON.stringify({...added.body,name:'Modal Workflow Edited Product',reorder_level:9,unit_cost:3.25})});
    assert.equal(editedAdded.status,200);
    assert.equal(editedAdded.body.name,'Modal Workflow Edited Product');
    assert.equal(editedAdded.body.reorder_level,9);
    assert.equal(editedAdded.body.unit_cost,3.25);
    const removedAdded=await request(`/products/${added.body.id}`,{method:'DELETE'});
    assert.equal(removedAdded.status,200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM products WHERE id=?').get(added.body.id).n,0);
    const secondWarehouse=warehouses.find(item=>item.id!==warehouse.id);
    const sourceBefore=db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity;
    const destinationBefore=db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,secondWarehouse.id).quantity;
    const stockIn=await request('/transactions',{method:'POST',body:JSON.stringify({type:'stock_in',product_id:product.id,warehouse_id:warehouse.id,quantity:6,reference:'isolated test stock-in'})});
    assert.equal(stockIn.status,201);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,sourceBefore+6);
    const stockOut=await request('/transactions',{method:'POST',body:JSON.stringify({type:'stock_out',product_id:product.id,warehouse_id:warehouse.id,quantity:2,reference:'isolated test stock-out'})});
    assert.equal(stockOut.status,201);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,sourceBefore+4);
    const transfer=await request('/transactions',{method:'POST',body:JSON.stringify({type:'transfer',product_id:product.id,warehouse_id:secondWarehouse.id,source_warehouse_id:warehouse.id,quantity:3,reference:'isolated test transfer'})});
    assert.equal(transfer.status,201);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,sourceBefore+1);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,secondWarehouse.id).quantity,destinationBefore+3);
    assert.equal(db.prepare("SELECT user_id FROM stock_transactions WHERE reference='isolated test stock-in' ORDER BY id DESC LIMIT 1").get().user_id,admin);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_transactions WHERE reference='isolated test transfer' AND user_id=? AND type IN ('transfer_in','transfer_out')").get(admin).n,2);
    const transactionResponse=await request('/transactions');
    assert.equal(transactionResponse.status,200);
    const transactionRows=transactionResponse.body;
    const testedIn=transactionRows.find(row=>row.reference==='isolated test stock-in');
    assert.equal(testedIn.product_id,product.id);assert.equal(testedIn.warehouse_id,warehouse.id);assert.equal(testedIn.user_name,'Temporary API Test');
    const byType=filterTransactions(transactionRows,{type:'stock_out'});
    assert.ok(byType.length>0);assert.ok(byType.every(row=>row.type==='stock_out'));
    const byProduct=filterTransactions(transactionRows,{product:String(product.id)});
    assert.ok(byProduct.length>=5);assert.ok(byProduct.every(row=>row.product_id===product.id));
    const byWarehouse=filterTransactions(transactionRows,{warehouse:String(secondWarehouse.id)});
    assert.ok(byWarehouse.length>0);assert.ok(byWarehouse.every(row=>row.warehouse_id===secondWarehouse.id));
    const byUser=filterTransactions(transactionRows,{user:'Temporary API Test'});
    assert.ok(byUser.length>0);assert.ok(byUser.every(row=>row.user_name==='Temporary API Test'));
    const byReference=filterTransactions(transactionRows,{search:'isolated test transfer'});
    assert.equal(byReference.length,2);assert.ok(byReference.every(row=>row.type.startsWith('transfer_')));
    const transferSummary=summarizeTransactions(byReference);
    assert.deepEqual(transferSummary,{all:2,in:0,out:0,transfer:2});
    const transferIn=byReference.find(row=>row.type==='transfer_in');
    assert.equal(transferIn.product_name,product.name);assert.equal(transferIn.warehouse_name,secondWarehouse.name);assert.equal(transferIn.user_name,'Temporary API Test');
    const filteredByDay=filterTransactions(transactionRows,{from:String(testedIn.created_at).slice(0,10),to:String(testedIn.created_at).slice(0,10)});
    assert.ok(filteredByDay.some(row=>row.id===testedIn.id));
    const transactionCount=db.prepare('SELECT COUNT(*) n FROM stock_transactions').get().n;
    const invalidStockOut=await request('/transactions',{method:'POST',body:JSON.stringify({type:'stock_out',product_id:product.id,warehouse_id:warehouse.id,quantity:99999})});
    assert.equal(invalidStockOut.status,400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_transactions').get().n,transactionCount);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,sourceBefore+1);

    const changed=await request(`/products/${product.id}`,{method:'PUT',body:JSON.stringify({...product,name:product.name+' Analytics',unit_cost:7.25})});
    assert.equal(changed.status,200);
    const poCreate=await request('/purchase-orders',{method:'POST',body:JSON.stringify({supplier_id:supplier,warehouse_id:warehouse.id,items:[{product_id:product.id,quantity:5,unit_cost:7.25},{product_id:products[1].id,quantity:4,unit_cost:3}]})});
    assert.equal(poCreate.status,201);
    const order=await request(`/purchase-orders/${poCreate.body.id}`);
    assert.equal(order.status,200);
    const lines=order.body.items;
    assert.equal(lines.length,2);
    const before=db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity;
    const partial=await request(`/purchase-orders/${poCreate.body.id}/receive`,{method:'POST',body:JSON.stringify({items:[{item_id:lines[0].item_id,quantity:2},{item_id:lines[1].item_id,quantity:1}]})});
    assert.equal(partial.status,200);assert.equal(partial.body.receiving_status,'partially_received');
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,before+2);
    const receiptCount=db.prepare('SELECT COUNT(*) n FROM purchase_order_receipts').get().n;
    const tooMany=await request(`/purchase-orders/${poCreate.body.id}/receive`,{method:'POST',body:JSON.stringify({items:[{item_id:lines[0].item_id,quantity:1},{item_id:lines[1].item_id,quantity:4}]})});
    assert.equal(tooMany.status,400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_order_receipts').get().n,receiptCount);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,before+2);
    const invalidLine=await request(`/purchase-orders/${poCreate.body.id}/receive`,{method:'POST',body:JSON.stringify({items:[{item_id:987654,quantity:1}]})});
    assert.equal(invalidLine.status,400);
    const completed=await request(`/purchase-orders/${poCreate.body.id}/receive`,{method:'POST',body:JSON.stringify({items:[{item_id:lines[0].item_id,quantity:3},{item_id:lines[1].item_id,quantity:3}]})});
    assert.equal(completed.status,200);assert.equal(completed.body.receiving_status,'received');
    const after=db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity;
    assert.equal(after,before+5);
    const transaction=db.prepare("SELECT user_id,quantity FROM stock_transactions WHERE reference=? AND product_id=? ORDER BY id DESC LIMIT 1").get(`PO-${poCreate.body.id}`,product.id);
    assert.equal(transaction.user_id,admin);assert.equal(transaction.quantity,3);
    const orderDetailAfterReceipt=await request(`/purchase-orders/${poCreate.body.id}`);
    assert.equal(orderDetailAfterReceipt.body.receiving_status,'received');
    assert.equal(orderDetailAfterReceipt.body.received_quantity,9);
    const receiptHistoryResponse=await request('/transactions');
    const receiptHistory=receiptHistoryResponse.body.filter(row=>row.reference===`PO-${poCreate.body.id}`);
    assert.equal(receiptHistory.length,4);
    assert.equal(receiptHistory.reduce((sum,row)=>sum+Number(row.quantity),0),9);
    assert.ok(receiptHistory.every(row=>row.type==='stock_in'&&row.user_name==='Temporary API Test'));
    const repeated=await request(`/purchase-orders/${poCreate.body.id}/receive`,{method:'POST',body:JSON.stringify({items:[{item_id:lines[0].item_id,quantity:1}]})});
    assert.equal(repeated.status,400);

    const emptyWarehouse=await request('/warehouses',{method:'POST',body:JSON.stringify({name:'Zero stock chart test',location:'Test-only location',manager:'Temporary test'})});
    assert.equal(emptyWarehouse.status,201);
    assert.equal(emptyWarehouse.body.name,'Zero stock chart test');
    assert.equal(db.prepare('SELECT SUM(quantity) n FROM inventory WHERE warehouse_id=?').get(emptyWarehouse.body.id).n,0);
    const editedWarehouse=await request(`/warehouses/${emptyWarehouse.body.id}`,{method:'PUT',body:JSON.stringify({name:'Zero stock chart edited',location:'Edited test location',manager:'Test manager updated'})});
    assert.equal(editedWarehouse.status,200);
    assert.equal(editedWarehouse.body.name,'Zero stock chart edited');
    assert.equal(editedWarehouse.body.location,'Edited test location');
    assert.equal(editedWarehouse.body.manager,'Test manager updated');

    const analytics=await request('/analytics?from=2026-01-01&to=2027-01-01');
    assert.equal(analytics.status,200);
    assert.ok(analytics.body.inventory_value>0);
    assert.equal(Math.round(analytics.body.inventory_by_category.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100),Math.round(analytics.body.inventory_value*100));
    assert.equal(analytics.body.stock_health.total_products,db.prepare('SELECT COUNT(*) n FROM products').get().n);
    assert.equal(analytics.body.stock_health.low_stock_products,db.prepare('SELECT COUNT(*) n FROM v_low_stock_products').get().n);
    assert.equal(analytics.body.daily_movement.length,366);
    assert.ok(analytics.body.daily_movement.every(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.day)));
    assert.equal(analytics.body.daily_movement.reduce((sum,row)=>sum+Number(row.inbound),0),db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM stock_transactions WHERE date(created_at) BETWEEN ? AND ? AND type IN ('stock_in','transfer_in')").get('2026-01-01','2027-01-01').n);
    assert.equal(analytics.body.warehouse_stock.reduce((sum,row)=>sum+Number(row.inventory_value),0),analytics.body.inventory_value);
    assert.ok(analytics.body.warehouse_stock.some(row=>row.warehouse_id===emptyWarehouse.body.id&&Number(row.quantity)===0));
    assert.ok(analytics.body.warehouse_stock.length>0);
    assert.ok(Array.isArray(analytics.body.low_stock));
    assert.ok(analytics.body.top_products.some(item=>item.product_id===product.id));
    assert.ok(analytics.body.movement_trends.length>0);
    assert.ok(analytics.body.movement_trends.some(item=>item.inbound>0));
    assert.ok(analytics.body.movement_kpi.movements>0);
    assert.ok(analytics.body.filter_options.categories.length>0);
    const filteredWarehouse=db.prepare('SELECT warehouse_id FROM inventory WHERE quantity>0 LIMIT 1').get().warehouse_id;
    const filteredCategory=db.prepare('SELECT category FROM products WHERE id=(SELECT product_id FROM inventory WHERE warehouse_id=? AND quantity>0 LIMIT 1)').get(filteredWarehouse).category;
    const scopedAnalytics=await request(`/analytics?from=2026-01-01&to=2027-01-01&warehouse_id=${filteredWarehouse}&category=${encodeURIComponent(filteredCategory)}`);
    assert.equal(scopedAnalytics.status,200);
    assert.deepEqual(scopedAnalytics.body.warehouse_stock.map(row=>row.warehouse_id),[filteredWarehouse]);
    assert.ok(scopedAnalytics.body.inventory_by_category.every(row=>row.category===filteredCategory));
    assert.equal(Math.round(scopedAnalytics.body.inventory_value*100),Math.round(scopedAnalytics.body.warehouse_stock.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100));
    assert.equal(scopedAnalytics.body.daily_movement.reduce((sum,row)=>sum+Number(row.movements),0),scopedAnalytics.body.movement_kpi.movements);
    const analyticsOrder=analytics.body.purchase_orders.find(item=>item.id===poCreate.body.id);
    assert.ok(analyticsOrder);assert.equal(analyticsOrder.receiving_status,'received');assert.equal(analyticsOrder.received_quantity,9);assert.equal(analyticsOrder.remaining_quantity,0);
    const invalidRange=await request('/analytics?from=2026-12-31&to=2026-01-01');
    assert.equal(invalidRange.status,400);
    const filteredRange=await request('/analytics?from=2000-01-01&to=2000-01-31');
    assert.equal(filteredRange.status,200);
    assert.equal(filteredRange.body.purchase_orders.some(item=>item.id===poCreate.body.id),false);
    assert.equal(filteredRange.body.movement_trends.length,1);
    assert.equal(filteredRange.body.movement_trends[0].inbound,0);
    const overlongRange=await request('/analytics?from=1900-01-01&to=2026-01-01');
    assert.equal(overlongRange.status,400);
    const dashboard=await request('/dashboard?days=30');
    assert.equal(dashboard.status,200);
    assert.equal(dashboard.body.movement.length,30);
    assert.equal(dashboard.body.stats.units,db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM inventory').get().n);
    assert.equal(Math.round(dashboard.body.inventoryValue*100),Math.round(db.prepare('SELECT COALESCE(SUM(i.quantity*p.unit_cost),0) n FROM inventory i JOIN products p ON p.id=i.product_id').get().n*100));
    assert.equal(dashboard.body.stockHealth.low_stock_products,db.prepare('SELECT COUNT(*) n FROM v_low_stock_products').get().n);
    assert.equal(dashboard.body.purchaseOrderStatus.reduce((sum,row)=>sum+Number(row.orders),0),db.prepare('SELECT COUNT(*) n FROM purchase_orders').get().n);
    assert.equal(dashboard.body.movement.reduce((sum,row)=>sum+Number(row.inbound),0),db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM stock_transactions WHERE date(created_at) BETWEEN ? AND ? AND type IN ('stock_in','transfer_in')").get(dashboard.body.movementRange.from,dashboard.body.movementRange.to).n);
    const dashboardWarehouses=await request('/warehouses');
    assert.equal(dashboardWarehouses.body.reduce((sum,row)=>sum+Number(row.units),0),dashboard.body.stats.units);
    assert.equal(Math.round(dashboardWarehouses.body.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100),Math.round(dashboard.body.inventoryValue*100));
    const staffAnalytics=await request('/analytics?from=2026-01-01&to=2027-01-01',{},true);
    assert.equal(staffAnalytics.status,403);

    const deactivated=await request(`/warehouses/${warehouse.id}/deactivate`,{method:'PATCH'});
    assert.equal(deactivated.status,200);
    assert.equal(db.prepare('SELECT active FROM warehouses WHERE id=?').get(warehouse.id).active,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory WHERE warehouse_id=?').get(warehouse.id).n,db.prepare('SELECT COUNT(*) n FROM products').get().n);
    const auditCount=db.prepare('SELECT COUNT(*) n FROM stock_transactions WHERE warehouse_id=?').get(warehouse.id).n;
    const warehouseList=await request('/warehouses');
    assert.equal(warehouseList.body.find(item=>item.id===warehouse.id).active,0);
    const blockedStock=await request('/transactions',{method:'POST',body:JSON.stringify({type:'stock_in',product_id:product.id,warehouse_id:warehouse.id,quantity:1})});
    assert.equal(blockedStock.status,400);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse.id).quantity,after);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_transactions WHERE warehouse_id=?').get(warehouse.id).n,auditCount);
    const blockedOrder=await request('/purchase-orders',{method:'POST',body:JSON.stringify({supplier_id:supplier,warehouse_id:warehouse.id,items:[{product_id:product.id,quantity:1,unit_cost:2}]})});
    assert.equal(blockedOrder.status,400);
    const reactivated=await request(`/warehouses/${warehouse.id}/activate`,{method:'PATCH'});
    assert.equal(reactivated.status,200);
    assert.equal(db.prepare('SELECT active FROM warehouses WHERE id=?').get(warehouse.id).active,1);
  } finally {
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.()});
    delete process.env.STOCKFLOW_NO_LISTEN;
  }
});

test.after(() => { delete process.env.DB_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
