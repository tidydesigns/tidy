import {
  budgetShard,
  windowChecks,
  workerBudgetConsumer,
  type BudgetEnvironment,
} from "../security/worker-budget";
import type { RateDecision } from "../auth/guard-store";

export const REALTIME_MESSAGE_LIMITS = { minute: 3600, hour: 120_000, batch: 10 } as const;

export async function reserveRealtimeMessages(env: BudgetEnvironment, userId: string) {
  return workerBudgetConsumer(env)(
    `presence-messages:${await budgetShard(userId)}`,
    ...windowChecks(
      userId,
      REALTIME_MESSAGE_LIMITS.minute,
      REALTIME_MESSAGE_LIMITS.hour,
      REALTIME_MESSAGE_LIMITS.batch,
    ),
  );
}

type Allowance = { remaining: number; until: number; pending: boolean; blocked: boolean };

/** Short-lived prepaid batches share durable account limits across rooms. Never
 * share an in-flight RPC between events; concurrent messages may be dropped. */
export class RealtimeMessageBudget {
  private accounts = new Map<string, Allowance>();
  constructor(
    private reserve: (userId: string) => Promise<RateDecision>,
    private now = Date.now,
  ) {}

  async consume(userId: string) {
    const now = this.now();
    let entry = this.accounts.get(userId);
    if (entry?.pending) return false;
    if (entry && entry.until > now) {
      if (entry.blocked) return false;
      if (entry.remaining > 0) {
        entry.remaining--;
        return true;
      }
    }
    if (!entry) {
      for (const [id, value] of this.accounts)
        if (!value.pending && value.until <= now) this.accounts.delete(id);
      if (this.accounts.size >= 100) return false;
      entry = { remaining: 0, until: 0, pending: false, blocked: false };
      this.accounts.set(userId, entry);
    }
    entry.pending = true;
    try {
      const result = await this.reserve(userId);
      entry.until =
        this.now() + (result.allowed ? 1000 : Math.max(1000, (result.retryAfter ?? 1) * 1000));
      entry.remaining = result.allowed ? REALTIME_MESSAGE_LIMITS.batch - 1 : 0;
      entry.blocked = !result.allowed;
      return result.allowed;
    } catch {
      entry.until = this.now() + 1000;
      entry.remaining = 0;
      entry.blocked = true;
      return false;
    } finally {
      entry.pending = false;
    }
  }
}
