import { Hono } from "hono";
import { admin, publisher, fail, object, strings, text, signingKey } from "./ota-protocol.ts";
import { appId, requestAppId, requireApp } from "./ota-apps.ts";
import { assertChanged, branchOf, changes, event, getRelease, percentage, publish, publicRelease } from "./ota-store.ts";
import type { Env, OtaContext, ReleaseRow, Manifest, Publication, ChannelRow, JsonObject } from "./types.ts";

export const controls = new Hono<{ Bindings: Env }>();
function copyInput(row: ReleaseRow): Publication {
  const manifest: Manifest | null = row.manifest_json ? JSON.parse(row.manifest_json) : null;
  return { appId: row.app_id, channel: row.channel, branch: branchOf(row), platform: row.platform,
    runtime: row.runtime_version, fingerprint: row.fingerprint, config: manifest?.extra.expoClient || {},
    targets: JSON.parse(row.targets_json), extensions: JSON.parse(row.extensions_json), rollout: 100, status: "Live", note: row.note };
}
async function body(c: OtaContext): Promise<JsonObject> {
  const raw = await c.req.text();
  return raw ? object(raw, "request") : {};
}
async function releaseAction(c: OtaContext, id: string, action: string, data: JsonObject) {
  const app = requestAppId(c, data.app_id, data.appId);
  await requireApp(c.env, app);
  const row = await getRelease(c.env, id, app);
  const revision = data.revision ?? row.revision;
  if (!Number.isInteger(revision) || revision !== row.revision) fail(409, "Release changed; refresh before retrying");
  const scope = [row.app_id, branchOf(row), row.platform, row.runtime_version];
  const before = [];
  if (action === "rollout") {
    if (row.status !== "Live" || !row.manifest_json) fail(409, "Only active updates have a rollout");
    const head = await c.env.DB.prepare("SELECT id FROM releases WHERE app_id=? AND branch=? AND platform=? AND runtime_version=? AND status='Live' ORDER BY created_at DESC LIMIT 1").bind(...scope).first<{ id: string }>();
    if (head?.id !== row.id) fail(409, "Only the latest update can change rollout");
    const amount = percentage(data.percentage);
    if (amount < row.rollout) fail(409, "Use rollback to revert users already exposed to this update");
    const result = await c.env.DB.prepare("UPDATE releases SET rollout=?, revision=revision+1 WHERE id=? AND revision=?").bind(amount, id, row.revision).run();
    if (!changes(result)) fail(409, "Release changed; refresh before retrying");
    await event(c.env, app, "rollout", `${id}: ${amount}%`).run();
    return getRelease(c.env, id, app);
  }
  let source = row;
  if (action === "rollback" || action === "embedded") {
    const head = await c.env.DB.prepare("SELECT id FROM releases WHERE app_id=? AND branch=? AND platform=? AND runtime_version=? AND status='Live' ORDER BY created_at DESC LIMIT 1").bind(...scope).first<{ id: string }>();
    if (head?.id !== id) fail(409, "Rollback must target the latest active update");
    before.push(c.env.DB.prepare("UPDATE releases SET status='Archived', rollout=0, revision=revision+1 WHERE id=? AND revision=?").bind(id, row.revision), ...assertChanged(c.env));
    const previous = action === "embedded" ? null : data.targetId
      ? await getRelease(c.env, text(data.targetId, "targetId"), app)
      : await c.env.DB.prepare("SELECT * FROM releases WHERE app_id=? AND branch=? AND platform=? AND runtime_version=? AND status='Live' AND rollout=100 AND id!=? AND targets_json=? ORDER BY created_at DESC LIMIT 1")
        .bind(...scope, id, row.targets_json).first<ReleaseRow>();
    if (!previous || previous.directive_json) {
      return publish(c, copyInput(row), null, [], { before, directive: { type: "rollBackToEmbedded" }, sourceId: id, action: "rollback-embedded" });
    }
    if (previous.app_id !== row.app_id || branchOf(previous) !== branchOf(row) || previous.platform !== row.platform || previous.runtime_version !== row.runtime_version || previous.fingerprint !== row.fingerprint) fail(409, "Rollback target is incompatible");
    source = previous;
  } else if (!["promote", "republish"].includes(action)) fail(400, "Unknown release action");
  if (!source.manifest_json) fail(409, "No update content to publish");
  const manifest: Manifest = JSON.parse(source.manifest_json);
  const input = copyInput(source);
  if (action === "rollback") input.targets = JSON.parse(row.targets_json);
  if (action === "promote" || action === "republish") {
    input.branch = text(data.branch || input.branch, "branch");
    input.channel = text(data.channel || input.channel, "channel");
    input.rollout = percentage(data.percentage ?? (row.status === "Staged" ? row.rollout : 100));
    if (row.status === "Staged") before.push(c.env.DB.prepare("UPDATE releases SET status='Archived', revision=revision+1 WHERE id=? AND revision=?").bind(id, row.revision), ...assertChanged(c.env));
  }
  return publish(c, input, manifest.launchAsset, manifest.assets, { before, sourceId: source.id, action });
}

