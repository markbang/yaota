-- Legacy APK ownership is unknown; do not assign it to an arbitrary application.
ALTER TABLE apks ADD COLUMN app_id TEXT;
ALTER TABLE apks ADD COLUMN size_bytes INTEGER;
ALTER TABLE apks ADD COLUMN source_url TEXT;
CREATE INDEX apks_app ON apks(app_id, created_at);
CREATE TABLE ota_patches (
  base_hash TEXT NOT NULL, target_hash TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0),
  PRIMARY KEY(base_hash, target_hash)
);
CREATE INDEX ota_patches_target ON ota_patches(target_hash);
-- The deployed legacy uploader only accepts this Cohub-specific filename contract.
UPDATE apks SET app_id='cohub-mobile'
WHERE app_id IS NULL AND key='apk/cohub-v'||version||'-android-'||arch||'.apk'
  AND arch IN ('arm64-v8a','armeabi-v7a','x86','x86_64')
  AND EXISTS(SELECT 1 FROM ota_apps WHERE app_id='cohub-mobile');
