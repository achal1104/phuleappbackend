import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import * as multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Audit, AuthUser, Db, Me, Realtime, Roles, loadUser, oneOf, str, uuid, uuids } from '../common/core';
import { Notifier } from '../notifications/notifications';

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MIME: Record<string, string> = {
  'image/jpeg': 'image', 'image/jpg': 'image', 'image/png': 'image', 'image/webp': 'image', 'application/pdf': 'pdf',
  'video/mp4': 'video', 'audio/mpeg': 'voice', 'audio/mp4': 'voice', 'audio/aac': 'voice', 'audio/ogg': 'voice', 'audio/webm': 'voice',
  'application/msword': 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document', 'text/plain': 'document',
};

@Injectable()
export class ChatService {
  constructor(private db: Db, private rt: Realtime, private notifier: Notifier) {}

  /** Throws unless the user is an active member (or super_admin reading a non-direct room). */
  async access(me: AuthUser, roomId: string, write = false) {
    const room = await this.db.one('SELECT * FROM rooms WHERE id=$1', [roomId]);
    if (!room) throw new NotFoundException('Room not found');
    const m = await this.db.one('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2 AND removed_at IS NULL', [roomId, me.id]);
    const adminRead = !write && me.role === 'super_admin' && room.type !== 'direct';
    const canRead = !write && (m || room.type === 'event' || room.type === 'global' || room.type === 'hall_day' || adminRead);
    if (!canRead && !m && !adminRead) throw new ForbiddenException('You do not have access to this room');

    if (write && room.type === 'event' && me.role !== 'super_admin' && me.role !== 'hall_manager' && me.role !== 'core_team') {
      const assigned = await this.db.one('SELECT 1 FROM event_assignments WHERE event_id=$1 AND user_id=$2', [room.event_id, me.id]);
      if (!assigned) throw new ForbiddenException('Only assigned team members of this event can send messages in this chat');
    }
    if (write && room.closed_at) throw new ForbiddenException('Room is closed');
    return room;
  }

