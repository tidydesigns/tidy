import { z } from "zod";
import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeParser,
  findHarness,
  harnessEnvironment,
  startHarness,
  type HarnessUpdate,
} from "./harnesses";
import { delimiter, dirname, isAbsolute } from "node:path";
import { harnessSettingsSchema } from "../../shared/contracts/harness-settings";

test("executable discovery ignores relative PATH entries and resolves an absolute executable", async () => {
  expect(
    await findHarness("codex", { PATH: [".", "node_modules/.bin", ""].join(delimiter) }),
  ).toBeNull();
  const { executable } = await fixture();
  const codex = join(dirname(executable), "codex");
  await copyFile(executable, codex);
  await chmod(codex, 0o700);
  expect(await findHarness("codex", { PATH: [".", dirname(executable)].join(delimiter) })).toBe(
    await realpath(codex),
  );
  expect(harnessEnvironment().PATH!.split(delimiter).every(isAbsolute)).toBe(true);
  for (const model of ["--dangerously-skip-permissions", "-x", "bad\nmodel", "\0model"])
    expect(harnessSettingsSchema.safeParse({ model }).success).toBe(false);
});

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy harness "));
  cleanups.push(directory);
  const executable = join(directory, "fixture-cli");
  await copyFile(new URL("../fixtures/harness.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  return { directory: await realpath(directory), executable };
}

for (const harness of ["codex", "claude"] as const) {
  for (const variant of ["oversized-approval", "bidi-approval"])
    test(`${harness} cannot approve hidden truncated actions and displays directional controls literally: ${variant}`, async () => {
      const { directory, executable } = await fixture();
      let received!: (request: Extract<HarnessUpdate, { type: "approval" }>["request"]) => void;
      const approval = new Promise<Extract<HarnessUpdate, { type: "approval" }>["request"]>(
        (resolve) => {
          received = resolve;
        },
      );
      const run = startHarness({
        harness,
        executable,
        cwd: directory,
        prompt: `permission-fixture ${variant}`,
        onUpdate: (event) => {
          if (event.type === "approval") received(event.request);
        },
      });
      try {
        const request = await approval;
        if (variant === "oversized-approval") {
          expect(request.shortened).toBe(true);
          expect(request.choices).toEqual(["deny"]);
          expect(run.respondToApproval!(request.id, "allow")).toBe(false);
          expect(run.respondToApproval!(request.id, "allow-session")).toBe(false);
        } else {
          expect(request.details).toContain("\\u202e");
          expect(request.details).not.toContain("\u202e");
        }
        expect(run.respondToApproval!(request.id, "deny")).toBe(true);
        await run.done;
        await expect(stat(join(directory, "approved.txt"))).rejects.toThrow();
      } finally {
        run.stop();
        await run.done.catch(() => {});
      }
    });
  for (const decision of [
    "allow",
    "deny",
    ...(harness === "codex" ? ["allow-session" as const] : []),
  ] as const) {
    test(`${harness} waits for an explicit ${decision} decision before a protected action`, async () => {
      const { directory, executable } = await fixture();
      let received!: (request: Extract<HarnessUpdate, { type: "approval" }>["request"]) => void;
      const approval = new Promise<Extract<HarnessUpdate, { type: "approval" }>["request"]>(
        (resolve) => {
          received = resolve;
        },
      );
      const updates: HarnessUpdate[] = [];
      const run = startHarness({
        harness,
        executable,
        cwd: directory,
        prompt: "permission-fixture",
        settings: { permissionMode: "default" },
        onUpdate: (update) => {
          updates.push(update);
          if (update.type === "approval") received(update.request);
        },
      });
      try {
        const request = await approval;
        expect(request.details).toContain("touch approved.txt");
        expect(request.reason).toBe("This action needs permission.");
        await expect(stat(join(directory, "approved.txt"))).rejects.toThrow();
        expect(run.respondToApproval!("stale-id", "allow")).toBe(false);
        if (harness === "claude")
          expect(run.respondToApproval!(request.id, "allow-session")).toBe(false);
        expect(run.respondToApproval!(request.id, decision)).toBe(true);
        expect(run.respondToApproval!(request.id, "allow")).toBe(false);
        await run.done;
        if (decision === "deny")
          await expect(stat(join(directory, "approved.txt"))).rejects.toThrow();
        else expect(await readFile(join(directory, "approved.txt"), "utf8")).toBe("approved");
        expect(
          updates.some((update) => update.type === "approval-resolved" && update.id === request.id),
        ).toBe(true);
        const response = JSON.parse(
          await readFile(join(directory, "permission-response.json"), "utf8"),
        );
        expect(
          harness === "codex" ? response.result.decision : response.response.response.behavior,
        ).toBe(
          harness === "codex"
            ? decision === "allow"
              ? "accept"
              : decision === "allow-session"
                ? "acceptForSession"
                : "decline"
            : decision === "deny"
              ? "deny"
              : "allow",
        );
      } finally {
        run.stop();
        await run.done.catch(() => {});
      }
    });
  }
  test(`${harness} Full access explicitly bypasses routine approval; native prompts still require a decision`, async () => {
    const { directory, executable } = await fixture();
    const updates: HarnessUpdate[] = [];
    await startHarness({
      harness,
      executable,
      cwd: directory,
      prompt: "permission-fixture",
      settings: { permissionMode: "auto" },
      onUpdate: (update) => updates.push(update),
    }).done;
    expect(await readFile(join(directory, "approved.txt"), "utf8")).toBe("approved");
    expect(updates.some((update) => update.type === "approval")).toBe(false);
    const invocation = JSON.parse(
      await readFile(join(directory, "harness-invocation.json"), "utf8"),
    );
    if (harness === "codex")
      expect(invocation.threadParams).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      });
    else {
      expect(invocation.args).toContain("bypassPermissions");
      expect(invocation.args).toContain("--allow-dangerously-skip-permissions");
    }
    let resolve!: () => void;
    const asked = new Promise<void>((done) => {
      resolve = done;
    });
    const run = startHarness({
      harness,
      executable,
      cwd: directory,
      prompt: "permission-fixture force-ask",
      settings: { permissionMode: "auto" },
      onUpdate: (update) => {
        if (update.type === "approval") resolve();
      },
    });
    await asked;
    run.stop();
    await run.done;
  });
  test(`${harness} stopping or native cancellation invalidates an unanswered permission request`, async () => {
    const { directory, executable } = await fixture();
    for (const cancel of [false, true]) {
      let resolve!: () => void,
        id = "";
      const asked = new Promise<void>((done) => {
        resolve = done;
      });
      const run = startHarness({
        harness,
        executable,
        cwd: directory,
        prompt: `permission-fixture${cancel ? " cancel-request" : ""}`,
        onUpdate: (update) => {
          if (update.type === "approval") {
            id = update.request.id;
            if (!cancel) resolve();
          }
          if (cancel && update.type === "approval-resolved") resolve();
        },
      });
      await asked;
      if (cancel) expect(run.respondToApproval!(id, "allow")).toBe(false);
      run.stop();
      await run.done;
      expect(run.respondToApproval!(id, "allow")).toBe(false);
      await expect(stat(join(directory, "approved.txt"))).rejects.toThrow();
    }
  });
  test(`${harness} streams inspectable tool activity without treating a failed test as a failed turn`, async () => {
    const { directory, executable } = await fixture();
    const updates: HarnessUpdate[] = [];
    await startHarness({
      harness,
      executable,
      cwd: directory,
      prompt: "tool-activity-fixture",
      onUpdate: (update) => updates.push(update),
    }).done;
    const tools = new Map(
      updates
        .filter((update) => update.type === "tool")
        .map((update) => [update.tool.id, update.tool]),
    );
    expect([...tools.values()].map((tool) => tool.kind)).toEqual([
      "test",
      "search",
      "edit",
      "test",
    ]);
    expect(tools.get("test")).toMatchObject({
      status: "failed",
      output: expect.stringContaining("1 failed, 2 passed"),
    });
    expect(tools.get("verify")).toMatchObject({
      status: "completed",
      output: "3 passed\n0 failed",
    });
    expect(tools.get("edit")?.files?.[0].path).toBe("src/button.tsx");
    expect(updates.some((update) => update.type === "error")).toBe(false);
  });
  test(`${harness} uses the exact project cwd, pipes prompts literally and resumes its session`, async () => {
    const { directory, executable } = await fixture();
    const updates: HarnessUpdate[] = [];
    const prompt = "Read ./design.json; do not execute $(touch injected) or `touch injected`.";
    const run = startHarness({
      harness,
      executable,
      cwd: directory,
      prompt,
      onUpdate: (value) => updates.push(value),
    });
    await run.done;
    const invocation = JSON.parse(
      await readFile(join(directory, "harness-invocation.json"), "utf8"),
    );
    expect(invocation.cwd).toBe(directory);
    expect(
      harness === "codex"
        ? invocation.prompt
        : JSON.parse(invocation.prompt).message.content[0].text,
    ).toBe(prompt);
    expect(invocation.inheritedElectron).toBeUndefined();
    expect(invocation.database).toBeUndefined();
    expect(updates.some((value) => value.type === "session")).toBe(true);
    expect(JSON.stringify(updates)).not.toContain("private reasoning");
    await expect(stat(join(directory, "injected"))).rejects.toThrow();
    const sessionId = "b56ba7bb-00aa-4a56-a64c-593c3c377dcc";
    await startHarness({
      harness,
      executable,
      cwd: directory,
      prompt: "Continue",
      sessionId,
      onUpdate: () => {},
    }).done;
    const resumed = JSON.parse(await readFile(join(directory, "harness-invocation.json"), "utf8"));
    if (harness === "codex") expect(resumed.threadParams.threadId).toBe(sessionId);
    else expect(resumed.args).toContain(sessionId);
    expect(resumed.args).not.toContain("--last");
    expect(resumed.args).not.toContain("--dangerously-skip-permissions");
    expect(resumed.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
}

test("stopping a harness kills its command tree and ignores late output", async () => {
  const { directory, executable } = await fixture();
  let run: ReturnType<typeof startHarness>;
  const started = new Promise<void>((resolve) => {
    run = startHarness({
      harness: "codex",
      executable,
      cwd: directory,
      prompt: "wait-for-stop",
      onUpdate: () => resolve(),
    });
  });
  await started;
  run!.stop();
  await run!.done;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await expect(stat(join(directory, "orphan.txt"))).rejects.toThrow();
});

test("invalid harness output fails instead of completing an empty thread", async () => {
  const { directory, executable } = await fixture();
  const run = startHarness({
    harness: "codex",
    executable,
    cwd: directory,
    prompt: "invalid-event",
    onUpdate: () => {},
  });
  await expect(run.done).rejects.toThrow("invalid event");
});

test("model and effort reach the native harness protocol literally", async () => {
  const { directory, executable } = await fixture();
  for (const harness of ["codex", "claude"] as const) {
    const updates: HarnessUpdate[] = [];
    await startHarness({
      harness,
      executable,
      cwd: directory,
      prompt: "Run with settings",
      settings: { model: `fixture-${harness}`, effort: "high" },
      onUpdate: (update) => updates.push(update),
    }).done;
    const invocation = JSON.parse(
      await readFile(join(directory, "harness-invocation.json"), "utf8"),
    );
    if (harness === "codex") {
      expect(invocation.threadParams.model).toBe("fixture-codex");
      expect(invocation.threadParams.config.model_reasoning_effort).toBe("high");
      expect(invocation.turnParams.effort).toBe("high");
    } else
      expect(invocation.args.slice(-4)).toEqual(["--model", "fixture-claude", "--effort", "high"]);
    const usage = updates.find((update) => update.type === "usage");
    expect(usage?.type === "usage" ? usage.usage.inputTokens : undefined).toBe(
      harness === "codex" ? 120 : 125,
    );
  }
});

test("Claude reports the thinking phase without retaining reasoning text or signatures", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((update) => updates.push(update));
  parse({ type: "stream_event", event: { type: "message_start", message: { id: "reply" } } });
  parse({
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "thinking", thinking: "private reasoning" },
    },
  });
  parse({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private reasoning" },
    },
  });
  parse({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "signature_delta", signature: "private signature" },
    },
  });
  parse({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Visible reply" } },
  });
  expect(updates).toEqual([
    { type: "activity", activity: "Working" },
    { type: "activity", activity: "Thinking" },
    { type: "message", id: "reply", text: "Visible reply", append: true },
  ]);
});

