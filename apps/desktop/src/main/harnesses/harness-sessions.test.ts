import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HarnessSession } from "./interactive-harness";
import { HarnessSessions } from "./harness-sessions";
import { harnessIdSchema, nativeSessionIdSchema } from "../../shared/contracts/desktop";
import type { HarnessUpdate } from "./harnesses";
let directory: string;
let executable: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tidy-sessions-"));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/session-agent.ts")],
    outdir: directory,
    target: "node",
    packages: "bundle",
  });
  if (!result.success) throw new AggregateError(result.logs);
  executable = result.outputs[0].path;
  await chmod(executable, 0o700);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const eventsSchema = z.array(
  z.object({ pid: z.number(), method: z.string().optional(), type: z.string().optional() }),
);
async function events(cwd: string) {
  return eventsSchema.parse(
    (await readFile(join(cwd, "session-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
}

for (const harness of harnessIdSchema.options) {
  test(`${harness} retains one connection across turns and interrupt, with isolated turn callbacks`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-`));
    const session = new HarnessSession({ harness, executable, cwd });
    try {
      await session.ready;
      const first: HarnessUpdate[] = [];
      await session.start({ prompt: "first", onUpdate: (update) => first.push(update) }).done;
      const firstCount = first.length;
      const started = Promise.withResolvers<void>();
      const stopped = session.start({
        prompt: "hold",
        onUpdate: (update) => {
          if (update.type === "started") started.resolve();
        },
      });
      await started.promise;
      stopped.stop();
      await stopped.done;
      stopped.stop();
      const last: HarnessUpdate[] = [];
      await session.start({ prompt: "last", onUpdate: (update) => last.push(update) }).done;
      expect(first).toHaveLength(firstCount);
      expect(last.filter((update) => update.type === "started")).toHaveLength(1);
      expect(last.some((update) => update.type === "message" && update.text === "OK")).toBe(true);
      const recorded = await events(cwd);
      expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
      expect(recorded.filter((event) => event.method === "initialize")).toHaveLength(1);
      expect(
        recorded.filter(
          (event) =>
            event.method === "turn/start" ||
            event.method === "session/prompt" ||
            event.type === "user",
        ),
      ).toHaveLength(3);
    } finally {
      session.close();
      await session.done;
    }
  });
  test(`${harness} rejects stale approvals after cancellation and accepts fresh approvals on the next turn`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-approval-`));
    const session = new HarnessSession({ harness, executable, cwd });
    try {
      const pending = Promise.withResolvers<string>();
      const first = session.start({
        prompt: "approve",
        onUpdate: (update) => {
          if (update.type === "approval") pending.resolve(update.request.id);
        },
      });
      const id = await pending.promise;
      first.stop();
      await first.done;
      expect(first.respondToApproval?.(id, "allow")).toBe(false);
      const nextApproval = Promise.withResolvers<string>();
      const next = session.start({
        prompt: "approve",
        onUpdate: (update) => {
          if (update.type === "approval") nextApproval.resolve(update.request.id);
        },
      });
      const nextId = await nextApproval.promise;
      expect(nextId).not.toBe(id);
      expect(next.respondToApproval?.(id, "allow")).toBe(false);
      expect(next.respondToApproval?.(nextId, "deny")).toBe(true);
      await next.done;
    } finally {
      session.close();
      await session.done;
    }
  });
  test(`${harness} shares the idle budget with composer preparation and recreates evicted sessions`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-cache-`));
    const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 60_000 });
    const context = { harness, executable, cwd };
    try {
      await sessions.warm("project", context);
      expect(
        (await events(cwd)).filter(
          (event) =>
            event.method === "turn/start" ||
            event.method === "session/prompt" ||
            event.type === "user",
        ),
      ).toHaveLength(0);
      await sessions.start("first", { ...context, prompt: "first", onUpdate() {} }).done;
      const first = await events(cwd);
      expect(new Set(first.map((event) => event.pid)).size).toBe(1);
      await sessions.start("second", { ...context, prompt: "second", onUpdate() {} }).done;
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
    } finally {
      await sessions.clear();
    }
  });
}

test("an unresponsive interrupt closes the connection before a later turn can use it", async () => {
  const cwd = await mkdtemp(join(directory, "stubborn-"));
  const session = new HarnessSession({ harness: "codex", executable, cwd });
  const started = Promise.withResolvers<void>();
  try {
    const turn = session.start({
      prompt: "stubborn",
      onUpdate: (update) => {
        if (update.type === "started") started.resolve();
      },
    });
    await started.promise;
    turn.stop();
    await turn.done;
    await session.done;
    expect(session.available).toBe(false);
    expect(() => session.start({ prompt: "next", onUpdate() {} })).toThrow("unavailable");
  } finally {
    session.close();
    await session.done;
  }
});

test("idle expiry, settings changes and crashes recreate connections without replaying a prompt", async () => {
  const cwd = await mkdtemp(join(directory, "recovery-"));
  const sessions = new HarnessSessions({ idleLimit: 2, idleMs: 25 });
  const context = { harness: "codex" as const, executable, cwd };
  const send = (prompt: string, model?: string) =>
    sessions.start("thread", { ...context, settings: { model }, prompt, onUpdate() {} }).done;
  try {
    await send("first");
    await send("model change", "other");
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(send("crash", "other")).rejects.toThrow();
    await send("recover", "other");
    const recorded = await events(cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(4);
    expect(recorded.filter((event) => event.method === "turn/start")).toHaveLength(4);
  } finally {
    await sessions.clear();
  }
});

test("idle cleanup preserves active turns and discarded handles cannot interrupt their successor", async () => {
  const cwd = await mkdtemp(join(directory, "active-"));
  const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 25 });
  const context = { harness: "codex" as const, executable, cwd };
  try {
    const started = Promise.withResolvers<void>();
    const first = sessions.start("thread", {
      ...context,
      prompt: "hold",
      onUpdate: (update) => {
        if (update.type === "started") started.resolve();
      },
    });
    await started.promise;
    await sessions.clear({ idleOnly: true });
    expect(first.deliveryState).toBe("accepted");
    first.stop();
    await first.done;
    const nextStarted = Promise.withResolvers<void>();
    const next = sessions.start("thread", {
      ...context,
      prompt: "hold",
      onUpdate: (update) => {
        if (update.type === "started") nextStarted.resolve();
      },
    });
    await nextStarted.promise;
    first.stop();
    expect(next.deliveryState).toBe("accepted");
    next.stop();
    await next.done;
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
  } finally {
    await sessions.clear();
  }
});

test("interrupt waits for the native turn to start after its early acceptance acknowledgement", async () => {
  const cwd = await mkdtemp(join(directory, "early-stop-"));
  const session = new HarnessSession({ harness: "codex", executable, cwd });
  try {
    const run = session.start({
      prompt: "early-stop hold",
      onUpdate: (update) => {
        if (update.type === "started") run.stop();
      },
    });
    await run.done;
    expect(session.available).toBe(true);
    await session.start({ prompt: "continue", onUpdate() {} }).done;
  } finally {
    session.close();
    await session.done;
  }
});

test("OpenCode preserves selected model, native command and image inputs and reports turn usage", async () => {
  const cwd = await mkdtemp(join(directory, "inputs-"));
  const session = new HarnessSession({
    harness: "opencode",
    executable,
    cwd,
    settings: { model: "fixture/model" },
  });
  const updates: HarnessUpdate[] = [];
  try {
    await session.start({
      prompt: "Project context /review file",
      skill: {
        invocation: { kind: "command", name: "review", description: "Review" },
        prompt: "/review file",
        context: "Project context",
      },
      images: [{ path: join(cwd, "image.png"), mimeType: "image/png", data: "aW1hZ2U=" }],
      onUpdate: (update) => updates.push(update),
    }).done;
    const recorded = z
      .array(
        z.object({
          method: z.string().optional(),
          value: z.object({ params: z.unknown().optional() }),
        }),
      )
      .parse(
        (await readFile(join(cwd, "session-events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    expect(
      recorded.find((event) => event.method === "session/set_config_option")?.value.params,
    ).toMatchObject({ configId: "model", value: "fixture/model" });
    expect(recorded.find((event) => event.method === "session/prompt")?.value.params).toMatchObject(
      {
        prompt: [
          { type: "text", text: "/review file\n\nProject context" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
    );
    expect(updates.find((update) => update.type === "usage")).toMatchObject({
      cumulative: false,
      usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 8 },
    });
  } finally {
    session.close();
    await session.done;
  }
});

test("OpenCode ignores replayed history while loading an opaque native session identifier", async () => {
  const cwd = await mkdtemp(join(directory, "resume-"));
  const session = new HarnessSession({
    harness: "opencode",
    executable,
    cwd,
    sessionId: "ses_fixture",
  });
  const updates: HarnessUpdate[] = [];
  try {
    await session.start({ prompt: "Continue", onUpdate: (update) => updates.push(update) }).done;
    expect(session.sessionId).toBe("ses_fixture");
    expect(nativeSessionIdSchema.safeParse("--permission-mode").success).toBe(false);
    expect(updates.filter((update) => update.type === "message")).toEqual([
      { type: "message", id: expect.any(String), text: "OK", append: true },
    ]);
  } finally {
    session.close();
    await session.done;
  }
});

test("concurrent capability requests share initialization and close their temporary connection", async () => {
  const cwd = await mkdtemp(join(directory, "metadata-"));
  const { withHarnessConnection } = await import("./harness-connection");
  const input = { harness: "codex" as const, executable, cwd };
  await Promise.all(
    [0, 1].map(() =>
      withHarnessConnection(input, async (request) => {
        await request("initialize");
        await request("thread/start");
      }),
    ),
  );
  const recorded = await events(cwd);
  expect(recorded.filter((event) => event.method === "initialize")).toHaveLength(1);
  expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
  const pid = recorded[0].pid;
  expect(() => process.kill(pid, 0)).toThrow();
});
