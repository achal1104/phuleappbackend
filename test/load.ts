import { spawn, execSync } from 'child_process';
import { io, Socket } from 'socket.io-client';
import { Pool } from 'pg';
import * as jwt from 'jsonwebtoken';

const N = Number(process.env.USERS || 450), SENDERS = Number(process.env.SENDERS || 60), PORT = 3112, BASE = `http://localhost:${PORT}`;
const DB = 'postgres://phule:phule@localhost/phule_test', SECRET = 'x'.repeat(40);
const env = { ...process.env, DATABASE_URL: DB, JWT_SECRET: SECRET, PORT: String(PORT), RATE_LIMIT: '1000000' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

(async () => {
  execSync(`psql "${DB}" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`, { stdio: 'ignore' });
  execSync('node dist/src/db/migrate.js', { env, stdio: 'ignore' });
  const pool = new Pool({ connectionString: DB });
  await pool.query(`INSERT INTO users(member_id,full_name,phone,password_hash,status,role_code)
    SELECT 'LOAD-'||g, 'Load User '||g, '+9100000'||lpad(g::text,5,'0'), 'x', 'active', CASE WHEN g<=10 THEN 'core_team' WHEN g<=110 THEN 'management' ELSE 'volunteer' END FROM generate_series(1,$1) g`, [N]);
  await pool.query(`INSERT INTO room_members(room_id,user_id) SELECT r.id,u.id FROM rooms r CROSS JOIN users u WHERE r.type='global'`);
  const users = (await pool.query('SELECT id FROM users ORDER BY member_id')).rows.map((r) => r.id);
  const srv = spawn('node', ['dist/src/main.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await sleep(500); }
  const tokens = users.map((id) => jwt.sign({ sub: id }, SECRET, { expiresIn: '1h' }));
  const room = (await pool.query(`SELECT id FROM rooms WHERE type='global'`)).rows[0].id;

  const t0 = Date.now(); const socks: Socket[] = [];
  await Promise.all(tokens.map((t) => new Promise<void>((res, rej) => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'], reconnection: false }); socks.push(s); s.on('ready', () => res()); setTimeout(() => rej(new Error('connect timeout')), 30000); })));
  console.log(`connected ${N} sockets in ${Date.now() - t0} ms`);

  // every socket records arrival time of each message it gets
  const sentAt = new Map<string, number>(); const lat: number[] = []; let received = 0;
  socks.forEach((s) => s.on('message:new', (m) => { const t = sentAt.get(m.body); if (t) { lat.push(Date.now() - t); received++; } }));
  const t1 = Date.now(); const sendLat: number[] = [];
  await Promise.all(socks.slice(0, SENDERS).map(async (s, i) => {
    const body = 'load-' + i; sentAt.set(body, Date.now()); const a0 = Date.now();
    const r = await s.emitWithAck('message:send', { roomId: room, body }); sendLat.push(Date.now() - a0); if (!r.ok) console.log('send failed', r.error);
  }));
  await sleep(4000);
  const expected = SENDERS * N;
  console.log(`messages: ${SENDERS} sent concurrently -> ${received}/${expected} deliveries (${(100 * received / expected).toFixed(2)}%) in ${Date.now() - t1 - 4000} ms`);
  console.log(`send->ack latency  p50=${pct(sendLat, .5)}ms p95=${pct(sendLat, .95)}ms max=${Math.max(...sendLat)}ms`);
  console.log(`send->receive latency p50=${pct(lat, .5)}ms p95=${pct(lat, .95)}ms p99=${pct(lat, .99)}ms`);

  // concurrent REST burst: every user loads dashboard + rooms at once
  const t2 = Date.now(); const http: number[] = []; let bad = 0;
  await Promise.all(tokens.flatMap((t) => ['/rooms', '/notifications'].map(async (p) => { const a = Date.now(); const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + t } }); http.push(Date.now() - a); if (r.status !== 200) bad++; })));
  console.log(`REST burst ${N * 2} requests in ${Date.now() - t2} ms, errors=${bad}, p50=${pct(http, .5)}ms p95=${pct(http, .95)}ms`);

  // emergency broadcast to everyone while all are connected
  const adminId = users[0]; await pool.query(`UPDATE users SET role_code='super_admin' WHERE id=$1`, [adminId]);
  let got = 0; const e0 = Date.now(); let last = 0; socks.forEach((s) => s.on('emergency:new', () => { got++; last = Date.now() - e0; }));
  const er = await fetch(BASE + '/emergency', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[0] }, body: JSON.stringify({ category: 'general_urgent', title: 'Load drill', description: 'drill', targetType: 'all' }) });
  await sleep(4000); console.log(`emergency drill: status ${er.status}, ${got}/${N} sockets received, last arrival ${last} ms`);
  const mem = process.memoryUsage().rss / 1e6; console.log(`load client rss ${mem.toFixed(0)} MB`);
  const ok = received / expected > 0.999 && bad === 0 && got === N;
  socks.forEach((s) => s.close()); srv.kill(); await pool.end(); console.log(ok ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED'); process.exit(ok ? 0 : 1);
})();
