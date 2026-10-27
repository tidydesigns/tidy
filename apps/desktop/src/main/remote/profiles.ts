import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { machineSchema, remoteTargetSchema, type RemoteMachine } from "../../shared/remote";
import { writePrivateJSON } from "./session-store";

export class MachineProfiles {
  private values: RemoteMachine[] = [];
  private writes = Promise.resolve();
  constructor(private path: string) {}
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.values = z
        .array(machineSchema)
        .max(100)
        .parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  list() {
    return structuredClone(this.values);
  }
  async remember(target: string) {
    target = remoteTargetSchema.parse(target);
    const existing = this.values.find((machine) => machine.target === target);
    if (existing) return structuredClone(existing);
    if (this.values.length >= 100)
      throw new Error("Remove an unused machine before adding another.");
    const machine: RemoteMachine = {
      id: randomUUID(),
      target,
      hostId: null,
      lastConnectedAt: null,
    };
    this.values.push(machine);
    await this.persist();
    return structuredClone(machine);
  }
  async connected(id: string, hostId: string) {
    const machine = this.values.find((value) => value.id === id);
    if (!machine) throw new Error("This connection was removed.");
    if (machine.hostId && machine.hostId !== hostId)
      throw new Error(
        "The backend identity changed. Verify the machine before removing and adding this connection again.",
      );
    machine.hostId = hostId;
    machine.lastConnectedAt = new Date().toISOString();
    await this.persist();
  }
  async forget(id: string) {
    this.values = this.values.filter((value) => value.id !== id);
    await this.persist();
  }
  async setOpen(id: string, open: boolean) {
    const machine = this.values.find((value) => value.id === id);
    if (!machine) throw new Error("This connection was removed.");
    machine.restoreOnLaunch = open;
    await this.persist();
  }
  flush() {
    return this.writes;
  }
  private persist() {
    const snapshot = structuredClone(this.values);
    const write = this.writes.then(() => writePrivateJSON(this.path, snapshot));
    this.writes = write.catch(() => {});
    return write;
  }
}
