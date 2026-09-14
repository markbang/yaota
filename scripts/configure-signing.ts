import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { appId } from "../src/ota-apps.ts";

const { values } = parseArgs({ options: {
  "app-id": { type: "string" }, certificate: { type: "string" }, "private-key": { type: "string" },
  "key-id": { type: "string", default: "main" }, apply: { type: "boolean", default: false },
} });
if (!values.certificate || !values["private-key"]) throw new Error("Required: --app-id APP --certificate CLIENT_CERT_PATH --private-key PRIVATE_KEY_PATH [--apply]");
const id = appId(values["app-id"]);
const certificate = await readFile(values.certificate, "utf8");
const privateKey = await readFile(values["private-key"], "utf8");
const cert = new X509Certificate(certificate);
const key = createPrivateKey(privateKey);
if (key.asymmetricKeyType !== "rsa" || !cert.publicKey.equals(createPublicKey(key))) throw new Error("Private key does not match the client's trusted RSA certificate");
if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) throw new Error("Client certificate is not currently valid");
const path = new URL("../.secrets/signing-apps.json", import.meta.url);
await mkdir(new URL("../.secrets/", import.meta.url), { recursive: true, mode: 0o700 });
let apps: Record<string, Record<string, { privateKey: string }>> = {};
try { apps = JSON.parse(await readFile(path, "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
apps[id] = { ...apps[id], [values["key-id"]!]: { privateKey } };
await writeFile(path, JSON.stringify(apps, null, 2) + "\n", { mode: 0o600 });
await chmod(path, 0o600);
console.log(`Verified ${id}: certificate SHA256 ${cert.fingerprint256}, valid until ${cert.validTo}`);
if (values.apply) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", "CODE_SIGNING_APPS"], {
    cwd: new URL("../", import.meta.url), input: JSON.stringify(apps), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("Signing credential upload failed; run wrangler whoami and retry");
  console.log("Configured CODE_SIGNING_APPS on yaota from .secrets/signing-apps.json.");
}
