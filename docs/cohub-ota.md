# Cohub Mobile OTA

Compatibility target: cohub-mobile commit 54a24a3b352c5051a4245eba7626343b560f0f3e,
with publisher CLI revision fab754606dfe747abee8faef24d84981789f8064.
APK distribution is outside this integration.

## Deployment

Use Node 24+ for local tests and the TypeScript publisher. Enable nodejs_compat in Wrangler.
Bind DB to D1 and ASSETS_R2 to R2. For a fresh database execute schema.sql.
For a database initialized with the previous yaota schema, execute
migrations/0001_cohub_ota.sql, migrations/0002_ota_controls.sql, then migrations/0003_app_registry.sql. Apply only migrations missing from your installation. Migration 0003 is idempotent and backfills applications referenced by existing Yaota data; it does not modify the old service's apps/updates tables. Fresh schema installations need no migrations.

There is no default application. Create apps in `/admin` before publishing. Configure Worker secrets:

- OTA_API_KEY: the operator-wide publishing key for this Yaota service.
- CODE_SIGNING_PRIVATE_KEY: RSA PEM private key matching the existing mobile
  certs/ota-certificate.crt. PKCS#8 and PKCS#1 PEM are accepted.
- YAOTA_ADMIN_TOKEN: console administration credential.

`node scripts/configure-publisher.ts --apply` creates/reuses an owner-only gitignored `.secrets/publisher.json` and uploads its publishing credential. Do not use it to rotate an already-configured remote credential without coordinating CI.

For per-app signing use `CODE_SIGNING_APPS`, a JSON map of app IDs to key-ID maps of `{privateKey, certificateChain?}`. When this secret exists, no app falls back to the global key. For example, two apps may each use `keyid=main` with different private keys. Without it, the legacy single-key variables or `CODE_SIGNING_KEYS` remain supported.

`node scripts/configure-signing.ts --app-id cohub-mobile --certificate /path/to/client-certificate.crt --private-key /path/to/matching-private-key.pem --apply` checks the certificate's validity and public-key match, then uploads `.secrets/signing-apps.json`. Keep that file as the complete source of truth for all apps: uploading it replaces the remote `CODE_SIGNING_APPS` value. It does not export private keys from Cloudflare or GitHub, generate substitute keys, or change the native certificate.

Never replace the client's trusted certificate to make a server test pass.
Local development may use .dev.vars (gitignored); production uses wrangler secret put.
Existing clients retain their native updates URL. To serve them, deploy behind the
existing expo-ota.talesofai.com/manifest endpoint. Changing only a repository variable
does not change URLs embedded in installed binaries. Existing OTA history is not
automatically imported from the old service.

## Publisher and client

POST /upload accepts the pinned CLI multipart request and x-ota-api-key.
The credential grants operator-wide publishing access. Supply `app_id` or declare
updates.requestHeaders.expo-app-id in expoConfig. Supplied IDs must agree; an unknown application is rejected without creating records. Uploads include bundle, asset-N, metadata,
expoConfig, platform, channel, runtimeVersion, fingerprint and optional commitHash.
Runtime and fingerprint are distinct hashes: runtime identifies the installed binary,
fingerprint guards the exported source's native dependencies. Baselines are stored
per app/branch/platform/runtime. Conflicts return 409 and cannot be bypassed by
ignoreFingerprintCheck. A new native baseline requires a new runtime.

GET /manifest uses Expo app/channel/platform/runtime headers and responds with a signed
multipart manifest or noUpdateAvailable directive (protocol 1). Protocol 0 missing-update
requests return 404. It preserves expoClient config, asset MD5 keys, SHA-256 base64url
integrity hashes, MIME types and extensions. Manifests use immutable UUID identities.
CI publications appear in the console. Rollback republishes historical bytes with a new UUID and newer timestamp, preserving the original targeting scope. A rollback without a previous update emits a signed rollBackToEmbedded directive. Merely archiving an update does not undo an update already installed on a device.

## SDK 57 binary deltas

SDK 57's native downloader opts in with A-IM: bsdiff, Expo-Current-Update-ID and
Expo-Requested-Update-ID on launch asset requests. Available matching patches return
226, IM: bsdiff and expo-base-update-id. Other clients, unknown bases, and missing patches
receive the full bundle. Asset responses use private/no-store and Vary to prevent a CDN
from serving one client's patch to another. The manifest always describes the full
bundle hash so the native client validates the reconstructed bytes.

