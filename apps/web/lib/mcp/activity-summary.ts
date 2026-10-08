import type { ActivityDetails } from "@/lib/realtime/agent-activity";

export function safeActivityText(value: unknown, limit: number): string | undefined {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit)
    : undefined;
}
export function activityPath(value: unknown, limit = 96): string | undefined {
  if (typeof value !== "string") return;
  const path = value.split(/[?#]/)[0];
  if (/^[\\/]|^[a-z]+:|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(path)) return;
  return safeActivityText(path, limit);
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Operates on already accepted chunks. Identical chunk retries cannot inflate counts. */
export function summarizeImportChunks(chunks: Record<string, unknown>): ActivityDetails {
  const nodes: Record<string, unknown>[] = [],
    paths = new Set<string>(),
    assets = new Set<string>();
  let source: Record<string, unknown> = {},
    warningCount = 0;
  for (const [, chunkValue] of Object.entries(chunks).sort(([a], [b]) => a.localeCompare(b))) {
    const chunk = record(chunkValue);
    if (!Object.keys(source).length && chunk.source) source = record(chunk.source);
    if (Array.isArray(chunk.warnings)) warningCount += chunk.warnings.length;
    for (const value of Array.isArray(chunk.nodes) ? chunk.nodes : []) {
      const node = record(value);
      nodes.push(node);
      const path = activityPath(node.sourcePath);
      if (path && paths.size < 3) paths.add(path);
      if (typeof node.assetId === "string") assets.add(node.assetId);
      const paints = record(node.style).paints;
      for (const paint of Array.isArray(paints) ? paints : [])
        if (typeof record(paint).assetId === "string") assets.add(record(paint).assetId as string);
    }
  }
  return {
    nodeCount: nodes.length,
    assetCount: assets.size,
    warningCount,
    sourcePaths: [...paths],
    sourceProject: safeActivityText(source.project, 80),
    sourceRoute: safeActivityText(
      typeof source.route === "string" ? source.route.split(/[?#]/)[0] : undefined,
      160,
    ),
    nodeIds: nodes
      .filter((node) => node.parentId === null && typeof node.id === "string")
      .slice(0, 3)
      .map((node) => node.id as string),
  };
}
