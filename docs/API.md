# API reference

Local base URL: `http://localhost:4000/api`. JSON is used for request and response bodies. The frontend sends the HTTP-only session cookie automatically. All endpoints require a valid session except `GET /health` and `POST /auth/login`.

`GET /health` returns `{ "ok":true,"database":"connected" }` only after a database query succeeds. If the selected database is unavailable, it returns HTTP 503 with a generic error and no connection details. Render uses this route as its health check.

## Authentication

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Public API health check |
| POST | `/auth/login` | Authenticate `{ "email": "…", "password": "…" }`; sets an HTTP-only session cookie |
| GET | `/auth/me` | Current authenticated user and assigned warehouse IDs |
| POST | `/auth/logout` | Revoke the current session and clear the cookie |

Sessions expire after eight hours. Login failures are throttled by the hashed client-IP/email key. Passwords use Node `scrypt`; plaintext passwords are never stored. There is no public registration endpoint.

## Inventory and operations

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/dashboard` | Admin: all warehouses. Staff: assigned warehouse totals and own recent movements |
| GET | `/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` | Admin only; live inventory valuation, warehouse stock, low stock, movement rankings/trends, and purchase-order summaries |
| GET | `/products?search=text` | Admin: all products. Staff: products stocked in assigned warehouses |
| POST | `/products` | Admin only; body: `sku,name,category,unit,reorder_level,unit_cost,supplier_id` |
| PUT | `/products/:id` | Admin only; update product fields |
| DELETE | `/products/:id` | Admin only; refuses deletion if a stock transaction references the product |
| GET | `/warehouses` | Admin: all. Staff: assigned only |
| POST | `/warehouses` | Admin only; body: `name,location,manager` |
| PUT | `/warehouses/:id` | Admin only; update warehouse details |
| PATCH | `/warehouses/:id/deactivate` | Admin only; deactivate while retaining stock and historical records |
| PATCH | `/warehouses/:id/activate` | Admin only; reactivate a warehouse |
| GET | `/inventory?warehouse_id=id&search=text` | Admin: all or requested warehouse. Staff: assigned locations only |
| POST | `/transactions` | Admin: stock-in, stock-out, transfer. Staff: stock-in/out at assigned locations only |
| GET | `/transactions` | Admin: latest 100 records. Staff: own records in assigned locations |

Stock operation body: `{ "type":"stock_in|stock_out|transfer", "product_id":1, "warehouse_id":1, "quantity":5, "reference":"optional", "note":"optional", "source_warehouse_id":2 }`. Quantities must be positive whole numbers. Transfers are admin-only and require distinct active source/destination warehouses and enough source stock. Inactive warehouses reject all new stock movements. Each movement is atomically written with the authenticated employee ID. Invalid or overdrawn requests are rejected.

## Employee and purchasing management

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/employees` | Admin only; list accounts and assignments (password hashes are never returned) |
| POST | `/employees` | Admin only; create `{name,email,role,password,warehouse_ids}`; passwords must be 12–128 characters; staff require assignments |
| PUT | `/employees/:id` | Admin only; update account, role, assignments; blank password leaves it unchanged |
| PATCH | `/employees/:id/deactivate` | Admin only; deactivate and revoke active sessions |
| PATCH | `/employees/:id/activate` | Admin only; reactivate an account |
| GET/POST | `/suppliers` | Admin only; list or create suppliers |
| GET/POST | `/purchase-orders` | Admin only; list or create orders; list includes receiving progress |
| GET | `/purchase-orders/:id` | Admin only; order lines with ordered, received, and remaining quantities |
| POST | `/purchase-orders/:id/receive` | Admin only; body `{ "items":[{"item_id":1,"quantity":2}] }`; receives valid remaining quantities atomically |

Purchase order body: `{ "supplier_id":1, "warehouse_id":1, "items":[{"product_id":1,"quantity":5,"unit_cost":12.5}] }`. Receiving creates receipt rows, increases inventory, and records stock-in transactions with the signed-in employee. Partial progress is reported as `partially_received`; the existing database status remains `ordered` until all lines are received, then changes to `received`. Receiving a cancelled/completed order, an unrelated line, invalid quantity, or more than the remaining quantity is rejected.

Inventory analytics use the current product unit cost multiplied by on-hand inventory. Legacy products are backfilled from the most recent nonnegative purchase-order item cost when available; products without recorded cost remain valued at zero. Analytics date filters apply to movement and purchase-order reports; stock valuation is a current snapshot.

## Security notes

The session cookie is HTTP-only and SameSite strict. On `NODE_ENV=production`, it is also Secure, so production use requires HTTPS. `APP_ORIGINS` can allow exact trusted origins; Render's `RENDER_EXTERNAL_URL` is also allowed for the single-origin deployment. Local development uses the Vite `/api` proxy. PostgreSQL connections require certificate-verified TLS except the explicit local PGlite test connection. Error responses use `{ "error":"…" }`; authentication failures return HTTP 401 and role/warehouse authorization failures return HTTP 403.
