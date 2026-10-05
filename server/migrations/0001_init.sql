CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    callsign TEXT NOT NULL UNIQUE,
    default_station_id TEXT REFERENCES stations (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE passkeys (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    credential_id BLOB NOT NULL UNIQUE,
    passkey TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);

CREATE INDEX passkeys_user_id ON passkeys (user_id);

CREATE TABLE bootstrap_tokens (
    token_hash BLOB PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE wavelog_settings (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    api_token TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE stations (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- NULL for stations entered by hand.
    wavelog_id INTEGER,
    name TEXT NOT NULL,
    callsign TEXT NOT NULL,
    gridsquare TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    cnty TEXT NOT NULL DEFAULT '',
    pota TEXT NOT NULL DEFAULT '',
    sota TEXT NOT NULL DEFAULT '',
    wwff TEXT NOT NULL DEFAULT '',
    iota TEXT NOT NULL DEFAULT '',
    sig TEXT NOT NULL DEFAULT '',
    sig_info TEXT NOT NULL DEFAULT '',
    power INTEGER,
    active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, wavelog_id)
);

CREATE TABLE qsos (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    forwarded_at TEXT,
    wavelog_qso_id INTEGER,
    forward_error TEXT,
    PRIMARY KEY (user_id, id)
);
