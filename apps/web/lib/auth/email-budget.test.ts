import { expect, test } from "bun:test";
import { consumeEmailBudget } from "./email-budget";
import { Database } from "bun:sqlite";
import { AuthGuardStore, type RateRule } from "./guard-store";
import { afterEach } from "bun:test";
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function limiter() {
  let now = 0;
  const database = new Database(":memory:");
  databases.push(database);
  const store = new AuthGuardStore({
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    consume: async (key: string, rule: RateRule) => store.consume(key, rule, now),
  };
}

test("concurrent email sends share a recipient cooldown across caller IPs and casing", async () => {
  const guard = limiter();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      consumeEmailBudget(index % 2 ? " User@Example.test " : "user@example.test", guard.consume),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  guard.advance(60_000);
  expect(await consumeEmailBudget("user@example.test", guard.consume)).toBe(true);
});

test("recipient hourly allowance remains bounded when the minute cooldown expires", async () => {
  const guard = limiter();
  for (let index = 0; index < 10; index++) {
    expect(await consumeEmailBudget("user@example.test", guard.consume)).toBe(true);
    guard.advance(61_000);
  }
  expect(await consumeEmailBudget("user@example.test", guard.consume)).toBe(false);
});

test("distinct inboxes share the global minute budget", async () => {
  const guard = limiter();
  const results = await Promise.all(
    Array.from({ length: 140 }, (_, index) =>
      consumeEmailBudget(`user-${index}@example.test`, guard.consume),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(120);
});

test("an unavailable budget store fails closed", async () => {
  await expect(
    consumeEmailBudget("user@example.test", async () => {
      throw new Error("store unavailable");
    }),
  ).rejects.toThrow("store unavailable");
});
