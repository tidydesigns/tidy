import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, type HarnessUpdate } from "./harnesses";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each([false, true])(
  "native steering preserves text, images and selected skills: %s",
  async (withSkill) => {
    const cwd = await mkdtemp(join(tmpdir(), "tidy-native-steering-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const executable = join(cwd, "agent");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  else if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: 'b56ba7bb-00aa-4a56-a64c-593c3c377dcc' } } });
  else if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: 'active-turn' } } });
  } else if (value.method === 'turn/steer') {
    writeFileSync('steer.json', JSON.stringify(value.params));
    send({ id: value.id, result: { turnId: 'active-turn' } });
    send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'Direction changed' } });
    send({ method: 'turn/completed', params: { turn: { id: 'active-turn', status: 'completed' } } });
  }
}
`,
    );
    await chmod(executable, 0o700);
    const updates: HarnessUpdate[] = [];
    const run = startHarness({
      harness: "codex",
      executable,
      cwd,
      prompt: "Original task",
      onUpdate: (update) => updates.push(update),
    });
    cleanups.push(async () => {
      run.stop();
      await run.done.catch(() => {});
    });
    expect(
      await run.steer?.({
        prompt: "Use the new direction",
        skill: withSkill
          ? {
              invocation: {
                kind: "file",
                name: "review",
                description: "Review",
                path: join(cwd, "SKILL.md"),
              },
              context: "Project context",
              prompt: "/review new direction",
            }
          : undefined,
        images: [{ path: join(cwd, "image.png"), mimeType: "image/png", data: "" }],
      }),
    ).toBe(true);
    await run.done;
    const sent: unknown = JSON.parse(await readFile(join(cwd, "steer.json"), "utf8"));
    expect(sent).toEqual({
      threadId: "b56ba7bb-00aa-4a56-a64c-593c3c377dcc",
      expectedTurnId: "active-turn",
      input: [
        {
          type: "text",
          text: withSkill
            ? "Project context\n\nUser request:\n\n$review new direction"
            : "Use the new direction",
          text_elements: [],
        },
        ...(withSkill ? [{ type: "skill", name: "review", path: join(cwd, "SKILL.md") }] : []),
        { type: "localImage", path: join(cwd, "image.png") },
      ],
    });
    expect(updates).toContainEqual({
      type: "message",
      id: "answer",
      text: "Direction changed",
      append: true,
    });
    expect(await run.steer?.({ prompt: "Too late", images: [] })).toBe(false);
  },
);

test.each(["thread/start", "turn/start"])(
  "native startup rejection tracks retry safety at %s",
  async (method) => {
    const cwd = await mkdtemp(join(tmpdir(), "tidy-startup-rejection-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const executable = join(cwd, "agent");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method === ${JSON.stringify(method)}) send({ id: value.id, error: { code: -32603, message: 'Startup rejected' } });
  else if (value.method === 'initialize') send({ id: value.id, result: {} });
  else if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: 'b56ba7bb-00aa-4a56-a64c-593c3c377dcc' } } });
}
`,
    );
    await chmod(executable, 0o700);
    const run = startHarness({
      harness: "codex",
      executable,
      cwd,
      prompt: "Try this",
      onUpdate() {},
    });
    cleanups.push(async () => {
      run.stop();
      await run.done.catch(() => {});
    });
    await expect(run.done).rejects.toThrow("Startup rejected");
    expect(run.deliveryState).toBe(method === "turn/start" ? "rejected" : "not-submitted");
  },
);

test.each([
  ["codex", true],
  ["claude", true],
  ["codex", false],
  ["claude", false],
] as const)(
  "input pipe failure for %s before submission: %s",
  async (harness, beforeSubmission) => {
    const cwd = await mkdtemp(join(tmpdir(), "tidy-closed-input-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const executable = join(cwd, "agent");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  else if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: 'b56ba7bb-00aa-4a56-a64c-593c3c377dcc' } } });
  else if (value.method === 'turn/start' || value.type === 'user') process.exit(1);
  else if (value.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } });
}
`,
    );
    await chmod(executable, 0o700);
    const spawning = spyOn(childProcess, "spawn");
    cleanups.push(async () => {
      spawning.mockRestore();
    });
    const run = startHarness({
      harness,
      executable,
      cwd,
      prompt: "Keep this instruction",
      onUpdate(update) {
        if (beforeSubmission && harness === "codex" && update.type === "session")
          child.stdin?.destroy();
      },
    });
    const result = spawning.mock.results[0];
    if (result.type !== "return") throw new Error("Expected a real child process");
    const child = result.value;
    if (beforeSubmission && harness === "claude")
      child.stdout?.prependOnceListener("data", () => child.stdin?.destroy());
    cleanups.push(async () => {
      run.stop();
      await run.done.catch(() => {});
    });
    await expect(run.done).rejects.toThrow();
    expect(run.deliveryState).toBe(beforeSubmission ? "not-submitted" : "unknown");
  },
);
