export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toLocaleString("en-US", { maximumFractionDigits: unit ? 2 : 0 })} ${units[unit]}`;
}
