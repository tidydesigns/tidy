import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, type HarnessUpdate } from "./harnesses";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("native steering waits for the active turn and sends text and images to that exact turn", async () => {
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
      images: [{ path: join(cwd, "image.png"), mimeType: "image/png", data: "" }],
    }),
  ).toBe(true);
  await run.done;
  const sent: unknown = JSON.parse(await readFile(join(cwd, "steer.json"), "utf8"));
  expect(sent).toEqual({
    threadId: "b56ba7bb-00aa-4a56-a64c-593c3c377dcc",
    expectedTurnId: "active-turn",
    input: [
      { type: "text", text: "Use the new direction", text_elements: [] },
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
});

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
