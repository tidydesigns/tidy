import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { PrivateState } from "../platform/private-state";
import type { ThreadPort } from "../../shared/contracts/thread-ports";
import {
  inspectOwnedProcess,
  inspectProcessIdentity,
  ownedDescendants,
  scanOwnedListeners,
  scanOwnedProcesses,
  scanProcessDescendants,
  scanProcessGroups,
  THREAD_OWNER_ENV,
  type OwnedProcess,
  type ProcessListener,
} from "./port-scanner";

type TrackedPort = { id: string; processId: string; listener: ProcessListener };
const ownershipSchema = z
  .array(
    z
      .object({
        token: z.string().uuid(),
        projectId: z.string().uuid(),
        threadId: z.string().uuid().nullable(),
        rootPid: z.number().int().positive().optional(),
        rootIdentity: z.string().min(1).max(200).optional(),
        groupId: z.number().int().positive().optional(),
        supervised: z.boolean().optional(),
      })
      .strict(),
  )
  .max(20_000);
type Owner = Omit<z.infer<typeof ownershipSchema>[number], "token">;

export class ThreadPorts {
  private owners = new Map<string, Owner>();
  private ports = new Map<string, TrackedPort>();
  private scanning?: Promise<void>;
  private scannedAt = 0;
  private retiring = new Map<string, Promise<void>>();
  private stopping = new Map<string, Promise<void>>();
  private initialized?: Promise<void>;
  private writes = Promise.resolve();
  private pending = new Set<string>();
  private pruning?: Promise<void>;
  private prunedAt = 0;

  constructor(private state?: PrivateState) {}

  async flush() {
    await this.writes;
  }

  private initialize() {
    return (this.initialized ??= (async () => {
      if (!this.state) return;
      const value = await this.state.read("thread-port-owners");
      for (const { token, ...owner } of ownershipSchema.parse(value ?? []))
        this.owners.set(token, owner);
    })());
  }