  async send(me: AuthUser, roomId: string, d: any) {
    const room = await this.access(me, roomId, true);
    const attachKey = d.attachmentKey ? str(d.attachmentKey, 'attachmentKey', 200) : null;
    let kind = d.kind ?? 'text'; let att: any = null;
    if (d.forwardAtt) { att = d.forwardAtt; kind = MIME[att.mime]; }
    else if (attachKey) {
      const f = path.join(UPLOAD_DIR, path.basename(attachKey));
      if (!attachKey.startsWith(me.id + '_') || !fs.existsSync(f)) throw new BadRequestException('Unknown attachment');
      const meta = JSON.parse(fs.readFileSync(f + '.json', 'utf8')); kind = MIME[meta.mime]; att = { key: attachKey, ...meta };
    }
    oneOf(kind, 'kind', ['text', 'image', 'pdf', 'document', 'video', 'voice']);
    const body = str(d.body, 'body', 4000, !attachKey && !att);
    const replyTo = d.replyTo ? uuid(d.replyTo, 'replyTo') : null;
    if (replyTo && !(await this.db.one('SELECT 1 FROM messages WHERE id=$1 AND room_id=$2', [replyTo, roomId]))) throw new BadRequestException('replyTo not in this room');
    const msg = await this.db.tx(async (c) => {
      const m = (await c.query('INSERT INTO messages(room_id,sender_id,body,kind,reply_to,forwarded_from) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [roomId, me.id, body, kind, replyTo, d.forwardedFrom ?? null])).rows[0];
      if (att) {
        let fileBuffer: Buffer | null = null;
        const fp = path.join(UPLOAD_DIR, path.basename(att.key));
        if (fs.existsSync(fp)) fileBuffer = fs.readFileSync(fp);
        await c.query('INSERT INTO message_attachments(message_id,storage_key,file_name,mime_type,size_bytes,data) VALUES($1,$2,$3,$4,$5,$6)', [m.id, att.key, att.name, att.mime, att.size, fileBuffer]);
      }
      const members = (await c.query('SELECT user_id FROM room_members WHERE room_id=$1 AND removed_at IS NULL AND user_id<>$2', [roomId, me.id])).rows.map((r) => r.user_id);
      await c.query(`INSERT INTO message_receipts(message_id,user_id,delivered_at) SELECT $1,u, CASE WHEN u = ANY($3::uuid[]) THEN now() END FROM unnest($2::uuid[]) u`, [m.id, members, members.filter((u) => this.rt.isOnline(u))]);
      return { m, members };
    });
    const out = { id: msg.m.id, roomId, senderId: me.id, senderName: me.name, body, kind, replyTo, createdAt: msg.m.created_at, attachment: att ? { key: att.key, name: att.name, mime: att.mime, size: att.size } : null };
    this.rt.toRoom(roomId, 'message:new', out);
    if (msg.members.length) {
      this.notifier.send(msg.members, {
        type: 'chat_message',
        title: room.type === 'direct' ? me.name : `${room.name} • ${me.name}`,
        body: (body ?? '[attachment]').slice(0, 120),
        deepLink: `/chat/${roomId}`,
        data: { roomId }
      }).catch(() => {});
    }
    return out;
  }

  async markRead(me: AuthUser, roomId: string) {
    await this.access(me, roomId);
    await this.db.q('UPDATE room_members SET last_read_at=now() WHERE room_id=$1 AND user_id=$2', [roomId, me.id]);
    const r = await this.db.rows(`UPDATE message_receipts SET read_at=now(), delivered_at=COALESCE(delivered_at,now()) WHERE user_id=$2 AND read_at IS NULL
      AND message_id IN (SELECT id FROM messages WHERE room_id=$1) RETURNING message_id`, [roomId, me.id]);
    if (r.length) this.rt.toRoom(roomId, 'message:status', { roomId, userId: me.id, status: 'read', messageIds: r.map((x) => x.message_id) });
    return { read: r.length };
  }
}

@Controller()
export class ChatController {
  constructor(private db: Db, private chat: ChatService, private rt: Realtime, private audit: Audit) {}

  @Get('rooms') async rooms(@Me() me: AuthUser) {
    const rows = await this.db.rows(`SELECT r.id, r.type, r.name, r.hall_id AS "hallId", r.day_id AS "dayId", r.event_id AS "eventId", r.closed_at AS "closedAt",
        (SELECT count(*)::int FROM messages m WHERE m.room_id=r.id AND m.created_at > rm.last_read_at AND m.sender_id<>$1 AND m.deleted_at IS NULL) AS unread,
        (SELECT json_build_object('body',m.body,'kind',m.kind,'at',m.created_at) FROM messages m WHERE m.room_id=r.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage",
        CASE WHEN r.type='direct' THEN (SELECT u.full_name FROM room_members o JOIN users u ON u.id=o.user_id WHERE o.room_id=r.id AND o.user_id<>$1 LIMIT 1) END AS "peerName"
      FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$1 AND rm.removed_at IS NULL
      ORDER BY (r.type='global') DESC, r.type, r.name`, [me.id]);
    return rows.map((r) => ({ ...r, name: r.peerName ?? r.name }));
  }

  @Get('rooms/:id/messages') async history(@Me() me: AuthUser, @Param('id') id: string, @Query('before') before?: string, @Query('limit') limit = '50') {
    uuid(id, 'id'); await this.chat.access(me, id);
    return (await this.db.rows(`SELECT m.id, m.sender_id AS "senderId", u.full_name AS "senderName", m.body, m.kind, m.reply_to AS "replyTo", m.forwarded_from AS "forwardedFrom",
        m.pinned_at AS "pinnedAt", m.created_at AS "createdAt",
        (SELECT json_build_object('key',a.storage_key,'name',a.file_name,'mime',a.mime_type,'size',a.size_bytes) FROM message_attachments a WHERE a.message_id=m.id LIMIT 1) AS attachment,
        (SELECT COALESCE(json_object_agg(emoji, n),'{}') FROM (SELECT emoji, count(*) n FROM message_reactions WHERE message_id=m.id GROUP BY emoji) x) AS reactions,
        (SELECT count(*)::int FROM message_receipts r WHERE r.message_id=m.id AND r.delivered_at IS NOT NULL) AS "deliveredCount",
        (SELECT count(*)::int FROM message_receipts r WHERE r.message_id=m.id AND r.read_at IS NOT NULL) AS "readCount"
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.room_id=$1 AND m.deleted_at IS NULL AND ($2::timestamptz IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC LIMIT $3`, [id, before ?? null, Math.min(+limit || 50, 100)])).reverse();
  }

  @Post('rooms/:id/messages') send(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) { return this.chat.send(me, uuid(id, 'id'), b); }
  @Post('rooms/:id/read') read(@Me() me: AuthUser, @Param('id') id: string) { return this.chat.markRead(me, uuid(id, 'id')); }

  @Get('rooms/:id/search') async search(@Me() me: AuthUser, @Param('id') id: string, @Query('q') q = '') {
    uuid(id, 'id'); await this.chat.access(me, id); if (q.length < 2) throw new BadRequestException('q too short');
    return this.db.rows(`SELECT m.id, m.body, m.created_at AS "createdAt", u.full_name AS "senderName" FROM messages m JOIN users u ON u.id=m.sender_id
      WHERE m.room_id=$1 AND m.deleted_at IS NULL AND m.body ILIKE '%'||$2||'%' ORDER BY m.created_at DESC LIMIT 50`, [id, q.slice(0, 80)]);
  }

  @Post('dm') async dm(@Me() me: AuthUser, @Body() b: any) {
    const other = uuid(b.userId, 'userId'); if (other === me.id) throw new BadRequestException('Cannot DM yourself');
    if (!(await this.db.one(`SELECT 1 FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL`, [other]))) throw new NotFoundException('User not found');
    const key = [me.id, other].sort().join(':');
    const room = await this.db.tx(async (c) => {
      let r = (await c.query('SELECT id FROM rooms WHERE direct_key=$1', [key])).rows[0];
      if (!r) {
        r = (await c.query(`INSERT INTO rooms(type,name,direct_key,created_by) VALUES('direct','Direct message',$1,$2) RETURNING id`, [key, me.id])).rows[0];
        await c.query('INSERT INTO room_members(room_id,user_id) VALUES($1,$2),($1,$3)', [r.id, me.id, other]);
      }
      return r;
    });
    this.rt.joinRoom(me.id, room.id); this.rt.joinRoom(other, room.id); this.rt.toUser(other, 'room:added', { roomId: room.id });
    return { roomId: room.id };
  }

  // ----- message actions
  private async msgRoom(me: AuthUser, messageId: string, write = false) {
    const m = await this.db.one('SELECT * FROM messages WHERE id=$1 AND deleted_at IS NULL', [uuid(messageId, 'id')]);
    if (!m) throw new NotFoundException(); await this.chat.access(me, m.room_id, write); return m;
  }
  @Post('messages/:id/pin') async pin(@Me() me: AuthUser, @Param('id') id: string) {
    const m = await this.msgRoom(me, id, true); if (me.rank < 60) throw new ForbiddenException('Only managers can pin');
    await this.db.q('UPDATE messages SET pinned_at=CASE WHEN pinned_at IS NULL THEN now() END, pinned_by=$2 WHERE id=$1', [id, me.id]);
    this.rt.toRoom(m.room_id, 'message:pinned', { messageId: id, pinned: !m.pinned_at }); return { ok: true };
  }
  @Post('messages/:id/react') async react(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    const m = await this.msgRoom(me, id, true); const e = str(b.emoji, 'emoji', 16)!;
    const del = await this.db.q('DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [id, me.id, e]);
    if (!del.rowCount) await this.db.q('INSERT INTO message_reactions VALUES($1,$2,$3)', [id, me.id, e]);
    this.rt.toRoom(m.room_id, 'message:reaction', { messageId: id, userId: me.id, emoji: e, added: !del.rowCount }); return { ok: true };
  }
  @Post('messages/:id/report') async report(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    await this.msgRoom(me, id);
    const r = await this.db.q('INSERT INTO message_reports(message_id,reporter_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, me.id, str(b.reason, 'reason', 300, false)]);
    if (r.rowCount) await this.db.q('UPDATE messages SET reported_count=reported_count+1 WHERE id=$1', [id]);
    return { ok: true };
  }
  @Post('messages/:id/forward') async forward(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    const m = await this.msgRoom(me, id); const targets = uuids(b.roomIds, 'roomIds'); if (!targets.length || targets.length > 5) throw new BadRequestException('1-5 roomIds');
    const att = await this.db.one('SELECT * FROM message_attachments WHERE message_id=$1', [id]);
    const forwardAtt = att ? { key: att.storage_key, name: att.file_name, mime: att.mime_type, size: att.size_bytes } : undefined;
    const out = []; for (const t of targets) out.push(await this.chat.send(me, t, { body: m.body, forwardedFrom: id, forwardAtt })); return out;
  }
  @Patch('messages/:id') async editMessage(@Me() me: AuthUser, @Param('id') id: string, @Body() b: any) {
    uuid(id, 'id');
    const msg = await this.db.one('SELECT * FROM messages WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!msg) throw new NotFoundException();
    await this.chat.access(me, msg.room_id, true);
    if (msg.sender_id !== me.id && me.role !== 'super_admin') throw new ForbiddenException('You can only edit your own messages');
    const newBody = str(b.body, 'body', 4000)!;
    await this.db.q('UPDATE messages SET body=$2, updated_at=now() WHERE id=$1', [id, newBody]);
    this.rt.toRoom(msg.room_id, 'message:updated', { messageId: id, body: newBody });
    return { ok: true, body: newBody };
  }

  @Delete('messages/:id') async deleteMessage(@Me() me: AuthUser, @Param('id') id: string) {
    uuid(id, 'id');
    const msg = await this.db.one('SELECT * FROM messages WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!msg) throw new NotFoundException();
    await this.chat.access(me, msg.room_id, true);
    if (msg.sender_id !== me.id && me.role !== 'super_admin' && me.role !== 'hall_manager' && me.role !== 'core_team') {
      throw new ForbiddenException('Not authorized to delete this message');
    }
    await this.db.q('UPDATE messages SET deleted_at=now() WHERE id=$1', [id]);
    await this.audit.log(me.id, 'message.delete', 'message', id);
    this.rt.toRoom(msg.room_id, 'message:deleted', { messageId: id });
    return { ok: true };
  }
  @Get('admin/reports') @Roles('super_admin') reports() {
    return this.db.rows(`SELECT m.id, m.body, m.reported_count AS "reportedCount", m.room_id AS "roomId", u.full_name AS "senderName" FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.reported_count>0 AND m.deleted_at IS NULL ORDER BY m.reported_count DESC LIMIT 100`);
  }

  // ----- custom rooms / closing (admin)
  @Post('rooms') @Roles('super_admin') async create(@Me() me: AuthUser, @Body() b: any) {
    const name = str(b.name, 'name', 120)!; const members = uuids(b.memberIds, 'memberIds');
    const r = await this.db.tx(async (c) => {
      const room = (await c.query(`INSERT INTO rooms(type,name,created_by) VALUES('custom',$1,$2) RETURNING id`, [name, me.id])).rows[0];
      await c.query(`INSERT INTO room_members(room_id,user_id) SELECT $1,u FROM unnest($2::uuid[]) u JOIN users x ON x.id=u AND x.status='active' ON CONFLICT DO NOTHING`, [room.id, [...members, me.id]]);
      await this.audit.log(me.id, 'room.create', 'room', room.id, null, { name }, c); return room;
    });
    [...members, me.id].forEach((u) => { this.rt.joinRoom(u, r.id); this.rt.toUser(u, 'room:added', { roomId: r.id }); }); return r;
  }
  @Post('rooms/:id/close') @Roles('super_admin') async close(@Me() me: AuthUser, @Param('id') id: string) {
    await this.db.q('UPDATE rooms SET closed_at=now() WHERE id=$1', [uuid(id, 'id')]); await this.audit.log(me.id, 'room.close', 'room', id); return { ok: true };
  }

  // ----- uploads (validated, stored privately, served only to authorised users)
  @Post('uploads') @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }))
  async upload(@Me() me: AuthUser, @UploadedFile() f: any) {
    if (!f) throw new BadRequestException('file required');
    if (f.mimetype === 'image/jpg') f.mimetype = 'image/jpeg';
    if (!MIME[f.mimetype]) throw new BadRequestException('File type not allowed');
    const ext = path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const key = `${me.id}_${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, key), f.buffer);
    fs.writeFileSync(path.join(UPLOAD_DIR, key + '.json'), JSON.stringify({ name: f.originalname.slice(0, 200), mime: f.mimetype, size: f.size }));
    return { key, kind: MIME[f.mimetype] };
  }
  @Get('files/:key') async file(@Me() me: AuthUser, @Param('key') key: string, @Res() res: any) {
    key = path.basename(key);
    const att = await this.db.one('SELECT mime_type, file_name, data FROM message_attachments WHERE storage_key=$1 LIMIT 1', [key]);
    if (att && att.data) {
      res.setHeader('Content-Type', att.mime_type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.file_name || 'file')}"`);
      return res.send(att.data);
    }
    const fp = path.join(UPLOAD_DIR, key); if (!fs.existsSync(fp)) throw new NotFoundException();
    let ok = key.startsWith(me.id + '_') || me.role === 'super_admin';
    if (!ok) {
      const roomCheck = await this.db.one(`
        SELECT r.type FROM message_attachments a
        JOIN messages m ON m.id=a.message_id AND m.deleted_at IS NULL
        JOIN rooms r ON r.id=m.room_id
        WHERE a.storage_key=$1 LIMIT 1
      `, [key]);
      if (roomCheck) {
        if (['global', 'hall_day', 'event'].includes(roomCheck.type)) {
          ok = true;
        } else {
          ok = !!(await this.db.one(`SELECT 1 FROM message_attachments a JOIN messages m ON m.id=a.message_id AND m.deleted_at IS NULL
            JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2 AND rm.removed_at IS NULL WHERE a.storage_key=$1 LIMIT 1`, [key, me.id]));
        }
      }
    }
    if (!ok) throw new ForbiddenException();
    const meta = JSON.parse(fs.readFileSync(fp + '.json', 'utf8'));
    res.setHeader('Content-Type', meta.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.name)}"`);
    return res.sendFile(fp);
  }
}

