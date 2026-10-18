import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, type HarnessUpdate } from "./harnesses";

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
