import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Thread } from "../contracts/desktop";
import type { ToolActivity } from "../contracts/tool-activity";
import {
  createdPullRequest,
  createdPullRequests,
  confirmedPullRequests,
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
    "gh pr create --body-file /tmp/body.md && git status --short",
    'BODY_FILE=/tmp/body.md\ngh pr create --body-file "$BODY_FILE"',
    'gh pr create --body-file "${BODY_FILE}"\ngit status --short',
    "gh pr create\ngh pr view 42",
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
    { input: "gh pr create --dry-run\n" },
    { input: 'gh pr create "--dry-run"' },
    { input: "gh pr create --dry-run=true" },
    { input: "printf '\ngh pr create\n'" },
    { input: 'echo "\ngh pr create"' },
    { input: "cat <<'EOF'\ngh pr create\nEOF\n" },
    { input: "cat <<'EOF'\ngh pr create" },
    { input: "# gh pr create" },
    { input: `if false; then\ngh pr create\nfi\nprintf '%s\\n' '${url}'` },
    { input: `for item in ''; do\ngh pr create\ndone\nprintf '%s\\n' '${url}'` },
    { input: "echo example \\\ngh pr create" },
    { output: `already exists: ${url}` },
    { output: "https://example.com/owner/repo/pull/42" },
  ])
    expect(createdPullRequest({ ...tool, ...overrides })).toBeNull();
});

test("multiple creation receipts are retained and comments are not mistaken for new PRs", () => {
  const second = "https://github.com/owner/repo/pull/43";
  expect(
    createdPullRequests({
      ...tool,
      input: "gh pr create; gh pr create",
      output: `${url}\n${second}\n`,
    }),
  ).toEqual([url, second]);
  expect(
    createdPullRequests({
      ...tool,
      input: "gh pr create && gh pr comment 42",
      output: `${url}\n${second}#issuecomment-1\n`,
    }),
  ).toEqual([url]);
  expect(createdPullRequests({ ...tool, output: "https://github.com/Owner/Repo/pull/42" })).toEqual(
    [url],
  );
});

test("completed creation receipts survive later command failure or cancellation without accepting partial output", () => {
  for (const status of ["running", "failed", "cancelled", "interrupted"] as const) {
    expect(
      createdPullRequests({
        ...tool,
        input: "gh pr create && bun test",
        status,
        exitCode: 1,
        output: `${url}\nTests failed\n`,
      }),
    ).toEqual([url]);
    expect(createdPullRequests({ ...tool, status, exitCode: 1, output: url })).toEqual([]);
  }
});

test("structured PR creation unwraps GitHub and MCP responses and rejects error envelopes", () => {
  const create = {
    ...tool,
    kind: "tool" as const,
    toolName: "github / create_pull_request",
    input: "{}",
  };
  for (const value of [
    { url },
    { data: { createPullRequest: { pullRequest: { url } } } },
    { structuredContent: { html_url: url } },
    { content: [{ type: "text", text: JSON.stringify({ html_url: url }) }] },
  ])
    expect(createdPullRequests({ ...create, output: JSON.stringify(value) })).toEqual([url]);
  for (const value of [
    { isError: true, structuredContent: { html_url: url } },
    { success: false, url },
    { error: "Already exists", url },
    { errors: [{ message: "Forbidden" }], url },
  ])
    expect(createdPullRequests({ ...create, output: JSON.stringify(value) })).toEqual([]);
});

test("explicit assistant creation confirmations recover pruned logs without linking reviews or examples", () => {
  const message = (text: string, role: "user" | "assistant" = "assistant") => ({
    id: randomUUID(),
    role,
    text,
  });
  for (const text of [
    `Created pull request: ${url}`,
    `Opened [PR #42](${url}) targeting main.`,
    `I've created [PR #42](${url}).`,
    `Fixed in [PR #42](${url}), ready for review.`,
    `Implemented in [PR #42](${url}).`,
  ])
    expect(confirmedPullRequests([message(text)])).toEqual([url]);
  for (const text of [
    `Review ${url}`,
    `Reviewed [PR #42](${url}).`,
    `Example: Opened ${url}`,
    `Created a regression test for ${url}`,
    `Opened the browser to review ${url}`,
    `> Opened ${url}`,
    `    Opened ${url}`,
    `\tCreated pull request: ${url}`,
    `\`\`\`text\nOpened ${url}\n\`\`\``,
    `~~~text\nCreated pull request: ${url}\n~~~`,
  ])
    expect(confirmedPullRequests([message(text)])).toEqual([]);
  expect(confirmedPullRequests([message(`Opened ${url}`, "user")])).toEqual([]);
  expect(
    threadPullRequests({
      pullRequests: [],
      pullRequestDetectionVersion: 1,
      toolActivities: [],
      messages: [message(`Opened ${url}`)],
    }),
  ).toEqual([url]);
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
