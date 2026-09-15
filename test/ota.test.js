import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, verify, createHash, randomBytes } from "node:crypto";
import { testCertificate } from "./helpers/signing.ts";
import app from "../worker.ts";
import { createVerifiedPatch } from "../scripts/delta.ts";
import { bucket } from "../src/ota-protocol.ts";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { parseDictionary } from "structured-headers";
import { publishExport } from "../scripts/publisher.ts";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  sql.exec("INSERT INTO ota_apps(app_id) VALUES ('cohub-mobile')");
  const objects = new Map();
  const env = {
    OTA_APP_ID: "cohub-mobile", OTA_API_KEY: "publish-secret", YAOTA_ADMIN_TOKEN: "admin-secret",
    CODE_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    DB: { async batch(statements) {
      sql.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec("COMMIT"); return result; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    }, prepare(query) {
      const stmt = sql.prepare(query);
      const bound = (args) => ({
        bind: (...values) => bound(values),
        first: async () => stmt.get(...args),
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => stmt.run(...args),
      });
      return bound([]);
    } },
    ASSETS_R2: {
      async head(key) { const object = objects.get(key); return object && { size: object.bytes.byteLength, customMetadata: object.options?.customMetadata }; },
      async put(key, bytes, options) {
        if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
        if (bytes instanceof ReadableStream) bytes = await new Response(bytes).arrayBuffer();
        objects.set(key, { bytes, options }); return { size: bytes.byteLength };
      },
      async delete(key) { objects.delete(key); },
      async get(key) {
        const object = objects.get(key);
        return object && { body: object.bytes, size: object.bytes.byteLength, httpEtag: '"test"', writeHttpMetadata(headers) {
          headers.set("content-type", object.options.httpMetadata.contentType);
        } };
      },
    },
  };
  return { sql, objects, env };
}
const runtime = "a".repeat(40);
function upload(env, overrides = {}, request = {}) {
  const fields = {
    channel: "production", platform: "android", runtimeVersion: runtime, fingerprint: "b".repeat(40),
    expoConfig: JSON.stringify({ version: "2.2.0", slug: "cohub-mobile", extra: { api: "https://example.com" }, updates: { requestHeaders: { "expo-app-id": "cohub-mobile" } } }),
    metadata: JSON.stringify({ fileMetadata: { android: { assets: [{ path: "assets/imagehash", ext: "png" }] }, ios: { assets: [{ path: "assets/imagehash", ext: "png" }] } } }),
    ...overrides,
  };
  const body = new FormData();
  Object.entries(fields).forEach(([key, value]) => body.set(key, value));
  body.set("bundle", new File([overrides.bundleBytes || "hermes-bytecode-fixture"], "index.hbc"));
  body.set("asset-0", new File(["image-fixture"], "imagehash"));
  return app.request(request.path || "/upload", { method: "POST", headers: request.headers || { "x-ota-api-key": "publish-secret" }, body }, env);
}
async function manifest(env, overrides = {}) {
  return app.request("/manifest", { headers: {
    "expo-app-id": "cohub-mobile", "expo-channel-name": "production", "expo-platform": "android",
    "expo-runtime-version": runtime, "expo-protocol-version": "1",
    "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"', ...overrides,
  } }, env);
}
async function signedContent(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type"), /multipart\/mixed/);
  assert.equal(response.headers.get("expo-sfv-version"), "0");
  const body = await response.text();
  const signature = /expo-signature: sig="([^"]+)", keyid="main"/.exec(body)?.[1];
  const json = body.split("\r\n\r\n")[1].split("\r\n--")[0];
  assert.ok(verify("RSA-SHA256", Buffer.from(json), keys.publicKey, Buffer.from(signature, "base64")));
  assert.equal(verify("RSA-SHA256", Buffer.from(json + " "), keys.publicKey, Buffer.from(signature, "base64")), false);
  return JSON.parse(json);
}
test("pinned CLI multipart contract publishes signed manifest and byte-exact assets", async () => {
  const f = fixture();
  try {
    const result = await upload(f.env);
    assert.equal(result.status, 201, await result.clone().text());
    const m = await signedContent(await manifest(f.env));
    assert.equal(m.extra.expoClient.extra.api, "https://example.com");
    assert.match(m.id, /^[a-f0-9-]{36}$/);
    for (const asset of [m.launchAsset, ...m.assets]) {
      const downloaded = await app.request(asset.url, {}, f.env);
      assert.equal(downloaded.status, 200);
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      assert.equal(createHash("sha256").update(bytes).digest("base64url"), asset.hash);
      assert.equal(createHash("md5").update(bytes).digest("hex"), asset.key);
    }
    assert.equal(m.assets[0].fileExtension, ".png");
    assert.equal(m.assets[0].contentType, "image/png");
    assert.equal((await signedContent(await manifest(f.env, { "expo-current-update-id": m.id }))).type, "noUpdateAvailable");
    const listed = await app.request("/api/ota/state?app_id=cohub-mobile", { headers: { authorization: "Bearer admin-secret" } }, f.env);
    assert.equal((await listed.json()).releases[0].id, m.id);
  } finally { f.sql.close(); }
});

const manage = (env, path, data = {}, method = "POST") => app.request(`/api/ota/${path}${path.includes("?") || path === "apps" ? "" : "?app_id=cohub-mobile"}`, {
  method, headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify(data),
}, env);

