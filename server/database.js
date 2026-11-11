const driver = (process.env.DB_DRIVER || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();
if (!['sqlite', 'postgres'].includes(driver)) throw new Error('DB_DRIVER must be sqlite or postgres.');
if (process.env.NODE_ENV === 'production' && driver !== 'postgres') {
  throw new Error('Production requires DB_DRIVER=postgres; local SQLite files are not persistent on Render Free.');
}

let db;
if (driver === 'postgres') {
  const module = await import('./postgres-db.js');
  db = module.db;
} else {
  const { db: sqlite } = await import('./db.js');
  // Keep sql.js for local development, while exposing the same async interface
  // used by PostgreSQL so API handlers can await either implementation.
  const statement = sql => {
    const raw = sqlite.prepare(sql);
    return {
      async all(...args) { return raw.all(...args); },
      async get(...args) { return raw.get(...args); },
      async run(...args) { return raw.run(...args); }
    };
  };
  db = {
    prepare: statement,
    async exec(sql) { return sqlite.exec(sql); },
    transaction(callback) { return sqlite.transaction(callback); },
    async health() { return sqlite.health(); },
    async close() {}
  };
}

export { db };
