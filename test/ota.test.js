import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
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
      async head(key) { const object = objects.get(key); return object && { size: object.bytes.byteLength }; },
      async put(key, bytes, options) { objects.set(key, { bytes, options }); },
      async delete(key) { objects.delete(key); },
      async get(key) {
        const object = objects.get(key);
        return object && { body: object.bytes, httpEtag: '"test"', writeHttpMetadata(headers) {
          headers.set("content-type", object.options.httpMetadata.contentType);
        } };
      },
    },
  };
  return { sql, objects, env };
}
const runtime = "a".repeat(40);
function upload(env, overrides = {}) {
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
  return app.request("/upload", { method: "POST", headers: { "x-ota-api-key": "publish-secret" }, body }, env);
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
    const listed = await app.request("/api/releases", {}, f.env);
    assert.equal((await listed.json()).releases[0].id, m.id);
  } finally { f.sql.close(); }
});

const manage = (env, path, data = {}, method = "POST") => app.request(`/api/ota/${path}`, {
  method, headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify(data),
}, env);

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
    const report = await app.request("/api/ota/state", { headers: { authorization: "Bearer admin-secret" } }, f.env);
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
      method: "PUT", headers: { "x-ota-api-key": "publish-secret" }, body: patch,
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
      method: "PUT", headers: { "x-ota-api-key": "publish-secret" }, body: patch,
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
      method: "POST", headers: { authorization: "Bearer admin-secret" },
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
