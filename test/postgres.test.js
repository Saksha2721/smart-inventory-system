import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

test('PostgreSQL adapter and API support authentication, permissions, stock, transfers, receiving and analytics', async () => {
  const probe=createNetServer();
  probe.listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));

  const pgEngine=new PGlite();
  const pgServer=new PGLiteSocketServer({db:pgEngine,host:'127.0.0.1',port});
  await pgServer.start();
  process.env.DB_DRIVER='postgres';
  process.env.DATABASE_URL=`postgresql://127.0.0.1:${port}/postgres?sslmode=disable`;
  process.env.PG_POOL_MAX='1';
  process.env.STOCKFLOW_NO_LISTEN='1';
  process.env.NODE_ENV='test';
  process.env.APP_ORIGINS='';

  let db,server;
  try {
    db=(await import('../server/database.js')).db;
    const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const reportPath=path.join(os.tmpdir(),`stockflow-migration-${randomBytes(6).toString('hex')}.json`);
    const {migrateSqliteCopy}=await import('../server/migrate-sqlite-to-postgres.js');
    const migration=await migrateSqliteCopy({source:path.join(projectRoot,'server','inventory.auth-demo.db'),reportPath,database:db});
    assert.equal(migration.status,'verified');
    assert.equal(migration.sqlite_integrity,'ok');
    assert.equal(migration.tables.products.source_rows,migration.tables.products.migrated_rows);
    const rerun=await migrateSqliteCopy({source:path.join(projectRoot,'server','inventory.auth-demo.db'),reportPath,database:db});
    assert.equal(rerun.status,'verified');
    fs.rmSync(reportPath,{force:true});
    const builtFrontend=fs.existsSync(path.join(projectRoot,'dist','index.html'));
    process.env.NODE_ENV=builtFrontend?'production':'test';
    const app=(await import('../server/index.js')).default;
    const hashPassword=password=>{
      const salt=randomBytes(16);
      return `scrypt$${salt.toString('hex')}$${scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex')}`;
    };
    const adminPassword=randomBytes(24).toString('base64url');
    const staffPassword=randomBytes(24).toString('base64url');
    const adminId=(await db.prepare('INSERT INTO users(name,email,role,password_hash) VALUES(?,?,?,?)').run('Postgres Admin','pg-admin@example.invalid','admin',hashPassword(adminPassword))).lastInsertRowid;
    const staffId=(await db.prepare('INSERT INTO users(name,email,role,password_hash) VALUES(?,?,?,?)').run('Postgres Staff','pg-staff@example.invalid','staff',hashPassword(staffPassword))).lastInsertRowid;
    const supplierId=(await db.prepare('INSERT INTO suppliers(name) VALUES(?)').run('PG test supplier')).lastInsertRowid;
    const warehouseOne=(await db.prepare('INSERT INTO warehouses(name,location,manager) VALUES(?,?,?)').run('PG warehouse 1','Test A','Test manager')).lastInsertRowid;
    const warehouseTwo=(await db.prepare('INSERT INTO warehouses(name,location,manager) VALUES(?,?,?)').run('PG warehouse 2','Test B','Test manager')).lastInsertRowid;
    const warehouseEmpty=(await db.prepare('INSERT INTO warehouses(name,location,manager) VALUES(?,?,?)').run('PG empty chart warehouse','Test empty','Test manager')).lastInsertRowid;
    const productId=(await db.prepare('INSERT INTO products(sku,name,category,unit,reorder_level,unit_cost,supplier_id) VALUES(?,?,?,?,?,?,?)').run('PG-001','Postgres test item','Testing','each',10,2.5,supplierId)).lastInsertRowid;
    const lowProductId=(await db.prepare('INSERT INTO products(sku,name,category,unit,reorder_level,unit_cost,supplier_id) VALUES(?,?,?,?,?,?,?)').run('PG-LOW','Low quantity item','Testing','each',5,1,supplierId)).lastInsertRowid;
    await db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,?)').run(productId,warehouseOne,10);
    await db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,?)').run(lowProductId,warehouseOne,2);
    await db.prepare('INSERT INTO warehouse_assignments(user_id,warehouse_id) VALUES(?,?)').run(staffId,warehouseOne);

    server=app.listen(0,'127.0.0.1');
    await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}/api`;
    if(builtFrontend){const home=await fetch(base.replace('/api','/'));assert.equal(home.status,200);assert.match(await home.text(),/id="root"/);}
    async function login(email,password){
      const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
      const body=await response.json();
      assert.equal(response.status,200,JSON.stringify(body));
      if(builtFrontend)assert.match(response.headers.get('set-cookie')||'',/;\s*Secure/i);
      return response.headers.get('set-cookie').split(';')[0];
    }
    async function request(route,cookie,options={}){
      const response=await fetch(base+route,{...options,headers:{cookie,...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});
      const body=await response.json();
      return {status:response.status,body,response};
    }

    const health=await fetch(`${base}/health`);
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{ok:true,database:'connected'});
    const adminCookie=await login('pg-admin@example.invalid',adminPassword);
    const staffCookie=await login('pg-staff@example.invalid',staffPassword);
    const staffProducts=await request('/products',staffCookie);
    assert.equal(staffProducts.status,200,JSON.stringify(staffProducts.body));
    const dashboard=await request('/dashboard',adminCookie);
    assert.equal(dashboard.status,200,JSON.stringify(dashboard.body));
    assert.ok(dashboard.body.stats.products>=2);
    assert.ok(dashboard.body.movement.length>=7);
    assert.equal(dashboard.body.stockHealth.low_stock_products,Number((await db.prepare('SELECT COUNT(*) n FROM v_low_stock_products').get()).n));
    assert.equal(Math.round(dashboard.body.inventoryValue*100),Math.round(Number((await db.prepare('SELECT COALESCE(SUM(i.quantity*p.unit_cost),0) n FROM inventory i JOIN products p ON p.id=i.product_id').get()).n)*100));
    const dashboardWarehouses=await request('/warehouses',adminCookie);
    assert.equal(dashboardWarehouses.status,200);
    assert.equal(dashboardWarehouses.body.reduce((sum,row)=>sum+Number(row.units),0),Number((await db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM inventory').get()).n));
    assert.equal(Math.round(dashboardWarehouses.body.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100),Math.round(dashboard.body.inventoryValue*100));
    const longerDashboard=await request('/dashboard?days=90',adminCookie);
    assert.equal(longerDashboard.status,200);
    assert.equal(longerDashboard.body.movement.length,90);
    assert.equal(dashboard.body.purchaseOrderStatus.reduce((sum,row)=>sum+Number(row.orders),0),Number((await db.prepare('SELECT COUNT(*) n FROM purchase_orders').get()).n));
    const staffDashboard=await request('/dashboard?days=30',staffCookie);
    assert.equal(staffDashboard.status,200);
    assert.equal(staffDashboard.body.movement.length,30);
    assert.deepEqual(staffDashboard.body.purchaseOrderStatus,[]);
    assert.equal(staffDashboard.body.stats.units,Number((await db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM inventory WHERE warehouse_id=?').get(warehouseOne)).n));
    const staffWarehouses=await request('/warehouses',staffCookie);
    assert.equal(staffWarehouses.body.reduce((sum,row)=>sum+Number(row.units),0),staffDashboard.body.stats.units);
    assert.equal((await request('/products',adminCookie,{method:'POST',body:JSON.stringify({sku:'DENY',name:'Denied',category:'Test',reorder_level:1})})).status,201);
    assert.equal((await request('/products',staffCookie,{method:'POST',body:JSON.stringify({sku:'DENY2',name:'Denied',category:'Test',reorder_level:1})})).status,403);

    const stockIn=await request('/transactions',adminCookie,{method:'POST',body:JSON.stringify({type:'stock_in',product_id:productId,warehouse_id:warehouseOne,quantity:4})});
    assert.equal(stockIn.status,201,JSON.stringify(stockIn.body));
    const stockOut=await request('/transactions',staffCookie,{method:'POST',body:JSON.stringify({type:'stock_out',product_id:productId,warehouse_id:warehouseOne,quantity:2})});
    assert.equal(stockOut.status,201,JSON.stringify(stockOut.body));
    assert.equal(Number((await db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(productId,warehouseOne)).quantity),12);
    const insufficient=await request('/transactions',staffCookie,{method:'POST',body:JSON.stringify({type:'stock_out',product_id:productId,warehouse_id:warehouseOne,quantity:100})});
    assert.equal(insufficient.status,400);
    const unassignedWarehouse=await request('/transactions',staffCookie,{method:'POST',body:JSON.stringify({type:'stock_in',product_id:productId,warehouse_id:warehouseTwo,quantity:1})});
    assert.equal(unassignedWarehouse.status,403);

    const transfer=await request('/transactions',adminCookie,{method:'POST',body:JSON.stringify({type:'transfer',product_id:productId,warehouse_id:warehouseTwo,source_warehouse_id:warehouseOne,quantity:3})});
    assert.equal(transfer.status,201,JSON.stringify(transfer.body));
    assert.equal(Number((await db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(productId,warehouseOne)).quantity),9);
    assert.equal(Number((await db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(productId,warehouseTwo)).quantity),3);
    const staffTransfer=await request('/transactions',staffCookie,{method:'POST',body:JSON.stringify({type:'transfer',product_id:productId,warehouse_id:warehouseTwo,source_warehouse_id:warehouseOne,quantity:1})});
    assert.equal(staffTransfer.status,403);

    const orderCreated=await request('/purchase-orders',adminCookie,{method:'POST',body:JSON.stringify({supplier_id:supplierId,warehouse_id:warehouseOne,items:[{product_id:productId,quantity:5,unit_cost:2.5}]})});
    assert.equal(orderCreated.status,201,JSON.stringify(orderCreated.body));
    const orderResponse=await request(`/purchase-orders/${orderCreated.body.id}`,adminCookie);
    assert.equal(orderResponse.status,200,JSON.stringify(orderResponse.body));
    const order=orderResponse.body;
    const itemId=order.items[0].item_id;
    const partial=await request(`/purchase-orders/${orderCreated.body.id}/receive`,adminCookie,{method:'POST',body:JSON.stringify({items:[{item_id:itemId,quantity:2}]})});
    assert.equal(partial.status,200,JSON.stringify(partial.body));
    assert.equal(partial.body.receiving_status,'partially_received');
    const beforeInvalid=Number((await db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(productId,warehouseOne)).quantity);
    const invalid=await request(`/purchase-orders/${orderCreated.body.id}/receive`,adminCookie,{method:'POST',body:JSON.stringify({items:[{item_id:itemId,quantity:4}]})});
    assert.equal(invalid.status,400);
    assert.equal(Number((await db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(productId,warehouseOne)).quantity),beforeInvalid);
    const complete=await request(`/purchase-orders/${orderCreated.body.id}/receive`,adminCookie,{method:'POST',body:JSON.stringify({items:[{item_id:itemId,quantity:3}]})});
    assert.equal(complete.status,200,JSON.stringify(complete.body));
    assert.equal(complete.body.receiving_status,'received');
    const receiptAudit=await db.prepare("SELECT user_id FROM stock_transactions WHERE reference=? AND user_id=? ORDER BY id DESC LIMIT 1").get(`PO-${orderCreated.body.id}`,adminId);
    assert.ok(receiptAudit);

    const range=`?from=${new Date().toISOString().slice(0,10)}&to=${new Date(Date.now()+86400000).toISOString().slice(0,10)}`;
    const analytics=await request(`/analytics${range}`,adminCookie);
    assert.equal(analytics.status,200,JSON.stringify(analytics.body));
    assert.ok(analytics.body.inventory_value>0);
    assert.equal(analytics.body.daily_movement.length,2);
    assert.ok(analytics.body.daily_movement.every(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.day)));
    assert.equal(Math.round(analytics.body.inventory_by_category.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100),Math.round(analytics.body.inventory_value*100));
    assert.equal(analytics.body.stock_health.low_stock_products,Number((await db.prepare('SELECT COUNT(*) n FROM v_low_stock_products').get()).n));
    assert.equal(Math.round(analytics.body.warehouse_stock.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100),Math.round(analytics.body.inventory_value*100));
    assert.ok(analytics.body.warehouse_stock.some(row=>row.warehouse_id===warehouseEmpty&&Number(row.quantity)===0));
    assert.ok(analytics.body.low_stock.some(row=>row.product_id===lowProductId));
    assert.ok(analytics.body.top_products.some(row=>row.product_id===productId));
    assert.ok(analytics.body.movement_trends.length>0);
    assert.ok(analytics.body.movement_kpi.movements>0);
    const scopedAnalytics=await request(`/analytics${range}&warehouse_id=${warehouseOne}&category=Testing`,adminCookie);
    assert.equal(scopedAnalytics.status,200,JSON.stringify(scopedAnalytics.body));
    assert.deepEqual(scopedAnalytics.body.warehouse_stock.map(row=>row.warehouse_id),[warehouseOne]);
    assert.ok(scopedAnalytics.body.inventory_by_category.every(row=>row.category==='Testing'));
    assert.equal(Math.round(scopedAnalytics.body.inventory_value*100),Math.round(scopedAnalytics.body.warehouse_stock.reduce((sum,row)=>sum+Number(row.inventory_value),0)*100));
    assert.equal(scopedAnalytics.body.daily_movement.reduce((sum,row)=>sum+Number(row.movements),0),scopedAnalytics.body.movement_kpi.movements);
    assert.equal((await request(`/analytics${range}`,staffCookie)).status,403);
    const history=await request('/transactions',adminCookie);
    assert.equal(history.status,200);
    assert.ok(history.body.some(row=>row.user_name==='Postgres Staff'));

    await request('/auth/logout',adminCookie,{method:'POST'});
    assert.equal((await request('/auth/me',adminCookie)).status,401);
    const fk=await db.prepare("SELECT COUNT(*) n FROM pg_constraint WHERE contype='f' AND NOT convalidated").get();
    assert.equal(Number(fk.n),0);
  } finally {
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.()});
    if(db)await db.close();
    await pgServer.stop();
    await pgEngine.close();
    for(const key of ['DB_DRIVER','DATABASE_URL','PG_POOL_MAX','STOCKFLOW_NO_LISTEN','NODE_ENV','APP_ORIGINS'])delete process.env[key];
  }
});
