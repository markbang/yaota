CREATE TABLE IF NOT EXISTS ota_signing_settings (app_id TEXT PRIMARY KEY, default_key_id TEXT, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ota_signing_keys (
  app_id TEXT NOT NULL, key_id TEXT NOT NULL, encrypted_private_key TEXT, certificate TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY(app_id, key_id)
);
CREATE TABLE IF NOT EXISTS ota_publishing_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS ota_publishing_settings (id INTEGER PRIMARY KEY CHECK(id=1), legacy_enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO ota_publishing_settings(id) VALUES(1);
