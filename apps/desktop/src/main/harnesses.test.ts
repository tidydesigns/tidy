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
    expect(invocation.prompt).toBe(prompt);
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
    expect(resumed.args).toContain(sessionId);
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

test("model and effort are passed to the selected CLI as literal arguments", async () => {
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
    expect(invocation.args.slice(-4)).toEqual(
      harness === "codex"
        ? ["--model", "fixture-codex", "-c", 'model_reasoning_effort="high"']
        : ["--model", "fixture-claude", "--effort", "high"],
    );
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
        expect(invocation.args.slice(-2)).toEqual(["--image", imagePath]);
        expect(invocation.prompt).toBe("Describe this image");
      } else {
        expect(invocation.args.slice(-2)).toEqual(["--input-format", "stream-json"]);
        const message = JSON.parse(invocation.prompt);
        expect(message.type).toBe("user");
        expect(message.session_id).toBe(sessionId ?? "");
        expect(message.message.content).toEqual([
          { type: "text", text: "Describe this image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
        ]);
      }
      if (sessionId) expect(invocation.args).toContain(sessionId);
    }
});
