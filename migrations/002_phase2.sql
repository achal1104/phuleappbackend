ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tasks_hall ON tasks(hall_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_day ON attendance(day);
CREATE INDEX IF NOT EXISTS idx_alloc_open ON resource_allocations(resource_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_docs_cat ON documents(category) WHERE deleted_at IS NULL;
