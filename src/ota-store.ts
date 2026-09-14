import { createHash } from "node:crypto";
import { lookup } from "mrmime";
import { fail, text, object, strings, signingKey } from "./ota-protocol.ts";
import type { OtaContext, Env, ReleaseRow, Publication, Asset, PublishOptions, Extensions, JsonObject, ExpoConfig, ChannelRow, Manifest, StringMap } from "./types.ts";

export const HASH = /^[A-Za-z0-9_-]{43}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const changes = (result: { meta?: { changes?: number }; changes?: number | bigint } | undefined) => Number(result?.meta?.changes ?? result?.changes ?? 0);
export const branchOf = (row: Pick<ReleaseRow, "branch" | "channel">) => row.branch || row.channel;
export const assertChanged = (env: Env) => [env.DB.prepare("INSERT INTO ota_assertions(ok) VALUES(changes())"), env.DB.prepare("DELETE FROM ota_assertions")];
export async function getRelease(env: Env, id: string): Promise<ReleaseRow> {
  const row = await env.DB.prepare("SELECT * FROM releases WHERE id=? AND app_id=? AND (manifest_json IS NOT NULL OR directive_json IS NOT NULL)").bind(id, env.OTA_APP_ID).first<ReleaseRow>();
  if (!row) fail(404, "OTA release not found");
  return row;
}
export function publicRelease(row: ReleaseRow) {
  return { id: row.id, appId: row.app_id, channel: row.channel, branch: branchOf(row), platform: row.platform,
    runtimeVersion: row.runtime_version, fingerprint: row.fingerprint, version: row.version, status: row.status,
    rollout: row.rollout, createdAt: row.created_at, revision: row.revision, sourceId: row.source_id,
    note: row.note, targets: JSON.parse(row.targets_json) as StringMap, directive: row.directive_json ? JSON.parse(row.directive_json) as { type: string; parameters: { commitTime: string } } : null,
    extensions: JSON.parse(row.extensions_json) as Extensions,
    manifest: row.manifest_json ? JSON.parse(row.manifest_json) as Manifest : null };
}
export const event = (env: Env, action: string, subject: string) => env.DB.prepare("INSERT INTO ota_events(app_id,action,subject,created_at) VALUES(?,?,?,?)")
  .bind(env.OTA_APP_ID, action, subject, new Date().toISOString());
