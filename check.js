const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DB,
  ssl: { rejectUnauthorized: false },
});
c.connect()
  .then(() => c.query('select * from users'))
  .then((r) => {
    console.log('Total users:', r.rows.length);
    console.log(
      r.rows.map((u) =>
        Object.fromEntries(
          Object.entries(u).filter(([k]) => !/pass|hash|secret/i.test(k)),
        ),
      ),
    );
    return c.end();
  })
  .catch((e) => {
    console.error('ERROR:', e.message);
    c.end();
  });