test("Claude startup failures cannot erase a resumed thread's recorded usage", () => {
  const updates: HarnessUpdate[] = [];
  createClaudeParser((update) => updates.push(update))({
    type: "result",
    is_error: true,
    errors: ["Could not start"],
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    total_cost_usd: 0,
  });
  expect(updates.some((update) => update.type === "usage")).toBe(false);
  expect(updates.some((update) => update.type === "error")).toBe(true);
});

test("images reach both native harness protocols on new and resumed turns", async () => {
  const { directory, executable } = await fixture();
  const imagePath = join(directory, "image with spaces;literal.png");
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSkcAAAAASUVORK5CYII=";
  for (const harness of ["codex", "claude"] as const)
    for (const sessionId of [undefined, "b56ba7bb-00aa-4a56-a64c-593c3c377dcc"]) {
      await startHarness({
        harness,
        executable,
        cwd: directory,
        prompt: "Describe this image",
        sessionId,
        images: [{ path: imagePath, mimeType: "image/png", data }],
        onUpdate: () => {},
      }).done;
      const invocation = JSON.parse(
        await readFile(join(directory, "harness-invocation.json"), "utf8"),
      );
      if (harness === "codex") {
        expect(invocation.turnParams.input[1]).toEqual({ type: "localImage", path: imagePath });
        expect(invocation.prompt).toBe("Describe this image");
      } else {
        expect(invocation.args).toContain("--input-format");
        expect(invocation.args).toContain("--permission-prompt-tool");
        const message = JSON.parse(invocation.prompt);
        expect(message.type).toBe("user");
        expect(message.session_id).toBe(sessionId ?? "");
        expect(message.message.content).toEqual([
          { type: "text", text: "Describe this image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
        ]);
      }
      if (sessionId) {
        if (harness === "codex") expect(invocation.threadParams.threadId).toBe(sessionId);
        else expect(invocation.args).toContain(sessionId);
      }
    }
});

for (const harness of ["codex", "claude"] as const) {
  test.each(["/", "$"])(
    `${harness} sends %s skill invocation separately from context and preserves images on resume`,
    async (prefix) => {
      const { directory, executable } = await fixture();
      const image = { path: join(directory, "image.png"), mimeType: "image/png", data: "aW1hZ2U=" };
      const invocation =
        harness === "codex"
          ? {
              kind: "file" as const,
              name: "review",
              description: "Review",
              path: join(directory, "SKILL.md"),
            }
          : { kind: "command" as const, name: "review", description: "Review" };
      const run = startHarness({
        harness,
        executable,
        cwd: directory,
        sessionId: "existing-session",
        prompt: "Context\n/review arguments",
        skill: {
          invocation,
          context: "Project context",
          prompt: `${prefix}review arguments\nsecond line`,
        },
        images: [image],
        onUpdate() {},
      });
      try {
        await run.done;
        const recorded = z
          .object({ turnParams: z.unknown().optional(), prompt: z.string() })
          .parse(JSON.parse(await readFile(join(directory, "harness-invocation.json"), "utf8")));
        if (harness === "codex") {
          const turn = z.object({ input: z.array(z.unknown()) }).parse(recorded.turnParams);
          expect(turn.input).toContainEqual({
            type: "skill",
            name: "review",
            path: invocation.kind === "file" ? invocation.path : "",
          });
          expect(turn.input[0]).toMatchObject({
            text: "Project context\n\nUser request:\n\n$review arguments\nsecond line",
          });
          expect(turn.input).toContainEqual({ type: "localImage", path: image.path });
        } else {
          const message = z
            .object({
              session_id: z.string(),
              message: z.object({ content: z.array(z.unknown()) }),
            })
            .parse(JSON.parse(recorded.prompt));
          const texts = message.message.content.slice(0, 2);
          expect(texts).toEqual([
            { type: "text", text: "Project context" },
            { type: "text", text: "/review arguments\nsecond line" },
          ]);
          expect(message.message.content).toContainEqual({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image.data },
          });
          expect(message.session_id).toBe("existing-session");
        }
      } finally {
        run.stop();
        await run.done.catch(() => {});
      }
    },
  );
}