async function dashboardState(env, appId = "cohub-mobile") {
  const response = await app.request(`/api/ota/state?app_id=${appId}`, { headers: { authorization: "Bearer admin-secret" } }, env);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test("implicit channels reflect fallback routes and become revision-guarded explicit mappings", async () => {
  const f = fixture();
  try {
    await upload(f.env);
    await upload(f.env, { channel: "beta", branch: "candidate" });
    const before = await dashboardState(f.env);
    assert.deepEqual(before.channels.map(channel => [channel.name, channel.branch, channel.implicit, channel.revision]), [
      ["beta", "beta", true, -1], ["candidate", "candidate", true, -1], ["production", "production", true, -1],
    ]);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM ota_channels").get().n, 0);
    assert.equal((await manage(f.env, "channels/production", { branch: "production", revision: -1 }, "PUT")).status, 200);
    const after = await dashboardState(f.env);
    assert.equal(after.channels.find(channel => channel.name === "production").implicit, false);
    assert.equal((await manage(f.env, "channels/production", { branch: "other", revision: -1 }, "PUT")).status, 409);
    await manage(f.env, "apps", { app_id: "other" });
    assert.deepEqual((await dashboardState(f.env, "other")).channels, []);
  } finally { f.sql.close(); }
});

test("dashboard reports byte sizes, reusable resources and scoped patch baselines without changing signed manifests", async () => {
  const f = fixture();
  try {
    const oldBytes = Buffer.from("abcdef".repeat(3000));
    const newBytes = Buffer.from("abcdef".repeat(2999) + "change");
    const base = await (await upload(f.env, { bundleBytes: oldBytes })).json();
    const target = await (await upload(f.env, { bundleBytes: newBytes })).json();
    const original = f.sql.prepare("SELECT manifest_json FROM releases WHERE id=?").get(target.id).manifest_json;
    const patch = await createVerifiedPatch(oldBytes, newBytes);
    assert.equal((await app.request(`/ota-patches/${base.id}/${target.id}`, { method: "PUT", headers: { "x-ota-api-key": "publish-secret", "expo-app-id": "cohub-mobile" }, body: patch }, f.env)).status, 200);
    const state = await dashboardState(f.env);
    const delivery = state.releases.find(row => row.id === target.id).delivery;
    assert.equal(delivery.bundleBytes, newBytes.length);
    assert.equal(delivery.assetBytes, Buffer.byteLength("image-fixture"));
    assert.equal(delivery.totalBytes, newBytes.length + delivery.assetBytes);
    assert.equal(delivery.reusedAssetCount, 1);
    assert.equal(delivery.reusedAssetBytes, delivery.assetBytes);
    assert.equal(delivery.previousUpdateId, base.id);
    assert.deepEqual(delivery.patches.map(p => [p.baseId, p.bytes]), [[base.id, patch.byteLength]]);
    assert.equal(delivery.patches[0].savingsPercent, Math.round((1 - patch.byteLength / newBytes.length) * 1000) / 10);
    assert.equal(f.sql.prepare("SELECT manifest_json FROM releases WHERE id=?").get(target.id).manifest_json, original);
    await manage(f.env, "apps", { app_id: "other" });
    await upload(f.env, { bundleBytes: newBytes, expoConfig: JSON.stringify({ updates: { requestHeaders: { "expo-app-id": "other" } } }) });
    assert.deepEqual((await dashboardState(f.env, "other")).releases[0].delivery.patches, []);
    const hash = JSON.parse(original).launchAsset.hash;
    f.sql.prepare("DELETE FROM ota_blobs WHERE hash=?").run(hash);
    const missing = (await dashboardState(f.env)).releases.find(row => row.id === target.id).delivery;
    assert.equal(missing.bundleBytes, null);
    assert.equal(missing.totalBytes, null);
    assert.equal(missing.patches[0].savingsPercent, null);
  } finally { f.sql.close(); }
});

test("APK uploads measure bytes, keep apps and architectures separate, and require authorization", async () => {
  const f = fixture();
  try {
    await manage(f.env, "apps", { app_id: "other" });
    const apkBytes = Buffer.from([80, 75, 3, 4, 1, 2, 3, 4]);
    function apkForm(appId = "cohub-mobile", arch = "arm64-v8a") {
      const form = new FormData();
      for (const [key, value] of Object.entries({ app_id: appId, version: "2.2.11", arch, size: "999 MB" })) form.set(key, value);
      form.set("file", new File([apkBytes], "test.apk"));
      return form;
    }
    assert.equal((await app.request("/api/ota/apks", { method: "POST", body: apkForm() }, f.env)).status, 401);
    for (const appId of ["cohub-mobile", "other"]) {
      for (const arch of ["arm64-v8a", "x86_64"]) {
        const response = await app.request("/api/ota/apks", { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: apkForm(appId, arch) }, f.env);
        assert.equal(response.status, 201, await response.clone().text());
        const { apk } = await response.json();
        assert.equal(apk.sizeBytes, apkBytes.length);
        assert.equal(apk.appId, appId);
        const downloaded = await app.request(apk.downloadUrl, {}, f.env);
        assert.equal(downloaded.headers.get("content-length"), String(apkBytes.length));
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), apkBytes);
      }
    }
    assert.equal(f.objects.size, 4);
    const listed = await dashboardState(f.env);
    assert.equal(listed.apks.length, 2);
    assert.ok(listed.apks.every(apk => apk.appId === "cohub-mobile"));
    const published = await app.request("/ota-publish/apks", { method: "POST", headers: { "x-ota-api-key": "publish-secret" }, body: apkForm() }, f.env);
    assert.equal(published.status, 201);
    assert.equal((await app.request("/api/ota/apks", { headers: { authorization: "Bearer admin-secret" } }, f.env)).status, 400);
    const conflicting = await app.request("/api/ota/apks?app_id=other", { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: apkForm() }, f.env);
    assert.equal(conflicting.status, 400);
    const invalid = apkForm(); invalid.set("file", new File(["not an apk"], "test.apk"));
    assert.equal((await app.request("/api/ota/apks", { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: invalid }, f.env)).status, 400);
  } finally { f.sql.close(); }
});

