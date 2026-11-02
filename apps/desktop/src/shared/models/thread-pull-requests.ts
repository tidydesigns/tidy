import type { Thread } from "../contracts/desktop";
import type { ToolActivity } from "../contracts/tool-activity";
import { pullRequestURL } from "../contracts/pull-request";

export const pullRequestDetectionVersion = 2;

function structuredReceipts(value: unknown, depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.slice(0, 50).flatMap((entry) => structuredReceipts(entry, depth + 1));
  const object = value as Record<string, unknown>;
  if (
    object.isError === true ||
    object.success === false ||
    object.error ||
    (Array.isArray(object.errors) && object.errors.length)
  )
    return [];
  const urls: string[] = [];
  for (const key of ["html_url", "url"]) {
    const url = typeof object[key] === "string" ? pullRequestURL(object[key]) : null;
    if (url) urls.push(url);
  }
  for (const key of [
    "data",
    "result",
    "structuredContent",
    "content",
    "pullRequest",
    "createPullRequest",
  ])
    urls.push(...structuredReceipts(object[key], depth + 1));
  if (object.type === "text" && typeof object.text === "string") {
    try {
      urls.push(...structuredReceipts(JSON.parse(object.text), depth + 1));
    } catch {
      const url = pullRequestURL(object.text.trim());
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)].slice(-20);
}

/** Read simple commands without evaluating expansions or matching quoted/heredoc examples. */
function shellCommands(input: string): string[][] | null {
  let words: string[] = [];
  const commands: string[][] = [];
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
        if (quote === '"' && character === "`") return null;
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
      if (words.length) commands.push(words);
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
    else if (/[|&()`]/.test(character)) return null;
    else {
      word += character;
      started = true;
    }
  }
  if (quote || documents.length) return null;
  finishWord();
  if (words.length) commands.push(words);
  if (
    commands.some((words) =>
      /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function)$/.test(words[0]),
    )
  )
    return null;
  return commands;
}

export function createdPullRequests(tool: ToolActivity): string[] {
  if (!tool.output) return [];
  const succeeded =
    tool.status === "completed" && (tool.exitCode === undefined || tool.exitCode === 0);
  const command = (tool.input ?? tool.title).replace(
    /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/,
    "$2",
  );
  const commands = shellCommands(command);
  if (
    (tool.kind === "command" || tool.kind === "test") &&
    (succeeded || /\r?\n$/.test(tool.output)) &&
    commands?.some(
      (creation) =>
        creation[0] === "gh" &&
        creation[1] === "pr" &&
        creation[2] === "create" &&
        !creation.some((word) => word === "--dry-run" || word.startsWith("--dry-run=")),
    )
  ) {
    return [
      ...new Set(
        tool.output.split("\n").flatMap((line) => {
          const raw = line.trim();
          const url = pullRequestURL(raw);
          return url && !/[?#]/.test(raw) && /\/pull\/[1-9]\d*\/?$/.test(new URL(raw).pathname)
            ? [url]
            : [];
        }),
      ),
    ].slice(-20);
  }
  if (succeeded && /(?:^|[\s._/])create_pull_request$/.test(tool.toolName)) {
    try {
      return structuredReceipts(JSON.parse(tool.output));
    } catch {
      return [];
    }
  }
  return [];
}

export function createdPullRequest(tool: ToolActivity): string | null {
  return createdPullRequests(tool).at(-1) ?? null;
}

/** Recover explicit creation receipts, never user references, review prose, quotes or code examples. */
export function confirmedPullRequests(messages: Pick<Thread, "messages">["messages"]): string[] {
  const urls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    let fence: string | undefined;
    for (const line of message.text.split("\n")) {
      const trimmed = line.trim();
      const marker = trimmed.match(/^(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1][0];
        else if (fence === marker[1][0]) fence = undefined;
        continue;
      }
      if (fence || /^(?: {4}|\t)/.test(line) || trimmed.startsWith(">")) continue;
      if (
        !/^(?:(?:I(?:'ve| have)?|We(?:'ve| have)?)\s+)?(?:Created pull request\s*:|(?:Opened|Created)\s+(?:(?:a\s+)?(?:PR\b|pull request\b)|\[(?:PR\b|pull request\b)|https:\/\/github\.com\/)|(?:Implemented in|Fixed in)\s+)/i.test(
          trimmed,
        )
      )
        continue;
      for (const match of trimmed.matchAll(/https:\/\/(?:www\.)?github\.com\/[^\s)\]>]+/g)) {
        const url = pullRequestURL(match[0].replace(/[.,;:]+$/, ""));
        if (url) urls.add(url);
      }
    }
  }
  return [...urls].slice(-20);
}

export function threadPullRequests(
  thread: Pick<Thread, "pullRequests" | "toolActivities" | "pullRequestDetectionVersion"> &
    Partial<Pick<Thread, "messages">>,
): string[] {
  if (thread.pullRequestDetectionVersion === pullRequestDetectionVersion && thread.pullRequests)
    return thread.pullRequests;
  const urls = new Set(thread.pullRequests ?? []);
  for (const tool of thread.toolActivities ?? []) {
    for (const url of createdPullRequests(tool)) {
      urls.delete(url);
      urls.add(url);
    }
  }
  for (const url of confirmedPullRequests(thread.messages ?? [])) {
    if (!urls.has(url)) urls.add(url);
  }
  return [...urls].slice(-20);
}
