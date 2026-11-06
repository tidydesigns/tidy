import { createHash } from "node:crypto";
import { z } from "zod";
import { version } from "../../../package.json";
import {
  codexUsageSchema,
  resetOutcomeSchema,
  resetSelectionSchema,
  availableResetCredits,
  type CodexUsage,
  type ResetSelection,
  type ResetResult,
} from "../../shared/contracts/codex-usage";
import { PrivateState } from "../platform/private-state";
import { findHarness } from "./harnesses";
import { withHarnessConnection } from "./harness-connection";
import { supportsExactReset } from "./codex-reset-capability";
import { invalidateHarnessDetails } from "./harness-details";

type Request = (method: string, params?: unknown) => Promise<unknown>;
const windowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().int().nonnegative().nullish(),
  windowDurationMins: z.number().positive().nullish(),
});
const bucketSchema = z.object({
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
});
const limitsSchema = z.object({
  accountId: z.string().min(1).nullish(),
  rateLimits: bucketSchema,
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullish(),
  rateLimitResetCredits: z.unknown().optional(),
});
const attemptSchema = z.object({
  selection: resetSelectionSchema,
  outcome: resetOutcomeSchema.nullable(),
});
type Dependencies = {
  connect<T>(cwd: string, use: (request: Request, supported: boolean) => Promise<T>): Promise<T>;
  now(): number;
};
const defaults: Dependencies = {
  now: Date.now,
  async connect(cwd, use) {
    const executable = await findHarness("codex");
    if (!executable) throw new Error("Install and sign in to Codex first.");
    const supported = await supportsExactReset(executable);
    return withHarnessConnection({ executable, harness: "codex", cwd }, async (request) => {
      await request("initialize", { clientInfo: { name: "tidy_desktop", title: "Tidy", version } });
      return use(request, supported);
    });
  },
};

/** Account-scoped, serialized redemption with a private, durable retry record. */
export class CodexUsageService {
  private mutations = Promise.resolve();
  private reads = new Map<string, Promise<CodexUsage>>();
  constructor(
    private state: PrivateState,
    private deps = defaults,
  ) {}

  private async snapshot(request: Request, supported: boolean): Promise<CodexUsage> {
    const limits = limitsSchema.parse(await request("account/rateLimits/read"));
    const details = codexUsageSchema.shape.resets.safeParse(limits.rateLimitResetCredits ?? null);
    let resets = details.success ? details.data : null;
    const duplicateIds =
      resets?.credits &&
      new Set(resets.credits.map((credit) => credit.id)).size !== resets.credits.length;
    const resetDetailsError =
      !details.success || duplicateIds
        ? "Codex returned invalid or ambiguous reset details. Refresh before using a new reset."
        : null;
    if (duplicateIds && resets) resets = { ...resets, credits: null };
    const accountKey = limits.accountId
      ? createHash("sha256").update(limits.accountId).digest("hex")
      : null;
    const bucket = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
    await this.state.initialize();
    const stored = accountKey ? await this.state.read(accountKey) : undefined;
    const attempt = stored === undefined ? null : attemptSchema.parse(stored);
    return {
      accountKey,
      checkedAt: new Date(this.deps.now()).toISOString(),
      windows: [bucket.primary, bucket.secondary].flatMap((window, i) =>
        window
          ? [
              {
                name: window.windowDurationMins
                  ? window.windowDurationMins >= 1440
                    ? `${window.windowDurationMins / 1440} day`
                    : window.windowDurationMins >= 60
                      ? `${window.windowDurationMins / 60} hour`
                      : `${window.windowDurationMins} minute`
                  : i === 0
                    ? "Primary"
                    : "Secondary",
                usedPercent: window.usedPercent,
                resetsAt: window.resetsAt ?? null,
              },
            ]
          : [],
      ),
      resets,
      resetDetailsError,
      redemptionUnavailable: !supported
        ? "Update Codex to use a specific banked reset safely."
        : !accountKey
          ? "Codex hasn’t identified this usage account. Refresh or use the provider’s usage page."
          : null,
      pendingReset: attempt && attempt.outcome === null ? attempt.selection : null,
    };
  }

