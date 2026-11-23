const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DB,
  ssl: { rejectUnauthorized: false },
});

const ADMIN = '02253952-0808-4458-9bfa-b597372251cc';
const OLD = [
  '0db28bcc-8688-40a1-9b12-cb683879c156',
  '3f836131-c450-47c5-b254-9dfbc08ac639',
  '4aa0dc79-eaeb-4cde-ab18-cca8e06d63eb',
];
const DATE = { 1: '2026-11-27', 2: '2026-11-28', 3: '2026-11-29' };
const HALL = 1; // Hall A, nantar app madhun badla

// [day, title, description, start, end]
const E = [
  [1, 'काव्य फुले', 'कवींची मैफल · ओपन माईक', '10:00', '11:00'],
  [1, 'सत्यशोधक लोककला दालन', 'महाराष्ट्रातून आलेल्या ५०० लोककलावंतांचे सादरीकरण. एकांकिका व समूह नृत्य · निळू फुले करंडक', '10:00', '14:00'],
  [1, 'संशोधन निबंध सादरीकरण', 'बीजभाषण · पद्मश्री डॉ. गणेश देवी आणि इतर मान्यवर', '11:00', '15:00'],
  [1, 'शिक्षक साहित्य संमेलन', 'अध्यक्ष: दासू वैद्य · उद्घाटक: विकास पाटील', '15:30', '17:30'],
  [1, 'उद्घाटन', null, '16:00', '17:30'],
  [1, 'पुस्तक प्रकाशन व स्टॉल उद्घाटन', null, '17:30', '18:30'],
  [1, 'मेरी पाटील स्मृती व्याख्यान', 'व्याख्याते: बजरंग बिहारी तिवारी', '18:30', '19:30'],
  [1, 'महाजलसा', 'लोककलावंतांची संगीतबारी', '19:30', '22:00'],
  [2, 'Phule Walk', 'Bhide Wada to Phule Wada heritage walk.', '10:00', '12:00'],
  [2, 'Research Paper Presentations', 'Parallel and thematic sessions.', '12:00', '15:00'],
  [2, 'Phule@200 National Conference', 'Eminent speakers from diverse fields.', '15:00', '17:00'],
  [2, 'National Youth Conference', 'Young voices from across India.', '17:00', '19:00'],
  [2, 'Film Screening', 'Films and documentaries.', '19:00', '21:30'],
  [3, 'Literature Festival', 'Writers, poets and readers.', '10:00', '13:00'],
  [3, 'Research Paper Presentations', 'The final round.', '11:00', '13:00'],
  [3, "Artists' Meet-up", 'Art and social change.', '12:00', '14:00'],
  [3, 'Film & Documentary Screening', 'The closing programme.', '16:00', '18:30'],
];

(async () => {
  await c.connect();
  try {
    const chk = await c.query(
      'select count(*)::int as n from events where deleted_at is null and id <> all($1::uuid[])',
      [OLD],
    );
    if (chk.rows[0].n > 0) {
      console.log('STOP: ya events aadhich aahet (' + chk.rows[0].n + '). Duplicate nako mhanun thambla.');
      return;
    }
    await c.query('begin');
    await c.query('update events set deleted_at = now() where id = any($1::uuid[])', [OLD]);
    const seq = { 1: 0, 2: 0, 3: 0 };
    for (const [day, title, desc, s, e] of E) {
      seq[day] += 1;
      await c.query(
        `insert into events (hall_id, day_id, title, description, start_time, end_time, seq, created_by)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8)`,
        [HALL, day, title, desc, DATE[day] + 'T' + s + ':00+05:30', DATE[day] + 'T' + e + ':00+05:30', seq[day], ADMIN],
      );
    }
    await c.query('commit');
    const r = await c.query('select day_id, count(*)::int as n from events where deleted_at is null group by 1 order by 1');
    console.log('Done. Events per day:', r.rows);
  } catch (err) {
    await c.query('rollback').catch(() => {});
    console.error('ERROR:', err.message);
  } finally {
    await c.end();
  }
})();