import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { featureFlagKeys, FLAGS_OFF } from "./feature-flags";

mock.module("server-only", () => ({}));
const { evaluateFunctionalFlags } = await import("./functional-feature-flags");
const configuration = { key: "synthetic-project-token", host: "https://eu.i.posthog.com" };
const enabled = { "mcp-pi-gemini": true, "github-connector": true, "settings-connectors": true };
const response = (value: unknown = true) => ({
  errorsWhileComputingFlags: false,
  flags: Object.fromEntries(featureFlagKeys.map((key) => [key, { enabled: value, variant: null }])),
});
let transport: ReturnType<typeof spyOn>;
afterEach(() => transport?.mockRestore());

test("functional evaluation sends only fixed service inputs and returns three booleans", async () => {
  transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response()));
  expect(await evaluateFunctionalFlags(configuration)).toEqual(enabled);
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, options] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://eu.i.posthog.com/flags/?v=2");
  expect(JSON.parse(String(options!.body))).toEqual({
    api_key: configuration.key,
    distinct_id: "tidy-functional-rollout",
    flag_keys_to_evaluate: [...featureFlagKeys],
  });
  expect(options!.headers).toEqual({ "Content-Type": "application/json" });
  expect(options!.credentials).toBe("omit");
  expect(options!.cache).toBe("no-store");
  expect(options!.redirect).toBe("manual");
  expect(options!.signal).toBeInstanceOf(AbortSignal);
  // No browser/account identifier, person properties, events or SDK enrichment.
  expect(Object.keys(await evaluateFunctionalFlags(configuration))).toEqual([...featureFlagKeys]);
});

test("unconfigured and unsafe hosts fail closed before any network request", async () => {
  transport = spyOn(globalThis, "fetch");
  for (const config of [
    {},
    { key: "key" },
    { host: configuration.host },
    ...[
      "http://eu.i.posthog.com",
      "https://attacker.example",
      "https://eu.i.posthog.com.attacker.example",
      "https://secret@eu.i.posthog.com",
      "https://eu.i.posthog.com:444",
      "invalid",
    ].map((host) => ({ key: "key", host })),
  ]) {
    expect(await evaluateFunctionalFlags(config)).toEqual(FLAGS_OFF);
  }
  expect(transport).not.toHaveBeenCalled();
});

test("managed and US regional hosts use the same fixed evaluation protocol", async () => {
  transport = spyOn(globalThis, "fetch");
  transport.mockImplementation(async () => Response.json(response()));
  for (const host of ["https://t.tidydesign.co", "https://us.i.posthog.com"]) {
    expect(await evaluateFunctionalFlags({ ...configuration, host })).toEqual(enabled);
    expect(String(transport.mock.calls.at(-1)![0])).toBe(`${host}/flags/?v=2`);
  }
});

test("missing, malformed, variant, failed and quota-limited results fail closed", async () => {
  transport = spyOn(globalThis, "fetch");
  for (const data of [
    null,
    [],
    {},
    { flags: response().flags },
    response(false),
    response("true"),
    response(1),
    { errorsWhileComputingFlags: false, flags: {} },
    { ...response(), errorsWhileComputingFlags: true },
    { ...response(), quotaLimited: ["feature_flags"] },
    { ...response(), error: "provider unavailable" },
    {
      ...response(),
      flags: Object.fromEntries(
        featureFlagKeys.map((key) => [key, { enabled: true, variant: "test" }]),
      ),
    },
    {
      ...response(),
      flags: Object.fromEntries(
        featureFlagKeys.map((key) => [key, { enabled: true, failed: true }]),
      ),
    },
  ]) {
    transport.mockResolvedValueOnce(Response.json(data));
    expect(await evaluateFunctionalFlags(configuration)).toEqual(FLAGS_OFF);
  }
  transport.mockResolvedValueOnce(new Response("invalid JSON"));
  expect(await evaluateFunctionalFlags(configuration)).toEqual(FLAGS_OFF);
});

test("one enabled flag does not reveal other interfaces or leak provider metadata", async () => {
  transport = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      ...response(),
      flags: {
        "github-connector": { enabled: true, variant: null, metadata: { payload: "private" } },
        unrelated: { enabled: true },
      },
      requestId: "provider-request",
    }),
  );
  expect(await evaluateFunctionalFlags(configuration)).toEqual({
    ...FLAGS_OFF,
    "github-connector": true,
  });
});

test("provider failures never reuse a previous enabled result or follow redirects", async () => {
  transport = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(response()));
  expect(await evaluateFunctionalFlags(configuration)).toEqual(enabled);
  for (const status of [301, 302, 307, 308, 401, 429, 500, 503]) {
    transport.mockResolvedValueOnce(new Response(null, { status }));
    expect(await evaluateFunctionalFlags(configuration)).toEqual(FLAGS_OFF);
  }
  transport.mockRejectedValueOnce(new TypeError("network unavailable"));
  expect(await evaluateFunctionalFlags(configuration)).toEqual(FLAGS_OFF);
});

test("a stalled evaluation aborts within its bounded deadline without retrying", async () => {
  transport = spyOn(globalThis, "fetch");
  transport.mockImplementation(
    (_url: unknown, options?: RequestInit) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
          once: true,
        });
      }),
  );
  const start = Date.now();
  expect(await evaluateFunctionalFlags(configuration)).toEqual(FLAGS_OFF);
  expect(Date.now() - start).toBeLessThan(3000);
  expect(transport).toHaveBeenCalledTimes(1);
});
