import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DesignSummary, Thread } from "../../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../../shared/contracts/tool-activity";
import { threadDesign, threadDesigns } from "./discovery";

const timestamp = "2026-10-22T12:00:00.000Z";
const design = (name: string): DesignSummary => {
  const id = randomUUID();
  return { id, name, path: `/project/.tidy/designs/${id}.json`, updatedAt: timestamp };
};
const first = design("First"),
  second = design("Second");
const user = randomUUID();
function thread(changes: Partial<Thread> = {}): Thread {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    revision: 0,
    title: "Work",
    harness: "codex",
    status: "running",
    designIds: [],
    messages: [{ id: user, role: "user", text: "Update the design" }],
    updatedAt: timestamp,
    ...changes,
  };
}
function tool(changes: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: randomUUID(),
    afterMessageId: user,
    kind: "edit",
    toolName: "Edit",
    title: "Edit",
    status: "running",
    startedAt: timestamp,
    ...changes,
  };
}

test("resolves referenced designs without choosing unrelated recent project files", () => {
  expect(threadDesign(thread(), [second, first])).toBeUndefined();
  expect(threadDesign(thread({ designIds: [randomUUID(), first.id] }), [second, first])).toBe(
    first,
  );
});

test("the latest tool target wins over references, including files created during the turn", () => {
  const value = thread({
    designIds: [first.id],
    toolActivities: [
      tool({ files: [{ path: first.path, kind: "modified" }] }),
      tool({ files: [{ path: second.path, kind: "added" }] }),
    ],
  });
  expect(threadDesign(value, [first])).toBe(first);
  expect(threadDesign(value, [first, second])).toBe(second);
});

test("structured file edits take priority over design paths quoted inside their contents", () => {
  expect(
    threadDesign(
      thread({
        toolActivities: [
          tool({
            title: first.path,
            input: `Copy from ${second.path}`,
            files: [{ path: first.path, kind: "modified" }],
          }),
        ],
      }),
      [first, second],
    ),
  ).toBe(first);
});

test("collects every known current-turn canvas once for docking", () => {
  const value = thread({
    designIds: [first.id, second.id],
    toolActivities: [
      tool({ files: [{ path: first.path, kind: "modified" }] }),
      tool({ files: [{ path: second.path, kind: "modified" }] }),
      tool({ title: first.path, status: "failed" }),
    ],
  });
  expect(threadDesigns(value, [first, second])).toEqual([second, first]);
});

test("immutable tool rows reuse parsed paths while refreshed metadata and new rows still resolve", () => {
  let reads = 0;
  const activity = tool();
  Object.defineProperty(activity, "input", {
    get() {
      reads++;
      return first.path;
    },
  });
  const value = thread({ toolActivities: [activity] });
  const cache = new WeakMap<ToolActivity, string[]>();
  expect(threadDesigns(value, [first, second], cache)).toEqual([first]);
  const renamed = { ...first, name: "Renamed" };
  expect(threadDesigns({ ...value, designIds: [] }, [renamed, second], cache)).toEqual([renamed]);
  expect(reads).toBe(1);
  const next = { ...value, toolActivities: [activity, tool({ input: second.path })] };
  expect(threadDesigns(next, [renamed, second], cache)).toEqual([second, renamed]);
  expect(reads).toBe(1);
});

test("shell and read tools can identify known local designs without an attached reference", () => {
  for (const path of [second.path, `.tidy/designs/${second.id}.json`]) {
    expect(
      threadDesign(
        thread({ toolActivities: [tool({ kind: "command", input: `cat '${path}'` })] }),
        [first, second],
      ),
    ).toBe(second);
    expect(
      threadDesign(
        thread({
          toolActivities: [tool({ kind: "read", input: JSON.stringify({ file_path: path }) })],
        }),
        [first, second],
      ),
    ).toBe(second);
  }
});

test("script output discovers newly created designs whose paths were computed rather than literal inputs", () => {
  const value = thread({
    toolActivities: [
      tool({
        kind: "command",
        input: "python3 create.py",
        output: `Created ${second.path}\nNodes: 86`,
      }),
    ],
  });
  expect(threadDesigns(value, [first])).toEqual([]);
  expect(threadDesigns(value, [first, second])).toEqual([second]);
  expect(
    threadDesigns(thread({ toolActivities: [tool({ output: second.path, status: "failed" })] }), [
      second,
    ]),
  ).toEqual([]);
});

test("old turns, failed tools, deleted files, unknown designs, and similar filenames do not select a canvas", () => {
  for (const activity of [
    tool({ afterMessageId: randomUUID(), title: second.path }),
    tool({ status: "failed", title: second.path }),
    tool({ status: "cancelled", title: second.path }),
    tool({ status: "interrupted", title: second.path }),
    tool({ files: [{ path: second.path, kind: "deleted" }], title: second.path }),
    tool({ title: `${second.path}.bak` }),
    tool({ title: `/project/.tidy/designs/${randomUUID()}.json` }),
  ]) {
    expect(threadDesign(thread({ toolActivities: [activity] }), [first, second])).toBeUndefined();
  }
});
