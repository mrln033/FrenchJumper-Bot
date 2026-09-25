CREATE TABLE IF NOT EXISTS entropia_central_deliveries (
    delivery_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entropia_central_globals (
    delivery_id TEXT PRIMARY KEY
        REFERENCES entropia_central_deliveries(delivery_id),
    event_name TEXT NOT NULL,
    sent_at TEXT,
    trigger_data TEXT,
    message TEXT,
    global_id INTEGER,
    global_type TEXT,
    value_ped REAL,
    is_hof INTEGER,
    is_ath INTEGER,
    is_team INTEGER,
    occurred_at TEXT,
    society_name TEXT,
    avatar TEXT,
    creature TEXT,
    deposit TEXT,
    landarea TEXT,
    item TEXT,
    tier REAL,
    payload TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
