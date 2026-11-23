const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DB,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  await c.connect();
  const t = await c.query(
    "select table_name from information_schema.tables where table_schema='public' order by 1",
  );
  console.log('TABLES:', t.rows.map((r) => r.table_name).join(', '));
  const en = await c.query(
    'select t.typname, e.enumlabel from pg_type t join pg_enum e on t.oid=e.enumtypid order by 1, e.enumsortorder',
  );
  console.log('\nENUMS:', en.rows);
  for (const name of ['halls', 'days', 'events']) {
    const cols = await c.query(
      "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",
      [name],
    );
    console.log('\n== ' + name + ' columns ==');
    console.table(cols.rows);
    const rows = await c.query('select * from ' + name + ' limit 20');
    console.log(name + ' rows:', rows.rowCount);
    console.log(rows.rows);
  }
  await c.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});