test.each(["codex", "claude"] as const)(
  "%s receives only the explicitly supplied workspace design directories",
  async (harness) => {
    const { directory, executable } = await fixture();
    const roots = [join(directory, "designs"), join(directory, "assets")];
    const run = startHarness({
      harness,
      executable,
      cwd: directory,
      prompt: "Hello",
      additionalDirectories: roots,
      onUpdate() {},
    });
    try {
      await run.done;
      const invocation = JSON.parse(
        await readFile(join(directory, "harness-invocation.json"), "utf8"),
      );
      if (harness === "codex") {
        expect(invocation.threadParams.config["sandbox_workspace_write.writable_roots"]).toEqual(
          roots,
        );
        expect(invocation.threadParams.sandbox).toBe("workspace-write");
        expect(invocation.threadParams.approvalPolicy).toBe("on-request");
      } else {
        for (const root of roots) {
          const index = invocation.args.indexOf(root);
          expect(index).toBeGreaterThan(0);
          expect(invocation.args[index - 1]).toBe("--add-dir");
        }
      }
    } finally {
      run.stop();
      await run.done.catch(() => {});
    }
  },
);

test("read-only Codex workspace threads retain read-only permissions with external design references", async () => {
  const { directory, executable } = await fixture();
  const run = startHarness({
    harness: "codex",
    executable,
    cwd: directory,
    prompt: "Inspect",
    settings: { permissionMode: "read-only" },
    additionalDirectories: [join(directory, "designs")],
    onUpdate() {},
  });
  try {
    await run.done;
    const invocation = JSON.parse(
      await readFile(join(directory, "harness-invocation.json"), "utf8"),
    );
    expect(invocation.threadParams.sandbox).toBe("read-only");
    expect(invocation.threadParams.approvalPolicy).toBe("on-request");
    expect(
      invocation.threadParams.config?.["sandbox_workspace_write.writable_roots"],
    ).toBeUndefined();
  } finally {
    run.stop();
    await run.done.catch(() => {});
  }
});

