-- D1 schema for the Radiant admin workspace
-- (License Manager, Client Setup, Client Portal).

-- ============================================================
-- FRESH DATABASE — run all of this once in the D1 "Console".
-- ============================================================
CREATE TABLE IF NOT EXISTS licenses (
  id          TEXT PRIMARY KEY,
  customer    TEXT NOT NULL,
  issued      TEXT NOT NULL,
  expires     TEXT NOT NULL,
  key         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  products    TEXT NOT NULL DEFAULT '',
  revoked     INTEGER NOT NULL DEFAULT 0,
  revoked_at  TEXT,
  location_id TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL,
  contact_email              TEXT,
  notes                      TEXT,
  password_hash              TEXT,
  created_at                 TEXT NOT NULL,
  must_change_password       INTEGER NOT NULL DEFAULT 1,
  -- Phase 2.5.5 (QuikBolus): per-clinic default settings JSON blob.
  -- Stores the operator's preferred printer family + model, mold
  -- params, direct-print params, embossing template. QuikBolus pulls
  -- this on session start to pre-fill its forms.
  default_quikbolus_settings TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  modules     TEXT NOT NULL DEFAULT '',
  access_end  TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  token       TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Admin login replaces the Cloudflare Access gate that used to protect
-- /admin/*. Single-row default seed: username RMPCAdmin / "Password 1"
-- with must_change_password=1 so it can't be left on the default key.
CREATE TABLE IF NOT EXISTS admin_users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  last_login_at        TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token       TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- ============================================================
-- EXISTING DATABASE — upgrade steps. Run only what you have not
-- run before.
--   Revocation update:
--     ALTER TABLE licenses ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
--     ALTER TABLE licenses ADD COLUMN revoked_at TEXT;
--   Client Setup update:
--     ALTER TABLE licenses ADD COLUMN location_id TEXT;
--     ...plus CREATE TABLE clients and CREATE TABLE locations above.
--   Client Portal update:
--     ALTER TABLE clients ADD COLUMN password_hash TEXT;
--     ...plus CREATE TABLE portal_sessions above.
--   Forced-password-change + admin auth update:
--     ALTER TABLE clients ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1;
--     ...plus CREATE TABLE admin_users + admin_sessions above.
--     The Worker also runs these as CREATE IF NOT EXISTS / try-ALTER
--     on every admin-auth call, so the migration is self-healing.
--   QuikBolus per-clinic defaults (Phase 2.5.5):
--     ALTER TABLE clients ADD COLUMN default_quikbolus_settings TEXT;
--     The Worker also runs this as a try-ALTER on every clients API
--     call, so the migration is self-healing.
-- ============================================================
