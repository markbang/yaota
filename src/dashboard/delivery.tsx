import type { Release } from "./api.ts";
import { formatBytes } from "./format.ts";

export function DeliveryDetails({ release }: { release: Release }) {
  const delivery = release.delivery;
  if (!release.manifest) return null;
  return <section className="delivery-details" aria-label="Update size and patches"><h3>Payload size</h3><dl className="detail-grid">
    <div><dt>Bundle (uncompressed)</dt><dd className="mono">{formatBytes(delivery?.bundleBytes)}</dd></div>
    <div><dt>Assets ({delivery?.uniqueAssetCount ?? release.manifest.assets.length} unique)</dt><dd className="mono">{formatBytes(delivery?.assetBytes)}</dd></div>
    <div><dt>Total payload</dt><dd className="mono">{formatBytes(delivery?.totalBytes)}</dd></div>
    <div><dt>Reusable assets vs previous</dt><dd className="mono">{delivery?.previousUpdateId ? `${formatBytes(delivery.reusedAssetBytes)} (${delivery.reusedAssetCount})` : "No baseline"}</dd></div>
  </dl>{delivery?.previousUpdateId && <div className="baseline-value"><span>Previous update</span><code>{delivery.previousUpdateId}</code></div>}
    <h3>Binary patches <span className="muted">BSDIFF</span></h3>
    {delivery?.patches.length ? <div className="patch-list">{delivery.patches.map(patch => <div className="patch-row" key={patch.baseId}><div className="cell-stack"><strong>From {patch.baseVersion || patch.baseId.slice(0, 8)}</strong><code title={patch.baseId}>{patch.baseId.slice(0, 8)} / {patch.baseStatus}</code></div><div className="cell-stack"><span className="mono">{formatBytes(patch.bytes)}</span><small className="savings-text">{patch.savingsPercent === null ? "Unknown savings" : `${patch.savingsPercent}% smaller`}</small></div></div>)}</div> : <p className="muted">No binary patches recorded</p>}
  </section>;
}
