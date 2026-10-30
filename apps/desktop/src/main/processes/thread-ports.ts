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
    const owners = [...this.owners].map(([token, owner]) => ({ token, ...owner }));
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        if (this.state) await this.state.write("thread-port-owners", ownershipSchema.parse(owners));
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
      let changed = false;
      for (const token of candidates) {
        if (live.has(token) || this.pending.has(token)) continue;
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
    if (process.platform === "linux" || process.platform === "darwin")
      await this.prune(this.owners.size >= 20_000);
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
      onSpawn: (pid: number, supervised = false) => {
        owner.rootPid = pid;
        owner.supervised = supervised;
        this.pending.delete(token);
        void this.save().catch(() => {});
      },
      onExit: () => {
        this.pending.delete(token);
        if (process.platform === "linux" || process.platform === "darwin")
          void this.prune().catch(() => {});
      },
      bind: async (threadId: string) => {
        const id = z.string().uuid().parse(threadId);
        if (owner.threadId === id) return;
        if (owner.threadId !== null) throw new Error("This process belongs to another thread.");
        owner.threadId = id;
        await this.save();
      },
    };
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