export function percentage(value: unknown) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) fail(400, "Percentage must be an integer from 0 to 100");
  return n;
}
export function extensions(value: unknown): Extensions {
  const parsed = object(value || {}, "extensions");
  if (Object.keys(parsed).some(key => key !== "assetRequestHeaders")) fail(400, "Unknown extension");
  if (!parsed.assetRequestHeaders) return {};
  const headers = object(parsed.assetRequestHeaders, "assetRequestHeaders");
  if (Object.keys(headers).length > 2000) fail(400, "Too many asset headers");
  for (const values of Object.values(headers)) {
    for (const [key, value] of Object.entries(object(values, "asset headers"))) {
      if (!/^(authorization|x-[a-z0-9-]+)$/.test(key) || typeof value !== "string" || value.length > 2048 || /[^\x20-\x7e]/.test(value)) fail(400, "Invalid asset request header");
    }
  }
  return parsed as Extensions;
}
export async function storeBlob(env: Env, bytes: ArrayBuffer | Uint8Array) {
  const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  const hash = createHash("sha256").update(buffer).digest("base64url");
  const key = createHash("md5").update(buffer).digest("hex");
  if (!await env.ASSETS_R2.head(`ota/blobs/${hash}`)) await env.ASSETS_R2.put(`ota/blobs/${hash}`, buffer);
  await env.DB.prepare("INSERT INTO ota_blobs(hash,asset_key,size) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(hash, key, buffer.length).run();
  return { hash, key, size: buffer.length };
}
export function assetDescriptor(blob: { hash: string; asset_key?: string; key?: string }, extension: string, bundle = false): Asset {
  if (extension && !/^\.[a-zA-Z0-9]{1,16}$/.test(extension)) fail(400, "Invalid asset extension");
  return { key: blob.asset_key || blob.key!, hash: blob.hash,
    contentType: bundle ? "application/javascript" : lookup(extension) || "application/octet-stream",
    ...(!bundle && extension ? { fileExtension: extension } : {}) };
}
export async function publicationInput(c: OtaContext, fields: JsonObject): Promise<Publication> {
  signingKey(c.env);
  const appId = text(c.env.OTA_APP_ID, "OTA_APP_ID");
  const channel = text(fields.channel, "channel");
  const mapping = await c.env.DB.prepare("SELECT * FROM ota_channels WHERE app_id=? AND name=?").bind(appId, channel).first<ChannelRow>();
  if (mapping?.rollout_branch && !fields.branch) fail(409, "Specify a branch during a channel rollout");
  const branch = text(fields.branch || mapping?.branch || channel, "branch");
  const platform = text(fields.platform, "platform");
  if (!["android", "ios"].includes(platform)) fail(400, "Invalid platform");
  const runtime = text(fields.runtimeVersion, "runtimeVersion");
  const fingerprint = fields.fingerprint ? text(fields.fingerprint, "fingerprint") : null;
  if (fingerprint && !/^[a-f0-9]{40,64}$/.test(fingerprint)) fail(400, "Invalid native fingerprint");
  if ((c.env.OTA_REQUIRE_FINGERPRINT === "true" || /^[a-f0-9]{40,64}$/.test(runtime)) && !fingerprint) fail(400, "Native fingerprint is required");
  const config = object(fields.expoConfig, "expoConfig") as ExpoConfig;
  if (config.updates?.requestHeaders?.["expo-app-id"] !== appId) fail(400, "App ID does not match upload credential");
  const targets = strings(fields.targets || {}, "targets");
  const ext = extensions(fields.extensions);
  const rollout = percentage(fields.rollout ?? 100);
  const embedded = fields.embedded === true || fields.embedded === "true";
  if (embedded && (typeof fields.id !== "string" || !UUID.test(fields.id))) fail(400, "Embedded registration requires its native update UUID");
  return { appId, channel, branch, platform, runtime, fingerprint, config, targets, extensions: ext,
    rollout, status: embedded ? "Embedded" : fields.staged === true || fields.staged === "true" ? "Staged" : "Live",
    id: embedded ? (fields.id as string).toLowerCase() : crypto.randomUUID(), note: String(fields.commitHash || fields.note || "").slice(0, 1000) };
}

export async function publish(c: OtaContext, input: Publication, launchAsset: Asset | null, assets: Asset[], options: PublishOptions = {}) {
  const { env } = c;
  const id = input.id || crypto.randomUUID();
  const origin = new URL(c.req.url).origin;
  const withUrl = (asset: Asset) => ({ ...asset, url: `${origin}/ota-assets/${id}/${asset.hash}` });
  const manifest = launchAsset ? { id, createdAt: "", runtimeVersion: input.runtime,
    launchAsset: withUrl(launchAsset), assets: assets.map(withUrl),
    metadata: { branch: input.branch }, extra: { expoClient: input.config, channel: input.channel } } : null;
  const scope = [input.appId, input.branch, input.platform, input.runtime];
  const statements = [...(options.before || [])];
  // The baseline check and insert are one transaction, so failed publications cannot claim a runtime.
  if (input.fingerprint) {
    statements.push(env.DB.prepare("INSERT INTO ota_fingerprints VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").bind(...scope, input.fingerprint));
  }
  const insert = env.DB.prepare(`INSERT INTO releases
    (id,version,channel,branch,platform,runtime_version,status,rollout,created_at,note,launch_asset_url,assets_json,app_id,fingerprint,manifest_json,directive_json,targets_json,extensions_json,source_id)
    SELECT ?,?,?,?,?,?,?,?,
      strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday('now'), coalesce((SELECT max(julianday(created_at)) + 0.00000002315 FROM releases),0))),
      ?,?,?,?,?,?,?,?,?,?`)
    .bind(id, String(input.config?.version || ""), input.channel, input.branch, input.platform, input.runtime, input.status || "Live", input.rollout ?? 100,
      input.note || "", manifest?.launchAsset.url || null, JSON.stringify(manifest?.assets || []), input.appId, input.fingerprint || null,
      manifest ? JSON.stringify(manifest) : null, options.directive ? JSON.stringify(options.directive) : null,
      JSON.stringify(input.targets || {}), JSON.stringify(input.extensions || {}), options.sourceId || null);
  statements.push(insert);
  const index = statements.length - 1;
  statements.push(env.DB.prepare("UPDATE releases SET manifest_json=CASE WHEN manifest_json IS NOT NULL THEN json_set(manifest_json,'$.createdAt',created_at) ELSE NULL END, directive_json=CASE WHEN directive_json IS NOT NULL THEN json_set(directive_json,'$.parameters.commitTime',created_at) ELSE NULL END WHERE id=?").bind(id));
  statements.push(event(env, options.action || "publish", id));
  try {
    const results = await env.DB.batch(statements);
    if (!changes(results[index])) fail(409, "Fingerprint mismatch");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (/Fingerprint mismatch/.test(error.message)) fail(409, "Fingerprint mismatch");
    if (/active rollout|UNIQUE constraint|CHECK constraint/.test(error.message)) fail(409, "Publication conflict: end the rollout or refresh before retrying");
    throw error;
  }
  return getRelease(env, id);
}
