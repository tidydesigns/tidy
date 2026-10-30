import { isAbsolute, relative, sep } from "node:path";
import { effectivePermissionMode } from "../../shared/contracts/permissions";
import type { HarnessId } from "../../shared/contracts/desktop";
import type { RunningHarness } from "./harnesses";
import { HarnessSession } from "./interactive-harness";
import { HarnessNotSubmittedError } from "./harness-transport";
import type { ProcessRegistration, SessionContext, TurnInput } from "./session-types";

type ManagedContext = SessionContext & { projectId: string };
type SessionFilter = {
  harness?: HarnessId;
  projectIds?: ReadonlySet<string>;
  cwd?: string;
  directory?: string;
};
const matches = (context: ManagedContext, filter: SessionFilter) => {
  if (filter.harness && context.harness !== filter.harness) return false;
  if (filter.projectIds && !filter.projectIds.has(context.projectId)) return false;
  if (filter.cwd && context.cwd !== filter.cwd) return false;
  if (filter.directory) {
    const path = relative(filter.directory, context.cwd);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return false;
  }
  return true;
};
type Entry = {
  id: string;
  context: ManagedContext;
  key: string;
  session: HarnessSession;
  timer?: ReturnType<typeof setTimeout>;
  invalidated: boolean;
  background: boolean;
  expiresAt: number;
  processOwner?: ProcessRegistration;
};
const contextKey = (input: ManagedContext) =>
  JSON.stringify([
    input.projectId,
    input.harness,
    input.executable,
    input.cwd,
    input.additionalDirectories ?? [],
    input.settings?.model,
    input.settings?.effort,
    effectivePermissionMode(input.harness, input.settings?.permissionMode),
    !!input.superviseParent,
  ]);

export class HarnessSessions {
  private entries = new Map<string, Entry>();
  private retiring = new Set<Promise<void>>();
  private acquiring = new Set<{ context: ManagedContext; invalidated: boolean }>();
  private changes: Promise<unknown> = Promise.resolve();
  constructor(
    private options: { idleLimit: number; idleMs: number; backgroundSilentMs?: number } = {
      idleLimit: 2,
      idleMs: 30 * 60_000,
    },
  ) {}

  private disposable() {
    return [...this.entries].filter(
      ([, entry]) => entry.session.idle && !entry.session.hasBackgroundWork,
    );
  }
  get backgroundContexts() {
    return [...this.entries.values()]
      .filter((entry) => entry.session.available && entry.session.hasBackgroundWork)
      .map(({ id, context }) => ({ threadId: id, harness: context.harness, cwd: context.cwd }));
  }

