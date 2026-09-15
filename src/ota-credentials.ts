import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { Dictionary } from "structured-headers";
import type { Env } from "./types.ts";

export interface SigningRow {
  app_id: string; key_id: string; encrypted_private_key: string | null; certificate: string;
  public_key_fingerprint: string; created_at: string; updated_at: string; revoked_at: string | null;
}
interface SigningSettings { default_key_id: string | null; revision: number }
interface EnvironmentKey { privateKey?: string; certificateChain?: string }
export interface KeyMetadata {
  keyId: string; source: "managed" | "environment"; fingerprint: string | null;
  expiresAt: string | null; certificate: string | null; revokedAt: string | null;
  error: string | null;
}
const unavailable = (message: string): never => { throw new HTTPException(503, { message }); };
const aad = (appId: string, keyId: string) => Buffer.from(JSON.stringify(["yaota-signing-v1", appId, keyId]));
const encryptionKey = (env: Env) => {
  const encoded = env.CREDENTIALS_ENCRYPTION_KEY || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) unavailable("Credential encryption is not configured");
  return Buffer.from(encoded, "base64url");
};
export function encryptionConfigured(env: Env) { try { encryptionKey(env); return true; } catch { return false; } }
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
// Compare canonical public bytes: workerd KeyObject.equals can reject equivalent keys.
export const publicKeyFingerprint = (key: ReturnType<typeof createPublicKey>) => createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");

export function encryptPrivateKey(env: Env, appId: string, keyId: string, pem: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  cipher.setAAD(aad(appId, keyId));
  const body = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function decryptPrivateKey(env: Env, appId: string, keyId: string, encoded: string) {
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length < 28) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), bytes.subarray(0, 12));
    decipher.setAAD(aad(appId, keyId));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return unavailable("Stored signing key is unreadable"); }
}

export function validateSigningMaterial(certificate: unknown, privateKey: unknown) {
  if (typeof certificate !== "string" || typeof privateKey !== "string" || certificate.length > 16384 || privateKey.length > 16384
    || !/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(certificate)
    || !/^\s*-----BEGIN (RSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END (RSA )?PRIVATE KEY-----\s*$/.test(privateKey)) {
    throw new HTTPException(400, { message: "Provide one PEM certificate and an unencrypted RSA private key" });
  }
  try {
    const cert = new X509Certificate(certificate);
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa" || Number(key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new HTTPException(400, { message: "Signing key must be RSA with at least 2048 bits" });
    if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new HTTPException(400, { message: "Certificate is expired or not yet valid" });
    if (publicKeyFingerprint(cert.publicKey) !== publicKeyFingerprint(createPublicKey(key))) throw new HTTPException(400, { message: "Certificate does not match the private key" });
    return { certificate: cert.toString(), privateKey: key.export({ type: "pkcs8", format: "pem" }).toString(), fingerprint: publicKeyFingerprint(cert.publicKey), expiresAt: new Date(cert.validTo).toISOString() };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "Invalid certificate or RSA private key" });
  }
}

export function environmentKeys(env: Env, appId?: string): Record<string, EnvironmentKey> {
  try {
    const record = (value: unknown): Record<string, unknown> => {
      const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    };
    if (env.CODE_SIGNING_APPS) {
      const apps = record(env.CODE_SIGNING_APPS);
      return appId && Object.hasOwn(apps, appId) ? record(apps[appId]) as Record<string, EnvironmentKey> : {};
    }
    if (env.CODE_SIGNING_KEYS) return record(env.CODE_SIGNING_KEYS) as Record<string, EnvironmentKey>;
    return { [env.CODE_SIGNING_KEY_ID || "main"]: { privateKey: env.CODE_SIGNING_PRIVATE_KEY, certificateChain: env.CODE_SIGNING_CERTIFICATE_CHAIN } };
  } catch { return unavailable("Invalid environment signing configuration"); }
}
export function environmentSigner(env: Env, keyid: string, appId?: string) {
  const entries = environmentKeys(env, appId);
  if (!Object.hasOwn(entries, keyid)) {
    if (env.CODE_SIGNING_APPS && !Object.keys(entries).length) unavailable("Signing keys are not configured for this application");
    throw new HTTPException(406, { message: "Requested signing key is unavailable" });
  }
  try {
    const entry = entries[keyid];
    if (!entry?.privateKey) return unavailable("OTA signing key is not configured");
    const key = createPrivateKey(entry.privateKey);
    if (key.asymmetricKeyType !== "rsa") return unavailable("OTA signing key must be RSA");
    if (entry.certificateChain && publicKeyFingerprint(new X509Certificate(entry.certificateChain).publicKey) !== publicKeyFingerprint(createPublicKey(key))) return unavailable("Signing certificate does not match key");
    return { key, keyid, chain: entry.certificateChain };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return unavailable("Invalid environment signing key or certificate");
  }
}
export async function signingSettings(env: Env, appId: string): Promise<SigningSettings> {
  return await env.DB.prepare("SELECT default_key_id,revision FROM ota_signing_settings WHERE app_id=?").bind(appId).first<SigningSettings>() || { default_key_id: null, revision: 0 };
}
export async function signingKey(env: Env, expected: Dictionary = new Map(), appId?: string) {
  if (expected.has("alg") && String(expected.get("alg")?.[0]) !== "rsa-v1_5-sha256") throw new HTTPException(406, { message: "Unsupported signing algorithm" });
  const settings = appId ? await signingSettings(env, appId) : null;
  const keyid = String(expected.get("keyid")?.[0] || settings?.default_key_id || env.CODE_SIGNING_KEY_ID || "main");
  if (appId) {
    const row = await env.DB.prepare("SELECT * FROM ota_signing_keys WHERE app_id=? AND key_id=?").bind(appId, keyid).first<SigningRow>();
    // A tombstone or unreadable managed key must never fall back to an environment key.
    if (row) {
      if (row.revoked_at || !row.encrypted_private_key) return unavailable("Requested signing key is revoked");
      try {
        const material = validateSigningMaterial(row.certificate, decryptPrivateKey(env, appId, keyid, row.encrypted_private_key));
        if (material.fingerprint !== row.public_key_fingerprint) return unavailable("Stored signing key is unreadable");
        return { key: createPrivateKey(material.privateKey), keyid, chain: undefined as string | undefined };
      } catch { return unavailable("Stored signing key is unreadable or its certificate has expired"); }
    }
  }
  return environmentSigner(env, keyid, appId);
}

