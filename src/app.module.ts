import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as crypto from 'crypto';

/** Venue Wi-Fi puts hundreds of users behind one IP, so rate-limit per authenticated user, not per IP. */
class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const a: string = req.headers?.authorization;
    return a ? 'u:' + crypto.createHash('sha1').update(a).digest('hex') : 'ip:' + req.ip;
  }
}
import { Audit, AuthGuard, Db, Realtime } from './common/core';
import { Notifier, NotificationsController } from './notifications/notifications';
import { RoomSync } from './chat/rooms.service';
import { AuthController, AuthService } from './auth/auth';
import { AdminUsersController, MembersController } from './users/users';
import { EventsController } from './events/events';
import { ChatController, ChatGateway, ChatService } from './chat/chat';
import { EmergencyController, EmergencyService } from './emergency/emergency';
import { DashboardController } from './dashboard/dashboard';
import { PasswordResetController, HandoverController, LostFoundController, FeedbackController, SearchController, EmergencyContactsController, AnnouncementsController } from './extras/extras';
import { TaskSweeper, TasksController, AttendanceController, VipController, DocumentsController, ResourcesController, ReportsController, AuditController } from './ops/ops';

@Module({
  imports: [
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: Number(process.env.RATE_LIMIT || 300) }]),
  ],
  controllers: [AuthController, AdminUsersController, MembersController, EventsController, ChatController, NotificationsController, EmergencyController, DashboardController, TasksController, AttendanceController, VipController, DocumentsController, ResourcesController, ReportsController, AuditController, PasswordResetController, HandoverController, LostFoundController, FeedbackController, SearchController, EmergencyContactsController, AnnouncementsController],
  providers: [Db, Audit, Realtime, Notifier, RoomSync, AuthService, ChatService, ChatGateway, EmergencyService, TaskSweeper,
    { provide: APP_GUARD, useClass: UserThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
