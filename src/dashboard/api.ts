import type { publicRelease } from "../ota-store.ts";
import type { ChannelRow, ReleaseDelivery, StringMap } from "../types.ts";
import type { listAppApks } from "../ota-artifacts.ts";
import type { CredentialsState } from "../ota-credentials.ts";

export type Release = ReturnType<typeof publicRelease> & { delivery?: ReleaseDelivery | null };
export type Channel = ChannelRow & { headers: StringMap; implicit?: boolean };
export type Apk = Awaited<ReturnType<typeof listAppApks>>[number];
export interface AppEntry { app_id: string; created_at: string }
export interface DashboardState {
  appId: string;
  releases: Release[];
  channels: Channel[];
  apks: Apk[];
  configuration?: { publishing: boolean; signing: boolean; signingError: string | null };
  credentials: CredentialsState;
  failures: { release_id: string; clients: number; last_seen: string }[];
  events: { action: string; subject: string; created_at: string }[];
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Request failed";
export const appPath = (path: string, appId: string) => `${path}?app_id=${encodeURIComponent(appId)}`;
export async function api<T>(path: string, options: RequestInit = {}, token = sessionStorage.getItem("yaota_admin_token")): Promise<T> {
  const headers = new Headers(options.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(result.error || `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}
