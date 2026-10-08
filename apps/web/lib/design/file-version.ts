export function fileVersion(updatedAt: Date | string, revision: number | null | undefined) {
  return `${revision ?? "legacy"}:${new Date(updatedAt).toISOString()}`;
}

export function fileVersionAtLeast(current: string, requested: string) {
  if (current === requested) return true;
  if (!current) return false;
  const currentSplit = current.indexOf(":"),
    requestedSplit = requested.indexOf(":");
  const revision = current.slice(0, currentSplit),
    target = requested.slice(0, requestedSplit);
  if (revision !== "legacy" && target !== "legacy" && Number(revision) !== Number(target))
    return Number(revision) > Number(target);
  return (
    Date.parse(current.slice(currentSplit + 1)) >= Date.parse(requested.slice(requestedSplit + 1))
  );
}
