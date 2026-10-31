import { observeUsage, scopeUsage, usageScope } from "./usage-state";
import { HarnessFailureError } from "./provider-failure";
import { randomUUID } from "node:crypto";
import {
  validatePermissionMode,
  claudePermissionMode,
  type ApprovalDecision,
} from "../../shared/contracts/permissions";
import { createCodexAdapter } from "./codex-adapter";
import { createClaudeAdapter } from "./claude-adapter";
import { createOpenCodeAdapter } from "./opencode-adapter";
import { harnessEnvironment } from "./harnesses";
import {
  HarnessNotSubmittedError,
  HarnessRequestError,
  HarnessTransport,
} from "./harness-transport";
import { plainToolText } from "./tool-events";
import type { HarnessUpdate, RunningHarness } from "./harnesses";
import type { SessionContext, TurnInput, HarnessAdapter, AdapterContext } from "./session-types";

const approvalText = (value: string) =>
  plainToolText(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16)}`,
  );
type Turn = {
  input: TurnInput;
  delivery: NonNullable<RunningHarness["deliveryState"]>;
  completion: ReturnType<typeof Promise.withResolvers<void>>;
  error?: HarnessFailureError;
  started: boolean;
  cancellation?: ReturnType<typeof setTimeout>;
};
type State =
  | { kind: "idle" }
  | { kind: "running"; turn: Turn }
  | { kind: "cancelling"; turn: Turn; acknowledged: boolean; completed: boolean }
  | { kind: "closed" };

export function harnessArguments(input: SessionContext) {
  const mode = validatePermissionMode(input.harness, input.settings?.permissionMode);
  switch (input.harness) {
    case "codex":
      return ["app-server", "--listen", "stdio://"];
    case "opencode":
      return ["acp", "--cwd", input.cwd];
    case "claude":
      return [
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
    default: {
      const _exhaustive: never = input.harness;
      return _exhaustive;
    }
  }
}

export class HarnessSession {
  private state: State = { kind: "idle" };
  private transport: HarnessTransport;
  private adapter: HarnessAdapter;
  private metadata = new Map<"session" | "model", HarnessUpdate>();
  private approvals = new Map<
    string,
    { nativeId: unknown; choices: ApprovalDecision[]; result(decision: ApprovalDecision): unknown }
  >();
  private backgroundTasks = new Set<string>();
  private backgroundOverflow = false;
  private activityAt = performance.now();
  onActivity: () => void = () => {};
  sessionId?: string;
  readonly ready: Promise<void>;
  readonly done: Promise<void>;

  constructor({
    harness,
    executable,
    cwd,
    additionalDirectories,
    sessionId,
    settings,
    superviseParent,
    environment,
    onSpawn,
    onExit,
  }: SessionContext) {
    const input = {
      harness,
      executable,
      cwd,
      additionalDirectories,
      sessionId,
      settings,
      superviseParent,
    };
    this.sessionId = input.sessionId;
    this.transport = new HarnessTransport({
      ...input,
      args: harnessArguments(input),
      protocol: input.harness === "claude" ? "claude" : "jsonrpc",
      onSpawn,
      onExit,
      env: {
        ...harnessEnvironment(harness),
        ...environment,
        ...(input.harness === "opencode" && input.settings?.permissionMode !== "provider-auto"
          ? {
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                permission: input.settings?.permissionMode === "auto" ? "allow" : "ask",
              }),
            }
          : {}),
      },
    });
    this.done = this.transport.done;
    const context: AdapterContext = {
      input,
      transport: this.transport,
      activity: (event) => {
        if (event?.state === "started") {
          if (this.backgroundTasks.has(event.id) || this.backgroundTasks.size < 1000)
            this.backgroundTasks.add(event.id);
          else this.backgroundOverflow = true;
        } else if (event?.state === "finished") this.backgroundTasks.delete(event.id);
        this.activityAt = performance.now();
        if (this.idle) this.onActivity();
      },
      isActive: () =>
        (this.state.kind === "running" || this.state.kind === "cancelling") &&
        this.state.turn.delivery !== "not-submitted",
      emit: (update) => this.emit(update),
      complete: (error) => this.finish(error),
      submitting: () => {
        if (this.state.kind === "running") this.state.turn.delivery = "unknown";
      },
      accepted: () => {
        if (this.state.kind !== "running") return;
        const turn = this.state.turn;
        turn.delivery = "accepted";
        if (!turn.started) {
          turn.started = true;
          this.emit({ type: "started" });
        }
      },
      ask: (...args) => this.ask(...args),
      cancelApproval: (nativeId) => {
        for (const [id, value] of this.approvals)
          if (value.nativeId === nativeId) {
            this.approvals.delete(id);
            this.emit({ type: "approval-resolved", id });
          }
      },
    };
    const adapters = {
      codex: createCodexAdapter,
      claude: createClaudeAdapter,
      opencode: createOpenCodeAdapter,
    };
    this.adapter = adapters[input.harness](context);
    let scope: string | undefined;
    this.transport.onMessage = (value) => {
      if (scope !== undefined) observeUsage(harness, cwd, value, scope);
      this.adapter.consume(value);
    };
    this.transport.onClose = (error) => {
      if (this.state.kind === "cancelling") this.state.acknowledged = true;
      this.finish(error);
      this.state = { kind: "closed" };
    };
    this.ready = this.adapter
      .initialize()
      .then(() => {
        if (harness !== "codex") {
          scope = usageScope(harness, cwd);
          return;
        }
        const previousScope = usageScope(harness, cwd);
        // Optional accounting must not delay a turn. Ignore events until this connection's
        // identity is known, and don't let a late read replace a newer account's scope.
        void this.transport
          .request("account/read", { refreshToken: false }, 1000)
          .then((account) => {
            if (!this.available || usageScope(harness, cwd) !== previousScope) return;
            scopeUsage(harness, cwd, account);
            scope = usageScope(harness, cwd);
          })
          .catch(() => {});
      })
      .catch((error: unknown) => {
        this.finish(
          error instanceof Error ? error : new Error("The harness could not initialize."),
        );
        this.close();
        throw error;
      });
    void this.ready.catch(() => {});
  }
  get available() {
    return this.state.kind !== "closed" && this.transport.available;
  }
  get idle() {
    return this.state.kind === "idle";
  }
  get hasBackgroundWork() {
    return this.backgroundOverflow || this.backgroundTasks.size > 0;
  }
  get lastProviderActivity() {
    return this.activityAt;
  }
  private emit(update: HarnessUpdate) {
    if (update.type === "session") this.sessionId = update.id;
    if (update.type === "session" || update.type === "model")
      this.metadata.set(update.type, update);
    if (this.state.kind !== "running") return;
    if (update.type === "error")
      this.state.turn.error = new HarnessFailureError(update.text, update.kind);
    else if (update.type === "error-cleared" && this.state.turn.error?.message === update.text)
      this.state.turn.error = undefined;
    if (update.type === "message" || update.type === "tool" || update.type === "approval")
      this.state.turn.delivery = "accepted";
    this.state.turn.input.onUpdate(update);
  }
  private ask(
    ...[nativeId, title, reason, details, choices, result, scope]: Parameters<AdapterContext["ask"]>
  ) {
    if (this.state.kind !== "running" || this.approvals.size >= 20) {
      this.transport.reject(nativeId, "No matching active permission request.");
      return;
    }
    if ([...this.approvals.values()].some((value) => value.nativeId === nativeId)) return;
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
    this.approvals.set(id, { nativeId, choices: available, result });
    this.emit({
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
  private clearApprovals() {
    for (const [id] of this.approvals) this.emit({ type: "approval-resolved", id });
    this.approvals.clear();
  }
  private finish(error?: Error) {
    if (this.state.kind !== "running" && this.state.kind !== "cancelling") return;
    if (this.state.kind === "cancelling" && !this.state.acknowledged) {
      this.state.completed = true;
      return;
    }
    const { turn } = this.state;
    const cancelled = this.state.kind === "cancelling";
    clearTimeout(turn.cancellation);
    this.clearApprovals();
    this.state = { kind: "idle" };
    if (!cancelled && (error || turn.error)) turn.completion.reject(error ?? turn.error);
    else turn.completion.resolve();
  }
  start(input: TurnInput): RunningHarness {
    if (!this.available || !this.idle) throw new Error("The harness session is unavailable.");
    const turn: Turn = {
      input,
      delivery: "not-submitted",
      completion: Promise.withResolvers<void>(),
      started: false,
    };
    this.state = { kind: "running", turn };
    const submission = (async () => {
      await this.ready;
      if (this.state.kind !== "running" || this.state.turn !== turn) return;
      for (const update of this.metadata.values()) this.emit(update);
      await this.adapter.submit(input);
    })();
    void submission.catch((error: unknown) => {
      if (
        (this.state.kind !== "running" && this.state.kind !== "cancelling") ||
        this.state.turn !== turn
      )
        return;
      if (error instanceof HarnessNotSubmittedError) turn.delivery = "not-submitted";
      if (error instanceof HarnessRequestError && turn.delivery !== "accepted")
        turn.delivery = "rejected";
      this.finish(error instanceof Error ? error : new Error("The harness could not start."));
      this.close();
    });
    return {
      get deliveryState() {
        return turn.delivery;
      },
      done: turn.completion.promise,
      stop: () => {
        if (this.state.kind !== "running" || this.state.turn !== turn) return;
        this.state = { kind: "cancelling", turn, acknowledged: false, completed: false };
        this.clearApprovals();
        turn.cancellation = setTimeout(() => this.close(), 2000);
        turn.cancellation.unref();
        void this.ready
          .then(() => {
            if (this.state.kind !== "cancelling" || this.state.turn !== turn) return;
            if (turn.delivery === "not-submitted") this.close();
            else return this.adapter.interrupt();
          })
          .then(() => {
            if (this.state.kind === "cancelling" && this.state.turn === turn) {
              this.state.acknowledged = true;
              if (this.state.completed) this.finish();
            }
          })
          .catch(() => this.close());
      },
      steer: async (message) => {
        try {
          await submission;
        } catch {
          return false;
        }
        return this.state.kind === "running" && this.state.turn === turn && this.adapter.steer
          ? this.adapter.steer(message)
          : false;
      },
      respondToApproval: (id, decision) => {
        if (this.state.kind !== "running" || this.state.turn !== turn) return false;
        const approval = this.approvals.get(id);
        if (!approval || !approval.choices.includes(decision)) return false;
        this.approvals.delete(id);
        const sent = this.transport.respond(approval.nativeId, approval.result(decision));
        this.emit({ type: "approval-resolved", id });
        return sent;
      },
    };
  }
  close() {
    if (this.state.kind === "closed") return;
    if (this.state.kind === "cancelling") this.state.acknowledged = true;
    this.finish(new Error("The harness session closed."));
    this.state = { kind: "closed" };
    this.transport.close();
  }
}

export function startInteractiveHarness(input: SessionContext & TurnInput): RunningHarness {
  let session: HarnessSession;
  try {
    session = new HarnessSession(input);
  } catch (error) {
    input.onExit?.();
    throw error;
  }
  const turn = session.start(input);
  void turn.done.finally(() => session.close()).catch(() => {});
  return turn;
}
