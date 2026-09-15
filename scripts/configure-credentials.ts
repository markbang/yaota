import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const path = new URL("../.secrets/credentials-encryption.json", import.meta.url);
const apply = process.argv.includes("--apply");
function wrangler(args: string[], input?: string) {
  const result = spawnSync("npx", ["wrangler", ...args, "--config", "wrangler.jsonc"], {
    cwd: new URL("../", import.meta.url), input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("Cloudflare credential setup failed; verify Wrangler login and the credentials migration");
  return result.stdout;
}
if (apply) {
  const secrets = JSON.parse(wrangler(["secret", "list"])) as { name: string }[];
  if (secrets.some(secret => secret.name === "CREDENTIALS_ENCRYPTION_KEY")) {
    console.log("CREDENTIALS_ENCRYPTION_KEY already exists. Left unchanged; no credentials were overwritten.");
    process.exit(0);
  }
  const result = JSON.parse(wrangler(["d1", "execute", "cohub-ota-updates", "--remote", "--json", "--command", "SELECT COUNT(*) AS count FROM ota_signing_keys WHERE encrypted_private_key IS NOT NULL"])) as { results: { count: number }[] }[];
  if (result[0]?.results[0]?.count !== 0) throw new Error("Encrypted signing keys exist. Restore the original encryption secret; refusing to generate a replacement");
}
await mkdir(new URL("../.secrets/", import.meta.url), { recursive: true, mode: 0o700 });
let value: { CREDENTIALS_ENCRYPTION_KEY: string };
try { value = JSON.parse(await readFile(path, "utf8")); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  value = { CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64url") };
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
if (!/^[A-Za-z0-9_-]{43}$/.test(value.CREDENTIALS_ENCRYPTION_KEY)) throw new Error("Invalid local encryption credential");
await chmod(path, 0o600);
if (apply) {
  wrangler(["secret", "put", "CREDENTIALS_ENCRYPTION_KEY"], value.CREDENTIALS_ENCRYPTION_KEY);
  console.log("Initialized CREDENTIALS_ENCRYPTION_KEY. Existing publishing and signing secrets were not changed.");
}
console.log("Encryption key backup: .secrets/credentials-encryption.json (owner-only, gitignored). Back it up in a secret manager; replacing it makes existing managed signing keys unreadable.");
