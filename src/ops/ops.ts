import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import * as crypto from 'crypto';
import { Audit, AuthUser, Db, Me, Realtime, Roles, date, oneOf, str, uuid, uuids } from '../common/core';
import { Notifier } from '../notifications/notifications';
import { tablePdf } from '../common/pdf';

const csvCell = (v: any) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows: any[]) => { if (!rows.length) return ''; const k = Object.keys(rows[0]); return [k.join(','), ...rows.map((r) => k.map((x) => csvCell(r[x])).join(','))].join('\n'); };
const sendCsv = (res: any, name: string, rows: any[]) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`); res.send(toCsv(rows)); };

// =====================================================================  TASKS
const NEXT: Record<string, string[]> = { assigned: ['accepted'], accepted: ['in_progress', 'completed'], in_progress: ['completed'], completed: ['verified', 'in_progress'] };

@Injectable()
export class TaskSweeper implements OnModuleInit, OnModuleDestroy {
  private t: NodeJS.Timeout;
  constructor(private db: Db, private notifier: Notifier) {}
  onModuleInit() { this.t = setInterval(() => this.sweep().catch((e) => console.error('task sweep', e)), Number(process.env.TASK_SWEEP_MS || 60000)); }
  onModuleDestroy() { clearInterval(this.t); }
  /** overdue tasks: notify assignees once, then escalate to the hall manager (or core team) once. */
  async sweep() {
    const rows = await this.db.rows(`UPDATE tasks SET overdue_notified_at=now() WHERE deleted_at IS NULL AND deadline < now() AND overdue_notified_at IS NULL
      AND status IN ('assigned','accepted','in_progress') RETURNING id,title,hall_id`);
    for (const t of rows) {
      const as = (await this.db.rows('SELECT user_id FROM task_assignments WHERE task_id=$1', [t.id])).map((r) => r.user_id);
      await this.notifier.send(as, { type: 'task_deadline', title: 'Task overdue', body: t.title, deepLink: `/tasks/${t.id}` });
      const mg = (await this.db.rows(`SELECT id FROM users WHERE status='active' AND ((role_code='hall_manager' AND hall_id=$1) OR role_code='core_team')`, [t.hall_id])).map((r) => r.id);
      await this.notifier.send(mg, { type: 'task_deadline', title: 'Escalation: overdue task', body: t.title, deepLink: `/tasks/${t.id}` });
      await this.db.q('UPDATE tasks SET escalated_at=now() WHERE id=$1', [t.id]);
    }
  }
}

@Controller('tasks')
export class TasksController {
  constructor(private db: Db, private audit: Audit, private notifier: Notifier, private rt: Realtime) {}
  private SEL = `t.id,t.title,t.description,t.priority,t.deadline,t.status,t.completion_notes AS "completionNotes",t.attachment_key AS "attachmentKey",t.hall_id AS "hallId",t.event_id AS "eventId",
    t.created_at AS "createdAt",(t.deadline < now() AND t.status IN ('assigned','accepted','in_progress')) AS overdue,
    COALESCE((SELECT json_agg(json_build_object('id',u.id,'name',u.full_name)) FROM task_assignments ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id),'[]') AS assignees`;

  private async canManageTask(me: AuthUser, t: any) {
    if (me.rank >= 90) return true;
    if (me.role === 'hall_manager' && t.hall_id === me.hallId) return true;
    if (t.created_by === me.id && me.rank >= 60) return true;
    return false;
  }

  @Get() list(@Me() me: AuthUser, @Query('mine') mine?: string, @Query('status') status?: string, @Query('hallId') hallId?: string) {
    const scope = mine === 'true' || me.rank < 60;
    return this.db.rows(`SELECT ${this.SEL} FROM tasks t WHERE t.deleted_at IS NULL
      AND ($2::text IS NULL OR t.status=$2) AND ($3::int IS NULL OR t.hall_id=$3)
      AND ( EXISTS(SELECT 1 FROM task_assignments x WHERE x.task_id=t.id AND x.user_id=$1)
        OR (NOT $4 AND ($5 >= 90 OR ($5 >= 60 AND (t.hall_id=$6 OR t.created_by=$1)))) )
      ORDER BY (t.status IN ('verified')), t.deadline NULLS LAST LIMIT 300`, [me.id, status ?? null, hallId ? Number(hallId) : null, scope, me.rank, me.hallId]);
  }

  @Post() @Roles('super_admin', 'core_team', 'hall_manager', 'event_manager') async create(@Me() me: AuthUser, @Body() b: any) {
    const hallId = b.hallId ? Number(b.hallId) : me.hallId;
    if (me.role === 'hall_manager' && hallId !== me.hallId) throw new ForbiddenException('Only your own hall');
    const eventId = b.eventId ? uuid(b.eventId, 'eventId') : null;
    const assignees = uuids(b.assigneeIds, 'assigneeIds');
    if (!assignees.length) throw new BadRequestException('assign at least one member');
    const t = await this.db.tx(async (c) => {
      if (me.role === 'event_manager') {
        if (!eventId) throw new ForbiddenException('Event managers must tie tasks to their event');
        const ok = await c.query(`SELECT 1 FROM event_assignments WHERE event_id=$1 AND user_id=$2 AND assignment_role='manager'`, [eventId, me.id]);
        if (!ok.rowCount) throw new ForbiddenException('Not your event');
      }
      const r = (await c.query(`INSERT INTO tasks(title,description,hall_id,event_id,priority,deadline,attachment_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,title`,
        [str(b.title, 'title', 200), str(b.description, 'description', 4000, false), hallId, eventId, oneOf(b.priority ?? 'normal', 'priority', ['low', 'normal', 'high', 'urgent']),
          b.deadline ? date(b.deadline, 'deadline') : null, str(b.attachmentKey, 'attachmentKey', 200, false), me.id])).rows[0];
      await c.query(`INSERT INTO task_assignments(task_id,user_id) SELECT $1::uuid,u FROM unnest($2::uuid[]) u JOIN users x ON x.id=u AND x.status='active' ON CONFLICT DO NOTHING`, [r.id, assignees]);
      await this.audit.log(me.id, 'task.create', 'task', r.id, null, { title: r.title, assignees: assignees.length }, c);
      return r;
    });
    await this.notifier.send(assignees, { type: 'task_assigned', title: 'New task assigned', body: t.title, deepLink: `/tasks/${t.id}` });
    this.rt.toUsers(assignees, 'task:updated', { id: t.id, status: 'assigned' });
    return t;
  }

  @Patch(':id/status') async status(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    const to = oneOf(b.status, 'status', ['accepted', 'in_progress', 'completed', 'verified']);
    const t = await this.db.one('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!t) throw new NotFoundException();
    const mine = await this.db.one('SELECT 1 FROM task_assignments WHERE task_id=$1 AND user_id=$2', [id, me.id]);
    if (to === 'verified') {
      if (!(await this.canManageTask(me, t))) throw new ForbiddenException('Only a manager can verify');
      if (mine && me.rank < 90) throw new ForbiddenException('You cannot verify your own task');
    } else if (!mine && !(await this.canManageTask(me, t))) throw new ForbiddenException('Not assigned to you');
    if (!(NEXT[t.status] || []).includes(to)) throw new BadRequestException(`Cannot go from ${t.status} to ${to}`);
    if (to === 'completed' && !b.completionNotes && !t.completion_notes) throw new BadRequestException('completionNotes required');
    await this.db.q(`UPDATE tasks SET status=$2, completion_notes=COALESCE($3,completion_notes), verified_by=CASE WHEN $2='verified' THEN $4::uuid END, updated_at=now() WHERE id=$1`,
      [id, to, str(b.completionNotes, 'completionNotes', 2000, false), me.id]);
    await this.audit.log(me.id, 'task.status', 'task', id, { status: t.status }, { status: to });
    const as = (await this.db.rows('SELECT user_id FROM task_assignments WHERE task_id=$1', [id])).map((r) => r.user_id);
    const watchers = [...as, t.created_by].filter(Boolean).filter((x) => x !== me.id);
    this.rt.toUsers(watchers, 'task:updated', { id, status: to });
    if (to === 'completed' && t.created_by) await this.notifier.send([t.created_by], { type: 'task_status', title: 'Task completed – verify', body: t.title, deepLink: `/tasks/${id}` });
    if (to === 'verified') await this.notifier.send(as, { type: 'task_status', title: 'Task verified', body: t.title, deepLink: `/tasks/${id}` });
    return { ok: true, status: to };
  }

  @Delete(':id') @Roles('super_admin', 'core_team', 'hall_manager') async remove(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const t = await this.db.one('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!t) throw new NotFoundException();
    if (!(await this.canManageTask(me, t))) throw new ForbiddenException();
    await this.db.q('UPDATE tasks SET deleted_at=now() WHERE id=$1', [id]);
    await this.audit.log(me.id, 'task.delete', 'task', id, { title: t.title });
    return { ok: true };
  }
}

// =====================================================================  ATTENDANCE / QR
@Controller('attendance')
export class AttendanceController {
  constructor(private db: Db, private audit: Audit, private rt: Realtime) {}

  @Post('qr') @Roles('super_admin', 'core_team', 'hall_manager') async makeQr(@Me() me: AuthUser, @Body() b: any) {
    const hallId = b.hallId ? Number(b.hallId) : null;
    if (me.role === 'hall_manager' && hallId !== me.hallId) throw new ForbiddenException('Only your own hall');
    const from = date(b.validFrom, 'validFrom'), to = date(b.validTo, 'validTo');
    if (to <= from) throw new BadRequestException('validTo must be after validFrom');
    const code = crypto.randomBytes(24).toString('base64url');
    const r = await this.db.one(`INSERT INTO qr_checkin_codes(code,location,hall_id,shift,valid_from,valid_to,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,code,location,shift`,
      [code, str(b.location, 'location', 200), hallId, str(b.shift, 'shift', 60), from, to, me.id]);
    await this.audit.log(me.id, 'qr.create', 'qr', r.id, null, { location: r.location, shift: r.shift });
    return r; // the app renders `code` as a QR image
  }
  @Get('qr') @Roles('super_admin', 'core_team', 'hall_manager') listQr(@Me() me: AuthUser) {
    return this.db.rows(`SELECT id,code,location,hall_id AS "hallId",shift,valid_from AS "validFrom",valid_to AS "validTo",revoked_at AS "revokedAt" FROM qr_checkin_codes
      WHERE ($1 >= 90 OR hall_id=$2) ORDER BY created_at DESC LIMIT 200`, [me.rank, me.hallId]);
  }
  @Post('qr/:id/revoke') @Roles('super_admin', 'core_team', 'hall_manager') async revoke(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q('UPDATE qr_checkin_codes SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL AND ($2>=90 OR hall_id=$3)', [id, me.rank, me.hallId]);
    if (!r.rowCount) throw new NotFoundException();
    await this.audit.log(me.id, 'qr.revoke', 'qr', id); return { ok: true };
  }

  /** One endpoint for scan: first scan of a shift = check-in, second = check-out. */
  @Post('scan') async scan(@Me() me: AuthUser, @Body() b: any) {
    const code = str(b.code, 'code', 100);
    const qr = await this.db.one('SELECT * FROM qr_checkin_codes WHERE code=$1', [code]);
    if (!qr || qr.revoked_at) throw new ForbiddenException('Invalid QR code');
    const now = new Date();
    const day = new Date((qr.valid_from ? qr.valid_from.getTime() : Date.now()) + 5.5 * 3600e3).toISOString().slice(0, 10); // IST calendar day of the shift
    const row = await this.db.tx(async (c) => {
      const ex = (await c.query('SELECT * FROM attendance WHERE user_id=$1 AND day=$2 AND shift=$3 FOR UPDATE', [me.id, day, qr.shift])).rows[0];
      if (!ex) {
        const r = (await c.query('INSERT INTO attendance(user_id,day,qr_id,shift) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *', [me.id, day, qr.id, qr.shift])).rows[0];
        if (!r) throw new BadRequestException('Duplicate scan');
        return { action: 'check_in', at: r.check_in_at };
      }
      if (ex.check_out_at) throw new BadRequestException('Already checked in and out for this shift');
      if (now.getTime() - ex.check_in_at.getTime() < 5000) throw new BadRequestException('Duplicate scan – wait a few seconds before checking out');
      const r = (await c.query('UPDATE attendance SET check_out_at=now() WHERE id=$1 RETURNING check_out_at', [ex.id])).rows[0];
      return { action: 'check_out', at: r.check_out_at };
    });
    await this.audit.log(me.id, 'attendance.' + row.action, 'attendance', null, null, { location: qr.location, shift: qr.shift });
    this.rt.server?.emit('attendance:updated', { userId: me.id, action: row.action, hallId: qr.hall_id });
    return { ...row, location: qr.location, shift: qr.shift };
  }

  @Get('me') mine(@Me() me: AuthUser) {
    return this.db.rows(`SELECT a.day,a.shift,a.check_in_at AS "checkInAt",a.check_out_at AS "checkOutAt",q.location FROM attendance a LEFT JOIN qr_checkin_codes q ON q.id=a.qr_id WHERE a.user_id=$1 ORDER BY a.day DESC, a.check_in_at DESC LIMIT 100`, [me.id]);
  }
  @Get() @Roles('super_admin', 'core_team', 'hall_manager') list(@Me() me: AuthUser, @Query('day') day?: string, @Query('hallId') hallId?: string) {
    return this.db.rows(this.listSql(), this.listArgs(me, day, hallId));
  }
  listSql() {
    return `SELECT a.day, u.member_id AS "memberId", u.full_name AS name, u.role_code AS role, h.name AS hall, a.shift, q.location, a.check_in_at AS "checkInAt", a.check_out_at AS "checkOutAt"
      FROM attendance a JOIN users u ON u.id=a.user_id LEFT JOIN qr_checkin_codes q ON q.id=a.qr_id LEFT JOIN halls h ON h.id=q.hall_id
      WHERE ($1::date IS NULL OR a.day=$1) AND ($2::int IS NULL OR q.hall_id=$2) AND ($3 >= 90 OR q.hall_id=$4) ORDER BY a.day DESC, a.check_in_at DESC LIMIT 2000`;
  }
  listArgs(me: AuthUser, day?: string, hallId?: string) { return [day || null, hallId ? Number(hallId) : null, me.rank, me.hallId]; }
  @Get('export.csv') @Roles('super_admin', 'core_team', 'hall_manager') async exp(@Me() me: AuthUser, @Res() res: any, @Query('day') day?: string, @Query('hallId') hallId?: string) {
    sendCsv(res, 'attendance', await this.db.rows(this.listSql(), this.listArgs(me, day, hallId)));
  }
}

// =====================================================================  VIP (restricted)
@Controller('vip')
export class VipController {
  constructor(private db: Db, private audit: Audit, private notifier: Notifier) {}
  /** Only super admin, core team who are flagged, and designated VIP coordinators. Everyone else: assigned duties only (hall mgr: stage/seating). */
  private full(me: AuthUser) { return me.role === 'super_admin' || me.isVip || me.role === 'core_team'; }

  @Get() async list(@Me() me: AuthUser) {
    if (this.full(me)) return this.db.rows(`SELECT id,kind,title,details,status,updated_at AS "updatedAt" FROM vip_records ORDER BY kind, created_at`);
    if (me.role === 'hall_manager') return this.db.rows(`SELECT id,kind,title,status FROM vip_records WHERE kind IN ('stage','seating','green_room') ORDER BY created_at`);
    return this.db.rows(`SELECT r.id,r.kind,r.title,a.duty,r.status FROM vip_assignments a JOIN vip_records r ON r.id=a.vip_record_id WHERE a.user_id=$1`, [me.id]);
  }
  @Post() async create(@Me() me: AuthUser, @Body() b: any) {
    if (!this.full(me)) throw new ForbiddenException();
    const kind = oneOf(b.kind, 'kind', ['itinerary', 'guest', 'transport', 'stage', 'seating', 'green_room', 'hospitality', 'medical', 'arrival']);
    const r = await this.db.one('INSERT INTO vip_records(kind,title,details,status,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [kind, str(b.title, 'title', 200), JSON.stringify(b.details ?? {}), str(b.status, 'status', 60, false), me.id]);
    await this.audit.log(me.id, 'vip.create', 'vip', r.id, null, { kind }); return r;
  }
  @Patch(':id') async update(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    if (!this.full(me)) throw new ForbiddenException(); uuid(id, 'id');
    const r = await this.db.q(`UPDATE vip_records SET title=COALESCE($2,title), details=COALESCE($3,details), status=COALESCE($4,status), updated_at=now() WHERE id=$1`,
      [id, str(b.title, 'title', 200, false), b.details ? JSON.stringify(b.details) : null, str(b.status, 'status', 60, false)]);
    if (!r.rowCount) throw new NotFoundException(); await this.audit.log(me.id, 'vip.update', 'vip', id, null, { status: b.status }); return { ok: true };
  }
  @Delete(':id') @Roles('super_admin') async del(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id'); await this.db.q('DELETE FROM vip_records WHERE id=$1', [id]); await this.audit.log(me.id, 'vip.delete', 'vip', id); return { ok: true };
  }
  @Post(':id/assign') async assign(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    if (!this.full(me)) throw new ForbiddenException(); uuid(id, 'id');
    const uid = uuid(b.userId, 'userId');
    await this.db.q('INSERT INTO vip_assignments(vip_record_id,user_id,duty) VALUES($1,$2,$3) ON CONFLICT (vip_record_id,user_id) DO UPDATE SET duty=EXCLUDED.duty', [id, uid, str(b.duty, 'duty', 300, false)]);
    await this.audit.log(me.id, 'vip.assign', 'vip', id, null, { userId: uid });
    await this.notifier.send([uid], { type: 'vip_update', title: 'New duty assigned', body: str(b.duty, 'duty', 100, false) ?? 'Check your assigned duties', deepLink: '/vip' });
    return { ok: true };
  }
  @Delete(':id/assign/:userId') async unassign(@Me() me: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    if (!this.full(me)) throw new ForbiddenException(); uuid(id, 'id'); uuid(userId, 'userId');
    await this.db.q('DELETE FROM vip_assignments WHERE vip_record_id=$1 AND user_id=$2', [id, userId]); await this.audit.log(me.id, 'vip.unassign', 'vip', id, null, { userId }); return { ok: true };
  }
}

// =====================================================================  DOCUMENTS
@Controller('documents')
export class DocumentsController {
  constructor(private db: Db, private audit: Audit) {}
  @Get() list(@Me() me: AuthUser, @Query('category') category?: string) {
    return this.db.rows(`SELECT d.id,d.title,d.category,d.mime_type AS "mimeType",d.size_bytes AS "sizeBytes",d.storage_key AS "fileKey",d.hall_id AS "hallId",d.created_at AS "createdAt"
      FROM documents d WHERE d.deleted_at IS NULL AND d.min_role_rank <= $1 AND ($2::text IS NULL OR d.category=$2) AND (d.hall_id IS NULL OR $1 >= 90 OR d.hall_id=$3) ORDER BY d.created_at DESC LIMIT 300`, [me.rank, category ?? null, me.hallId]);
  }
  /** Upload the file first with POST /uploads, then register it here with the returned key. */
  @Post() @Roles('super_admin', 'core_team', 'hall_manager') async add(@Me() me: AuthUser, @Body() b: any) {
    const key = str(b.fileKey, 'fileKey', 200);
    const hallId = me.role === 'hall_manager' ? me.hallId : b.hallId ? Number(b.hallId) : null;
    const minRank = Math.min(Number(b.minRoleRank ?? 10), me.rank);
    const r = await this.db.one('INSERT INTO documents(title,category,storage_key,mime_type,size_bytes,hall_id,min_role_rank,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [str(b.title, 'title', 200), str(b.category, 'category', 60, false), key, str(b.mimeType, 'mimeType', 100, false), b.sizeBytes ? Number(b.sizeBytes) : null, hallId, minRank, me.id]);
    await this.audit.log(me.id, 'document.add', 'document', r.id, null, { title: b.title }); return r;
  }
  @Delete(':id') @Roles('super_admin', 'core_team', 'hall_manager') async del(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q('UPDATE documents SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL AND ($2>=90 OR uploaded_by=$3)', [id, me.rank, me.id]);
    if (!r.rowCount) throw new NotFoundException(); await this.audit.log(me.id, 'document.delete', 'document', id); return { ok: true };
  }
}

// =====================================================================  RESOURCES
@Controller('resources')
export class ResourcesController {
  constructor(private db: Db, private audit: Audit) {}
  @Get() @Roles('super_admin', 'core_team', 'hall_manager', 'event_manager') list() {
    return this.db.rows(`SELECT r.id,r.name,r.category,r.quantity, r.quantity - COALESCE((SELECT sum(a.qty) FROM resource_allocations a WHERE a.resource_id=r.id AND a.returned_at IS NULL),0)::int AS available
      FROM resources r ORDER BY r.category, r.name`);
  }
  @Post() @Roles('super_admin', 'core_team') async create(@Me() me: AuthUser, @Body() b: any) {
    const r = await this.db.one('INSERT INTO resources(name,category,quantity) VALUES($1,$2,$3) RETURNING id', [str(b.name, 'name', 150), str(b.category, 'category', 60), Math.max(1, Number(b.quantity) || 1)]);
    await this.audit.log(me.id, 'resource.create', 'resource', r.id, null, b); return r;
  }
  @Get('allocations') @Roles('super_admin', 'core_team', 'hall_manager', 'event_manager') allocations(@Me() me: AuthUser, @Query('open') open?: string) {
    return this.db.rows(`SELECT a.id,r.name AS resource,r.category,a.qty,h.name AS hall,e.title AS event,u.full_name AS "responsible",a.allocated_at AS "allocatedAt",a.returned_at AS "returnedAt"
      FROM resource_allocations a JOIN resources r ON r.id=a.resource_id LEFT JOIN halls h ON h.id=a.hall_id LEFT JOIN events e ON e.id=a.event_id LEFT JOIN users u ON u.id=a.responsible_user_id
      WHERE ($1 >= 90 OR a.hall_id=$2) AND ($3::bool IS NOT TRUE OR a.returned_at IS NULL) ORDER BY a.allocated_at DESC LIMIT 500`, [me.rank, me.hallId, open === 'true']);
  }
  @Post('allocations') @Roles('super_admin', 'core_team', 'hall_manager') async allocate(@Me() me: AuthUser, @Body() b: any) {
    const rid = uuid(b.resourceId, 'resourceId'), qty = Math.max(1, Number(b.qty) || 1);
    const hallId = me.role === 'hall_manager' ? me.hallId : b.hallId ? Number(b.hallId) : null;
    const a = await this.db.tx(async (c) => {
      const res = (await c.query('SELECT quantity FROM resources WHERE id=$1 FOR UPDATE', [rid])).rows[0];
      if (!res) throw new NotFoundException('Resource not found');
      const used = (await c.query('SELECT COALESCE(sum(qty),0)::int n FROM resource_allocations WHERE resource_id=$1 AND returned_at IS NULL', [rid])).rows[0].n;
      if (used + qty > res.quantity) throw new BadRequestException(`Only ${res.quantity - used} available`);
      const r = (await c.query('INSERT INTO resource_allocations(resource_id,hall_id,event_id,responsible_user_id,qty) VALUES($1,$2,$3,$4,$5) RETURNING id', [rid, hallId, b.eventId ? uuid(b.eventId, 'eventId') : null, b.responsibleUserId ? uuid(b.responsibleUserId, 'responsibleUserId') : null, qty])).rows[0];
      await this.audit.log(me.id, 'resource.allocate', 'resource', rid, null, { qty, hallId }, c); return r;
    });
    return a;
  }
  @Post('allocations/:id/return') @Roles('super_admin', 'core_team', 'hall_manager') async ret(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q('UPDATE resource_allocations SET returned_at=now() WHERE id=$1 AND returned_at IS NULL AND ($2>=90 OR hall_id=$3)', [id, me.rank, me.hallId]);
    if (!r.rowCount) throw new NotFoundException(); await this.audit.log(me.id, 'resource.return', 'allocation', id); return { ok: true };
  }
}

// =====================================================================  REPORTS
@Controller('reports')
export class ReportsController {
  constructor(private db: Db) {}
  private rep: Record<string, (me: AuthUser) => [string, any[]]> = {
    members: () => [`SELECT role_code AS role, count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active FROM users WHERE deleted_at IS NULL GROUP BY role_code ORDER BY role_code`, []],
    'attendance-hall': () => [`SELECT h.name AS hall, count(a.id)::int AS check_ins, count(a.check_out_at)::int AS check_outs FROM halls h LEFT JOIN qr_checkin_codes q ON q.hall_id=h.id LEFT JOIN attendance a ON a.qr_id=q.id GROUP BY h.name ORDER BY h.name`, []],
    'attendance-event': () => [`SELECT e.title AS event, h.name AS hall, count(DISTINCT a.user_id)::int AS attendees FROM events e JOIN halls h ON h.id=e.hall_id
      LEFT JOIN event_assignments ea ON ea.event_id=e.id LEFT JOIN attendance a ON a.user_id=ea.user_id AND a.day=(SELECT day FROM festival_days WHERE id=e.day_id) WHERE e.deleted_at IS NULL GROUP BY e.title,h.name,e.start_time ORDER BY e.start_time`, []],
    tasks: () => [`SELECT COALESCE(h.name,'—') AS hall, count(*)::int AS total, count(*) FILTER (WHERE t.status IN ('completed','verified'))::int AS done,
      count(*) FILTER (WHERE t.status NOT IN ('completed','verified'))::int AS pending, count(*) FILTER (WHERE t.deadline<now() AND t.status NOT IN ('completed','verified'))::int AS overdue
      FROM tasks t LEFT JOIN halls h ON h.id=t.hall_id WHERE t.deleted_at IS NULL GROUP BY h.name ORDER BY h.name`, []],
    incidents: () => [`SELECT category, status, count(*)::int AS total FROM incidents GROUP BY category,status ORDER BY category`, []],
    communication: () => [`SELECT r.type, r.name AS room, count(m.id)::int AS messages FROM rooms r LEFT JOIN messages m ON m.room_id=r.id WHERE r.type<>'direct' GROUP BY r.type,r.name ORDER BY messages DESC LIMIT 100`, []],
    equipment: () => [`SELECT r.category, r.name, r.quantity, COALESCE(sum(a.qty) FILTER (WHERE a.returned_at IS NULL),0)::int AS out_now FROM resources r LEFT JOIN resource_allocations a ON a.resource_id=r.id GROUP BY r.id ORDER BY r.category,r.name`, []],
    summary: () => [`SELECT (SELECT count(*) FROM users WHERE status='active')::int AS members, (SELECT count(*) FROM events WHERE deleted_at IS NULL AND status='completed')::int AS events_completed,
      (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND status IN ('completed','verified'))::int AS tasks_done, (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND status NOT IN ('completed','verified'))::int AS tasks_pending,
      (SELECT count(*) FROM attendance WHERE day=(now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS checkins_today, (SELECT count(*) FROM incidents WHERE status<>'resolved')::int AS open_incidents,
      (SELECT count(*) FROM emergency_alerts)::int AS emergencies`, []],
  };
  private guard(me: AuthUser, name: string) {
    if (me.rank < 90) throw new ForbiddenException('Reports are for Super Admin / Core Team');
    if (!this.rep[name]) throw new NotFoundException('Unknown report');
  }
  @Get() names(@Me() me: AuthUser) { if (me.rank < 90) throw new ForbiddenException(); return Object.keys(this.rep); }
  @Get(':name') async get(@Me() me: AuthUser, @Param('name') name: string) { this.guard(me, name); const [s, p] = this.rep[name](me); return this.db.rows(s, p); }
  @Get(':name/export.csv') async csv(@Me() me: AuthUser, @Param('name') name: string, @Res() res: any) { this.guard(me, name); const [s, p] = this.rep[name](me); sendCsv(res, name, await this.db.rows(s, p)); }
  @Get(':name/export.pdf') async pdf(@Me() me: AuthUser, @Param('name') name: string, @Res() res: any) {
    this.guard(me, name); const [s, p] = this.rep[name](me);
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    res.send(tablePdf('Phule Festival 2026 - ' + name + ' report', await this.db.rows(s, p)));
  }
}

@Controller('admin')
export class AuditController {
  constructor(private db: Db) {}
  @Get('audit') @Roles('super_admin') logs(@Query('limit') limit = '200', @Query('action') action?: string) {
    return this.db.rows(`SELECT a.id,a.action,a.entity,a.entity_id AS "entityId",a.old_value AS "oldValue",a.new_value AS "newValue",a.created_at AS "createdAt",u.full_name AS actor
      FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ($2::text IS NULL OR a.action LIKE $2||'%') ORDER BY a.id DESC LIMIT $1`, [Math.min(+limit || 200, 1000), action ?? null]);
  }
}
