# Smart Inventory & Warehouse Management System — Logistics

StockFlow is a local demonstration application for multi-warehouse inventory operations. It uses React + Vite, Express, and SQLite (through the portable `sql.js` WebAssembly runtime). Dashboard figures, tables, alerts, and history are queried from SQLite.

## Requirements

- Node.js 20 or newer and npm (or pnpm)
- Windows, macOS, or Linux

## Start locally

1. Open this project folder in a terminal.
2. Install packages: `npm install`
3. Start both frontend and backend: `npm run dev`
4. Open **http://localhost:5173**. The API runs at **http://localhost:4000**.

The database is created automatically at `server/inventory.db` with realistic sample data on first launch. To reset the demo data, stop the app and delete that database file; it will be recreated next start. This generated database is ignored by Git.

To verify a production frontend build, run `npm run build`. The Express API does not serve the built frontend; `npm run dev` is the simplest demo command.

## Features

- Live overview counts, movement chart, recent activity, and low-stock alerts
- Product catalog with add, edit, search, and reorder thresholds
- Warehouse list with stock totals and manager information
- Stock-in, stock-out, and inter-warehouse transfers
- Transaction audit history
- Supplier directory creation and basic purchase order creation
- SQLite foreign keys and constraints; inventory rows reject negative values and transfer operations execute atomically

Demo operator shown in history: **Alex Morgan (Administrator)**. This is a local demonstration identity, not an authentication system. Do not expose the server publicly.

## Database

Schema is in [`server/schema.sql`](server/schema.sql). Relationships are documented in [`docs/erd.mmd`](docs/erd.mmd). API and architecture are in [`docs/API.md`](docs/API.md) and [`docs/architecture.mmd`](docs/architecture.mmd).

Tables: users, suppliers, products, warehouses, inventory, stock_transactions, purchase_orders, purchase_order_items. SQLite enforces primary keys, foreign keys, checks, and unique constraints. Stock operations use a transaction to keep inventory and audit rows consistent.

## Environment

The defaults work without an environment file. Copy `.env.example` to `.env` only if you need to change the local API port or database location. `VITE_API_URL` configures the frontend during Vite startup. Never store real credentials in `.env`; the example file contains no secrets.

## GitHub

Commit the source files and `pnpm-lock.yaml` (if generated). `.gitignore` excludes `node_modules`, build output, local SQLite files, and `.env`. Do not upload a real database or secrets.

## Demo flow

1. Show Overview and explain the database-backed total cards and low-stock panel.
2. Open Products, search “scanner”, and edit a reorder level; use Add product to create another catalog item.
3. Open Warehouses and create a location.
4. In Stock operations, choose Stock in and add units; verify the updated overview and transaction history.
5. Try a stock-out larger than the available quantity: the API rejects it and stock stays unchanged. Then stock out a valid amount.
6. Choose Transfer, select a source warehouse and a different destination, and submit. Confirm paired transfer entries in Transactions.
7. Create a supplier and purchase order under Purchase orders.

## Troubleshooting

- If the page cannot connect to the API, confirm both processes started and port 4000 is free.
- If dependencies fail to install, check that Node/npm are installed and internet access to the npm registry is available.
- Sample state is local to `server/inventory.db` and is not committed.

