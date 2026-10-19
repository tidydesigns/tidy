import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore } from "../auth/guard-store";
import {
  consumeOperationBudget,
  OperationBudgetError,
  operationFailure,
  OPERATION_LIMITS,
} from "./operation-budget";
import type { BudgetConsumer } from "./worker-budget";

test.each([
  "history-write",
  "document-read",
  "document-write",
  "document-request",
  "avatar-read",
  "avatar-write",
  "avatar-request",
  "billing",
  "billing-request",
] as const)("%s budgets span workspaces per account and actors per workspace", async (kind) => {
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
    const [accountMinute, , workspaceMinute] = OPERATION_LIMITS[kind];
    for (let i = 0; i < accountMinute; i++)
      await consumeOperationBudget(kind, "same-user", `workspace-${i}`, consume);
    await expect(
      consumeOperationBudget(kind, "same-user", "another-workspace", consume),
    ).rejects.toBeInstanceOf(OperationBudgetError);
    for (let i = 0; i < workspaceMinute; i++)
      await consumeOperationBudget(kind, `actor-${i}`, "shared-workspace", consume);
    await expect(
      consumeOperationBudget(kind, "extra-actor", "shared-workspace", consume),
    ).rejects.toBeInstanceOf(OperationBudgetError);
    const response = operationFailure(new OperationBudgetError(429, 20));
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("20");
  } finally {
    for (const database of databases) database.close();
  }
});
