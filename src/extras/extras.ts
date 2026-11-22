import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Audit, AuthUser, Db, Me, Public, Realtime, Roles, oneOf, phoneNorm, str, uuid } from '../common/core';
import { Notifier } from '../notifications/notifications';

// =====================================================================  FORGOT PASSWORD (admin-assisted – no SMS gateway needed)
@Controller()
export class PasswordResetController {
  constructor(private db: Db, private audit: Audit, private notifier: Notifier) {}

  /** Public. Always answers the same way so it cannot be used to discover which numbers are registered. */
  @Public() @Throttle({ default: { limit: 20, ttl: 60000 } }) @Post('auth/forgot')
  async forgot(@Body() b: any) {
    const id = str(b.identifier, 'identifier', 160)!;
    const key = id.includes('@') ? id.toLowerCase() : phoneNorm(id);
    const u = await this.db.one(`SELECT id, full_name, member_id FROM users WHERE ${id.includes('@') ? 'email' : 'phone'}=$1 AND status='active' AND deleted_at IS NULL`, [key]);
    if (u) {
      const r = await this.db.q(`INSERT INTO password_reset_requests(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [u.id]);
      if (r.rowCount) {
        const admins = (await this.db.rows(`SELECT id FROM users WHERE role_code IN ('super_admin','core_team') AND status='active'`)).map((x) => x.id);
        await this.notifier.send(admins, { type: 'announcement', title: 'Password reset requested', body: `${u.full_name} (${u.member_id})`, deepLink: '/admin/reset-requests' });
      }
    }
    return { ok: true, message: 'If this account exists, the festival control team has been asked to issue a temporary password. Please contact them to receive it.' };
  }

  @Get('admin/reset-requests') @Roles('super_admin', 'core_team')
  list() { return this.db.rows(`SELECT r.id, r.status, r.created_at AS "createdAt", u.full_name AS name, u.member_id AS "memberId", u.phone FROM password_reset_requests r JOIN users u ON u.id=r.user_id WHERE r.status='open' ORDER BY r.created_at`); }

  /** Generates a one-time temporary password, kills all existing sessions, returns it ONCE to the admin to hand to the member. */
  @Post('admin/reset-requests/:id/issue') @Roles('super_admin', 'core_team')
  async issue(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const temp = crypto.randomBytes(6).toString('base64url') + '#' + crypto.randomInt(10, 99);
    const hash = await bcrypt.hash(temp, 11);
    const row = await this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE password_reset_requests SET status='done', handled_by=$2, handled_at=now() WHERE id=$1 AND status='open' RETURNING user_id`, [id, me.id])).rows[0];
      if (!r) throw new NotFoundException('Request not found or already handled');
      await c.query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [r.user_id, hash]);
      await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [r.user_id]);
      await this.audit.log(me.id, 'auth.password_reset_issued', 'user', r.user_id, null, null, c);
      return r;
    });
    return { userId: row.user_id, temporaryPassword: temp, note: 'Share this privately. The member should change it after login.' };
  }
}

// =====================================================================  SHIFT HANDOVER
@Controller('handovers')
export class HandoverController {
  constructor(private db: Db, private audit: Audit, private notifier: Notifier, private rt: Realtime) {}

  @Get() list(@Me() me: AuthUser) {
    return this.db.rows(`SELECT s.id, s.notes, s.checklist, s.status, s.created_at AS "createdAt", s.accepted_at AS "acceptedAt", h.name AS hall, e.title AS event,
        json_build_object('id',f.id,'name',f.full_name) AS "from", json_build_object('id',t.id,'name',t.full_name) AS "to"
      FROM shift_handovers s JOIN users f ON f.id=s.from_user JOIN users t ON t.id=s.to_user LEFT JOIN halls h ON h.id=s.hall_id LEFT JOIN events e ON e.id=s.event_id
      WHERE s.from_user=$1 OR s.to_user=$1 OR $2 >= 90 OR ($2 >= 70 AND s.hall_id=$3) ORDER BY s.created_at DESC LIMIT 200`, [me.id, me.rank, me.hallId]);
  }

