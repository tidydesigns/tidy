import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
export { startInteractiveHarness as startHarness } from "./interactive-harness";
import type { ApprovalRequest, ApprovalDecision } from "../shared/permissions";
import { createToolEventParser } from "./tool-events";
import type { ToolActivityUpdate } from "../shared/tool-activity";
import type { TokenUsage } from "../shared/harness-settings";
import type { HarnessConnection, HarnessId } from "../shared/contracts";

const execute = promisify(execFile);
const names = { codex: "Codex", claude: "Claude Code" };
export type HarnessUpdate =
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string }
  | { type: "tool"; tool: ToolActivityUpdate }
  | { type: "usage"; usage: TokenUsage; cumulative: boolean }
  | { type: "model"; model: string }
  | { type: "session"; id: string }
  | { type: "message"; id: string; text: string; append?: boolean }
  | { type: "error"; text: string };
export type RunningHarness = {
  readonly deliveryState?: "not-submitted" | "unknown" | "accepted" | "rejected";
  done: Promise<void>;
  stop(): void;
  steer?(input: {
    prompt: string;
    images: Array<{ path: string; mimeType: string; data: string }>;
  }): Promise<boolean>;
  respondToApproval?(id: string, decision: ApprovalDecision): boolean;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Build the CLI environment from an allowlist and include standard user installation paths. */
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
      join(homedir(), ".opencode/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ]
    .filter((directory) => isAbsolute(directory))
    .join(delimiter);
  environment.NO_COLOR = "1";
  return environment;
}

/** Resolve a simple executable name from absolute PATH entries to its canonical file. */
export async function findExecutable(id: string, environment = harnessEnvironment()) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null;
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (!isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const path = join(directory, `${id}${extension}`);
      try {
        await access(path, constants.X_OK);
        if (!(await stat(path)).isFile()) continue;
        return await realpath(path);
      } catch {
        /* Try the next executable location. */
      }
    }
  }
  return null;
}

/** Locate a supported conversation CLI or the update-only OpenCode integration. */
export function findHarness(id: HarnessId | "opencode", environment = harnessEnvironment()) {
  return findExecutable(id, environment);
}

/** Report installation and authentication status for the supported conversation providers. */
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
function readUsage(value: Record<string, unknown>): TokenUsage | undefined {
  if (!Object.keys(value).length) return;
  const cached = count(value.cache_read_input_tokens);
  return {
    inputTokens: count(value.input_tokens) + cached + count(value.cache_creation_input_tokens),
    cachedInputTokens: cached,
    outputTokens: count(value.output_tokens),
  };
}

/** Normalize only visible messages and tool progress, never reasoning or credentials. */
export function createClaudeParser(emit: (event: HarnessUpdate) => void) {
  let claudeMessageId = "response";
  const tools = createToolEventParser("claude", (tool) => emit({ type: "tool", tool }));
  return (input: unknown) => {
    const value = record(input);
    if (value.type !== "assistant" || value.parent_tool_use_id) tools(value);
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
      else usage = readUsage(record(value.usage));
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
    }
  };
}
