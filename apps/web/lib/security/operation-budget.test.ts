import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore } from "../auth/guard-store";
import { consumeOperationBudget, OperationBudgetError, operationFailure } from "./operation-budget";
import type { BudgetConsumer } from "./worker-budget";

test("history budgets span workspaces per account and actors per workspace", async () => {
  const databases: Database[] = [];
  const guards = new Map<string, AuthGuardStore>();
  const consume: BudgetConsumer = async (scope, first, second) => {
    let guard = guards.get(scope);
    if (!guard) {
      const database = new Database(":memory:");
      databases.push(database);
      guard = new AuthGuardStore({
        exec(query: string, ...bindings: (string | number | null)[]) {
          const rows = database.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      } as unknown as SqlStorage);
      guards.set(scope, guard);
    }
    return guard.consumePair(first, second);
  };
  try {
    for (let i = 0; i < 5; i++)
      await consumeOperationBudget("history-write", "same-user", `workspace-${i}`, consume);
    await expect(
      consumeOperationBudget("history-write", "same-user", "another-workspace", consume),
    ).rejects.toBeInstanceOf(OperationBudgetError);
    for (let i = 0; i < 10; i++)
      await consumeOperationBudget("history-write", `actor-${i}`, "shared-workspace", consume);
    await expect(
      consumeOperationBudget("history-write", "extra-actor", "shared-workspace", consume),
    ).rejects.toBeInstanceOf(OperationBudgetError);
    const response = operationFailure(new OperationBudgetError(429, 20));
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("20");
  } finally {
    for (const database of databases) database.close();
  }
});
