-- Phase 3: forgot-password requests, shift handover, lost & found, feedback
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  handled_by UUID REFERENCES users(id), handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reset_open ON password_reset_requests(user_id) WHERE status='open';

CREATE TABLE IF NOT EXISTS shift_handovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hall_id INT REFERENCES halls(id), event_id UUID REFERENCES events(id),
  from_user UUID NOT NULL REFERENCES users(id), to_user UUID NOT NULL REFERENCES users(id),
  notes TEXT NOT NULL, checklist JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_handover_to ON shift_handovers(to_user, status);

CREATE TABLE IF NOT EXISTS lost_found (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('lost','found')),
  item TEXT NOT NULL, description TEXT, location TEXT, hall_id INT REFERENCES halls(id),
  photo_key TEXT, reported_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','closed')),
  claimed_by_name TEXT, resolution_notes TEXT, resolved_by UUID REFERENCES users(id), resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lf_status ON lost_found(status, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id), hall_id INT REFERENCES halls(id),
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','operations','communication','safety','suggestion')),
  message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
