# APKs And OTA Sizes

The dashboard keeps native APKs separate from OTA updates. Neither importing an APK
nor changing a channel triggers a native build or alters the mobile repository.

## Android Packages

Open **APKs > Add APKs** for the selected application:

- **GitHub Release**: enter a public `owner/repository` and an optional tag. An empty
  tag selects the latest release. Yaota registers uploaded `.apk` assets, using
  GitHub's byte sizes and original download URLs. It does not copy the binaries to
  R2 or automatically synchronize future releases. Reimporting is idempotent.
- **Local APK**: select a file, version and architecture. Yaota stores a unique,
  app-scoped R2 object and records the received byte count. The request limit is
  100 MiB including multipart overhead. Larger files can stay on GitHub.

Local uploads validate the archive signature, not Android signing identities or
package metadata. Supply the version/architecture of the signed build. Unknown
GitHub filename architectures are displayed as `unknown`, never guessed as ARM64.

| Endpoint | Authentication | Input |
| --- | --- | --- |
| `GET /api/ota/apks?app_id=APP` | Admin bearer | Includes pending uploads |
| `POST /api/ota/apks?app_id=APP` | Admin bearer | Multipart `file`, `version`, `arch` |
| `POST /ota-publish/apks?app_id=APP` | `x-ota-api-key` | Same multipart input for CI |
| `POST /api/ota/apks/github?app_id=APP` | Admin bearer | JSON `repository`, optional `tag` |
| `POST /api/ota/apks/presign?app_id=APP` | Admin bearer | JSON `version`, `arch`; reserves an upload |
| `PUT` returned `uploadUrl` | Admin bearer | Raw APK bytes; supplied URL contains `app_id` |

The new app-scoped two-step API requires an explicit registered app. Its dashboard
listing returns `sizeBytes` and `downloadUrl`. Reservation creates a `Pending` row,
not a downloadable package; successful upload records its actual size and marks it
`Available`. Published bytes cannot be overwritten through that upload URL.

The deployed Cohub `/api/apks` listing and `/api/apks/presign` plus upload contract
remain compatible with existing native CI, including publisher-token authentication,
the canonical Cohub filenames, `size`, `sha256`, `url` and download counts. These
legacy endpoints remain Cohub-specific; other applications use `/api/ota/apks`.

## OTA Size Accounting

`GET /api/ota/state?app_id=APP` adds `delivery` to each OTA update:

- `bundleBytes`: uncompressed launch bundle bytes from the blob index.
- `assetBytes`, `uniqueAssetCount`: resources counted once per SHA-256 hash.
- `totalBytes`: bundle plus resources, again counted once per hash.
- `previousUpdateId`, `reusedAssetBytes`, `reusedAssetCount`: resources unchanged
  from the previous non-staged update on the same app/branch/platform/runtime and
  fingerprint. This is potential cache reuse, not measured device traffic.
- `patches`: compatible base update IDs, byte sizes and percentage reduction
  relative to the full target bundle. The list shows the smallest recorded patch;
  the details view includes each compatible base. A device needs that exact base.

Missing sizes are `null` and appear as **Unknown**, not zero. Rollback directives
have no bundle. These fields are admin metadata; signed manifests are unchanged.
HTTP compression, device caches, asset reuse and actual device base versions affect
network transfer size. No bandwidth telemetry is inferred from these values.

Patch uploads now index their R2 byte sizes in D1. Pre-upgrade patches without index
records remain downloadable but appear as **Not recorded** until reuploaded using
the existing patch publisher. Legacy multipart and dashboard OTA uploads still do
not generate patches automatically; use the TypeScript publisher for that.

## Channels

The dashboard includes **Default mapping** entries inferred from stored updates'
channel and branch names. These represent the server's existing same-name fallback,
not new database rows or evidence of client traffic. Unobserved channel names cannot
be enumerated. Explicit mappings take precedence. Saving a default mapping creates
the channel with revision `-1`; concurrent saves are rejected rather than overwritten.

## Upgrade

Apply `migrations/0006_artifact_metrics.sql` once before deploying this version to
an existing database. Fresh databases use `schema.sql` only. This migration leaves
legacy APKs intact. Canonical Cohub filenames are attached to the registered
`cohub-mobile` app; their byte sizes are read from R2. Other legacy records stay
unassigned rather than guessing ownership. Reimport or upload those into the
intended app; existing R2 download URLs remain valid. No old files are deleted.
