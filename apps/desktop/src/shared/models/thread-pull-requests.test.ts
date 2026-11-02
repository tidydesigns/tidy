import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Thread } from "../contracts/desktop";
import type { ToolActivity } from "../contracts/tool-activity";
import {
  createdPullRequest,
  pullRequestDetectionVersion,
  threadPullRequests,
} from "./thread-pull-requests";
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
    "python3 - <<'PY'\nprint('prepare description')\nPY\n\ngh pr create --body-file /tmp/body.md",
    "/bin/zsh -lc \"python3 - <<'PY'\nprint(42)\nPY\n\ngh pr create --title 'Hotfix'\"",
    "printf 'ready'\ngh pr create \\\n  --title 'Hotfix' \\\n  --body-file /tmp/body.md\n",
    "gh pr create --title 'A; B' --body 'First line\nSecond line'",
    "cat <<-BODY\n\tprepare\n\tBODY\ngh pr create\n# created above",
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
    { input: "gh pr create\ngh pr view 42" },
    { input: "gh pr create --dry-run\n" },
    { input: 'gh pr create "--dry-run"' },
    { input: "gh pr create --dry-run=true" },
    { input: "printf '\ngh pr create\n'" },
    { input: 'echo "\ngh pr create"' },
    { input: "cat <<'EOF'\ngh pr create\nEOF\n" },
    { input: "cat <<'EOF'\ngh pr create" },
    { input: "# gh pr create" },
    { input: "echo example \\\ngh pr create" },
    { output: `already exists: ${url}` },
    { output: "https://example.com/owner/repo/pull/42" },
  ])
    expect(createdPullRequest({ ...tool, ...overrides })).toBeNull();
});

test("thread summaries recover missed creation logs and ignore conversational PR references", () => {
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
    summarizeThread({ ...thread, pullRequests: [], toolActivities: [tool] }).pullRequests,
  ).toEqual([url]);
  const retained = "https://github.com/owner/repo/pull/41";
  expect(
    summarizeThread({ ...thread, pullRequests: [retained], toolActivities: [tool] }).pullRequests,
  ).toEqual([retained, url]);
  expect(
    summarizeThread({ ...thread, pullRequests: [url], toolActivities: [] }).pullRequests,
  ).toEqual([url]);
});

test("recovered lists skip unchanged tool logs and retain links after log eviction", () => {
  const pullRequests = [url];
  const recovered: Pick<Thread, "pullRequests" | "pullRequestDetectionVersion" | "toolActivities"> =
    {
      pullRequests,
      pullRequestDetectionVersion,
      get toolActivities(): ToolActivity[] {
        throw new Error("Recovered threads must not rescan tool logs during streaming");
      },
    };
  expect(threadPullRequests(recovered)).toBe(pullRequests);
});

test("backfill keeps the newest twenty created PRs", () => {
  const tools = Array.from({ length: 25 }, (_, index) => ({
    ...tool,
    output: `https://github.com/owner/repo/pull/${index + 1}`,
  }));
  expect(threadPullRequests({ toolActivities: tools })).toEqual(
    tools.slice(5).map((entry) => entry.output),
  );
  expect(
    threadPullRequests({
      pullRequests: ["https://github.com/owner/repo/pull/1"],
      toolActivities: tools,
    }),
  ).toEqual(tools.slice(5).map((entry) => entry.output));
});