export async function publishingSettings(env: Env) {
  return await env.DB.prepare("SELECT legacy_enabled,revision FROM ota_publishing_settings WHERE id=1").first<{ legacy_enabled: number; revision: number }>() || { legacy_enabled: 1, revision: 0 };
}
export async function managedPublisher(env: Env, given: string) {
  return !!await env.DB.prepare("SELECT id FROM ota_publishing_tokens WHERE token_hash=? AND revoked_at IS NULL").bind(hashToken(given)).first();
}
export async function credentialsState(env: Env, appId: string) {
  const settings = await signingSettings(env, appId);
  const { results } = await env.DB.prepare("SELECT * FROM ota_signing_keys WHERE app_id=? ORDER BY key_id").bind(appId).all<SigningRow>();
  const keys: KeyMetadata[] = results.map(row => {
    let expiresAt: string | null = null;
    try { expiresAt = new Date(new X509Certificate(row.certificate).validTo).toISOString(); } catch {}
    return { keyId: row.key_id, source: "managed", fingerprint: row.public_key_fingerprint, certificate: row.certificate, expiresAt, revokedAt: row.revoked_at, error: null };
  });
  let environmentError: string | null = null;
  try {
    for (const keyId of Object.keys(environmentKeys(env, appId))) {
      if (keys.some(key => key.keyId === keyId)) continue;
      const entry: KeyMetadata = { keyId, source: "environment", fingerprint: null, expiresAt: null, certificate: null, revokedAt: null, error: null };
      try {
        const signer = environmentSigner(env, keyId, appId);
        entry.fingerprint = publicKeyFingerprint(createPublicKey(signer.key));
        if (signer.chain) { const cert = new X509Certificate(signer.chain); entry.certificate = cert.toString(); entry.expiresAt = new Date(cert.validTo).toISOString(); }
      } catch (error) { entry.error = error instanceof HTTPException ? error.message : "Invalid signing configuration"; }
      keys.push(entry);
    }
  } catch { environmentError = "Invalid environment signing configuration"; }
  for (const key of keys.filter(key => key.source === "managed" && !key.revokedAt)) {
    try { await signingKey(env, new Map([["keyid", [key.keyId, new Map()]]]), appId); }
    catch (error) { key.error = error instanceof HTTPException ? error.message : "Invalid signing configuration"; }
  }
  let error: string | null = null;
  try { await signingKey(env, new Map(), appId); }
  catch (cause) { error = cause instanceof HTTPException ? cause.message : "Invalid signing configuration"; }
  const publishing = await publishingSettings(env);
  const tokens = await env.DB.prepare("SELECT id,name,created_at,revoked_at FROM ota_publishing_tokens ORDER BY created_at DESC").all<{ id: string; name: string; created_at: string; revoked_at: string | null }>();
  return {
    signing: { defaultKeyId: settings.default_key_id || env.CODE_SIGNING_KEY_ID || "main", revision: settings.revision, encryptionConfigured: encryptionConfigured(env), configured: !error, error, environmentError, keys },
    publishing: { scope: "service" as const, revision: publishing.revision, legacyConfigured: !!env.OTA_API_KEY, legacyEnabled: !!publishing.legacy_enabled, configured: (!!env.OTA_API_KEY && !!publishing.legacy_enabled) || tokens.results.some(token => !token.revoked_at), tokens: tokens.results },
  };
}
export type CredentialsState = Awaited<ReturnType<typeof credentialsState>>;
