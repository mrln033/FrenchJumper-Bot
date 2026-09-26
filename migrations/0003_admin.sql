CREATE TABLE IF NOT EXISTS bot_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  channel_id TEXT NOT NULL,
  publishing INTEGER NOT NULL CHECK(publishing IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS admin_role_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  role_ids TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
