import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ConnectionLeases } from "./connection-leases";

test("account connection limits span rooms, reject ticket replay, expire and survive restart", () => {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  const leases = new ConnectionLeases(sql);
  try {
    for (let i = 0; i < 10; i++)
      expect(leases.acquire("account", `room-${i}`, 301_000, 1000)).toBe(true);
    expect(leases.acquire("account", "eleventh", 301_000, 1000)).toBe(false);
    expect(leases.acquire("account", "room-0", 301_000, 1000)).toBe(false);
    expect(leases.acquire("another-account", "room-0", 301_000, 1000)).toBe(true);
    const restarted = new ConnectionLeases(sql);
    expect(restarted.acquire("account", "eleventh", 301_000, 1001)).toBe(false);
    restarted.release("account", "room-0");
    restarted.release("account", "room-0");
    expect(restarted.acquire("account", "replacement", 301_000, 1002)).toBe(true);
    expect(restarted.acquire("account", "expired", 1000, 1002)).toBe(false);
    expect(restarted.acquire("account", "too-long", 900_000, 1002)).toBe(false);
    expect(restarted.acquire("account", "reconnect", 601_000, 301_000)).toBe(true);
  } finally {
    db.close();
  }
});
