import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Audit, AuthUser, Db, Me, RANK, Realtime, Roles, oneOf, phoneNorm, str, uuid, uuids } from '../common/core';
import { Notifier } from '../notifications/notifications';
import { RoomSync } from '../chat/rooms.service';

const ROLES = Object.keys(RANK);
const USER_COLS = `u.id, u.member_id AS "memberId", u.full_name AS "fullName", u.phone, u.email, u.role_code AS role, u.designation,
  u.hall_id AS "hallId", u.status, u.can_publish_emergency AS "canPublishEmergency", u.is_vip_coordinator AS "isVipCoordinator", u.created_at AS "createdAt"`;

@Controller('admin/users')
@Roles('super_admin')
export class AdminUsersController {
  constructor(private db: Db, private audit: Audit, private sync: RoomSync, private notifier: Notifier, private rt: Realtime) {}

  @Get() list(@Query('status') status?: string, @Query('q') q?: string, @Query('role') role?: string) {
    return this.db.rows(`SELECT ${USER_COLS} FROM users u WHERE u.deleted_at IS NULL
      AND ($1::text IS NULL OR u.status=$1) AND ($2::text IS NULL OR u.role_code=$2)
      AND ($3::text IS NULL OR u.full_name ILIKE '%'||$3||'%' OR u.member_id ILIKE '%'||$3||'%')
      ORDER BY u.created_at DESC LIMIT 500`, [status ?? null, role ?? null, q ?? null]);
  }

