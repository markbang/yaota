import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const path = new URL("../.secrets/publisher.json", import.meta.url);
await mkdir(new URL("../.secrets/", import.meta.url), { recursive: true, mode: 0o700 });
let value: { OTA_API_KEY: string };
try { value = JSON.parse(await readFile(path, "utf8")); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  value = { OTA_API_KEY: randomBytes(32).toString("base64url") };
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
if (!/^[A-Za-z0-9_-]{43}$/.test(value.OTA_API_KEY)) throw new Error("Invalid local publishing credential");
await chmod(path, 0o600);
if (process.argv.includes("--apply")) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", "OTA_API_KEY"], {
    cwd: new URL("../", import.meta.url), input: value.OTA_API_KEY, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("Publishing credential upload failed; run wrangler whoami and retry");
  console.log("Configured OTA_API_KEY on yaota. No other credentials were changed.");
}
console.log("Publishing credential: .secrets/publisher.json (owner-only, gitignored).");
