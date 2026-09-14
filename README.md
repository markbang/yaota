# yaota

Multi-app Expo Updates service and English admin console, built in strict TypeScript with Hono and the official Cloudflare Workers Vite plugin.

- Dashboard: https://mobile.talesofai.com/admin
- Signed Expo endpoint: https://mobile.talesofai.com/manifest
- Public R2 domain: https://r2-mobile.talesofai.com

Open `/admin` and enter the Admin Token. Create an application, select it, then manage its channels and releases. Application IDs are explicit request data, not a global default. Publishing also requires a publishing credential and a signing key matching the certificate trusted by the native client.

## Development

Use Node 24+.

```bash
npm ci
npm run typecheck
npm test
npm run test:workerd
npm run dev
```

Visit `http://localhost:5173/admin`. Vite uses local D1/R2 bindings; configure local secrets in `.dev.vars`. Initialize a fresh local database with `npx wrangler d1 execute cohub-ota-updates --local --file=schema.sql`.

For a disposable, populated dashboard with test-only credentials, run `node scripts/smoke-ota.ts --serve` after a build. It prints the temporary local URL and credential. Its D1/R2 contents disappear when the process exits.

## Deployment

`wrangler.jsonc` binds the `yaota` Worker to D1 `cohub-ota-updates`, R2 `expo-updates`, and `mobile.talesofai.com`. Existing installations must use incremental migrations, not reinitialize the database.

```bash
npx wrangler d1 execute cohub-ota-updates --remote --file=migrations/0003_app_registry.sql
npm run deploy
```

See [Cohub OTA](docs/cohub-ota.md) for migration order, credentials and protocol details, and [Mobile CI](docs/mobile-ci-integration.md) for staged integration and device acceptance checks. Do not switch installed clients or their existing update hostname before signed native testing passes.

## API

- `GET /api/health`
- `GET /api/ota/apps`, `POST /api/ota/apps` (admin)
- `GET /api/ota/state?app_id=APP` (admin)
- `PUT /api/ota/channels/CHANNEL?app_id=APP` (admin)
- `POST /api/ota/releases/ID/ACTION?app_id=APP` (admin)
- `POST /api/ota/upload` (admin Expo export upload)
- `POST /upload` (legacy CLI-compatible publishing credential)
- `/ota-publish/*` and `/ota-patches/*` (publishing credential)
- `GET /manifest`, `GET /ota-assets/ID/HASH` (Expo clients)

The publishing credential is operator-wide, not a per-app tenant credential. Admin endpoints require a bearer token. R2 is intentionally public; asset-header checks on Worker URLs do not make direct bucket objects private. Do not include secrets in update bundles or resources. APK endpoints are retained but outside the Expo integration.
