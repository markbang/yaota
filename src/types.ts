import type { Context } from "hono";
import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";

export type JsonObject = { [key: string]: unknown };
export type StringMap = Record<string, string>;
export interface Env {
  DB: D1Database;
  ASSETS_R2: R2Bucket;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  OTA_API_KEY?: string;
  YAOTA_ADMIN_TOKEN?: string;
  OTA_REQUIRE_FINGERPRINT?: string;
  CODE_SIGNING_PRIVATE_KEY?: string;
  CODE_SIGNING_KEY_ID?: string;
  CODE_SIGNING_KEYS?: string;
  CODE_SIGNING_APPS?: string;
  CODE_SIGNING_CERTIFICATE_CHAIN?: string;
  CREDENTIALS_ENCRYPTION_KEY?: string;
}
export type OtaContext = Context<{ Bindings: Env }>;
export interface Asset { key: string; hash: string; contentType: string; fileExtension?: string; url?: string }
export interface ExpoConfig {
  version?: string;
  updates?: { requestHeaders?: StringMap };
  [key: string]: unknown;
}
export interface Manifest {
  id: string; createdAt: string; runtimeVersion: string; launchAsset: Asset; assets: Asset[];
  metadata: StringMap; extra: { expoClient: ExpoConfig; channel: string };
}
export interface Extensions { assetRequestHeaders?: Record<string, StringMap> }
export interface ReleaseRow {
  id: string; app_id: string; channel: string; branch: string; platform: string; runtime_version: string;
  version: string; fingerprint: string | null; status: string; rollout: number; created_at: string; note: string;
  launch_asset_url: string | null; assets_json: string; manifest_json: string | null; directive_json: string | null;
  targets_json: string; extensions_json: string; source_id: string | null; revision: number;
}
export interface ChannelRow {
  app_id: string; name: string; branch: string; rollout_branch: string | null; percentage: number;
  seed: string; headers_json: string; revision: number;
}
export interface BlobRow { hash: string; asset_key: string; size: number }
export interface ReleaseDelivery {
  bundleBytes: number | null; assetBytes: number | null; totalBytes: number | null;
  assetCount: number; uniqueAssetCount: number;
  previousUpdateId: string | null; reusedAssetCount: number; reusedAssetBytes: number | null;
  patches: { baseId: string; baseVersion: string; baseStatus: string; bytes: number; savingsPercent: number | null }[];
}
export interface ApkRow {
  key: string; app_id: string | null; version: string; arch: string; size: string;
  size_bytes: number | null; source_url: string | null; created_at: string; status: string; downloads: number; sha256: string;
}
export interface Publication {
  appId: string; channel: string; branch: string; platform: string; runtime: string; fingerprint: string | null;
  config: ExpoConfig; targets: StringMap; extensions: Extensions; rollout: number; status: string; id?: string; note: string;
}
export interface PublishOptions {
  before?: D1PreparedStatement[]; directive?: { type: string; parameters?: JsonObject };
  sourceId?: string; action?: string;
}