test("two-step APK uploads stay pending until stored and cannot overwrite other apps or published APKs", async () => {
  const f = fixture();
  try {
    await manage(f.env, "apps", { app_id: "other" });
    const headers = { authorization: "Bearer admin-secret", "content-type": "application/json" };
    const reserved = await app.request("/api/ota/apks/presign?app_id=cohub-mobile", { method: "POST", headers, body: JSON.stringify({ version: "1", arch: "universal", size: "100 MB" }) }, f.env);
    assert.equal(reserved.status, 200);
    const { uploadUrl } = await reserved.json();
    assert.equal((await dashboardState(f.env)).apks[0].status, "Pending");
    assert.equal((await dashboardState(f.env)).apks[0].sizeBytes, null);
    assert.equal((await (await app.request("/api/apks", {}, f.env)).json()).apks.length, 0);
    const body = Buffer.from([80, 75, 3, 4, 5]);
    assert.equal((await app.request(uploadUrl.replace("app_id=cohub-mobile", "app_id=other"), { method: "PUT", headers, body }, f.env)).status, 404);
    const batch = f.env.DB.batch;
    f.env.DB.batch = async () => { throw new Error("D1 temporarily unavailable"); };
    assert.equal((await app.request(uploadUrl, { method: "PUT", headers, body }, f.env)).status, 500);
    f.env.DB.batch = batch;
    assert.equal((await app.request(uploadUrl, { method: "PUT", headers, body: Buffer.from([80,75,3,4,6]) }, f.env)).status, 409);
    assert.equal((await app.request(uploadUrl, { method: "PUT", headers, body }, f.env)).status, 200);
    assert.equal((await app.request(uploadUrl, { method: "PUT", headers, body }, f.env)).status, 409);
    assert.equal((await dashboardState(f.env)).apks[0].sizeBytes, body.length);
    const publicList = await app.request("/api/apks", { headers: { origin: "https://example.com" } }, f.env);
    assert.equal(publicList.headers.get("access-control-allow-origin"), "*");
  } finally { f.sql.close(); }
});

test("GitHub APK import uses release asset sizes, is idempotent and rejects unrelated download origins", async t => {
  const f = fixture();
  try {
    const asset = { id: 123, name: "client-v1-android-arm64-v8a.apk", size: 123456, state: "uploaded", browser_download_url: "https://github.com/example/mobile/releases/download/v1/client.apk", created_at: new Date().toISOString() };
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/example/mobile/releases/tags/v1");
      assert.equal(options.redirect, "manual", "Workers supports manual, not error, for redirects");
      return Response.json({ tag_name: "v1", assets: [asset] });
    });
    const data = { repository: "example/mobile", tag: "v1" };
    assert.equal((await app.request("/api/ota/apks/github?app_id=cohub-mobile", { method: "POST", body: JSON.stringify(data) }, f.env)).status, 401);
    for (let i = 0; i < 2; i++) assert.equal((await manage(f.env, "apks/github", data)).status, 201);
    const apks = (await dashboardState(f.env)).apks;
    assert.equal(apks.length, 1);
    assert.equal(apks[0].sizeBytes, asset.size);
    assert.equal(apks[0].arch, "arm64-v8a");
    assert.equal(apks[0].source, "GitHub");
    assert.equal(f.objects.size, 0);
    asset.browser_download_url = "https://untrusted.example/package.apk";
    assert.equal((await manage(f.env, "apks/github", data)).status, 502);
    assert.equal((await manage(f.env, "apks/github", { repository: "../mobile" })).status, 400);
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "https://untrusted.example" } }));
    assert.equal((await manage(f.env, "apks/github", data)).status, 502);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
    const offline = await manage(f.env, "apks/github", data);
    assert.equal(offline.status, 502);
    assert.match(await offline.text(), /Unable to reach GitHub/);
  } finally { f.sql.close(); }
});

test("artifact migration preserves legacy APKs without guessing app ownership or numeric sizes", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec("CREATE TABLE ota_apps(app_id TEXT PRIMARY KEY); CREATE TABLE apks(key TEXT PRIMARY KEY,version TEXT,size TEXT,arch TEXT,downloads INTEGER,created_at TEXT,status TEXT); INSERT INTO apks VALUES('apk/old.apk','1','48 MB','arm64-v8a',5,'2026-01-01','Available')");
    sql.exec(readFileSync(new URL("../migrations/0006_artifact_metrics.sql", import.meta.url), "utf8"));
    const row = sql.prepare("SELECT * FROM apks").get();
    assert.equal(row.app_id, null);
    assert.equal(row.size_bytes, null);
    assert.equal(row.size, "48 MB");
    assert.equal(row.downloads, 5);
  } finally { sql.close(); }
});

const signingPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const signingCertificate = testCertificate(signingPem);
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPem = otherKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const otherCertificate = testCertificate(otherPem);
const credentials = (env, appId = "cohub-mobile") => app.request(`/api/ota/credentials?app_id=${appId}`, { headers: { authorization: "Bearer admin-secret" } }, env);
const importKey = (env, keyId = "main", revision = 0, overrides = {}) => manage(env, `credentials/signing/keys/${keyId}`, { certificate: signingCertificate, privateKey: signingPem, revision, ...overrides }, "PUT");

test("credential APIs require admin and explicit registered app; responses never disclose secrets", async () => {
  const f = fixture();
  try {
    f.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    for (const [path, method] of [["credentials", "GET"], ["credentials/signing/validate", "POST"], ["credentials/signing/keys/main", "PUT"], ["credentials/signing/default", "PUT"], ["credentials/signing/keys/main/revoke", "POST"], ["credentials/signing/keys/main/certificate", "GET"], ["credentials/publishing/tokens", "POST"], ["credentials/publishing/tokens/none/revoke", "POST"], ["credentials/publishing/legacy", "PUT"]]) {
      assert.equal((await app.request(`/api/ota/${path}?app_id=cohub-mobile`, { method }, f.env)).status, 401, path);
    }
    assert.equal((await credentials(f.env, "missing")).status, 404);
    assert.equal((await credentials(f.env, "cohub-mobile&app_id=other")).status, 400);
    assert.equal((await app.request("/api/ota/credentials", { headers: { authorization: "Bearer admin-secret" } }, f.env)).status, 400);
    assert.equal((await importKey(f.env)).status, 201);
    const response = await credentials(f.env);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const state = await response.json();
    assert.equal(state.signing.keys[0].source, "managed");
    assert.equal(state.signing.configured, true);
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes("PRIVATE KEY"));
    assert.ok(!serialized.includes("encrypted_private_key"));
    assert.ok(!serialized.includes(f.env.CREDENTIALS_ENCRYPTION_KEY));
    const stored = f.sql.prepare("SELECT encrypted_private_key FROM ota_signing_keys").get().encrypted_private_key;
    assert.ok(!stored.includes("PRIVATE KEY"));
    assert.ok(!serialized.includes(stored));
    const cert = await app.request("/api/ota/credentials/signing/keys/main/certificate?app_id=cohub-mobile", { headers: { authorization: "Bearer admin-secret" } }, f.env);
    assert.equal(cert.status, 200);
    assert.match(await cert.text(), /BEGIN CERTIFICATE/);
    const events = JSON.stringify(f.sql.prepare("SELECT * FROM ota_events").all());
    assert.ok(!events.includes("PRIVATE KEY"));
    assert.ok(!events.includes(stored));
  } finally { f.sql.close(); }
});

