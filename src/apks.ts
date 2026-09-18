import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import type { ReadableStream as WorkersReadableStream } from "@cloudflare/workers-types";
import { admin, fail, object, publisher, text } from "./ota-protocol.ts";
import { requestAppId, requireApp } from "./ota-apps.ts";
import { event } from "./ota-store.ts";
import { listAppApks } from "./ota-artifacts.ts";
import type { ApkRow, Env, OtaContext } from "./types.ts";

export const apks = new Hono<{ Bindings: Env }>();
const architectures = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86", "universal"];

function releaseMetadata(form: FormData) {
  return {
    title: typeof form.get("title") === "string" ? String(form.get("title")).trim() || null : null,
    notes: typeof form.get("notes") === "string" ? String(form.get("notes")) : null,
    releaseUrl: typeof form.get("release_url") === "string" ? String(form.get("release_url")).trim() || null : null,
  };
}

async function apkCatalog(c: OtaContext, appId: string) {
  const apks = await listAppApks(c.env, appId);
  const metadata = await c.env.DB.prepare("SELECT version,title,notes,release_url,published_at,status FROM apk_releases WHERE app_id=? ORDER BY published_at DESC").bind(appId).all<{ version: string; title: string | null; notes: string | null; release_url: string | null; published_at: string; status: string }>();
  const byVersion = new Map(metadata.results.filter(row => row.status === "Available").map(row => [row.version, row]));
  const versions = new Map<string, typeof apks>();
  for (const apk of apks) versions.set(apk.version, [...(versions.get(apk.version) || []), apk]);
  return [...versions].map(([version, assets]) => {
    const row = byVersion.get(version);
    return {
      version,
      title: row?.title ?? null,
      notes: row?.notes ?? null,
      releaseUrl: row?.release_url ?? null,
      publishedAt: row?.published_at ?? assets[0]?.createdAt ?? null,
      apks: assets.map(asset => ({ ...asset, downloadUrl: asset.downloadUrl.startsWith("http") ? asset.downloadUrl : new URL(asset.downloadUrl, c.req.url).href })),
    };
  });
}

function assertApk(bytes: ArrayBuffer) {
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  if (header[0] !== 80 || header[1] !== 75 || header[2] !== 3 || header[3] !== 4) fail(400, "APK must be a ZIP archive");
}

async function uploadApk(c: OtaContext) {
  if (!c.env.DB || !c.env.ASSETS_R2) fail(503, "APK storage is not configured");
  const form = await c.req.raw.formData();
  const appId = requestAppId(c, form.get("app_id"));
  await requireApp(c.env, appId);
  const version = text(form.get("version"), "version");
  const arch = text(form.get("arch"), "architecture");
  const metadata = releaseMetadata(form);
  if (!architectures.includes(arch)) fail(400, "Unsupported APK architecture");
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".apk") || file.size < 4) fail(400, "Select a non-empty APK file");
  assertApk(await file.slice(0, 4).arrayBuffer());
  const rawSha256 = form.get("sha256");
  const sha256 = rawSha256 == null ? "" : text(rawSha256, "sha256").toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) fail(400, "sha256 must be a 64-character hex digest");
  const key = `apk/${appId}/${crypto.randomUUID()}/${arch}.apk`;
  await c.env.ASSETS_R2.put(key, file.stream() as unknown as WorkersReadableStream, { customMetadata: sha256 ? { sha256 } : undefined, httpMetadata: { contentType: "application/vnd.android.package-archive" } });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO apk_releases(app_id,version,title,notes,release_url,published_at,status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id,version) DO UPDATE SET title=excluded.title,notes=excluded.notes,release_url=excluded.release_url,published_at=excluded.published_at,status='Available'")
      .bind(appId, version, metadata.title, metadata.notes, metadata.releaseUrl, now, "Available"),
    c.env.DB.prepare("INSERT INTO apks(key,app_id,version,arch,size_bytes,sha256,created_at,status) VALUES(?,?,?,?,?,?,?,?)")
      .bind(key, appId, version, arch, file.size, sha256, now, "Available"),
    event(c.env, appId, "upload-apk", key),
  ]);
  return c.json({ apk: (await listAppApks(c.env, appId)).find(apk => apk.key === key) }, 201);
}

apks.use("/api/ota/apks*", async (c, next) => { admin(c); c.header("Cache-Control", "private, no-store"); return next(); });
apks.use("/api/ota/apks", bodyLimit({ maxSize: 100 * 1024 * 1024 }));
apks.get("/api/ota/catalog", async c => {
  const appId = requestAppId(c);
  await requireApp(c.env, appId);
  const response = c.json({ releases: await apkCatalog(c, appId) });
  response.headers.set("cache-control", "no-store");
  response.headers.set("access-control-allow-origin", "*");
  return response;
});

apks.get("/api/ota/apks", async c => {
  const appId = requestAppId(c);
  await requireApp(c.env, appId);
  return c.json({ apks: await listAppApks(c.env, appId) });
});

