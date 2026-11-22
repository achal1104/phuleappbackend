import { Controller, Get } from '@nestjs/common';
import { AuthUser, Db, Me, Realtime } from '../common/core';

@Controller('dashboard')
export class DashboardController {
  constructor(private db: Db, private rt: Realtime) {}
  @Get() async get(@Me() me: AuthUser) {
    const monitor = me.rank >= 90;
    const s = await this.db.one(`SELECT
      (SELECT count(*)::int FROM users WHERE status='active' AND deleted_at IS NULL) AS "totalMembers",
      (SELECT count(*)::int FROM users WHERE status='active' AND deleted_at IS NULL AND last_seen_at > now() - interval '5 minutes') AS "activeMembers",
      (SELECT count(*)::int FROM users WHERE status='active' AND role_code='volunteer') AS "totalVolunteers",
      (SELECT count(*)::int FROM users WHERE status='active' AND role_code IN ('management','event_manager','hall_manager')) AS "managementMembers",
      (SELECT count(*)::int FROM halls WHERE deleted_at IS NULL) AS "halls",
      (SELECT count(*)::int FROM events WHERE deleted_at IS NULL AND status='ongoing') AS "activeEvents",
      (SELECT count(*)::int FROM events WHERE deleted_at IS NULL AND status='completed') AS "completedEvents",
      (SELECT count(*)::int FROM tasks WHERE deleted_at IS NULL AND status IN ('assigned','accepted','in_progress')) AS "pendingTasks",
      (SELECT count(*)::int FROM emergency_alerts WHERE created_at > now() - interval '24 hours') AS "emergencyAlerts"`);
    const halls = me.rank >= 70 ? await this.db.rows(`SELECT h.id, h.code, h.name, h.status,
        (SELECT row_to_json(x) FROM (SELECT e.id,e.title,e.progress,e.start_time AS "startTime",e.end_time AS "endTime" FROM events e WHERE e.hall_id=h.id AND e.deleted_at IS NULL AND e.status NOT IN ('cancelled','completed') AND (e.status='ongoing' OR now() BETWEEN e.start_time AND e.end_time) ORDER BY e.start_time LIMIT 1) x) AS "currentEvent",
        (SELECT row_to_json(x) FROM (SELECT e.id,e.title,e.start_time AS "startTime" FROM events e WHERE e.hall_id=h.id AND e.deleted_at IS NULL AND e.status IN ('upcoming','postponed') AND e.start_time > now() ORDER BY e.start_time LIMIT 1) x) AS "nextEvent",
        (SELECT full_name FROM users WHERE role_code='hall_manager' AND hall_id=h.id AND status='active' LIMIT 1) AS manager,
        (SELECT count(DISTINCT ea.user_id)::int FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE e.hall_id=h.id AND e.deleted_at IS NULL AND ea.assignment_role='volunteer') AS "volunteerCount",
        (SELECT count(*)::int FROM tasks t WHERE t.hall_id=h.id AND t.deleted_at IS NULL AND t.status IN ('assigned','accepted','in_progress')) AS "pendingTasks"
      FROM halls h WHERE h.deleted_at IS NULL AND ($1 OR h.id=$2) ORDER BY h.code`, [monitor, me.hallId]) : [];
    const myEvents = await this.db.rows(`SELECT e.id,e.title,e.start_time AS "startTime",e.end_time AS "endTime",e.status,h.name AS "hallName" FROM event_assignments ea JOIN events e ON e.id=ea.event_id JOIN halls h ON h.id=e.hall_id
      WHERE ea.user_id=$1 AND e.deleted_at IS NULL AND e.status<>'cancelled' ORDER BY e.start_time LIMIT 10`, [me.id]);
    const myRooms = await this.db.rows(`SELECT r.id,r.name,r.type FROM rooms r JOIN room_members m ON m.room_id=r.id AND m.user_id=$1 AND m.removed_at IS NULL WHERE r.type<>'direct' AND r.closed_at IS NULL ORDER BY r.type, r.name LIMIT 30`, [me.id]);
    const feed = me.rank >= 70
      ? await this.db.rows(`SELECT a.action, a.entity, a.entity_id AS "entityId", a.new_value AS detail, a.created_at AS "createdAt", u.full_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
          WHERE a.action IN ('event.create','event.timing_change','event.cancel','event.assignments','member.approve','emergency.publish','emergency.escalate','room.create','incident.report') ORDER BY a.id DESC LIMIT 20`)
      : await this.db.rows(`SELECT type AS action, title, body, created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [me.id]);
    const unread = (await this.db.one('SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [me.id])).n;
    return { scope: monitor ? 'festival' : me.rank >= 70 ? 'hall' : 'personal', stats: monitor || me.rank >= 70 ? { ...s, onlineNow: this.rt.onlineCount() } : null, halls, myEvents, myRooms, feed, unreadNotifications: unread };
  }
}
