import { Controller, Get, Injectable, Param, Post, Query, Body } from '@nestjs/common';
import { Audit, Db, Me, AuthUser, Realtime, str, uuid } from '../common/core';

let fcm: any = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    fcm = admin.messaging();
  }
} catch (e) { console.warn('FCM not initialised:', (e as Error).message); }

export type Notif = { type: string; title: string; body?: string; deepLink?: string; data?: any };

@Injectable()
export class Notifier {
  constructor(private db: Db, private rt: Realtime) {}
  pushEnabled() { return !!fcm; }

  /** Store + socket-emit + FCM push. Returns per-user push success (true if >=1 device accepted). */
  async send(userIds: string[], n: Notif, opts: { push?: boolean } = { push: true }) {
    userIds = [...new Set(userIds)];
    if (!userIds.length) return new Map<string, boolean>();
    const rows = await this.db.rows(
      `INSERT INTO notifications(user_id,type,title,body,deep_link,data)
       SELECT u, $2,$3,$4,$5,$6 FROM unnest($1::uuid[]) u RETURNING id, user_id`,
      [userIds, n.type, n.title, n.body ?? null, n.deepLink ?? null, n.data ? JSON.stringify(n.data) : null]);
    rows.forEach((r) => this.rt.toUser(r.user_id, 'notification:new', { id: r.id, ...n, createdAt: new Date() }));
    const result = new Map<string, boolean>();
    if (opts.push !== false) for (const id of userIds) result.set(id, await this.push(id, n));
    return result;
  }

  async push(userId: string, n: Notif): Promise<boolean> {
    if (!fcm) return false;
    const toks = (await this.db.rows('SELECT fcm_token FROM device_tokens WHERE user_id=$1', [userId])).map((r) => r.fcm_token);
    if (!toks.length) return false;
    try {
      const res = await fcm.sendEachForMulticast({
        tokens: toks, notification: { title: n.title, body: n.body },
        data: { type: n.type, deepLink: n.deepLink ?? '' }, android: { priority: 'high' },
      });
      res.responses.forEach((r: any, i: number) => {
        if (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code || ''))
          this.db.q('DELETE FROM device_tokens WHERE fcm_token=$1', [toks[i]]).catch(() => {});
      });
      return res.successCount > 0;
    } catch { return false; }
  }
}

@Controller()
export class NotificationsController {
  constructor(private db: Db) {}
  @Get('notifications')
  async list(@Me() me: AuthUser, @Query('limit') limit = '50') {
    const items = await this.db.rows('SELECT id,type,title,body,deep_link AS "deepLink",data,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [me.id, Math.min(+limit || 50, 200)]);
    const c = await this.db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [me.id]);
    return { unread: c.n, items };
  }
  @Post('notifications/:id/read')
  async read(@Me() me: AuthUser, @Param('id') id: string) {
    await this.db.q('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL', [uuid(id, 'id'), me.id]);
    return { ok: true };
  }
  @Post('notifications/read-all')
  async readAll(@Me() me: AuthUser) { await this.db.q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [me.id]); return { ok: true }; }
  @Post('devices')
  async device(@Me() me: AuthUser, @Body() b: any) {
    const t = str(b.fcmToken, 'fcmToken', 4096);
    await this.db.q(`INSERT INTO device_tokens(user_id,fcm_token,platform) VALUES($1,$2,$3)
      ON CONFLICT (fcm_token) DO UPDATE SET user_id=$1, platform=$3`, [me.id, t, str(b.platform, 'platform', 20, false)]);
    return { ok: true };
  }
}
