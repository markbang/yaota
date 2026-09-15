import { Button, Input, Table, TextField } from "@heroui/react";
import { Activity, ArrowRight, ChevronLeft, ChevronRight, GitBranch, Layers, Search, Settings2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { Channel, DashboardState, Release } from "./api.ts";
import { Choice, CopyButton, Empty, IconButton, Status, formatDate } from "./ui.tsx";
import { CredentialsSettings } from "./credentials.tsx";

function Pager({ page, count, pageSize, onChange }: { page: number; count: number; pageSize: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / pageSize));
  return <Table.Footer className="table-pagination"><span>{count ? `${page * pageSize + 1}-${Math.min((page + 1) * pageSize, count)} of ${count}` : "0 results"}</span><div className="pagination-actions"><span>Page {page + 1} of {pages}</span><IconButton label="Previous page" disabled={page === 0} onPress={() => onChange(page - 1)}><ChevronLeft size={16} /></IconButton><IconButton label="Next page" disabled={page + 1 >= pages} onPress={() => onChange(page + 1)}><ChevronRight size={16} /></IconButton></div></Table.Footer>;
}

export function Coverage({ value, label = "Rollout" }: { value: number; label?: string }) {
  return <div className="coverage"><progress value={value} max={100} aria-label={label} /><span>{value}%</span></div>;
}

export function ReleasesView({ releases, onManage, publishAction }: { releases: Release[]; onManage: (release: Release) => void; publishAction: ReactNode }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = releases.filter(release => (status === "all" || release.status === status) && (platform === "all" || release.platform === platform) && [release.id, release.version, release.branch, release.channel, release.runtimeVersion, release.note].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  const size = 12;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / size) - 1));
  const reset = () => { setQuery(""); setStatus("all"); setPlatform("all"); setPage(0); };
  return <section className="data-section" aria-label="Updates">
    <div className="data-toolbar"><TextField aria-label="Search updates" value={query} onChange={value => { setQuery(value); setPage(0); }} className="search-field"><Search size={16} /><Input placeholder="Search updates..." /></TextField>
      <div className="filter-group"><Choice label="Release status" hiddenLabel value={status} onChange={value => { setStatus(value); setPage(0); }} options={[{ id: "all", label: "All statuses" }, ...["Live", "Staged", "Archived", "Embedded"].map(id => ({ id, label: id }))]} /><Choice label="Platform" hiddenLabel value={platform} onChange={value => { setPlatform(value); setPage(0); }} options={[{ id: "all", label: "All platforms" }, { id: "android", label: "Android" }, { id: "ios", label: "iOS" }]} /></div>
    </div>
    <Table className="data-table"><Table.ScrollContainer><Table.Content aria-label="Updates" className="releases-table"><Table.Header><Table.Column isRowHeader>Update</Table.Column><Table.Column>Branch / Platform</Table.Column><Table.Column>Runtime</Table.Column><Table.Column>Rollout</Table.Column><Table.Column>Status</Table.Column><Table.Column>Created</Table.Column><Table.Column aria-label="Update actions" /></Table.Header>
      <Table.Body items={filtered.slice(currentPage * size, (currentPage + 1) * size)} renderEmptyState={() => <Empty icon={<Layers size={24} />} title={releases.length ? "No matching updates" : "No updates yet"} action={releases.length ? <Button variant="secondary" size="sm" onPress={reset}>Clear filters</Button> : publishAction} />}>
        {release => <Table.Row id={release.id}><Table.Cell><div className="update-name"><span className={`update-mark ${release.directive ? "directive-mark" : ""}`}><Layers size={16} /></span><div className="cell-stack"><strong title={release.note}>{release.directive ? "Embedded rollback" : release.version || "Update"}</strong><code title={release.id}>{release.id.slice(0, 8)}</code><small className="mobile-update-context">{release.branch} / {release.platform === "ios" ? "iOS" : "Android"}</small></div></div></Table.Cell>
          <Table.Cell><div className="cell-stack"><span className="branch-label" title={release.branch}><GitBranch size={13} /><span>{release.branch}</span></span><small>{release.platform === "ios" ? "iOS" : "Android"}</small></div></Table.Cell>
          <Table.Cell><code className="runtime-value" title={release.runtimeVersion}>{release.runtimeVersion}</code></Table.Cell>
          <Table.Cell><Coverage value={release.rollout} /></Table.Cell><Table.Cell><Status status={release.status} /></Table.Cell><Table.Cell><time dateTime={release.createdAt} className="table-date">{formatDate(release.createdAt)}</time></Table.Cell>
          <Table.Cell><IconButton label={`Manage ${release.id.slice(0, 8)}`} onPress={() => onManage(release)}><Settings2 size={16} /></IconButton></Table.Cell></Table.Row>}
      </Table.Body></Table.Content></Table.ScrollContainer><Pager page={currentPage} count={filtered.length} pageSize={size} onChange={setPage} /></Table>
  </section>;
}

