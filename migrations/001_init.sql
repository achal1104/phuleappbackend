-- PHULE FESTIVAL 2026 - COMMAND : initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE roles (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, rank INT NOT NULL);
INSERT INTO roles(code,name,rank) VALUES
 ('super_admin','Super Admin',100),('core_team','Core Team',90),('hall_manager','Hall Manager',70),
 ('event_manager','Event Manager',60),('management','Management Member',40),('volunteer','Volunteer',10);

CREATE TABLE permissions (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, description TEXT);
CREATE TABLE role_permissions (
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INT REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY(role_id, permission_id)
);

CREATE TABLE halls (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'operational', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE TABLE festival_days (id SERIAL PRIMARY KEY, day DATE UNIQUE NOT NULL, label TEXT NOT NULL);
INSERT INTO halls(code,name) VALUES ('A','Hall A'),('B','Hall B'),('C','Hall C'),('D','Hall D');
INSERT INTO festival_days(day,label) VALUES ('2026-11-27','27 November'),('2026-11-28','28 November'),('2026-11-29','29 November');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT UNIQUE, email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role_code TEXT NOT NULL REFERENCES roles(code) DEFAULT 'volunteer',
  designation TEXT,
  hall_id INT REFERENCES halls(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','deactivated')),
  photo_url TEXT,
  can_publish_emergency BOOLEAN NOT NULL DEFAULT false,
  is_vip_coordinator BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX idx_users_role ON users(role_code) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_hall ON users(hall_id);
CREATE INDEX idx_users_name_trgm ON users USING gin (full_name gin_trgm_ops);
CREATE SEQUENCE member_seq START 1;

CREATE TABLE user_roles (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE, role_id INT REFERENCES roles(id),
  assigned_by UUID REFERENCES users(id), assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, role_id)
);
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL DEFAULT 'unknown',
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rt_user ON refresh_tokens(user_id);
CREATE TABLE device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT UNIQUE NOT NULL, platform TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dt_user ON device_tokens(user_id);

CREATE TABLE teams (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, hall_id INT REFERENCES halls(id),
  leader_id UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE TABLE team_members (
  team_id INT REFERENCES teams(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(team_id,user_id)
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hall_id INT NOT NULL REFERENCES halls(id), day_id INT NOT NULL REFERENCES festival_days(id),
  title TEXT NOT NULL, description TEXT, technical_requirements TEXT, rehearsal_schedule TEXT,
  start_time TIMESTAMPTZ NOT NULL, end_time TIMESTAMPTZ NOT NULL, seq INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','ongoing','completed','postponed','cancelled')),
  progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CHECK (end_time > start_time)
);
CREATE INDEX idx_events_hall_day ON events(hall_id, day_id, seq) WHERE deleted_at IS NULL;
CREATE TABLE event_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_role TEXT NOT NULL CHECK (assignment_role IN ('manager','volunteer')),
  assigned_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id,user_id)
);
CREATE INDEX idx_ea_user ON event_assignments(user_id);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('global','hall_day','event','direct','vip','custom')),
  name TEXT NOT NULL, hall_id INT REFERENCES halls(id), day_id INT REFERENCES festival_days(id),
  event_id UUID REFERENCES events(id), direct_key TEXT UNIQUE,
  closed_at TIMESTAMPTZ, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_room_event ON rooms(event_id) WHERE type='event';
CREATE UNIQUE INDEX uq_room_hall_day ON rooms(hall_id, day_id) WHERE type='hall_day';
CREATE UNIQUE INDEX uq_room_global ON rooms(type) WHERE type='global';
CREATE TABLE room_members (
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), removed_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,user_id)
);
CREATE INDEX idx_rm_user ON room_members(user_id) WHERE removed_at IS NULL;

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  body TEXT, kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','pdf','document','video','voice','system')),
  reply_to UUID REFERENCES messages(id), forwarded_from UUID REFERENCES messages(id),
  pinned_at TIMESTAMPTZ, pinned_by UUID REFERENCES users(id), reported_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_msg_room_time ON messages(room_id, created_at DESC);
