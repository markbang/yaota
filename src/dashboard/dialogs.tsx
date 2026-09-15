import { Button, Checkbox, Label, Modal, Spinner, TextArea, TextField, toast } from "@heroui/react";
import { ArrowUpRight, FileJson, FolderOpen, KeyRound, Plus, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, appPath, errorMessage } from "./api.ts";
import type { Channel, Release } from "./api.ts";
import { exportUpload } from "./export-upload.ts";
import { DeliveryDetails } from "./delivery.tsx";
import { Choice, CopyButton, Field, Percentage, Status, formatDate } from "./ui.tsx";

export interface Callbacks { onClose: () => void; onDone: (appId?: string) => Promise<void>; onUnauthorized: () => void }

export function FormDialog({ title, context, children, command, icon, onSubmit, onClose, onUnauthorized, locked = false, disabled = false, danger = false }: {
  title: string; context?: string; children: ReactNode; command: string; icon?: ReactNode;
  onSubmit: (data: FormData) => Promise<void>; onClose: () => void; onUnauthorized: () => void;
  locked?: boolean; disabled?: boolean; danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open && !busy && !locked) onClose(); }} isDismissable={!busy && !locked} isKeyboardDismissDisabled={busy || locked}>
    <Modal.Container size="lg" scroll="outside" placement="center">
      <Modal.Dialog className="operation-dialog">
        {!locked && <Modal.CloseTrigger isDisabled={busy} />}
        <Modal.Header><Modal.Heading>{title}</Modal.Heading>{context && <p className="dialog-context">{context}</p>}</Modal.Header>
        <form onSubmit={async event => {
          event.preventDefault();
          if (submitting.current || disabled) return;
          const data = new FormData(event.currentTarget);
          submitting.current = true; setBusy(true); setError("");
          try { await onSubmit(data); }
          catch (cause) {
            if (cause instanceof ApiError && cause.status === 401 && !locked) { onClose(); onUnauthorized(); }
            else setError(errorMessage(cause));
          } finally { submitting.current = false; setBusy(false); }
        }}>
          <Modal.Body><fieldset disabled={busy} className="form-fields">{children}</fieldset>{error && <p className="form-error" role="alert">{error}</p>}</Modal.Body>
          <Modal.Footer>{!locked && <Button variant="secondary" onPress={onClose} isDisabled={busy}>Cancel</Button>}<Button type="submit" variant={danger ? "danger" : "primary"} isDisabled={busy || disabled}>{busy ? <Spinner size="sm" color="current" /> : icon}{busy ? "Saving..." : command}</Button></Modal.Footer>
        </form>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function Confirmation({ selected, onChange }: { selected: boolean; onChange: (value: boolean) => void }) {
  return <Checkbox isSelected={selected} onChange={onChange} name="confirmed"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Confirm this distribution change</Checkbox.Content></Checkbox>;
}

