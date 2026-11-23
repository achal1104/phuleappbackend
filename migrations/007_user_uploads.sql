CREATE TABLE IF NOT EXISTS user_uploads (
  storage_key TEXT PRIMARY KEY,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  data BYTEA,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