test("signing import validates PEM, key match, RSA strength, expiry, encryption and revisions", async () => {
  const f = fixture();
  try {
    assert.equal((await importKey(f.env)).status, 503);
    f.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    const weakPem = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
    for (const data of [
      { certificate: "invalid", privateKey: "invalid" },
      { certificate: signingCertificate + signingCertificate, privateKey: signingPem },
      { certificate: signingCertificate, privateKey: otherPem },
      { certificate: testCertificate(signingPem, true), privateKey: signingPem },
      { certificate: testCertificate(weakPem), privateKey: weakPem },
    ]) assert.equal((await manage(f.env, "credentials/signing/validate", data)).status, 400);
    assert.equal((await manage(f.env, "credentials/signing/validate", { certificate: signingCertificate, privateKey: signingPem })).status, 200);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM ota_signing_keys").get().n, 0, "validation does not persist");
    assert.equal((await importKey(f.env)).status, 201);
    assert.equal((await importKey(f.env, "other", 0)).status, 409);
    assert.equal((await importKey(f.env, "main", 1, { certificate: otherCertificate, privateKey: otherPem })).status, 409);
    assert.equal((await importKey(f.env, "main", 1)).status, 200);
    const oversized = await manage(f.env, "credentials/signing/validate", { certificate: "a".repeat(70000), privateKey: signingPem });
    assert.equal(oversized.status, 413);
    const malformed = await app.request("/api/ota/credentials/signing/validate?app_id=cohub-mobile", { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: "{secret" }, f.env);
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes("secret"));
  } finally { f.sql.close(); }
});

test("managed signing rotates across key IDs, stays app-scoped and revoked keys never fall back", async () => {
  const f = fixture();
  try {
    f.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    await manage(f.env, "apps", { app_id: "beta" });
    assert.equal((await importKey(f.env)).status, 201);
    assert.equal((await importKey(f.env, "next", 1, { certificate: otherCertificate, privateKey: otherPem, makeDefault: true })).status, 201);
    assert.equal((await upload(f.env)).status, 201);
    for (const [keyId, publicKey] of [["main", keys.publicKey], ["next", otherKeys.publicKey]]) {
      const response = await manifest(f.env, { "expo-expect-signature": `sig, keyid="${keyId}"`, accept: "application/json" });
      assert.equal(response.status, 200);
      const header = parseDictionary(response.headers.get("expo-signature"));
      assert.equal(header.get("keyid")[0], keyId);
      assert.ok(verify("RSA-SHA256", Buffer.from(await response.text()), publicKey, Buffer.from(header.get("sig")[0], "base64")));
    }
    const next = await manifest(f.env, { "expo-expect-signature": "sig", accept: "application/json" });
    assert.equal(parseDictionary(next.headers.get("expo-signature")).get("keyid")[0], "next");
    assert.equal((await manifest(f.env, { "expo-app-id": "beta", "expo-expect-signature": 'sig, keyid="next"' })).status, 406);
    const beta = await (await credentials(f.env, "beta")).json();
    assert.equal(beta.signing.keys.some(key => key.keyId === "next"), false);
    assert.equal((await manage(f.env, "credentials/signing/keys/main/revoke", { revision: 2 })).status, 400);
    assert.equal((await manage(f.env, "credentials/signing/keys/main/revoke", { revision: 2, confirm: true })).status, 200);
    assert.equal((await manifest(f.env)).status, 503);
    assert.equal((await importKey(f.env, "main", 3)).status, 409);
    assert.equal(f.sql.prepare("SELECT encrypted_private_key FROM ota_signing_keys WHERE key_id='main'").get().encrypted_private_key, null);
    assert.equal((await manage(f.env, "credentials/signing/default", { keyId: "main", revision: 3 }, "PUT")).status, 503);
    assert.equal((await manifest(f.env, { "expo-expect-signature": 'sig, keyid="next"' })).status, 200);
  } finally { f.sql.close(); }
});

test("managed keys fail closed on ciphertext tampering, app/key replay and lost encryption secret", async () => {
  const f = fixture();
  try {
    f.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
    await importKey(f.env);
    const original = f.sql.prepare("SELECT encrypted_private_key FROM ota_signing_keys").get().encrypted_private_key;
    const tampered = Buffer.from(original, "base64url"); tampered[30] ^= 1;
    f.sql.prepare("UPDATE ota_signing_keys SET encrypted_private_key=?").run(tampered.toString("base64url"));
    assert.equal((await manifest(f.env)).status, 503);
    f.sql.prepare("UPDATE ota_signing_keys SET encrypted_private_key=?,key_id='copied'").run(original);
    assert.equal((await manifest(f.env, { "expo-expect-signature": 'sig, keyid="copied"' })).status, 503);
    f.sql.exec("UPDATE ota_signing_keys SET key_id='main',app_id='beta'");
    assert.equal((await manifest(f.env, { "expo-app-id": "beta" })).status, 503);
    f.sql.exec("UPDATE ota_signing_keys SET app_id='cohub-mobile'");
    delete f.env.CREDENTIALS_ENCRYPTION_KEY;
    assert.equal((await manifest(f.env)).status, 503);
    assert.equal((await upload(f.env)).status, 503);
  } finally { f.sql.close(); }
});