  @Post() async create(@Me() me: AuthUser, @Body() b: any) {
    if (me.rank < 40) throw new ForbiddenException('Handover is for management members and above');
    const to = uuid(b.toUserId, 'toUserId');
    if (to === me.id) throw new BadRequestException('Cannot hand over to yourself');
    const target = await this.db.one(`SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL`, [to]);
    if (!target) throw new NotFoundException('Recipient not found');
    const list = Array.isArray(b.checklist) ? b.checklist.slice(0, 40).map((x: any) => ({ text: String(x?.text ?? x).slice(0, 200), done: !!x?.done })) : [];
    const r = await this.db.one(`INSERT INTO shift_handovers(hall_id,event_id,from_user,to_user,notes,checklist) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.hallId ? Number(b.hallId) : me.hallId, b.eventId ? uuid(b.eventId, 'eventId') : null, me.id, to, str(b.notes, 'notes', 4000)!, JSON.stringify(list)]);
    await this.audit.log(me.id, 'handover.create', 'handover', r.id, null, { to });
    await this.notifier.send([to], { type: 'assignment', title: 'Shift handover received', body: `${me.name} handed over responsibilities`, deepLink: '/handovers' });
    this.rt.toUser(to, 'handover:new', { id: r.id });
    return r;
  }

  @Post(':id/accept') async accept(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.one(`UPDATE shift_handovers SET status='accepted', accepted_at=now() WHERE id=$1 AND to_user=$2 AND status='pending' RETURNING from_user`, [id, me.id]);
    if (!r) throw new NotFoundException('Nothing to accept');
    await this.audit.log(me.id, 'handover.accept', 'handover', id);
    await this.notifier.send([r.from_user], { type: 'assignment', title: 'Handover accepted', body: `${me.name} accepted your handover`, deepLink: '/handovers' });
    return { ok: true };
  }
}

// =====================================================================  LOST & FOUND
@Controller('lost-found')
export class LostFoundController {
  constructor(private db: Db, private audit: Audit) {}
  private SEL = `l.id,l.kind,l.item,l.description,l.location,l.photo_key AS "photoKey",l.status,l.claimed_by_name AS "claimedByName",l.resolution_notes AS "resolutionNotes",
    l.created_at AS "createdAt",l.resolved_at AS "resolvedAt",h.name AS hall,u.full_name AS "reportedBy"`;

  @Get() list(@Query('status') status?: string) {
    return this.db.rows(`SELECT ${this.SEL} FROM lost_found l LEFT JOIN halls h ON h.id=l.hall_id JOIN users u ON u.id=l.reported_by
      WHERE ($1::text IS NULL OR l.status=$1) ORDER BY (l.status='open') DESC, l.created_at DESC LIMIT 300`, [status ?? null]);
  }
  @Post() async create(@Me() me: AuthUser, @Body() b: any) {
    const r = await this.db.one(`INSERT INTO lost_found(kind,item,description,location,hall_id,photo_key,reported_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [oneOf(b.kind, 'kind', ['lost', 'found']), str(b.item, 'item', 200), str(b.description, 'description', 2000, false), str(b.location, 'location', 200, false),
        b.hallId ? Number(b.hallId) : me.hallId, str(b.photoKey, 'photoKey', 200, false), me.id]);
    await this.audit.log(me.id, 'lostfound.create', 'lost_found', r.id, null, { kind: b.kind, item: b.item });
    return r;
  }
  /** Only management (rank>=40) closes cases – volunteers report, managers hand items back. */
  @Patch(':id') async resolve(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    if (me.rank < 40) throw new ForbiddenException('Only management members can resolve a case');
    const status = oneOf(b.status, 'status', ['claimed', 'closed']);
    const r = await this.db.q(`UPDATE lost_found SET status=$2, claimed_by_name=$3, resolution_notes=$4, resolved_by=$5, resolved_at=now() WHERE id=$1 AND status='open'`,
      [id, status, str(b.claimedByName, 'claimedByName', 150, false), str(b.resolutionNotes, 'resolutionNotes', 1000, false), me.id]);
    if (!r.rowCount) throw new NotFoundException('Case not found or already resolved');
    await this.audit.log(me.id, 'lostfound.' + status, 'lost_found', id);
    return { ok: true };
  }
}

// =====================================================================  FEEDBACK & CLOSING REPORT
@Controller('feedback')
export class FeedbackController {
  constructor(private db: Db, private audit: Audit) {}
  @Post() async submit(@Me() me: AuthUser, @Body() b: any) {
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('rating must be 1-5');
    const r = await this.db.one(`INSERT INTO feedback(user_id,hall_id,rating,category,message) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [me.id, me.hallId, rating, oneOf(b.category ?? 'general', 'category', ['general', 'operations', 'communication', 'safety', 'suggestion']), str(b.message, 'message', 3000, false)]);
    return r;
  }
  @Get() @Roles('super_admin', 'core_team') list() {
    return this.db.rows(`SELECT f.id,f.rating,f.category,f.message,f.created_at AS "createdAt",u.full_name AS name,h.name AS hall FROM feedback f JOIN users u ON u.id=f.user_id LEFT JOIN halls h ON h.id=f.hall_id ORDER BY f.created_at DESC LIMIT 500`);
  }
  @Get('summary') @Roles('super_admin', 'core_team') summary() {
    return this.db.rows(`SELECT COALESCE(h.name,'—') AS hall, f.category, count(*)::int AS responses, round(avg(f.rating),2)::float AS avg_rating FROM feedback f LEFT JOIN halls h ON h.id=f.hall_id GROUP BY h.name,f.category ORDER BY h.name,f.category`);
  }
  /** Single-call closing report: everything the organisers need after 29 Nov. */
  @Get('closing-report') @Roles('super_admin', 'core_team') async closing() {
    const one = (s: string) => this.db.one(s);
    const [totals, byHall, feedback] = await Promise.all([
      one(`SELECT (SELECT count(*) FROM users WHERE status='active')::int AS members,
        (SELECT count(*) FROM events WHERE deleted_at IS NULL)::int AS events, (SELECT count(*) FROM events WHERE deleted_at IS NULL AND status='completed')::int AS events_completed,
        (SELECT count(*) FROM tasks WHERE deleted_at IS NULL)::int AS tasks, (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND status='verified')::int AS tasks_verified,
        (SELECT count(*) FROM attendance)::int AS check_ins, (SELECT count(*) FROM incidents)::int AS incidents, (SELECT count(*) FROM incidents WHERE status='resolved')::int AS incidents_resolved,
        (SELECT count(*) FROM emergency_alerts)::int AS emergencies, (SELECT count(*) FROM messages)::int AS messages,
        (SELECT count(*) FROM lost_found WHERE status='open')::int AS lost_found_open`),
      this.db.rows(`SELECT h.name AS hall, (SELECT count(*) FROM events e WHERE e.hall_id=h.id AND e.deleted_at IS NULL)::int AS events,
        (SELECT count(*) FROM tasks t WHERE t.hall_id=h.id AND t.deleted_at IS NULL AND t.status IN ('completed','verified'))::int AS tasks_done,
        (SELECT count(*) FROM incidents i WHERE i.hall_id=h.id)::int AS incidents FROM halls h ORDER BY h.name`),
      one(`SELECT count(*)::int AS responses, COALESCE(round(avg(rating),2),0)::float AS avg_rating FROM feedback`),
    ]);
    return { totals, byHall, feedback };
  }
}

// =====================================================================  GLOBAL SEARCH (everything is permission-filtered)
@Controller('search')
export class SearchController {
  constructor(private db: Db) {}
  @Get() async search(@Me() me: AuthUser, @Query('q') q?: string) {
    const s = (q ?? '').trim();
    if (s.length < 2) throw new BadRequestException('Type at least 2 characters');
    const like = '%' + s.replace(/[%_\\]/g, '\\$&') + '%';
    const [members, events, rooms, tasks] = await Promise.all([
      this.db.rows(`SELECT id, full_name AS name, designation, role_code AS role FROM users WHERE status='active' AND deleted_at IS NULL AND (full_name ILIKE $1 OR designation ILIKE $1 OR member_id ILIKE $1) ORDER BY full_name LIMIT 15`, [like]),
      this.db.rows(`SELECT e.id, e.title, h.name AS hall, e.start_time AS "startTime" FROM events e JOIN halls h ON h.id=e.hall_id WHERE e.deleted_at IS NULL AND e.title ILIKE $1 ORDER BY e.start_time LIMIT 15`, [like]),
      this.db.rows(`SELECT r.id, r.name, r.type FROM rooms r JOIN room_members m ON m.room_id=r.id AND m.user_id=$2 AND m.removed_at IS NULL WHERE r.type<>'direct' AND r.closed_at IS NULL AND r.name ILIKE $1 ORDER BY r.name LIMIT 15`, [like, me.id]),
      this.db.rows(`SELECT t.id, t.title, t.status FROM tasks t WHERE t.deleted_at IS NULL AND t.title ILIKE $1
        AND (EXISTS(SELECT 1 FROM task_assignments x WHERE x.task_id=t.id AND x.user_id=$2) OR $3 >= 90 OR ($3 >= 60 AND (t.hall_id=$4 OR t.created_by=$2))) ORDER BY t.created_at DESC LIMIT 15`, [like, me.id, me.rank, me.hallId]),
    ]);
    return { members, events, rooms, tasks };
  }
}

// =====================================================================  EMERGENCY CONTACT DIRECTORY (all active members can read; only admins edit)
@Controller('emergency-contacts')
export class EmergencyContactsController {
  constructor(private db: Db, private audit: Audit) {}
  @Get() list() {
    return this.db.rows(`SELECT c.id,c.category,c.name,c.phone,c.notes,h.name AS hall FROM emergency_contacts c LEFT JOIN halls h ON h.id=c.hall_id WHERE c.deleted_at IS NULL ORDER BY c.category, c.sort_order, c.name`);
  }
  @Post() @Roles('super_admin', 'core_team') async add(@Me() me: AuthUser, @Body() b: any) {
    const phone = phoneNorm(str(b.phone, 'phone', 20)!)!;
    if (!/^\+?\d{3,15}$/.test(phone)) throw new BadRequestException('phone invalid');
    const r = await this.db.one(`INSERT INTO emergency_contacts(category,name,phone,notes,hall_id,sort_order,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [oneOf(b.category, 'category', ['medical', 'fire', 'venue', 'security', 'festival', 'police', 'other']), str(b.name, 'name', 150), phone, str(b.notes, 'notes', 500, false), b.hallId ? Number(b.hallId) : null, Number(b.sortOrder) || 0, me.id]);
    await this.audit.log(me.id, 'contact.add', 'emergency_contact', r.id, null, { name: b.name });
    return r;
  }
  @Delete(':id') @Roles('super_admin', 'core_team') async del(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q('UPDATE emergency_contacts SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!r.rowCount) throw new NotFoundException();
    await this.audit.log(me.id, 'contact.delete', 'emergency_contact', id); return { ok: true };
  }
}

// =====================================================================  ANNOUNCEMENTS (global / per hall, pinnable)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private db: Db, private audit: Audit, private notifier: Notifier) {}
  @Get() list(@Me() me: AuthUser) {
    return this.db.rows(`SELECT a.id,a.title,a.body,a.pinned,a.created_at AS "createdAt",u.full_name AS "issuedBy",h.name AS hall
      FROM announcements a JOIN users u ON u.id=a.created_by LEFT JOIN halls h ON h.id=a.target_hall_id
      WHERE a.deleted_at IS NULL AND (a.target_hall_id IS NULL OR $1 >= 90 OR a.target_hall_id=$2 OR EXISTS(
        SELECT 1 FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE ea.user_id=$3 AND e.hall_id=a.target_hall_id AND e.deleted_at IS NULL))
      ORDER BY a.pinned DESC, a.created_at DESC LIMIT 100`, [me.rank, me.hallId, me.id]);
  }
  @Post() @Roles('super_admin', 'core_team', 'hall_manager') async create(@Me() me: AuthUser, @Body() b: any) {
    let hallId: number | null = b.hallId ? Number(b.hallId) : null;
    if (me.role === 'hall_manager') hallId = me.hallId; // hall managers can only address their own hall
    const r = await this.db.one(`INSERT INTO announcements(title,body,pinned,target_hall_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [str(b.title, 'title', 150), str(b.body, 'body', 3000), !!b.pinned && me.rank >= 90, hallId, me.id]);
    const ids = (await this.db.rows(`SELECT id FROM users WHERE status='active' AND deleted_at IS NULL AND id<>$2 AND ($1::int IS NULL OR hall_id=$1 OR role_code IN ('super_admin','core_team')
      OR id IN (SELECT ea.user_id FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE e.hall_id=$1))`, [hallId, me.id])).map((x) => x.id);
    await this.audit.log(me.id, 'announcement.create', 'announcement', r.id, null, { title: b.title, hallId, recipients: ids.length });
    await this.notifier.send(ids, { type: 'announcement', title: String(b.title).slice(0, 100), body: String(b.body).slice(0, 140), deepLink: '/announcements' });
    return { id: r.id, recipients: ids.length };
  }
  @Patch(':id/pin') @Roles('super_admin', 'core_team') async pin(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q('UPDATE announcements SET pinned=NOT pinned WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!r.rowCount) throw new NotFoundException(); await this.audit.log(me.id, 'announcement.pin', 'announcement', id); return { ok: true };
  }
  @Delete(':id') @Roles('super_admin', 'core_team') async del(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q('UPDATE announcements SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!r.rowCount) throw new NotFoundException(); await this.audit.log(me.id, 'announcement.delete', 'announcement', id); return { ok: true };
  }
}
