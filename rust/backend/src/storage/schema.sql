-- Fresh native schema. No legacy rows or historical migrations are imported.
CREATE TABLE app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_radio_contacts INTEGER DEFAULT 200,
    auto_decrypt_dm_on_advert INTEGER DEFAULT 1,
    last_message_times TEXT DEFAULT '{}',
    preferences_migrated INTEGER DEFAULT 0,
    advert_interval INTEGER DEFAULT 0,
    last_advert_time INTEGER DEFAULT 0,
    flood_scope TEXT DEFAULT '',
    blocked_keys TEXT DEFAULT '[]',
    blocked_names TEXT DEFAULT '[]',
    discovery_blocked_types TEXT DEFAULT '[]',
    tracked_telemetry_repeaters TEXT DEFAULT '[]',
    auto_resend_channel INTEGER DEFAULT 0,
    telemetry_interval_hours INTEGER DEFAULT 8,
    vapid_private_key TEXT DEFAULT '',
    vapid_public_key TEXT DEFAULT '',
    push_conversations TEXT DEFAULT '[]'
, telemetry_routed_hourly INTEGER DEFAULT 0, tracked_telemetry_contacts TEXT DEFAULT '[]', known_regions TEXT);

CREATE TABLE channels (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_hashtag INTEGER DEFAULT 0,
    on_radio INTEGER DEFAULT 0,
    flood_scope_override TEXT,
    path_hash_mode_override INTEGER,
    last_read_at INTEGER,
    last_read_message_id INTEGER,
    favorite INTEGER DEFAULT 0,
    muted INTEGER DEFAULT 0
);

CREATE TABLE community_observed_neighbors (
    public_key TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_discovery_at INTEGER,
    source TEXT NOT NULL,
    node_type TEXT NOT NULL,
    local_snr REAL,
    local_rssi INTEGER,
    remote_snr REAL,
    scope_names TEXT,
    scope_queried_at INTEGER,
    scope_status TEXT NOT NULL DEFAULT 'not_queried'
);

CREATE TABLE companion_channel_datagrams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    channel_idx INTEGER NOT NULL,
    data_type INTEGER NOT NULL,
    payload BLOB NOT NULL,
    snr REAL,
    path_len INTEGER,
    identity_hash BLOB NOT NULL UNIQUE,
    attribution_status TEXT NOT NULL DEFAULT 'unresolved'
);

CREATE TABLE "contact_advert_paths" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_key TEXT NOT NULL,
                path_hex TEXT NOT NULL,
                path_len INTEGER NOT NULL,
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                heard_count INTEGER NOT NULL DEFAULT 1,
                UNIQUE(public_key, path_hex, path_len),
                FOREIGN KEY (public_key) REFERENCES contacts(public_key) ON DELETE CASCADE
            );

CREATE TABLE "contact_name_history" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_key TEXT NOT NULL,
                name TEXT NOT NULL,
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                UNIQUE(public_key, name),
                FOREIGN KEY (public_key) REFERENCES contacts(public_key) ON DELETE CASCADE
            );

CREATE TABLE contact_telemetry_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_key TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY (public_key) REFERENCES contacts(public_key) ON DELETE CASCADE
            );

CREATE TABLE "contacts" (
            public_key TEXT PRIMARY KEY,
            name TEXT,
            type INTEGER DEFAULT 0,
            flags INTEGER DEFAULT 0,
            direct_path TEXT,
            direct_path_len INTEGER,
            direct_path_hash_mode INTEGER,
            direct_path_updated_at INTEGER,
            route_override_path TEXT,
            route_override_len INTEGER,
            route_override_hash_mode INTEGER,
            last_advert INTEGER,
            lat REAL,
            lon REAL,
            last_seen INTEGER,
            on_radio INTEGER DEFAULT 0,
            last_contacted INTEGER,
            first_seen INTEGER,
            last_read_at INTEGER
        , favorite INTEGER DEFAULT 0, last_read_message_id INTEGER);

CREATE TABLE fanout_configs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    scope TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    text TEXT NOT NULL,
    sender_timestamp INTEGER,
    received_at INTEGER NOT NULL,
    paths TEXT,
    txt_type INTEGER DEFAULT 0,
    signature TEXT,
    outgoing INTEGER DEFAULT 0,
    acked INTEGER DEFAULT 0,
    send_status TEXT NOT NULL DEFAULT 'confirmed',
    sender_name TEXT,
    sender_key TEXT,
    wire_packet_id INTEGER
    -- Deduplication: channel echoes/repeats use a content/time unique index so
    -- duplicate observations reconcile onto a single stored row. Legacy
    -- databases may also gain an incoming-DM content index via migration 44.
    -- Enforced via idx_messages_dedup_null_safe (unique index) rather than a table constraint
    -- to avoid the storage overhead of SQLite's autoindex duplicating every message text.
, transport_code INTEGER, region TEXT);

CREATE TABLE pending_dm_ack_correlations (
    code TEXT PRIMARY KEY,
    message_id INTEGER NOT NULL,
    radio_key TEXT NOT NULL,
    expiry_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE pending_radio_ingress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('CHAN', 'PRIV')),
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unresolved',
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_success_at INTEGER,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(endpoint)
);

