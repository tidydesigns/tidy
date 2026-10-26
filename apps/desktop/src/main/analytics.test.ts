import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAnalytics } from "./analytics";
import { PrivateState } from "./platform/private-state";
import { ANALYTICS_NOTICE } from "@tidy/design/analytics";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for analytics.");
    await Bun.sleep(10);
  }
}
async function fixture(
  options: {
    initial?: unknown;
    online?: boolean;
    fetch?: (
      action: string,
      body: Record<string, unknown>,
      init?: RequestInit,
    ) => Promise<Response | undefined>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "tidy-analytics-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const calls: { action: string; body: Record<string, unknown>; authorization: string | null }[] =
    [];
  let online = options.online ?? true;
  let now = Date.now();
  let count = 0;
  const privateState = new PrivateState(directory);
  if (options.initial) {
    await privateState.initialize();
    await privateState.write("choices", options.initial);
  }
  const instance = new DesktopAnalytics({
    state: privateState,
    origin: "https://app.example.test",
    version: "0.1.0-beta.1",
    platform: "darwin",
    arch: "arm64",
    available: true,
    now: () => now,
    open: async () => {},
    fetch: async (url, init) => {
      if (!online) throw new Error("offline");
      const action = new URL(url).pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ action, body, authorization: new Headers(init?.headers).get("authorization") });
      const custom = await options.fetch?.(action, body, init);
      if (custom) return custom;
      if (action === "receipt")
        return Response.json({
          token: (++count).toString(16).padStart(64, "0"),
          revision: 1,
          expiresAt: new Date(now + 90 * 86_400_000).toISOString(),
          linked: false,
          choices: body.choices,
        });
      return new Response(null, { status: 204 });
    },
  });
  cleanup.unshift(() => instance.close());
  await instance.initialize();
  return {
    instance,
    calls,
    directory,
    setOnline: (value: boolean) => {
      online = value;
    },
    advance: (days: number) => {
      now += days * 86_400_000;
    },
  };
}

test("essential-only creates no analytics identity, queue or network requests", async () => {
  const { instance, calls, directory } = await fixture();
  instance.capture({ name: "harness_turn_started", harness: "codex" });
  instance.active();
  await Bun.sleep(300);
  expect(calls).toHaveLength(0);
  expect((await instance.state()).usage).toBe(false);
  expect(await Bun.file(join(directory, "choices.json")).exists()).toBe(false);
});

