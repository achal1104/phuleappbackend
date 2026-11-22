CREATE TABLE IF NOT EXISTS emergency_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('medical','fire','venue','security','festival','police','other')),
  name TEXT NOT NULL, phone TEXT NOT NULL, notes TEXT, hall_id INT REFERENCES halls(id),
  sort_order INT NOT NULL DEFAULT 0, created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL, body TEXT NOT NULL, pinned BOOLEAN NOT NULL DEFAULT false,
  target_hall_id INT REFERENCES halls(id), created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ann_recent ON announcements(pinned DESC, created_at DESC) WHERE deleted_at IS NULL;
