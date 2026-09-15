import type { ExpoConfig } from "../types.ts";

export async function exportUpload(data: FormData, appId: string): Promise<FormData> {
  const files = data.getAll("directory").filter((file): file is File => file instanceof File && !!file.name);
  const path = (file: File) => file.webkitRelativePath.split("/").slice(1).join("/");
  const metadataFile = files.find(file => path(file) === "metadata.json");
  if (!metadataFile) throw new Error("metadata.json is missing from the export directory");
  const configFile = data.get("config");
  if (!(configFile instanceof File) || !configFile.size) throw new Error("Expo public config is required");
  const configText = await configFile.text();
  const config = JSON.parse(configText) as ExpoConfig;
  const configApp = config.updates?.requestHeaders?.["expo-app-id"];
  if (configApp && configApp !== appId) throw new Error("Expo config does not match the selected application");
  const metadataText = await metadataFile.text();
  const metadata = JSON.parse(metadataText) as { fileMetadata?: Record<string, { bundle: string; assets: { path: string }[] }> };
  const platform = metadata.fileMetadata?.[String(data.get("platform"))];
  if (!platform || !Array.isArray(platform.assets)) throw new Error("Selected platform is missing from the export");
  const bundle = files.find(file => path(file) === platform.bundle);
  if (!bundle) throw new Error("Bundle is missing from the export");
  const upload = new FormData();
  for (const key of ["channel", "branch", "runtimeVersion", "fingerprint", "rollout", "targets", "platform"]) upload.set(key, String(data.get(key) || ""));
  upload.set("staged", data.has("staged") ? "true" : "false");
  upload.set("metadata", metadataText); upload.set("expoConfig", configText);
  upload.set("bundle", bundle, bundle.name); upload.set("app_id", appId);
  platform.assets.forEach((asset, index) => {
    const file = files.find(file => path(file) === asset.path);
    if (!file) throw new Error(`Missing asset: ${asset.path}`);
    upload.set(`asset-${index}`, file, file.name);
  });
  return upload;
}
