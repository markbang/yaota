import { Hono } from "hono";
import type { ReadableStream as WorkersReadableStream } from "@cloudflare/workers-types";
import { ota } from "./src/ota.ts";
import type { Env, ReleaseRow, JsonObject } from "./src/types.ts";
import { appId, requireApp } from "./src/ota-apps.ts";
import { authorized as tokenMatch } from "./src/ota-protocol.ts";
import { managedPublisher, publishingSettings } from "./src/ota-credentials.ts";

interface LegacyRelease {
  id: string; version: string; channel: string; platform: string; runtimeVersion: string;
  status: string; rollout: number; createdAt: string; note: string; launchAssetUrl: string | null; assets: unknown[];
}
interface ApkRow { key: string; version: string; size: string; arch: string; sha256?: string; downloads: number; created_at: string; status: string }
interface ApkReleaseRow { version: string; title: string | null; notes: string | null; release_url: string | null; published_at: string; status: string }

const APK_ABI = /^(arm64-v8a|armeabi-v7a|x86|x86_64)$/;
const APK_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const APK_FILE = /^cohub-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-android-(arm64-v8a|armeabi-v7a|x86|x86_64)\.apk$/;

function apkObjectKey(version: string, arch: string) {
  return `apk/cohub-v${version}-android-${arch}.apk`;
}

const seedReleases: LegacyRelease[] = [
  {
    id: "8c1f2f3a-9c16-4d8e-9f6d-0aa77d9d0e11",
    version: "2.4.0",
    channel: "production",
    platform: "android",
    runtimeVersion: "54.0.0",
    status: "Live",
    rollout: 68,
    createdAt: "2024-06-20T09:42:00.000Z",
    note: "Fix push token invalidation",
    launchAssetUrl: null,
    assets: [],
  },
  {
    id: "2a91f4d8-97a2-4a5b-8f2f-2d5f8be0c1e7",
    version: "2.4.0-rc.2",
    channel: "preview",
    platform: "android",
    runtimeVersion: "54.0.0",
    status: "Staged",
    rollout: 12,
    createdAt: "2024-06-19T16:18:00.000Z",
    note: "Checkout performance improvements",
    launchAssetUrl: null,
    assets: [],
  },
  {
    id: "7d03b961-4c7a-47de-8e43-4e4bf2e9a2dd",
    version: "2.3.9",
    channel: "production",
    platform: "android",
    runtimeVersion: "53.0.0",
    status: "Archived",
    rollout: 0,
    createdAt: "2024-06-18T11:04:00.000Z",
    note: "Stable release",
    launchAssetUrl: null,
    assets: [],
  },
];

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-ota-api-key",
};
const withCors = (response: Response) => {
  const headers = new Headers(response.headers);
  Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
};

async function authorized(request: Request, env: Env) {
  const admin = env.YAOTA_ADMIN_TOKEN;
  if (tokenMatch(request.headers.get("authorization") ?? undefined, admin ? `Bearer ${admin}` : undefined)) return true;
  const apiKey = request.headers.get("x-ota-api-key");
  if (apiKey && apiKey.length <= 1024 && env.DB) {
    const settings = await publishingSettings(env);
    if (settings.legacy_enabled && tokenMatch(apiKey, env.OTA_API_KEY)) return true;
    if (await managedPublisher(env, apiKey)) return true;
  } else if (apiKey && tokenMatch(apiKey, env.OTA_API_KEY)) {
    return true;
  }
  // Seeded local mode is intentionally open; configured storage requires a secret.
  if (!admin) return !env.DB && !env.ASSETS_R2;
  return false;
}

async function listReleases(env: Env, id?: string, unsignedOnly = false): Promise<LegacyRelease[]> {
  if (!env.DB) return seedReleases;
  const { results } = await env.DB.prepare(
    "SELECT * FROM releases WHERE app_id=? ORDER BY created_at DESC",
  ).bind(appId(id)).all<ReleaseRow>();
  return results.filter(row => !unsignedOnly || (!row.manifest_json && !row.directive_json)).map(rowToRelease);
}

