import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  budgetShard,
  windowChecks,
  workerBudgetConsumer,
  type BudgetConsumer,
  type BudgetEnvironment,
} from "./worker-budget";

/** Separate product budgets; suppression never reports another billable error. */
export async function consumeServerTelemetry(
  kind: "errors" | "flags",
  fingerprint: string,
  consume: BudgetConsumer,
) {
  try {
    if (kind === "errors") {
      const duplicate = await consume(
        `server-errors:${await budgetShard(fingerprint)}`,
        ...windowChecks(fingerprint, 3, 20),
      );
      if (!duplicate.allowed) return false;
    }
    const limits = kind === "errors" ? [30, 500] : [120, 3000];
    return (await consume(`server-${kind}`, ...windowChecks("global", limits[0], limits[1])))
      .allowed;
  } catch {
    return false;
  }
}
export function admitServerError(env: BudgetEnvironment, fingerprint: string) {
  return consumeServerTelemetry("errors", fingerprint, workerBudgetConsumer(env));
}
export async function admitFlagEvaluation() {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return true;
  try {
    const { env } = getCloudflareContext();
    return consumeServerTelemetry("flags", "global", workerBudgetConsumer(env));
  } catch {
    return false;
  }
}
