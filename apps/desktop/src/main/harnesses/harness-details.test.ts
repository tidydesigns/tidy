import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectHarness, validateHarnessSettings } from "./harness-details";
import type { HarnessId } from "../../shared/contracts/desktop";
const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tidy-capabilities-")));
  cleanups.push(directory);
  const executable = join(directory, "harness");
  await copyFile(new URL("../fixtures/harness.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  return { directory, executable };
}

test("older Codex catalogs cannot offer a toggle without explicit standard routing", async () => {
  const { directory, executable } = await fixture();
  await writeFile(join(directory, "legacy-speed-catalog"), "");
  const details = await inspectHarness(executable, "codex", directory);
  expect(details.models[0].supportsFastMode).toBe(false);
  await expect(
    validateHarnessSettings("codex", directory, { fastMode: true }, async () => details),
  ).rejects.toThrow("Fast mode");
});

test("Fast defaults come from the model catalog or native settings, including explicit standard", async () => {
  const { directory, executable } = await fixture();
  await writeFile(join(directory, "fast-default"), "");
  let details = await inspectHarness(executable, "codex", directory);
  expect(details.models[0].defaultFastMode).toBe(true);
  expect(details.defaultFastMode).toBeUndefined();
  await writeFile(join(directory, "standard-config-default"), "");
  details = await inspectHarness(executable, "codex", directory);
  expect(details.defaultFastMode).toBe(false);
  expect((await inspectHarness(executable, "claude", directory)).defaultFastMode).toBe(true);
});
for (const harness of ["codex", "claude"] as HarnessId[])
  test(`${harness} discovers models without starting a turn or exposing account details`, async () => {
    const { directory, executable } = await fixture();
    const details = await inspectHarness(executable, harness, directory);
    expect(details.models.map((model) => model.id)).toContain(`fixture-${harness}`);
    expect(details.models.find((model) => model.id === `fixture-${harness}`)?.efforts).toContain(
      "high",
    );
    expect(
      details.models.find((model) => model.id === `fixture-${harness}`)?.supportsFastMode,
    ).toBe(true);
    const invocation = JSON.parse(
      await readFile(join(directory, "capability-invocation.json"), "utf8"),
    );
    expect(invocation.cwd).toBe(directory);
    expect(invocation.methods).not.toContain("turn/start");
    expect(JSON.stringify(details)).not.toContain("private@example.invalid");
    expect(JSON.stringify(details)).not.toContain("do-not-expose");
    if (harness === "codex") {
      expect(details.defaultEffort).toBe("high");
      expect(details.windows[0].usedPercent).toBe(25);
    } else expect(details.windows).toEqual([]);
    await validateHarnessSettings(
      harness,
      directory,
      { model: `fixture-${harness}`, effort: "high" },
      async () => details,
    );
    await validateHarnessSettings(
      harness,
      directory,
      { model: `fixture-${harness}`, effort: "high", fastMode: true },
      async () => details,
    );
    await expect(
      validateHarnessSettings(harness, directory, { fastMode: true }, async () => ({
        ...details,
        models: details.models.map((model) => ({ ...model, supportsFastMode: false })),
      })),
    ).rejects.toThrow("Fast mode");
    await validateHarnessSettings(harness, directory, { fastMode: false }, async () => details);
    await expect(
      validateHarnessSettings(
        harness,
        directory,
        { model: "not-in-the-catalog" },
        async () => details,
      ),
    ).rejects.toThrow("offered");
    await expect(
      validateHarnessSettings(
        harness,
        directory,
        { model: `fixture-${harness}`, effort: "ultra" },
        async () => details,
      ),
    ).rejects.toThrow("effort");
  });