CREATE TABLE "raw_packets" (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, data BLOB NOT NULL, message_id INTEGER, payload_hash BLOB, FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL);

CREATE TABLE repeater_telemetry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (public_key) REFERENCES contacts(public_key) ON DELETE CASCADE
);

CREATE TABLE virtual_companion_channel_sends (
            identity_key TEXT NOT NULL,
            virtual_index INTEGER NOT NULL CHECK (virtual_index BETWEEN 0 AND 255),
            sender_timestamp INTEGER NOT NULL CHECK (sender_timestamp BETWEEN 0 AND 4294967295),
            text_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'uncertain')),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (identity_key, virtual_index, sender_timestamp, text_hash)
        );

CREATE TABLE virtual_companion_contact_changes (
    public_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1))
);

CREATE TABLE virtual_companion_contact_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL
);

CREATE INDEX idx_contact_advert_paths_recent ON contact_advert_paths(public_key, last_seen DESC);

CREATE INDEX idx_contact_name_history_key ON contact_name_history(public_key, last_seen DESC);

CREATE INDEX idx_contact_telemetry_pk_ts
                ON contact_telemetry_history(public_key, timestamp)
            ;

CREATE INDEX idx_contacts_public_key_lower ON contacts(lower(public_key));

CREATE INDEX idx_contacts_type_last_seen ON contacts(type, last_seen);

CREATE INDEX idx_dm_ack_expiry ON pending_dm_ack_correlations(expiry_at);

CREATE UNIQUE INDEX idx_fanout_virtual_companion_singleton
    ON fanout_configs(type) WHERE type = 'virtual_companion_tcp';

CREATE INDEX idx_messages_content_fallback ON messages(type,conversation_key,sender_timestamp);

CREATE INDEX idx_messages_pagination ON messages(type, conversation_key, received_at DESC, id DESC);

CREATE INDEX idx_messages_received ON messages(received_at);

CREATE INDEX idx_messages_sender_key ON messages(sender_key);

CREATE INDEX idx_messages_type_received_conversation
                ON messages(type, received_at, conversation_key)
                ;

CREATE INDEX idx_messages_unread_covering ON messages(type, conversation_key, outgoing, received_at);

CREATE UNIQUE INDEX idx_messages_wire_identity ON messages(type,conversation_key,wire_packet_id) WHERE wire_packet_id IS NOT NULL;

CREATE INDEX idx_pending_radio_ingress_status
    ON pending_radio_ingress(status, id);

CREATE INDEX idx_raw_packets_message_id ON raw_packets(message_id);

CREATE UNIQUE INDEX idx_raw_packets_payload_hash ON raw_packets(payload_hash);

CREATE INDEX idx_raw_packets_timestamp ON raw_packets(timestamp);

CREATE INDEX idx_repeater_telemetry_pk_ts
            ON repeater_telemetry_history (public_key, timestamp)
        ;

CREATE INDEX idx_virtual_companion_channel_sends_created
        ON virtual_companion_channel_sends(created_at);

CREATE INDEX idx_virtual_companion_contact_changes_revision
        ON virtual_companion_contact_changes(revision);

CREATE TRIGGER trg_virtual_companion_contact_delete
        AFTER DELETE ON contacts BEGIN
            UPDATE virtual_companion_contact_clock
            SET revision = MAX(revision + 1, CAST(strftime('%s', 'now') AS INTEGER))
            WHERE singleton = 1;
            INSERT INTO virtual_companion_contact_changes(public_key, revision, deleted)
            SELECT lower(OLD.public_key), revision, 1
            FROM virtual_companion_contact_clock WHERE singleton = 1
            ON CONFLICT(public_key) DO UPDATE SET revision = excluded.revision, deleted = 1;
        END;

CREATE TRIGGER trg_virtual_companion_contact_insert
        AFTER INSERT ON contacts BEGIN
            UPDATE virtual_companion_contact_clock
            SET revision = MAX(revision + 1, CAST(strftime('%s', 'now') AS INTEGER))
            WHERE singleton = 1;
            INSERT INTO virtual_companion_contact_changes(public_key, revision, deleted)
            SELECT lower(NEW.public_key), revision, 0
            FROM virtual_companion_contact_clock WHERE singleton = 1
            ON CONFLICT(public_key) DO UPDATE SET revision = excluded.revision, deleted = 0;
        END;

CREATE TRIGGER trg_virtual_companion_contact_update
        AFTER UPDATE ON contacts BEGIN
            UPDATE virtual_companion_contact_clock
            SET revision = MAX(revision + 1, CAST(strftime('%s', 'now') AS INTEGER))
            WHERE singleton = 1;
            INSERT INTO virtual_companion_contact_changes(public_key, revision, deleted)
            SELECT lower(NEW.public_key), revision, 0
            FROM virtual_companion_contact_clock WHERE singleton = 1
            ON CONFLICT(public_key) DO UPDATE SET revision = excluded.revision, deleted = 0;
        END;

INSERT INTO app_settings(id) VALUES(1);

INSERT INTO virtual_companion_contact_clock(singleton,revision) VALUES(1,CAST(strftime('%s','now') AS INTEGER));

INSERT INTO channels(key,name,is_hashtag) VALUES('1ABC598EA3EF6FC85604F15EB93930E8','#meshrik',1);
