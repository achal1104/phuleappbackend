import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Audit, AuthUser, Db, Me, Realtime, Roles, date, oneOf, str, uuid, uuids } from '../common/core';
import { Notifier } from '../notifications/notifications';
import { RoomSync } from '../chat/rooms.service';

const STATUSES = ['upcoming', 'ongoing', 'completed', 'postponed', 'cancelled'];
const EV = `e.id, e.hall_id AS "hallId", h.name AS "hallName", e.day_id AS "dayId", d.label AS "dayLabel", e.title, e.description,
  e.technical_requirements AS "technicalRequirements", e.rehearsal_schedule AS "rehearsalSchedule", e.start_time AS "startTime", e.end_time AS "endTime",
  e.seq, e.status, e.progress`;

@Controller()
export class EventsController {
  constructor(private db: Db, private audit: Audit, private sync: RoomSync, private notifier: Notifier, private rt: Realtime) {}

  @Get('halls') halls() { return this.db.rows(`SELECT id, code, name, status FROM halls WHERE deleted_at IS NULL ORDER BY code`); }
  @Get('days') days() { return this.db.rows(`SELECT id, day, label FROM festival_days ORDER BY day`); }

  // ---------- authorization helpers
  private async canManage(me: AuthUser, eventId: string, level: 'full' | 'volunteers' | 'progress') {
    const e = await this.db.one('SELECT hall_id FROM events WHERE id=$1 AND deleted_at IS NULL', [eventId]);
    if (!e) throw new NotFoundException('Event not found');
    if (me.role === 'super_admin') return e;
    if (me.role === 'core_team' && level === 'progress') return e;
    if (me.role === 'hall_manager' && me.hallId === e.hall_id) return e;
    if (me.role === 'event_manager' && level !== 'full') {
      const a = await this.db.one(`SELECT 1 FROM event_assignments WHERE event_id=$1 AND user_id=$2 AND assignment_role='manager'`, [eventId, me.id]);
      if (a) return e;
    }
    throw new ForbiddenException('Not authorised for this event');
  }
  private async canView(me: AuthUser, eventId: string) {
    if (me.rank >= 90) return true;
    const r = await this.db.one(`SELECT 1 FROM events e WHERE e.id=$1 AND e.deleted_at IS NULL AND (
      ((e.hall_id=$3) AND $2 IN ('hall_manager','management')) OR EXISTS(SELECT 1 FROM event_assignments a WHERE a.event_id=e.id AND a.user_id=$4))`, [eventId, me.role, me.hallId, me.id]);
    return !!r;
  }

  // ---------- reads
  @Get('events') async list(@Me() me: AuthUser, @Query('hallId') hallId?: string, @Query('dayId') dayId?: string) {
    return this.db.rows(`SELECT ${EV},
        (SELECT u.full_name FROM event_assignments a JOIN users u ON u.id=a.user_id WHERE a.event_id=e.id AND a.assignment_role='manager' LIMIT 1) AS "managerName",
        (SELECT count(*)::int FROM event_assignments a WHERE a.event_id=e.id AND a.assignment_role='volunteer') AS "volunteerCount",
        (SELECT r.id FROM rooms r JOIN room_members m ON m.room_id=r.id AND m.user_id=$1 AND m.removed_at IS NULL WHERE r.event_id=e.id) AS "roomId"
      FROM events e JOIN halls h ON h.id=e.hall_id JOIN festival_days d ON d.id=e.day_id
      WHERE e.deleted_at IS NULL AND ($2::int IS NULL OR e.hall_id=$2) AND ($3::int IS NULL OR e.day_id=$3)
        AND ( $4 IN ('super_admin','core_team') OR (e.hall_id=$5 AND $4 IN ('hall_manager','management'))
              OR EXISTS(SELECT 1 FROM event_assignments a WHERE a.event_id=e.id AND a.user_id=$1))
      ORDER BY d.day, e.hall_id, e.seq, e.start_time`, [me.id, hallId ? +hallId : null, dayId ? +dayId : null, me.role, me.hallId]);
  }