function rowToRelease(row: ReleaseRow) {
  return {
    id: row.id,
    appId: row.app_id,
    branch: row.branch || row.channel,
    revision: row.revision,
    fingerprint: row.fingerprint,
    manifest: row.manifest_json ? JSON.parse(row.manifest_json) : null,
    version: row.version,
    channel: row.channel,
    platform: row.platform,
    runtimeVersion: row.runtime_version,
    status: row.status,
    rollout: row.rollout,
    createdAt: row.created_at,
    note: row.note,
    launchAssetUrl: row.launch_asset_url,
    assets: JSON.parse(row.assets_json || "[]"),
  };
}

async function createRelease(env: Env, payload: JsonObject) {
  const release: LegacyRelease = {
    id: crypto.randomUUID(),
    version: String(payload.version || "").trim(),
    channel: String(payload.channel || "preview"),
    platform: String(payload.platform || "android").toLowerCase(),
    runtimeVersion: String(
      payload.runtimeVersion || payload.runtime || "54.0.0",
    ),
    status: "Staged",
    rollout: 0,
    createdAt: new Date().toISOString(),
    note: String(payload.note || ""),
    launchAssetUrl: typeof payload.launchAssetUrl === "string" ? payload.launchAssetUrl : null,
    assets: Array.isArray(payload.assets) ? payload.assets : [],
  };
  if (!release.version) throw new Error("version is required");
  if (!env.DB) {
    seedReleases.unshift(release);
    return release;
  }
  const application = appId(payload.app_id ?? payload.appId);
  await requireApp(env, application);
  await env.DB.prepare(
    "INSERT INTO releases (id,version,channel,platform,runtime_version,status,rollout,created_at,note,launch_asset_url,assets_json,app_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      release.id,
      release.version,
      release.channel,
      release.platform,
      release.runtimeVersion,
      release.status,
      release.rollout,
      release.createdAt,
      release.note,
      release.launchAssetUrl,
      JSON.stringify(release.assets),
      application,
    )
    .run();
  return release;
}

async function updateRelease(env: Env, id: string, status: string, rollout: number) {
  if (!env.DB) {
    const release = seedReleases.find((item) => item.id === id);
    if (!release) return null;
    if (status === "Live") {
      seedReleases.forEach((item) => {
        if (
          item.id !== id &&
          item.channel === release.channel &&
          item.platform === release.platform &&
          item.runtimeVersion === release.runtimeVersion &&
          item.status === "Live"
        ) {
          item.status = "Archived";
          item.rollout = 0;
        }
      });
    }
    release.status = status;
    release.rollout = rollout;
    return release;
  }
  if (status === "Live") {
    const current = await env.DB.prepare(
      "SELECT app_id, channel, platform, runtime_version FROM releases WHERE id = ?",
    )
      .bind(id)
      .first<ReleaseRow>();
    if (current) {
      await env.DB.prepare(
        "UPDATE releases SET status = 'Archived', rollout = 0 WHERE channel = ? AND platform = ? AND app_id = ? AND runtime_version = ? AND status = 'Live' AND id != ? AND manifest_json IS NULL AND directive_json IS NULL",
      )
        .bind(current.channel, current.platform, current.app_id, current.runtime_version, id)
        .run();
    }
  }
  await env.DB.prepare(
    "UPDATE releases SET status = ?, rollout = ? WHERE id = ?",
  )
    .bind(status, rollout, id)
    .run();
  const row = await env.DB.prepare("SELECT * FROM releases WHERE id = ?")
    .bind(id)
    .first<ReleaseRow>();
  return row ? rowToRelease(row) : null;
}

async function patchRelease(env: Env, id: string, payload: JsonObject, origin: string) {
  const launchAssetUrl = typeof payload.launchAssetUrl === "string" ? payload.launchAssetUrl : null;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  if (!env.DB) {
    const release = seedReleases.find((item) => item.id === id);
    if (!release) return null;
    if (launchAssetUrl) release.launchAssetUrl = launchAssetUrl;
    if (Array.isArray(payload.assets)) release.assets = assets;
    return release;
  }
  const existing = await env.DB.prepare("SELECT manifest_json,directive_json FROM releases WHERE id=?").bind(id).first();
  if (existing?.manifest_json || existing?.directive_json) throw new Error("Published OTA manifests are immutable; publish a new update");
  await env.DB.prepare(
    "UPDATE releases SET launch_asset_url = COALESCE(?, launch_asset_url), assets_json = CASE WHEN ? THEN ? ELSE assets_json END WHERE id = ?",
  )
    .bind(
      launchAssetUrl,
      Array.isArray(payload.assets) ? 1 : 0,
      JSON.stringify(assets),
      id,
    )
    .run();
  const row = await env.DB.prepare("SELECT * FROM releases WHERE id = ?")
    .bind(id)
    .first<ReleaseRow>();
  return row ? rowToRelease(row) : null;
}

