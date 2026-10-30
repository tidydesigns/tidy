import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateThreadTitle, generatedThreadTitle } from "./thread-naming";

let directory: string;
let executable: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tidy-naming-test-"));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/naming-agent.ts")],
    outdir: directory,
    target: "node",
  });
  if (!result.success) throw new AggregateError(result.logs);
  executable = result.outputs[0].path;
  await chmod(executable, 0o700);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

for (const harness of ["codex", "claude", "opencode"] as const) {
  test(`${harness} naming runs independently and rejects agent tool requests`, async () => {
    expect(
      await generateThreadTitle({
        executable,
        harness,
        model: "fixture/model",
        prompt: "Improve navigation",
        instructions: "Short task names",
        signal: new AbortController().signal,
      }),
    ).toBe("Tools disabled");
  });
}

test("aborted naming does not leave a waiting CLI process", async () => {
  const controller = new AbortController();
  const result = generateThreadTitle({
    executable,
    harness: "codex",
    prompt: "wait-for-cancel",
    instructions: "",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await expect(result).rejects.toThrow();
});

test("only a bounded single-line title is accepted", () => {
  expect(generatedThreadTitle("“Improve navigation”")).toBe("Improve navigation");
  expect(() => generatedThreadTitle("Title\nHere is an explanation")).toThrow();
  expect(() => generatedThreadTitle("a".repeat(121))).toThrow();
  expect(() => generatedThreadTitle("")).toThrow();
});
