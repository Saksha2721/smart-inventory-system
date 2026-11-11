# StockFlow deployment preparation

Deployment is **not complete** until a Neon URL is configured, the SQLite copy is migrated and verified, the updated branch is pushed, and Render's public URL passes its health check. Do not use the local SQLite file on Render: Render Free's filesystem is temporary.

## 1. Create the free Neon database

1. Open [Neon Console](https://console.neon.tech/) and sign in.
2. Choose **Create project**. Name it `stockflow-production`, choose a nearby region, and select the **Free** plan if asked.
3. Confirm the console shows **$0 / Free** before creating it. Do not add payment details or upgrade.
4. Open the project dashboard and choose **Connect**. Select the default database and a **pooled** connection string for a Node.js app.
5. Keep the connection string private. It contains a database password. Do not send it in chat or add it to a committed file.

Neon's current Free plan lists 1 GB storage per project, 100 compute hours per month, 5 GB egress, and scale-to-zero after five idle minutes. It has no uptime SLA and its limits can change; keep a separate SQLite backup. [Plan details](https://neon.com/docs/introduction/plans)

## 2. Migrate the existing SQLite data safely

This is a manual step after the Neon database exists. The command reads `server/inventory.auth-demo.db`, first copies it to a temporary file, and only writes to the Neon database. It never writes to the SQLite source. Run it before adding a new admin account or using the cloud database.

1. In the project folder, copy `.env.example` to `.env`.
2. Edit only the local `.env` file and set:

   ```env
   DB_DRIVER=postgres
   DATABASE_URL=<paste-the-Neon-connection-string-here>
   SQLITE_SOURCE_PATH=./server/inventory.auth-demo.db
   MIGRATION_REPORT_PATH=./server/migration-report.json
   ```

3. In PowerShell in the project folder, run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm run migrate:postgres
   ```

4. Continue only if the command reports `Migration verified` and every table has matching source and destination row counts with zero mismatches. The generated report contains counts and verification status, not passwords, password hashes, or connection strings. It is ignored by Git.
5. The migration is safe to rerun against an otherwise unchanged, newly created destination: matching IDs are skipped and compared. If the destination already contains unrelated rows, it stops without overwriting them. Do not manually merge records into the Neon database before migrating.
6. Remove the Neon URL from `.env` before sharing the project folder. `.env` is ignored by Git.

Existing password hashes are copied unchanged, so existing employees can sign in with their current passwords. The migration does not print hashes or recover passwords.

## 3. Connect the GitHub repository to Render (do not deploy yet)

The new deployment files currently exist only in this local working tree. They have **not** been pushed to GitHub. Keep deployment on hold until the code is reviewed and you explicitly approve pushing it.

After the branch containing these files is uploaded:

1. Sign in to [Render](https://dashboard.render.com/) using **GitHub**.
2. Click **New** → **Blueprint**.
3. Authorize Render to access `Saksha2721/smart-inventory-system` if prompted.
4. Select that repository and the branch that contains the deployment changes. Render should detect the root `render.yaml`.
5. Review the service settings. Confirm the service plan is **Free** and the service name is `stockflow-smart-inventory`.
6. When Render asks for `DATABASE_URL`, paste the Neon pooled connection string directly into Render's secret field. Do not put it in `render.yaml` or GitHub.
7. Do not click **Apply**, **Create**, or **Deploy** until you are ready to publish. This project is deliberately not deployed from these instructions.

`render.yaml` sets the build command to `corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build` so Vite's development dependencies are installed even while `NODE_ENV=production` is set. It uses `corepack pnpm start`, health path `/api/health`, and `autoDeploy: false`. `DB_DRIVER=postgres` ensures production refuses to fall back to an ephemeral SQLite file. Render supplies its public origin; the API allows that same origin and secure cookies are enabled under HTTPS.

## Free-tier behavior

- Render Free web services have an ephemeral filesystem and sleep after 15 minutes of inactivity. The first request after sleeping can take about a minute. Local SQLite changes would be lost, so production selects PostgreSQL only. [Render free limits](https://render.com/docs/free)
- Render free PostgreSQL expires 30 days after creation; it is not used here.
- Neon Free data is external to Render's filesystem, but free compute/storage/network quotas apply and service can be unavailable while the database wakes. Monitor both dashboards and keep a backup.
- No payment method, paid instance, Render Postgres, or credit top-up is needed by this configuration.