  read(cwd: string) {
    const existing = this.reads.get(cwd);
    if (existing) return existing;
    const pending = this.deps.connect(cwd, (request, supported) =>
      this.snapshot(request, supported),
    );
    this.reads.set(cwd, pending);
    void pending
      .finally(() => {
        if (this.reads.get(cwd) === pending) this.reads.delete(cwd);
      })
      .catch(() => {});
    return pending;
  }

  consume(cwd: string, input: ResetSelection): Promise<ResetResult> {
    const selection = resetSelectionSchema.parse(input);
    const operation = this.mutations.then(() =>
      this.deps.connect(cwd, async (request, supported) => {
        const usage = await this.snapshot(request, supported);
        if (usage.redemptionUnavailable) throw new Error(usage.redemptionUnavailable);
        if (usage.accountKey !== selection.accountKey)
          throw new Error("Your Codex account changed. Refresh and choose a reset again.");
        const stored = await this.state.read(selection.accountKey);
        const latest = stored === undefined ? null : attemptSchema.parse(stored);
        const attemptKey = `${selection.accountKey}-${selection.idempotencyKey}`;
        const completed = await this.state.read(attemptKey);
        const attempt = completed === undefined ? latest : attemptSchema.parse(completed);
        const sameAttempt = attempt?.selection.idempotencyKey === selection.idempotencyKey;
        if (
          sameAttempt &&
          (attempt.selection.creditId !== selection.creditId ||
            attempt.selection.expiresAt !== selection.expiresAt ||
            attempt.selection.accountKey !== selection.accountKey)
        )
          throw new Error("This retry does not match the original reset.");
        if (sameAttempt && attempt.outcome !== null) {
          // Repair a pending pointer if the completed record was durable before an interrupted write.
          if (
            latest?.selection.idempotencyKey === selection.idempotencyKey &&
            latest.outcome === null
          ) {
            await this.state.write(selection.accountKey, attempt);
            return { outcome: attempt.outcome, usage: { ...usage, pendingReset: null } };
          }
          return { outcome: attempt.outcome, usage };
        }
        if (!sameAttempt) {
          if (latest?.outcome === null)
            throw new Error("Resolve the previous reset attempt before using another reset.");
          if (usage.resetDetailsError) throw new Error(usage.resetDetailsError);
          // Migrate an older host’s last completed record before replacing its account pointer.
          if (latest && latest.outcome !== null)
            await this.state.write(
              `${selection.accountKey}-${latest.selection.idempotencyKey}`,
              latest,
            );
          const credit = availableResetCredits(usage, this.deps.now()).find(
            (item) => item.id === selection.creditId,
          );
          if (!credit || usage.resets?.availableCount === 0)
            throw new Error(
              "That reset has expired or is no longer available. Refresh and choose again.",
            );
          if (credit.expiresAt !== selection.expiresAt)
            throw new Error("That reset’s expiry changed. Refresh and review it again.");
          await this.state.write(selection.accountKey, { selection, outcome: null });
        }
        // Pending attempts must reuse BOTH fields, even if the original credit is now redeemed/expired.
        // Never fall back to an omitted creditId or to the next available credit.
        let outcome: ResetResult["outcome"];
        try {
          ({ outcome } = z.object({ outcome: resetOutcomeSchema }).parse(
            await request("account/rateLimitResetCredit/consume", {
              creditId: selection.creditId,
              idempotencyKey: selection.idempotencyKey,
            }),
          ));
          // Retain each outcome independently; a later redemption must not erase this retry result.
          await this.state.write(attemptKey, { selection, outcome });
          await this.state.write(selection.accountKey, { selection, outcome });
        } catch {
          outcome = "unconfirmed";
        }
        invalidateHarnessDetails("codex");
        // A failed refresh must never turn a confirmed redemption into a new spending attempt.
        const refreshed = await this.snapshot(request, supported).catch(() => null);
        return { outcome, usage: refreshed };
      }),
    );
    this.mutations = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
