import { effectivePermissionMode } from "../../shared/contracts/permissions";
import type { HarnessId } from "../../shared/contracts/desktop";
import type { RunningHarness } from "./harnesses";
import { HarnessSession } from "./interactive-harness";
import type { SessionContext, TurnInput } from "./session-types";

type Entry = {
  context: SessionContext;
  key: string;
  session: HarnessSession;
  timer?: ReturnType<typeof setTimeout>;
  invalidated: boolean;
};
const contextKey = (input: SessionContext) =>
  JSON.stringify([
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
  private generation = 0;
  private changes: Promise<unknown> = Promise.resolve();
  constructor(private options = { idleLimit: 2, idleMs: 120_000 }) {}

  private retire(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.session.close();
    this.retiring.add(entry.session.done);
    void entry.session.done.finally(() => this.retiring.delete(entry.session.done));
  }
  private release(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry || !entry.session.idle) return;
    if (!entry.session.available || entry.invalidated) {
      this.retire(id, entry);
      return;
    }
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.entries.set(id, entry);
    entry.timer = setTimeout(() => this.retire(id, entry), this.options.idleMs);
    entry.timer.unref();
    const idle = [...this.entries].filter(([, item]) => item.session.idle);
    for (const [key, item] of idle.slice(0, Math.max(0, idle.length - this.options.idleLimit)))
      this.retire(key, item);
  }
  private acquire(id: string, context: SessionContext, composer = false): Promise<Entry> {
    const generation = this.generation;
    const operation = this.changes
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation)
          throw new Error("The harness context changed. Try again.");
        const key = contextKey(context);
        let entry = this.entries.get(id);
        if (
          entry &&
          (entry.key !== key ||
            !entry.session.available ||
            (context.sessionId !== undefined
              ? entry.session.sessionId !== context.sessionId
              : entry.context.sessionId !== undefined))
        ) {
          this.retire(id, entry);
          entry = undefined;
        }
        if (!entry && !composer && !context.sessionId) {
          const warm = [...this.entries].find(
            ([key, item]) =>
              key.startsWith("composer:") &&
              item.key === contextKey(context) &&
              item.session.idle &&
              item.session.available,
          );
          if (warm) {
            this.entries.delete(warm[0]);
            entry = warm[1];
            this.entries.set(id, entry);
          }
        }
        if (!entry) {
          if (composer) {
            for (const [key, item] of this.entries)
              if (key.startsWith("composer:")) this.retire(key, item);
          }
          const idle = [...this.entries].filter(([, item]) => item.session.idle);
          for (const [key, item] of idle.slice(
            0,
            Math.max(0, idle.length - this.options.idleLimit + 1),
          ))
            this.retire(key, item);
          await Promise.all(this.retiring);
          if (generation !== this.generation)
            throw new Error("The harness context changed. Try again.");
          const {
            harness,
            executable,
            cwd,
            additionalDirectories,
            sessionId,
            settings,
            superviseParent,
          } = context;
          const binding = {
            harness,
            executable,
            cwd,
            additionalDirectories,
            sessionId,
            settings,
            superviseParent,
          };
          entry = {
            context: binding,
            key,
            session: new HarnessSession(binding),
            invalidated: false,
          };
          this.entries.set(id, entry);
          const current = entry;
          void current.session.done.then(() => {
            for (const [key, item] of this.entries) if (item === current) this.retire(key, item);
          });
        }
        clearTimeout(entry.timer);
        return entry;
      });
    this.changes = operation;
    return operation;
  }
  async warm(id: string, context: SessionContext) {
    const entry = await this.acquire(`composer:${id}`, context, true);
    this.release(`composer:${id}`, entry);
    try {
      await entry.session.ready;
    } catch (error) {
      this.retire(`composer:${id}`, entry);
      throw error;
    }
  }
  start(id: string, input: SessionContext & TurnInput): RunningHarness {
    let run: RunningHarness | undefined;
    let stopped = false;
    const completion = (async () => {
      const entry = await this.acquire(id, input);
      if (stopped) {
        this.release(id, entry);
        return;
      }
      try {
        run = entry.session.start(input);
        await run.done;
      } catch (error) {
        this.retire(id, entry);
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
  clear({ harness, idleOnly = false }: { harness?: HarnessId; idleOnly?: boolean } = {}) {
    this.generation++;
    for (const [id, entry] of this.entries) {
      if (harness && entry.context.harness !== harness) continue;
      entry.invalidated = true;
      if (!idleOnly || entry.session.idle) this.retire(id, entry);
    }
    return Promise.all([...this.retiring]).then(() => {});
  }
}
