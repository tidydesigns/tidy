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

type Allowance = {
  remaining: number;
  until: number;
  pending: Promise<boolean> | null;
  blocked: boolean;
};

/** Short-lived prepaid batches share durable account limits across rooms.
 * Instantiate only inside a Durable Object, whose events share one I/O context. */
export class RealtimeMessageBudget {
  private accounts = new Map<string, Allowance>();
  constructor(
    private reserve: (userId: string) => Promise<RateDecision>,
    private now = Date.now,
  ) {}

  /** Discard local permits on departure; durable charges are never refunded. */
  forget(userId: string) {
    this.accounts.delete(userId);
  }

  async consume(userId: string): Promise<boolean> {
    const now = this.now();
    let entry = this.accounts.get(userId);
    if (entry?.pending) {
      await entry.pending;
      if (this.accounts.get(userId) !== entry) return false;
      return this.consume(userId);
    }
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
      entry = { remaining: 0, until: 0, pending: null, blocked: false };
      this.accounts.set(userId, entry);
    }
    const current = entry;
    current.pending = (async () => {
      try {
        const result = await this.reserve(userId);
        current.until =
          this.now() + (result.allowed ? 1000 : Math.max(1000, (result.retryAfter ?? 1) * 1000));
        current.remaining = result.allowed ? REALTIME_MESSAGE_LIMITS.batch - 1 : 0;
        current.blocked = !result.allowed;
        return result.allowed;
      } catch {
        current.until = this.now() + 1000;
        current.remaining = 0;
        current.blocked = true;
        return false;
      } finally {
        current.pending = null;
      }
    })();
    return current.pending;
  }
}