test("publishing tokens are one-time, hashed, revision-guarded, revocable and cannot authorize admin routes", async () => {
  const f = fixture();
  try {
    const created = await manage(f.env, "credentials/publishing/tokens", { name: "CI", revision: 0 });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "private, no-store");
    const token = await created.json();
    assert.match(token.token, /^yaota_pub_[A-Za-z0-9_-]{43}$/);
    assert.equal((await manage(f.env, "credentials/publishing/tokens", { name: "stale", revision: 0 })).status, 409);
    const state = await (await credentials(f.env)).json();
    assert.ok(!JSON.stringify(state).includes(token.token));
    assert.ok(!JSON.stringify(state).includes("token_hash"));
    const stored = f.sql.prepare("SELECT * FROM ota_publishing_tokens").get();
    assert.equal(stored.token_hash, createHash("sha256").update(token.token).digest("hex"));
    assert.ok(!JSON.stringify(f.sql.prepare("SELECT * FROM ota_events").all()).includes(token.token));
    assert.equal((await upload(f.env, {}, { headers: { "x-ota-api-key": token.token } })).status, 201);
    assert.equal((await app.request("/api/ota/apps", { headers: { authorization: `Bearer ${token.token}` } }, f.env)).status, 401);
    assert.equal((await manage(f.env, "credentials/publishing/legacy", { enabled: false, confirm: true, revision: 1 }, "PUT")).status, 200);
    assert.equal((await upload(f.env)).status, 401);
    assert.equal((await upload(f.env, {}, { headers: { "x-ota-api-key": token.token } })).status, 201);
    assert.equal((await manage(f.env, `credentials/publishing/tokens/${token.id}/revoke`, { revision: 2, confirm: true })).status, 200);
    assert.equal((await upload(f.env, {}, { headers: { "x-ota-api-key": token.token } })).status, 401);
    assert.equal((await app.request("/ota-publish/releases?app_id=cohub-mobile", { headers: { "x-ota-api-key": token.token } }, f.env)).status, 401);
    assert.equal((await upload(f.env, {}, { path: "/api/ota/upload", headers: { authorization: "Bearer admin-secret" } })).status, 201);
    delete f.env.OTA_API_KEY;
    assert.equal((await upload(f.env, {}, { path: "/api/ota/upload", headers: { authorization: "Bearer admin-secret" } })).status, 201);
    assert.equal((await upload(f.env, {}, { path: "/api/ota/upload", headers: {} })).status, 401);
  } finally { f.sql.close(); }
});

test("app management never mutates shared Worker bindings or crosses app scopes", async () => {
  const f = fixture();
  try {
    Object.freeze(f.env);
    for (const appId of ["alpha", "beta"]) {
      assert.equal((await manage(f.env, "apps", { app_id: appId })).status, 201);
      const result = await manage(f.env, `channels/production?app_id=${appId}`, { branch: `${appId}-stable`, revision: -1 }, "PUT");
      assert.equal(result.status, 200, await result.clone().text());
    }
    for (const appId of ["beta", "alpha", "beta"]) {
      const response = await app.request(`/api/ota/state?app_id=${appId}`, { headers: { authorization: "Bearer admin-secret" } }, f.env);
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.deepEqual(state.channels.map(c => c.branch), [`${appId}-stable`]);
      assert.equal(state.events.length, 2, "create app and map channel belong to this app");
    }
  } finally { f.sql.close(); }
});

test("apps require explicit creation, reject ambiguous selection and never register failed publications", async () => {
  const f = fixture();
  try {
    assert.equal((await manage(f.env, "apps", { app_id: "cohub-mobile" })).status, 409);
    assert.equal((await upload(f.env, { app_id: "unregistered", expoConfig: "{}" })).status, 404);
    assert.equal((await upload(f.env, { app_id: "different" })).status, 400);
    assert.equal((await upload(f.env, { expoConfig: "{}" })).status, 400);
    assert.equal((await app.request("/api/ota/state", { headers: { authorization: "Bearer admin-secret" } }, f.env)).status, 400);
    assert.equal((await app.request("/api/ota/state?app_id=cohub-mobile&app_id=other", { headers: { authorization: "Bearer admin-secret" } }, f.env)).status, 400);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM ota_apps").get().n, 1);
    assert.equal((await app.request("/api/ota/apps", { method: "POST", body: JSON.stringify({ app_id: "attacker" }) }, f.env)).status, 401);
    assert.equal(f.env.OTA_APP_ID, "cohub-mobile");
  } finally { f.sql.close(); }
});

test("app-specific signing keys cannot be selected across apps", async () => {
  const f = fixture();
  try {
    const betaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await manage(f.env, "apps", { app_id: "beta" });
    f.env.CODE_SIGNING_APPS = JSON.stringify({
      "cohub-mobile": { main: { privateKey: f.env.CODE_SIGNING_PRIVATE_KEY } },
      beta: { main: { privateKey: betaKeys.privateKey.export({ type: "pkcs8", format: "pem" }) } },
    });
    await upload(f.env, { app_id: "beta", expoConfig: "{}" });
    const response = await manifest(f.env, { "expo-app-id": "beta", accept: "application/json" });
    const signature = Buffer.from(parseDictionary(response.headers.get("expo-signature")).get("sig")[0], "base64");
    const bytes = Buffer.from(await response.text());
    assert.ok(verify("RSA-SHA256", bytes, betaKeys.publicKey, signature));
    assert.equal(verify("RSA-SHA256", bytes, keys.publicKey, signature), false);
    assert.equal((await manifest(f.env, { "expo-app-id": "unconfigured" })).status, 503);
  } finally { f.sql.close(); }
});

test("registry migration preserves existing releases and channels without seeding a default app", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ota_apps").get().n, 0);
    sql.exec("DROP TABLE ota_apps; INSERT INTO ota_channels(app_id,name,branch,seed) VALUES('existing','production','stable','seed')");
    const migration = readFileSync(new URL("../migrations/0003_app_registry.sql", import.meta.url), "utf8");
    sql.exec(migration);
    sql.exec(migration);
    assert.deepEqual(sql.prepare("SELECT app_id FROM ota_apps").all().map(r => r.app_id), ["existing"]);
  } finally { sql.close(); }
});

