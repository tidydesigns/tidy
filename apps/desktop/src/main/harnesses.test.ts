import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessParser, startHarness, type HarnessUpdate } from "./harnesses";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy harness "));
  cleanups.push(directory);
  const executable = join(directory, "fixture-cli");
  await copyFile(new URL("./fixtures/harness.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  return { directory: await realpath(directory), executable };
}

for (const harness of ["codex", "claude"] as const) {
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
  test(`${harness} Auto explicitly enables full access; native prompts still require a decision`, async () => {
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

test("Claude startup failures cannot erase a resumed thread's recorded usage", () => {
  const updates: HarnessUpdate[] = [];
  createHarnessParser("claude", (update) => updates.push(update))({
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
