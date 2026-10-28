# API reference

Base URL: `http://localhost:4000/api`; requests and responses use JSON.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | API health check |
| GET | `/dashboard` | Live totals, low-stock items, 7-day movements, recent transactions |
| GET | `/products?search=text` | Product catalog and aggregated stock |
| POST | `/products` | Create product; body: `sku,name,category,unit,reorder_level,supplier_id` |
| PUT | `/products/:id` | Update product fields |
| GET | `/warehouses` | Locations with product and unit totals |
| POST | `/warehouses` | Create warehouse; body: `name,location,manager` |
| GET | `/inventory?warehouse_id=id&search=text` | Stock by product/location |
| POST | `/transactions` | Stock operation; body below |
| GET | `/transactions` | Latest 100 transaction records |
| GET/POST | `/suppliers` | List or create suppliers |
| GET/POST | `/purchase-orders` | List or create simple one-line-item orders |

Stock operation body: `{ "type":"stock_in|stock_out|transfer", "product_id":1, "warehouse_id":1, "quantity":5, "reference":"optional", "note":"optional", "source_warehouse_id":2 }`. Transfers require a different source and destination and sufficient source quantity. Errors return `{ "error":"..." }` with HTTP 400.

Purchase order body: `{ "supplier_id":1, "warehouse_id":1, "items":[{"product_id":1,"quantity":5,"unit_cost":12.5}] }`. Orders are recorded as `ordered`; receiving them into inventory is not yet implemented.

This local demo API has no login or authorization middleware. Do not expose it to an untrusted network.
