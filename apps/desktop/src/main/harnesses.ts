import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { createToolEventParser } from "./tool-events";
import type { ToolActivityUpdate } from "../shared/tool-activity";
import type { HarnessSettings, TokenUsage } from "../shared/harness-settings";
import type { HarnessConnection, HarnessId } from "../shared/contracts";

const execute = promisify(execFile);
const names = { codex: "Codex", claude: "Claude Code" };
export type HarnessUpdate =
  | { type: "tool"; tool: ToolActivityUpdate }
  | { type: "usage"; usage: TokenUsage; cumulative: boolean }
  | { type: "model"; model: string }
  | { type: "session"; id: string }
  | { type: "message"; id: string; text: string; append?: boolean }
  | { type: "activity"; text: string }
  | { type: "error"; text: string };
export type RunningHarness = { done: Promise<void>; stop(): void };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function harnessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.PATH = [
    ...new Set([
      ...(process.env.PATH ?? "").split(delimiter),
      join(homedir(), ".local/bin"),
      join(homedir(), ".bun/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ]
    .filter(Boolean)
    .join(delimiter);
  environment.NO_COLOR = "1";
  return environment;
}

export async function findHarness(id: HarnessId, environment = harnessEnvironment()) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, `${id}${extension}`);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Try the next executable location. */
      }
    }
  }
  return null;
}

