import { CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata, createParamDecorator, ForbiddenException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Pool, PoolClient } from 'pg';
import { Server } from 'socket.io';

@Injectable()
export class Db {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL || 20) });
  q(text: string, params: any[] = []) { return this.pool.query(text, params); }
  async rows(text: string, params: any[] = []) { return (await this.pool.query(text, params)).rows; }
  async one(text: string, params: any[] = []) { return (await this.pool.query(text, params)).rows[0]; }
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
}

@Injectable()
export class Audit {
  constructor(private db: Db) {}
  async log(actorId: string | null, action: string, entity?: string, entityId?: string, oldV?: any, newV?: any, client?: PoolClient, ip?: string) {
    const q = client ?? this.db.pool;
    await q.query(
      'INSERT INTO audit_logs(actor_id,action,entity,entity_id,old_value,new_value,ip) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [actorId, action, entity ?? null, entityId ?? null, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, ip ?? null]);
  }
}

@Injectable()
export class Realtime {
  server: Server;
  online = new Map<string, number>();
  toUser(id: string, ev: string, p: any) { this.server?.to('u:' + id).emit(ev, p); }
  toUsers(ids: string[], ev: string, p: any) { ids.forEach((i) => this.toUser(i, ev, p)); }
  toRoom(roomId: string, ev: string, p: any) { this.server?.to('r:' + roomId).emit(ev, p); }
  isOnline(id: string) { return (this.online.get(id) || 0) > 0; }
  joinRoom(userId: string, roomId: string) { this.server?.in('u:' + userId).socketsJoin('r:' + roomId); }
  leaveRoom(userId: string, roomId: string) { this.server?.in('u:' + userId).socketsLeave('r:' + roomId); }
  onlineCount() { return this.online.size; }
}

export type AuthUser = { id: string; name: string; role: string; hallId: number | null; canEmergency: boolean; isVip: boolean; rank: number };
export const RANK: Record<string, number> = { super_admin: 100, core_team: 90, hall_manager: 70, event_manager: 60, management: 40, volunteer: 10 };

export const Public = () => SetMetadata('public', true);
export const Roles = (...r: string[]) => SetMetadata('roles', r);
export const Me = createParamDecorator((_d, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private db: Db, private ref: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.ref.getAllAndOverride('public', [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string = req.headers['authorization'] || '';
    if (!h.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');
    let p: any;
    try { p = await this.jwt.verifyAsync(h.slice(7)); } catch { throw new UnauthorizedException('Invalid or expired token'); }
    const u = await loadUser(this.db, p.sub);
    if (!u) throw new UnauthorizedException('Account inactive');
    req.user = u;
    const roles: string[] | undefined = this.ref.getAllAndOverride('roles', [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(u.role)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}

export async function loadUser(db: Db, id: string): Promise<AuthUser | null> {
  const r = await db.one(`SELECT id, full_name, role_code, hall_id, can_publish_emergency, is_vip_coordinator FROM users
    WHERE id=$1 AND status='active' AND deleted_at IS NULL`, [id]);
  if (!r) return null;
  db.q('UPDATE users SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval \'30 seconds\')', [id]).catch(() => {});
  return { id: r.id, name: r.full_name, role: r.role_code, hallId: r.hall_id, canEmergency: r.can_publish_emergency, isVip: r.is_vip_coordinator, rank: RANK[r.role_code] };
}

// ---- tiny validation helpers
export const str = (v: any, name: string, max = 2000, required = true) => {
  if (v === undefined || v === null || v === '') { if (required) throw new BadRequestException(`${name} is required`); return null; }
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`${name} invalid`);
  return v.trim();
};
export const oneOf = (v: any, name: string, list: string[]) => { if (!list.includes(v)) throw new BadRequestException(`${name} must be one of ${list.join(',')}`); return v; };
export const date = (v: any, name: string) => { const d = new Date(v); if (isNaN(d.getTime())) throw new BadRequestException(`${name} invalid date`); return d; };
export const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuid = (v: any, name: string) => { if (typeof v !== 'string' || !uuidRe.test(v)) throw new BadRequestException(`${name} invalid id`); return v; };
export const uuids = (v: any, name: string) => { if (v === undefined) return []; if (!Array.isArray(v)) throw new BadRequestException(`${name} must be array`); v.forEach((x) => uuid(x, name)); return [...new Set(v as string[])]; };
export const phoneNorm = (p?: string) => (p ? p.replace(/[\s\-()]/g, '') : null);
export { HttpException };
