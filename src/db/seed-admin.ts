import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
(async () => {
  const phone = process.env.ADMIN_PHONE || '9307872086', pass = process.env.ADMIN_PASSWORD || 'dvpcapital@123', name = process.env.ADMIN_NAME || 'Super Admin';
  if (!phone || !pass || pass.length < 10) { console.error('Set ADMIN_PHONE and ADMIN_PASSWORD (min 10 chars)'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const hash = await bcrypt.hash(pass, 12);
  const r = await pool.query(`INSERT INTO users(member_id,full_name,phone,password_hash,role_code,designation,status,can_publish_emergency,is_vip_coordinator)
    VALUES('PFC-'||lpad(nextval('member_seq')::text,4,'0'),$1,$2,$3,'super_admin','Super Admin','active',true,true)
    ON CONFLICT (phone) DO UPDATE SET password_hash=$3, role_code='super_admin', status='active' RETURNING id, member_id`, [name, phone, hash]);
  await pool.query(`INSERT INTO user_roles(user_id,role_id) SELECT $1, id FROM roles WHERE code='super_admin' ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  await pool.query(`INSERT INTO room_members(room_id,user_id) SELECT id,$1 FROM rooms WHERE type IN ('global','hall_day') ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  console.log('Super admin ready:', r.rows[0].member_id); await pool.end();
})();