test("Claude preserves provider errors from assistant events and result error arrays", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((update) => updates.push(update));
  parse({
    type: "assistant",
    error: "authentication_failed",
    message: { content: [{ type: "text", text: "Please sign in again" }] },
  });
  parse({ type: "result", is_error: true, errors: ["Provider overloaded", "Try later"] });
  expect(updates).toEqual([
    { type: "error", text: "Please sign in again", kind: "authentication" },
    { type: "error", text: "Provider overloaded\nTry later", kind: "unavailable" },
  ]);
});

test("Claude subagent errors do not fail the parent turn", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((update) => updates.push(update));
  parse({
    type: "assistant",
    parent_tool_use_id: "tool-1",
    error: "rate_limit",
    message: { content: [{ type: "text", text: "Too many requests" }] },
  });
  expect(updates.some((update) => update.type === "error")).toBe(false);
});

for (const [subtype, kind] of [
  ["error_max_turns", "turn-limit"],
  ["error_max_budget_usd", "budget"],
  ["error_max_structured_output_retries", "output-format"],
  ["error_during_execution", "unknown"],
] as const) {
  test(`Claude terminal subtype ${subtype} fails even without is_error`, () => {
    const updates: HarnessUpdate[] = [];
    createClaudeParser((value) => updates.push(value))({
      type: "result",
      subtype,
      is_error: false,
    });
    expect(updates.at(-1)).toMatchObject({ type: "error", kind });
  });
}

