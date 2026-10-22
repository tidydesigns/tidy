import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore, metadataFreshness, type RatePair } from "./guard-store";

function store() {
  const database = new Database(":memory:");
  const sql = {
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  return { database, guard: new AuthGuardStore(sql) };
}
const url = "https://client.example/metadata.json";
const metadata = JSON.stringify({
  client_id: url,
  client_name: "Test client",
  redirect_uris: ["http://127.0.0.1/callback"],
  token_endpoint_auth_method: "none",
  application_type: "native",
});

test("independent callers consume the same atomic budget and recover after expiry", async () => {
  const { database, guard } = store();
  try {
    const result = await Promise.all(
      Array.from({ length: 20 }, async () =>
        guard.consume("shared-ip-and-route", { window: 60, max: 3 }, 1000),
      ),
    );
    expect(result.filter((value) => value.allowed)).toHaveLength(3);
    expect(result.find((value) => !value.allowed)?.retryAfter).toBe(60);
    expect(guard.consume("different-key", { window: 60, max: 3 }, 1000).allowed).toBe(true);
    expect(guard.consume("shared-ip-and-route", { window: 60, max: 3 }, 61_000).allowed).toBe(true);
  } finally {
    database.close();
  }
});

test("paired minute/hour reservations match sequential counters, denials and expiry", () => {
  const before = store(),
    batched = store();
  const clock = spyOn(Date, "now");
  const first = { key: "minute", rule: { window: 60, max: 3 } };
  const second = { key: "hour", rule: { window: 3600, max: 5 } };
  try {
    for (const now of [
      1000, 1001, 1002, 1003, 61_003, 61_004, 61_005, 61_006, 122_006, 3_722_007,
    ]) {
      clock.mockReturnValue(now);
      let expected = before.guard.consume(first.key, first.rule);
      if (expected.allowed) expected = before.guard.consume(second.key, second.rule);
      expect(batched.guard.consumePair(first, second)).toEqual(expected);
      expect(batched.database.query("select * from auth_bucket order by key").all()).toEqual(
        before.database.query("select * from auth_bucket order by key").all(),
      );
    }
  } finally {
    clock.mockRestore();
    before.database.close();
    batched.database.close();
  }
});

test("concurrent paired checks retain the minute charge when the hour is exhausted", async () => {
  const { database, guard } = store();
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        guard.consumePair(
          { key: "minute", rule: { window: 60, max: 3 } },
          { key: "hour", rule: { window: 3600, max: 2 } },
        ),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(database.query("select key,count from auth_bucket order by key").all()).toEqual([
      { key: "hour", count: 2 },
      { key: "minute", count: 3 },
    ]);
  } finally {
    database.close();
  }
});

test("validated metadata expires, honors no-store, and invalid updates clear old data", () => {
  const { database, guard } = store();
  try {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "max-age=60",
      ETag: '"first"',
      "Set-Cookie": "should-never-be-stored",
    });
    guard.store(url, metadata, headers, 1000);
    expect(guard.cached(url, 1001)?.expires_at).toBe(61_000);
    expect(guard.cached(url, 1001)?.headers).not.toContain("Set-Cookie");
    guard.store(url, metadata, new Headers({ "Cache-Control": "no-store" }), 2000);
    expect(guard.cached(url, 2000)).toBeUndefined();
    guard.store(url, metadata, headers, 3000);
    guard.store(
      url,
      JSON.stringify({ client_id: "https://attacker.example/metadata.json" }),
      headers,
      4000,
    );
    expect(guard.cached(url, 4000)).toBeUndefined();
    guard.store(url, JSON.stringify({ keys: [] }), headers, 5000);
    expect(guard.cached(url, 5000)).toBeUndefined();
  } finally {
    database.close();
  }
});

test.each([
  "no-store",
  "private",
  "no-cache",
  "max-age=0",
  "max-age=garbage",
  "max-age=60junk",
  "max-age=10,max-age=60",
])("cache does not override origin policy %s", (control) => {
  expect(metadataFreshness(new Headers({ "Cache-Control": control }), 1000)).toBe(0);
});

test("cache lifetime includes Age, Date, shared max-age, and Vary", () => {
  const now = Date.UTC(2026, 9, 3);
  expect(
    metadataFreshness(
      new Headers({
        "Cache-Control": "max-age=600, s-maxage=60",
        Age: "50",
        Date: new Date(now).toUTCString(),
      }),
      now,
    ),
  ).toBe(10_000);
  expect(
    metadataFreshness(
      new Headers({ "Cache-Control": "max-age=60", Date: new Date(now - 65_000).toUTCString() }),
      now,
    ),
  ).toBe(0);
  expect(metadataFreshness(new Headers({ Vary: "*" }), now)).toBe(0);
  expect(metadataFreshness(new Headers({ "Cache-Control": "max-age=86400" }), now)).toBe(600_000);
});

