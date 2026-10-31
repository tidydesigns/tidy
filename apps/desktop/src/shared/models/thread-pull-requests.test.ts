import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Thread } from "../contracts/desktop";
import type { ToolActivity } from "../contracts/tool-activity";
import { createdPullRequest, threadPullRequests } from "./thread-pull-requests";
import { summarizeThread } from "./thread-updates";

const url = "https://github.com/owner/repo/pull/42";
const tool: ToolActivity = {
  id: randomUUID(),
  afterMessageId: randomUUID(),
  kind: "command",
  toolName: "Shell",
  title: "gh pr create",
  input: "gh pr create --title Preview --body-file /tmp/body.md",
  status: "completed",
  output: url,
  exitCode: 0,
  startedAt: new Date().toISOString(),
};

test("creation detection accepts native shell and structured tools, excluding examples and unsuccessful creation", () => {
  for (const input of [
    tool.input,
    "cd /tmp/project && gh pr create --draft",
    "/bin/bash -lc 'gh pr create'",
  ])
    expect(createdPullRequest({ ...tool, input })).toBe(url);
  expect(
    createdPullRequest({ ...tool, output: `https://github.com/owner/repo/pull/1\n${url}` }),
  ).toBe(url);
  expect(
    createdPullRequest({
      ...tool,
      kind: "tool",
      toolName: "github / create_pull_request",
      input: "{}",
      output: JSON.stringify({ html_url: url }),
    }),
  ).toBe(url);
  for (const overrides of [
    { status: "running" as const },
    { status: "failed" as const },
    { exitCode: 1 },
    { kind: "read" as const },
    { input: 'echo "gh pr create"' },
    { input: "gh pr create --dry-run" },
    { input: "gh pr create || gh pr view 42" },
    { input: "gh pr view 42" },
    { output: `already exists: ${url}` },
    { output: "https://example.com/owner/repo/pull/42" },
  ])
    expect(createdPullRequest({ ...tool, ...overrides })).toBeNull();
});

test("thread summaries backfill creation logs once, deduplicate, and ignore conversational PR references", () => {
  const thread: Thread = {
    id: randomUUID(),
    projectId: randomUUID(),
    revision: 1,
    title: "Preview",
    harness: "codex",
    messages: [
      { id: randomUUID(), role: "user", text: `Review ${url}` },
      { id: randomUUID(), role: "assistant", text: `Reviewed ${url}` },
    ],
    designIds: [],
    status: "completed",
    updatedAt: new Date().toISOString(),
  };
  expect(summarizeThread(thread).pullRequests).toEqual([]);
  expect(summarizeThread({ ...thread, toolActivities: [tool, tool] }).pullRequests).toEqual([url]);
  expect(
    summarizeThread({ ...thread, pullRequests: [url], toolActivities: [] }).pullRequests,
  ).toEqual([url]);
});

test("backfill keeps the newest twenty created PRs", () => {
  const tools = Array.from({ length: 25 }, (_, index) => ({
    ...tool,
    output: `https://github.com/owner/repo/pull/${index + 1}`,
  }));
  expect(threadPullRequests({ toolActivities: tools })).toEqual(
    tools.slice(5).map((entry) => entry.output),
  );
});
