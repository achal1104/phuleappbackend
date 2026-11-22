import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Db, Realtime } from '../common/core';

export type SyncResult = { roomId: string; added: string[]; removed: string[] };

/** Single source of truth for who belongs in which room. Always runs inside a transaction. */
@Injectable()
export class RoomSync {
  constructor(private db: Db, private rt: Realtime) {}

  private async desired(c: PoolClient, room: any): Promise<string[]> {
    let sql: string; let params: any[] = [];
    const staff = `SELECT id FROM users WHERE status='active' AND deleted_at IS NULL AND role_code IN ('super_admin','core_team')`;
    if (room.type === 'global') sql = `SELECT id FROM users WHERE status='active' AND deleted_at IS NULL`;
    else if (room.type === 'hall_day') {
      params = [room.hall_id, room.day_id];
      sql = `${staff} UNION
        SELECT id FROM users WHERE status='active' AND deleted_at IS NULL AND role_code='hall_manager' AND hall_id=$1 UNION
        SELECT ea.user_id FROM event_assignments ea JOIN events e ON e.id=ea.event_id JOIN users u ON u.id=ea.user_id
          WHERE e.hall_id=$1 AND e.day_id=$2 AND e.deleted_at IS NULL AND u.status='active' AND u.deleted_at IS NULL`;
    } else if (room.type === 'event') {
      params = [room.event_id];
      sql = `${staff} UNION
        SELECT u.id FROM users u JOIN events e ON e.hall_id=u.hall_id WHERE e.id=$1 AND u.role_code='hall_manager' AND u.status='active' AND u.deleted_at IS NULL UNION
        SELECT ea.user_id FROM event_assignments ea JOIN users u ON u.id=ea.user_id WHERE ea.event_id=$1 AND u.status='active' AND u.deleted_at IS NULL`;
    } else return []; // direct/vip/custom are managed explicitly
    return (await c.query(sql, params)).rows.map((r) => r.id);
  }

  async syncRoom(c: PoolClient, roomId: string): Promise<SyncResult> {
    const room = (await c.query('SELECT * FROM rooms WHERE id=$1', [roomId])).rows[0];
    const want = await this.desired(c, room);
    const added = (await c.query(
      `INSERT INTO room_members(room_id,user_id) SELECT $1, u FROM unnest($2::uuid[]) u
       ON CONFLICT (room_id,user_id) DO UPDATE SET removed_at=NULL, joined_at=CASE WHEN room_members.removed_at IS NOT NULL THEN now() ELSE room_members.joined_at END
       WHERE room_members.removed_at IS NOT NULL RETURNING user_id`, [roomId, want])).rows.map((r) => r.user_id);
    const removed = (await c.query(
      `UPDATE room_members SET removed_at=now() WHERE room_id=$1 AND removed_at IS NULL AND NOT (user_id = ANY($2::uuid[])) RETURNING user_id`,
      [roomId, want])).rows.map((r) => r.user_id);
    return { roomId, added, removed };
  }

  /** Re-sync every auto-managed room (used when a user's role/hall/status changes). */
  async syncAll(c: PoolClient): Promise<SyncResult[]> {
    const rooms = (await c.query(`SELECT id FROM rooms WHERE type IN ('global','hall_day','event') AND closed_at IS NULL`)).rows;
    const out: SyncResult[] = [];
    for (const r of rooms) { const s = await this.syncRoom(c, r.id); if (s.added.length || s.removed.length) out.push(s); }
    return out;
  }

  async syncHallDay(c: PoolClient, hallId: number, dayId: number) {
    const r = (await c.query(`SELECT id FROM rooms WHERE type='hall_day' AND hall_id=$1 AND day_id=$2`, [hallId, dayId])).rows[0];
    return r ? this.syncRoom(c, r.id) : null;
  }

  /** Apply socket-level effects AFTER the transaction has committed. */
  applyRealtime(results: (SyncResult | null)[]) {
    for (const s of results) {
      if (!s) continue;
      s.removed.forEach((u) => { this.rt.leaveRoom(u, s.roomId); this.rt.toUser(u, 'room:removed', { roomId: s.roomId }); });
      s.added.forEach((u) => { this.rt.joinRoom(u, s.roomId); this.rt.toUser(u, 'room:added', { roomId: s.roomId }); });
    }
  }
}
