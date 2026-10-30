import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { ThreadPort } from "../../shared/contracts/thread-ports";

export const THREAD_OWNER_ENV = "TIDY_THREAD_OWNER";
const execute = promisify(execFile);
export type OwnedProcess = {
  pid: number;
  parentPid: number;
  identity: string;
  owner: string;
  name: string;
};
export type ProcessListener = OwnedProcess & Pick<ThreadPort, "port" | "host">;

async function batches<T, R>(items: T[], action: (item: T) => Promise<R>) {
  const result: R[] = [];
  for (let index = 0; index < items.length; index += 16)
    result.push(...(await Promise.all(items.slice(index, index + 16).map(action))));
  return result;
}

function ownerFromEnvironment(environment: string, owners: ReadonlySet<string>) {
  for (const entry of environment.split("\0")) {
    if (!entry.startsWith(`${THREAD_OWNER_ENV}=`)) continue;
    const owner = entry.slice(THREAD_OWNER_ENV.length + 1);
    if (owners.has(owner)) return owner;
  }
  return null;
}

export function parseLinuxProcess(pid: number, stat: string) {
  const begin = stat.indexOf("("),
    end = stat.lastIndexOf(")");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  if (begin < 0 || end < begin || !/^\d+$/.test(fields[19] ?? "") || !Number.isInteger(parentPid))
    throw new Error("Could not inspect a local process.");
  return {
    pid,
    parentPid,
    identity: `${pid}:${fields[19]}`,
    name: stat.slice(begin + 1, end).slice(0, 120),
  };
}

export function parseLinuxListeners(table: string) {
  const listeners = new Map<string, Pick<ThreadPort, "port" | "host">>();
  for (const line of table.trim().split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A") continue;
    const [address, rawPort] = (fields[1] ?? "").split(":");
    const port = Number.parseInt(rawPort, 16);
    const host = address?.length === 8 ? "127.0.0.1" : "::1";
    const local =
      address === "00000000" ||
      address === "0100007F" ||
      address === "00000000000000000000000000000000" ||
      address === "00000000000000000000000001000000";
    if (local && port > 0 && port <= 65535 && /^\d+$/.test(fields[9] ?? ""))
      listeners.set(fields[9], { port, host });
  }
  return listeners;
}

async function linuxProcesses(owners: ReadonlySet<string>): Promise<OwnedProcess[]> {
  const entries = await readdir("/proc");
  const result = await batches(
    entries.filter((entry) => /^\d+$/.test(entry)),
    async (entry) => {
      try {
        const environment = await readFile(`/proc/${entry}/environ`, "utf8");
        const owner = ownerFromEnvironment(environment, owners);
        if (!owner) return null;
        const stat = await readFile(`/proc/${entry}/stat`, "utf8");
        return { ...parseLinuxProcess(Number(entry), stat), owner };
      } catch {
        return null;
      }
    },
  );
  return result.filter((entry) => entry !== null);
}

async function linuxListeners(owners: ReadonlySet<string>): Promise<ProcessListener[]> {
  const tables = await Promise.all([
    readFile("/proc/net/tcp", "utf8"),
    readFile("/proc/net/tcp6", "utf8"),
  ]);
  const sockets = parseLinuxListeners(`${tables[0]}\n${tables[1]}`);
  if (!sockets.size) return [];
  const processes = await linuxProcesses(owners);
  const result = await batches(processes, async (process) => {
    try {
      const directory = `/proc/${process.pid}/fd`;
      const descriptors = await readdir(directory);
      const found = new Map<string, ProcessListener>();
      await batches(descriptors, async (descriptor) => {
        const link = await readlink(`${directory}/${descriptor}`).catch(() => "");
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        const socket = inode ? sockets.get(inode) : undefined;
        if (socket) found.set(`${socket.host}:${socket.port}`, { ...process, ...socket });
      });
      return [...found.values()];
    } catch {
      return [];
    }
  });
  return result.flat();
}

