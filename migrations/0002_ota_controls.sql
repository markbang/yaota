ALTER TABLE releases ADD COLUMN branch TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN directive_json TEXT;
ALTER TABLE releases ADD COLUMN targets_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE releases ADD COLUMN extensions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE releases ADD COLUMN source_id TEXT;
ALTER TABLE releases ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE releases SET branch=channel;
CREATE TABLE ota_channels (
  app_id TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL,
  rollout_branch TEXT, percentage INTEGER NOT NULL DEFAULT 0 CHECK(percentage BETWEEN 0 AND 100),
  seed TEXT NOT NULL, headers_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(app_id, name)
);
CREATE TABLE ota_blobs (hash TEXT PRIMARY KEY, asset_key TEXT NOT NULL, size INTEGER NOT NULL);
CREATE TABLE ota_failures (
  app_id TEXT NOT NULL, release_id TEXT NOT NULL, client_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(app_id, release_id, client_hash)
);
CREATE TABLE ota_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL,
  action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ota_one_rollout ON releases(app_id, branch, platform, runtime_version)
  WHERE status='Live' AND rollout < 100;
CREATE TRIGGER ota_block_publish_during_rollout BEFORE INSERT ON releases
WHEN NEW.status='Live' AND EXISTS (
  SELECT 1 FROM releases WHERE app_id=NEW.app_id AND branch=NEW.branch AND platform=NEW.platform
  AND runtime_version=NEW.runtime_version AND status='Live' AND rollout < 100
)
BEGIN SELECT RAISE(ABORT, 'End the active rollout before publishing'); END;
CREATE TABLE ota_assertions(ok INTEGER CHECK(ok=1));
CREATE TRIGGER ota_fingerprint_guard BEFORE INSERT ON releases
WHEN EXISTS (SELECT 1 FROM ota_fingerprints WHERE app_id=NEW.app_id AND channel=NEW.branch
  AND platform=NEW.platform AND runtime_version=NEW.runtime_version AND fingerprint IS NOT NEW.fingerprint)
BEGIN SELECT RAISE(ABORT, 'Fingerprint mismatch'); END;
