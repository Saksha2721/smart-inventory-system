CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','staff')), password_hash TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS warehouse_assignments(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, PRIMARY KEY(user_id,warehouse_id));
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs', reorder_level INTEGER NOT NULL DEFAULT 10 CHECK(reorder_level >= 0), unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost >= 0), supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS warehouses(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, location TEXT NOT NULL, manager TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS inventory(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0), updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id,warehouse_id));
CREATE TABLE IF NOT EXISTS stock_transactions(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), type TEXT NOT NULL CHECK(type IN ('stock_in','stock_out','transfer_in','transfer_out','adjustment')), quantity INTEGER NOT NULL CHECK(quantity > 0), reference TEXT, note TEXT, user_id INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT, email TEXT, phone TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ordered','received','cancelled')), total REAL NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_order_items(id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0), unit_cost REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchase_order_receipts(id INTEGER PRIMARY KEY, purchase_order_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE, quantity INTEGER NOT NULL CHECK(quantity > 0), received_by INTEGER NOT NULL REFERENCES users(id), received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_txn_created ON stock_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_warehouse_product ON inventory(warehouse_id,product_id);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_product_type ON stock_transactions(product_id,type,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_user_date ON stock_transactions(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_assignments_warehouse ON warehouse_assignments(warehouse_id,user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status_date ON purchase_orders(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_product ON purchase_order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_warehouse_date ON stock_transactions(warehouse_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_receipts_item ON purchase_order_receipts(purchase_order_item_id,received_at);
CREATE INDEX IF NOT EXISTS idx_purchase_order_receipts_user ON purchase_order_receipts(received_by,received_at DESC);

-- SQLite has no ALTER TABLE ADD CONSTRAINT. Triggers add these protections
-- safely to existing databases without rebuilding or removing any table.
CREATE TRIGGER IF NOT EXISTS trg_purchase_orders_total_nonnegative_insert
BEFORE INSERT ON purchase_orders WHEN NEW.total < 0
BEGIN SELECT RAISE(ABORT,'purchase order total must be nonnegative'); END;
CREATE TRIGGER IF NOT EXISTS trg_purchase_orders_total_nonnegative_update
BEFORE UPDATE OF total ON purchase_orders WHEN NEW.total < 0
BEGIN SELECT RAISE(ABORT,'purchase order total must be nonnegative'); END;
CREATE TRIGGER IF NOT EXISTS trg_purchase_order_items_cost_nonnegative_insert
BEFORE INSERT ON purchase_order_items WHEN NEW.unit_cost < 0
BEGIN SELECT RAISE(ABORT,'purchase order item cost must be nonnegative'); END;
CREATE TRIGGER IF NOT EXISTS trg_purchase_order_items_cost_nonnegative_update
BEFORE UPDATE OF unit_cost ON purchase_order_items WHEN NEW.unit_cost < 0
BEGIN SELECT RAISE(ABORT,'purchase order item cost must be nonnegative'); END;

CREATE VIEW IF NOT EXISTS v_current_stock_by_warehouse AS
SELECT i.id,i.product_id,p.sku,p.name product_name,p.category,p.unit,p.reorder_level,
       i.warehouse_id,w.name warehouse_name,i.quantity,i.updated_at
FROM inventory i
JOIN products p ON p.id=i.product_id
JOIN warehouses w ON w.id=i.warehouse_id;

CREATE VIEW IF NOT EXISTS v_low_stock_products AS
SELECT p.id,p.sku,p.name,p.category,p.unit,p.reorder_level,
       COALESCE(SUM(i.quantity),0) total_quantity,
       p.reorder_level-COALESCE(SUM(i.quantity),0) shortage
FROM products p
LEFT JOIN inventory i ON i.product_id=p.id
GROUP BY p.id
HAVING COALESCE(SUM(i.quantity),0)<=p.reorder_level;

CREATE VIEW IF NOT EXISTS v_product_stock_movement_totals AS
SELECT p.id product_id,p.sku,p.name,
       COALESCE(SUM(CASE WHEN t.type='stock_in' THEN t.quantity ELSE 0 END),0) stock_in_quantity,
       COALESCE(SUM(CASE WHEN t.type='stock_out' THEN t.quantity ELSE 0 END),0) stock_out_quantity,
       COALESCE(SUM(CASE WHEN t.type='transfer_in' THEN t.quantity ELSE 0 END),0) transfer_in_quantity,
       COALESCE(SUM(CASE WHEN t.type='transfer_out' THEN t.quantity ELSE 0 END),0) transfer_out_quantity,
       COALESCE(SUM(CASE WHEN t.type='adjustment' THEN t.quantity ELSE 0 END),0) adjustment_quantity,
       COALESCE(SUM(t.quantity),0) total_movement_quantity,
       COALESCE(SUM(CASE WHEN t.type IN ('stock_in','transfer_in') THEN t.quantity ELSE 0 END),0) total_inbound_quantity,
       COALESCE(SUM(CASE WHEN t.type IN ('stock_out','transfer_out') THEN t.quantity ELSE 0 END),0) total_outbound_quantity,
       COALESCE(SUM(CASE WHEN t.type='stock_in' THEN t.quantity WHEN t.type='stock_out' THEN -t.quantity ELSE 0 END),0) net_external_movement,
       COUNT(t.id) movement_count
FROM products p
LEFT JOIN stock_transactions t ON t.product_id=p.id
GROUP BY p.id;

CREATE VIEW IF NOT EXISTS v_purchase_order_summary AS
SELECT po.id,po.supplier_id,s.name supplier_name,po.warehouse_id,w.name warehouse_name,
       po.status,po.total,po.created_at,COUNT(item.id) item_count,
       COALESCE(SUM(item.quantity),0) total_quantity
FROM purchase_orders po
JOIN suppliers s ON s.id=po.supplier_id
JOIN warehouses w ON w.id=po.warehouse_id
LEFT JOIN purchase_order_items item ON item.purchase_order_id=po.id
GROUP BY po.id;
