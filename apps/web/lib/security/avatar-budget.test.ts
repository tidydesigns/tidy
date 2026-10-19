import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore } from "../auth/guard-store";
import { AVATAR_STORAGE_LIMITS, consumeAvatarStorage } from "./avatar-budget";
import { OperationBudgetError } from "./operation-budget";
import type { BudgetConsumer } from "./worker-budget";

test.each(["read", "write"] as const)(
  "avatar %s work shares a ceiling across callers",
  async (kind) => {
    const database = new Database(":memory:");
    const store = new AuthGuardStore({
      exec(query: string, ...bindings: (string | number | null)[]) {
        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    } as unknown as SqlStorage);
    const consume: BudgetConsumer = async (_scope, first, second) =>
      store.consumePair(first, second);
    try {
      for (let i = 0; i < AVATAR_STORAGE_LIMITS[kind][0]; i++)
        await consumeAvatarStorage(kind, consume);
      await expect(consumeAvatarStorage(kind, consume)).rejects.toBeInstanceOf(
        OperationBudgetError,
      );
    } finally {
      database.close();
    }
  },
);
