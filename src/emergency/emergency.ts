import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Patch, Post } from '@nestjs/common';
import { Audit, AuthUser, Db, Me, Realtime, Roles, oneOf, str, uuid } from '../common/core';
import { Notifier } from '../notifications/notifications';

const CATS = ['critical', 'medical', 'security', 'crowd', 'technical', 'stage', 'vip_protocol', 'general_urgent'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class EmergencyService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout;
  constructor(private db: Db, private rt: Realtime, private notifier: Notifier, private audit: Audit) {}
  onModuleInit() { this.timer = setInterval(() => this.escalate().catch((e) => console.error('escalation', e)), Number(process.env.ESCALATION_POLL_MS || 15000)); }
  onModuleDestroy() { clearInterval(this.timer); }

  async recipients(a: any): Promise<string[]> {
    const act = `u.status='active' AND u.deleted_at IS NULL`;
    let rows: any[];
    if (a.target_type === 'all') rows = await this.db.rows(`SELECT id FROM users u WHERE ${act}`);
    else if (a.target_type === 'hall') rows = await this.db.rows(`SELECT id FROM users u WHERE ${act} AND (u.hall_id=$1 OR u.id IN (SELECT ea.user_id FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE e.hall_id=$1 AND e.deleted_at IS NULL) OR u.role_code IN ('super_admin','core_team'))`, [a.target_hall_id]);
    else if (a.target_type === 'team') rows = await this.db.rows(`SELECT u.id FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 AND ${act}`, [a.target_team_id]);
    else rows = await this.db.rows(`SELECT u.id FROM users u WHERE ${act} AND (u.id IN (SELECT user_id FROM event_assignments WHERE event_id=$1) OR u.role_code IN ('super_admin','core_team') OR (u.role_code='hall_manager' AND u.hall_id=(SELECT hall_id FROM events WHERE id=$1)))`, [a.target_event_id]);
    return rows.map((r) => r.id);
  }

  async publish(me: AuthUser, b: any) {
    if (!(me.role === 'super_admin' || (me.role === 'core_team' && me.canEmergency))) throw new ForbiddenException('Not authorised to publish emergency broadcasts');
    const targetType = oneOf(b.targetType, 'targetType', ['all', 'hall', 'team', 'event']);
    const hallId = b.targetHallId ? Number(b.targetHallId) : null, teamId = b.targetTeamId ? Number(b.targetTeamId) : null, eventId = b.targetEventId ? uuid(b.targetEventId, 'targetEventId') : null;
    if ((targetType === 'hall' && !hallId) || (targetType === 'team' && !teamId) || (targetType === 'event' && !eventId)) throw new BadRequestException('target id required');
    const alert = await this.db.tx(async (c) => {
      const a = (await c.query(`INSERT INTO emergency_alerts(category,title,description,instructions,priority,location,target_type,target_hall_id,target_team_id,target_event_id,issued_by,escalate_after_sec)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [oneOf(b.category, 'category', CATS), str(b.title, 'title', 200), str(b.description, 'description', 4000), str(b.instructions, 'instructions', 4000, false),
        oneOf(b.priority ?? 'high', 'priority', ['critical', 'high', 'medium']), str(b.location, 'location', 200, false), targetType, hallId, teamId, eventId, me.id,
        Math.max(Number(b.escalateAfterSec) || 180, Number(process.env.MIN_ESCALATION_SEC || 30))])).rows[0];
      const ids = await this.recipients(a);
      await c.query(`INSERT INTO emergency_acknowledgements(alert_id,user_id) SELECT $1,u FROM unnest($2::uuid[]) u ON CONFLICT DO NOTHING`, [a.id, ids]);
      await this.audit.log(me.id, 'emergency.publish', 'emergency', a.id, null, { title: a.title, category: a.category, targetType, recipients: ids.length }, c);
      return { a, ids };
    });
    // fire-and-forget delivery with retries, so the API call returns immediately
    this.deliver(alert.a, alert.ids, me.name).catch((e) => console.error('deliver', e));
    return { id: alert.a.id, recipients: alert.ids.length };
  }

  private async deliver(a: any, ids: string[], issuerName: string) {
    const n = { type: 'emergency', title: `🚨 ${a.title}`, body: a.description.slice(0, 180), deepLink: `/emergency/${a.id}`, data: { alertId: a.id, category: a.category, priority: a.priority } };
    await this.notifier.send(ids, n, { push: false }); // stores history + emits notification:new
    const payload = { id: a.id, category: a.category, title: a.title, description: a.description, instructions: a.instructions, priority: a.priority, location: a.location, issuer: issuerName, createdAt: a.created_at };
    const retryMs = Number(process.env.EMERGENCY_RETRY_MS || 3000);
    const one = async (id: string) => {
      this.rt.toUser(id, 'emergency:new', payload);
      let ok = this.rt.isOnline(id);
      let attempts = 0;
      if (!ok) for (; attempts < 3 && !ok; attempts++) { ok = await this.notifier.push(id, n); if (!ok && attempts < 2) await sleep(retryMs * (attempts + 1)); }
      await this.db.q(`UPDATE emergency_acknowledgements SET delivery_status=$3, delivered_at=CASE WHEN $3='delivered' THEN now() END, push_attempts=$4 WHERE alert_id=$1 AND user_id=$2`, [a.id, id, ok ? 'delivered' : 'failed', attempts]);
    };
    for (let i = 0; i < ids.length; i += 40) await Promise.all(ids.slice(i, i + 40).map(one));
    this.rt.toUsers((await this.db.rows(`SELECT id FROM users WHERE role_code IN ('super_admin','core_team') AND status='active'`)).map((r) => r.id), 'emergency:delivery', { alertId: a.id });
  }

  /** Non-acknowledgement is escalated once to hall managers / core team / issuer. */
  async escalate() {
    const due = await this.db.rows(`UPDATE emergency_alerts a SET escalated_at=now()
      WHERE escalated_at IS NULL AND created_at + (escalate_after_sec || ' seconds')::interval < now()
        AND EXISTS (SELECT 1 FROM emergency_acknowledgements k WHERE k.alert_id=a.id AND k.acknowledged_at IS NULL) RETURNING *`);
    for (const a of due) {
      const pend = await this.db.rows(`SELECT u.hall_id, u.full_name FROM emergency_acknowledgements k JOIN users u ON u.id=k.user_id WHERE k.alert_id=$1 AND k.acknowledged_at IS NULL AND u.role_code NOT IN ('super_admin','core_team')`, [a.id]);
      if (!pend.length) continue;
      const halls = [...new Set(pend.map((p) => p.hall_id).filter(Boolean))];
      const mgrs = (await this.db.rows(`SELECT id FROM users WHERE status='active' AND ((role_code='hall_manager' AND (hall_id = ANY($1::int[]) OR $2)) OR role_code='core_team' OR id=$3)`, [halls, !halls.length, a.issued_by])).map((r) => r.id);
      await this.notifier.send(mgrs, { type: 'emergency_escalation', title: `Unacknowledged: ${a.title}`, body: `${pend.length} member(s) have not acknowledged`, deepLink: `/emergency/${a.id}`, data: { alertId: a.id } });
      this.rt.toUsers(mgrs, 'emergency:escalated', { alertId: a.id, pending: pend.length });
      await this.audit.log(null, 'emergency.escalate', 'emergency', a.id, null, { pending: pend.length });
    }
  }
}

@Controller()
export class EmergencyController {
  constructor(private db: Db, private svc: EmergencyService, private audit: Audit, private rt: Realtime) {}

  @Post('emergency') publish(@Me() me: AuthUser, @Body() b: any) { return this.svc.publish(me, b); }

  @Get('emergency') async list(@Me() me: AuthUser) {
    const monitor = me.rank >= 90;
    return this.db.rows(`SELECT a.id, a.category, a.title, a.description, a.instructions, a.priority, a.location, a.target_type AS "targetType", a.created_at AS "createdAt", a.escalated_at AS "escalatedAt", i.full_name AS issuer,
        ${monitor ? `(SELECT json_build_object('total',count(*),'delivered',count(*) FILTER (WHERE delivery_status='delivered'),'failed',count(*) FILTER (WHERE delivery_status='failed'),'pending',count(*) FILTER (WHERE delivery_status='pending'),'acknowledged',count(*) FILTER (WHERE acknowledged_at IS NOT NULL)) FROM emergency_acknowledgements k WHERE k.alert_id=a.id)` : 'NULL'} AS stats,
        (SELECT json_build_object('deliveryStatus',k.delivery_status,'acknowledgedAt',k.acknowledged_at) FROM emergency_acknowledgements k WHERE k.alert_id=a.id AND k.user_id=$1) AS mine
      FROM emergency_alerts a JOIN users i ON i.id=a.issued_by
      WHERE ($2 OR EXISTS (SELECT 1 FROM emergency_acknowledgements k WHERE k.alert_id=a.id AND k.user_id=$1)) ORDER BY a.created_at DESC LIMIT 100`, [me.id, monitor]);
  }

  /** Per-recipient delivered / acknowledged / awaiting / failed (monitoring roles only). */
  @Get('emergency/:id/status') @Roles('super_admin', 'core_team', 'hall_manager') async status(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const rows = await this.db.rows(`SELECT u.id AS "userId", u.full_name AS "fullName", u.hall_id AS "hallId", k.delivery_status AS "deliveryStatus", k.delivered_at AS "deliveredAt", k.acknowledged_at AS "acknowledgedAt", k.push_attempts AS "pushAttempts"
      FROM emergency_acknowledgements k JOIN users u ON u.id=k.user_id WHERE k.alert_id=$1 AND ($2 <> 'hall_manager' OR u.hall_id=$3) ORDER BY k.acknowledged_at NULLS FIRST, u.full_name`, [id, me.role, me.hallId]);
    return rows.map((r) => ({ ...r, state: r.acknowledgedAt ? 'acknowledged' : r.deliveryStatus === 'failed' ? 'failed' : r.deliveryStatus === 'delivered' ? 'awaiting_acknowledgement' : 'pending' }));
  }

  @Post('emergency/:id/ack') async ack(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const r = await this.db.q(`UPDATE emergency_acknowledgements SET acknowledged_at=COALESCE(acknowledged_at,now()), delivered_at=COALESCE(delivered_at,now()), delivery_status='delivered' WHERE alert_id=$1 AND user_id=$2`, [id, me.id]);
    if (!r.rowCount) throw new NotFoundException('This alert was not sent to you');
    this.rt.server?.emit('emergency:ack', { alertId: id, userId: me.id }); return { ok: true };
  }

  // ---- incidents
  @Post('incidents') async report(@Me() me: AuthUser, @Body() b: any) {
    let hallId = b.hallId ? Number(b.hallId) : me.hallId;
    if (!hallId) hallId = (await this.db.one(`SELECT e.hall_id FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE ea.user_id=$1 AND e.deleted_at IS NULL ORDER BY e.start_time LIMIT 1`, [me.id]))?.hall_id ?? null;
    const i = await this.db.one(`INSERT INTO incidents(title,category,description,photo_key,location,hall_id,reported_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [str(b.title, 'title', 200), str(b.category, 'category', 60), str(b.description, 'description', 4000, false), str(b.photoKey, 'photoKey', 200, false), str(b.location, 'location', 200, false), hallId, me.id]);
    await this.audit.log(me.id, 'incident.report', 'incident', i.id);
    this.rt.server?.emit('incident:new', { id: i.id }); return i;
  }
  @Get('incidents') incidentList(@Me() me: AuthUser) {
    return this.db.rows(`SELECT i.id,i.title,i.category,i.description,i.location,i.status,i.resolution_notes AS "resolutionNotes",i.hall_id AS "hallId",i.created_at AS "createdAt",u.full_name AS "reportedBy",m.full_name AS "responseManager"
      FROM incidents i JOIN users u ON u.id=i.reported_by LEFT JOIN users m ON m.id=i.response_manager_id
      WHERE ($2 >= 90) OR ($2 >= 60 AND (i.hall_id=$3 OR i.reported_by=$1)) OR i.reported_by=$1 ORDER BY i.created_at DESC LIMIT 200`, [me.id, me.rank, me.hallId]);
  }
  @Patch('incidents/:id') @Roles('super_admin', 'core_team', 'hall_manager') async update(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    const r = await this.db.one(`UPDATE incidents SET status=COALESCE($2,status), response_manager_id=COALESCE($3,response_manager_id), resolution_notes=COALESCE($4,resolution_notes),
      resolved_at=CASE WHEN $2='resolved' THEN now() ELSE resolved_at END WHERE id=$1 AND ($5<>'hall_manager' OR hall_id=$6) RETURNING id`,
      [id, b.status ? oneOf(b.status, 'status', ['open', 'responding', 'resolved']) : null, b.responseManagerId ? uuid(b.responseManagerId, 'responseManagerId') : null, b.resolutionNotes ?? null, me.role, me.hallId]);
    if (!r) throw new NotFoundException(); await this.audit.log(me.id, 'incident.update', 'incident', id, null, b); return { ok: true };
  }
}
