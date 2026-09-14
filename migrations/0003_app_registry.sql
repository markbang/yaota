CREATE TABLE IF NOT EXISTS ota_apps (
  app_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO ota_apps(app_id)
  SELECT app_id FROM releases
  UNION SELECT app_id FROM ota_channels
  UNION SELECT app_id FROM ota_fingerprints
  UNION SELECT app_id FROM ota_events;