export function ChannelsView({ channels, onManage, createAction }: { channels: Channel[]; onManage: (channel: Channel) => void; createAction: ReactNode }) {
  return <section className="data-section"><Table className="data-table"><Table.ScrollContainer><Table.Content aria-label="Channels" className="channels-table"><Table.Header><Table.Column isRowHeader>Channel</Table.Column><Table.Column>Distribution</Table.Column><Table.Column>Candidate rollout</Table.Column><Table.Column>Server headers</Table.Column><Table.Column aria-label="Channel actions" /></Table.Header>
    <Table.Body items={channels} renderEmptyState={() => <Empty icon={<GitBranch size={24} />} title="No channels yet" action={createAction} />}>
      {channel => <Table.Row id={channel.name}><Table.Cell><div className="cell-stack"><strong>{channel.name}</strong><small>{channel.rollout_branch ? `${channel.percentage}% candidate` : "Mapped"}</small></div></Table.Cell>
        <Table.Cell><div className="channel-flow"><span><GitBranch size={14} />{channel.branch}</span>{channel.rollout_branch && <><ArrowRight size={14} /><span className="candidate-branch"><GitBranch size={14} />{channel.rollout_branch}</span></>}</div></Table.Cell>
        <Table.Cell>{channel.rollout_branch ? <Coverage value={channel.percentage} label="Candidate rollout" /> : <span className="muted">No active rollout</span>}</Table.Cell><Table.Cell><span className="mono">{Object.keys(channel.headers).length}</span></Table.Cell>
        <Table.Cell><IconButton label={`Manage ${channel.name}`} onPress={() => onManage(channel)}><Settings2 size={16} /></IconButton></Table.Cell></Table.Row>}
    </Table.Body></Table.Content></Table.ScrollContainer><Table.Footer>{channels.length} {channels.length === 1 ? "channel" : "channels"}</Table.Footer></Table></section>;
}

export function FailuresView({ failures }: { failures: DashboardState["failures"] }) {
  return <section className="data-section"><Table className="data-table"><Table.ScrollContainer><Table.Content aria-label="Reported launch failures" className="failures-table"><Table.Header><Table.Column isRowHeader>Update ID</Table.Column><Table.Column>Reporting clients</Table.Column><Table.Column>Last seen</Table.Column></Table.Header>
    <Table.Body items={failures} renderEmptyState={() => <Empty icon={<ShieldCheck size={26} />} title="No launch failures reported" />}>
      {failure => <Table.Row id={failure.release_id}><Table.Cell><div className="copy-value"><code>{failure.release_id}</code><CopyButton value={failure.release_id} label="Copy update ID" /></div></Table.Cell><Table.Cell><span className="failure-count">{failure.clients}</span></Table.Cell><Table.Cell><time dateTime={failure.last_seen}>{formatDate(failure.last_seen)}</time></Table.Cell></Table.Row>}
    </Table.Body></Table.Content></Table.ScrollContainer><Table.Footer>{failures.length} affected {failures.length === 1 ? "update" : "updates"}</Table.Footer></Table></section>;
}

export function ActivityView({ events }: { events: DashboardState["events"] }) {
  const [page, setPage] = useState(0);
  const size = 20;
  const current = Math.min(page, Math.max(0, Math.ceil(events.length / size) - 1));
  return <section className="data-section"><Table className="data-table"><Table.ScrollContainer><Table.Content aria-label="Activity log" className="activity-table"><Table.Header><Table.Column isRowHeader>Event</Table.Column><Table.Column>Subject</Table.Column><Table.Column>Time</Table.Column></Table.Header>
    <Table.Body items={events.slice(current * size, (current + 1) * size).map((event, index) => ({ ...event, key: index }))} renderEmptyState={() => <Empty icon={<Activity size={24} />} title="No recorded activity" />}>
      {event => <Table.Row id={event.key}><Table.Cell><span className="event-action"><span className="event-dot" />{event.action.replaceAll("-", " ")}</span></Table.Cell><Table.Cell><code className="event-subject">{event.subject}</code></Table.Cell><Table.Cell><time className="table-date" dateTime={event.created_at}>{formatDate(event.created_at)}</time></Table.Cell></Table.Row>}
    </Table.Body></Table.Content></Table.ScrollContainer><Pager page={current} count={events.length} pageSize={size} onChange={setPage} /></Table></section>;
}

export function SettingsView({ state, onDone, onUnauthorized }: { state: DashboardState; onDone: () => Promise<void>; onUnauthorized: () => void }) {
  const manifestUrl = `${location.origin}/manifest?app_id=${encodeURIComponent(state.appId)}`;
  return <section className="settings-section"><div className="settings-row"><div><h2>Application</h2></div><dl><dt>App ID</dt><dd className="copy-value"><code>{state.appId}</code><CopyButton value={state.appId} label="Copy app ID" /></dd><dt>Manifest URL</dt><dd className="copy-value"><code>{manifestUrl}</code><CopyButton value={manifestUrl} label="Copy manifest URL" /></dd></dl></div>
    <CredentialsSettings appId={state.appId} credentials={state.credentials} onDone={onDone} onUnauthorized={onUnauthorized} /></section>;
}
