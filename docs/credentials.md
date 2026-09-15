# Credential Management

Open `/admin`, select an application, and open **Settings**. Signing keys belong to
that application. Publishing tokens grant access to **all applications** on the
service. The admin token remains a Worker secret, not a setting exposed by this API.

## Initial Setup

For an existing database, apply `migrations/0004_credentials.sql` after the earlier
migrations. Fresh installations using `schema.sql` already include these tables.

```bash
npx wrangler d1 execute cohub-ota-updates --remote --file=migrations/0004_credentials.sql
node scripts/configure-credentials.ts --apply
```

The setup script initializes a 32-byte base64url `CREDENTIALS_ENCRYPTION_KEY` Worker
secret only when it is absent and no encrypted signing keys exist. It never replaces
an existing secret. A local backup is stored in the owner-only, gitignored
`.secrets/credentials-encryption.json`. Back up this value in a secret manager.
Replacing or losing it prevents the service from decrypting existing managed keys.
Individual credential changes require neither redeployment nor a Cloudflare API token.

## Dashboard

- **Import key:** choose a key ID, PEM certificate, and matching unencrypted RSA
  private key. Validate, review the fingerprint and expiry, then confirm the import.
- **Default key:** used when a client does not request a specific key ID. Clients
  requesting another active key ID retain access to that key.
- **Revoke key:** permanently deletes its stored encrypted private key and keeps a
  tombstone. Clients requesting it stop receiving updates. Revoking the default
  also blocks publication and default-key delivery until another default is set.
- **Create token:** returns a generated publishing token once. Store it in CI as
  `OTA_API_KEY` (or your action's secret input). The server stores only SHA-256 hashes.
- **Revoke token / Worker publishing key:** revokes a managed token or disables the
  legacy `OTA_API_KEY` without changing the original Worker secret. Dashboard admin
  uploads do not need a publishing token.

The trusted certificate and key ID must match the installed native binary. RSA keys
must be at least 2048 bits, with a currently valid certificate. The server does not
generate substitute native signing keys. Rotate to a **new key ID**, ship the new
certificate in a native build, retain the old key for installed clients, then revoke
it deliberately. A key ID cannot be reused after revocation or assigned a different
public key. Renewing a certificate with the same private key is allowed.

Managed keys override environment keys with the same `(app_id, key ID)`.
Revoked, expired, or unreadable managed keys never fall back to environment keys.
Unmanaged IDs retain the existing `CODE_SIGNING_APPS`, `CODE_SIGNING_KEYS`, and
single-key configuration behavior. Environment-backed keys can be marked default
or revoked per application; replacing their material remains a Worker-secret change
or a managed import of the matching key. Managed certificate downloads do not
automatically add a certificate-chain part to every Expo response.

## Admin API

Every endpoint below requires `Authorization: Bearer ADMIN_TOKEN` and an explicit
registered `app_id` query parameter (or `expo-app-id` header). Responses use
`Cache-Control: private, no-store`. Mutation and validation bodies are JSON, limited
to 64 KB. Errors are JSON with an `error` string.

Prefix: `/api/ota/credentials`

| Method / Path | JSON Body / Result |
| --- | --- |
| `GET /` | Signing and publishing metadata, configuration status and separate revisions |
| `POST /signing/validate` | `{certificate, privateKey}`; returns `{fingerprint, expiresAt}` without storing material |
| `PUT /signing/keys/KEY_ID` | `{certificate, privateKey, makeDefault?: boolean, revision}` |
| `PUT /signing/default` | `{keyId, revision}` |
| `POST /signing/keys/KEY_ID/revoke` | `{confirm: true, revision}` |
| `GET /signing/keys/KEY_ID/certificate` | PEM attachment, never the private key |
| `POST /publishing/tokens` | `{name, revision}`; returns `{id, name, token, revision}` **once** |
| `POST /publishing/tokens/TOKEN_ID/revoke` | `{confirm: true, revision}` |
| `PUT /publishing/legacy` | `{enabled: boolean, confirm: true, revision}` |

Use `/api/ota/credentials?app_id=APP` for the metadata request (no trailing slash).
Read `signing.revision` for signing changes and `publishing.revision` for publishing
changes. New installations start at revision `0`. Mutations increment their revision
and return it; stale revisions return `409` and require a refresh. Signing revisions
are per app; publishing revisions are service-wide. Metadata is also available at
`credentials` inside `/api/ota/state?app_id=APP`.

Example validation and import from existing PEM files, without including private
material in shell arguments or command history:

```bash
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
const base = `${process.env.OTA_SERVER}/api/ota/credentials`;
const query = `?app_id=${encodeURIComponent(process.env.APP_ID)}`;
const headers = { authorization: `Bearer ${process.env.YAOTA_ADMIN_TOKEN}`, 'content-type': 'application/json' };
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path + query, { method, headers, body: body && JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
const state = await request('');
const material = {
  certificate: await readFile(process.env.CERTIFICATE_PATH, 'utf8'),
  privateKey: await readFile(process.env.PRIVATE_KEY_PATH, 'utf8'),
};
await request('/signing/validate', 'POST', material);
await request(`/signing/keys/${encodeURIComponent(process.env.KEY_ID)}`, 'PUT', {
  ...material, revision: state.signing.revision, makeDefault: true,
});
console.log('Signing key imported');
JS
```

Private keys are AES-256-GCM encrypted in D1, with authenticated data binding them
to the app and key ID. R2 never receives credential material. Neither private keys,
ciphertext nor token hashes are returned by management APIs. Audit events record
only operations and IDs; service-wide token events appear in every app's activity.
Keep D1 backups and the encryption secret under separate access controls. Use HTTPS
and do not enable request-body logging for these endpoints.