// The deployed /api/apks contract remains in worker.ts for existing native CI.
apks.post("/api/ota/apks/presign", async c => {
  admin(c);
  const data = object(await c.req.text(), "request");
  const appId = requestAppId(c, data.app_id, data.appId);
  await requireApp(c.env, appId);
  const version = text(data.version, "version");
  const arch = text(data.arch || "arm64-v8a", "architecture");
  if (!architectures.includes(arch)) fail(400, "Unsupported APK architecture");
  const key = `apk/${appId}/${crypto.randomUUID()}/${arch}.apk`;
  await c.env.DB.prepare("INSERT INTO apks(key,app_id,version,arch,created_at,status) VALUES(?,?,?,?,?,?)")
    .bind(key, appId, version, arch, new Date().toISOString(), "Pending").run();
  return c.json({ key, uploadUrl: `${new URL(c.req.url).origin}/api/ota/apks/upload/${encodeURIComponent(key)}?app_id=${encodeURIComponent(appId)}`, publicUrl: `${new URL(c.req.url).origin}/${key}` });
});
apks.put("/api/ota/apks/upload/:key", bodyLimit({ maxSize: 100 * 1024 * 1024 }), async c => {
  admin(c);
  const appId = requestAppId(c);
  await requireApp(c.env, appId);
  if (!c.env.ASSETS_R2) fail(503, "APK storage is not configured");
  const key = c.req.param("key");
  const row = await c.env.DB.prepare("SELECT * FROM apks WHERE key=? AND app_id=?").bind(key, appId).first<ApkRow>();
  if (!row) fail(404, "APK upload not found");
  if (row.status !== "Pending") fail(409, "This APK is already published");
  const bytes = await c.req.raw.arrayBuffer();
  assertApk(bytes);
  // R2 conditional writes prevent concurrent uploads from replacing a published binary.
  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const stored = await c.env.ASSETS_R2.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256 }, httpMetadata: { contentType: "application/vnd.android.package-archive" } });
  if (!stored) {
    const existing = await c.env.ASSETS_R2.head(key);
    if (existing?.size !== bytes.byteLength || existing.customMetadata?.sha256 !== sha256) fail(409, "Different APK bytes already uploaded");
  }
  await c.env.DB.batch([c.env.DB.prepare("UPDATE apks SET size_bytes=?,sha256=?,status='Available' WHERE key=? AND app_id=?").bind(bytes.byteLength, sha256, key, appId), event(c.env, appId, "upload-apk", key)]);
  return c.json({ ok: true, key, sizeBytes: bytes.byteLength });
});
apks.get("/apk/:appId/:id/:file", async c => {
  const { appId, id, file } = c.req.param();
  const key = `apk/${appId}/${id}/${file}`;
  const row = await c.env.DB.prepare("SELECT * FROM apks WHERE key=? AND app_id=? AND status='Available'").bind(key, appId).first<ApkRow>();
  if (!row || row.source_url) return c.notFound();
  const stored = await c.env.ASSETS_R2.get(key);
  if (!stored) return c.notFound();
  await c.env.DB.prepare("UPDATE apks SET downloads=downloads+1 WHERE key=?").bind(key).run();
  return new Response(stored.body as unknown as ReadableStream, { headers: {
    "content-type": "application/vnd.android.package-archive", "content-length": String(stored.size),
    "content-disposition": "attachment", etag: stored.httpEtag, "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
  } });
});
apks.post("/api/ota/apks", uploadApk);
apks.use("/ota-publish/apks", bodyLimit({ maxSize: 100 * 1024 * 1024 }));
apks.post("/ota-publish/apks", async c => { await publisher(c); return uploadApk(c); });
apks.post("/api/ota/apks/github", bodyLimit({ maxSize: 4096 }), async c => {
  const data = object(await c.req.text(), "request");
  const appId = requestAppId(c, data.app_id);
  await requireApp(c.env, appId);
  const repository = text(data.repository, "GitHub repository");
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || repository.split("/").some(part => part === "." || part === "..")) fail(400, "Use a GitHub owner/repository");
  const tag = data.tag ? text(data.tag, "release tag") : null;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : "latest"}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "yaota" }, redirect: "manual", signal: AbortSignal.timeout(15000),
    });
  } catch { fail(502, "Unable to reach GitHub. Retry the import shortly."); }
  if (!response.ok) fail(502, `GitHub release could not be loaded (${response.status})`);
  const release = object(await response.json(), "GitHub release");
  const version = text(release.tag_name, "GitHub release tag");
  if (!Array.isArray(release.assets) || release.draft) fail(400, "Expected a published GitHub release");
  const candidates = release.assets.map(asset => object(asset, "GitHub asset")).filter(asset => typeof asset.name === "string" && asset.name.toLowerCase().endsWith(".apk") && asset.state === "uploaded");
  if (!candidates.length) fail(400, "This release has no uploaded APKs");
  if (candidates.length > 50) fail(400, "Too many APKs in this release");
  const statements = candidates.map(asset => {
    if (!Number.isSafeInteger(asset.id) || Number(asset.id) <= 0 || !Number.isSafeInteger(asset.size) || Number(asset.size) <= 0) fail(502, "GitHub returned invalid APK metadata");
    const download = new URL(String(asset.browser_download_url));
    if (download.origin !== "https://github.com" || !download.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/releases/download/`) || download.username || download.password) fail(502, "GitHub returned an unexpected APK URL");
    const name = String(asset.name);
    const arch = architectures.find(value => new RegExp(`(?:^|[-_.])${value}(?:[-_.]|$)`).test(name)) || "unknown";
    return c.env.DB.prepare(`INSERT INTO apks(key,app_id,version,arch,size_bytes,source_url,created_at,status) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET version=excluded.version,arch=excluded.arch,size_bytes=excluded.size_bytes,source_url=excluded.source_url`)
      .bind(`github/${appId}/${asset.id}`, appId, version, arch, asset.size, download.href, String(asset.created_at || new Date().toISOString()), "Available");
  });
  await c.env.DB.batch([...statements, event(c.env, appId, "import-apks", `${repository}@${version}`)]);
  return c.json({ imported: candidates.length, apks: await listAppApks(c.env, appId) }, 201);
});