controls.use("/api/ota/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  admin(c);
  if (!c.env.DB) fail(503, "D1 binding is required");
  return next();
});
controls.get("/api/ota/state", async c => {
  const app = requestAppId(c);
  await requireApp(c.env, app);
  const releases = await c.env.DB.prepare("SELECT * FROM releases WHERE app_id=? AND (manifest_json IS NOT NULL OR directive_json IS NOT NULL) ORDER BY created_at DESC").bind(app).all<ReleaseRow>();
  const channels = await c.env.DB.prepare("SELECT * FROM ota_channels WHERE app_id=? ORDER BY name").bind(app).all<ChannelRow>();
  const failures = await c.env.DB.prepare("SELECT release_id,COUNT(*) AS clients,MAX(last_seen) AS last_seen FROM ota_failures WHERE app_id=? GROUP BY release_id ORDER BY last_seen DESC").bind(app).all();
  const events = await c.env.DB.prepare("SELECT action,subject,created_at FROM ota_events WHERE app_id=? ORDER BY id DESC LIMIT 100").bind(app).all();
  let signingError: string | null = null;
  try { signingKey(c.env, new Map(), app); } catch (error) { signingError = error instanceof Error ? error.message : "Invalid signing configuration"; }
  return c.json({ appId: app, configuration: { publishing: !!c.env.OTA_API_KEY, signing: !signingError, signingError }, releases: releases.results.map(publicRelease), channels: channels.results.map(row => ({ ...row, headers: JSON.parse(row.headers_json) })), failures: failures.results, events: events.results });
});
controls.get("/api/ota/apps", async c => {
  const { results } = await c.env.DB.prepare("SELECT app_id,created_at FROM ota_apps ORDER BY app_id").all();
  return c.json({ apps: results });
});
controls.post("/api/ota/apps", async c => {
  const data = await body(c);
  const id = appId(data.app_id);
  if (await c.env.DB.prepare("SELECT app_id FROM ota_apps WHERE app_id=?").bind(id).first()) fail(409, "Application already exists");
  await c.env.DB.batch([c.env.DB.prepare("INSERT INTO ota_apps(app_id) VALUES(?)").bind(id), event(c.env, id, "create-app", id)]);
  return c.json({ appId: id }, 201);
});
controls.post("/api/ota/releases/:id/:action", async c => c.json({ release: publicRelease(await releaseAction(c, c.req.param("id"), c.req.param("action"), await body(c))) }));