test("shared metadata budgets block fan-out and expired invocations release capacity", () => {
  const { database, guard } = store();
  try {
    guard.acquireFetch(url, 1000);
    expect(() => guard.acquireFetch(url, 1001)).toThrow("limit");
    for (let i = 1; i < 4; i++) guard.acquireFetch(`https://client.example/${i}.json`, 1000);
    expect(() => guard.acquireFetch("https://client.example/fifth.json", 1001)).toThrow("limit");
    expect(() => guard.acquireFetch(url, 7001)).not.toThrow();
    for (const unsafe of [
      "http://client.example/meta",
      "https://127.0.0.1/meta",
      "https://169.254.169.254/meta",
    ])
      expect(() => guard.acquireFetch(unsafe, 8000)).toThrow();
  } finally {
    database.close();
  }
});

test("weighted budgets reject overshoot atomically, retain counts and recover after expiry", async () => {
  const { database, guard } = store();
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, async () =>
        guard.consume("bytes", { window: 60, max: 20_000_000, cost: 5_000_000 }, 1000),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
    expect(guard.consume("bytes", { window: 60, max: 20_000_000, cost: 1 }, 1001).allowed).toBe(
      false,
    );
    expect(
      guard.consume("bytes", { window: 60, max: 20_000_000, cost: 5_000_000 }, 61_000).allowed,
    ).toBe(true);
    for (const cost of [0, -1, 0.5, NaN, Infinity, 21_000_000])
      expect(() => guard.consume("invalid", { window: 60, max: 20_000_000, cost })).toThrow();
    expect(database.query("select * from auth_bucket where key='invalid'").all()).toHaveLength(0);
  } finally {
    database.close();
  }
});

test("steady traffic replenishes without requiring an idle window", () => {
  for (const [window, max, interval] of [
    [60, 120, 1000],
    [3600, 600, 10000],
  ]) {
    const { database, guard } = store();
    try {
      for (let i = 0; i < max * 3; i++)
        expect(guard.consume("steady", { window, max }, 1000 + i * interval).allowed).toBe(true);
    } finally {
      database.close();
    }
  }
});

test("weighted charges and rejected attempts do not move the window boundary", () => {
  const { database, guard } = store();
  try {
    expect(guard.consume("bytes", { window: 60, max: 100, cost: 60 }, 1000).allowed).toBe(true);
    expect(guard.consume("bytes", { window: 60, max: 100, cost: 40 }, 30_000).allowed).toBe(true);
    expect(guard.consume("bytes", { window: 60, max: 100 }, 60_999)).toEqual({
      allowed: false,
      retryAfter: 1,
    });
    expect(guard.consume("bytes", { window: 60, max: 100, cost: 100 }, 61_000).allowed).toBe(true);
  } finally {
    database.close();
  }
});

test("expiry cleanup is indexed, bounded and recovers capacity after object restart", () => {
  const { database, guard } = store();
  try {
    for (let i = 0; i < 10_000; i++)
      expect(guard.consume(`key-${i}`, { window: 60, max: 1 }, 1000).allowed).toBe(true);
    expect(guard.consume("overflow", { window: 60, max: 1 }, 1000).allowed).toBe(false);
    expect(guard.consume("recovered", { window: 60, max: 1 }, 61_000).allowed).toBe(true);
    expect(database.query("SELECT count(*) AS count FROM auth_bucket").get()).toEqual({
      count: 9745,
    });
    const plan = database
      .query(
        "EXPLAIN QUERY PLAN SELECT key FROM auth_bucket WHERE expires_at <= ? ORDER BY expires_at LIMIT 256",
      )
      .all(61000);
    expect(JSON.stringify(plan)).toContain("auth_bucket_expiry");
    const restarted = new AuthGuardStore({
      exec(query: string, ...bindings: (string | number | null)[]) {
        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    } as unknown as SqlStorage);
    expect(restarted.consume("recovered", { window: 60, max: 1 }, 61_001).allowed).toBe(false);
  } finally {
    database.close();
  }
});

test("atomic admission restores SQL and cached accounting after rejection or write failure", () => {
  const { database, guard } = store();
  const identity = (key: string): RatePair => [
    { key: `${key}:minute`, rule: { window: 60, max: 5 } },
    { key: `${key}:hour`, rule: { window: 3600, max: 20 } },
  ];
  const shared = identity("global");
  const transactionSync = <T>(callback: () => T) => database.transaction(callback)();
  try {
    for (let index = 0; index < 5; index++)
      expect(
        guard.consumeAdmission({ identity: identity(`ip-${index}`), shared, transactionSync })
          .allowed,
      ).toBe(true);
    const before = database.query("SELECT * FROM auth_bucket ORDER BY key").all();
    for (let index = 0; index < 10_001; index++)
      expect(
        guard.consumeAdmission({ identity: identity(`denied-${index}`), shared, transactionSync })
          .allowed,
      ).toBe(false);
    expect(database.query("SELECT * FROM auth_bucket ORDER BY key").all()).toEqual(before);
    const otherShared = identity("other-global");
    expect(() =>
      guard.consumeAdmission({
        identity: identity("write-failure"),
        shared: otherShared,
        transactionSync: (callback) =>
          transactionSync(() => {
            callback();
            throw new Error("storage failure");
          }),
      }),
    ).toThrow("storage failure");
    expect(database.query("SELECT * FROM auth_bucket ORDER BY key").all()).toEqual(before);
    expect(
      guard.consumeAdmission({
        identity: identity("recovered"),
        shared: otherShared,
        transactionSync,
      }).allowed,
    ).toBe(true);
  } finally {
    database.close();
  }
}, 15_000);
