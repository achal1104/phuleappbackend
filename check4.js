const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DB,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  await c.connect();
  for (const name of ['festival_days', 'events', 'event_assignments']) {
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
  const chk = await c.query(
    "select conrelid::regclass as tbl, pg_get_constraintdef(oid) as def from pg_constraint where conrelid in ('events'::regclass, 'festival_days'::regclass) and contype in ('c','f','u')",
  );
  console.log('\n== constraints ==');
  console.log(chk.rows);
  await c.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});