  private async applyAssignment(c: any, adminId: string, userId: string, b: any) {
    const role = oneOf(b.role ?? 'volunteer', 'role', ROLES);
    const hallId = b.hallId ?? null;
    if ((role === 'hall_manager') && !hallId) throw new BadRequestException('hallId required for hall_manager');
    await c.query(`UPDATE users SET role_code=$2, designation=COALESCE($3,designation), hall_id=$4,
      can_publish_emergency=COALESCE($5,can_publish_emergency), is_vip_coordinator=COALESCE($6,is_vip_coordinator), updated_at=now() WHERE id=$1`,
      [userId, role, b.designation ?? null, hallId, b.canPublishEmergency ?? null, b.isVipCoordinator ?? null]);
    await c.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
    await c.query('INSERT INTO user_roles(user_id,role_id,assigned_by) SELECT $1,id,$3 FROM roles WHERE code=$2', [userId, role, adminId]);
    for (const eid of uuids(b.eventIds, 'eventIds'))
      await c.query(`INSERT INTO event_assignments(event_id,user_id,assignment_role,assigned_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [eid, userId, role === 'event_manager' ? 'manager' : 'volunteer', adminId]);
  }

  @Post(':id/approve') async approve(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    const res = await this.db.tx(async (c) => {
      const u = (await c.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!u) throw new NotFoundException();
      if (u.status === 'active') throw new BadRequestException('Already active');
      await c.query(`UPDATE users SET status='active' WHERE id=$1`, [id]);
      await this.applyAssignment(c, me.id, id, b);
      const syncs = await this.sync.syncAll(c);
      await this.audit.log(me.id, 'member.approve', 'user', id, { status: u.status }, { role: b.role, hallId: b.hallId }, c);
      return syncs;
    });
    this.sync.applyRealtime(res);
    await this.notifier.send([id], { type: 'activation', title: 'Account activated', body: 'Your Phule Festival account is now active.', deepLink: '/home' });
    return { ok: true };
  }

  @Post(':id/reject') async reject(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    await this.db.q(`UPDATE users SET status='rejected', updated_at=now() WHERE id=$1 AND status='pending'`, [id]);
    await this.audit.log(me.id, 'member.reject', 'user', id, null, { reason: b.reason });
    return { ok: true };
  }

  /** Create an already-active member (admin-added). */
  @Post() async create(@Me() me: AuthUser, @Body() b: any) {
    const name = str(b.fullName, 'fullName', 120)!; const phone = phoneNorm(str(b.phone, 'phone', 20, false) ?? undefined);
    const email = str(b.email, 'email', 160, false)?.toLowerCase() ?? null;
    if (!phone && !email) throw new BadRequestException('phone or email required');
    const pw = str(b.password, 'password', 100)!; if (pw.length < 8) throw new BadRequestException('password min 8 chars');
    const hash = await bcrypt.hash(pw, 11);
    const out = await this.db.tx(async (c) => {
      const u = (await c.query(`INSERT INTO users(member_id,full_name,phone,email,password_hash,status)
        VALUES('PFC-'||lpad(nextval('member_seq')::text,4,'0'),$1,$2,$3,$4,'active') RETURNING id,member_id`, [name, phone, email, hash])).rows[0];
      await this.applyAssignment(c, me.id, u.id, b);
      const s = await this.sync.syncAll(c);
      await this.audit.log(me.id, 'member.create', 'user', u.id, null, { role: b.role }, c);
      return { u, s };
    });
    this.sync.applyRealtime(out.s);
    return { id: out.u.id, memberId: out.u.member_id };
  }

  /** Bulk import. Body: {csv: "fullName,phone,email,role,hallCode,designation,password\n..."} (Excel -> Save as CSV) */
  @Post('import') async import(@Me() me: AuthUser, @Body() b: any) {
    const text = str(b.csv, 'csv', 2_000_000)!;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const head = lines.shift()!.split(',').map((h) => h.trim());
    const halls = new Map((await this.db.rows('SELECT id,code FROM halls')).map((h) => [h.code, h.id]));
    const report = { created: 0, skipped: [] as any[] };
    const defaultPw = process.env.IMPORT_DEFAULT_PASSWORD;
    for (const [i, line] of lines.entries()) {
      const cols = line.split(',').map((x) => x.trim()); const r: any = {}; head.forEach((h, k) => (r[h] = cols[k]));
      try {
        const pw = r.password || defaultPw; if (!pw || pw.length < 8) throw new Error('password missing/short');
        const role = oneOf(r.role || 'volunteer', 'role', ROLES);
        const hash = await bcrypt.hash(pw, 10);
        await this.db.tx(async (c) => {
          const u = (await c.query(`INSERT INTO users(member_id,full_name,phone,email,password_hash,status,role_code,designation,hall_id)
            VALUES('PFC-'||lpad(nextval('member_seq')::text,4,'0'),$1,$2,$3,$4,'active',$5,$6,$7) RETURNING id`,
            [str(r.fullName, 'fullName', 120), phoneNorm(r.phone) || null, r.email?.toLowerCase() || null, hash, role, r.designation || null, r.hallCode ? halls.get(r.hallCode) : null])).rows[0];
          await c.query('INSERT INTO user_roles(user_id,role_id,assigned_by) SELECT $1,id,$3 FROM roles WHERE code=$2', [u.id, role, me.id]);
        });
        report.created++;
      } catch (e: any) { report.skipped.push({ line: i + 2, error: e.code === '23505' ? 'duplicate phone/email' : e.message }); }
    }
    const s = await this.db.tx((c) => this.sync.syncAll(c)); this.sync.applyRealtime(s);
    await this.audit.log(me.id, 'member.import', 'user', undefined, null, { created: report.created, skipped: report.skipped.length });
    return report;
  }

  /** Change role / hall / permissions. Room memberships are recomputed in the same transaction. */
  @Patch(':id') async update(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    const out = await this.db.tx(async (c) => {
      const old = (await c.query('SELECT role_code,hall_id,designation,can_publish_emergency,is_vip_coordinator FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old) throw new NotFoundException();
      await this.applyAssignment(c, me.id, id, { role: old.role_code, hallId: old.hall_id, ...b });
      if (b.fullName) await c.query('UPDATE users SET full_name=$2 WHERE id=$1', [id, str(b.fullName, 'fullName', 120)]);
      const s = await this.sync.syncAll(c);
      await this.audit.log(me.id, 'member.update', 'user', id, old, b, c);
      return s;
    });
    this.sync.applyRealtime(out);
    return { ok: true };
  }

  /** Deactivate: kills sessions, push tokens, and ALL room access immediately. */
  @Post(':id/deactivate') async deactivate(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id'); if (id === me.id) throw new BadRequestException('Cannot deactivate yourself');
    const s = await this.db.tx(async (c) => {
      await c.query(`UPDATE users SET status='deactivated', updated_at=now() WHERE id=$1`, [id]);
      await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await c.query('DELETE FROM device_tokens WHERE user_id=$1', [id]);
      await c.query('UPDATE room_members SET removed_at=now() WHERE user_id=$1 AND removed_at IS NULL', [id]);
      await this.audit.log(me.id, 'member.deactivate', 'user', id, null, null, c);
      return (await c.query('SELECT room_id FROM room_members WHERE user_id=$1', [id])).rows;
    });
    s.forEach((r) => this.rt.leaveRoom(id, r.room_id));
    this.rt.server?.in('u:' + id).disconnectSockets(true);
    return { ok: true };
  }

  @Post(':id/reset-password') async reset(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id'); const pw = str(b.newPassword, 'newPassword', 100)!; if (pw.length < 8) throw new BadRequestException('min 8 chars');
    await this.db.q('UPDATE users SET password_hash=$2 WHERE id=$1', [id, await bcrypt.hash(pw, 11)]);
    await this.db.q('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await this.audit.log(me.id, 'member.reset_password', 'user', id);
    return { ok: true };
  }

  @Get('/audit/logs') audits(@Query('limit') limit = '100') {
    return this.db.rows(`SELECT a.id,a.action,a.entity,a.entity_id AS "entityId",a.old_value AS "oldValue",a.new_value AS "newValue",a.created_at AS "createdAt",u.full_name AS actor
      FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT $1`, [Math.min(+limit || 100, 500)]);
  }
}

/** Member directory + profile popup. Contact details are permission-gated on the server. */
@Controller('members')
export class MembersController {
  constructor(private db: Db, private rt: Realtime) {}

  @Get() async search(@Me() me: AuthUser, @Query('q') q = '') {
    const rows = await this.db.rows(`SELECT id, member_id AS "memberId", full_name AS "fullName", designation, role_code AS role, hall_id AS "hallId"
      FROM users WHERE status='active' AND deleted_at IS NULL AND ($1='' OR full_name ILIKE '%'||$1||'%' OR member_id ILIKE '%'||$1||'%') ORDER BY full_name LIMIT 50`, [q.slice(0, 60)]);
    return rows.map((r) => ({ ...r, online: this.rt.isOnline(r.id) }));
  }

  @Get(':id') async profile(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const u = await this.db.one(`SELECT u.*, h.name AS hall_name FROM users u LEFT JOIN halls h ON h.id=u.hall_id WHERE u.id=$1 AND u.status='active' AND u.deleted_at IS NULL`, [id]);
    if (!u) throw new NotFoundException();
    let contact = me.id === id || me.role === 'super_admin' || me.role === 'core_team';
    if (!contact && me.role === 'hall_manager')
      contact = !!(await this.db.one(`SELECT 1 FROM users WHERE id=$1 AND hall_id=$2 UNION
        SELECT 1 FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE ea.user_id=$1 AND e.hall_id=$2 LIMIT 1`, [id, me.hallId]));
    if (!contact && me.role === 'event_manager')
      contact = !!(await this.db.one(`SELECT 1 FROM event_assignments a JOIN event_assignments b ON a.event_id=b.event_id
        WHERE a.user_id=$1 AND a.assignment_role='manager' AND b.user_id=$2 LIMIT 1`, [me.id, id]));
    const events = await this.db.rows(`SELECT e.id, e.title, e.start_time AS "startTime", ea.assignment_role AS "assignmentRole" FROM event_assignments ea JOIN events e ON e.id=ea.event_id
      WHERE ea.user_id=$1 AND e.deleted_at IS NULL ORDER BY e.start_time`, [id]);
    const teams = await this.db.rows('SELECT t.name FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=$1', [id]);
    return { id: u.id, memberId: u.member_id, fullName: u.full_name, photoUrl: u.photo_url, role: u.role_code, designation: u.designation,
      hall: u.hall_name, events, teams: teams.map((t) => t.name), online: this.rt.isOnline(id),
      phone: contact ? u.phone : null, email: contact ? u.email : null, contactVisible: contact };
  }
}