export async function checkHarnesses(): Promise<HarnessConnection[]> {
  return Promise.all(
    (["codex", "claude"] as const).map(async (id) => {
      const executable = await findHarness(id);
      if (!executable) return { id, name: names[id], status: "not-installed" };
      try {
        const result = await execute(
          executable,
          id === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
          { env: harnessEnvironment(), timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true },
        );
        if (id === "claude" && record(JSON.parse(result.stdout)).loggedIn === false)
          throw new Error("Sign in required.");
        return { id, name: names[id], status: "ready" };
      } catch {
        return { id, name: names[id], status: "signed-out" };
      }
    }),
  );
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
function readUsage(value: Record<string, unknown>, claude: boolean): TokenUsage | undefined {
  if (!Object.keys(value).length) return;
  const cached = count(claude ? value.cache_read_input_tokens : value.cached_input_tokens);
  return {
    inputTokens:
      count(value.input_tokens) + (claude ? cached + count(value.cache_creation_input_tokens) : 0),
    cachedInputTokens: cached,
    outputTokens: count(value.output_tokens),
  };
}

/** Normalize only visible messages and tool progress, never reasoning or credentials. */
export function createHarnessParser(harness: HarnessId, emit: (event: HarnessUpdate) => void) {
  let claudeMessageId = "response";
  const tools = createToolEventParser(harness, (tool) => emit({ type: "tool", tool }));
  return (input: unknown) => {
    const value = record(input);
    if (value.type !== "assistant" || value.parent_tool_use_id) tools(value);
    if (harness === "codex") {
      if (value.type === "thread.started" && text(value.thread_id))
        emit({ type: "session", id: text(value.thread_id) });
      if (
        value.type === "item.started" ||
        value.type === "item.updated" ||
        value.type === "item.completed"
      ) {
        const item = record(value.item);
        if (item.type === "agent_message")
          emit({ type: "message", id: text(item.id), text: text(item.text) });
        else if (
          ![
            "reasoning",
            "command_execution",
            "file_change",
            "web_search",
            "mcp_tool_call",
            "dynamic_tool_call",
          ].includes(text(item.type))
        )
          emit({ type: "activity", text: "Working" });
      }
      if (value.type === "turn.completed") {
        const usage = readUsage(record(value.usage), false);
        if (usage) emit({ type: "usage", usage, cumulative: false });
      }
      if (value.type === "turn.failed" || value.type === "error")
        emit({
          type: "error",
          text:
            text(record(value.error).message) ||
            text(value.message) ||
            "Codex could not complete this turn.",
        });
      return;
    }
    if (value.type === "system" && typeof value.model === "string")
      emit({ type: "model", model: value.model });
    if (typeof value.session_id === "string") emit({ type: "session", id: value.session_id });
    if (value.parent_tool_use_id) return;
    const event = record(value.event);
    if (value.type === "stream_event") {
      if (event.type === "message_start")
        claudeMessageId = text(record(event.message).id) || "response";
      const delta = record(event.delta);
      if (delta.type === "text_delta")
        emit({ type: "message", id: claudeMessageId, text: text(delta.text), append: true });
    }
    if (value.type === "assistant") {
      const message = record(value.message);
      const content = Array.isArray(message.content) ? message.content.map(record) : [];
      const visible = content
        .filter((block) => block.type === "text")
        .map((block) => text(block.text))
        .join("\n");
      if (visible)
        emit({ type: "message", id: text(message.id) || claudeMessageId, text: visible });
      tools(value);
    }
    if (value.type === "result") {
      const byModel = Object.values(record(value.modelUsage)).map(record);
      let usage: TokenUsage | undefined;
      if (byModel.length)
        usage = byModel.reduce<TokenUsage>(
          (total, model) => ({
            inputTokens:
              total.inputTokens +
              count(model.inputTokens) +
              count(model.cacheReadInputTokens) +
              count(model.cacheCreationInputTokens),
            cachedInputTokens: total.cachedInputTokens + count(model.cacheReadInputTokens),
            outputTokens: total.outputTokens + count(model.outputTokens),
          }),
          { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        );
      else usage = readUsage(record(value.usage), true);
      // Startup errors can report zeroed accounting even when resuming a used session.
      if (value.is_error && usage && usage.inputTokens === 0 && usage.outputTokens === 0)
        usage = undefined;
      if (usage) {
        if (
          typeof value.total_cost_usd === "number" &&
          Number.isFinite(value.total_cost_usd) &&
          value.total_cost_usd >= 0
        )
          usage.costUSD = value.total_cost_usd;
        emit({ type: "usage", usage, cumulative: byModel.length > 0 });
      }
      if (value.is_error)
        emit({
          type: "error",
          text: text(value.result) || "Claude Code could not complete this turn.",
        });
      else if (text(value.result))
        emit({ type: "message", id: claudeMessageId, text: text(value.result) });
      if (Array.isArray(value.permission_denials) && value.permission_denials.length) {
        emit({
          type: "error",
          text: "Claude Code needs permission for a tool. Review the CLI's project permissions before continuing.",
        });
      }
    }
  };
}

export function startHarness(input: {
  harness: HarnessId;
  executable: string;
  cwd: string;
  prompt: string;
  sessionId?: string;
  settings?: HarnessSettings;
  images?: Array<{ path: string; mimeType: string; data: string }>;
  onUpdate: (update: HarnessUpdate) => void;
}): RunningHarness {
  const args =
    input.harness === "codex"
      ? [
          "exec",
          ...(input.sessionId ? ["resume", input.sessionId] : []),
          "--json",
          "--skip-git-repo-check",
          "-c",
          'approval_policy="never"',
          "-c",
          'sandbox_mode="workspace-write"',
          "-",
        ]
      : [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--permission-mode",
          "acceptEdits",
          ...(input.sessionId ? ["--resume", input.sessionId] : []),
        ];
  if (input.settings?.model) args.push("--model", input.settings.model);
  if (input.settings?.effort) {
    if (input.harness === "codex")
      args.push("-c", `model_reasoning_effort=${JSON.stringify(input.settings.effort)}`);
    else args.push("--effort", input.settings.effort);
  }
  if (input.images?.length) {
    if (input.harness === "codex")
      for (const image of input.images) args.push("--image", image.path);
    else args.push("--input-format", "stream-json");
  }
  const child: ChildProcessWithoutNullStreams = spawn(input.executable, args, {
    cwd: input.cwd,
    env: harnessEnvironment(),
    stdio: "pipe",
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let buffer = "";
  let stopped = false;
  let failure: string | undefined;
  let completed = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const parser = createHarnessParser(input.harness, (update) => {
    if (stopped) return;
    if (update.type === "error") failure = update.text.slice(0, 4000);
    input.onUpdate(update);
  });
  function consume(line: string) {
    const value: unknown = JSON.parse(line);
    const type = record(value).type;
    if (type === "turn.completed" || type === "result") completed = true;
    parser(value);
  }
  function signal(value: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, value);
      else child.kill(value);
    } catch {
      /* The process already exited. */
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    signal("SIGTERM");
    force = setTimeout(() => signal("SIGKILL"), 2000);
    force.unref();
  }
  const done = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        failure = "The harness output exceeded the message limit.";
        stop();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          consume(line);
        } catch {
          failure = "The harness returned an invalid event.";
          stop();
          return;
        }
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => {
      reject(new Error(`Could not start ${names[input.harness]}. Check its installation.`));
    });
    child.once("close", (code) => {
      clearTimeout(force);
      if (buffer.trim() && !stopped) {
        try {
          consume(buffer);
        } catch {
          failure = "The harness returned an invalid event.";
        }
      }
      if (failure) reject(new Error(failure));
      else if ((code !== 0 || !completed) && !stopped)
        reject(
          new Error(
            `${names[input.harness]} exited before completing the turn. Check its CLI sign-in and project permissions.`,
          ),
        );
      else resolve();
    });
    child.stdin.end(
      input.harness === "claude" && input.images?.length
        ? JSON.stringify({
            type: "user",
            session_id: input.sessionId ?? "",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                ...input.images.map((image) => ({
                  type: "image",
                  source: { type: "base64", media_type: image.mimeType, data: image.data },
                })),
              ],
            },
          }) + "\n"
        : input.prompt,
    );
  });
  return { done, stop };
}