async function ensureApkSchema(env: Env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("ALTER TABLE apks ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // Fresh schema.sql already has sha256; existing databases add it once.
  }
}

function apkPublicUrl(origin: string, key: string) {
  return `${origin}/${key}`;
}

function apkRecord(row: ApkRow, origin: string) {
  const size = Number(row.size);
  return {
    version: row.version,
    arch: row.arch,
    size: Number.isSafeInteger(size) && size > 0 ? size : 0,
    sha256: typeof row.sha256 === "string" ? row.sha256.toLowerCase() : "",
    downloads: row.downloads,
    createdAt: row.created_at,
    key: row.key,
    url: apkPublicUrl(origin, row.key),
    status: row.status,
  };
}

async function listApks(env: Env, origin: string) {
  if (!env.DB) {
    return [
      apkRecord({
        version: "2.3.8",
        size: "48200000",
        arch: "arm64-v8a",
        sha256: "a".repeat(64),
        downloads: 1284,
        created_at: "2024-06-12T00:00:00.000Z",
        key: apkObjectKey("2.3.8", "arm64-v8a"),
        status: "Available",
      }, origin),
    ];
  }
  await ensureApkSchema(env);
  const { results } = await env.DB.prepare(
    "SELECT * FROM apks WHERE key LIKE 'apk/cohub-v%-android-%.apk' AND (app_id IS NULL OR app_id='cohub-mobile') ORDER BY created_at DESC",
  ).all<ApkRow>();
  return results.map((row) => apkRecord(row, origin));
}

