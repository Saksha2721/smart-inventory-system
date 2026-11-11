import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));
types.setTypeParser(1114, value => new Date(`${value.replace(' ', 'T')}Z`).toISOString());
types.setTypeParser(1184, value => new Date(value).toISOString());

const urlText = process.env.DATABASE_URL;
if (!urlText) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres.');
const connectionUrl = new URL(urlText);
const disableTlsForLocalTest = process.env.NODE_ENV !== 'production' && connectionUrl.searchParams.get('sslmode') === 'disable';
// Force certificate-verified TLS even when Neon supplies sslmode=require in its URL.
connectionUrl.searchParams.delete('sslmode');
connectionUrl.searchParams.delete('ssl');
connectionUrl.searchParams.delete('uselibpqcompat');

const pool = new Pool({
  connectionString: connectionUrl.toString(),
  ssl: disableTlsForLocalTest ? false : { rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: Number(process.env.PG_POOL_MAX || 5)
});
pool.on('error', () => console.error('PostgreSQL pool reported an idle connection error.'));
const transactionContext = new AsyncLocalStorage();
const returningTables = new Set(['users','sessions','products','warehouses','inventory','stock_transactions','suppliers','purchase_orders','purchase_order_items','purchase_order_receipts']);

function postgresSql(source) {
  let sql = source
    .replace(/date\('now','-6 days'\)/gi, "(CURRENT_DATE - 6)")
    .replace(/date\(day,'\+1 day'\)/gi, "(day + INTERVAL '1 day')::date")
    .replace(/strftime\('%Y-%m',\s*([^)]*)\)/gi, "to_char($1, 'YYYY-MM')")
    .replace(/to_char\(t\.created_at, 'YYYY-MM'\) month/gi, 'to_char(t.created_at, \'YYYY-MM\') AS "month"')
    .replace(/date\((\w+(?:\.\w+)?)\)/gi, '($1)::date')
    .replace(/GROUP_CONCAT\(a\.warehouse_id\)/gi, "STRING_AGG(a.warehouse_id::text, ',')");
  let n = 0;
  sql = sql.replace(/\?/g, () => `$${++n}`);
  return sql;
}

function returningSql(sql) {
  if (!/^\s*INSERT\s+INTO\s+/i.test(sql) || /\bRETURNING\b/i.test(sql)) return sql;
  const table = sql.match(/^\s*INSERT\s+INTO\s+([a-z_]+)/i)?.[1]?.toLowerCase();
  if (!returningTables.has(table)) return sql;
  return `${sql.trimEnd()} RETURNING id`;
}

function statement(source) {
  const sql = postgresSql(source);
  return {
    async all(...args) {
      const executor = transactionContext.getStore() || pool;
      const result = await executor.query(sql, args);
      return result.rows;
    },
    async get(...args) {
      const result = await this.all(...args);
      return result[0];
    },
    async run(...args) {
      const executor = transactionContext.getStore() || pool;
      const query = returningSql(sql);
      const result = await executor.query(query, args);
      return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0]?.id ?? 0 };
    }
  };
}

export const db = {
  prepare: statement,
  async exec(sql) {
    const executor = transactionContext.getStore() || pool;
    await executor.query(sql);
  },
  transaction(callback) {
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transactionContext.run(client, () => callback(...args));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* retain the original database error */ }
        throw error;
      } finally {
        client.release();
      }
    };
  },
  async health() {
    await pool.query('SELECT 1');
    return true;
  },
  async close() { await pool.end(); }
};

const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'postgres-schema.sql'), 'utf8');
await pool.query(schema);
