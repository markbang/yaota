import "./styles.css";

const state = {
  releases: [
    {
      id: "rel_8c1f",
      version: "2.4.0",
      channel: "production",
      platform: "android",
      runtimeVersion: "54.0.0",
      status: "Live",
      rollout: 68,
      createdAt: "Today 09:42",
      note: "Fix push token invalidation",
    },
    {
      id: "rel_2a91",
      version: "2.4.0-rc.2",
      channel: "preview",
      platform: "android",
      runtimeVersion: "54.0.0",
      status: "Staged",
      rollout: 12,
      createdAt: "Yesterday 16:18",
      note: "Checkout performance improvements",
    },
    {
      id: "rel_7d03",
      version: "2.3.9",
      channel: "production",
      platform: "android",
      runtimeVersion: "53.0.0",
      status: "Archived",
      rollout: 0,
      createdAt: "06/18 11:04",
      note: "Stable release",
    },
  ],
  apks: [
    {
      version: "2.3.8",
      size: "48.2 MB",
      arch: "arm64-v8a",
      downloads: 1284,
      createdAt: "06/12/2024",
      status: "Available",
      key: "apk/2.3.8.apk",
    },
    {
      version: "2.3.7",
      size: "47.9 MB",
      arch: "arm64-v8a",
      downloads: 3901,
      createdAt: "05/28/2024",
      status: "Available",
      key: "apk/2.3.7.apk",
    },
  ],
};

const icon = (name) =>
  `<span class="icon icon-${name}" aria-hidden="true"></span>`;
const api = async (path, options = {}) => {
  const token = sessionStorage.getItem("yaota_admin_token");
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.status === 204 ? null : response.json();
};

async function upload(url, file, contentType) {
  const token = sessionStorage.getItem("yaota_admin_token");
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
}

function formatDate(value) {
  if (!value) return "Just now";
  if (/Today|Yesterday|^\d{2}\/\d{2}/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }) +
        " " +
        date.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
}

function releaseRow(r) {
  const rollout = Number(r.rollout ?? r.users?.replace("%", "") ?? 0);
  const action =
    r.status === "Staged"
      ? "Promote to 100%"
      : r.status === "Live"
        ? "Rollback"
        : "···";
  return `<tr><td><div class="version"><span class="version-dot ${r.status.toLowerCase()}"></span><strong>${r.version}</strong><small>${r.note || "No release notes"}</small></div></td><td><span class="channel ${r.channel}">${r.channel}</span></td><td><code>${r.runtimeVersion || r.runtime}</code></td><td><div class="coverage"><span><i style="width:${rollout}%"></i></span>${rollout}%</div></td><td><span class="status ${r.status.toLowerCase()}">${r.status}</span></td><td><span class="muted">${formatDate(r.createdAt || r.created)}</span></td><td><button class="row-action" data-action="${r.status === "Staged" ? "promote" : r.status === "Live" ? "rollback" : "details"}" data-id="${r.id}">${action}</button></td></tr>`;
}

function apkRow(a) {
  const key = a.key || `apk/${a.version}.apk`;
  return `<div class="apk-row"><div class="apk-badge">APK</div><div class="apk-info"><strong>v${a.version}</strong><small>${a.arch} · ${a.size} · ${formatDate(a.createdAt || a.created)}</small></div><span class="downloads">${Number(a.downloads || 0).toLocaleString()} downloads</span><a class="download-btn" title="Download APK" href="/apk/${key.replace(/^apk\//, "")}" download>${icon("download")}</a></div>`;
}

