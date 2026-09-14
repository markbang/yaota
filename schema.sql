CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Staged',
  rollout INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  launch_asset_url TEXT,
  assets_json TEXT NOT NULL DEFAULT '[]',
  app_id TEXT NOT NULL DEFAULT 'cohub-mobile',
  fingerprint TEXT,
  manifest_json TEXT,
  branch TEXT NOT NULL DEFAULT '',
  directive_json TEXT,
  targets_json TEXT NOT NULL DEFAULT '{}',
  extensions_json TEXT NOT NULL DEFAULT '{}',
  source_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ota_apps (
  app_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO ota_apps(app_id) VALUES ('cohub-mobile');

CREATE INDEX IF NOT EXISTS releases_channel_runtime ON releases(channel, platform, runtime_version, status);
CREATE INDEX IF NOT EXISTS releases_app_runtime ON releases(app_id, channel, platform, runtime_version, status);
CREATE TABLE IF NOT EXISTS ota_fingerprints (
  app_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(app_id, channel, platform, runtime_version)
);

CREATE TABLE IF NOT EXISTS apks (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT 'arm64-v8a',
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available'
);

CREATE TABLE IF NOT EXISTS ota_channels (
  app_id TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL,
  rollout_branch TEXT, percentage INTEGER NOT NULL DEFAULT 0 CHECK(percentage BETWEEN 0 AND 100),
  seed TEXT NOT NULL, headers_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(app_id, name)
);
CREATE TABLE IF NOT EXISTS ota_blobs (
  hash TEXT PRIMARY KEY, asset_key TEXT NOT NULL, size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_failures (
  app_id TEXT NOT NULL, release_id TEXT NOT NULL, client_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY(app_id, release_id, client_hash)
);
CREATE TABLE IF NOT EXISTS ota_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL,
  action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ota_one_rollout ON releases(app_id, branch, platform, runtime_version)
  WHERE status='Live' AND rollout < 100;
CREATE TRIGGER IF NOT EXISTS ota_block_publish_during_rollout BEFORE INSERT ON releases
WHEN NEW.status='Live' AND EXISTS (
  SELECT 1 FROM releases WHERE app_id=NEW.app_id AND branch=NEW.branch AND platform=NEW.platform
  AND runtime_version=NEW.runtime_version AND status='Live' AND rollout < 100
)
BEGIN SELECT RAISE(ABORT, 'End the active rollout before publishing'); END;
CREATE TABLE IF NOT EXISTS ota_assertions(ok INTEGER CHECK(ok=1));
CREATE TRIGGER IF NOT EXISTS ota_fingerprint_guard BEFORE INSERT ON releases
WHEN EXISTS (SELECT 1 FROM ota_fingerprints WHERE app_id=NEW.app_id AND channel=NEW.branch
  AND platform=NEW.platform AND runtime_version=NEW.runtime_version AND fingerprint IS NOT NEW.fingerprint)
BEGIN SELECT RAISE(ABORT, 'Fingerprint mismatch'); END;
