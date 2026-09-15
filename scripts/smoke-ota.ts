import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createVerifiedPatch } from "./delta.ts";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { testCertificate } from "../test/helpers/signing.ts";
import { validateSigningMaterial } from "../src/ota-credentials.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const worker = new Miniflare(convertV4MiniflareOptions({
  name: "yaota-smoke",
  host: "127.0.0.1", port: 0,
  assets: { directory: "dist/client", binding: "ASSETS", run_worker_first: true, routerConfig: { has_user_worker: true } },
  modules: true,
  scriptPath: "dist/yaota/index.js",
  compatibilityDate: "2025-08-03",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  r2Buckets: ["ASSETS_R2"],
  bindings: {
    YAOTA_ADMIN_TOKEN: "local-admin-only", OTA_API_KEY: "local-test-only",
    CODE_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  },
}));
try {
  const db = await worker.getD1Database("DB");
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  await db.exec(schema.replace(/\n/g, " "));
  await db.prepare("INSERT INTO ota_apps(app_id) VALUES (?)").bind("cohub-mobile").run();
  const runtime = "a".repeat(40);
  async function publish(bytes: Uint8Array<ArrayBuffer>): Promise<{ id: string }> {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      channel: "production", platform: "android", runtimeVersion: runtime,
      fingerprint: "b".repeat(40),
      expoConfig: JSON.stringify({ updates: { requestHeaders: { "expo-app-id": "cohub-mobile" } } }),
      metadata: JSON.stringify({ fileMetadata: { android: { assets: [{ path: "assets/shared", ext: "png" }] } } }),
    })) form.set(key, value);
    form.set("bundle", new File([bytes], "index.hbc"));
    form.set("asset-0", new File(["shared-image"], "shared"));
    const request = new Request("https://ota.local/upload", {
      method: "POST", headers: { "x-ota-api-key": "local-test-only" }, body: form,
    });
    const result = await worker.dispatchFetch(request.url, {
      method: request.method, headers: Object.fromEntries(request.headers), body: await request.arrayBuffer(),
    });
    assert.equal(result.status, 201, await result.clone().text());
    return result.json() as Promise<{ id: string }>;
  }
  const oldBytes = Buffer.from("abcdef".repeat(3000));
  const newBytes = Buffer.from("abcdef".repeat(2999) + "change");
  const base = await publish(oldBytes);
  const target = await publish(newBytes);
  const bucket = await worker.getR2Bucket("ASSETS_R2");
  assert.equal((await bucket.list()).objects.length, 3);
  const response = await worker.dispatchFetch("https://ota.local/manifest", { headers: {
    "expo-app-id": "cohub-mobile", "expo-channel-name": "production",
    "expo-platform": "android", "expo-runtime-version": runtime, "expo-protocol-version": "1",
  } });
  assert.equal(response.status, 200);
  const multipart = await response.text();
  const json = multipart.split("\r\n\r\n")[1].split("\r\n--")[0];
  const signature = /expo-signature: sig="([^"]+)"/.exec(multipart)![1];
  assert.ok(verify("RSA-SHA256", Buffer.from(json), keys.publicKey, Buffer.from(signature, "base64")));
  const manifest = JSON.parse(json);
  assert.equal(manifest.id, target.id);
  const patch = await createVerifiedPatch(oldBytes, newBytes);
  const stored = await worker.dispatchFetch(`https://ota.local/ota-patches/${base.id}/${target.id}`, {
    method: "PUT", headers: { "x-ota-api-key": "local-test-only", "expo-app-id": "cohub-mobile" }, body: patch,
  });
  assert.equal(stored.status, 200, await stored.clone().text());
  const delta = await worker.dispatchFetch(manifest.launchAsset.url, { headers: {
    "A-IM": "bsdiff", "Expo-Current-Update-ID": base.id, "Expo-Requested-Update-ID": target.id,
  } });
  assert.equal(delta.status, 226);
  assert.equal(delta.headers.get("expo-base-update-id"), base.id);
  assert.deepEqual(Buffer.from(await delta.arrayBuffer()), Buffer.from(patch));
  const full = await worker.dispatchFetch(manifest.launchAsset.url);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), newBytes);
  for (const [encoding, decompress] of [["gzip", gunzipSync], ["br", brotliDecompressSync]] as const) {
    const service = await worker.getWorker("yaota-smoke");
    const compressed = await service.fetch(manifest.launchAsset.url, { headers: { "accept-encoding": encoding } });
    assert.equal(compressed.status, 200, await compressed.clone().text());
    // Miniflare may transparently decompress HTTP responses at its fetch boundary.
    const received = Buffer.from(await compressed.arrayBuffer());
    assert.deepEqual(compressed.headers.get("content-encoding") ? decompress(received) : received, newBytes);
    const storedEncoding = await bucket.get(`ota/encoded/${manifest.launchAsset.hash}/${encoding}`);
    assert.ok(storedEncoding, `${encoding} variant was generated by workerd`);
    assert.deepEqual(decompress(Buffer.from(await storedEncoding.arrayBuffer())), newBytes);
  }
  const manage = (path: string, body: object, method = "POST") => worker.dispatchFetch(`https://ota.local/api/ota/${path}`, {
    method, headers: { authorization: "Bearer local-admin-only", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const certForSmoke = testCertificate(privateKey);
  validateSigningMaterial(certForSmoke, privateKey);
  const imported = await manage("credentials/signing/keys/managed-main?app_id=cohub-mobile", { certificate: certForSmoke, privateKey, revision: 0, makeDefault: true }, "PUT");
  assert.equal(imported.status, 201, await imported.clone().text());
  const signed = await worker.dispatchFetch("https://ota.local/manifest", { headers: {
    "expo-app-id": "cohub-mobile", "expo-channel-name": "production", "expo-platform": "android", "expo-runtime-version": runtime, "expo-protocol-version": "1",
  } });
  assert.equal(signed.status, 200, await signed.clone().text());
  const signedBody = await signed.text();
  assert.ok(verify("RSA-SHA256", Buffer.from(signedBody.split("\r\n\r\n")[1].split("\r\n--")[0]), keys.publicKey, Buffer.from(/expo-signature: sig="([^"]+)"/.exec(signedBody)![1], "base64")));
  const tokenResponse = await manage("credentials/publishing/tokens?app_id=cohub-mobile", { name: "Smoke CI", revision: 0 });
  assert.equal(tokenResponse.status, 201, await tokenResponse.clone().text());
  const token = await tokenResponse.json() as { id: string; token: string };
  assert.equal((await manage("credentials/publishing/legacy?app_id=cohub-mobile", { enabled: false, confirm: true, revision: 1 }, "PUT")).status, 200);
  assert.equal((await worker.dispatchFetch("https://ota.local/ota-publish/releases?app_id=cohub-mobile", { headers: { "x-ota-api-key": token.token } })).status, 200);
  assert.equal((await worker.dispatchFetch("https://ota.local/ota-publish/releases?app_id=cohub-mobile", { headers: { "x-ota-api-key": "local-test-only" } })).status, 401);
  assert.equal((await manage(`credentials/publishing/tokens/${token.id}/revoke?app_id=cohub-mobile`, { confirm: true, revision: 2 })).status, 200);
  assert.equal((await worker.dispatchFetch("https://ota.local/ota-publish/releases?app_id=cohub-mobile", { headers: { "x-ota-api-key": token.token } })).status, 401);
  assert.equal((await manage("credentials/publishing/legacy?app_id=cohub-mobile", { enabled: true, confirm: true, revision: 3 }, "PUT")).status, 200);
  assert.equal((await manage("apps", { app_id: "second-app" })).status, 201);
  assert.equal((await manage("channels/production?app_id=second-app", { branch: "second-stable", revision: -1 }, "PUT")).status, 200);
  for (const appId of ["cohub-mobile", "second-app", "cohub-mobile", "second-app"]) {
    const state = await worker.dispatchFetch(`https://ota.local/api/ota/state?app_id=${appId}`, { headers: { authorization: "Bearer local-admin-only" } });
    const data = await state.json() as { appId: string; releases: { appId: string }[] };
    assert.equal(data.appId, appId);
    assert.ok(data.releases.every(release => release.appId === appId));
  }
  assert.equal((await manage(`releases/${target.id}/rollback?app_id=second-app`, {})).status, 404);
  assert.equal((await manage(`releases/${target.id}/rollback?app_id=cohub-mobile`, {})).status, 200);
  assert.equal((await worker.dispatchFetch("https://ota.local/")).status, 404);
  assert.equal((await worker.dispatchFetch("https://ota.local/index.html")).status, 404);
  const adminPage = await worker.dispatchFetch("https://ota.local/admin");
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /lang="en"/);
  assert.equal((await worker.dispatchFetch("https://ota.local/api/ota/apps")).status, 401);
  console.log("workerd + D1 + R2: encrypted signing, managed tokens, signatures, patches, compression, multi-app isolation, rollback and admin routing passed.");
  if (process.argv.includes("--serve")) {
    console.log(`Disposable dashboard: ${await worker.ready}admin (token: local-admin-only)`);
    await new Promise<void>(resolve => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} finally {
  await worker.dispose();
}