test("rollout cohorts persist, grow monotonically, block overlapping publications and cancel via republish", async () => {
  const f = fixture();
  try {
    const base = await (await upload(f.env)).json();
    const candidate = await (await upload(f.env, { rollout: "10", bundleBytes: "candidate" })).json();
    const clients = Array.from({ length: 200 }, (_, i) => `device-${i}`);
    const inside = clients.find(id => bucket(candidate.id, id) < 10);
    const outside = clients.find(id => bucket(candidate.id, id) >= 60);
    assert.ok(inside && outside);
    for (let i = 0; i < 2; i++) {
      assert.equal((await signedContent(await manifest(f.env, { "yaota-client-id": inside }))).id, candidate.id);
      assert.equal((await signedContent(await manifest(f.env, { "yaota-client-id": outside }))).id, base.id);
    }
    const response = await manifest(f.env);
    assert.ok(parseDictionary(response.headers.get("expo-server-defined-headers")).get("yaota-client-id"));
    assert.equal((await upload(f.env)).status, 409);
    assert.equal((await manage(f.env, `releases/${candidate.id}/rollout`, { percentage: 60, revision: 0 })).status, 200);
    assert.equal((await manage(f.env, `releases/${candidate.id}/rollout`, { percentage: 100, revision: 0 })).status, 409);
    assert.equal((await manage(f.env, `releases/${candidate.id}/rollout`, { percentage: 5, revision: 1 })).status, 409);
    const rolled = await manage(f.env, `releases/${candidate.id}/rollback`, { revision: 1 });
    assert.equal(rolled.status, 200, await rolled.clone().text());
    const release = (await rolled.json()).release;
    assert.equal(release.sourceId, base.id);
    assert.ok(release.createdAt > candidate.createdAt);
    assert.equal((await signedContent(await manifest(f.env, { "yaota-client-id": inside }))).id, release.id);
    assert.equal((await upload(f.env)).status, 201);
  } finally { f.sql.close(); }
});

test("embedded rollback is signed, ordered and superseded by subsequent publication", async () => {
  const f = fixture();
  try {
    const release = await (await upload(f.env)).json();
    const result = await manage(f.env, `releases/${release.id}/embedded`);
    assert.equal(result.status, 200, await result.clone().text());
    const directive = await signedContent(await manifest(f.env));
    assert.equal(directive.type, "rollBackToEmbedded");
    assert.ok(directive.parameters.commitTime > release.createdAt);
    assert.equal((await manifest(f.env, { accept: "application/json" })).status, 406);
    assert.equal((await manifest(f.env, { "expo-protocol-version": "0" })).status, 406);
    const next = await (await upload(f.env)).json();
    assert.equal((await signedContent(await manifest(f.env))).id, next.id);
  } finally { f.sql.close(); }
});

test("branch mappings support cohort rollout, progress and cancellation with manifest filters", async () => {
  const f = fixture();
  try {
    const stable = await (await upload(f.env, { branch: "stable" })).json();
    const next = await (await upload(f.env, { branch: "next", bundleBytes: "next" })).json();
    const mapped = await manage(f.env, "channels/production", { branch: "stable", revision: -1 }, "PUT");
    assert.equal(mapped.status, 200);
    assert.equal((await signedContent(await manifest(f.env))).id, stable.id);
    const start = await manage(f.env, "channels/production", { action: "start", rolloutBranch: "next", percentage: 20, revision: 0 }, "PUT");
    assert.equal(start.status, 200, await start.clone().text());
    const channel = await start.json();
    const clients = Array.from({ length: 100 }, (_, i) => `client-${i}`);
    const inside = clients.find(id => bucket(channel.seed, id) < 20);
    const outside = clients.find(id => bucket(channel.seed, id) >= 20);
    const selected = await manifest(f.env, { "yaota-client-id": inside });
    assert.equal(parseDictionary(selected.headers.get("expo-manifest-filters")).get("branch")[0], "next");
    assert.equal((await signedContent(selected)).id, next.id);
    assert.equal((await signedContent(await manifest(f.env, { "yaota-client-id": outside }))).id, stable.id);
    assert.equal((await upload(f.env)).status, 409, "ambiguous channel publication is rejected");
    const cancel = await manage(f.env, "channels/production", { action: "cancel", revision: 1 }, "PUT");
    assert.equal(cancel.status, 200);
    const reverted = await manifest(f.env, { "yaota-client-id": inside });
    assert.equal(parseDictionary(reverted.headers.get("expo-manifest-filters")).get("branch")[0], "stable");
    assert.equal((await signedContent(reverted)).id, stable.id);
    assert.equal((await manage(f.env, "channels/production", { branch: "next", revision: 0 }, "PUT")).status, 409);
  } finally { f.sql.close(); }
});

test("custom runtimes, target params and failed update reports influence selection without trusting foreign IDs", async () => {
  const f = fixture();
  try {
    const base = await (await upload(f.env, { runtimeVersion: "1.0.0", fingerprint: "" })).json();
    const target = await (await upload(f.env, { runtimeVersion: "1.0.0", fingerprint: "", targets: '{"tier":"beta"}', bundleBytes: "beta" })).json();
    const headers = { "expo-runtime-version": "1.0.0", "yaota-client-id": "client-a" };
    assert.equal((await signedContent(await manifest(f.env, headers))).id, base.id);
    assert.equal((await signedContent(await manifest(f.env, { ...headers, "expo-extra-params": 'tier="beta"' }))).id, target.id);
    const failed = { ...headers, "expo-extra-params": 'tier="beta"', "expo-recent-failed-update-ids": `"${target.id}", "${crypto.randomUUID()}"` };
    assert.equal((await signedContent(await manifest(f.env, failed))).id, base.id);
    await manifest(f.env, failed);
    const report = await app.request("/api/ota/state?app_id=cohub-mobile", { headers: { authorization: "Bearer admin-secret" } }, f.env);
    assert.deepEqual((await report.json()).failures.map(r => [r.release_id, r.clients]), [[target.id, 1]]);
    assert.equal((await manifest(f.env, { ...headers, "expo-extra-params": "broken==" })).status, 400);
  } finally { f.sql.close(); }
});

