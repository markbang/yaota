import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, verify } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createVerifiedPatch } from "./delta.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: "dist/yaota/index.js",
  compatibilityDate: "2025-08-03",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  r2Buckets: ["ASSETS_R2"],
  bindings: {
    OTA_APP_ID: "cohub-mobile", OTA_API_KEY: "local-test-only",
    CODE_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  },
}));
try {
  const db = await worker.getD1Database("DB");
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  await db.exec(schema.replace(/\n/g, " "));
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
    method: "PUT", headers: { "x-ota-api-key": "local-test-only" }, body: patch,
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
  console.log("workerd + D1 + R2: signed uploads, deduplication, delta and full fallback passed.");
} finally {
  await worker.dispose();
}