async function expoManifest(request: Request, env: Env, url: URL) {
  const channel =
    request.headers.get("expo-channel-name") ||
    url.searchParams.get("channel") ||
    "production";
  const platform =
    request.headers.get("expo-platform") ||
    url.searchParams.get("platform") ||
    "android";
  const runtimeVersion =
    request.headers.get("expo-runtime-version") ||
    url.searchParams.get("runtimeVersion") ||
    "54.0.0";
  const releases = await listReleases(env, request.headers.get("expo-app-id") || url.searchParams.get("app_id") || undefined, true);
  const release = releases.find(
    (item) =>
      item.channel === channel &&
      item.platform === platform &&
      item.runtimeVersion === runtimeVersion &&
      item.status === "Live",
  );
  if (!release) return new Response(null, { status: 204, headers: cors });
  const origin = url.origin;
  const manifest = {
    id: release.id,
    createdAt: release.createdAt,
    runtimeVersion: release.runtimeVersion,
    launchAsset: {
      key: "bundle",
      contentType: "application/javascript",
      url:
        release.launchAssetUrl ||
        `${origin}/api/updates/assets/${release.id}/index.js`,
    },
    assets: release.assets,
    metadata: {
      version: release.version,
      channel: release.channel,
      note: release.note,
    },
    extra: { expoClient: { version: release.version } },
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      ...cors,
      "content-type": "application/expo+json",
      "expo-protocol-version": "1",
      "cache-control": "no-store",
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if ((url.pathname === "/admin" || url.pathname === "/admin/") && ["GET", "HEAD"].includes(request.method)) {
        return env.ASSETS ? env.ASSETS.fetch(new Request(new URL("/", request.url), request)) : json({ error: "Assets are not configured" }, 503);
    }
    if (["/", "/index.html"].includes(url.pathname)) return withCors(json({ error: "Not found" }, 404));
    try {
      if (url.pathname === "/api/health")
        return withCors(
          json({
            ok: true,
            service: "yaota",
            timestamp: new Date().toISOString(),
          }),
        );
      if (url.pathname === "/api/updates" || url.pathname === "/api/manifest")
        return withCors(await expoManifest(request, env, url));
      if (url.pathname === "/api/releases" && request.method === "GET") {
        if (!await authorized(request, env)) return withCors(json({ error: "Unauthorized" }, 401));
        return withCors(json({ releases: await listReleases(env, request.headers.get("expo-app-id") || url.searchParams.get("app_id") || undefined) }, 200, { "cache-control": "private, no-store" }));
      }
      if (url.pathname === "/api/releases" && request.method === "POST") {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        return withCors(
          json(
            { release: await createRelease(env, await request.json()) },
            201,
          ),
        );
      }
      const releaseAction = url.pathname.match(
        /^\/api\/releases\/([^/]+)\/(promote|rollback)$/,
      );
      if (releaseAction && ["POST", "PATCH"].includes(request.method)) {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        const release = await updateRelease(
          env,
          releaseAction[1],
          releaseAction[2] === "promote" ? "Live" : "Archived",
          releaseAction[2] === "promote" ? 100 : 0,
        );
        return withCors(
          release
            ? json({ release })
            : json({ error: "Release not found" }, 404),
        );
      }
      const releasePatch = url.pathname.match(/^\/api\/releases\/([^/]+)$/);
      if (releasePatch && request.method === "PATCH") {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        const release = await patchRelease(
          env,
          releasePatch[1],
          await request.json(),
          url.origin,
        );
        return withCors(
          release
            ? json({ release })
            : json({ error: "Release not found" }, 404),
        );
      }
      if (url.pathname === "/api/apk-releases" && request.method === "GET") {
        if (!env.DB) return withCors(json({ releases: [] }));
        await ensureApkSchema(env);
        const { results } = await env.DB.prepare("SELECT * FROM apk_releases WHERE status='Available' ORDER BY published_at DESC").all<ApkReleaseRow>();
        return withCors(json({ releases: results.map(row => ({ version: row.version, title: row.title, notes: row.notes, releaseUrl: row.release_url, publishedAt: row.published_at })) }));
      }
      if (url.pathname === "/api/apks" && request.method === "GET")
        return withCors(json({ apks: await listApks(env, url.origin) }));
      if (url.pathname === "/api/apks/presign" && request.method === "POST") {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        const body = await request.json();
        const version = String(body.version || "").trim();
        const arch = String(body.arch || "").trim();
        const sha256 = String(body.sha256 || "").trim().toLowerCase();
        const size = Number(body.size);
        if (!APK_VERSION.test(version) || !APK_ABI.test(arch))
          return withCors(json({ error: "version and arch are required" }, 400));
        if (!Number.isSafeInteger(size) || size <= 0)
          return withCors(json({ error: "size must be a positive byte count" }, 400));
        if (!/^[a-f0-9]{64}$/.test(sha256))
          return withCors(json({ error: "sha256 must be a 64-character hex digest" }, 400));
        const key = apkObjectKey(version, arch);
        if (env.DB) {
          await ensureApkSchema(env);
          await env.DB.prepare("INSERT OR REPLACE INTO apk_releases (app_id,version,title,notes,release_url,published_at,status) VALUES (?,?,?,?,?,?,?)")
            .bind("cohub-mobile", version, typeof body.title === "string" ? body.title.trim() || null : null, typeof body.notes === "string" ? body.notes : null, typeof body.releaseUrl === "string" ? body.releaseUrl.trim() || null : null, new Date().toISOString(), "Available").run();
          await env.DB.prepare(
            "INSERT OR REPLACE INTO apks (key,version,size,arch,sha256,downloads,created_at,status,app_id) VALUES (?,?,?,?,?,?,?,?,(SELECT app_id FROM ota_apps WHERE app_id='cohub-mobile'))",
          )
            .bind(key, version, String(size), arch, sha256, 0, new Date().toISOString(), "Available")
            .run();
        }
        return withCors(
          json({
            key,
            uploadUrl: `${url.origin}/api/apks/upload/${encodeURIComponent(key)}`,
            publicUrl: apkPublicUrl(url.origin, key),
          }),
        );
      }
      const updatePresign = url.pathname.match(
        /^\/api\/updates\/([^/]+)\/presign$/,
      );
      if (updatePresign && request.method === "POST") {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        const body = await request.json();
        const key = String(body.key || "index.js").replace(/^\/+/, "");
        return withCors(
          json({
            key,
            uploadUrl: `${url.origin}/api/updates/assets/${updatePresign[1]}/upload/${encodeURIComponent(key)}`,
            publicUrl: `${url.origin}/api/updates/assets/${updatePresign[1]}/${encodeURIComponent(key)}`,
          }),
        );
      }
      const updateAsset = url.pathname.match(
        /^\/api\/updates\/assets\/([^/]+)\/(.+)$/,
      );
      if (updateAsset && request.method === "GET") {
        if (!env.ASSETS_R2)
          return withCors(
            json({ error: "Update asset storage is not configured" }, 404),
          );
        const object = await env.ASSETS_R2.get(
          `updates/${updateAsset[1]}/${decodeURIComponent(updateAsset[2])}`,
        );
        if (!object)
          return withCors(json({ error: "Update asset not found" }, 404));
        const headers = new Headers(cors);
        for (const [key, value] of Object.entries(object.httpMetadata || {})) {
          if (key === "contentType") headers.set("content-type", String(value));
        }
        headers.set("etag", object.httpEtag);
        headers.set("cache-control", "public, max-age=31536000, immutable");
        return new Response(object.body as unknown as ReadableStream, { headers });
      }
      const updateUpload = url.pathname.match(
        /^\/api\/updates\/assets\/([^/]+)\/upload\/(.+)$/,
      );
      if (updateUpload && request.method === "PUT") {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        if (!env.ASSETS_R2)
          return withCors(
            json({ error: "R2 binding ASSETS_R2 is required" }, 501),
          );
        const key = `updates/${updateUpload[1]}/${decodeURIComponent(updateUpload[2])}`;
        await env.ASSETS_R2.put(key, await request.arrayBuffer(), {
          httpMetadata: {
            contentType:
              request.headers.get("content-type") || "application/octet-stream",
          },
        });
        return withCors(json({ ok: true, key }));
      }
      const upload = url.pathname.match(/^\/api\/apks\/upload\/(.+)$/);
      if (upload && request.method === "PUT") {
        if (!await authorized(request, env))
          return withCors(json({ error: "Unauthorized" }, 401));
        if (!env.ASSETS_R2)
          return withCors(
            json({ error: "R2 binding ASSETS_R2 is required" }, 501),
          );
        const key = decodeURIComponent(upload[1]);
        const filename = key.startsWith("apk/") ? key.slice(4) : "";
        if (!APK_FILE.test(filename) || !request.body)
          return withCors(json({ error: "Invalid APK upload" }, 400));
        // Stream into R2. Buffering the APK (~60MB) as an ArrayBuffer exceeds Worker memory.
        const stored = await env.ASSETS_R2.put(key, request.body as unknown as WorkersReadableStream, {
          httpMetadata: {
            contentType: "application/vnd.android.package-archive",
          },
        });
        if (stored && env.DB) await env.DB.prepare("UPDATE apks SET size_bytes=?,app_id=(SELECT app_id FROM ota_apps WHERE app_id='cohub-mobile') WHERE key=?").bind(stored.size, key).run();
        return withCors(json({ ok: true, key }));
      }
      if (url.pathname.startsWith("/apk/") && request.method === "GET") {
        const filename = decodeURIComponent(url.pathname.slice("/apk/".length));
        if (!APK_FILE.test(filename))
          return withCors(json({ error: "APK not found" }, 404));
        if (!env.ASSETS_R2)
          return withCors(
            json({ error: "APK storage is not configured" }, 404),
          );
        const key = `apk/${filename}`;
        const object = await env.ASSETS_R2.get(key);
        if (!object) return withCors(json({ error: "APK not found" }, 404));
        if (env.DB) await env.DB.prepare("UPDATE apks SET downloads = downloads + 1 WHERE key = ?").bind(key).run();
        const headers = new Headers(cors);
        headers.set("content-type", object.httpMetadata?.contentType || "application/vnd.android.package-archive");
        headers.set("etag", object.httpEtag);
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        headers.set("content-length", String(object.size));
        headers.set("cache-control", "public, max-age=31536000, immutable");
        return new Response(object.body as unknown as ReadableStream, { headers });
      }
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response("Not found", { status: 404 });
    } catch (error) {
      return withCors(json({ error: error instanceof Error ? error.message : "Request failed" }, 400));
    }
  },
};

// Hono is the routing layer used by the Cloudflare Workers + Vite integration.
// Keeping the handler boundary explicit also makes it easy to test with app.request().
const app = new Hono<{ Bindings: Env }>();
app.route("/", ota);
app.all("*", (c) => worker.fetch(c.req.raw, c.env || {}));

export default app;