test("content negotiation, signing key selection, private assets, compression and conditional caching", async () => {
  const f = fixture();
  try {
    await upload(f.env);
    for (const accept of ["application/json", "application/expo+json"]) {
      const response = await manifest(f.env, { accept });
      assert.equal(response.headers.get("content-type"), accept);
      const signature = parseDictionary(response.headers.get("expo-signature")).get("sig")[0];
      assert.ok(verify("RSA-SHA256", Buffer.from(await response.text()), keys.publicKey, Buffer.from(signature, "base64")));
    }
    assert.equal((await manifest(f.env, { accept: "multipart/mixed;q=0, text/html" })).status, 406);
    assert.equal((await manifest(f.env, { "expo-expect-signature": 'sig, keyid="missing"' })).status, 406);
    assert.equal((await manifest(f.env, { "expo-expect-signature": 'sig, alg="unknown"' })).status, 406);
    f.env.CODE_SIGNING_KEYS = JSON.stringify({ other: { privateKey: f.env.CODE_SIGNING_PRIVATE_KEY } });
    const keyResponse = await manifest(f.env, { "expo-expect-signature": 'sig, keyid="other"', accept: "application/json" });
    assert.equal(parseDictionary(keyResponse.headers.get("expo-signature")).get("keyid")[0], "other");
    delete f.env.CODE_SIGNING_KEYS;
    const m = await signedContent(await manifest(f.env));
    for (const [encoding, decompress] of [["gzip", gunzipSync], ["br", brotliDecompressSync]]) {
      const asset = await app.request(m.assets[0].url, { headers: { "accept-encoding": encoding } }, f.env);
      assert.equal(asset.headers.get("content-encoding"), encoding);
      assert.match(asset.headers.get("cache-control"), /immutable/);
      assert.equal(decompress(Buffer.from(await asset.arrayBuffer())).toString(), "image-fixture");
      assert.equal((await app.request(m.assets[0].url, { headers: { "accept-encoding": encoding, "if-none-match": asset.headers.get("etag") } }, f.env)).status, 304);
    }
    const assetKey = createHash("md5").update("image-fixture").digest("hex");
    assert.equal((await upload(f.env, { extensions: JSON.stringify({ assetRequestHeaders: { [assetKey]: { "x-asset-access": "test" } } }) })).status, 201);
    assert.equal((await manifest(f.env, { accept: "application/json" })).status, 406);
    const privateManifest = await signedContent(await manifest(f.env));
    assert.equal((await app.request(privateManifest.assets[0].url, {}, f.env)).status, 401);
    const authorizedAsset = await app.request(privateManifest.assets[0].url, { headers: { "x-asset-access": "test" } }, f.env);
    assert.equal(authorizedAsset.status, 200);
    assert.equal(authorizedAsset.headers.get("cache-control"), "private, no-store");
  } finally { f.sql.close(); }
});

test("publisher uploads only missing blobs and automatically verifies historical and embedded patches before activation", async () => {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), "yaota-publisher-"));
  try {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "image"), "image-fixture");
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ fileMetadata: { android: { bundle: "index.hbc", assets: [{ path: "assets/image", ext: "png" }] } } }));
    const fetcher = (input, options) => app.request(String(input), options, f.env);
    const options = { server: "https://localhost", apiKey: "publish-secret", exportDir: dir, platform: "android", runtimeVersion: runtime,
      fingerprint: "b".repeat(40), channel: "production", expoConfig: { version: "1", updates: { requestHeaders: { "expo-app-id": "cohub-mobile" } } } };
    await writeFile(join(dir, "index.hbc"), "abcdef".repeat(3000));
    const embeddedId = crypto.randomUUID();
    await publishExport({ ...options, embeddedId }, fetcher);
    await writeFile(join(dir, "index.hbc"), "abcdef".repeat(2999) + "change");
    const first = await publishExport(options, fetcher);
    assert.equal(first.uploadedBlobs, 1);
    assert.equal(first.reusedBlobs, 1);
    assert.equal(first.patches[0].base, embeddedId);
    assert.equal(first.patches[0].skipped, false);
    assert.equal((await signedContent(await manifest(f.env))).id, first.id);
    await writeFile(join(dir, "index.hbc"), "abcdef".repeat(2998) + "changedagain");
    const second = await publishExport(options, fetcher);
    assert.equal(second.patches.length, 2);
    assert.equal(second.uploadedBlobs, 1);
    assert.equal(second.reusedBlobs, 1);
    const current = await signedContent(await manifest(f.env));
    assert.equal(current.id, second.id);
    const delta = await app.request(current.launchAsset.url, { headers: { "a-im": "bsdiff", "expo-current-update-id": embeddedId, "expo-requested-update-id": second.id } }, f.env);
    assert.equal(delta.status, 226);
    await manage(f.env, "apps", { app_id: "second-app" });
    Object.freeze(f.env);
    const otherOptions = { ...options, appId: "second-app", platform: "ios", expoConfig: { updates: { requestHeaders: { "expo-app-id": "second-app" } } } };
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ fileMetadata: { ios: { bundle: "index.hbc", assets: [{ path: "assets/image", ext: "png" }] } } }));
    // Every request gets fresh bindings, as it may on a different Worker isolate.
    const isolatedFetcher = (input, init) => app.request(String(input), init, Object.freeze({ ...f.env }));
    const otherBase = await publishExport(otherOptions, isolatedFetcher);
    await writeFile(join(dir, "index.hbc"), "abcdef".repeat(2997) + "second-app-change");
    const otherTarget = await publishExport(otherOptions, isolatedFetcher);
    assert.equal(otherTarget.patches[0].base, otherBase.id);
    assert.equal(otherTarget.patches[0].skipped, false);
    assert.equal((await signedContent(await manifest(f.env, { "expo-app-id": "second-app", "expo-platform": "ios" }))).id, otherTarget.id);
    const rejected = await manage(f.env, `releases/${otherTarget.id}/rollback?app_id=cohub-mobile`);
    assert.equal(rejected.status, 404);
    const rolled = await manage(f.env, `releases/${otherTarget.id}/rollback?app_id=second-app`);
    assert.equal(rolled.status, 200, await rolled.clone().text());
    assert.equal((await rolled.json()).release.sourceId, otherBase.id);
    assert.equal((await signedContent(await manifest(f.env))).id, second.id);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM ota_events WHERE app_id='second-app'").get().n, 6);
  } finally { f.sql.close(); await rm(dir, { recursive: true, force: true }); }
});
test("fingerprints, app IDs, runtimes, channels and platforms remain isolated", async () => {
  const f = fixture();
  try {
    assert.equal((await upload(f.env)).status, 201);
    assert.equal((await upload(f.env, { fingerprint: "c".repeat(40) })).status, 409);
    assert.equal((await upload(f.env, { fingerprint: "c".repeat(40), ignoreFingerprintCheck: "true" })).status, 409);
    for (const headers of [{ "expo-app-id": "other" }, { "expo-channel-name": "staging" }, { "expo-platform": "ios" }, { "expo-runtime-version": "c".repeat(40) }]) {
      assert.equal((await signedContent(await manifest(f.env, headers))).type, "noUpdateAvailable");
    }
    assert.equal((await upload(f.env, { platform: "ios", runtimeVersion: "d".repeat(40), fingerprint: "e".repeat(40) })).status, 201);
    assert.equal((await signedContent(await manifest(f.env, { "expo-platform": "ios", "expo-runtime-version": "d".repeat(40) }))).runtimeVersion, "d".repeat(40));
    assert.equal((await manage(f.env, "apps", { app_id: "other" })).status, 201);
    assert.equal((await upload(f.env, { expoConfig: JSON.stringify({ updates: { requestHeaders: { "expo-app-id": "other" } } }) })).status, 201);
  } finally { f.sql.close(); }
});
test("unauthorized, unsigned and failed uploads never publish releases", async () => {
  const f = fixture();
  try {
    assert.equal((await upload({ ...f.env, OTA_API_KEY: "different" })).status, 401);
    assert.equal((await upload({ ...f.env, CODE_SIGNING_PRIVATE_KEY: "" })).status, 503);
    assert.equal((await upload(f.env, { metadata: "{}" })).status, 400);
    f.env.ASSETS_R2.put = async () => { throw new Error("storage unavailable"); };
    assert.equal((await upload(f.env)).status, 500);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM releases").get().n, 0);
  } finally { f.sql.close(); }
});

