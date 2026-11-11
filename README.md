# Smart Inventory & Warehouse Management System — Logistics

StockFlow is a multi-warehouse inventory application. Local development uses React + Vite, Express, and SQLite (`sql.js`); production can use PostgreSQL through `pg`, including Neon. Dashboard figures, tables, alerts, and history are queried from the selected database.

## Requirements

- Node.js 20 or newer and npm (or pnpm)
- Windows, macOS, or Linux

## Start locally

1. Open this project folder in a terminal.
2. Install packages: `pnpm install`
3. On first use, stop any running app processes and run `pnpm run create-admin`. Enter a name and email, then a unique password of at least 12 characters; password input is hidden. This creates the first administrator in the selected database. There is no public registration page.
4. Start both frontend and backend: `pnpm run dev`
5. Open **http://localhost:5173**. The API runs at **http://localhost:4000**.

Sign in with the admin credentials. Admins create staff accounts and choose warehouse assignments from **Employee management**.

The database is created automatically at `server/inventory.auth-demo.db` with realistic sample data on first launch. This keeps the local authenticated demo database separate from any older `server/inventory.db` file. To reset the demo data, stop the app and delete the selected demo database file; it will be recreated next start. Database files are ignored by Git.

With PostgreSQL configured and `NODE_ENV=production`, `pnpm build` followed by `pnpm start` runs the single-service production setup; Express serves the Vite build and `/api` from the same origin. For the local SQLite demo, `pnpm run dev` remains the simplest command.

## Features

- Live overview counts, movement chart, recent activity, and low-stock alerts
- Product catalog with add, edit, search, and reorder thresholds
- Warehouse list with stock totals and manager information
- Stock-in, stock-out, and inter-warehouse transfers
- Transaction audit history with the signed-in employee
- Supplier directory creation and basic purchase order creation
- Purchase order partial/full receiving with inventory and employee-audited transactions
- Admin analytics with current stock valuation, low-stock and movement reports, monthly trends, date filters, and CSV exports
- Warehouse deactivation/reactivation that preserves stock/history and blocks new stock movements
- SQLite foreign keys and constraints; inventory rows reject negative values and transfer operations execute atomically
- Hashed passwords, expiring server-side sessions, login throttling, admin/staff roles, and staff warehouse assignments

Staff can view inventory for assigned warehouses and perform stock-in/stock-out there. Only admins can transfer stock, manage products and warehouses, manage employee accounts, and use suppliers or purchase orders. The API enforces these permissions independently of the user interface.

## Database

The local schema is in [`server/schema.sql`](server/schema.sql); the PostgreSQL schema is in [`server/postgres-schema.sql`](server/postgres-schema.sql). Relationships are documented in [`docs/erd.mmd`](docs/erd.mmd). API and architecture are in [`docs/API.md`](docs/API.md) and [`docs/architecture.mmd`](docs/architecture.mmd).

Tables: users, sessions, warehouse_assignments, login_attempts, suppliers, products, warehouses, inventory, stock_transactions, purchase_orders, purchase_order_items, purchase_order_receipts. Both schemas define primary keys, foreign keys, checks, indexes, and reporting views. Stock operations and order receiving use transactions to keep inventory and audit rows consistent. SQLite startup applies additive schema migrations and keeps existing rows. The PostgreSQL migration copies from a temporary SQLite copy, preserves IDs and password hashes, and verifies row values/counts before reporting success. Existing legacy demo users do not have passwords and cannot sign in until an administrator replaces them or creates managed employee accounts.

## Environment

The defaults work without an environment file. Copy `.env.example` to `.env` only if you need to change the local API port, SQLite path, or allowed origins. Local development uses `DB_DRIVER=sqlite`. Production must set `NODE_ENV=production`, `DB_DRIVER=postgres`, and `DATABASE_URL` to a private Neon connection string; TLS certificate validation is enabled. The same-origin Render frontend/API uses secure HTTPS cookies and Render's public service origin. `.env` is ignored by Git. Never commit passwords, connection strings, local SQLite files, or migration reports.

## Production deployment

Deployment is prepared but is not created or published from this repository automatically. See [`docs/deployment.md`](docs/deployment.md) for Neon setup, safe data migration, Render Blueprint settings, free-tier limitations, and the manual GitHub steps. The deployment configuration uses one Render Free web service and an external Neon PostgreSQL database; it never uses Render's temporary filesystem for persistent inventory.

## Verification

Run `pnpm test` for the SQLite suite and PostgreSQL API/migration tests. The PostgreSQL tests use a local PGlite PostgreSQL engine; they do not contact Neon or Render. Run `pnpm build` to build the frontend.

## GitHub

Commit the source files and lockfile. `.gitignore` excludes `node_modules`, build output, local SQLite files, and `.env`. Do not upload a real database or secrets.

## Demo flow

1. Sign in with the administrator account provisioned using `npm run create-admin`.
2. Show the live dashboard and employee name/administrator role.
3. Open Employee management and create a staff account with at least one warehouse assignment.
4. Sign out and sign in as staff. Show that only assigned warehouses appear, then perform a valid stock-in and stock-out.
5. Open Transactions to show the employee name on the movements. Try an unassigned warehouse API action or an admin-only screen to demonstrate the backend permission checks (the UI hides unauthorized pages).
6. Sign out, sign in as admin, and show product/warehouse management, transfers, suppliers, and purchase orders.

## Troubleshooting

- If the page cannot connect to the API, confirm both processes started and port 4000 is free.
- If dependencies fail to install, check that Node/npm are installed and internet access to the npm registry is available.
- Sample state is local to `server/inventory.db` and is not committed.
- If the admin setup command says an administrator already exists, sign in and create additional users under **Employee management**. If you have lost the only admin password, stop the application, back up the database, then use the documented recovery procedure from your instructor or project maintainer rather than deleting inventory data.

