import { z } from "zod";

export const activityPhaseSchema = z.enum([
  "reading",
  "editing",
  "receiving",
  "staged",
  "validating",
  "publishing",
  "published",
  "completed",
  "failed",
  "aborted",
  "unavailable",
]);
export type ActivityPhase = z.infer<typeof activityPhaseSchema>;
const identifier = z.string().min(1).max(120);
export const agentActivitySchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().nonnegative(),
    fileId: identifier,
    threadId: z.uuid().optional(),
    agentId: z.uuid().optional(),
    ownerName: z.string().max(80).optional(),
    actorId: z.string().min(1).max(64),
    actorName: z.string().min(1).max(80),
    tool: z.string().min(1).max(60),
    phase: activityPhaseSchema,
    importId: z.uuid().optional(),
    nodeIds: z.array(identifier).max(3).optional(),
    sourceProject: z.string().max(80).optional(),
    sourceRoute: z.string().max(160).optional(),
    sourcePaths: z.array(z.string().max(96)).max(3).optional(),
    nodeCount: z.number().int().min(0).max(5000).optional(),
    assetCount: z.number().int().min(0).max(5000).optional(),
    warningCount: z.number().int().min(0).max(10000).optional(),
    issueCount: z.number().int().min(0).max(10000).optional(),
    revision: z.number().int().positive().optional(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2048,
    "Activity exceeds 2 KB.",
  );
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type ActivityDetails = Partial<
  Pick<
    AgentActivity,
    | "nodeIds"
    | "sourceProject"
    | "sourceRoute"
    | "sourcePaths"
    | "nodeCount"
    | "assetCount"
    | "warningCount"
    | "issueCount"
    | "revision"
  >
>;
export type ActivityObserver = (phase: ActivityPhase, details?: ActivityDetails) => Promise<void>;
export type ActivityCheckpoint = {
  items: AgentActivity[];
  versions: [string, { version: number; until: number }][];
  closedImports: [string, number][];
};
export const activityLabels: Record<ActivityPhase, string> = {
  reading: "Reading file",
  editing: "Updating layers",
  receiving: "Receiving content",
  staged: "Layers staged",
  validating: "Checking layout",
  publishing: "Publishing",
  published: "Published",
  completed: "Finished",
  failed: "Call failed",
  aborted: "Import discarded",
  unavailable: "Activity unavailable",
};
export function activityWorking(activity: AgentActivity) {
  return ["reading", "editing", "receiving", "validating", "publishing"].includes(activity.phase);
}
export function activityTerminal(activity: AgentActivity) {
  return !activityWorking(activity) && activity.phase !== "staged";
}
export function activityVisible(activity: AgentActivity, now = Date.now()) {
  return (
    activity.expiresAt > now && (!activityTerminal(activity) || activity.updatedAt + 6000 > now)
  );
}

/** Both the room and the browser use the same bounded, ordered activity ledger. */
export class AgentActivityStore {
  private items: AgentActivity[] = [];
  private versions = new Map<string, { version: number; until: number }>();
  private closedImports = new Map<string, number>();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.items;
  getServerSnapshot = () => EMPTY;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    for (const listener of this.listeners) listener();
  }
  update(input: AgentActivity, now = Date.now()) {
    const parsed = agentActivitySchema.safeParse(input);
    if (
      !parsed.success ||
      input.expiresAt <= now ||
      (this.versions.get(input.id)?.version ?? -1) >= input.version
    )
      return;
    const importKey = input.importId ? `${input.actorId}:${input.importId}` : undefined;
    if (importKey && (this.closedImports.get(importKey) ?? 0) > now && !activityTerminal(input))
      return;
    const previous = input.importId
      ? this.items.find(
          (item) => item.importId === input.importId && item.actorId === input.actorId,
        )
      : undefined;
    const merged =
      previous &&
      agentActivitySchema.safeParse({
        ...previous,
        ...Object.fromEntries(
          Object.entries(parsed.data).filter(([, value]) => value !== undefined),
        ),
      });
    const item = merged && merged.success ? merged.data : parsed.data;
    this.versions.set(item.id, {
      version: item.version,
      until: Math.max(now + 60_000, item.expiresAt),
    });
    const closesImport = item.importId && ["published", "aborted"].includes(item.phase);
    if (closesImport) this.closedImports.set(importKey!, now + 65_000);
    const all = [
      item,
      ...this.items.filter(
        (previous) =>
          previous.id !== item.id &&
          !(item.agentId && previous.agentId === item.agentId) &&
          previous.expiresAt > now &&
          !(
            closesImport &&
            previous.importId === item.importId &&
            previous.actorId === item.actorId
          ),
      ),
    ].sort((a, b) => b.updatedAt - a.updatedAt || b.version - a.version);
    // Keep the worst-case checkpoint below the room storage value limit while
    // retaining every active agent under the organisation cap.
    this.items = [
      ...all.filter((entry) => !activityTerminal(entry)).slice(0, 36),
      ...all.filter(activityTerminal).slice(0, 12),
    ];
    while (this.versions.size > 100) this.versions.delete(this.versions.keys().next().value!);
    while (this.closedImports.size > 100)
      this.closedImports.delete(this.closedImports.keys().next().value!);
    this.notify();
  }
  replace(items: AgentActivity[]) {
    this.items = [];
    this.versions.clear();
    this.closedImports.clear();
    for (const item of items.slice(0, 48).reverse()) this.update(item);
    this.notify();
  }
  checkpoint(): ActivityCheckpoint {
    return {
      items: this.items,
      versions: [...this.versions],
      closedImports: [...this.closedImports],
    };
  }
  restore(checkpoint: ActivityCheckpoint) {
    this.replace(checkpoint.items);
    this.versions = new Map(checkpoint.versions.slice(-100));
    this.closedImports = new Map(checkpoint.closedImports.slice(-100));
    this.expire();
  }
  expire(now = Date.now(), showUnavailable = false) {
    let changed = false;
    this.items = this.items.flatMap((item) => {
      if (item.expiresAt > now) return [item];
      changed = true;
      return showUnavailable && activityWorking(item)
        ? [{ ...item, phase: "unavailable" as const, updatedAt: now, expiresAt: now + 5000 }]
        : [];
    });
    for (const [id, value] of this.versions) if (value.until < now) this.versions.delete(id);
    for (const [key, until] of this.closedImports) if (until < now) this.closedImports.delete(key);
    if (changed) this.notify();
  }
  clear() {
    this.versions.clear();
    this.closedImports.clear();
    if (this.items.length) {
      this.items = [];
      this.notify();
    }
  }
}
const EMPTY: AgentActivity[] = [];
