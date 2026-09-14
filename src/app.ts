import "./styles.css";
import { createIcons, RefreshCw, KeyRound, Plus, X, Settings2, Layers, GitBranch, Activity, RotateCcw, Upload, Download } from "lucide";
import type { publicRelease } from "./ota-store.ts";
import type { ChannelRow, StringMap } from "./types.ts";

type Release = ReturnType<typeof publicRelease>;
interface State {
  appId: string; releases: Release[]; channels: (ChannelRow & { headers: StringMap })[];
  configuration?: { publishing: boolean; signing: boolean; signingError: string | null };
  failures: { release_id: string; clients: number; last_seen: string }[];
  events: { action: string; subject: string; created_at: string }[];
}
interface AppEntry { app_id: string; created_at: string }
const blankState = (appId = ""): State => ({ appId, releases: [], channels: [], failures: [], events: [] });
let state: State = blankState();
let apps: AppEntry[] = [];
let error = "";
let filter = "all";
let selectedApp = localStorage.getItem("yaota_app_id") || "";
let authenticated = false;
let loading = false;
let refreshId = 0;
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const icon = (name: string) => `<i data-lucide="${name}"></i>`;
const icons = () => createIcons({ icons: { RefreshCw, KeyRound, Plus, X, Settings2, Layers, GitBranch, Activity, RotateCcw, Upload, Download } });
function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = sessionStorage.getItem("yaota_admin_token");
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(result.error || `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}
const date = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function toast(message: string) {
  const node = element("#toast"); node.textContent = message; node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 4500);
}
async function refresh() {
  const id = ++refreshId;
  loading = true; error = ""; state = blankState(); render();
  try {
    const result = await api<{ apps: AppEntry[] }>("/api/ota/apps");
    if (id !== refreshId) return;
    apps = result.apps; authenticated = true;
    if (!apps.some(a => a.app_id === selectedApp)) selectedApp = apps[0]?.app_id || "";
    localStorage.setItem("yaota_app_id", selectedApp);
    const next = selectedApp ? await api<State>(`/api/ota/state?app_id=${encodeURIComponent(selectedApp)}`) : blankState();
    if (id !== refreshId) return;
    state = next;
  } catch (cause) {
    if (id !== refreshId) return;
    error = cause instanceof Error ? cause.message : "Connection failed";
    if (cause instanceof ApiError && cause.status === 401) {
      authenticated = false; apps = []; sessionStorage.removeItem("yaota_admin_token");
    }
  }
  loading = false; render();
  if (!authenticated && error === "Unauthorized") credentials();
}
const empty = (columns: number, message: string) => `<tr><td colspan="${columns}" class="empty">${escape(message)}</td></tr>`;
function render() {
  const ready = authenticated && !loading && state.appId === selectedApp && !!selectedApp && !error;
  const releases = state.releases.filter(r => filter === "all" || r.status === filter);
  element("#app").innerHTML = `<div class="shell"><aside class="sidebar">
    <div class="brand"><span class="brand-mark">Y</span>yaota</div><div class="workspace"><span class="eyebrow">APPLICATION</span><strong>${escape(state.appId || "No application")}</strong></div>
    <nav class="nav"><a class="nav-item active" href="#releases">${icon("layers")}Releases</a><a class="nav-item" href="#channels">${icon("git-branch")}Channels</a><a class="nav-item" href="#failures">${icon("activity")}Failures</a><a class="nav-item" href="#activity">${icon("activity")}Activity</a></nav>
    </aside><main class="main"><header class="topbar"><strong>yaota / OTA</strong><div class="top-actions"><button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">${icon("refresh-cw")}</button><button class="icon-btn" id="token" title="Admin credentials" aria-label="Admin credentials">${icon("key-round")}</button></div></header>
    <div class="content"><section class="page-heading"><div><span class="kicker">APPLICATIONS</span><h1>Release management</h1><div class="app-switcher"><label for="app-id">Application</label><select id="app-id" ${!authenticated || !apps.length ? "disabled" : ""}>${apps.map(a => `<option value="${escape(a.app_id)}" ${a.app_id === selectedApp ? "selected" : ""}>${escape(a.app_id)}</option>`).join("") || '<option>No applications</option>'}</select><button class="secondary" id="new-app" type="button" ${!authenticated || loading ? "disabled" : ""}>${icon("plus")}New app</button></div></div><button class="primary" id="publish" ${!ready || !state.configuration?.publishing || !state.configuration?.signing ? "disabled" : ""}>${icon("upload")}Publish update</button></section>
    ${error ? `<div class="error" role="alert">${escape(error)}</div>` : ""}
    ${loading ? '<p class="muted" role="status">Loading application...</p>' : !selectedApp && authenticated ? '<p class="muted">No applications yet</p>' : ""}
    ${ready && state.configuration ? `<div class="configuration" aria-label="Application configuration"><span>Publishing key <strong class="${state.configuration.publishing ? "configured" : "missing"}">${state.configuration.publishing ? "Configured" : "Missing"}</strong></span><span>Signing key <strong class="${state.configuration.signing ? "configured" : "missing"}">${state.configuration.signing ? "Configured" : "Missing or invalid"}</strong></span>${state.configuration.signingError ? `<span role="status">${escape(state.configuration.signingError)}</span>` : ""}</div>` : ""}
    <section class="metrics">${[["Active updates", state.releases.filter(r => r.status === "Live" && r.manifest).length], ["Staged", state.releases.filter(r => r.status === "Staged").length], ["Active rollouts", state.releases.filter(r => r.status === "Live" && r.rollout < 100).length + state.channels.filter(c => c.rollout_branch).length], ["Reported client/update failures", state.failures.reduce((n, f) => n + f.clients, 0)]].map(([label, value]) => `<div class="metric"><span class="metric-label">${label}</span><strong>${value}</strong></div>`).join("")}</section>
    <section class="section" id="releases"><div class="section-head"><h2>Updates</h2><select id="status-filter" aria-label="Release status">${["all", "Live", "Staged", "Archived", "Embedded"].map(s => `<option ${s === filter ? "selected" : ""}>${s}</option>`).join("")}</select></div><div class="table-wrap"><table><thead><tr><th>VERSION / UPDATE</th><th>BRANCH / PLATFORM</th><th>RUNTIME</th><th>ROLLOUT</th><th>STATUS</th><th>CREATED</th><th></th></tr></thead><tbody>${releases.map(r => `<tr><td><strong>${escape(r.directive ? "Embedded rollback" : r.version || "Update")}</strong><small>${escape(r.id.slice(0, 8))} / ${escape(r.note)}</small></td><td>${escape(r.branch)}<small>${escape(r.platform)}</small></td><td><code class="runtime" title="${escape(r.runtimeVersion)}">${escape(r.runtimeVersion)}</code></td><td><div class="coverage"><progress value="${r.rollout}" max="100"></progress>${r.rollout}%</div></td><td><span class="status ${escape(r.status.toLowerCase())}">${escape(r.status)}</span></td><td>${date(r.createdAt)}</td><td><button class="icon-btn" data-release="${escape(r.id)}" title="Manage update" aria-label="Manage ${escape(r.id.slice(0, 8))}">${icon("settings-2")}</button></td></tr>`).join("") || empty(7, "No updates")}</tbody></table></div></section>
    <section class="section" id="channels"><div class="section-head"><h2>Channels</h2><button class="secondary" id="new-channel">${icon("plus")}Add channel</button></div><div class="table-wrap"><table><thead><tr><th>CHANNEL</th><th>BRANCH</th><th>CANDIDATE</th><th>ROLLOUT</th><th></th></tr></thead><tbody>${state.channels.map(c => `<tr><td>${escape(c.name)}</td><td>${escape(c.branch)}</td><td>${escape(c.rollout_branch || "None")}</td><td>${c.percentage}%</td><td><button class="icon-btn" data-channel="${escape(c.name)}" title="Manage channel" aria-label="Manage ${escape(c.name)}">${icon("settings-2")}</button></td></tr>`).join("") || empty(5, "No explicit mappings")}</tbody></table></div></section>
    <section class="section" id="failures"><div class="section-head"><h2>Reported launch failures</h2></div><div class="table-wrap"><table><thead><tr><th>UPDATE</th><th>REPORTING CLIENTS</th><th>LAST SEEN</th></tr></thead><tbody>${state.failures.map(f => `<tr><td><code>${escape(f.release_id)}</code></td><td>${f.clients}</td><td>${date(f.last_seen)}</td></tr>`).join("") || empty(3, "No launch failures reported")}</tbody></table></div></section>
    <section class="section activity" id="activity"><h2>Activity</h2>${state.events.map(e => `<div class="activity-row"><time>${date(e.created_at)}</time><strong>${escape(e.action)}</strong><code>${escape(e.subject)}</code></div>`).join("") || `<p class="muted">No recorded activity</p>`}</section>
    </div></main></div><dialog id="dialog"></dialog><div class="toast" id="toast" role="status"></div>`;
  icons();
  element("#refresh").onclick = refresh;
  element("#token").onclick = credentials;
  element<HTMLSelectElement>("#status-filter").onchange = e => { filter = (e.target as HTMLSelectElement).value; render(); };
  element("#publish").onclick = publishDialog;
  element<HTMLSelectElement>("#app-id").onchange = e => { selectedApp = (e.target as HTMLSelectElement).value; localStorage.setItem("yaota_app_id", selectedApp); void refresh(); };
  element("#new-app").onclick = () => dialog("Create application", '<label>App ID<input name="app_id" required maxlength="128" pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]*" spellcheck="false" autocomplete="off"></label>', async form => { const appId = String(new FormData(form).get("app_id") || "").trim(); await api("/api/ota/apps", { method: "POST", body: JSON.stringify({ app_id: appId }) }); selectedApp = appId; localStorage.setItem("yaota_app_id", appId); }, "Create app", "Application created");
  element("#new-channel").onclick = () => channelDialog();
  element<HTMLButtonElement>("#new-channel").disabled = !ready;
  document.querySelectorAll<HTMLButtonElement>("[data-release]").forEach(button => button.onclick = () => releaseDialog(state.releases.find(r => r.id === button.dataset.release)!));
  document.querySelectorAll<HTMLButtonElement>("[data-channel]").forEach(button => button.onclick = () => channelDialog(state.channels.find(c => c.name === button.dataset.channel)));
}
function dialog(title: string, content: string, submit: (form: HTMLFormElement) => Promise<void>, command = "Save", success = "Saved") {
  const node = element<HTMLDialogElement>("#dialog");
  node.innerHTML = `<form><div class="dialog-head"><h2>${escape(title)}</h2><button type="button" class="icon-btn" id="close-dialog" title="Close" aria-label="Close">${icon("x")}</button></div>${content}<p class="form-error" role="alert"></p><div class="dialog-actions"><button class="primary" type="submit">${escape(command)}</button></div></form>`;
  icons(); node.showModal();
  element("#close-dialog").onclick = () => node.close();
  node.querySelector("form")!.onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try { await submit(form); node.close(); await refresh(); if (!error) toast(success); }
    catch (cause) { form.querySelector(".form-error")!.textContent = cause instanceof Error ? cause.message : "Request failed"; }
    finally { button.disabled = false; }
  };
}
const field = (name: string, label: string, value = "", type = "text") => `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${type === "number" ? 'min="0" max="100" step="1"' : ""}></label>`;
function credentials() {
  dialog("Admin sign in", '<label>Admin token<input name="token" type="password" autocomplete="off" required autofocus></label>', async form => {
    const token = String(new FormData(form).get("token") || "").trim();
    await api("/api/ota/apps", { headers: { authorization: `Bearer ${token}` } });
    sessionStorage.setItem("yaota_admin_token", token);
  }, "Sign in", "Signed in");
}
function releaseDialog(release: Release) {
  const appId = release.appId;
  const actions = release.status === "Live" ? ["rollout", "rollback", "embedded", "republish"] : release.status === "Staged" ? ["promote"] : ["republish"];
  dialog("Manage update", `<div class="dialog-detail"><code>${escape(release.id)}</code><small>${escape(release.branch)} / ${escape(release.platform)}</small></div>
    <label>Action<select name="action">${actions.map(a => `<option value="${a}">${({ rollout: "Increase rollout", rollback: "Roll back to previous update", embedded: "Roll back to embedded update", republish: "Republish / promote to branch", promote: "Publish staged update" })[a]}</option>`).join("")}</select></label>
    ${field("percentage", "Rollout percentage", String(release.rollout), "number")}${field("branch", "Destination branch", release.branch)}${field("channel", "Destination channel", release.channel)}
    <label class="check"><input type="checkbox" name="confirmed" required>Confirm this distribution change</label>`, async form => {
    const data = Object.fromEntries(new FormData(form));
    await api(`/api/ota/releases/${release.id}/${data.action}?app_id=${encodeURIComponent(appId)}`, { method: "POST", body: JSON.stringify({ ...data, app_id: appId, percentage: Number(data.percentage), revision: release.revision }) });
  });
}
function channelDialog(channel?: State["channels"][number]) {
  const appId = selectedApp;
  const actions = channel?.rollout_branch ? ["progress", "complete", "cancel"] : ["map", "start"];
  dialog("Channel distribution", `${field("name", "Channel", channel?.name || "")}
    <label>Action<select name="action">${actions.map(a => `<option value="${a}">${({ map: "Map branch", start: "Start branch rollout", progress: "Increase rollout", complete: "Complete rollout", cancel: "Cancel rollout" })[a]}</option>`).join("")}</select></label>
    ${field("branch", "Branch", channel?.branch || "")}${field("rolloutBranch", "Candidate branch", channel?.rollout_branch || "")}${field("percentage", "Candidate percentage", String(channel?.percentage || 0), "number")}
    <label>Server headers (JSON)<textarea name="headers">${escape(JSON.stringify(channel?.headers || {}, null, 2))}</textarea></label>`, async form => {
    const data = Object.fromEntries(new FormData(form));
    if (channel && data.name !== channel.name) throw new Error("Create a new channel to change its name");
    await api(`/api/ota/channels/${encodeURIComponent(String(data.name))}?app_id=${encodeURIComponent(appId)}`, { method: "PUT", body: JSON.stringify({ ...data, app_id: appId, percentage: Number(data.percentage), headers: JSON.parse(String(data.headers)), revision: channel?.revision ?? -1 }) });
  });
}
function publishDialog() {
  const appId = selectedApp;
  dialog("Publish Expo export", `<label>Export directory<input type="file" name="directory" webkitdirectory multiple required></label><label>Expo public config<input type="file" name="config" accept=".json" required></label>
    <label>Platform<select name="platform"><option>android</option><option>ios</option></select></label>
    ${field("channel", "Channel", "production")}${field("branch", "Branch (optional)")}${field("runtimeVersion", "Runtime version")}${field("fingerprint", "Native fingerprint (optional)")}${field("rollout", "Rollout percentage", "100", "number")}
    <label>Target parameters (JSON)<textarea name="targets">{}</textarea></label><label class="check"><input type="checkbox" name="staged" checked>Stage for review</label>`, async form => {
    const data = new FormData(form);
    const files = (data.getAll("directory") as File[]);
    const path = (file: File) => file.webkitRelativePath.split("/").slice(1).join("/");
    const metadataFile = files.find(f => path(f) === "metadata.json");
    if (!metadataFile) throw new Error("metadata.json is missing from the export directory");
    const metadataText = await metadataFile.text();
    const metadata = JSON.parse(metadataText) as { fileMetadata: Record<string, { bundle: string; assets: { path: string }[] }> };
    const platform = metadata.fileMetadata[String(data.get("platform"))];
    if (!platform) throw new Error("Selected platform is missing from the export");
    const bundle = files.find(f => path(f) === platform.bundle);
    if (!bundle) throw new Error("Bundle is missing from the export");
    const upload = new FormData();
    for (const key of ["channel", "branch", "runtimeVersion", "fingerprint", "rollout", "targets", "platform"]) upload.set(key, String(data.get(key) || ""));
    upload.set("staged", data.has("staged") ? "true" : "false");
    upload.set("metadata", metadataText);
    upload.set("expoConfig", await (data.get("config") as File).text());
    upload.set("bundle", bundle, bundle.name);
    platform.assets.forEach((asset, index) => {
      const file = files.find(f => path(f) === asset.path);
      if (!file) throw new Error(`Missing asset: ${asset.path}`);
      upload.set(`asset-${index}`, file, file.name);
    });
    upload.set("app_id", appId);
    await api("/api/ota/upload", { method: "POST", body: upload });
  });
}
render();
void refresh();
