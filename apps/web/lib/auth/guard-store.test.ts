import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore, metadataFreshness } from "./guard-store";

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