function render() {
  const stagedCount = state.releases.filter(
    (r) => r.status === "Staged",
  ).length;
  const live = state.releases.find((r) => r.status === "Live");
  document.querySelector("#app").innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">Y</span><span>yaota</span><span class="brand-dot"></span></div>
        <div class="workspace"><span class="eyebrow">WORKSPACE</span><button class="workspace-select">shop-app <span>⌄</span></button></div>
        <nav class="nav"><a class="nav-item active" href="#releases">${icon("layers")} Releases <span class="nav-count">${state.releases.length}</span></a><a class="nav-item" href="#apk">${icon("download")} APK assets</a><a class="nav-item" href="#channels">${icon("radio")} Channels & rules</a><a class="nav-item" href="#activity">${icon("pulse")} Activity log</a></nav>
        <div class="sidebar-bottom"><div class="edge-status"><span class="status-light"></span><div><strong>Cloudflare Edge</strong><small>Singapore · 42ms</small></div></div><div class="user"><span class="avatar">B</span><div><strong>Bang Wu</strong><small>Administrator</small></div><span class="more">···</span></div></div>
      </aside>
      <main class="main">
        <header class="topbar"><div><span class="crumb">WORKSPACE /</span><span class="crumb-current">RELEASES</span></div><div class="top-actions"><button class="icon-btn" title="Search">${icon("search")}</button><button class="icon-btn" title="Notifications">${icon("bell")}<span class="notification-dot"></span></button><button class="help-btn">${icon("help")} Docs</button></div></header>
        <div class="content">
          <section class="page-heading"><div><div class="kicker">OTA CONTROL PLANE <span>·</span> LIVE</div><h1>Release management</h1><p>Ship Expo Updates and Android APKs with confidence, visibility, and rollback control.</p></div><button class="primary" id="new-release">${icon("plus")} New release</button></section>
          <section class="metrics"><div class="metric"><span class="metric-label">Live version</span><strong>${live?.version || "—"}</strong><span class="metric-trend up">↑ 1 release</span></div><div class="metric"><span class="metric-label">Active devices</span><strong>24,891</strong><span class="metric-trend up">↑ 8.4% this week</span></div><div class="metric"><span class="metric-label">Update success</span><strong>99.2<span class="unit">%</span></strong><span class="metric-trend neutral">Last 7 days</span></div><div class="metric accent-metric"><span class="metric-label">Pending actions</span><strong>${stagedCount}</strong><span class="metric-trend warn">Needs your review</span></div></section>
          <section class="section" id="releases"><div class="section-head"><div><h2>Release queue</h2><p>Current Expo OTA status by channel</p></div><div class="filters"><button class="filter active" data-filter="all">All <span>${state.releases.length}</span></button><button class="filter" data-filter="production">Production</button><button class="filter" data-filter="preview">Preview</button><button class="filter" data-filter="archived">Archived</button></div></div><div class="table-wrap"><table><thead><tr><th>VERSION / NOTES</th><th>CHANNEL</th><th>RUNTIME</th><th>ROLLOUT</th><th>STATUS</th><th>CREATED</th><th></th></tr></thead><tbody id="release-body">${state.releases.map(releaseRow).join("")}</tbody></table></div></section>
          <div class="lower-grid"><section class="section compact" id="apk"><div class="section-head"><div><h2>APK assets</h2><p>Native Android packages available for download</p></div><button class="secondary" id="upload-apk">${icon("upload")} Upload APK</button><input id="apk-file" type="file" accept=".apk,application/vnd.android.package-archive" hidden /></div><div class="apk-list" id="apk-list">${state.apks.map(apkRow).join("")}</div></section><section class="section compact" id="channels"><div class="section-head"><div><h2>Channel rules</h2><p>Distribution strategy for update requests</p></div><button class="icon-btn" title="Settings">${icon("settings")}</button></div><div class="rule"><div class="rule-icon">P</div><div><strong>production</strong><small>Stable release · 100% devices</small></div><span class="rule-arrow">→</span></div><div class="rule"><div class="rule-icon preview">B</div><div><strong>preview</strong><small>Internal testing · 12% devices</small></div><span class="rule-arrow">→</span></div><div class="endpoint"><span class="endpoint-dot"></span><code>updates.yaota.dev</code><button class="copy" data-copy="https://updates.yaota.dev">${icon("copy")}</button><button class="token-btn" id="set-token">Set token</button></div></section></div>
          <section class="activity section" id="activity"><div class="section-head"><div><h2>Recent activity</h2><p>System events and operator actions</p></div><a class="text-link" href="#activity">View all ${icon("arrow")}</a></div><div class="activity-row"><span class="activity-time">09:42</span><span class="activity-dot green"></span><div><strong>Published 2.4.0 to production</strong><small>Bang Wu · Expo OTA · rel_8c1f</small></div><span class="activity-status">Success</span></div><div class="activity-row"><span class="activity-time">09:16</span><span class="activity-dot yellow"></span><div><strong>Adjusted preview rollout to 12%</strong><small>Bang Wu · Channel rules</small></div><span class="activity-status">Updated</span></div></section>
        </div>
      </main>
    </div>
    <div class="toast" id="toast"></div>
    <dialog id="release-dialog"><form method="dialog" id="release-form"><div class="dialog-head"><div><span class="kicker">NEW RELEASE</span><h2>Create OTA release</h2></div><button class="icon-btn close" value="cancel">${icon("close")}</button></div><div class="field-grid"><label>Version<input name="version" value="2.4.1" required /></label><label>Runtime version<input name="runtimeVersion" value="54.0.0" required /></label></div><label>Channel<select name="channel"><option>production</option><option>preview</option></select></label><label>Launch asset URL<input name="launchAssetUrl" type="url" placeholder="https://cdn.example.com/bundle/index.js" /></label><label>Bundle file<input name="bundle" type="file" accept=".js,text/javascript,application/javascript" /></label><label>Release notes<textarea name="note" rows="3" placeholder="What changed in this release?"></textarea></label><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" value="default">Create release</button></div></form></dialog>
  `;
  bindEvents();
}

function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function refreshFromApi() {
  try {
    const [releaseData, apkData] = await Promise.all([
      api("/api/releases"),
      api("/api/apks"),
    ]);
    if (releaseData?.releases) state.releases = releaseData.releases;
    if (apkData?.apks) state.apks = apkData.apks;
    render();
  } catch {
    /* Vite development uses the seeded state until Worker API is available. */
  }
}

function bindEvents() {
  document.querySelectorAll('#release-form button[value="cancel"]').forEach((button) => {
    button.type = "button";
    button.onclick = () => document.querySelector("#release-dialog").close();
  });
  document.querySelector("#new-release").onclick = () =>
    document.querySelector("#release-dialog").showModal();
  document.querySelector("#release-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const bundle = formData.get("bundle");
    formData.delete("bundle");
    const data = Object.fromEntries(formData);
    let createdRelease;
    let bundleUploaded = false;
    try {
      const result = await api("/api/releases", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (result?.release) {
        createdRelease = result.release;
        state.releases.unshift(result.release);
        if (bundle instanceof File && bundle.size > 0) {
          const signed = await api(
            `/api/updates/${result.release.id}/presign`,
            { method: "POST", body: JSON.stringify({ key: "index.js" }) },
          );
          await upload(signed.uploadUrl, bundle, "application/javascript");
          const patched = await api(`/api/releases/${result.release.id}`, {
            method: "PATCH",
            body: JSON.stringify({ launchAssetUrl: signed.publicUrl }),
          });
          if (patched?.release) Object.assign(result.release, patched.release);
          bundleUploaded = true;
        }
      }
    } catch (error) {
      if (createdRelease) {
        render();
        toast(`Release saved, but bundle setup failed: ${error.message}`);
      } else toast(`Release creation failed: ${error.message}`);
      return;
    }
    document.querySelector("#release-dialog").close();
    render();
    toast(
      bundleUploaded
        ? "Release and bundle uploaded to R2"
        : "Release created and staged for review",
    );
  };
  document.querySelectorAll(".row-action").forEach(
    (button) =>
      (button.onclick = async () => {
        if (button.dataset.action === "details")
          return toast("This release is archived");
        const action = button.dataset.action;
        const id = button.dataset.id;
        const release = state.releases.find((item) => item.id === id);
        try {
          const result = await api(`/api/releases/${id}/${action}`, { method: "POST" });
          Object.assign(release, result.release);
          const listed = await api("/api/releases");
          state.releases = listed.releases;
        } catch (error) {
          toast(`Release action failed: ${error.message}`);
          return;
        }
        render();
        toast(
          action === "promote"
            ? `${release?.version || "Release"} promoted on ${release.channel}`
            : "Release rolled back",
        );
      }),
  );
  document.querySelector("#upload-apk").onclick = () =>
    document.querySelector("#apk-file").click();
  document.querySelector("#set-token").onclick = () => {
    const token = window.prompt(
      "Enter YAOTA_ADMIN_TOKEN for this workspace",
      sessionStorage.getItem("yaota_admin_token") || "",
    );
    if (token !== null) {
      sessionStorage.setItem("yaota_admin_token", token.trim());
      toast(
        token.trim()
          ? "Admin token saved for this session"
          : "Admin token cleared",
      );
    }
  };
  document.querySelector("#apk-file").onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const version =
        file.name.replace(/\.apk$/i, "").replace(/^v/, "") ||
        Date.now().toString();
      const signed = await api("/api/apks/presign", {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      await upload(signed.uploadUrl, file, "application/vnd.android.package-archive");
      toast("APK uploaded to R2");
      refreshFromApi();
    } catch (error) {
      toast(error.message);
    }
  };
  document.querySelectorAll("[data-copy]").forEach(
    (button) =>
      (button.onclick = async () => {
        await navigator.clipboard?.writeText(button.dataset.copy);
        toast("Link copied to clipboard");
      }),
  );
  document.querySelectorAll(".filter").forEach(
    (button) =>
      (button.onclick = () => {
        document
          .querySelectorAll(".filter")
          .forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        const filter = button.dataset.filter;
        document.querySelector("#release-body").innerHTML = state.releases
          .filter(
            (item) =>
              filter === "all" ||
              item.channel === filter ||
              item.status.toLowerCase() === filter,
          )
          .map(releaseRow)
          .join("");
        bindEvents();
      }),
  );
}

render();
refreshFromApi();
