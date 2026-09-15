import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import Negotiator from "negotiator";
import { fail, text, object, publisher, admin, authorized, dictionary, failedIds, bucket, otaResponse } from "./ota-protocol.ts";
import { HASH, UUID, storeBlob, assetDescriptor, publicationInput, publish, publicRelease, branchOf } from "./ota-store.ts";
import { controls } from "./ota-controls.ts";
import { credentialControls } from "./ota-credential-controls.ts";
import { requestAppId, requireApp } from "./ota-apps.ts";
import type { Env, OtaContext, ReleaseRow, ChannelRow, BlobRow, Manifest, Extensions, StringMap } from "./types.ts";

export const ota = new Hono<{ Bindings: Env }>();
ota.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error("OTA request failed", error.name, error.message);
  if (/CHECK constraint|UNIQUE constraint/.test(error.message)) return c.json({ error: "Concurrent change; refresh before retrying" }, 409);
  return c.json({ error: "OTA storage or signing operation failed" }, 500);
});
ota.route("/", controls);
ota.route("/", credentialControls);
ota.use("/api/ota/upload", bodyLimit({ maxSize: 100 * 1024 * 1024 }));
ota.use("/upload", bodyLimit({ maxSize: 100 * 1024 * 1024 }));
ota.post("/api/ota/upload", async c => { admin(c); return multipartUpload(c); });
ota.post("/upload", async c => { await publisher(c); return multipartUpload(c); });
async function multipartUpload(c: OtaContext) {
  if (!c.env.DB || !c.env.ASSETS_R2) fail(503, "OTA storage is not configured");
  const form = await c.req.raw.formData();
  const fields = Object.fromEntries(form);
  const input = await publicationInput(c, fields);
  const metadata = object(fields.metadata, "metadata");
  const bundle = form.get("bundle");
  if (!(bundle instanceof File) || !bundle.size) fail(400, "Missing bundle");
  const fileMetadata = object(metadata.fileMetadata, "fileMetadata");
  const assetMetadata = object(fileMetadata[input.platform], "platform metadata").assets;
  if (!Array.isArray(assetMetadata) || assetMetadata.length > 2000) fail(400, "Missing platform asset metadata");
  const entries = [...form.entries()].filter(([name]) => /^asset-\d+$/.test(name)).map(([, file]) => file);
  if (entries.some(file => !(file instanceof File)) || entries.length !== assetMetadata.length) fail(400, "Assets do not match export metadata");
  const files = entries as File[];
  if (assetMetadata.some(asset => !asset || typeof asset.path !== "string" || (asset.ext !== undefined && typeof asset.ext !== "string"))) fail(400, "Invalid asset metadata");
  if (new Set(files.map(file => file.name)).size !== files.length || new Set(assetMetadata.map(a => a.path)).size !== assetMetadata.length) fail(400, "Duplicate assets");
  for (const asset of assetMetadata) if (typeof asset.path !== "string" || !files.some(file => asset.path.split("/").pop() === file.name)) fail(400, "Missing exported asset");
  const launch = assetDescriptor(await storeBlob(c.env, await bundle.arrayBuffer()), "", true);
  const assets = [];
  for (const file of files) {
    const meta = assetMetadata.find(item => item.path.split("/").pop() === file.name);
    assets.push(assetDescriptor(await storeBlob(c.env, await file.arrayBuffer()), meta.ext ? "." + meta.ext.replace(/^\./, "") : ""));
  }
  const row = await publish(c, input, launch, assets);
  return c.json({ id: row.id, createdAt: row.created_at, runtimeVersion: row.runtime_version }, 201);
}

ota.use("/ota-publish/*", bodyLimit({ maxSize: 100 * 1024 * 1024 }));
ota.use("/ota-publish/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await publisher(c);
  if (!c.env.DB || !c.env.ASSETS_R2) fail(503, "OTA storage is not configured");
  return next();
});
ota.post("/ota-publish/missing", async c => {
  const { hashes } = object(await c.req.text(), "request");
  if (!Array.isArray(hashes) || hashes.length > 2001 || hashes.some(hash => typeof hash !== "string" || !HASH.test(hash))) fail(400, "Invalid hashes");
  const missing = [];
  for (const hash of new Set(hashes)) {
    const known = await c.env.DB.prepare("SELECT hash FROM ota_blobs WHERE hash=?").bind(hash).first();
    if (!known || !await c.env.ASSETS_R2.head(`ota/blobs/${hash}`)) missing.push(hash);
  }
  return c.json({ missing });
});
ota.put("/ota-publish/blobs/:hash", async c => {
  const hash = c.req.param("hash");
  if (!HASH.test(hash)) fail(400, "Invalid hash");
  const bytes = await c.req.raw.arrayBuffer();
  if (createHash("sha256").update(Buffer.from(bytes)).digest("base64url") !== hash) fail(400, "Blob integrity mismatch");
  return c.json(await storeBlob(c.env, bytes));
});
ota.post("/ota-publish/releases", async c => {
  const body = object(await c.req.text(), "request");
  const input = await publicationInput(c, body);
  if (!Array.isArray(body.assets) || body.assets.length > 2000) fail(400, "Invalid assets");
  async function resolve(value: unknown, bundle = false) {
    const descriptor = object(value, "asset");
    if (typeof descriptor.hash !== "string" || !HASH.test(descriptor.hash)) fail(400, "Invalid asset hash");
    if (descriptor.fileExtension !== undefined && typeof descriptor.fileExtension !== "string") fail(400, "Invalid asset extension");
    const blob = await c.env.DB.prepare("SELECT * FROM ota_blobs WHERE hash=?").bind(descriptor.hash).first<BlobRow>();
    if (!blob || !await c.env.ASSETS_R2.head(`ota/blobs/${descriptor.hash}`)) fail(409, "Upload missing blobs before publication");
    if (bundle && !blob.size) fail(400, "Empty bundle");
    return assetDescriptor(blob, descriptor.fileExtension || "", bundle);
  }
  const launch = await resolve(body.launchAsset, true);
  const assets = [];
  for (const asset of body.assets) assets.push(await resolve(asset));
  const row = await publish(c, input, launch, assets);
  return c.json(publicRelease(row), 201);
});
ota.get("/ota-publish/releases", async c => {
  const appId = requestAppId(c);
  await requireApp(c.env, appId);
  const { results } = await c.env.DB.prepare("SELECT * FROM releases WHERE app_id=? AND manifest_json IS NOT NULL ORDER BY created_at DESC").bind(appId).all<ReleaseRow>();
  return c.json({ releases: results.map(publicRelease) });
});

