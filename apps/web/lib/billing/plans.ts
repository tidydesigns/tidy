// Serializable types and formatting shared by the server and billing UI.
export type PlanLimits = {
  files: number | null;
  editors: number | null;
  storageBytes: number | null;
  mcpCalls: number | null;
};
export type PlanUsage = {
  tier: "free" | "pro" | "self_hosted";
  limits: PlanLimits;
  usage: { files: number; editors: number; storageBytes: number; mcpCalls: number };
  mcpResetAt: string;
};

export function formatStorage(bytes: number) {
  if (bytes >= 1_000_000_000) return `${Number((bytes / 1_000_000_000).toFixed(2))} GB`;
  if (bytes >= 1_000_000) return `${Number((bytes / 1_000_000).toFixed(2))} MB`;
  if (bytes >= 1_000) return `${Number((bytes / 1_000).toFixed(2))} KB`;
  return `${bytes} bytes`;
}

export function planLimitMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: string; detail?: string; message?: string; cause?: unknown };
  if (value.code === "P0001" && value.detail) {
    try {
      if (JSON.parse(value.detail).code === "PLAN_LIMIT" && typeof value.message === "string")
        return value.message;
    } catch {
      /* Other database exceptions must not expose database internals. */
    }
  }
  return value.cause && value.cause !== error ? planLimitMessage(value.cause) : null;
}
