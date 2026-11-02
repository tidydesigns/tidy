import { z } from "zod";
import type { Thread } from "../contracts/desktop";
import type { ToolActivity } from "../contracts/tool-activity";
import { pullRequestURL } from "../contracts/pull-request";

const createdResponse = z.object({ html_url: z.string() });
export const pullRequestDetectionVersion = 1;

/** Read the final simple command without executing shell input or matching quoted examples. */
function lastShellCommand(input: string): string[] | null {
  let words: string[] = [];
  let previous: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const documents: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === "\\" && quote !== "'") {
      const next = input[++index];
      if (next === undefined) return null;
      if (next !== "\n") {
        word += next;
        started = true;
      }
    } else if (quote) {
      if (character === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`]/.test(character)) return null;
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "#" && !started) {
      while (index + 1 < input.length && input[index + 1] !== "\n") index++;
    } else if (input.startsWith("<<", index)) {
      const document = input
        .slice(index)
        .match(/^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([\w-]+))/);
      if (!document) return null;
      finishWord();
      documents.push({
        delimiter: document[2] ?? document[3] ?? document[4],
        stripTabs: document[1] === "-",
      });
      index += document[0].length - 1;
    } else if (character === ";" || character === "\n" || input.startsWith("&&", index)) {
      finishWord();
      if (words.length) previous = words;
      words = [];
      if (character === "&") index++;
      if (character === "\n") {
        for (const document of documents.splice(0)) {
          let found = false;
          while (index < input.length) {
            const start = index + 1;
            const end = input.indexOf("\n", start);
            const line = input.slice(start, end < 0 ? input.length : end);
            index = end < 0 ? input.length : end;
            if ((document.stripTabs ? line.replace(/^\t+/, "") : line) === document.delimiter) {
              found = true;
              break;
            }
          }
          if (!found) return null;
        }
      }
    } else if (/\s/.test(character)) finishWord();
    // Complex shell expressions are deliberately left unlinked rather than guessed.
    else if (/[|&(){}$`]/.test(character)) return null;
    else {
      word += character;
      started = true;
    }
  }
  if (quote || documents.length) return null;
  finishWord();
  return words.length ? words : previous;
}

export function createdPullRequest(tool: ToolActivity): string | null {
  if (tool.status !== "completed" || (tool.exitCode !== undefined && tool.exitCode !== 0))
    return null;
  if (!tool.output) return null;
  const command = (tool.input ?? tool.title).replace(
    /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/,
    "$2",
  );
  const creation = lastShellCommand(command);
  if (
    (tool.kind === "command" || tool.kind === "test") &&
    creation?.[0] === "gh" &&
    creation[1] === "pr" &&
    creation[2] === "create" &&
    !creation.some((word) => word === "--dry-run" || word.startsWith("--dry-run="))
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
  thread: Pick<Thread, "pullRequests" | "toolActivities" | "pullRequestDetectionVersion">,
): string[] {
  if (thread.pullRequestDetectionVersion === pullRequestDetectionVersion && thread.pullRequests)
    return thread.pullRequests;
  const urls = new Set(thread.pullRequests ?? []);
  for (const tool of thread.toolActivities ?? []) {
    const url = createdPullRequest(tool);
    if (url) {
      urls.delete(url);
      urls.add(url);
    }
  }
  return [...urls].slice(-20);
}
