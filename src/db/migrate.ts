import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  const dir = path.join(process.cwd(), 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); console.log('applied', f); }
    catch (e) { await c.query('ROLLBACK'); console.error('FAILED', f, e); process.exit(1); } finally { c.release(); }
  }
  await pool.end();
})();