test("content-addressed assets deduplicate and SDK 57 negotiates verified BSDIFF40 with full fallback", async () => {
  const f = fixture();
  try {
    const oldBytes = Buffer.from("abcdef".repeat(3000));
    const newBytes = Buffer.from("abcdef".repeat(2999) + "change");
    const base = await (await upload(f.env, { bundleBytes: oldBytes })).json();
    const target = await (await upload(f.env, { bundleBytes: newBytes })).json();
    assert.equal(f.objects.size, 3, "two bundles plus one shared image");
    const m = await signedContent(await manifest(f.env));
    const patch = await createVerifiedPatch(oldBytes, newBytes);
    const published = await app.request(`/ota-patches/${base.id}/${target.id}`, {
      method: "PUT", headers: { "x-ota-api-key": "publish-secret", "expo-app-id": "cohub-mobile" }, body: patch,
    }, f.env);
    assert.equal(published.status, 200, await published.clone().text());
    const requestHeaders = { "A-IM": "bsdiff", "Expo-Current-Update-ID": base.id, "Expo-Requested-Update-ID": target.id };
    const delta = await app.request(m.launchAsset.url, { headers: requestHeaders }, f.env);
    assert.equal(delta.status, 226);
    assert.equal(delta.headers.get("im"), "bsdiff");
    assert.equal(delta.headers.get("expo-base-update-id"), base.id);
    assert.deepEqual(Buffer.from(await delta.arrayBuffer()), Buffer.from(patch));
    const other = await (await upload(f.env, { runtimeVersion: "f".repeat(40), bundleBytes: oldBytes })).json();
    const rejected = await app.request(`/ota-patches/${other.id}/${target.id}`, {
      method: "PUT", headers: { "x-ota-api-key": "publish-secret", "expo-app-id": "cohub-mobile" }, body: patch,
    }, f.env);
    assert.equal(rejected.status, 409);
    for (const headers of [{}, { ...requestHeaders, "A-IM": "" }, { ...requestHeaders, "Expo-Current-Update-ID": crypto.randomUUID() }, { ...requestHeaders, "Expo-Requested-Update-ID": base.id }, { ...requestHeaders, "Expo-Current-Update-ID": other.id }]) {
      const full = await app.request(m.launchAsset.url, { headers }, f.env);
      assert.equal(full.status, 200);
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), newBytes);
    }
    const image = await app.request(m.assets[0].url, { headers: requestHeaders }, f.env);
    assert.equal(image.status, 200, "only launch assets receive patches");
  } finally { f.sql.close(); }
});

test("rollback republishes old bytes with a newer identity and promotion isolates native runtimes", async () => {
  const f = fixture();
  try {
    const base = await (await upload(f.env)).json();
    const target = await (await upload(f.env, { bundleBytes: "new-bundle" })).json();
    const otherRuntime = "f".repeat(40);
    const other = await (await upload(f.env, { runtimeVersion: otherRuntime })).json();
    const action = (id, name) => app.request(`/api/releases/${id}/${name}`, {
      method: "POST", headers: { authorization: "Bearer admin-secret", "expo-app-id": "cohub-mobile" },
    }, f.env);
    const rolled = await action(target.id, "rollback");
    assert.equal(rolled.status, 200, await rolled.clone().text());
    const rollback = (await rolled.json()).release;
    assert.notEqual(rollback.id, base.id);
    assert.equal(rollback.sourceId, base.id);
    assert.ok(new Date(rollback.createdAt) > new Date(target.createdAt));
    assert.equal((await signedContent(await manifest(f.env))).id, rollback.id);
    const promoted = await action(target.id, "promote");
    assert.equal(promoted.status, 200, await promoted.clone().text());
    assert.equal((await signedContent(await manifest(f.env))).id, (await promoted.json()).release.id);
    assert.equal((await signedContent(await manifest(f.env, { "expo-runtime-version": otherRuntime }))).id, other.id);
  } finally { f.sql.close(); }
});
