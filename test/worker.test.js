import test from "node:test";
import assert from "node:assert/strict";
import app from "../worker.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

test("authenticated release creation persists through the SQL storage path", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  database.exec("INSERT INTO ota_apps(app_id) VALUES('test-app')");
  const env = {
    YAOTA_ADMIN_TOKEN: "test-admin",
    DB: {
      prepare(sql) {
        const statement = database.prepare(sql);
        const bound = (args) => ({
          bind: (...values) => bound(values),
          run: async () => statement.run(...args),
          first: async () => statement.get(...args),
          all: async () => ({ results: statement.all(...args) }),
        });
        return bound([]);
      },
    },
  };
  try {
    const response = await app.request("/api/releases", {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ app_id: "test-app", version: "1.0.0", runtimeVersion: "native-1", channel: "preview" }),
    }, env);
    assert.equal(response.status, 201, await response.clone().text());
    const { release } = await response.json();
    assert.equal(database.prepare("SELECT version FROM releases WHERE id = ?").get(release.id).version, "1.0.0");
    const listed = await app.request("/api/releases?app_id=test-app", { headers: { authorization: "Bearer test-admin" } }, env);
    assert.equal((await listed.json()).releases[0].runtimeVersion, "native-1");
  } finally {
    database.close();
  }
});

test("health endpoint reports a live service", async () => {
  const response = await app.request("/api/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, "yaota");
});

test("release lifecycle can be staged, promoted, and returned as an Expo manifest", async () => {
  const created = await app.request("/api/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: "9.9.9-test",
      channel: "preview",
      runtimeVersion: "54.0.0",
      note: "Protocol test",
    }),
  });
  assert.equal(created.status, 201);
  const release = (await created.json()).release;
  assert.equal(release.status, "Staged");

  const promoted = await app.request(`/api/releases/${release.id}/promote`, {
    method: "POST",
  });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).release.status, "Live");

  const manifest = await app.request("/api/updates", {
    headers: {
      "expo-channel-name": "preview",
      "expo-platform": "android",
      "expo-runtime-version": "54.0.0",
      accept: "application/expo+json",
    },
  });
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /application\/expo\+json/);
  assert.equal(manifest.headers.get("expo-protocol-version"), "1");
  assert.equal((await manifest.json()).metadata.version, "9.9.9-test");
});

test("admin writes require a token when storage bindings are configured", async () => {
  const response = await app.request(
    "/api/releases",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "blocked" }),
    },
    { DB: {}, YAOTA_ADMIN_TOKEN: "secret" },
  );
  assert.equal(response.status, 401);
});

test("APK presign stores per-ABI objects and lists a public download URL", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = {
    OTA_API_KEY: "publisher-key",
    YAOTA_ADMIN_TOKEN: "admin",
    DB: {
      prepare(sql) {
        const statement = database.prepare(sql);
        const bound = (args) => ({
          bind: (...values) => bound(values),
          run: async () => statement.run(...args),
          first: async () => statement.get(...args),
          all: async () => ({ results: statement.all(...args) }),
        });
        return bound([]);
      },
    },
  };
  try {
    const denied = await app.request("/api/apks/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "2.2.11", arch: "arm64-v8a", size: 12, sha256: "a".repeat(64) }),
    }, env);
    assert.equal(denied.status, 401);
    const created = await app.request("/api/apks/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ota-api-key": "publisher-key" },
      body: JSON.stringify({ version: "2.2.11", arch: "arm64-v8a", size: 12, sha256: "A".repeat(64) }),
    }, env);
    assert.equal(created.status, 200, await created.clone().text());
    const body = await created.json();
    assert.equal(body.key, "apk/cohub-v2.2.11-android-arm64-v8a.apk");
    assert.equal(body.publicUrl, "http://localhost/apk/cohub-v2.2.11-android-arm64-v8a.apk");
    const listed = await app.request("/api/apks", {}, env);
    assert.equal(listed.status, 200);
    const { apks } = await listed.json();
    assert.equal(apks[0].version, "2.2.11");
    assert.equal(apks[0].arch, "arm64-v8a");
    assert.equal(apks[0].size, 12);
    assert.equal(apks[0].sha256, "a".repeat(64));
    assert.equal(apks[0].url, body.publicUrl);
  } finally {
    database.close();
  }
});

test("runtime mismatches never receive an incompatible OTA", async () => {
  const response = await app.request("/api/updates", {
    headers: {
      "expo-channel-name": "production",
      "expo-platform": "android",
      "expo-runtime-version": "not-installed",
      accept: "application/expo+json",
    },
  });
  assert.equal(response.status, 204);
});
