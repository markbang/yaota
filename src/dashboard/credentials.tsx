import { Button, Checkbox, toast } from "@heroui/react";
import { Check, Download, KeyRound, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CredentialsState, KeyMetadata } from "../ota-credentials.ts";
import { api, appPath } from "./api.ts";
import { FileField, FormDialog } from "./dialogs.tsx";
import type { Callbacks } from "./dialogs.tsx";
import { CopyButton, Field, IconButton, formatDate } from "./ui.tsx";

const root = "/api/ota/credentials";
const certificateDate = (value: string) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
type Change = { type: "default"; key: KeyMetadata } | { type: "revoke-key"; key: KeyMetadata } | { type: "revoke-token"; id: string; name: string } | { type: "legacy"; enabled: boolean };
type Dialog = { type: "import" } | { type: "token" } | Change;
type Context = Callbacks & { appId: string; credentials: CredentialsState };

function useCredentialRequest(appId: string) {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { controller.current = new AbortController(); return () => controller.current?.abort(); }, []);
  return <T,>(path: string, data: object, method = "POST") => api<T>(appPath(`${root}/${path}`, appId), { method, body: JSON.stringify(data), signal: controller.current?.signal });
}
function Confirm({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: string }) {
  return <Checkbox isSelected={checked} onChange={onChange}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{children}</Checkbox.Content></Checkbox>;
}
function downloadCertificate(key: KeyMetadata) {
  const url = URL.createObjectURL(new Blob([key.certificate!], { type: "application/x-pem-file" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${key.keyId}.pem`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CredentialsSettings({ appId, credentials, onDone, onUnauthorized }: Omit<Context, "onClose">) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const { signing, publishing } = credentials;
  const callbacks = { appId, credentials, onDone, onUnauthorized, onClose: () => setDialog(null) };
  return <>
    <div className="settings-row"><div className="settings-heading"><h2>Signing keys</h2><span className="scope-label">{appId}</span></div><div className="credential-settings">
      <div className="credential-toolbar"><div><span className={signing.configured ? "configured-text" : "warning-text"}>{signing.configured ? "Signing ready" : "Signing unavailable"}</span><span className="credential-default">Default: <code>{signing.defaultKeyId}</code></span></div><Button size="sm" variant="secondary" onPress={() => setDialog({ type: "import" })} isDisabled={!signing.encryptionConfigured}><Upload size={15} />Import key</Button></div>
      {!signing.encryptionConfigured && <p className="warning-message">Credential encryption is not configured. Set the Worker secret CREDENTIALS_ENCRYPTION_KEY before importing keys.</p>}
      {signing.error && <p className="warning-message">{signing.error}</p>}
      {signing.environmentError && <p className="warning-message">{signing.environmentError}</p>}
      <ul className="credential-list" aria-label="Signing keys">{signing.keys.map(key => <li key={key.keyId} className={key.revokedAt ? "revoked-credential" : ""}>
        <div className="credential-item-heading"><div className="credential-name"><KeyRound size={16} /><strong>{key.keyId}</strong>{key.keyId === signing.defaultKeyId && <span className="credential-badge">Default</span>}<span className="scope-label">{key.source === "managed" ? "Managed" : "Worker secret"}</span></div>
          <div className="credential-actions">{key.certificate && <IconButton label={`Download certificate ${key.keyId}`} onPress={() => downloadCertificate(key)}><Download size={15} /></IconButton>}{!key.revokedAt && <><IconButton label={`Set ${key.keyId} as default`} disabled={key.keyId === signing.defaultKeyId || !!key.error} onPress={() => setDialog({ type: "default", key })}><Check size={15} /></IconButton><IconButton label={`Revoke signing key ${key.keyId}`} onPress={() => setDialog({ type: "revoke-key", key })}><Trash2 size={15} /></IconButton></>}</div></div>
        {key.fingerprint && <div className="credential-fingerprint"><span>SHA-256 public key</span><code>{key.fingerprint}</code><CopyButton value={key.fingerprint} label={`Copy fingerprint ${key.keyId}`} /></div>}
        <div className="credential-meta">{key.revokedAt ? <span>Revoked {formatDate(key.revokedAt)}</span> : key.error ? <span className="warning-text">{key.error}</span> : <span className="configured-text">Active</span>}{key.expiresAt && <span>Expires {certificateDate(key.expiresAt)} UTC</span>}</div>
      </li>)}</ul>
    </div></div>
    <div className="settings-row"><div className="settings-heading"><h2>Publishing tokens</h2><span className="scope-label">Service-wide / All applications</span></div><div className="credential-settings">
      <div className="credential-toolbar"><span className={publishing.configured ? "configured-text" : "warning-text"}>{publishing.configured ? "Publishing access configured" : "No active publishing token"}</span><Button size="sm" variant="secondary" onPress={() => setDialog({ type: "token" })}><Plus size={15} />Create token</Button></div>
      <div className="legacy-credential"><div><strong>Worker publishing key</strong><span className="scope-label">OTA_API_KEY {publishing.legacyConfigured ? "configured" : "not configured"}</span></div><Checkbox aria-label="Enable Worker publishing key" isSelected={publishing.legacyEnabled && publishing.legacyConfigured} isDisabled={!publishing.legacyConfigured} onChange={enabled => setDialog({ type: "legacy", enabled })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Enabled</Checkbox.Content></Checkbox></div>
      <ul className="credential-list" aria-label="Publishing tokens">{publishing.tokens.map(token => <li key={token.id} className={token.revoked_at ? "revoked-credential" : ""}><div className="credential-item-heading"><div className="credential-name"><KeyRound size={16} /><strong>{token.name}</strong></div>{!token.revoked_at && <IconButton label={`Revoke token ${token.name}`} onPress={() => setDialog({ type: "revoke-token", id: token.id, name: token.name })}><Trash2 size={15} /></IconButton>}</div><div className="credential-meta"><span className={token.revoked_at ? "muted" : "configured-text"}>{token.revoked_at ? `Revoked ${formatDate(token.revoked_at)}` : "Active"}</span><span>Created {formatDate(token.created_at)}</span></div><code className="token-id">{token.id}</code></li>)}</ul>
      {!publishing.tokens.length && <p className="muted credential-empty">No managed tokens</p>}
    </div></div>
    {dialog?.type === "import" && <ImportKeyDialog {...callbacks} />}
    {dialog?.type === "token" && <CreateTokenDialog {...callbacks} />}
    {dialog && dialog.type !== "import" && dialog.type !== "token" && <ChangeDialog {...callbacks} change={dialog} />}
  </>;
}

function ImportKeyDialog({ appId, credentials, onClose, onDone, onUnauthorized }: Context) {
  const request = useCredentialRequest(appId);
  const [material, setMaterial] = useState<{ keyId: string; certificate: string; privateKey: string; fingerprint: string; expiresAt: string } | null>(null);
  const [makeDefault, setMakeDefault] = useState(!credentials.signing.configured);
  const [confirmed, setConfirmed] = useState(false);
  return <FormDialog title="Import signing key" context={appId} command={material ? "Import key" : "Validate key"} icon={material ? <Upload size={16} /> : <ShieldCheck size={16} />} disabled={!!material && !confirmed} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async data => {
    if (!material) {
      const file = async (name: string) => { const value = data.get(name); if (!(value instanceof File) || !value.size || value.size > 16384) throw new Error("Choose a PEM file smaller than 16 KB for each field"); return value.text(); };
      const certificate = await file("certificate"); const privateKey = await file("privateKey");
      const keyId = String(data.get("keyId") || "").trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(keyId)) throw new Error("Invalid key ID");
      const validation = await request<{ fingerprint: string; expiresAt: string }>("signing/validate", { certificate, privateKey });
      setMaterial({ keyId, certificate, privateKey, ...validation }); return;
    }
    await request(`signing/keys/${encodeURIComponent(material.keyId)}`, { certificate: material.certificate, privateKey: material.privateKey, makeDefault, revision: credentials.signing.revision }, "PUT");
    setMaterial(null); onClose(); toast.success("Signing key imported"); await onDone();
  }}>
    {material ? <><dl className="credential-review"><dt>Key ID</dt><dd><code>{material.keyId}</code></dd><dt>SHA-256 public key</dt><dd><code>{material.fingerprint}</code></dd><dt>Certificate expires</dt><dd>{certificateDate(material.expiresAt)} UTC</dd></dl><Button size="sm" variant="secondary" onPress={() => { setMaterial(null); setConfirmed(false); }}>Choose different files</Button></> : <><Field name="keyId" label="Key ID" required autoFocus /><FileField name="certificate" label="Certificate (PEM)" accept=".pem,.crt,.cer" /><FileField name="privateKey" label="Private key (PEM)" accept=".pem,.key" /></>}
    <Checkbox isSelected={makeDefault} onChange={setMakeDefault}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Use as default signing key</Checkbox.Content></Checkbox>
    <p className="warning-message">Installed apps must trust this certificate and request the same key ID. A different certificate requires a new native build.</p>
    {material && <Confirm checked={confirmed} onChange={setConfirmed}>This key matches the certificate trusted by my app</Confirm>}
  </FormDialog>;
}

function CreateTokenDialog({ appId, credentials, onClose, onDone, onUnauthorized }: Context) {
  const request = useCredentialRequest(appId);
  const [token, setToken] = useState("");
  const finish = () => { onClose(); if (token) void onDone(); };
  return <FormDialog title={token ? "Publishing token created" : "Create publishing token"} context="Service-wide / All applications" command={token ? "Done" : "Create token"} icon={token ? <Check size={16} /> : <Plus size={16} />} onClose={finish} onUnauthorized={onUnauthorized} onSubmit={async data => {
    if (token) { finish(); return; }
    const result = await request<{ token: string }>("publishing/tokens", { name: String(data.get("name") || ""), revision: credentials.publishing.revision });
    setToken(result.token);
  }}>
    {token ? <><div className="one-time-token"><code>{token}</code><CopyButton value={token} label="Copy publishing token" /></div><p className="warning-message">This token will not be shown again. Store it in your CI secret manager.</p></> : <><Field name="name" label="Token name" required autoFocus /><p className="warning-message">This token can publish updates to every application on this service.</p></>}
  </FormDialog>;
}

function ChangeDialog({ appId, credentials, change, onClose, onDone, onUnauthorized }: Context & { change: Change }) {
  const request = useCredentialRequest(appId);
  const [confirmed, setConfirmed] = useState(false);
  const title = change.type === "default" ? "Change default signing key" : change.type === "revoke-key" ? "Revoke signing key" : change.type === "revoke-token" ? "Revoke publishing token" : `${change.enabled ? "Enable" : "Disable"} Worker publishing key`;
  const subject = "key" in change ? change.key.keyId : change.type === "revoke-token" ? change.name : "OTA_API_KEY";
  const warning = change.type === "default" ? "Clients without a requested key ID will use this key. Other active keys remain available." : change.type === "revoke-key" ? "Clients requesting this key will stop receiving updates. Revocation cannot be undone, and this key ID cannot be reused." : change.type === "revoke-token" ? "Publishing jobs using this token will lose access to all applications immediately." : change.enabled ? "The existing Worker secret will regain publishing access to all applications." : "Publishing jobs using OTA_API_KEY will lose access to all applications. Managed tokens and admin access remain active.";
  const command = change.type === "default" ? "Set default" : change.type === "legacy" ? (change.enabled ? "Enable key" : "Disable key") : change.type === "revoke-key" ? "Revoke key" : "Revoke token";
  return <FormDialog title={title} context={subject} command={command} danger={change.type.startsWith("revoke") || (change.type === "legacy" && !change.enabled)} disabled={!confirmed} onClose={onClose} onUnauthorized={onUnauthorized} onSubmit={async () => {
    const body = { revision: change.type === "default" || change.type === "revoke-key" ? credentials.signing.revision : credentials.publishing.revision, confirm: true };
    if (change.type === "default") await request("signing/default", { ...body, keyId: change.key.keyId }, "PUT");
    else if (change.type === "revoke-key") await request(`signing/keys/${encodeURIComponent(change.key.keyId)}/revoke`, body);
    else if (change.type === "revoke-token") await request(`publishing/tokens/${encodeURIComponent(change.id)}/revoke`, body);
    else await request("publishing/legacy", { ...body, enabled: change.enabled }, "PUT");
    onClose(); toast.success("Credentials updated"); await onDone();
  }}><p className="warning-message">{warning}</p><Confirm checked={confirmed} onChange={setConfirmed}>Confirm this credential change</Confirm></FormDialog>;
}