Generate a patch after uploading two compatible releases:

```bash
OTA_SERVER=https://mobile.talesofai.com \
  node scripts/publish-delta.ts BASE_UPDATE_UUID TARGET_UPDATE_UUID cohub-mobile
```

Provide OTA_API_KEY through the environment/CI secret. This command downloads and
verifies both bundles, generates BSDIFF40 with bsdiff-wasm, applies it with bspatch,
compares every reconstructed byte, and uploads only if smaller than the full bundle.
It can be appended to CI after the existing CLI upload; it is not automatically invoked
by the existing mobile workflow. Patch generation runs in CI, not on the Worker request
path. Unregistered embedded bundles use full downloads.

R2 blobs are keyed by SHA-256 across releases, including images/fonts and bundles.
Repeated content reuses a blob. Failed publications may leave unreferenced blobs;
automatic garbage collection is intentionally absent until reference-aware retention
is implemented. Never delete shared blobs when deleting one release.

## TypeScript publishing and controls

Run `node scripts/publish.ts --app-id cohub-mobile --export-dir dist --config expo-config.json --platform android --runtime RUNTIME --fingerprint FINGERPRINT` with `OTA_SERVER` and `OTA_API_KEY` in the environment. The publisher uploads only missing SHA-256 blobs, creates a staged update, verifies BSDIFF40 patches against up to three compatible bases by default, then activates the same UUID. History, patch upload and activation carry the same explicit application ID, even across separate Worker instances. `--staged` defers activation. `--embedded-id` registers the exact bundle and native update UUID shipped in a binary, allowing embedded-base patches. Never register a newly exported bundle as an existing binary's embedded content.

The composite action in `.github/actions/publish-ota/action.yml` runs this publisher. It is not yet connected to the remote cohub-mobile workflow. Legacy multipart and console uploads remain compatible but do not automatically generate patches.

The authenticated `/api/ota/state?app_id=APP` and release/channel controls support staged publishing, promotion, monotonic update rollouts, channel-to-branch mappings, stable branch cohorts, rollback, target parameters, and reported failures. All management operations require an explicit `app_id` query or `expo-app-id` header; conflicting IDs are rejected. Clients must retain the returned server-defined client ID for stable cohorts. `Expo-Extra-Params` must match target values. Failed IDs are untrusted client reports, not a measured crash rate.

Response negotiation supports JSON and multipart, signature key selection and optional certificate chains. Configure `CODE_SIGNING_KEY_ID` and `CODE_SIGNING_CERTIFICATE_CHAIN` for a single key, or `CODE_SIGNING_KEYS` as a JSON map of key IDs to `{privateKey, certificateChain}`. Production trust still depends on the certificate embedded in the native app.

Per-asset `extensions.assetRequestHeaders` are enforced before serving content. Normal public resources use immutable caching; launch bundles, private resources and patches use no-store. Gzip/Brotli variants are cached in R2 by content hash. Shared blobs and encoded variants must not be deleted just because one release is removed.

This deployment intentionally exposes R2 through public custom domains. Direct object URLs bypass Worker request-header checks. Assets, bundles and patches are public distribution artifacts, not confidential storage. Signatures and hashes provide authenticity/integrity, not secrecy. Manifests keep Worker asset URLs so SDK 57 delta negotiation continues to work.

Run `npm run typecheck`, `npm test`, `npm run test:workerd`, and `npx wrangler deploy --dry-run` before deployment.

## Verification scope

npm test covers CLI-shaped uploads, SQL persistence, RSA verification of actual
response bytes, asset bytes/hashes, scope isolation, fingerprint conflicts, failed
uploads, deduplication and SDK 57 delta negotiation/fallback.
These are integration tests using SQLite and an R2 test adapter; real-device validation
against the existing certificate/private key and live Cloudflare deployment is still
required before changing the production endpoint.

`npm run test:workerd` additionally builds the Worker and runs signed multipart
uploads, R2 deduplication, RSA signature verification, patch delivery and full-bundle
fallback inside local Cloudflare workerd with D1/R2 bindings. It uses ephemeral
storage and a generated test-only key; no production resources or secrets are used.
