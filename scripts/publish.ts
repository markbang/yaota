import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { publishExport } from "./publisher.ts";

const { values } = parseArgs({ options: {
  "export-dir": { type: "string" }, config: { type: "string" }, platform: { type: "string" },
  runtime: { type: "string" }, fingerprint: { type: "string" }, channel: { type: "string", default: "production" },
  branch: { type: "string" }, rollout: { type: "string", default: "100" }, "delta-bases": { type: "string", default: "3" },
  targets: { type: "string", default: "{}" }, extensions: { type: "string", default: "{}" },
  "embedded-id": { type: "string" }, staged: { type: "boolean", default: false }, commit: { type: "string" },
} });
if (!values["export-dir"] || !values.config || !values.platform || !values.runtime || !process.env.OTA_SERVER || !process.env.OTA_API_KEY) throw new Error("Required: OTA_SERVER, OTA_API_KEY, --export-dir, --config, --platform, --runtime");
const result = await publishExport({ server: process.env.OTA_SERVER, apiKey: process.env.OTA_API_KEY,
  exportDir: values["export-dir"], expoConfig: JSON.parse(await readFile(values.config, "utf8")),
  platform: values.platform, runtimeVersion: values.runtime, fingerprint: values.fingerprint,
  channel: values.channel!, branch: values.branch, rollout: Number(values.rollout), deltaBases: Number(values["delta-bases"]),
  targets: JSON.parse(values.targets!), extensions: JSON.parse(values.extensions!), embeddedId: values["embedded-id"], staged: values.staged, commitHash: values.commit,
});
console.log(JSON.stringify(result));
