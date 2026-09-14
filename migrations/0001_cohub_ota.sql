ALTER TABLE releases ADD COLUMN app_id TEXT NOT NULL DEFAULT 'cohub-mobile';
ALTER TABLE releases ADD COLUMN fingerprint TEXT;
ALTER TABLE releases ADD COLUMN manifest_json TEXT;
CREATE INDEX releases_app_runtime ON releases(app_id, channel, platform, runtime_version, status);
CREATE TABLE ota_fingerprints (
  app_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(app_id, channel, platform, runtime_version)
);
