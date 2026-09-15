import type { ApkRow, BlobRow, ChannelRow, Env, Manifest, ReleaseDelivery, ReleaseRow } from "./types.ts";
import { branchOf, publicRelease } from "./ota-store.ts";

export function visibleChannels(appId: string, channels: ChannelRow[], releases: ReleaseRow[]) {
  const rows = channels.map(row => ({ ...row, headers: JSON.parse(row.headers_json), implicit: false }));
  const names = new Set(rows.map(row => row.name));
  for (const release of releases) {
    for (const name of [release.channel, branchOf(release)]) {
      if (names.has(name)) continue;
      names.add(name);
      rows.push({ app_id: appId, name, branch: name, rollout_branch: null, percentage: 0,
        seed: "", headers_json: "{}", headers: {}, revision: -1, implicit: true });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function releasesWithDelivery(env: Env, appId: string, rows: ReleaseRow[]) {
  const { results: blobs } = await env.DB.prepare(`SELECT b.* FROM ota_blobs b WHERE b.hash IN (
    SELECT json_extract(manifest_json,'$.launchAsset.hash') FROM releases WHERE app_id=? AND manifest_json IS NOT NULL
    UNION SELECT json_extract(a.value,'$.hash') FROM releases r, json_each(r.manifest_json,'$.assets') a WHERE r.app_id=?
  )`).bind(appId, appId).all<BlobRow>();
  const { results: patches } = await env.DB.prepare(`SELECT p.* FROM ota_patches p WHERE target_hash IN (
    SELECT json_extract(manifest_json,'$.launchAsset.hash') FROM releases WHERE app_id=? AND manifest_json IS NOT NULL
  )`).bind(appId).all<{ base_hash: string; target_hash: string; size: number }>();
  const sizes = new Map(blobs.map(blob => [blob.hash, blob.size]));
  const manifests = new Map(rows.filter(row => row.manifest_json).map(row => [row.id, JSON.parse(row.manifest_json!) as Manifest]));
  const sum = (hashes: Set<string>) => [...hashes].every(hash => sizes.has(hash)) ? [...hashes].reduce((n, hash) => n + sizes.get(hash)!, 0) : null;
  const patchSizes = new Map(patches.map(patch => [`${patch.base_hash}/${patch.target_hash}`, patch.size]));
  return rows.map((row, index) => {
    const manifest = manifests.get(row.id);
    let delivery: ReleaseDelivery | null = null;
    if (manifest) {
      const hashes = new Set(manifest.assets.map(asset => asset.hash));
      const compatible = (base: ReleaseRow) => base.platform === row.platform && base.runtime_version === row.runtime_version
        && base.fingerprint === row.fingerprint && (branchOf(base) === branchOf(row) || base.status === "Embedded") && manifests.has(base.id);
      const previous = rows.slice(index + 1).find(base => compatible(base) && base.status !== "Staged" && branchOf(base) === branchOf(row));
      const oldHashes = new Set(previous ? manifests.get(previous.id)!.assets.map(asset => asset.hash) : []);
      const reused = new Set([...hashes].filter(hash => oldHashes.has(hash)));
      const bundleBytes = sizes.get(manifest.launchAsset.hash) ?? null;
      delivery = { bundleBytes, assetBytes: sum(hashes), totalBytes: sum(new Set([manifest.launchAsset.hash, ...hashes])),
        assetCount: manifest.assets.length, uniqueAssetCount: hashes.size, previousUpdateId: previous?.id ?? null,
        reusedAssetCount: reused.size, reusedAssetBytes: previous ? sum(reused) : null,
        patches: rows.filter(base => base.id !== row.id && compatible(base)).flatMap(base => {
          const bytes = patchSizes.get(`${manifests.get(base.id)!.launchAsset.hash}/${manifest.launchAsset.hash}`);
          return bytes === undefined ? [] : [{ baseId: base.id, baseVersion: base.version, baseStatus: base.status, bytes,
            savingsPercent: bundleBytes ? Math.round((1 - bytes / bundleBytes) * 1000) / 10 : null }];
        }).sort((a, b) => a.bytes - b.bytes),
      };
    }
    return { ...publicRelease(row), delivery };
  });
}

export async function listAppApks(env: Env, appId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM apks WHERE app_id=? ORDER BY created_at DESC, key").bind(appId).all<ApkRow>();
  return Promise.all(results.map(async row => {
    const stored = !row.source_url && row.size_bytes === null ? await env.ASSETS_R2?.head(row.key) : null;
    return { key: row.key, appId: row.app_id!, version: row.version, arch: row.arch,
      sizeBytes: row.size_bytes ?? stored?.size ?? null, createdAt: row.created_at,
      status: !row.source_url && row.size_bytes === null && !stored ? "Pending" : row.status,
      sha256: row.sha256, downloads: row.downloads,
      source: row.source_url ? "GitHub" : "R2", downloadUrl: row.source_url || `/${row.key.split("/").map(encodeURIComponent).join("/")}` };
  }));
}