  @Get('events/:id') async get(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id'); if (!(await this.canView(me, id))) throw new ForbiddenException('Not authorised for this event');
    const e = await this.db.one(`SELECT ${EV} FROM events e JOIN halls h ON h.id=e.hall_id JOIN festival_days d ON d.id=e.day_id WHERE e.id=$1`, [id]);
    const people = await this.db.rows(`SELECT u.id, u.full_name AS "fullName", u.member_id AS "memberId", a.assignment_role AS "assignmentRole" FROM event_assignments a JOIN users u ON u.id=a.user_id WHERE a.event_id=$1 ORDER BY a.assignment_role, u.full_name`, [id]);
    const room = await this.db.one(`SELECT r.id FROM rooms r JOIN room_members m ON m.room_id=r.id AND m.user_id=$2 AND m.removed_at IS NULL WHERE r.event_id=$1`, [id, me.id]);
    return { ...e, assignments: people, roomId: room?.id ?? null };
  }

  // ---------- create (auto-creates private room + membership)
  @Post('events') @Roles('super_admin', 'hall_manager')
  async create(@Me() me: AuthUser, @Body() b: any) {
    const hallId = Number(b.hallId), dayId = Number(b.dayId);
    if (me.role === 'hall_manager' && me.hallId !== hallId) throw new ForbiddenException('You can only create events in your own hall');
    const title = str(b.title, 'title', 200)!; const start = date(b.startTime, 'startTime'), end = date(b.endTime, 'endTime');
    if (end <= start) throw new BadRequestException('endTime must be after startTime');
    const managerId = b.managerId ? uuid(b.managerId, 'managerId') : null; const vols = uuids(b.volunteerIds, 'volunteerIds');
    const out = await this.db.tx(async (c) => {
      const hall = (await c.query('SELECT * FROM halls WHERE id=$1 AND deleted_at IS NULL', [hallId])).rows[0];
      const day = (await c.query('SELECT * FROM festival_days WHERE id=$1', [dayId])).rows[0];
      if (!hall || !day) throw new BadRequestException('Unknown hall or day');
      const seq = (await c.query('SELECT COALESCE(max(seq),0)+1 AS n FROM events WHERE hall_id=$1 AND day_id=$2 AND deleted_at IS NULL', [hallId, dayId])).rows[0].n;
      const ev = (await c.query(`INSERT INTO events(hall_id,day_id,title,description,technical_requirements,rehearsal_schedule,start_time,end_time,seq,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [hallId, dayId, title, b.description ?? null, b.technicalRequirements ?? null, b.rehearsalSchedule ?? null, start, end, seq, me.id])).rows[0];
      const all = [...(managerId ? [[managerId, 'manager']] : []), ...vols.filter((v) => v !== managerId).map((v) => [v, 'volunteer'])];
      for (const [uid, role] of all) {
        const ok = (await c.query(`SELECT 1 FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL`, [uid])).rowCount;
        if (!ok) throw new BadRequestException(`User ${uid} is not an active member`);
        await c.query('INSERT INTO event_assignments(event_id,user_id,assignment_role,assigned_by) VALUES($1,$2,$3,$4)', [ev.id, uid, role, me.id]);
      }
      const room = (await c.query(`INSERT INTO rooms(type,name,hall_id,day_id,event_id,created_by) VALUES('event',$1,$2,$3,$4,$5) RETURNING id`,
        [`${hall.name} → ${day.label} → ${title}`, hallId, dayId, ev.id, me.id])).rows[0];
      await c.query(`INSERT INTO messages(room_id,sender_id,body,kind) VALUES($1,$2,$3,'system')`, [room.id, me.id, `Room created for "${title}"`]);
      const s1 = await this.sync.syncRoom(c, room.id); const s2 = await this.sync.syncHallDay(c, hallId, dayId);
      await this.audit.log(me.id, 'event.create', 'event', ev.id, null, { title, hallId, dayId, start, end }, c);
      return { eventId: ev.id, roomId: room.id, syncs: [s1, s2], assignees: all.map((a) => a[0]), title };
    });
    this.sync.applyRealtime(out.syncs);
    await this.notifier.send(out.assignees.filter((u) => u !== me.id), { type: 'room_assignment', title: 'New event assignment', body: out.title, deepLink: `/rooms/${out.roomId}`, data: { eventId: out.eventId, roomId: out.roomId } });
    this.rt.server?.emit('event:created', { eventId: out.eventId, hallId, dayId });
    return { id: out.eventId, roomId: out.roomId };
  }

  // ---------- edit (timing/status/details) with old/new audit + notifications
  @Patch('events/:id') @Roles('super_admin', 'hall_manager')
  async update(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id'); await this.canManage(me, id, 'full');
    const out = await this.db.tx(async (c) => {
      const old = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [id])).rows[0];
      const start = b.startTime ? date(b.startTime, 'startTime') : old.start_time; const end = b.endTime ? date(b.endTime, 'endTime') : old.end_time;
      if (end <= start) throw new BadRequestException('endTime must be after startTime');
      const status = b.status ? oneOf(b.status, 'status', STATUSES) : old.status;
      const title = b.title ? str(b.title, 'title', 200)! : old.title;
      await c.query(`UPDATE events SET title=$2, description=COALESCE($3,description), technical_requirements=COALESCE($4,technical_requirements),
        rehearsal_schedule=COALESCE($5,rehearsal_schedule), start_time=$6, end_time=$7, status=$8, updated_at=now() WHERE id=$1`,
        [id, title, b.description ?? null, b.technicalRequirements ?? null, b.rehearsalSchedule ?? null, start, end, status]);
      const timingChanged = +new Date(old.start_time) !== +start || +new Date(old.end_time) !== +end;
      const statusChanged = old.status !== status;
      const room = (await c.query(`SELECT id FROM rooms WHERE event_id=$1`, [id])).rows[0];
      if (title !== old.title) await c.query(`UPDATE rooms r SET name = h.name || ' → ' || d.label || ' → ' || $2 FROM halls h, festival_days d WHERE r.id=$1 AND h.id=r.hall_id AND d.id=r.day_id`, [room.id, title]);
      const msgs: string[] = [];
      if (timingChanged) msgs.push(`Timing changed: ${new Date(old.start_time).toISOString()}–${new Date(old.end_time).toISOString()} → ${start.toISOString()}–${end.toISOString()}`);
      if (statusChanged) msgs.push(`Status: ${old.status} → ${status}`);
      for (const m of msgs) await c.query(`INSERT INTO messages(room_id,sender_id,body,kind) VALUES($1,$2,$3,'system')`, [room.id, me.id, m]);
      await this.audit.log(me.id, timingChanged ? 'event.timing_change' : 'event.update', 'event', id,
        { title: old.title, start: old.start_time, end: old.end_time, status: old.status }, { title, start, end, status }, c);
      // affected = this event's people + people of subsequent events in same hall/day
      const affected = (await c.query(`SELECT DISTINCT ea.user_id FROM event_assignments ea JOIN events e ON e.id=ea.event_id
        WHERE e.deleted_at IS NULL AND e.hall_id=$1 AND e.day_id=$2 AND (e.id=$3 OR ($4 AND e.seq > $5))`,
        [old.hall_id, old.day_id, id, timingChanged || status === 'postponed' || status === 'cancelled', old.seq])).rows.map((r) => r.user_id);
      return { roomId: room.id, old, title, timingChanged, statusChanged, affected, start, end, status, hallDay: await this.hallDayRoom(c, old.hall_id, old.day_id) };
    });
    if (out.timingChanged || out.statusChanged) {
      await this.notifier.send(out.affected.filter((u) => u !== me.id), {
        type: 'event_update', title: out.timingChanged ? 'Event schedule updated' : `Event ${out.status}`,
        body: `${out.title}${out.timingChanged ? ' – new time ' + out.start.toISOString() : ''}`, deepLink: `/rooms/${out.roomId}`, data: { eventId: id } });
    }
    const payload = { eventId: id, title: out.title, startTime: out.start, endTime: out.end, status: out.status };
    this.rt.toRoom(out.roomId, 'event:updated', payload); if (out.hallDay) this.rt.toRoom(out.hallDay, 'event:updated', payload);
    return { ok: true, notified: out.affected.length };
  }
  private async hallDayRoom(c: any, hallId: number, dayId: number) {
    return (await c.query(`SELECT id FROM rooms WHERE type='hall_day' AND hall_id=$1 AND day_id=$2`, [hallId, dayId])).rows[0]?.id;
  }

  // ---------- assignments (revokes room access immediately for removed users)
  @Put('events/:id/assignments') @Roles('super_admin', 'hall_manager', 'event_manager')
  async assign(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id'); const ev = await this.canManage(me, id, me.role === 'event_manager' ? 'volunteers' : 'full');
    const vols = uuids(b.volunteerIds, 'volunteerIds');
    const managerSpecified = me.role !== 'event_manager' && b.managerId !== undefined;
    const managerId = b.managerId ? uuid(b.managerId, 'managerId') : null;
    const out = await this.db.tx(async (c) => {
      const cur = (await c.query('SELECT user_id, assignment_role FROM event_assignments WHERE event_id=$1 FOR UPDATE', [id])).rows;
      const curMgr = cur.find((x) => x.assignment_role === 'manager')?.user_id ?? null;
      const wantMgr = managerSpecified ? managerId : curMgr;
      const want = new Map<string, string>(); vols.forEach((v) => want.set(v, 'volunteer')); if (wantMgr) want.set(wantMgr, 'manager');
      const removed = cur.filter((x) => !want.has(x.user_id)).map((x) => x.user_id);
      const added = [...want.keys()].filter((u) => !cur.some((x) => x.user_id === u));
      for (const u of added) {
        if (!(await c.query(`SELECT 1 FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL`, [u])).rowCount) throw new BadRequestException(`User ${u} is not an active member`);
      }
      await c.query('DELETE FROM event_assignments WHERE event_id=$1 AND user_id = ANY($2::uuid[])', [id, removed]);
      for (const [u, role] of want) await c.query(`INSERT INTO event_assignments(event_id,user_id,assignment_role,assigned_by) VALUES($1,$2,$3,$4)
        ON CONFLICT (event_id,user_id) DO UPDATE SET assignment_role=$3`, [id, u, role, me.id]);
      const room = (await c.query('SELECT id, name FROM rooms WHERE event_id=$1', [id])).rows[0];
      const s1 = await this.sync.syncRoom(c, room.id); const s2 = await this.sync.syncHallDay(c, ev.hall_id, (await c.query('SELECT day_id FROM events WHERE id=$1', [id])).rows[0].day_id);
      await this.audit.log(me.id, 'event.assignments', 'event', id, { users: cur.map((x) => x.user_id) }, { users: [...want.keys()], added, removed }, c);
      return { room, added, removed, syncs: [s1, s2] };
    });
    this.sync.applyRealtime(out.syncs);
    await this.notifier.send(out.added.filter((u) => u !== me.id), { type: 'room_assignment', title: 'New event assignment', body: out.room.name, deepLink: `/rooms/${out.room.id}` });
    await this.notifier.send(out.removed, { type: 'assignment_removed', title: 'Assignment removed', body: out.room.name }, { push: true });
    this.rt.toUsers(out.removed, 'assignment:changed', { eventId: id });
    return { ok: true, added: out.added.length, removed: out.removed.length };
  }

  // ---------- progress (event manager)
  @Patch('events/:id/progress') @Roles('super_admin', 'core_team', 'hall_manager', 'event_manager')
  async progress(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id'); await this.canManage(me, id, 'progress');
    const p = Number(b.progress); if (!(p >= 0 && p <= 100)) throw new BadRequestException('progress 0-100');
    const status = b.status ? oneOf(b.status, 'status', STATUSES) : null;
    const e = await this.db.one(`UPDATE events SET progress=$2, status=COALESCE($3,status), updated_at=now() WHERE id=$1 RETURNING title, status, hall_id`, [id, p, status]);
    await this.audit.log(me.id, 'event.progress', 'event', id, null, { progress: p, status });
    this.rt.server?.emit('event:updated', { eventId: id, progress: p, status: e.status });
    return { ok: true };
  }

  // ---------- cancel / delete (explicit confirmation required, audited)
  @Post('events/:id/cancel') @Roles('super_admin', 'hall_manager')
  async cancel(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id'); await this.canManage(me, id, 'full');
    if (b.confirm !== true) throw new BadRequestException('confirm=true required');
    const r = await this.db.tx(async (c) => {
      const e = (await c.query(`UPDATE events SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING title, hall_id, day_id`, [id])).rows[0];
      const room = (await c.query('SELECT id FROM rooms WHERE event_id=$1', [id])).rows[0];
      await c.query(`INSERT INTO messages(room_id,sender_id,body,kind) VALUES($1,$2,$3,'system')`, [room.id, me.id, `Event cancelled${b.reason ? ': ' + b.reason : ''}`]);
      await this.audit.log(me.id, 'event.cancel', 'event', id, null, { reason: b.reason }, c);
      return { e, room, users: (await c.query('SELECT user_id FROM event_assignments WHERE event_id=$1', [id])).rows.map((x) => x.user_id) };
    });
    await this.notifier.send(r.users, { type: 'event_update', title: 'Event cancelled', body: r.e.title, deepLink: `/rooms/${r.room.id}` });
    this.rt.server?.emit('event:updated', { eventId: id, status: 'cancelled' });
    return { ok: true };
  }

  @Delete('events/:id') @Roles('super_admin')
  async remove(@Me() me: AuthUser, @Param('id') id: string, @Query('confirm') confirm?: string) {
    uuid(id, 'id'); if (confirm !== 'true') throw new BadRequestException('confirm=true required');
    const out = await this.db.tx(async (c) => {
      const e = (await c.query('UPDATE events SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING hall_id, day_id, title', [id])).rows[0];
      if (!e) throw new NotFoundException();
      const room = (await c.query(`UPDATE rooms SET closed_at=now() WHERE event_id=$1 RETURNING id`, [id])).rows[0];
      await c.query('UPDATE room_members SET removed_at=now() WHERE room_id=$1 AND removed_at IS NULL', [room.id]);
      const s = await this.sync.syncHallDay(c, e.hall_id, e.day_id);
      await this.audit.log(me.id, 'event.delete', 'event', id, e, null, c);
      return { s, roomId: room.id };
    });
    this.sync.applyRealtime([out.s]); this.rt.server?.in('r:' + out.roomId).socketsLeave('r:' + out.roomId);
    return { ok: true };
  }

  // ---------- drag & drop ordering
  @Put('events/reorder') @Roles('super_admin', 'hall_manager')
  async reorder(@Me() me: AuthUser, @Body() b: any) {
    const hallId = Number(b.hallId), dayId = Number(b.dayId); const ids = uuids(b.orderedIds, 'orderedIds');
    if (me.role === 'hall_manager' && me.hallId !== hallId) throw new ForbiddenException();
    await this.db.tx(async (c) => {
      const have = (await c.query('SELECT id FROM events WHERE hall_id=$1 AND day_id=$2 AND deleted_at IS NULL', [hallId, dayId])).rows.map((r) => r.id);
      if (have.length !== ids.length || !ids.every((i) => have.includes(i))) throw new BadRequestException('orderedIds must list every event of that hall/day');
      for (const [i, id] of ids.entries()) await c.query('UPDATE events SET seq=$2 WHERE id=$1', [id, i + 1]);
      await this.audit.log(me.id, 'event.reorder', 'hall_day', `${hallId}/${dayId}`, null, { ids }, c);
    });
    this.rt.server?.emit('event:updated', { hallId, dayId, reordered: true });
    return { ok: true };
  }
}
