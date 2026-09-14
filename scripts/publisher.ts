import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createVerifiedPatch } from "./delta.ts";
import type { Manifest, Extensions, StringMap, ExpoConfig } from "../src/types.ts";

export interface PublishedRelease {
  id: string; appId: string; branch: string; channel: string; platform: string; runtimeVersion: string;
  fingerprint: string | null; status: string; createdAt: string; manifest: Manifest; extensions?: Extensions;
}
export interface PublisherOptions {
  server: string; apiKey: string; exportDir: string; expoConfig: ExpoConfig;
  platform: string; runtimeVersion: string; channel: string; branch?: string; fingerprint?: string;
  rollout?: number; targets?: StringMap; extensions?: Extensions; embeddedId?: string; deltaBases?: number;
  staged?: boolean; commitHash?: string;
}
export function client(server: string, apiKey: string, fetcher: typeof fetch = fetch) {
  const origin = new URL(server);
  if (origin.username || origin.password || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) throw new Error("OTA_SERVER must be an HTTPS origin");
  return async (path: string, options: RequestInit = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new Error("Refusing to send publisher credentials to another origin");
    const response = await fetcher(url, { ...options, redirect: "error", headers: { ...Object.fromEntries(new Headers(options.headers)), "x-ota-api-key": apiKey } });
    if (!response.ok) throw new Error(`OTA ${response.status}: ${await response.text()}`);
    return response;
  };
}
type Client = ReturnType<typeof client>;
export async function publishPatch(request: Client, base: PublishedRelease, target: PublishedRelease) {
  if ((["appId", "platform", "runtimeVersion", "fingerprint"] as const).some(k => base[k] !== target[k]) || (base.status !== "Embedded" && base.branch !== target.branch)) throw new Error("Patch scope mismatch");
  const download = async (release: PublishedRelease) => {
    const asset = release.manifest.launchAsset;
    if (!asset.url) throw new Error("Missing bundle URL");
    const response = await request(asset.url, { headers: { ...release.extensions?.assetRequestHeaders?.[asset.key], "accept-encoding": "identity" } });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("base64url") !== asset.hash) throw new Error("Bundle integrity mismatch");
    return bytes;
  };
  if (base.manifest.launchAsset.hash === target.manifest.launchAsset.hash) return { base: base.id, size: 0, skipped: true };
  const targetBytes = await download(target);
  const patch = await createVerifiedPatch(await download(base), targetBytes);
  if (patch.byteLength >= targetBytes.byteLength) return { base: base.id, size: patch.byteLength, skipped: true };
  await request(`/ota-patches/${base.id}/${target.id}`, { method: "PUT", body: patch });
  return { base: base.id, size: patch.byteLength, skipped: false };
}
export async function publishExport(options: PublisherOptions, fetcher: typeof fetch = fetch) {
  const limit = options.deltaBases ?? 3;
  if (!Number.isInteger(limit) || limit < 0 || limit > 20) throw new Error("deltaBases must be 0-20");
  const request = client(options.server, options.apiKey, fetcher);
  const root = await realpath(options.exportDir);
  async function file(path: string) {
    const resolved = await realpath(resolve(root, path));
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Export path escapes the export directory");
    return readFile(resolved);
  }
  const metadata = JSON.parse((await file("metadata.json")).toString()) as { fileMetadata: Record<string, { bundle: string; assets: { path: string; ext?: string }[] }> };
  const platform = metadata.fileMetadata?.[options.platform];
  if (!platform?.bundle || !Array.isArray(platform.assets)) throw new Error("Export metadata is missing the selected platform");
  const blobs = new Map<string, Buffer>();
  async function descriptor(path: string, ext?: string) {
    const bytes = await file(path);
    const hash = createHash("sha256").update(bytes).digest("base64url");
    blobs.set(hash, bytes);
    return { hash, ...(ext ? { fileExtension: `.${ext.replace(/^\./, "")}` } : {}) };
  }
  const launchAsset = await descriptor(platform.bundle);
  const assets = [];
  for (const asset of platform.assets) assets.push(await descriptor(asset.path, asset.ext));
  const { missing } = await (await request("/ota-publish/missing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: [...blobs.keys()] }) })).json() as { missing: string[] };
  for (const hash of missing) {
    const bytes = blobs.get(hash);
    if (!bytes) throw new Error("Server requested an unknown blob");
    await request(`/ota-publish/blobs/${hash}`, { method: "PUT", body: new Uint8Array(bytes) });
  }
  const release = await (await request("/ota-publish/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    ...options, server: undefined, apiKey: undefined, exportDir: undefined, deltaBases: undefined,
    launchAsset, assets, staged: !options.embeddedId, embedded: !!options.embeddedId, id: options.embeddedId,
  }) })).json() as PublishedRelease;
  const patches = [];
  if (!options.embeddedId) {
    const { releases } = await (await request("/ota-publish/releases")).json() as { releases: PublishedRelease[] };
    const candidates = releases.filter(base => base.id !== release.id && base.status !== "Staged"
      && (["appId", "platform", "runtimeVersion", "fingerprint"] as const).every(k => base[k] === release[k])
      && (base.branch === release.branch || base.status === "Embedded"));
    const bases = [...candidates.filter(b => b.status === "Embedded"), ...candidates.filter(b => b.status !== "Embedded")].slice(0, limit);
    // Keep the release staged until every requested patch has been verified and stored.
    for (const base of bases) patches.push(await publishPatch(request, base, release));
    if (!options.staged) await request(`/ota-publish/releases/${release.id}/activate`, { method: "POST" });
  }
  return { id: release.id, uploadedBlobs: missing.length, reusedBlobs: blobs.size - missing.length, patches, status: options.embeddedId ? "Embedded" : options.staged ? "Staged" : "Live" };
}
