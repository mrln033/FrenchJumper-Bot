CREATE TABLE IF NOT EXISTS entropia_poll_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    cursor_at TEXT,
    roster_refreshed_at TEXT,
    lease_until TEXT,
    last_run_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    last_stats TEXT
);

INSERT OR IGNORE INTO entropia_poll_state (singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS entropia_active_members (
    normalized_name TEXT PRIMARY KEY,
    avatar_name TEXT NOT NULL,
    member_id TEXT,
    grade TEXT,
    sync_token TEXT NOT NULL,
    synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entropia_polled_globals (
    global_id INTEGER PRIMARY KEY,
    avatar_name TEXT NOT NULL,
    global_type TEXT,
    value_ped REAL,
    occurred_at TEXT NOT NULL,
    is_hof INTEGER NOT NULL DEFAULT 0,
    is_ath INTEGER NOT NULL DEFAULT 0,
    is_team INTEGER NOT NULL DEFAULT 0,
    detail_route TEXT,
    payload TEXT NOT NULL,
    publish_status TEXT NOT NULL
        CHECK (publish_status IN ('observed', 'pending', 'published', 'failed')),
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    discord_channel_id TEXT,
    discord_message_id TEXT,
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_entropia_polled_globals_publish
    ON entropia_polled_globals (publish_status, next_attempt_at, occurred_at);

CREATE INDEX IF NOT EXISTS idx_entropia_polled_globals_occurred
    ON entropia_polled_globals (occurred_at);
