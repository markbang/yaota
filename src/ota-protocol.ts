import { createHash, sign, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { parseDictionary, parseList, serializeDictionary } from "structured-headers";
import Negotiator from "negotiator";
import type { OtaContext, JsonObject, StringMap } from "./types.ts";
import { managedPublisher, publishingSettings, signingKey } from "./ota-credentials.ts";
export { signingKey } from "./ota-credentials.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Dictionary } from "structured-headers";

export function fail(status: ContentfulStatusCode, message: string): never { throw new HTTPException(status, { message }); }
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail(400, `Invalid ${name}`);
  return value.trim();
}
export function object(value: unknown, name: string): JsonObject {
  try {
    const result = typeof value === "string" ? JSON.parse(value) : value;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch { fail(400, `Invalid ${name}`); }
}
export function strings(value: unknown, name: string): StringMap {
  const result = object(value, name);
  if (Object.keys(result).length > 30 || Object.entries(result).some(([k, v]) => !/^[a-z][a-z0-9_-]*$/.test(k) || typeof v !== "string" || v.length > 256 || /[^\x20-\x7e]/.test(v))) fail(400, `Invalid ${name}`);
  return result as StringMap;
}
export function authorized(given: string | undefined, expected: string | undefined) {
  return !!given && !!expected && timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}
export async function publisher(c: OtaContext) {
  const given = c.req.header("x-ota-api-key");
  if (!given || given.length > 1024) fail(401, "Unauthorized");
  if (!c.env.DB) fail(503, "D1 binding is required");
  const settings = await publishingSettings(c.env);
  if (settings.legacy_enabled && authorized(given, c.env.OTA_API_KEY)) return;
  if (!await managedPublisher(c.env, given)) fail(401, "Unauthorized");
}
export function admin(c: OtaContext) {
  if (!authorized(c.req.header("authorization"), c.env.YAOTA_ADMIN_TOKEN && `Bearer ${c.env.YAOTA_ADMIN_TOKEN}`)) fail(401, "Unauthorized");
}
export function dictionary(header: string | undefined): Dictionary {
  try { return parseDictionary(header || ""); } catch { fail(400, "Invalid structured dictionary header"); }
}
export function failedIds(header: string | undefined): string[] {
  try {
    if ((header || "").length > 4096) fail(400, "Too many failed updates");
    return parseList(header || "").map(([v]) => {
      if (typeof v !== "string" || !/^[a-f0-9-]{36}$/i.test(v)) fail(400, "Invalid failed update ID");
      return v.toLowerCase();
    }).slice(0, 20);
  } catch { fail(400, "Invalid failed updates header"); }
}
export const sfv = (values: StringMap) => serializeDictionary(new Map(Object.entries(values).map(([k, v]) => [k, [v, new Map()]])));
export const bucket = (seed: string, client: string) => createHash("sha256").update(`${seed}:${client}`).digest().readUInt32BE(0) / 4294967296 * 100;

export async function otaResponse(c: OtaContext, content: unknown, field: string, { filters = {}, headers = {}, extensions = {}, appId }: { filters?: StringMap; headers?: StringMap; extensions?: object; appId?: string } = {}) {
  const signer = await signingKey(c.env, dictionary(c.req.header("expo-expect-signature")), appId);
  const multipartOnly = field !== "manifest" || Object.keys(extensions).length || signer.chain;
  const type = new Negotiator({ headers: { accept: c.req.header("accept") || "*/*" } })
    .mediaType(multipartOnly ? ["multipart/mixed"] : ["multipart/mixed", "application/expo+json", "application/json"]);
  if (!type) fail(406, "No acceptable OTA response format");
  const bytes = JSON.stringify(content);
  const signature = sfv({ sig: sign("RSA-SHA256", Buffer.from(bytes), signer.key).toString("base64"), keyid: signer.keyid });
  const common = { "expo-protocol-version": "1", "expo-sfv-version": "0", "expo-manifest-filters": sfv(filters), "expo-server-defined-headers": sfv(headers), "cache-control": "private, no-store", vary: "Accept, Expo-Expect-Signature" };
  if (type !== "multipart/mixed") return new Response(bytes, { headers: { ...common, "content-type": type, "expo-signature": signature } });
  const boundary = `Yaota-${crypto.randomUUID()}`;
  const part = (name: string, value: string, type = "application/json", signatureHeader = "") => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: ${type}\r\n${signatureHeader}\r\n${value}\r\n`;
  let body = part(field, bytes, "application/json", `expo-signature: ${signature}\r\n`);
  if (Object.keys(extensions).length) body += part("extensions", JSON.stringify(extensions));
  if (signer.chain) body += part("certificate_chain", signer.chain, "application/x-pem-file");
  return new Response(body + `--${boundary}--\r\n`, { headers: { ...common, "content-type": `multipart/mixed; boundary=${boundary}` } });
}
