import "./styles.css";
import { Button, Spinner, Toast } from "@heroui/react";
import { I18nProvider } from "@heroui/react/rac";
import { Activity, ArrowUpRight, ChevronRight, CircleAlert, GitBranch, Layers, LogOut, Plus, Radio, RefreshCw, Settings2, ShieldCheck, Smartphone, Upload } from "lucide-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Channel, Release } from "./dashboard/api.ts";
import { ChannelDialog, LoginDialog, NewAppDialog, PublishDialog, ReleaseDialog } from "./dashboard/dialogs.tsx";
import { Choice, Empty, IconButton } from "./dashboard/ui.tsx";
import { useDashboard } from "./dashboard/use-dashboard.ts";
import { ActivityView, ChannelsView, FailuresView, ReleasesView, SettingsView } from "./dashboard/views.tsx";

const navigation = [
  { id: "releases", label: "Releases", icon: Layers }, { id: "channels", label: "Channels", icon: GitBranch },
  { id: "failures", label: "Failures", icon: CircleAlert }, { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;
type View = typeof navigation[number]["id"];
type Dialog = { type: "app" } | { type: "publish"; appId: string } | { type: "channel"; appId: string; channel?: Channel } | { type: "release"; release: Release };
const currentView = (): View => navigation.find(item => item.id === location.hash.slice(1))?.id || "releases";

function Dashboard() {
  const dashboard = useDashboard();
  const { apps, selectedApp, state, phase, error, refresh, signOut } = dashboard;
  const [view, setView] = useState<View>(currentView);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useEffect(() => { const change = () => setView(currentView()); window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  const ready = phase === "ready" && !!state && state.appId === selectedApp;
  const canPublish = ready && !!state.configuration?.signing;
  const title = navigation.find(item => item.id === view)!.label;
  const close = () => setDialog(null);
  const callbacks = { onClose: close, onDone: refresh, onUnauthorized: signOut };
  const createApp = <Button variant="secondary" size="sm" onPress={() => setDialog({ type: "app" })} isDisabled={phase !== "ready" && phase !== "error"}><Plus size={15} />New application</Button>;
  const publish = <Button onPress={() => setDialog({ type: "publish", appId: selectedApp })} isDisabled={!canPublish}><Upload size={16} />Publish update</Button>;
  const createChannel = <Button onPress={() => setDialog({ type: "channel", appId: selectedApp })} isDisabled={!ready}><Plus size={16} />Create channel</Button>;
  return <><div className="dashboard-shell"><aside className="sidebar">
    <a className="brand" href="/admin" aria-label="yaota dashboard"><span className="brand-mark"><Radio size={22} strokeWidth={2.4} /></span><span>yaota</span><span className="brand-caption">console</span></a>
    <div className="application-picker"><div className="sidebar-label"><span>APPLICATION</span><IconButton label="Create application" disabled={phase !== "ready" && phase !== "error"} onPress={() => setDialog({ type: "app" })}><Plus size={16} /></IconButton></div>
      <Choice label="Application" hiddenLabel className="app-select" value={selectedApp} disabled={!apps.length || phase === "signed-out"} onChange={id => { close(); void refresh(id); }} options={apps.map(app => ({ id: app.app_id, label: app.app_id }))} />
    </div>
    <nav className="navigation" aria-label="Main navigation">{navigation.map(({ id, label, icon: Icon }) => <a key={id} className={`nav-link ${view === id ? "active" : ""}`} href={`#${id}`} aria-current={view === id ? "page" : undefined}><Icon size={17} /><span>{label}</span>{id === "releases" && ready && state.releases.length > 0 && <span className="nav-count">{state.releases.length}</span>}{id === "failures" && ready && state.failures.length > 0 && <span className="nav-count alert-count">{state.failures.length}</span>}</a>)}</nav>
    <div className="sidebar-bottom">{createApp}<div className="workspace-label"><ShieldCheck size={15} /><span>Admin workspace</span></div></div>
  </aside>
  <main className="main"><header className="topbar"><div className="breadcrumb"><Smartphone size={15} /><span title={selectedApp}>{selectedApp || "Workspace"}</span><ChevronRight size={14} /><strong>{title}</strong></div><div className="topbar-actions"><IconButton label="Refresh" disabled={phase === "loading" || phase === "signed-out"} onPress={() => { close(); void refresh(); }}><RefreshCw size={17} className={phase === "loading" ? "spin" : ""} /></IconButton><span className="topbar-divider" /><IconButton label="Sign out" disabled={phase === "signed-out"} onPress={() => { close(); signOut(); }}><LogOut size={17} /></IconButton></div></header>
    <div className="content"><div className="page-heading"><div><div className="eyebrow">APPLICATION / {view === "settings" ? "CONFIGURATION" : "OTA UPDATES"}</div><h1>{title}</h1></div>{view === "releases" ? publish : view === "channels" ? createChannel : null}</div>
      {phase === "loading" ? <div className="loading-state" role="status"><Spinner size="md" /><span>Loading workspace...</span></div> : phase === "error" ? <div className="error-state" role="alert"><CircleAlert size={24} /><h2>Unable to load workspace</h2><p>{error}</p><Button variant="secondary" onPress={() => { void refresh(); }}><RefreshCw size={16} />Try again</Button></div> : phase === "signed-out" ? <Empty icon={<ShieldCheck size={28} />} title="Workspace locked" /> : !state ? <Empty icon={<Smartphone size={28} />} title="No applications yet" action={createApp} /> : <>
        <div className="configuration-strip"><div className="configuration-items"><span className={state.configuration?.publishing ? "configured-text" : "warning-text"}><span className="status-dot" />Publishing key: {state.configuration?.publishing ? "configured" : "missing"}</span><span className={state.configuration?.signing ? "configured-text" : "warning-text"}><span className="status-dot" />Signing key: {state.configuration?.signing ? "configured" : "missing or invalid"}</span></div>{view !== "settings" && <a href="#settings" className="settings-link" aria-label="View configuration"><ArrowUpRight size={16} /></a>}</div>
        {view === "releases" && <><section className="metrics" aria-label="Release overview">{[
          { label: "Live updates", value: state.releases.filter(release => release.status === "Live" && release.manifest).length, className: "live-metric" },
          { label: "Staged updates", value: state.releases.filter(release => release.status === "Staged").length, className: "staged-metric" },
          { label: "Active rollouts", value: state.releases.filter(release => release.status === "Live" && release.manifest && release.rollout < 100).length + state.channels.filter(channel => channel.rollout_branch).length, className: "rollout-metric" },
          { label: "Client/update failures", value: state.failures.reduce((sum, failure) => sum + failure.clients, 0), className: "failure-metric" },
        ].map(metric => <div key={metric.label} className={`metric ${metric.className}`}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}</section><ReleasesView key={state.appId} releases={state.releases} onManage={release => setDialog({ type: "release", release })} publishAction={publish} /></>}
        {view === "channels" && <ChannelsView channels={state.channels} onManage={channel => setDialog({ type: "channel", appId: state.appId, channel })} createAction={createChannel} />}
        {view === "failures" && <FailuresView failures={state.failures} />}
        {view === "activity" && <ActivityView key={state.appId} events={state.events} />}
        {view === "settings" && <SettingsView key={state.appId} state={state} onDone={refresh} onUnauthorized={signOut} />}
        <footer className="content-footer"><span><span className="status-dot" />Connected</span><span>{state.appId}</span></footer>
      </>}
    </div>
  </main></div>
  {phase === "signed-out" && <LoginDialog onDone={refresh} />}
  {phase !== "signed-out" && dialog?.type === "app" && <NewAppDialog {...callbacks} />}
  {ready && dialog?.type === "publish" && dialog.appId === selectedApp && <PublishDialog {...callbacks} appId={dialog.appId} />}
  {ready && dialog?.type === "channel" && dialog.appId === selectedApp && <ChannelDialog {...callbacks} appId={dialog.appId} channel={dialog.channel} />}
  {ready && dialog?.type === "release" && dialog.release.appId === selectedApp && <ReleaseDialog {...callbacks} release={dialog.release} />}
  <Toast.Provider placement="bottom end" />
  </>;
}

createRoot(document.getElementById("app")!).render(<StrictMode><I18nProvider locale="en-US"><Dashboard /></I18nProvider></StrictMode>);