  private retire(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.session.close();
    this.retiring.add(entry.session.done);
    void entry.session.done.finally(() => this.retiring.delete(entry.session.done));
  }
  private scheduleExpiry(entry: Entry) {
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        if (this.entries.get(entry.id) !== entry || !entry.session.idle) return;
        if (entry.expiresAt > performance.now()) this.scheduleExpiry(entry);
        else this.retire(entry.id, entry);
      },
      Math.max(1, entry.expiresAt - performance.now()),
    );
    entry.timer.unref();
  }
  private activity(entry: Entry) {
    if (this.entries.get(entry.id) !== entry || !entry.session.idle) return;
    if (
      !entry.timer ||
      entry.background !== entry.session.hasBackgroundWork ||
      (entry.invalidated && !entry.background)
    ) {
      this.release(entry.id, entry);
      return;
    }
    entry.expiresAt = this.expiry(entry);
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
  }
  private expiry(entry: Entry) {
    return entry.session.hasBackgroundWork
      ? entry.session.lastProviderActivity + (this.options.backgroundSilentMs ?? 4 * 60 * 60_000)
      : performance.now() + this.options.idleMs;
  }
  private release(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry || !entry.session.idle) return;
    if (!entry.session.available || (entry.invalidated && !entry.session.hasBackgroundWork)) {
      this.retire(id, entry);
      return;
    }
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.entries.set(id, entry);
    entry.background = entry.session.hasBackgroundWork;
    entry.expiresAt = this.expiry(entry);
    this.scheduleExpiry(entry);
    const idle = this.disposable();
    for (const [key, item] of idle.slice(0, Math.max(0, idle.length - this.options.idleLimit)))
      this.retire(key, item);
  }
  private acquire(id: string, context: ManagedContext, composer = false): Promise<Entry> {
    const pending = { context, invalidated: false };
    this.acquiring.add(pending);
    const operation = this.changes
      .catch(() => {})
      .then(async () => {
        if (pending.invalidated) throw new Error("The harness context changed. Try again.");
        const key = contextKey(context);
        let entry = this.entries.get(id);
        if (
          entry &&
          (entry.invalidated ||
            entry.key !== key ||
            !entry.session.available ||
            (context.sessionId !== undefined
              ? entry.session.sessionId !== context.sessionId
              : entry.context.sessionId !== undefined))
        ) {
          if (entry.session.available && (!entry.session.idle || entry.session.hasBackgroundWork))
            throw new HarnessNotSubmittedError(
              "Wait for background work to finish before changing this conversation's settings.",
            );
          this.retire(id, entry);
          entry = undefined;
        }
        if (!entry && !composer && !context.sessionId) {
          const warm = [...this.entries].find(
            ([id, item]) =>
              id.startsWith("composer:") &&
              item.key === key &&
              item.session.idle &&
              item.session.available,
          );
          if (warm) {
            this.entries.delete(warm[0]);
            entry = warm[1];
            entry.id = id;
            this.entries.set(id, entry);
          }
        }
        if (!entry) {
          if (composer) {
            for (const [key, item] of this.entries)
              if (key.startsWith("composer:")) this.retire(key, item);
          }
          const idle = this.disposable();
          for (const [key, item] of idle.slice(
            0,
            Math.max(0, idle.length - this.options.idleLimit + 1),
          ))
            this.retire(key, item);
          await Promise.all(this.retiring);
          if (pending.invalidated) throw new Error("The harness context changed. Try again.");
          const {
            projectId,
            harness,
            executable,
            cwd,
            additionalDirectories,
            sessionId,
            settings,
            superviseParent,
          } = context;
          const binding = {
            projectId,
            harness,
            executable,
            cwd,
            additionalDirectories,
            sessionId,
            settings,
            superviseParent,
            environment: context.environment,
            onSpawn: context.onSpawn,
            onExit: context.onExit,
          };
          const processOwner = await context.processRegistration?.();
          if (pending.invalidated) {
            processOwner?.onExit();
            throw new Error("The harness context changed. Try again.");
          }
          if (processOwner) {
            binding.environment = processOwner.environment;
            binding.onSpawn = processOwner.onSpawn;
            binding.onExit = processOwner.onExit;
          }
          let session: HarnessSession;
          try {
            session = new HarnessSession(binding);
          } catch (error) {
            processOwner?.onExit();
            throw error;
          }
          entry = {
            id,
            context: binding,
            key,
            session,
            invalidated: false,
            background: false,
            expiresAt: 0,
            processOwner,
          };
          this.entries.set(id, entry);
          const current = entry;
          current.session.onActivity = () => this.activity(current);
          void current.session.done.then(() => {
            for (const [key, item] of this.entries) if (item === current) this.retire(key, item);
          });
        }
        clearTimeout(entry.timer);
        if (!composer) await entry.processOwner?.bind(id);
        return entry;
      })
      .finally(() => this.acquiring.delete(pending));
    this.changes = operation;
    return operation;
  }
  async prepare({
    kind,
    id,
    context,
  }: {
    kind: "composer" | "thread";
    id: string;
    context: ManagedContext;
  }) {
    const key = kind === "composer" ? `composer:${id}` : id;
    const entry = await this.acquire(key, context, kind === "composer");
    if (!entry.session.idle) return;
    this.release(key, entry);
    try {
      await entry.session.ready;
    } catch (error) {
      this.retire(key, entry);
      throw error;
    }
  }
  start(id: string, input: ManagedContext & TurnInput): RunningHarness {
    let run: RunningHarness | undefined;
    let stopped = false;
    const completion = (async () => {
      const entry = await this.acquire(id, input);
      if (stopped) {
        this.release(id, entry);
        return;
      }
      if (!entry.session.idle)
        throw new HarnessNotSubmittedError("This conversation already has a running turn.");
      try {
        run = entry.session.start(input);
        await run.done;
      } catch (error) {
        if (!entry.session.available || !entry.session.hasBackgroundWork) this.retire(id, entry);
        throw error;
      } finally {
        this.release(id, entry);
      }
    })();
    return {
      get deliveryState() {
        return run?.deliveryState ?? "not-submitted";
      },
      done: completion,
      stop() {
        stopped = true;
        run?.stop();
      },
      async steer(message) {
        return run?.steer ? run.steer(message) : false;
      },
      respondToApproval(id, decision) {
        return run?.respondToApproval?.(id, decision) ?? false;
      },
    };
  }
  clear({ idleOnly = false, ...filter }: SessionFilter & { idleOnly?: boolean } = {}) {
    for (const pending of this.acquiring)
      if (matches(pending.context, filter)) pending.invalidated = true;
    for (const [id, entry] of this.entries) {
      if (!matches(entry.context, filter)) continue;
      entry.invalidated = true;
      if (!idleOnly || (entry.session.idle && !entry.session.hasBackgroundWork))
        this.retire(id, entry);
    }
    return Promise.all([...this.retiring]).then(() => {});
  }
}