test("usage-only sends explicit content-free events and deduplicates active days", async () => {
  const { instance, calls } = await fixture();
  await instance.choose({ usage: true, diagnostics: false });
  instance.active();
  instance.active();
  instance.capture({ name: "harness_turn_started", harness: "codex" });
  instance.capture({ name: "desktop_error", operation: "renderer", category: "unexpected" });
  await until(() => calls.some((call) => call.action === "events"));
  const events = calls
    .filter((call) => call.action === "events")
    .flatMap((call) => call.body.events as { event: { name: string } }[]);
  expect(events.filter((value) => value.event.name === "product_active_day")).toHaveLength(1);
  expect(events.some((value) => value.event.name === "harness_turn_started")).toBe(true);
  expect(events.some((value) => value.event.name === "desktop_error")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("Bearer");
  expect(Object.keys(events[0]).sort()).toEqual([
    "arch",
    "at",
    "event",
    "id",
    "platform",
    "release",
  ]);
});

test("diagnostics consent does not grant usage and raw errors are never accepted", async () => {
  const { instance, calls } = await fixture();
  await instance.choose({ usage: false, diagnostics: true });
  instance.error("renderer");
  instance.error("renderer");
  instance.active();
  await until(() => calls.some((call) => call.action === "events"));
  const text = JSON.stringify(calls.filter((call) => call.action === "events"));
  expect(text).toContain("desktop_error");
  expect(text).not.toContain("product_active_day");
  expect(() =>
    instance.capture({
      name: "desktop_error",
      operation: "renderer",
      category: "unexpected",
      message: "secret-path-token",
    } as never),
  ).toThrow();
});

test("offline withdrawal immediately stops capture and durably schedules erasure", async () => {
  const { instance, calls, directory, setOnline } = await fixture();
  await instance.choose({ usage: true, diagnostics: false });
  await until(() => calls.some((call) => call.action === "events"));
  setOnline(false);
  await instance.erase();
  instance.capture({ name: "harness_turn_started", harness: "claude" });
  expect((await instance.state()).usage).toBe(false);
  const saved = JSON.parse(await readFile(join(directory, "choices.json"), "utf8"));
  expect(saved.erase).toHaveLength(1);
  expect(saved.receipt).toBeUndefined();
  expect(saved.choices).toEqual({ usage: false, diagnostics: false });
});

test("expired choices fail closed and old local diagnostics are removed", async () => {
  const { instance, advance, directory } = await fixture();
  await instance.choose({ usage: true, diagnostics: true });
  instance.error("storage");
  await instance.close();
  advance(91);
  await instance.pruneLocal();
  expect(await Bun.file(join(directory, "diagnostics.json")).exists()).toBe(false);
  expect((await instance.state()).usage).toBe(false);
  const stored = JSON.parse(await readFile(join(directory, "choices.json"), "utf8"));
  expect(stored.notice).toBe(ANALYTICS_NOTICE);
});

test("rapid changes cannot restore an earlier opt-in", async () => {
  const { instance, calls } = await fixture();
  await Promise.all([
    instance.choose({ usage: true, diagnostics: true }),
    instance.choose({ usage: false, diagnostics: false }),
  ]);
  await Bun.sleep(300);
  expect((await instance.state()).usage).toBe(false);
  expect((await instance.state()).diagnostics).toBe(false);
  expect(calls.some((call) => call.action === "events")).toBe(false);
});

test("an async operation cannot cross consent or account generations", async () => {
  const { instance, calls } = await fixture();
  await instance.choose({ usage: true, diagnostics: false });
  const capture = instance.bind();
  await instance.choose({ usage: true, diagnostics: true });
  capture({ name: "harness_turn_finished", harness: "codex", result: "success" });
  await until(() => calls.some((call) => call.action === "events"));
  expect(JSON.stringify(calls)).not.toContain("harness_turn_finished");
});

test("sync diagnostics are sampled rather than exposing an edit-by-edit stream", async () => {
  const { instance, calls } = await fixture();
  await instance.choose({ usage: false, diagnostics: true });
  for (let i = 0; i < 100; i++)
    instance.capture({ name: "desktop_sync_result", result: "success" });
  await until(() => calls.some((value) => value.action === "events"));
  const events = calls
    .filter((value) => value.action === "events")
    .flatMap((value) => value.body.events as { event: { name: string } }[]);
  expect(events.filter((value) => value.event.name === "desktop_sync_result")).toHaveLength(1);
});

test("essential local failures retain only reviewed categories without creating an identity or upload", async () => {
  const { instance, calls, directory } = await fixture();
  instance.bind()({ name: "desktop_error", operation: "harness", category: "unexpected" });
  instance.record({ name: "desktop_sync_result", result: "failed" });
  instance.error("update");
  await instance.close();
  const report = JSON.parse(await instance.reports());
  expect(report.localDiagnostics).toHaveLength(3);
  expect(report.events).toEqual([]);
  expect(calls).toHaveLength(0);
  expect(await Bun.file(join(directory, "choices.json")).exists()).toBe(false);
  const errors = JSON.parse(await readFile(join(directory, "diagnostics.json"), "utf8"));
  expect(errors.map((row: { event: { operation: string } }) => row.event.operation)).toEqual([
    "harness",
    "sync",
    "update",
  ]);
  expect(
    errors.every((row: { event: { name: string } }) => row.event.name === "desktop_error"),
  ).toBe(true);
});

test("an outdated notice revokes collection but preserves every deletion receipt across an offline restart", async () => {
  const tokens = Array.from({ length: 12 }, (_, i) => (i + 10).toString(16).padStart(64, "0"));
  const oldToken = "f".repeat(64);
  const { instance, directory, calls } = await fixture({
    online: false,
    initial: {
      notice: "older-notice",
      choices: { usage: true, diagnostics: true },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      receipt: {
        token: oldToken,
        revision: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        linked: true,
      },
      erase: tokens,
    },
  });
  expect(await instance.state()).toMatchObject({
    usage: false,
    diagnostics: false,
    linked: false,
    pendingDeletion: true,
  });
  await instance.choose({ usage: false, diagnostics: false });
  const saved = JSON.parse(await readFile(join(directory, "choices.json"), "utf8"));
  expect(saved.erase).toEqual([...tokens, oldToken]);
  expect(saved.receipt).toBeUndefined();
  expect(calls).toHaveLength(0);
});

test("transport failure retries original delivery IDs instead of losing the optional batch", async () => {
  let attempts = 0;
  const { instance, calls } = await fixture({
    fetch: async (action) => {
      if (action === "events" && ++attempts === 1) throw new Error("offline");
      return undefined;
    },
  });
  await instance.choose({ usage: true, diagnostics: false });
  instance.capture({ name: "harness_turn_started", harness: "claude" });
  await until(() => attempts === 1);
  await (instance as unknown as { flush(): Promise<void> }).flush();
  const batches = calls.filter((call) => call.action === "events");
  expect(batches).toHaveLength(2);
  expect(batches[1].body.events).toEqual(batches[0].body.events);
});

test("slow response bodies are canceled on withdrawal, refresh is deduplicated and local state never waits for it", async () => {
  let statusCalls = 0,
    canceled = false;
  const { instance, directory, calls } = await fixture({
    fetch: async (action) => {
      if (action !== "status") return undefined;
      statusCalls++;
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    },
  });
  await instance.choose({ usage: true, diagnostics: false });
  await until(() => calls.some((call) => call.action === "events"));
  const first = instance.refresh(),
    second = instance.refresh();
  expect(first).toBe(second);
  await until(() => statusCalls === 1);
  expect((await instance.state()).usage).toBe(true);
  await instance.choose({ usage: false, diagnostics: false });
  await first;
  expect(canceled).toBe(true);
  expect(await instance.state()).toMatchObject({ usage: false, linked: false });
  expect(
    JSON.parse(await readFile(join(directory, "choices.json"), "utf8")).receipt,
  ).toBeUndefined();
});

test("oversized privacy responses are canceled before parsing or opening a browser", async () => {
  let canceled = false;
  const { instance, calls } = await fixture({
    fetch: async (action) =>
      action === "link"
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(16_385));
              },
              cancel() {
                canceled = true;
              },
            }),
          )
        : undefined,
  });
  await instance.choose({ usage: true, diagnostics: false });
  await until(() => calls.some((call) => call.action === "events"));
  await expect(instance.link()).rejects.toThrow("Privacy response too large");
  expect(canceled).toBe(true);
});

