import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createPublicKey, randomBytes } from "node:crypto";
import { admin, fail, object, text } from "./ota-protocol.ts";
import { requestAppId, requireApp } from "./ota-apps.ts";
import { assertChanged, event } from "./ota-store.ts";
import { credentialsState, encryptPrivateKey, environmentKeys, environmentSigner, hashToken, publicKeyFingerprint, publishingSettings, signingKey, signingSettings, validateSigningMaterial } from "./ota-credentials.ts";
import type { SigningRow } from "./ota-credentials.ts";
import type { Env, JsonObject, OtaContext } from "./types.ts";

export const credentialControls = new Hono<{ Bindings: Env }>();
credentialControls.use("/api/ota/credentials/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  admin(c);
  if (!c.env.DB) fail(503, "D1 binding is required");
  await next();
});
credentialControls.use("/api/ota/credentials/*", bodyLimit({ maxSize: 64 * 1024 }));
async function input(c: OtaContext) {
  const data = object(await c.req.text(), "request");
  const appId = requestAppId(c, data.app_id);
  await requireApp(c.env, appId);
  return { data, appId };
}
function keyId(value: unknown) {
  const id = text(value, "key ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) fail(400, "Invalid key ID");
  return id;
}
async function signingRevision(c: OtaContext, appId: string, data: JsonObject) {
  const current = await signingSettings(c.env, appId);
  if (!Number.isSafeInteger(data.revision) || data.revision !== current.revision) fail(409, "Signing settings changed; refresh before retrying");
  return [
    c.env.DB.prepare("INSERT OR IGNORE INTO ota_signing_settings(app_id) VALUES(?)").bind(appId),
    c.env.DB.prepare("UPDATE ota_signing_settings SET revision=revision+1 WHERE app_id=? AND revision=?").bind(appId, current.revision), ...assertChanged(c.env),
  ];
}
async function publishingRevision(c: OtaContext, data: JsonObject) {
  const current = await publishingSettings(c.env);
  if (!Number.isSafeInteger(data.revision) || data.revision !== current.revision) fail(409, "Publishing settings changed; refresh before retrying");
  return [c.env.DB.prepare("UPDATE ota_publishing_settings SET revision=revision+1 WHERE id=1 AND revision=?").bind(current.revision), ...assertChanged(c.env)];
}
const signatureRequest = (id: string) => new Map<string, [string, Map<string, never>]>([["keyid", [id, new Map<string, never>()]]]);

credentialControls.get("/api/ota/credentials", async c => {
  const appId = requestAppId(c);
  await requireApp(c.env, appId);
  return c.json(await credentialsState(c.env, appId));
});
credentialControls.post("/api/ota/credentials/signing/validate", async c => {
  const { data } = await input(c);
  const material = validateSigningMaterial(data.certificate, data.privateKey);
  return c.json({ fingerprint: material.fingerprint, expiresAt: material.expiresAt });
});
credentialControls.put("/api/ota/credentials/signing/keys/:keyId", async c => {
  const { data, appId } = await input(c);
  const id = keyId(c.req.param("keyId"));
  const before = await signingRevision(c, appId, data);
  const material = validateSigningMaterial(data.certificate, data.privateKey);
  const current = await c.env.DB.prepare("SELECT * FROM ota_signing_keys WHERE app_id=? AND key_id=?").bind(appId, id).first<SigningRow>();
  if (current?.revoked_at) fail(409, "Revoked key IDs cannot be reused; choose a new key ID");
  let fingerprint = current?.public_key_fingerprint;
  if (!current) {
    const envKeys = environmentKeys(c.env, appId);
    if (Object.hasOwn(envKeys, id) && envKeys[id]?.privateKey) fingerprint = publicKeyFingerprint(createPublicKey(environmentSigner(c.env, id, appId).key));
  }
  if (fingerprint && fingerprint !== material.fingerprint) fail(409, "This key ID already belongs to a different key; choose a new key ID");
  if (data.makeDefault !== undefined && typeof data.makeDefault !== "boolean") fail(400, "Invalid makeDefault");
  const now = new Date().toISOString();
  const encrypted = encryptPrivateKey(c.env, appId, id, material.privateKey);
  await c.env.DB.batch([...before,
    c.env.DB.prepare("INSERT INTO ota_signing_keys(app_id,key_id,encrypted_private_key,certificate,public_key_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id,key_id) DO UPDATE SET encrypted_private_key=excluded.encrypted_private_key,certificate=excluded.certificate,updated_at=excluded.updated_at")
      .bind(appId, id, encrypted, material.certificate, material.fingerprint, now, now),
    ...(data.makeDefault ? [c.env.DB.prepare("UPDATE ota_signing_settings SET default_key_id=? WHERE app_id=?").bind(id, appId)] : []),
    event(c.env, appId, "import-signing-key", id),
  ]);
  return c.json({ keyId: id, revision: Number(data.revision) + 1 }, current ? 200 : 201);
});
credentialControls.put("/api/ota/credentials/signing/default", async c => {
  const { data, appId } = await input(c);
  const id = keyId(data.keyId);
  const before = await signingRevision(c, appId, data);
  await signingKey(c.env, signatureRequest(id), appId);
  await c.env.DB.batch([...before, c.env.DB.prepare("UPDATE ota_signing_settings SET default_key_id=? WHERE app_id=?").bind(id, appId), event(c.env, appId, "default-signing-key", id)]);
  return c.json({ keyId: id, revision: Number(data.revision) + 1 });
});
credentialControls.post("/api/ota/credentials/signing/keys/:keyId/revoke", async c => {
  const { data, appId } = await input(c);
  const id = keyId(c.req.param("keyId"));
  const before = await signingRevision(c, appId, data);
  const state = await credentialsState(c.env, appId);
  const key = state.signing.keys.find(key => key.keyId === id);
  if (!key) fail(404, "Signing key not found");
  if (key.revokedAt) fail(409, "Signing key is already revoked");
  if (data.confirm !== true) fail(400, "Confirm revocation; clients requesting this key will stop receiving updates");
  const now = new Date().toISOString();
  await c.env.DB.batch([...before,
    c.env.DB.prepare("INSERT INTO ota_signing_keys(app_id,key_id,certificate,public_key_fingerprint,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id,key_id) DO UPDATE SET encrypted_private_key=NULL,revoked_at=excluded.revoked_at,updated_at=excluded.updated_at")
      .bind(appId, id, key.certificate || "", key.fingerprint || "", now, now, now),
    event(c.env, appId, "revoke-signing-key", id),
  ]);
  return c.json({ keyId: id, revision: Number(data.revision) + 1 });
});
credentialControls.get("/api/ota/credentials/signing/keys/:keyId/certificate", async c => {
  const appId = requestAppId(c);
  await requireApp(c.env, appId);
  const id = keyId(c.req.param("keyId"));
  const state = await credentialsState(c.env, appId);
  const key = state.signing.keys.find(key => key.keyId === id);
  if (!key?.certificate) fail(404, "Certificate not available");
  c.header("Content-Type", "application/x-pem-file");
  c.header("Content-Disposition", `attachment; filename="${id}.pem"`);
  return c.body(key.certificate);
});
credentialControls.post("/api/ota/credentials/publishing/tokens", async c => {
  const { data } = await input(c);
  const before = await publishingRevision(c, data);
  const name = text(data.name, "token name");
  const id = crypto.randomUUID();
  const token = `yaota_pub_${randomBytes(32).toString("base64url")}`;
  await c.env.DB.batch([...before,
    c.env.DB.prepare("INSERT INTO ota_publishing_tokens(id,name,token_hash,created_at) VALUES(?,?,?,?)").bind(id, name, hashToken(token), new Date().toISOString()),
    event(c.env, "", "create-publishing-token", id),
  ]);
  return c.json({ id, name, token, revision: Number(data.revision) + 1 }, 201);
});
credentialControls.post("/api/ota/credentials/publishing/tokens/:id/revoke", async c => {
  const { data } = await input(c);
  const before = await publishingRevision(c, data);
  const id = text(c.req.param("id"), "token ID");
  if (data.confirm !== true) fail(400, "Confirm token revocation");
  if (!await c.env.DB.prepare("SELECT id FROM ota_publishing_tokens WHERE id=? AND revoked_at IS NULL").bind(id).first()) fail(404, "Active publishing token not found");
  await c.env.DB.batch([...before, c.env.DB.prepare("UPDATE ota_publishing_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(new Date().toISOString(), id), ...assertChanged(c.env), event(c.env, "", "revoke-publishing-token", id)]);
  return c.json({ id, revision: Number(data.revision) + 1 });
});
credentialControls.put("/api/ota/credentials/publishing/legacy", async c => {
  const { data } = await input(c);
  const before = await publishingRevision(c, data);
  if (typeof data.enabled !== "boolean" || data.confirm !== true) fail(400, "Confirm the legacy publishing key change");
  await c.env.DB.batch([...before, c.env.DB.prepare("UPDATE ota_publishing_settings SET legacy_enabled=? WHERE id=1").bind(data.enabled ? 1 : 0), event(c.env, "", data.enabled ? "enable-legacy-publishing" : "disable-legacy-publishing", "OTA_API_KEY")]);
  return c.json({ enabled: data.enabled, revision: Number(data.revision) + 1 });
});
