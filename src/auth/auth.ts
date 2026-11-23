import { BadRequestException, Body, Controller, Injectable, Post, Get, UnauthorizedException, ConflictException, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Audit, AuthUser, Db, Me, Public, Realtime, phoneNorm, str } from '../common/core';
import { Notifier } from '../notifications/notifications';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const REFRESH_DAYS = Number(process.env.REFRESH_TTL_DAYS || 365);

@Injectable()
export class AuthService {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private db: Db, private jwt: JwtService, private audit: Audit, private notifier: Notifier) {}

  async issue(userId: string, deviceId: string) {
    const access = await this.jwt.signAsync({ sub: userId }, { expiresIn: process.env.ACCESS_TTL || '15m' });
    const refresh = crypto.randomBytes(48).toString('base64url');
    await this.db.q('INSERT INTO refresh_tokens(user_id,token_hash,device_id,expires_at) VALUES($1,$2,$3,now()+($4||\' days\')::interval)', [userId, sha(refresh), deviceId, String(REFRESH_DAYS)]);
    return { accessToken: access, refreshToken: refresh };
  }
  publicUser(u: any) {
    return { id: u.id, memberId: u.member_id, fullName: u.full_name, role: u.role_code, designation: u.designation, hallId: u.hall_id, phone: u.phone, email: u.email, photoUrl: u.photo_url, canPublishEmergency: u.can_publish_emergency, isVipCoordinator: u.is_vip_coordinator };
  }

  async register(b: any) {
    const name = str(b.fullName, 'fullName', 120)!;
    const phone = phoneNorm(str(b.phone, 'phone', 20, false) ?? undefined);
    const email = str(b.email, 'email', 160, false)?.toLowerCase() ?? null;
    if (!phone && !email) throw new BadRequestException('phone or email required');
    if (phone && !/^\+?\d{10,15}$/.test(phone)) throw new BadRequestException('phone invalid');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('email invalid');
    const pw = str(b.password, 'password', 100)!;
    if (pw.length < 8) throw new BadRequestException('password must be at least 8 characters');
    const hash = await bcrypt.hash(pw, 11);
    try {
      const u = await this.db.one(`INSERT INTO users(member_id,full_name,phone,email,password_hash,status)
        VALUES('PFC-'||lpad(nextval('member_seq')::text,4,'0'),$1,$2,$3,$4,'pending') RETURNING id, member_id, full_name`, [name, phone, email, hash]);
      await this.audit.log(u.id, 'member.register', 'user', u.id);

      const admins = (await this.db.rows(`SELECT id FROM users WHERE role_code='super_admin' AND status='active' AND deleted_at IS NULL`)).map((r: any) => r.id);
      if (admins.length) {
        this.notifier.send(admins, {
          type: 'registration_approval',
          title: 'New member registration approval',
          body: `${name} has requested access. Tap to review.`,
          deepLink: '/approvals',
        }).catch(() => {});
      }
      return { memberId: u.member_id, status: 'pending', message: 'Registration submitted. You will be notified after admin approval.' };
    } catch (e: any) { if (e.code === '23505') throw new ConflictException('Phone or email already registered'); throw e; }
  }

  async login(b: any, ip?: string) {
    const id = str(b.identifier, 'identifier', 160)!; const pw = str(b.password, 'password', 100)!;
    const dev = str(b.deviceId, 'deviceId', 100, false) ?? 'unknown';
    const key = id.includes('@') ? id.toLowerCase() : phoneNorm(id);
    const f = this.fails.get(key!); if (f && f.until > Date.now()) throw new UnauthorizedException('Too many failed attempts. Try again in a few minutes.');
    const u = await this.db.one(`SELECT * FROM users WHERE (${id.includes('@') ? 'email' : 'phone'}=$1) AND deleted_at IS NULL`, [key]);
    const ok = u ? await bcrypt.compare(pw, u.password_hash) : await bcrypt.compare(pw, '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid');
    if (!u || !ok) {
      const cur = this.fails.get(key!) ?? { n: 0, until: 0 }; cur.n++; if (cur.n >= Number(process.env.LOGIN_MAX_FAILS || 8)) { cur.until = Date.now() + 5 * 60000; cur.n = 0; } this.fails.set(key!, cur);
      throw new UnauthorizedException('Invalid credentials');
    }
    this.fails.delete(key!);
    if (u.status === 'pending') throw new UnauthorizedException('Registration is awaiting admin approval');
    if (u.status !== 'active') throw new UnauthorizedException('Account is not active');
    await this.audit.log(u.id, 'auth.login', 'user', u.id, null, { deviceId: dev }, undefined, ip);
    return { ...(await this.issue(u.id, dev)), user: this.publicUser(u) };
  }

  async refresh(b: any) {
    const t = str(b.refreshToken, 'refreshToken', 200)!;
    const row = await this.db.one('SELECT * FROM refresh_tokens WHERE token_hash=$1', [sha(t)]);
    if (!row) throw new UnauthorizedException('Invalid refresh token');
    if (row.revoked_at) { // reuse of rotated token => revoke the whole device chain
      await this.db.q('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL', [row.user_id, row.device_id]);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (new Date(row.expires_at) < new Date()) throw new UnauthorizedException('Session expired, please log in again');
    const u = await this.db.one(`SELECT * FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL`, [row.user_id]);
    if (!u) throw new UnauthorizedException('Account inactive');
    await this.db.q('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [row.id]);
    return this.issue(u.id, row.device_id);
  }
}

@Controller('auth')
export class AuthController {
  constructor(private s: AuthService, private db: Db, private rt: Realtime) {}
  @Public() @Throttle({ default: { limit: Number(process.env.AUTH_IP_LIMIT || 200), ttl: 60000 } }) @Post('register') register(@Body() b: any) { return this.s.register(b); }
  @Public() @Throttle({ default: { limit: Number(process.env.AUTH_IP_LIMIT || 200), ttl: 60000 } }) @Post('login') login(@Body() b: any, @Req() r: any) { return this.s.login(b, r.ip); }
  @Public() @Throttle({ default: { limit: Number(process.env.AUTH_IP_LIMIT || 200), ttl: 60000 } }) @Post('refresh') refresh(@Body() b: any) { return this.s.refresh(b); }
  @Post('logout') async logout(@Me() me: AuthUser, @Body() b: any) {
    const dev = str(b.deviceId, 'deviceId', 100, false);
    await this.db.q(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND ($2::text IS NULL OR device_id=$2)`, [me.id, dev]);
    if (b.fcmToken) await this.db.q('DELETE FROM device_tokens WHERE fcm_token=$1 AND user_id=$2', [b.fcmToken, me.id]);
    return { ok: true };
  }
  @Get('me') async me(@Me() me: AuthUser) { return this.s.publicUser(await this.db.one('SELECT * FROM users WHERE id=$1', [me.id])); }
  @Patch('me/photo') async photo(@Me() me: AuthUser, @Body() b: any) {
    const key = str(b.photoUrl, 'photoUrl', 200);
    await this.db.q('UPDATE users SET photo_url=$2, updated_at=now() WHERE id=$1', [me.id, key]);
    return { ok: true, photoUrl: key };
  }
}