CREATE INDEX idx_msg_body_trgm ON messages USING gin (body gin_trgm_ops);
CREATE TABLE message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL, file_name TEXT, mime_type TEXT, size_bytes BIGINT
);
CREATE TABLE message_receipts (
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ, read_at TIMESTAMPTZ, PRIMARY KEY(message_id,user_id)
);
CREATE TABLE message_reactions (
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL, PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE message_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id), reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(message_id,reporter_id)
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL, description TEXT, team_id INT REFERENCES teams(id),
  hall_id INT REFERENCES halls(id), event_id UUID REFERENCES events(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  deadline TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','accepted','in_progress','completed','verified')),
  completion_notes TEXT, attachment_key TEXT,
  created_by UUID REFERENCES users(id), verified_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_tasks_status ON tasks(status, deadline);
CREATE TABLE task_assignments (
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id,user_id)
);

CREATE TABLE qr_checkin_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL, location TEXT NOT NULL, hall_id INT REFERENCES halls(id),
  shift TEXT NOT NULL, valid_from TIMESTAMPTZ NOT NULL, valid_to TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ
);
CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id), day DATE NOT NULL,
  qr_id UUID REFERENCES qr_checkin_codes(id), shift TEXT NOT NULL,
  check_in_at TIMESTAMPTZ NOT NULL DEFAULT now(), check_out_at TIMESTAMPTZ,
  UNIQUE(user_id, day, shift)
);

CREATE TABLE emergency_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('critical','medical','security','crowd','technical','stage','vip_protocol','general_urgent')),
  title TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT,
  priority TEXT NOT NULL DEFAULT 'high' CHECK (priority IN ('critical','high','medium')),
  location TEXT, target_type TEXT NOT NULL CHECK (target_type IN ('all','hall','team','event')),
  target_hall_id INT REFERENCES halls(id), target_team_id INT REFERENCES teams(id), target_event_id UUID REFERENCES events(id),
  issued_by UUID NOT NULL REFERENCES users(id),
  escalate_after_sec INT NOT NULL DEFAULT 180, escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE emergency_acknowledgements (
  alert_id UUID REFERENCES emergency_alerts(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','delivered','failed')),
  push_attempts INT NOT NULL DEFAULT 0, PRIMARY KEY(alert_id,user_id)
);
CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL, category TEXT NOT NULL, description TEXT, photo_key TEXT, location TEXT,
  hall_id INT REFERENCES halls(id), reported_by UUID NOT NULL REFERENCES users(id),
  response_manager_id UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','responding','resolved')),
  resolution_notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, deep_link TEXT, data JSONB,
  read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL, category TEXT, storage_key TEXT NOT NULL, mime_type TEXT, size_bytes BIGINT,
  hall_id INT REFERENCES halls(id), min_role_rank INT NOT NULL DEFAULT 10,
  uploaded_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE TABLE resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, category TEXT NOT NULL, quantity INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE resource_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id), hall_id INT REFERENCES halls(id), event_id UUID REFERENCES events(id),
  responsible_user_id UUID REFERENCES users(id), qty INT NOT NULL DEFAULT 1,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(), returned_at TIMESTAMPTZ
);
CREATE TABLE vip_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('itinerary','guest','transport','stage','seating','green_room','hospitality','medical','arrival')),
  title TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', status TEXT,
  created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vip_assignments (
  vip_record_id UUID REFERENCES vip_records(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  duty TEXT, PRIMARY KEY(vip_record_id,user_id)
);
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, actor_id UUID REFERENCES users(id), action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, old_value JSONB, new_value JSONB, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_time ON audit_logs(created_at DESC);

INSERT INTO rooms(type,name) VALUES ('global','PHULE FESTIVAL 2026 – Global');
INSERT INTO rooms(type,name,hall_id,day_id)
 SELECT 'hall_day', h.name || ' – ' || d.label, h.id, d.id FROM halls h CROSS JOIN festival_days d;