test("unlink rotates reporting locally while offline and publishes a deletion-pending state", async () => {
  const { instance, calls, setOnline } = await fixture();
  await instance.choose({ usage: true, diagnostics: false });
  await until(() => calls.some((call) => call.action === "events"));
  setOnline(false);
  const changes: unknown[] = [];
  const unsubscribe = instance.subscribe((value) => changes.push(value));
  await instance.unlink();
  expect(await instance.state()).toMatchObject({
    usage: true,
    linked: false,
    pendingDeletion: true,
  });
  expect(changes.at(-1)).toMatchObject({ linked: false, pendingDeletion: true });
  unsubscribe();
});

test("a failed renderer subscriber cannot change a persisted privacy choice", async () => {
  const { instance } = await fixture();
  instance.subscribe(() => {
    throw new Error("renderer closed");
  });
  const values: unknown[] = [];
  instance.subscribe((value) => values.push(value));
  await expect(instance.choose({ usage: false, diagnostics: true })).resolves.toMatchObject({
    diagnostics: true,
  });
  expect(values.at(-1)).toMatchObject({ usage: false, diagnostics: true });
});

test("accepting an unchanged choice preserves its receipt and existing reports", async () => {
  const { instance, calls, directory } = await fixture();
  await instance.choose({ usage: true, diagnostics: true });
  await until(() => calls.some((call) => call.action === "events"));
  const before = JSON.parse(await readFile(join(directory, "choices.json"), "utf8"));
  await instance.choose({ usage: true, diagnostics: true });
  const after = JSON.parse(await readFile(join(directory, "choices.json"), "utf8"));
  expect(after.receipt.token).toBe(before.receipt.token);
  expect(after.erase).toEqual([]);
  expect(calls.some((call) => call.action === "erase")).toBe(false);
});

test("a link revision drops the earlier batch and resumes future activity without revoking consent", async () => {
  let attempts = 0;
  const { instance, calls } = await fixture({
    fetch: async (action, _body, init) => {
      if (action === "events" && ++attempts === 1) return new Response(null, { status: 409 });
      if (action === "status")
        return Response.json({
          token: new Headers(init?.headers).get("authorization")!.slice(7),
          revision: 2,
          linked: true,
          expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          choices: { usage: true, diagnostics: false },
        });
      return undefined;
    },
  });
  await instance.choose({ usage: true, diagnostics: false });
  instance.capture({ name: "harness_turn_started", harness: "claude" });
  await until(() => attempts >= 2);
  const batches = calls.filter((call) => call.action === "events");
  expect(batches[0].body.revision).toBe(1);
  expect(batches[1].body.revision).toBe(2);
  expect(JSON.stringify(batches[0].body)).toContain("harness_turn_started");
  expect(JSON.stringify(batches[1].body)).not.toContain("harness_turn_started");
  expect(await instance.state()).toMatchObject({ usage: true, linked: true });
});