  private save() {
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        const owners = [...this.owners].map(([token, owner]) => ({ token, ...owner }));
        if (this.state)
          await this.state.write("thread-port-owners", ownershipSchema.parse(owners), {
            durable: true,
          });
      });
    this.writes = write;
    return write;
  }

  private async prune(force = false) {
    if (this.pruning) await this.pruning;
    if (!force && Date.now() - this.prunedAt < 60_000) return;
    const operation = (async () => {
      const candidates = new Set(
        [...this.owners.keys()].filter((token) => !this.pending.has(token)),
      );
      const live = new Set((await scanOwnedProcesses(candidates)).map((entry) => entry.owner));
      const groups = new Set(
        [...candidates].flatMap((token) => {
          const owner = this.owners.get(token)!;
          return !live.has(token) && owner.groupId ? [owner.groupId] : [];
        }),
      );
      const liveGroups = new Set((await scanProcessGroups(groups)).map((entry) => entry.groupId));
      let changed = false;
      for (const token of candidates) {
        if (live.has(token) || this.pending.has(token)) continue;
        const owner = this.owners.get(token)!;
        if (owner.rootPid) {
          const identity = await inspectProcessIdentity(owner.rootPid);
          if (identity && (!owner.rootIdentity || identity === owner.rootIdentity)) continue;
        }
        if (owner.groupId && liveGroups.has(owner.groupId)) continue;
        changed = this.owners.delete(token) || changed;
      }
      if (changed) {
        this.scannedAt = 0;
        await this.save();
      }
      this.prunedAt = Date.now();
    })();
    this.pruning = operation;
    try {
      await operation;
    } finally {
      if (this.pruning === operation) this.pruning = undefined;
    }
  }

  private isAgent(entry: OwnedProcess, owner: Owner) {
    return (
      entry.pid === process.pid ||
      entry.pid === owner.rootPid ||
      (owner.supervised && entry.parentPid === owner.rootPid)
    );
  }

  async register(input: { projectId: string; threadId: string | null }) {
    await this.initialize();
    if (input.threadId && this.retiring.has(`${input.projectId}:${input.threadId}`))
      throw new Error("The previous agent is still being retired.");
    if (process.platform === "linux" || process.platform === "darwin")
      await this.prune(this.owners.size >= 20_000);
    if (input.threadId && this.retiring.has(`${input.projectId}:${input.threadId}`))
      throw new Error("The previous agent is still being retired.");
    if (this.owners.size >= 20_000) throw new Error("Local process ownership storage is full.");
    const token = randomUUID();
    const owner: Owner = { ...input };
    this.owners.set(token, owner);
    this.pending.add(token);
    try {
      await this.save();
    } catch (error) {
      this.pending.delete(token);
      this.owners.delete(token);
      throw error;
    }
    this.scannedAt = 0;
    return {
      environment: { [THREAD_OWNER_ENV]: token },
      onSpawn: (pid: number, supervised = false, groupId?: number) => {
        owner.rootPid = pid;
        owner.supervised = supervised;
        owner.groupId = groupId;
        // Include birth-identity capture in flush(), without changing the synchronous spawn hook.
        delete owner.rootIdentity;
        this.writes = this.writes
          .catch(() => {})
          .then(async () => {
            try {
              // spawn() can return before exec installs the child's environment.
              const deadline = performance.now() + 1000;
              do {
                const entry = await inspectOwnedProcess(pid, new Set([token]));
                if (entry && owner.rootPid === pid) {
                  owner.rootIdentity = entry.identity;
                  break;
                }
                if (!(await inspectProcessIdentity(pid))) break;
                await delay(25);
              } while (performance.now() < deadline);
              if (!owner.rootIdentity && (await inspectProcessIdentity(pid)))
                throw new Error("Could not verify the spawned agent's process identity.");
            } finally {
              this.pending.delete(token);
            }
          });
        const captured = this.writes;
        const saved = this.save();
        const ready = captured.then(() => saved);
        void ready.catch(() => {});
        return ready;
      },
      onExit: () => {
        this.pending.delete(token);
        if (process.platform === "linux" || process.platform === "darwin")
          void this.prune().catch(() => {});
      },
      bind: async (threadId: string) => {
        const id = z.string().uuid().parse(threadId);
        if (this.retiring.has(`${owner.projectId}:${id}`))
          throw new Error("The previous agent is still being retired.");
        if (owner.threadId === id) return;
        if (owner.threadId !== null) throw new Error("This process belongs to another thread.");
        owner.threadId = id;
        await this.save();
      },
    };
  }

  /** Resolve only after verified old agents are gone. Failure must block automatic recovery. */
  retireAgent(input: { projectId: string; threadId: string }): Promise<void> {
    const projectId = z.string().uuid().parse(input.projectId);
    const threadId = z.string().uuid().parse(input.threadId);
    const key = `${projectId}:${threadId}`;
    const existing = this.retiring.get(key);
    if (existing) return existing;
    const operation = this.retire({ projectId, threadId }).finally(() => {
      this.retiring.delete(key);
      this.scannedAt = 0;
    });
    this.retiring.set(key, operation);
    return operation;
  }

  /** Revalidate both the private token and birth identity immediately before every signal. */
  private async signalRetiredAgent(entry: OwnedProcess, signal: NodeJS.Signals) {
    if (entry.pid <= 1 || entry.pid === process.pid)
      throw new Error("Cannot retire this agent process.");
    if ((await inspectProcessIdentity(entry.pid)) !== entry.identity) return false;
    const current = await inspectOwnedProcess(entry.pid, new Set([entry.owner]));
    if (!current || current.identity !== entry.identity) {
      if ((await inspectProcessIdentity(entry.pid)) !== entry.identity) return false;
      throw new Error("Could not verify the previous agent's process ownership.");
    }
    try {
      process.kill(entry.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new Error("Could not stop the previous agent process.");
    }
  }

  private async retire(input: { projectId: string; threadId: string }) {
    if (process.platform !== "linux" && process.platform !== "darwin")
      throw new Error("Agent retirement is not supported on this computer.");
    await this.initialize();
    await this.writes;
    const owners = [...this.owners].filter(
      ([, owner]) => owner.projectId === input.projectId && owner.threadId === input.threadId,
    );
    if (!owners.length) return;
    if (owners.some(([token]) => this.pending.has(token)))
      throw new Error("Could not verify the previous agent's ownership record.");
    if (owners.length > 128) throw new Error("Too many previous agent roots to retire safely.");
    const tokens = new Set(owners.map(([token]) => token));
    const targets = new Map<string, OwnedProcess>();
    const frozen = new Map<string, OwnedProcess>();
    const deadline = performance.now() + 5000;
    const checkDeadline = () => {
      if (performance.now() >= deadline)
        throw new Error("Could not stabilize the previous agent's process tree.");
    };
    try {
      // Validate every root before touching any process. Reused PIDs never confer authority.
      for (const [token, owner] of owners) {
        checkDeadline();
        if (!owner.rootPid) {
          if ((await scanOwnedProcesses(new Set([token]))).length)
            throw new Error("The previous agent has no verified root process.");
          continue;
        }
        const identity = await inspectProcessIdentity(owner.rootPid);
        if (!identity) continue;
        if (!owner.rootIdentity)
          throw new Error(
            "The previous agent has no recorded process identity. Stop it manually before retrying.",
          );
        if (identity !== owner.rootIdentity) continue;
        const root = await inspectOwnedProcess(owner.rootPid, new Set([token]));
        if (!root || root.identity !== identity) {
          if ((await inspectProcessIdentity(owner.rootPid)) !== identity) continue;
          throw new Error("Could not verify the previous agent's process ownership.");
        }
        if (root.pid <= 1 || root.pid === process.pid)
          throw new Error("Cannot retire this agent process.");
        targets.set(root.identity, root);
      }
      // Stop creation of new descendants while enumerating. Untagged children cause refusal.
      for (let round = 0; ; round++) {
        if (round >= 64 || performance.now() >= deadline)
          throw new Error("Could not stabilize the previous agent's process tree.");
        for (const entry of targets.values()) {
          if (performance.now() >= deadline)
            throw new Error("Could not stabilize the previous agent's process tree.");
          if (frozen.has(entry.identity)) continue;
          if (!(await this.signalRetiredAgent(entry, "SIGSTOP")))
            throw new Error("The previous agent changed while verifying its descendants.");
          frozen.set(entry.identity, entry);
        }
        const descendants = await scanProcessDescendants([...targets.values()]);
        let added = false;
        for (const entry of descendants) {
          checkDeadline();
          if (targets.has(entry.identity)) continue;
          const owned = await inspectOwnedProcess(entry.pid, tokens);
          if (!owned || owned.identity !== entry.identity)
            throw new Error("Could not verify the previous agent's descendant ownership.");
          if (targets.size >= 128)
            throw new Error("Too many previous agent descendants to retire safely.");
          targets.set(owned.identity, owned);
          added = true;
        }
        if (!added) break;
      }
      for (const entry of frozen.values()) {
        checkDeadline();
        if ((await inspectProcessIdentity(entry.pid)) !== entry.identity)
          throw new Error("The previous agent changed while verifying its descendants.");
      }
      // Detached/reparented actors cannot be claimed by a token alone. Leave them untouched.
      const assertNoUnknownActors = async () => {
        for (const entry of await scanOwnedProcesses(tokens)) {
          if ((await inspectProcessIdentity(entry.pid)) !== entry.identity) continue;
          if (!targets.has(entry.identity))
            throw new Error(
              "An unverified process still holds the previous agent's ownership token. Tidy will retry automatically after it exits.",
            );
        }
        const groups = new Set(
          owners.flatMap(([, owner]) => (owner.groupId ? [owner.groupId] : [])),
        );
        for (const entry of await scanProcessGroups(groups)) {
          if (
            !targets.has(entry.identity) &&
            (await inspectProcessIdentity(entry.pid)) === entry.identity
          )
            throw new Error(
              "An unverified process remains in the previous agent's process group. Tidy will retry automatically after it exits.",
            );
        }
      };
      await assertNoUnknownActors();
      checkDeadline();
      const ordered = [...targets.values()].reverse();
      for (const entry of ordered) await this.signalRetiredAgent(entry, "SIGTERM");
      for (const entry of ordered) await this.signalRetiredAgent(entry, "SIGCONT");
      const wait = async (duration: number) => {
        const deadline = performance.now() + duration;
        do {
          if (
            (await Promise.all(ordered.map((entry) => inspectProcessIdentity(entry.pid)))).every(
              (identity, index) => identity !== ordered[index].identity,
            )
          )
            return true;
          await delay(80);
        } while (performance.now() < deadline);
        return false;
      };
      if (!(await wait(1500))) {
        for (const entry of ordered) await this.signalRetiredAgent(entry, "SIGKILL");
        if (!(await wait(1000)))
          throw new Error("The previous agent is still running. Stop it manually before retrying.");
      }
      await assertNoUnknownActors();
    } finally {
      // A refused retirement must not strand verified processes in SIGSTOP.
      let thawFailure = false;
      for (const entry of frozen.values()) {
        let failure: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.signalRetiredAgent(entry, "SIGCONT");
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            try {
              // Undo only our own pause on the same birth identity. This fallback never terminates a process.
              if ((await inspectProcessIdentity(entry.pid)) !== entry.identity) {
                failure = undefined;
                break;
              }
              process.kill(entry.pid, "SIGCONT");
              failure = undefined;
              break;
            } catch {
              await delay(50);
            }
          }
        }
        if (failure) thawFailure = true;
      }
      if (thawFailure)
        throw new Error(
          "Could not resume a paused previous agent safely. Recovery will retry its ownership checks.",
        );
    }
  }

  private async scan(force = false) {
    while (this.scanning) await this.scanning;
    if (!force && Date.now() - this.scannedAt < 1500) return;
    const scanning = (async () => {
      const listeners = await scanOwnedListeners(new Set(this.owners.keys()));
      const previous = new Map(
        [...this.ports.values()].map((entry) => [this.key(entry.listener), entry]),
      );
      const processIds = new Map(
        [...this.ports.values()].map((entry) => [
          `${entry.listener.owner}:${entry.listener.identity}`,
          entry.processId,
        ]),
      );
      const next = new Map<string, TrackedPort>();
      for (const listener of listeners) {
        const owner = this.owners.get(listener.owner);
        if (!owner || this.isAgent(listener, owner)) continue;
        const key = this.key(listener);
        const id = previous.get(key)?.id ?? randomUUID();
        const processKey = `${listener.owner}:${listener.identity}`;
        const processId = processIds.get(processKey) ?? randomUUID();
        processIds.set(processKey, processId);
        next.set(id, { id, processId, listener });
      }
      for (const entry of this.ports.values()) {
        if (next.has(entry.id)) continue;
        const listener = entry.listener;
        if (this.stopping.has(listener.identity)) continue;
        if (
          !(await inspectOwnedProcess(listener.pid, new Set([listener.owner]))) &&
          (await inspectProcessIdentity(listener.pid)) === listener.identity
        )
          throw new Error("Could not verify the thread's port ownership.");
      }
      this.ports = next;
      this.scannedAt = Date.now();
    })();
    this.scanning = scanning;
    try {
      await scanning;
    } finally {
      if (this.scanning === scanning) this.scanning = undefined;
    }
  }

  private key(listener: ProcessListener) {
    return `${listener.owner}:${listener.identity}:${listener.host}:${listener.port}`;
  }

  async list(input: { projectId: string; threadId: string }): Promise<ThreadPort[]> {
    await this.initialize();
    await this.writes;
    if (
      ![...this.owners.values()].some(
        (owner) => owner.projectId === input.projectId && owner.threadId === input.threadId,
      )
    )
      return [];
    await this.scan();
    return [...this.ports.values()]
      .filter(({ listener }) => {
        const owner = this.owners.get(listener.owner);
        return owner?.projectId === input.projectId && owner.threadId === input.threadId;
      })
      .sort((a, b) => a.listener.port - b.listener.port)
      .slice(0, 100)
      .map(({ id, processId, listener }) => ({
        id,
        processId,
        processName: listener.name,
        port: listener.port,
        host: listener.host,
      }));
  }

  async stop(input: { projectId: string; threadId: string; portId: string }) {
    const target = this.ports.get(input.portId);
    const owner = target && this.owners.get(target.listener.owner);
    if (!target || owner?.projectId !== input.projectId || owner.threadId !== input.threadId)
      throw new Error("This port is no longer owned by this thread.");
    const existing = this.stopping.get(target.listener.identity);
    if (existing) return existing;
    const operation = this.stopListener(target.listener);
    this.stopping.set(target.listener.identity, operation);
    try {
      await operation;
    } finally {
      this.stopping.delete(target.listener.identity);
      this.scannedAt = 0;
    }
  }

  private async signal(entry: OwnedProcess, signal: NodeJS.Signals) {
    const current = await inspectOwnedProcess(entry.pid, new Set([entry.owner]));
    if (!current || current.identity !== entry.identity) {
      if ((await inspectProcessIdentity(entry.pid)) === entry.identity)
        throw new Error("Could not verify this process still belongs to the thread.");
      return;
    }
    const owner = this.owners.get(entry.owner);
    if (!owner || this.isAgent(current, owner))
      throw new Error("Cannot stop the thread's agent process.");
    try {
      process.kill(entry.pid, signal);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH"))
        throw new Error("Could not stop this process. Try again.");
    }
  }

  private async stopListener(listener: ProcessListener) {
    await this.scan(true);
    if (![...this.ports.values()].some((entry) => this.key(entry.listener) === this.key(listener)))
      throw new Error("This port changed before it could be stopped. Refresh and try again.");
    const descendants = await ownedDescendants(listener);
    const targets = [...descendants.reverse(), listener];
    for (const entry of targets) await this.signal(entry, "SIGTERM");
    const exited = async () => {
      const current = await Promise.all(targets.map((entry) => inspectProcessIdentity(entry.pid)));
      return current.every((identity, index) => identity !== targets[index].identity);
    };
    const wait = async (duration: number) => {
      const deadline = Date.now() + duration;
      do {
        if (await exited()) return true;
        await delay(80);
      } while (Date.now() < deadline);
      return false;
    };
    if (await wait(1500)) return;
    for (const entry of targets) await this.signal(entry, "SIGKILL");
    if (!(await wait(1000)))
      throw new Error("The process is still running. Try stopping it again.");
  }
}
