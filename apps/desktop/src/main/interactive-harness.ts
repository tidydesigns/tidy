import { skillCommand } from "../shared/skills";
import type { SkillInvocation } from "./harness-skills";
import { version } from "../../package.json";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createClaudeParser,
  harnessEnvironment,
  type HarnessUpdate,
  type RunningHarness,
} from "./harnesses";
import type { HarnessId } from "../shared/contracts";
import type { HarnessSettings } from "../shared/harness-settings";
import { createCodexEvents } from "./codex-events";
import { plainToolText } from "./tool-events";
import {
  validatePermissionMode,
  codexPermissions,
  claudePermissionMode,
  type ApprovalDecision,
} from "../shared/permissions";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
class HarnessRequestError extends Error {}
const key = (id: unknown) => `${typeof id}:${String(id)}`;
const approvalText = (value: string) =>
  plainToolText(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16)}`,
  );

/** One native harness turn, with an open duplex connection for explicit approvals. */
export function startInteractiveHarness(input: {
  harness: HarnessId;
  executable: string;
  cwd: string;
  additionalDirectories?: string[];
  prompt: string;
  skill?: { invocation: SkillInvocation; context: string; prompt: string };
  sessionId?: string;
  settings?: HarnessSettings;
  images?: Array<{ path: string; mimeType: string; data: string }>;
  onUpdate: (update: HarnessUpdate) => void;
}): RunningHarness {
  const codex = input.harness === "codex";
  let deliveryState: NonNullable<RunningHarness["deliveryState"]> = "not-submitted";
  const mode = validatePermissionMode(input.harness, input.settings?.permissionMode);
  const args = codex
    ? ["app-server", "--listen", "stdio://"]
    : [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        claudePermissionMode(mode),
        ...(mode === "auto" ? ["--allow-dangerously-skip-permissions"] : []),
        ...(input.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path]),
        ...(input.sessionId ? ["--resume", input.sessionId] : []),
        ...(input.settings?.model ? ["--model", input.settings.model] : []),
        ...(input.settings?.effort ? ["--effort", input.settings.effort] : []),
      ];
  const child = spawn(input.executable, args, {
    cwd: input.cwd,
    env: harnessEnvironment(),
    stdio: "pipe",
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let buffer = "",
    serial = 0,
    stopped = false,
    completed = false,
    closed = false,
    failure: string | undefined,
    threadId: string | undefined,
    turnId: string | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const filePreviews = new Map<string, string>();
  const approvals = new Map<
    string,
    { nativeId: unknown; choices: ApprovalDecision[]; result(decision: ApprovalDecision): unknown }
  >();
  const emit: typeof input.onUpdate = (update) => {
    if (!stopped && !closed) {
      if (update.type === "message" || update.type === "tool" || update.type === "approval")
        deliveryState = "accepted";
      if (update.type === "error") failure = update.text;
      input.onUpdate(update);
    }
  };
  const parse = createClaudeParser(emit),
    codexEvent = createCodexEvents(emit);
  function write(value: unknown) {
    if (closed || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(JSON.stringify(value) + "\n");
      return true;
    } catch {
      return false;
    }
  }
  function signal(value: NodeJS.Signals) {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, value);
      else child.kill(value);
    } catch {}
  }
  function terminate() {
    signal("SIGTERM");
    if (!force) {
      force = setTimeout(() => signal("SIGKILL"), 2000);
      force.unref();
    }
  }
  function clearRequests() {
    for (const [id] of approvals) {
      input.onUpdate({ type: "approval-resolved", id });
    }
    approvals.clear();
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The harness connection closed."));
    }
    waiting.clear();
  }
  function stop() {
    if (stopped || closed) return;
    stopped = true;
    clearRequests();
    terminate();
  }
  function request(method: string, params: unknown): Promise<unknown> {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(String(id));
        reject(new Error("The harness connection timed out."));
      }, 15_000);
      waiting.set(String(id), { resolve, reject, timer });
      if (
        !write(
          codex
            ? { id, method, params }
            : {
                type: "control_request",
                request_id: String(id),
                request: { subtype: method, ...object(params) },
              },
        )
      ) {
        clearTimeout(timer);
        waiting.delete(String(id));
        if (codex && method === "turn/start" && deliveryState === "unknown")
          deliveryState = "not-submitted";
        reject(new Error("The harness connection closed."));
      }
    });
  }
  function respond(nativeId: unknown, result: unknown) {
    return write(
      codex
        ? { id: nativeId, result }
        : {
            type: "control_response",
            response: { subtype: "success", request_id: nativeId, response: result },
          },
    );
  }
  function rejectRequest(nativeId: unknown, message: string) {
    write(
      codex
        ? { id: nativeId, error: { code: -32601, message } }
        : {
            type: "control_response",
            response: { subtype: "error", request_id: nativeId, error: message },
          },
    );
  }
  function cancelApproval(nativeId: unknown) {
    for (const [id, approval] of approvals)
      if (key(approval.nativeId) === key(nativeId)) {
        approvals.delete(id);
        emit({ type: "approval-resolved", id });
      }
  }
  function ask(
    nativeId: unknown,
    title: string,
    reason: string,
    details: unknown,
    choices: ApprovalDecision[],
    result: (decision: ApprovalDecision) => unknown,
    scope?: "turn",
  ) {
    if (approvals.size >= 20) {
      rejectRequest(nativeId, "Too many pending permission requests.");
      return;
    }
    if ([...approvals.values()].some((approval) => key(approval.nativeId) === key(nativeId)))
      return;
    const id = randomUUID();
    const preview = approvalText(
      typeof details === "string"
        ? details
        : (JSON.stringify(
            details,
            (name, value) =>
              /password|secret|api.?key|token|authorization|signature|thinking|reasoning/i.test(
                name,
              )
                ? "[redacted]"
                : value,
            2,
          ) ?? ""),
    );
    const shortened = preview.length > 16_000;
    const available: ApprovalDecision[] = shortened ? ["deny"] : choices;
    approvals.set(id, { nativeId, choices: available, result });
    emit({
      type: "approval",
      request: {
        id,
        title: approvalText(title).slice(0, 240),
        reason: shortened
          ? "This request is too large to review here. Ask the harness to split it into smaller actions."
          : approvalText(reason).slice(0, 4000) || undefined,
        details: preview.slice(0, 16_000) || undefined,
        shortened,
        choices: available,
        scope,
      },
    });
  }
  function consume(value: Record<string, unknown>) {
    if (codex) {
      if (value.method === undefined && value.id !== undefined) {
        const pending = waiting.get(String(value.id));
        if (!pending) return;
        waiting.delete(String(value.id));
        clearTimeout(pending.timer);
        if (value.error)
          pending.reject(
            new HarnessRequestError(
              plainToolText(text(object(value.error).message)).slice(0, 1000) ||
                "The installed Codex rejected this request.",
            ),
          );
        else pending.resolve(value.result);
        return;
      }
      const method = text(value.method),
        params = object(value.params);
      // Ignore notifications and requests belonging to a different native session or turn.
      if (params.threadId && params.threadId !== threadId) {
        if (value.id !== undefined)
          rejectRequest(value.id, "This request belongs to another thread.");
        return;
      }
      if (turnId && params.turnId && params.turnId !== turnId) {
        if (value.id !== undefined)
          rejectRequest(value.id, "This request belongs to another turn.");
        return;
      }
      if (value.id !== undefined) {
        if (
          !threadId ||
          params.threadId !== threadId ||
          !text(params.turnId) ||
          !text(params.itemId)
        ) {
          rejectRequest(value.id, "No matching active Tidy thread and turn.");
          return;
        }
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          const command = text(params.command),
            network = object(params.networkApprovalContext);
          const choices: ApprovalDecision[] = ["allow", "allow-session", "deny"];
          if (Array.isArray(params.availableDecisions)) {
            if (!params.availableDecisions.includes("accept"))
              choices.splice(choices.indexOf("allow"), 1);
            if (!params.availableDecisions.includes("acceptForSession"))
              choices.splice(choices.indexOf("allow-session"), 1);
          }
          ask(
            value.id,
            method.includes("fileChange")
              ? "Allow file changes?"
              : network.host
                ? `Allow network access to ${text(network.host)}?`
                : "Allow command?",
            text(params.reason),
            [
              command,
              filePreviews.has(text(params.itemId)) ? filePreviews.get(text(params.itemId))! : "",
              text(params.cwd) && `Directory: ${text(params.cwd)}`,
              text(params.grantRoot) && `Write access: ${text(params.grantRoot)}`,
              network.host && JSON.stringify(network),
            ]
              .filter(Boolean)
              .join("\n"),
            choices,
            (decision) => ({
              decision:
                decision === "allow"
                  ? "accept"
                  : decision === "allow-session"
                    ? "acceptForSession"
                    : "decline",
            }),
          );
        } else if (method === "item/permissions/requestApproval") {
          const requested = object(params.permissions);
          const granted = {
            ...(requested.network ? { network: requested.network } : {}),
            ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
          };
          ask(
            value.id,
            "Allow additional access?",
            text(params.reason),
            { cwd: params.cwd, permissions: requested },
            ["allow", "allow-session", "deny"],
            (decision) => ({
              permissions: decision === "deny" ? {} : granted,
              scope: decision === "allow-session" ? "session" : "turn",
            }),
            "turn",
          );
        } else rejectRequest(value.id, "This interactive request is not supported in Tidy yet.");
        return;
      }
      if (method === "serverRequest/resolved") cancelApproval(params.requestId);
      if (method === "turn/started") {
        deliveryState = "accepted";
        turnId = text(object(params.turn).id) || turnId;
      }
      const item = object(params.item);
      if (method === "item/started" && item.type === "fileChange" && filePreviews.size < 1000)
        filePreviews.set(
          text(item.id),
          plainToolText(JSON.stringify(item.changes) ?? "").slice(0, 16_001),
        );
      codexEvent(method, params);
      if (method === "item/completed") filePreviews.delete(text(item.id));
      if (method === "error" && !params.willRetry)
        failure = text(object(params.error).message) || "Codex could not complete this turn.";
      if (method === "turn/completed") {
        const turn = object(params.turn);
        completed = true;
        if (turn.status === "failed")
          failure = text(object(turn.error).message) || "Codex could not complete this turn.";
        if (turn.status === "interrupted") failure = "The harness turn was interrupted.";
        clearRequests();
        terminate();
      }
      return;
    }
    if (value.type === "control_response") {
      const response = object(value.response),
        pending = waiting.get(text(response.request_id));
      if (!pending) return;
      waiting.delete(text(response.request_id));
      clearTimeout(pending.timer);
      if (response.subtype === "error")
        pending.reject(new Error(text(response.error) || "Claude Code rejected initialization."));
      else pending.resolve(response.response);
      return;
    }
    if (value.type === "control_cancel_request") {
      cancelApproval(value.request_id);
      return;
    }
    if (value.type === "control_request") {
      const request = object(value.request);
      if (request.subtype !== "can_use_tool") {
        rejectRequest(value.request_id, "This interactive request is not supported in Tidy yet.");
        return;
      }
      // Questions require answers, not permission to execute with empty input.
      if (request.tool_name === "AskUserQuestion") {
        rejectRequest(
          value.request_id,
          "Ask the user in the conversation instead; interactive question forms are not supported yet.",
        );
        return;
      }
      ask(
        value.request_id,
        text(request.title) ||
          `Allow ${text(request.display_name) || text(request.tool_name) || "tool"}?`,
        text(request.decision_reason) || text(request.description),
        {
          ...object(request.input),
          ...(request.blocked_path ? { blocked_path: request.blocked_path } : {}),
        },
        ["allow", "deny"],
        (decision) =>
          decision === "deny"
            ? { behavior: "deny", message: "The user declined this action in Tidy." }
            : {
                behavior: "allow",
                updatedInput: object(request.input),
                toolUseID: request.tool_use_id,
              },
      );
      return;
    }
    parse(value);
    if (value.type === "result") {
      completed = true;
      clearRequests();
      child.stdin.end();
    }
  }
  const done = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (!completed && !stopped) {
        failure = "The harness input connection closed.";
        terminate();
      }
    });
    child.stdout.on("data", (chunk: string) => {
      if (stopped || closed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        failure = "The harness output exceeded the message limit.";
        terminate();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          consume(object(JSON.parse(line)));
        } catch {
          failure = "The harness returned an invalid event.";
          terminate();
          return;
        }
      }
    });
    child.once("error", () => {
      failure = `Could not start ${codex ? "Codex" : "Claude Code"}. Check its installation.`;
    });
    child.once("close", (code) => {
      if (buffer.trim() && !stopped)
        try {
          consume(object(JSON.parse(buffer)));
        } catch {
          failure = "The harness returned an invalid event.";
        }
      closed = true;
      clearTimeout(force);
      clearRequests();
      if (stopped) resolve();
      else if (failure) reject(new Error(failure));
      else if (!completed || (!codex && code !== 0))
        reject(new Error("The harness stopped before completing its turn."));
      else resolve();
    });
  });
  const ready = (async () => {
    if (codex) {
      await request("initialize", {
        clientInfo: { name: "tidy_desktop", title: "Tidy", version },
      });
      if (stopped || closed) return;
      write({ method: "initialized", params: {} });
      const params = {
        cwd: input.cwd,
        ...codexPermissions(mode),
        model: input.settings?.model ?? null,
        ...(input.settings?.effort || (mode === "default" && input.additionalDirectories?.length)
          ? {
              config: {
                ...(input.settings?.effort
                  ? { model_reasoning_effort: input.settings.effort }
                  : {}),
                ...(mode === "default" && input.additionalDirectories?.length
                  ? { "sandbox_workspace_write.writable_roots": input.additionalDirectories }
                  : {}),
              },
            }
          : {}),
      };
      const response = object(
        await request(input.sessionId ? "thread/resume" : "thread/start", {
          ...params,
          ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
        }),
      );
      threadId = text(object(response.thread).id);
      if (!threadId) throw new Error("Codex did not return a thread identifier.");
      if (stopped || closed) return;
      emit({ type: "session", id: threadId });
      if (typeof response.model === "string") emit({ type: "model", model: response.model });
      deliveryState = "unknown";
      const responseTurn = object(
        await request("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: input.skill
                ? `${input.skill.context}\n\nUser request:\n\n$${input.skill.prompt.slice(1)}`
                : input.prompt,
              text_elements: [],
            },
            ...(input.skill?.invocation.kind === "file"
              ? [
                  {
                    type: "skill",
                    name: input.skill.invocation.name,
                    path: input.skill.invocation.path,
                  },
                ]
              : []),
            ...(input.images ?? []).map((image) => ({ type: "localImage", path: image.path })),
          ],
          ...(input.settings?.effort ? { effort: input.settings.effort } : {}),
        }).catch((error: unknown) => {
          if (error instanceof HarnessRequestError && deliveryState !== "accepted")
            deliveryState = "rejected";
          throw error;
        }),
      );
      deliveryState = "accepted";
      turnId = text(object(responseTurn.turn).id) || turnId;
    } else {
      await request("initialize", {});
      if (stopped || closed) return;
      deliveryState = "unknown";
      if (
        !write({
          type: "user",
          session_id: input.sessionId ?? "",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              ...(input.skill?.invocation.kind === "command"
                ? [
                    { type: "text", text: input.skill.context },
                    {
                      type: "text",
                      text: `/${input.skill.invocation.name}${input.skill.prompt.slice(skillCommand(input.skill.prompt)?.end ?? 0)}`,
                    },
                  ]
                : [{ type: "text", text: input.prompt }]),
              ...(input.images ?? []).map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mimeType, data: image.data },
              })),
            ],
          },
        })
      ) {
        deliveryState = "not-submitted";
        throw new Error("The harness connection closed.");
      }
    }
  })().catch((error: unknown) => {
    if (!stopped && !closed && !completed) {
      failure = error instanceof Error ? error.message : "The harness could not start.";
      terminate();
    }
  });
  return {
    get deliveryState() {
      return deliveryState;
    },
    done,
    stop,
    async steer(message) {
      if (!codex) return false;
      await ready;
      if (stopped || closed || completed || !threadId || !turnId) return false;
      await request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [
          {
            type: "text",
            text: message.skill
              ? `${message.skill.context}\n\nUser request:\n\n$${message.skill.prompt.slice(1)}`
              : message.prompt,
            text_elements: [],
          },
          ...(message.skill?.invocation.kind === "file"
            ? [
                {
                  type: "skill",
                  name: message.skill.invocation.name,
                  path: message.skill.invocation.path,
                },
              ]
            : []),
          ...(message.images ?? []).map((image) => ({ type: "localImage", path: image.path })),
        ],
      });
      return true;
    },
    respondToApproval(id, decision) {
      const approval = approvals.get(id);
      if (stopped || closed || completed || !approval || !approval.choices.includes(decision))
        return false;
      approvals.delete(id);
      const sent = respond(approval.nativeId, approval.result(decision));
      emit({ type: "approval-resolved", id });
      return sent;
    },
  };
}