async function ps(args: string[]) {
  const { stdout } = await execute("/bin/ps", args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function macProcess(pid: number, owners: ReadonlySet<string>): Promise<OwnedProcess | null> {
  try {
    const before = await ps(["-p", String(pid), "-o", "lstart=,ppid=,comm="]);
    const match = /^(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\d+)\s+(.+)$/.exec(before);
    if (!match) return null;
    const command = await ps(["-ww", "-p", String(pid), "-o", "command="]);
    const environment = await ps(["eww", "-p", String(pid), "-o", "command="]);
    if (!environment.startsWith(`${command} `)) return null;
    const values = environment
      .slice(command.length + 1)
      .split(/\s+/)
      .join("\0");
    const owner = ownerFromEnvironment(values, owners);
    if (!owner || before !== (await ps(["-p", String(pid), "-o", "lstart=,ppid=,comm="])))
      return null;
    return {
      pid,
      parentPid: Number(match[2]),
      identity: `${pid}:${match[1]}`,
      owner,
      name: (match[3].split("/").pop() ?? "Process").slice(0, 120),
    };
  } catch {
    return null;
  }
}

async function macProcesses(owners: ReadonlySet<string>): Promise<OwnedProcess[]> {
  try {
    const [table, commands, environments] = await Promise.all([
      ps(["-axo", "pid=,ppid=,lstart=,comm="]),
      ps(["-ww", "-axo", "pid=,command="]),
      ps(["eww", "-axo", "pid=,command="]),
    ]);
    const commandByPid = new Map(
      commands.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        return match ? [[Number(match[1]), match[2]] as const] : [];
      }),
    );
    const ownerByPid = new Map<number, string>();
    for (const line of environments.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]),
        command = commandByPid.get(pid);
      if (!command || !match[2].startsWith(`${command} `)) continue;
      const owner = ownerFromEnvironment(
        match[2]
          .slice(command.length + 1)
          .split(/\s+/)
          .join("\0"),
        owners,
      );
      if (owner) ownerByPid.set(pid, owner);
    }
    return table.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
      const pid = Number(match?.[1]),
        owner = ownerByPid.get(pid);
      return match && owner
        ? [
            {
              pid,
              parentPid: Number(match[2]),
              identity: `${pid}:${match[3]}`,
              owner,
              name: (match[4].split("/").pop() ?? "Process").slice(0, 120),
            },
          ]
        : [];
    });
  } catch {
    throw new Error("Could not inspect local process ownership.");
  }
}

export function parseLsofListeners(output: string) {
  let pid = 0;
  const listeners: Array<{ pid: number; port: number; host: ThreadPort["host"] }> = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n") || !Number.isInteger(pid) || pid <= 0) continue;
    const match = /^n(\*|127\.0\.0\.1|\[::1\]|\[::\]):(\d+)$/.exec(line);
    const port = Number(match?.[2]);
    if (match && port > 0 && port <= 65535)
      listeners.push({ pid, port, host: match[1].includes(":") ? "::1" : "127.0.0.1" });
  }
  return listeners;
}

export async function inspectProcessIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return null;
      return parseLinuxProcess(pid, stat).identity;
    }
    if (process.platform === "darwin") {
      const value = await ps(["-p", String(pid), "-o", "lstart=,stat="]);
      const match = /^(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)$/.exec(value);
      if (!match) throw new Error("Could not inspect the process identity.");
      return match[2].startsWith("Z") ? null : `${pid}:${match[1]}`;
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" ||
        error.code === "ESRCH" ||
        (process.platform === "darwin" && error.code === 1))
    )
      return null;
    throw new Error("Could not confirm whether the process has exited.");
  }
  throw new Error("Local process inspection is not supported on this computer.");
}

export async function inspectOwnedProcess(pid: number, owners: ReadonlySet<string>) {
  if (process.platform === "darwin") return macProcess(pid, owners);
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const owner = ownerFromEnvironment(await readFile(`/proc/${pid}/environ`, "utf8"), owners);
    const after = await readFile(`/proc/${pid}/stat`, "utf8");
    const before = parseLinuxProcess(pid, stat),
      current = parseLinuxProcess(pid, after);
    return owner && before.identity === current.identity ? { ...current, owner } : null;
  } catch {
    return null;
  }
}

export async function scanOwnedListeners(owners: ReadonlySet<string>): Promise<ProcessListener[]> {
  if (!owners.size) return [];
  if (process.platform === "linux") return linuxListeners(owners);
  if (process.platform !== "darwin")
    throw new Error("Local port discovery is not supported on this computer.");
  let stdout: string;
  try {
    ({ stdout } = await execute("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      error.stdout === ""
    )
      return [];
    throw new Error("Could not inspect local ports.");
  }
  const listeners = parseLsofListeners(stdout);
  const processes = new Map((await macProcesses(owners)).map((entry) => [entry.pid, entry]));
  return listeners.flatMap((listener) => {
    const process = processes.get(listener.pid);
    return process ? [{ ...process, ...listener }] : [];
  });
}

export async function ownedDescendants(root: OwnedProcess): Promise<OwnedProcess[]> {
  const owners = new Set([root.owner]);
  const processes = await scanOwnedProcesses(owners);
  const ids = new Set([root.pid]);
  for (let round = 0; round < 64; round++) {
    const previous = ids.size;
    for (const entry of processes) if (ids.has(entry.parentPid)) ids.add(entry.pid);
    if (ids.size === previous) break;
  }
  return processes.filter((entry) => ids.has(entry.pid) && entry.pid !== root.pid);
}

export function scanOwnedProcesses(owners: ReadonlySet<string>): Promise<OwnedProcess[]> {
  if (!owners.size) return Promise.resolve([]);
  if (process.platform === "linux") return linuxProcesses(owners);
  if (process.platform === "darwin") return macProcesses(owners);
  throw new Error("Local process inspection is not supported on this computer.");
}
