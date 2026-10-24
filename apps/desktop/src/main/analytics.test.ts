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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-analytics-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const calls: { action: string; body: Record<string, unknown>; authorization: string | null }[] =
    [];
  let online = true;
  let now = Date.now();
  let count = 0;
  const instance = new DesktopAnalytics({
    state: new PrivateState(directory),
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
