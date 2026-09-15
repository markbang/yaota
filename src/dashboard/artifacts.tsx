import { Button, Input, Table, TextField, toast } from "@heroui/react";
import { Download, GitBranch, Package, Search, Upload } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { Apk } from "./api.ts";
import { api, appPath } from "./api.ts";
import { FileField, FormDialog } from "./dialogs.tsx";
import type { Callbacks } from "./dialogs.tsx";
import { Choice, CopyButton, Empty, Field, formatDate } from "./ui.tsx";
import { Pager } from "./views.tsx";
import { formatBytes } from "./format.ts";

export function ApksView({ apks, addAction }: { apks: Apk[]; addAction: ReactNode }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = apks.filter(apk => [apk.version, apk.arch, apk.source].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  const current = Math.min(page, Math.max(0, Math.ceil(filtered.length / 12) - 1));
  return <section className="data-section"><div className="data-toolbar"><TextField className="search-field" aria-label="Search APKs" value={query} onChange={value => { setQuery(value); setPage(0); }}><Search size={16} /><Input placeholder="Search APKs..." /></TextField><span className="muted">{apks.length} packages</span></div>
    <Table className="data-table"><Table.ScrollContainer><Table.Content aria-label="Android packages" className="apks-table"><Table.Header><Table.Column isRowHeader>Version / Architecture</Table.Column><Table.Column>Size</Table.Column><Table.Column>Source</Table.Column><Table.Column>Created</Table.Column><Table.Column aria-label="Download APK" /></Table.Header>
      <Table.Body items={filtered.slice(current * 12, (current + 1) * 12)} renderEmptyState={() => <Empty icon={<Package size={24} />} title={apks.length ? "No matching APKs" : "No APKs registered"} action={apks.length ? <Button variant="secondary" onPress={() => setQuery("")}>Clear search</Button> : addAction} />}>
        {apk => <Table.Row id={apk.key}><Table.Cell><div className="update-name"><span className="update-mark apk-mark"><Package size={16} /></span><div className="cell-stack"><strong title={apk.version}>{apk.version}</strong><code>{apk.arch}</code><small className="mobile-update-context">{apk.source}</small>{apk.status !== "Available" && <small>{apk.status}</small>}</div></div></Table.Cell><Table.Cell><span className="mono">{formatBytes(apk.sizeBytes)}</span></Table.Cell><Table.Cell>{apk.source}</Table.Cell><Table.Cell><time className="table-date" dateTime={apk.createdAt}>{formatDate(apk.createdAt)}</time></Table.Cell><Table.Cell>{apk.status === "Available" && <div className="apk-actions"><a className="download-link" href={apk.downloadUrl} aria-label={`Download ${apk.version} ${apk.arch}`} title={`Download ${apk.version} ${apk.arch}`}><Download size={16} /></a><CopyButton value={new URL(apk.downloadUrl, location.origin).href} label="Copy APK URL" /></div>}</Table.Cell></Table.Row>}
      </Table.Body></Table.Content></Table.ScrollContainer><Pager page={current} count={filtered.length} pageSize={12} onChange={setPage} /></Table>
  </section>;
}

export function ApkDialog({ appId, onClose, onDone, onUnauthorized }: Callbacks & { appId: string }) {
  const [source, setSource] = useState("github");
  const [arch, setArch] = useState("arm64-v8a");
  return <FormDialog title="Add Android packages" context={appId} command={source === "github" ? "Import APKs" : "Upload APK"} icon={source === "github" ? <GitBranch size={16} /> : <Upload size={16} />} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async data => {
    if (source === "github") {
      await api(appPath("/api/ota/apks/github", appId), { method: "POST", body: JSON.stringify({ repository: data.get("repository"), tag: data.get("tag") }) });
    } else {
      const file = data.get("file");
      if (!(file instanceof File) || !file.size || !file.name.toLowerCase().endsWith(".apk")) throw new Error("Select an APK file");
      if (file.size >= 100 * 1024 * 1024 - 65536) throw new Error("APK exceeds the 100 MiB upload limit. Import a GitHub Release instead.");
      data.set("arch", arch);
      await api(appPath("/api/ota/apks", appId), { method: "POST", body: data });
    }
    onClose(); toast.success(source === "github" ? "APKs imported" : "APK uploaded"); await onDone();
  }}><Choice label="Source" value={source} onChange={setSource} options={[{ id: "github", label: "GitHub Release" }, { id: "upload", label: "Local APK" }]} />
    {source === "github" ? <><Field name="repository" label="GitHub repository (owner/repo)" required /><Field name="tag" label="Release tag (blank for latest)" /></> : <><Field name="version" label="Version" required /><Choice label="Architecture" value={arch} onChange={setArch} options={["arm64-v8a", "armeabi-v7a", "x86_64", "x86", "universal"].map(id => ({ id, label: id }))} /><FileField name="file" label="APK file" accept=".apk,application/vnd.android.package-archive" /></>}
  </FormDialog>;
}
