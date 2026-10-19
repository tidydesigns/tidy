export function relativeThreadTime(updatedAt: string, now: number) {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return "";
  const minutes = Math.floor(Math.max(0, now - updated) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