@WebSocketGateway({ cors: { origin: true }, pingInterval: 20000, pingTimeout: 20000 })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private buckets = new Map<string, { n: number; t: number }>();
  constructor(private rt: Realtime, private db: Db, private jwt: JwtService, private chat: ChatService) {}
  afterInit(server: Server) { this.rt.server = server; }

  async handleConnection(s: Socket) {
    try {
      const token = (s.handshake.auth?.token as string) || '';
      const p = await this.jwt.verifyAsync(token); const u = await loadUser(this.db, p.sub);
      if (!u) throw new Error('inactive');
      (s.data as any).user = u; s.join('u:' + u.id);
      const rooms = await this.db.rows('SELECT room_id FROM room_members WHERE user_id=$1 AND removed_at IS NULL', [u.id]);
      rooms.forEach((r) => s.join('r:' + r.room_id));
      this.rt.online.set(u.id, (this.rt.online.get(u.id) || 0) + 1);
      s.emit('ready', { userId: u.id, rooms: rooms.length });
    } catch { s.emit('error', { message: 'unauthorized' }); s.disconnect(true); }
  }
  handleDisconnect(s: Socket) {
    const u = (s.data as any).user; if (!u) return;
    const n = (this.rt.online.get(u.id) || 1) - 1; n <= 0 ? this.rt.online.delete(u.id) : this.rt.online.set(u.id, n);
  }
  private limited(id: string) { // spam protection: 20 msgs / 10 s per user
    const now = Date.now(); const b = this.buckets.get(id); if (!b || now - b.t > 10000) { this.buckets.set(id, { n: 1, t: now }); return false; }
    return ++b.n > 20;
  }
  @SubscribeMessage('message:send')
  async onSend(@ConnectedSocket() s: Socket, @MessageBody() d: any) {
    const u: AuthUser = (s.data as any).user; if (!u) return { ok: false, error: 'unauthorized' };
    if (this.limited(u.id)) return { ok: false, error: 'rate_limited' };
    try { return { ok: true, message: await this.chat.send(u, d?.roomId, d) }; } catch (e: any) { return { ok: false, error: e.message }; }
  }
  @SubscribeMessage('room:read')
  async onRead(@ConnectedSocket() s: Socket, @MessageBody() d: any) {
    const u: AuthUser = (s.data as any).user; try { return { ok: true, ...(await this.chat.markRead(u, d?.roomId)) }; } catch (e: any) { return { ok: false, error: e.message }; }
  }
  @SubscribeMessage('typing')
  onTyping(@ConnectedSocket() s: Socket, @MessageBody() d: any) {
    const u: AuthUser = (s.data as any).user; if (u && s.rooms.has('r:' + d?.roomId)) s.to('r:' + d.roomId).emit('typing', { roomId: d.roomId, userId: u.id, name: u.name });
  }
}