export function FileField({ name, label, directory = false, accept = ".json,application/json" }: { name: string; label: string; directory?: boolean; accept?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [selection, setSelection] = useState("No selection");
  return <div className="file-field"><span id={id}>{label}</span><div className="file-picker"><Button size="sm" variant="secondary" aria-describedby={id} onPress={() => input.current?.click()}>{directory ? <FolderOpen size={15} /> : <FileJson size={15} />}{directory ? "Choose directory" : "Choose file"}</Button><span title={selection}>{selection}</span></div>
    <input hidden ref={input} type="file" name={name} aria-label={label} {...(directory ? { webkitdirectory: "", multiple: true } : { accept })} onChange={event => {
      const files = event.currentTarget.files;
      setSelection(!files?.length ? "No selection" : directory ? `${files.length} files selected` : files[0]!.name);
    }} />
  </div>;
}

export function LoginDialog({ onDone }: { onDone: () => Promise<void> }) {
  return <FormDialog title="Admin sign in" context="yaota workspace" command="Sign in" icon={<KeyRound size={16} />} locked onClose={() => {}} onUnauthorized={() => {}} onSubmit={async data => {
    const token = String(data.get("token") || "").trim();
    if (!token) throw new Error("Enter your admin token");
    await api("/api/ota/apps", {}, token);
    sessionStorage.setItem("yaota_admin_token", token);
    await onDone();
  }}><Field name="token" label="Admin token" type="password" required autoFocus /></FormDialog>;
}

export function NewAppDialog({ onClose, onDone, onUnauthorized }: Callbacks) {
  return <FormDialog title="Create application" command="Create application" icon={<Plus size={16} />} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async data => {
    const appId = String(data.get("app_id") || "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(appId)) throw new Error("Use 1-128 letters, numbers, periods, underscores or hyphens, starting with a letter or number");
    await api("/api/ota/apps", { method: "POST", body: JSON.stringify({ app_id: appId }) });
    onClose(); toast.success("Application created"); await onDone(appId);
  }}><Field name="app_id" label="App ID" required autoFocus /></FormDialog>;
}

const releaseLabels: Record<string, string> = {
  rollout: "Increase rollout", rollback: "Roll back to previous update", embedded: "Roll back to embedded update",
  republish: "Republish to branch", promote: "Publish staged update",
};

export function ReleaseDialog({ release, onClose, onDone, onUnauthorized }: Callbacks & { release: Release }) {
  const actions = !release.manifest ? [] : release.status === "Live" ? [...(release.rollout < 100 ? ["rollout"] : []), "republish", "rollback", "embedded"] : release.status === "Staged" ? ["promote"] : ["republish"];
  const [action, setAction] = useState(actions[0] || "");
  const [amount, setAmount] = useState(release.rollout);
  const [confirmed, setConfirmed] = useState(false);
  const destructive = action === "rollback" || action === "embedded";
  const destination = action === "republish" || action === "promote";
  return <FormDialog title="Update details" context={release.appId} command={releaseLabels[action] || "Close"} disabled={!!action && !confirmed} danger={destructive} icon={<ArrowUpRight size={16} />} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async data => {
    if (!action) { onClose(); return; }
    await api(appPath(`/api/ota/releases/${encodeURIComponent(release.id)}/${action}`, release.appId), { method: "POST", body: JSON.stringify({
      app_id: release.appId, percentage: amount, branch: data.get("branch"), channel: data.get("channel"), revision: release.revision,
    }) });
    onClose(); toast.success("Update distribution saved"); await onDone();
  }}>
    <div className="release-detail"><div className="detail-title"><strong>{release.directive ? "Embedded rollback" : release.version || "Update"}</strong><Status status={release.status} /></div>
      <div className="copy-value"><code>{release.id}</code><CopyButton value={release.id} label="Copy update ID" /></div>
      <dl className="detail-grid"><div><dt>Branch</dt><dd>{release.branch}</dd></div><div><dt>Platform</dt><dd>{release.platform}</dd></div><div><dt>Runtime</dt><dd><code>{release.runtimeVersion}</code></dd></div><div><dt>Created</dt><dd>{formatDate(release.createdAt)}</dd></div><div><dt>Rollout</dt><dd>{release.rollout}%</dd></div><div><dt>Assets</dt><dd>{release.manifest ? release.manifest.assets.length : "None"}</dd></div></dl>
      <DeliveryDetails release={release} />
      {release.note && <p className="release-note">{release.note}</p>}
      {Object.keys(release.targets).length > 0 && <details><summary>Target parameters</summary><pre>{JSON.stringify(release.targets, null, 2)}</pre></details>}
    </div>
    {action && <><Choice label="Action" value={action} onChange={value => { setAction(value); setConfirmed(false); }} options={actions.map(id => ({ id, label: releaseLabels[id]! }))} />
      {destination && <div className="form-grid"><Field name="branch" label="Destination branch" value={release.branch} required /><Field name="channel" label="Destination channel" value={release.channel} required /></div>}
      {!destructive && <Percentage value={amount} onChange={setAmount} min={action === "rollout" ? release.rollout : 0} />}
      {destructive && <p className="warning-message">{action === "embedded" ? "Clients will return to the update bundled in their installed app." : "Clients will return to the previous compatible update, or the embedded update when none is available."}</p>}
      <Confirmation selected={confirmed} onChange={setConfirmed} /></>}
  </FormDialog>;
}

const channelLabels: Record<string, string> = { map: "Map branch", start: "Start branch rollout", progress: "Increase rollout", complete: "Complete rollout", cancel: "Cancel rollout" };

