import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore } from "../auth/guard-store";
import { windowChecks } from "../security/worker-budget";
import { RealtimeMessageBudget, REALTIME_MESSAGE_LIMITS } from "./message-budget";

test("rooms and fresh room instances share one durable account allowance", async () => {
  const database = new Database(":memory:");
  const store = new AuthGuardStore({
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage);
  const now = Date.now();
  let reservations = 0;
  const reserve = async (id: string) => {
    reservations++;
    const [minute, hour] = windowChecks(
      id,
      REALTIME_MESSAGE_LIMITS.minute,
      REALTIME_MESSAGE_LIMITS.hour,
      REALTIME_MESSAGE_LIMITS.batch,
    );
    const result = store.consume(minute.key, minute.rule, now);
    return result.allowed ? store.consume(hour.key, hour.rule, now) : result;
  };
  const rooms = Array.from({ length: 10 }, () => new RealtimeMessageBudget(reserve, () => now));
  try {
    for (let i = 0; i < REALTIME_MESSAGE_LIMITS.minute; i++)
      expect(await rooms[Math.floor(i / 10) % rooms.length].consume("account")).toBe(true);
    expect(reservations).toBe(360);
    expect(await rooms[0].consume("account")).toBe(false);
    expect(await new RealtimeMessageBudget(reserve, () => now).consume("account")).toBe(false);
    expect(await rooms[0].consume("other-account")).toBe(true);
  } finally {
    database.close();
  }
});

test("unused permits expire and denied or failed checks do not cause an RPC per message", async () => {
  let now = 1000,
    calls = 0,
    available = true;
  const room = new RealtimeMessageBudget(
    async () => {
      calls++;
      if (!available) throw new Error("Guard unavailable");
      return { allowed: true, retryAfter: null };
    },
    () => now,
  );
  expect(await room.consume("account")).toBe(true);
  expect(await room.consume("account")).toBe(true);
  expect(calls).toBe(1);
  now += 1001;
  available = false;
  expect(await room.consume("account")).toBe(false);
  for (let i = 0; i < 100; i++) expect(await room.consume("account")).toBe(false);
  expect(calls).toBe(2);
  now += 1001;
  available = true;
  expect(await room.consume("account")).toBe(true);
});

test("overlapping messages cannot obtain multiple outstanding batches", async () => {
  let finish!: (result: { allowed: boolean; retryAfter: null }) => void;
  let calls = 0;
  const room = new RealtimeMessageBudget(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = room.consume("account");
  expect(await room.consume("account")).toBe(false);
  expect(calls).toBe(1);
  finish({ allowed: true, retryAfter: null });
  expect(await first).toBe(true);
  for (let i = 0; i < 9; i++) expect(await room.consume("account")).toBe(true);
  expect(calls).toBe(1);
});

test("departed accounts release cache capacity without resetting their durable denial", async () => {
  let calls = 0;
  const room = new RealtimeMessageBudget(
    async (userId) => {
      calls++;
      return { allowed: userId === "new-participant", retryAfter: 3600 };
    },
    () => 1000,
  );
  for (let i = 0; i < 100; i++) expect(await room.consume(`departing-${i}`)).toBe(false);
  expect(await room.consume("new-participant")).toBe(false);
  expect(calls).toBe(100);
  room.forget("departing-0");
  expect(await room.consume("new-participant")).toBe(true);
  expect(calls).toBe(101);
  room.forget("new-participant");
  expect(await room.consume("departing-0")).toBe(false);
  expect(calls).toBe(102);
});
