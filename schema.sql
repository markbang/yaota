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
  assets_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS releases_channel_runtime ON releases(channel, platform, runtime_version, status);

CREATE TABLE IF NOT EXISTS apks (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT 'arm64-v8a',
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available'
);
