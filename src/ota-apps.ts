import { fail, text } from "./ota-protocol.ts";
import type { Env, OtaContext } from "./types.ts";

export function appId(value: unknown): string {
  const id = text(value, "app_id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) fail(400, "Invalid app_id");
  return id;
}

// App selection is request data, never mutable Worker environment state.
export function requestAppId(c: OtaContext, ...values: unknown[]): string {
  const ids = [...(c.req.queries("app_id") || []), c.req.header("expo-app-id"), ...values]
    .filter(value => value !== undefined && value !== null).map(appId);
  if (!ids.length) fail(400, "app_id is required");
  if (ids.some(id => id !== ids[0])) fail(400, "Conflicting app IDs");
  return ids[0];
}

export async function requireApp(env: Env, id: string) {
  if (!await env.DB.prepare("SELECT app_id FROM ota_apps WHERE app_id=?").bind(id).first()) fail(404, "Application not found; create it before publishing");
}
