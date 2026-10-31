import { z } from "zod";
import type { Thread } from "../contracts/desktop";
import type { ToolActivity } from "../contracts/tool-activity";
import { pullRequestURL } from "../contracts/pull-request";

const createdResponse = z.object({ html_url: z.string() });

export function createdPullRequest(tool: ToolActivity): string | null {
  if (tool.status !== "completed" || (tool.exitCode !== undefined && tool.exitCode !== 0))
    return null;
  if (!tool.output) return null;
  const command = (tool.input ?? tool.title).replace(
    /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/,
    "$2",
  );
  const creation = command.match(/(?:^|&&|;)\s*gh\s+pr\s+create(?:\s|$)([\s\S]*)$/);
  if (
    (tool.kind === "command" || tool.kind === "test") &&
    creation &&
    !/(?:[;&|\n]|(?:^|\s)--dry-run(?:\s|$))/.test(creation[1])
  ) {
    for (const line of tool.output.split("\n").reverse()) {
      const url = pullRequestURL(line.trim());
      if (url) return url;
    }
  }
  if (/(?:^|[\s._/])create_pull_request$/.test(tool.toolName)) {
    try {
      const response = createdResponse.safeParse(JSON.parse(tool.output));
      if (response.success) return pullRequestURL(response.data.html_url);
    } catch {
      return null;
    }
  }
  return null;
}

export function threadPullRequests(
  thread: Pick<Thread, "pullRequests" | "toolActivities">,
): string[] {
  if (thread.pullRequests) return [...new Set(thread.pullRequests)];
  const urls = new Set<string>();
  for (const tool of thread.toolActivities ?? []) {
    const url = createdPullRequest(tool);
    if (url) urls.add(url);
  }
  return [...urls].slice(-20);
}