export function ChannelDialog({ appId, channel, onClose, onDone, onUnauthorized }: Callbacks & { appId: string; channel?: Channel }) {
  const actions = channel?.rollout_branch ? ["progress", "complete", "cancel"] : ["map", "start"];
  const [action, setAction] = useState(actions[0]!);
  const [amount, setAmount] = useState(channel?.percentage || 0);
  const [confirmed, setConfirmed] = useState(false);
  return <FormDialog title={channel ? "Channel distribution" : "Create channel"} context={appId} command={channel ? "Save distribution" : "Create channel"} disabled={!!channel && !confirmed} danger={action === "cancel"} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async data => {
    const name = channel?.name || String(data.get("name") || "").trim();
    if (!name) throw new Error("Channel name is required");
    const headers = JSON.parse(String(data.get("headers") || "{}")) as unknown;
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== "string")) throw new Error("Server headers must be a JSON object with string values");
    if (action === "start" && amount >= 100) throw new Error("Start a rollout below 100%, or map the branch directly");
    await api(appPath(`/api/ota/channels/${encodeURIComponent(name)}`, appId), { method: "PUT", body: JSON.stringify({
      app_id: appId, action, branch: data.get("branch"), rolloutBranch: data.get("rolloutBranch"), percentage: amount, headers, revision: channel?.revision ?? -1,
    }) });
    onClose(); toast.success(channel ? "Channel distribution saved" : "Channel created"); await onDone();
  }}>
    <Field name="name" label="Channel name" value={channel?.name} readOnly={!!channel} required autoFocus={!channel} />
    <Choice label="Action" value={action} onChange={value => { setAction(value); setConfirmed(false); }} options={actions.map(id => ({ id, label: channelLabels[id]! }))} />
    <Field name="branch" label="Branch" value={channel?.branch} readOnly={!!channel?.rollout_branch} required />
    {(action === "start" || action === "progress") && <><Field name="rolloutBranch" label="Candidate branch" value={channel?.rollout_branch || ""} readOnly={action === "progress"} required /><Percentage value={amount} onChange={setAmount} label="Candidate percentage" min={action === "progress" ? channel?.percentage || 0 : 0} /></>}
    {(action === "complete" || action === "cancel") && <p className="warning-message">{action === "complete" ? `All clients will receive branch ${channel?.rollout_branch}.` : `All clients will return to branch ${channel?.branch}.`}</p>}
    <TextField name="headers" defaultValue={JSON.stringify(channel?.headers || {}, null, 2)}><Label>Server headers (JSON)</Label><TextArea rows={3} className="code-input" /></TextField>
    {channel && <Confirmation selected={confirmed} onChange={setConfirmed} />}
  </FormDialog>;
}

export function PublishDialog({ appId, onClose, onDone, onUnauthorized }: Callbacks & { appId: string }) {
  const [platform, setPlatform] = useState("android");
  const [amount, setAmount] = useState(100);
  const [staged, setStaged] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  return <FormDialog title="Publish Expo export" context={appId} command={staged ? "Stage update" : "Publish update"} disabled={!staged && !confirmed} icon={<Upload size={16} />} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async data => {
    data.set("rollout", String(amount)); data.set("platform", platform);
    if (staged) data.set("staged", "true"); else data.delete("staged");
    const upload = await exportUpload(data, appId);
    await api("/api/ota/upload", { method: "POST", body: upload });
    onClose(); toast.success(staged ? "Update staged" : "Update published"); await onDone();
  }}>
    <FileField name="directory" label="Export directory" directory />
    <FileField name="config" label="Expo public config" />
    <div className="form-grid"><Choice label="Platform" name="platform" value={platform} onChange={setPlatform} options={[{ id: "android", label: "Android" }, { id: "ios", label: "iOS" }]} /><Field name="runtimeVersion" label="Runtime version" required /></div>
    <div className="form-grid"><Field name="channel" label="Channel" value="production" required /><Field name="branch" label="Branch (optional)" /></div>
    <Percentage value={amount} onChange={setAmount} name="rollout" />
    <details className="advanced-fields"><summary>Advanced options</summary><div className="form-fields"><Field name="fingerprint" label="Native fingerprint" /><TextField name="targets" defaultValue="{}"><Label>Target parameters (JSON)</Label><TextArea rows={3} className="code-input" /></TextField></div></details>
    <Checkbox name="staged" isSelected={staged} onChange={setStaged}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Stage for review</Checkbox.Content></Checkbox>
    {!staged && <Confirmation selected={confirmed} onChange={setConfirmed} />}
  </FormDialog>;
}