// Existing console URLs must execute native-compatible rollback for signed releases too.
controls.on(["POST", "PATCH"], "/api/releases/:id/:action", async (c, next) => {
  if (!c.env?.DB) return next();
  const row = await c.env.DB.prepare("SELECT manifest_json,directive_json FROM releases WHERE id=?").bind(c.req.param("id")).first<Pick<ReleaseRow, "manifest_json" | "directive_json">>();
  if (!row?.manifest_json && !row?.directive_json) return next();
  admin(c);
  return c.json({ release: publicRelease(await releaseAction(c, c.req.param("id"), c.req.param("action"), await body(c))) });
});
controls.post("/ota-publish/releases/:id/activate", async c => {
  publisher(c);
  if (!c.env.DB) fail(503, "D1 binding is required");
  const app = requestAppId(c);
  const row = await getRelease(c.env, c.req.param("id"), app);
  signingKey(c.env, new Map(), app);
  if (row.status !== "Staged") fail(409, "Only staged updates can activate");
  // Activation retains the UUID used when generating patches, but assigns a fresh creation time.
  const statements = [c.env.DB.prepare("UPDATE releases SET status='Live',revision=revision+1,created_at=strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday('now'),(SELECT max(julianday(created_at))+0.00000002315 FROM releases))) WHERE id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM releases WHERE app_id=? AND branch=? AND platform=? AND runtime_version=? AND status='Live' AND rollout<100)")
    .bind(row.id, row.revision, row.app_id, branchOf(row), row.platform, row.runtime_version), ...assertChanged(c.env),
    c.env.DB.prepare("UPDATE releases SET manifest_json=json_set(manifest_json,'$.createdAt',created_at) WHERE id=?").bind(row.id), event(c.env, app, "activate", row.id)];
  await c.env.DB.batch(statements);
  return c.json(publicRelease(await getRelease(c.env, row.id, app)));
});

controls.put("/api/ota/channels/:name", async c => {
  const name = text(c.req.param("name"), "channel");
  const data = await body(c);
  const app = requestAppId(c, data.app_id, data.appId);
  await requireApp(c.env, app);
  const current = await c.env.DB.prepare("SELECT * FROM ota_channels WHERE app_id=? AND name=?").bind(app, name).first<ChannelRow>();
  if ((data.revision ?? -1) !== (current?.revision ?? -1)) fail(409, "Channel changed; refresh before retrying");
  const action = data.action || "map";
  let branch = text(data.branch || current?.branch || name, "branch");
  let candidate: string | null = current?.rollout_branch || null;
  let amount = current?.percentage || 0;
  if (action === "start") {
    if (candidate) fail(409, "A branch rollout is already active");
    candidate = text(data.rolloutBranch, "rolloutBranch");
    if (candidate === branch) fail(400, "Choose a different candidate branch");
    amount = percentage(data.percentage);
    if (amount === 100) fail(400, "Use a channel mapping for immediate full delivery");
  } else if (action === "progress") {
    if (!candidate) fail(409, "No branch rollout is active");
    amount = percentage(data.percentage);
    if (amount < (current?.percentage || 0)) fail(409, "Cancel the rollout to revert");
  } else if (action === "complete" || action === "cancel") {
    if (!candidate) fail(409, "No branch rollout is active");
    branch = action === "complete" ? candidate : current!.branch;
    candidate = null;
    amount = 0;
  } else if (action === "map") {
    if (candidate) fail(409, "Complete or cancel the branch rollout first");
  } else fail(400, "Unknown channel action");
  const headers = strings(data.headers || JSON.parse(current?.headers_json || "{}"), "server headers");
  if (Object.keys(headers).some(key => !key.startsWith("x-") || key === "x-ota-api-key")) fail(400, "Server headers must use non-secret x- names");
  const statement = current
    ? c.env.DB.prepare("UPDATE ota_channels SET branch=?,rollout_branch=?,percentage=?,headers_json=?,revision=revision+1 WHERE app_id=? AND name=? AND revision=?")
      .bind(branch, candidate, amount, JSON.stringify(headers), app, name, current.revision)
    : c.env.DB.prepare("INSERT INTO ota_channels(app_id,name,branch,rollout_branch,percentage,seed,headers_json) VALUES(?,?,?,?,?,?,?)")
      .bind(app, name, branch, candidate, amount, crypto.randomUUID(), JSON.stringify(headers));
  await c.env.DB.batch([statement, ...assertChanged(c.env), event(c.env, app, `channel-${action}`, name)]);
  return c.json(await c.env.DB.prepare("SELECT * FROM ota_channels WHERE app_id=? AND name=?").bind(app, name).first());
});
