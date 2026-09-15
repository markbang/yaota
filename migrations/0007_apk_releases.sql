CREATE TABLE IF NOT EXISTS apk_releases (
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT,
  notes TEXT,
  release_url TEXT,
  published_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available',
  PRIMARY KEY(app_id, version)
);