for (const terminal_reason of ["prompt_too_long", "image_error", "budget_exhausted"] as const) {
  test(`Claude retains terminal reason ${terminal_reason}`, () => {
    const updates: HarnessUpdate[] = [];
    createClaudeParser((value) => updates.push(value))({
      type: "result",
      subtype: "error_during_execution",
      terminal_reason,
      is_error: true,
    });
    expect(updates.at(-1)).toMatchObject({
      type: "error",
      kind:
        terminal_reason === "prompt_too_long"
          ? "context"
          : terminal_reason === "image_error"
            ? "attachment"
            : "budget",
    });
  });
}

test("Claude refuses explicitly without misclassifying successful output truncation", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((value) => updates.push(value));
  parse({
    type: "result",
    subtype: "success",
    stop_reason: "max_tokens",
    result: "Partial output",
  });
  expect(updates.some((value) => value.type === "error")).toBe(false);
  parse({
    type: "result",
    subtype: "success",
    stop_reason: "refusal",
    result: "The model declined this request.",
  });
  expect(updates.at(-1)).toMatchObject({ type: "error", kind: "policy" });
});

test("Claude refusal fallback clears only the pending provider failure", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((value) => updates.push(value));
  parse({
    type: "system",
    subtype: "model_refusal_no_fallback",
    api_refusal_explanation: "Policy blocked this request",
  });
  parse({ type: "system", subtype: "model_refusal_fallback", scope: "local" });
  expect(updates.at(-1)).toMatchObject({ type: "error", kind: "policy" });
  parse({ type: "system", subtype: "model_refusal_fallback", scope: "session" });
  expect(updates.at(-1)).toEqual({ type: "error-cleared", text: "Policy blocked this request" });
  parse({ type: "result", subtype: "success", result: "Recovered" });
  expect(updates.at(-1)).toMatchObject({ type: "message", text: "Recovered" });
});

test("Claude no-fallback refusals survive generic successful-looking result frames", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((value) => updates.push(value));
  parse({
    type: "system",
    subtype: "model_refusal_no_fallback",
    content: "Policy refused this request",
  });
  parse({ type: "result", subtype: "success", is_error: false });
  expect(updates.at(-1)).toMatchObject({ type: "error", kind: "policy" });
});

test("Claude warnings and retries do not fail turns, rejected limits can recover", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((value) => updates.push(value));
  parse({ type: "system", subtype: "api_retry", error: "overloaded" });
  parse({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } });
  expect(updates).toEqual([]);
  parse({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
  expect(updates.at(-1)).toMatchObject({ type: "error", kind: "rate-limit" });
  parse({ type: "result", subtype: "success", is_error: false });
  expect(updates.at(-1)).toMatchObject({ type: "error-cleared" });
});
