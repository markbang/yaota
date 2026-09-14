import { client, publishPatch } from "./publisher.ts";
import type { PublishedRelease } from "./publisher.ts";

const [baseId, targetId, appId] = process.argv.slice(2);
if (!baseId || !targetId || !appId || !process.env.OTA_SERVER || !process.env.OTA_API_KEY) throw new Error("Usage: OTA_SERVER=https://host OTA_API_KEY=... node scripts/publish-delta.ts BASE_ID TARGET_ID APP_ID");
const request = client(process.env.OTA_SERVER, process.env.OTA_API_KEY);
const { releases } = await (await request(`/ota-publish/releases?app_id=${encodeURIComponent(appId)}`)).json() as { releases: PublishedRelease[] };
const base = releases.find(item => item.id === baseId);
const target = releases.find(item => item.id === targetId);
if (!base || !target) throw new Error("Both releases must be registered");
console.log(JSON.stringify(await publishPatch(request, base, target)));