ota.get("/manifest", async c => {
  if (!c.env.DB) fail(503, "OTA storage is not configured");
  const appId = requestAppId(c);
  const channel = text(c.req.header("expo-channel-name"), "expo-channel-name");
  const platform = text(c.req.header("expo-platform"), "expo-platform");
  const runtime = text(c.req.header("expo-runtime-version"), "expo-runtime-version");
  if (!["android", "ios"].includes(platform)) fail(400, "Invalid platform");
  const protocol = c.req.header("expo-protocol-version") || "0";
  if (!["0", "1"].includes(protocol)) fail(406, "Unsupported protocol version");
  const client = text(c.req.header("yaota-client-id") || c.req.header("expo-client-id") || crypto.randomUUID(), "client ID");
  const mapping = await c.env.DB.prepare("SELECT * FROM ota_channels WHERE app_id=? AND name=?").bind(appId, channel).first<ChannelRow>();
  let branch = mapping?.branch || channel;
  if (mapping?.rollout_branch && bucket(mapping.seed, client) < mapping.percentage) branch = mapping.rollout_branch;
  const options = { appId, filters: { branch }, headers: { ...JSON.parse(mapping?.headers_json || "{}"), "yaota-client-id": client } };
  const failed = failedIds(c.req.header("expo-recent-failed-update-ids"));
  const params = dictionary(c.req.header("expo-extra-params"));
  const { results } = await c.env.DB.prepare("SELECT * FROM releases WHERE app_id=? AND (branch=? OR (branch='' AND channel=?)) AND platform=? AND runtime_version=? AND status='Live' AND (manifest_json IS NOT NULL OR directive_json IS NOT NULL) ORDER BY created_at DESC, rowid DESC").bind(appId, branch, branch, platform, runtime).all<ReleaseRow>();
  for (const id of failed) {
    if (!results.some(row => row.id === id)) continue;
    const clientHash = createHash("sha256").update(`${appId}:${client}`).digest("hex");
    await c.env.DB.prepare("INSERT INTO ota_failures VALUES(?,?,?,?,?) ON CONFLICT(app_id,release_id,client_hash) DO UPDATE SET last_seen=excluded.last_seen")
      .bind(appId, id, clientHash, new Date().toISOString(), new Date().toISOString()).run();
  }
  const row = results.find(row => !failed.includes(row.id)
    && Object.entries(JSON.parse(row.targets_json)).every(([key, value]) => params.get(key)?.[0] === value)
    && (row.rollout === 100 || bucket(row.id, client) < row.rollout));
  if (!row || row.id === c.req.header("expo-current-update-id")) {
    if (protocol === "0") return c.body(null, 404);
    return otaResponse(c, { type: "noUpdateAvailable" }, "directive", options);
  }
  if (row.directive_json) {
    if (protocol === "0") fail(406, "Rollback directives require protocol 1");
    return otaResponse(c, JSON.parse(row.directive_json), "directive", options);
  }
  return otaResponse(c, JSON.parse(row.manifest_json!), "manifest", { ...options, extensions: JSON.parse(row.extensions_json) });
});

