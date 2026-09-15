import assert from "node:assert/strict";
import test from "node:test";
import { exportUpload } from "../src/dashboard/export-upload.ts";
import { api, ApiError, appPath } from "../src/dashboard/api.ts";

function exportForm(appId = "first-app") {
  const data = new FormData();
  const files = [
    ["metadata.json", JSON.stringify({ fileMetadata: { android: { bundle: "bundles/android.hbc", assets: [{ path: "assets/image.png" }] } } })],
    ["bundles/android.hbc", "bundle bytes"],
    ["assets/image.png", "asset bytes"],
  ];
  for (const [path, contents] of files) {
    const file = new File([contents], path.split("/").at(-1));
    Object.defineProperty(file, "webkitRelativePath", { value: `dist/${path}` });
    data.append("directory", file);
  }
  data.set("config", new File([JSON.stringify({ updates: { requestHeaders: { "expo-app-id": appId } } })], "app.json"));
  for (const [key, value] of Object.entries({ channel: "production", platform: "android", runtimeVersion: "1.0", rollout: "25", targets: "{}", staged: "true" })) data.set(key, value);
  return data;
}

test("dashboard export preserves files, rollout and explicitly selected app", async () => {
  const upload = await exportUpload(exportForm(), "first-app");
  assert.equal(upload.get("app_id"), "first-app");
  assert.equal(upload.get("channel"), "production");
  assert.equal(upload.get("rollout"), "25");
  assert.equal(upload.get("staged"), "true");
  assert.equal(await upload.get("bundle").text(), "bundle bytes");
  assert.equal(await upload.get("asset-0").text(), "asset bytes");
  assert.equal(upload.has("directory"), false);
  const direct = exportForm();
  direct.delete("staged");
  assert.equal((await exportUpload(direct, "first-app")).get("staged"), "false");
});

test("dashboard rejects cross-app exports and incomplete directories before upload", async () => {
  await assert.rejects(exportUpload(exportForm(), "second-app"), /does not match/);
  const missingDirectory = exportForm();
  missingDirectory.delete("directory");
  await assert.rejects(exportUpload(missingDirectory, "first-app"), /metadata.json/);
  const missingConfig = exportForm();
  missingConfig.delete("config");
  await assert.rejects(exportUpload(missingConfig, "first-app"), /public config/);
  const wrongPlatform = exportForm();
  wrongPlatform.set("platform", "ios");
  await assert.rejects(exportUpload(wrongPlatform, "first-app"), /platform is missing/);
  const missingAsset = exportForm();
  const files = missingAsset.getAll("directory");
  missingAsset.delete("directory");
  files.filter(file => file.name !== "image.png").forEach(file => missingAsset.append("directory", file));
  await assert.rejects(exportUpload(missingAsset, "first-app"), /Missing asset/);
});

test("dashboard API preserves auth, scoped URLs and multipart boundaries", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push({ path, options });
    return Response.json({ ok: true });
  });
  const path = appPath("/api/ota/state", "app.example-1");
  assert.equal(path, "/api/ota/state?app_id=app.example-1");
  await api(path, { method: "POST", body: JSON.stringify({ revision: 3 }) }, "test-token");
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer test-token");
  assert.equal(calls[0].options.headers.get("content-type"), "application/json");
  const data = exportForm();
  await api("/api/ota/upload", { method: "POST", body: data }, "test-token");
  assert.equal(calls[1].options.body, data);
  assert.equal(calls[1].options.headers.has("content-type"), false);
});

test("dashboard API exposes authorization and revision conflict failures", async t => {
  for (const [status, error] of [[401, "Unauthorized"], [409, "Release changed; refresh before retrying"]]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ error }, { status }));
    await assert.rejects(api("/api/ota/apps", {}, "invalid-token"), cause => cause instanceof ApiError && cause.status === status && cause.message === error);
  }
});