ota.get("/ota-assets/:id/:hash", async c => {
  const { id, hash } = c.req.param();
  if (!UUID.test(id) || !HASH.test(hash)) return c.notFound();
  if (!c.env.DB || !c.env.ASSETS_R2) fail(503, "OTA storage is not configured");
  const target = await c.env.DB.prepare("SELECT * FROM releases WHERE id=? AND manifest_json IS NOT NULL").bind(id).first<ReleaseRow>();
  if (!target) return c.notFound();
  const manifest: Manifest = JSON.parse(target.manifest_json!);
  const asset = [manifest.launchAsset, ...manifest.assets].find(asset => asset.hash === hash);
  if (!asset) return c.notFound();
  const required: StringMap = (JSON.parse(target.extensions_json) as Extensions).assetRequestHeaders?.[asset.key] || {};
  for (const [key, value] of Object.entries(required)) if (!authorized(c.req.header(key), value)) fail(401, "Asset authorization required");
  const isLaunch = hash === manifest.launchAsset.hash;
  const baseId = c.req.header("expo-current-update-id") || c.req.header("expo-embedded-update-id");
  const requested = c.req.header("expo-requested-update-id");
  const acceptsPatch = (c.req.header("a-im") || "").split(",").some(value => value.trim().toLowerCase() === "bsdiff");
  if (acceptsPatch && baseId && requested === id && isLaunch) {
    const base = await c.env.DB.prepare("SELECT * FROM releases WHERE id=? AND app_id=? AND platform=? AND runtime_version=? AND manifest_json IS NOT NULL").bind(baseId, target.app_id, target.platform, target.runtime_version).first<ReleaseRow>();
    if (base && base.fingerprint === target.fingerprint && (branchOf(base) === branchOf(target) || base.status === "Embedded")) {
      const patch = await c.env.ASSETS_R2.get(`ota/patches/${JSON.parse(base.manifest_json!).launchAsset.hash}/${hash}`);
      if (patch) return new Response(patch.body as unknown as ReadableStream, { status: 226, headers: { "content-type": "application/octet-stream", im: "bsdiff",
        "expo-base-update-id": baseId, "cache-control": "private, no-store", vary: "A-IM, Expo-Current-Update-ID, Expo-Embedded-Update-ID, Expo-Requested-Update-ID" } });
    }
  }
  const object = await c.env.ASSETS_R2.get(`ota/blobs/${hash}`);
  if (!object) return c.notFound();
  const encoding = new Negotiator({ headers: { "accept-encoding": c.req.header("accept-encoding") || "identity" } }).encoding(["br", "gzip", "identity"]);
  if (!encoding) fail(406, "No acceptable asset encoding");
  const privateAsset = isLaunch || Object.keys(required).length > 0;
  const headers = new Headers({ "content-type": asset.contentType, "cache-control": privateAsset ? "private, no-store" : "public, max-age=31536000, immutable",
    vary: "Accept-Encoding" + (isLaunch ? ", A-IM, Expo-Current-Update-ID, Expo-Embedded-Update-ID, Expo-Requested-Update-ID" : ""), etag: `"${hash}-${encoding}"` });
  if (encoding !== "identity") headers.set("content-encoding", encoding);
  if (c.req.header("if-none-match")?.split(",").map(v => v.trim()).includes(headers.get("etag")!)) return new Response(null, { status: 304, headers });
  if (encoding === "identity") return new Response(object.body as unknown as ReadableStream, { headers });
  const encodedKey = `ota/encoded/${hash}/${encoding}`;
  const cached = await c.env.ASSETS_R2.get(encodedKey);
  if (cached) return new Response(cached.body as unknown as ReadableStream, { headers, encodeBody: "manual" });
  const bytes = Buffer.from(await new Response(object.body as unknown as ReadableStream).arrayBuffer());
  const encoded = encoding === "br" ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : gzipSync(bytes);
  await c.env.ASSETS_R2.put(encodedKey, encoded);
  return new Response(encoded, { headers, encodeBody: "manual" });
});

ota.use("/ota-patches/*", bodyLimit({ maxSize: 100 * 1024 * 1024 }));
ota.put("/ota-patches/:base/:target", async c => {
  await publisher(c);
  const appId = requestAppId(c);
  const rows = [];
  for (const id of [c.req.param("base"), c.req.param("target")]) {
    const row = await c.env.DB.prepare("SELECT * FROM releases WHERE id=? AND app_id=? AND manifest_json IS NOT NULL").bind(id, appId).first<ReleaseRow>();
    if (!row) fail(404, "Release not found");
    rows.push(row);
  }
  const [base, target] = rows;
  if ((["platform", "runtime_version", "fingerprint"] as const).some(key => base[key] !== target[key]) || (base.status !== "Embedded" && branchOf(base) !== branchOf(target))) fail(409, "Patch scope mismatch");
  const oldHash = JSON.parse(base.manifest_json!).launchAsset.hash;
  const newHash = JSON.parse(target.manifest_json!).launchAsset.hash;
  const full = await c.env.ASSETS_R2.head(`ota/blobs/${newHash}`);
  const bytes = Buffer.from(await c.req.raw.arrayBuffer());
  if (bytes.length < 32 || bytes.subarray(0, 8).toString() !== "BSDIFF40") fail(400, "Expected BSDIFF40 patch");
  if (!full || bytes.length >= full.size || oldHash === newHash || bytes.readBigUInt64LE(24) !== BigInt(full.size)) fail(400, "Patch size does not match full bundle");
  await c.env.ASSETS_R2.put(`ota/patches/${oldHash}/${newHash}`, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  return c.json({ base: base.id, target: target.id, size: bytes.length });
});
