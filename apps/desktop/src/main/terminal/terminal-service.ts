import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { IPty } from "@lydell/node-pty";
import {
  terminalInputSchema,
  terminalScopeSchema,
  type TerminalInput,
  type TerminalOutput,
  type TerminalScope,
  type TerminalWatch,
} from "../../shared/contracts/terminal";

const require = createRequire(import.meta.url);
const HISTORY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 8;
const MAX_VIEWERS = 16;
const WINDOW_BYTES = 128 * 1024;
export function terminalEnvironment() {
  const env: Record<string, string> = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SSH_AUTH_SOCK",
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.PATH = [
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
    .filter(isAbsolute)
    .join(delimiter);
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Tidy";
  return env;
}
type Chunk = { sequence: number; data: string; bytes: number };
type Viewer = {
  send(output: TerminalOutput): void;
  pending: Map<number, number>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Session = {
  id: string;
  projectId: string;
  pty: IPty;
  cols: number;
  rows: number;
  sequence: number;
  history: Chunk[];
  historyBytes: number;
  pending: string;
  flush?: ReturnType<typeof setTimeout>;
  exited: boolean;
  exitCode: number | null;
  paused: boolean;
  viewers: Set<Viewer>;
};

/** Shells belong to registered local projects; neither paths nor commands come from the renderer. */
export class TerminalService {
  private sessions = new Map<string, Session>();
  private opening = new Map<string, Promise<Session>>();
  private closed = false;
  constructor(
    private projectPath: (projectId: string) => Promise<string>,
    private spawn: typeof import("@lydell/node-pty").spawn = (...args) =>
      (require("@lydell/node-pty") as typeof import("@lydell/node-pty")).spawn(...args),
  ) {}
  get activeCount() {
    return [...this.sessions.values()].filter((s) => !s.exited).length + this.opening.size;
  }

  private async open(scope: TerminalScope, admitted: () => boolean): Promise<Session> {
    if (this.closed || !admitted()) throw new Error("The terminal viewer closed.");
    await this.projectPath(scope.projectId);
    if (this.closed || !admitted()) throw new Error("The terminal viewer closed.");
    const previous = this.sessions.get(scope.projectId);
    if (previous) return previous;
    const pending = this.opening.get(scope.projectId);
    if (pending) return pending;
    if (this.sessions.size + this.opening.size >= MAX_SESSIONS)
      throw new Error("Close a terminal before opening another project terminal.");
    const task = (async () => {
      const cwd = await this.projectPath(scope.projectId);
      if (this.closed || !admitted()) throw new Error("The terminal viewer closed.");
      const env = terminalEnvironment();
      const shell =
        process.platform === "win32"
          ? "powershell.exe"
          : env.SHELL && isAbsolute(env.SHELL)
            ? env.SHELL
            : process.platform === "darwin"
              ? "/bin/zsh"
              : "/bin/bash";
      let pty: IPty;
      try {
        pty = this.spawn(shell, process.platform === "win32" ? ["-NoLogo"] : ["-l"], {
          cwd,
          env,
          name: "xterm-256color",
          cols: scope.cols,
          rows: scope.rows,
        });
      } catch {
        throw new Error("Could not start the terminal. Check that your shell is installed.");
      }
      const session: Session = {
        id: randomUUID(),
        projectId: scope.projectId,
        pty,
        cols: scope.cols,
        rows: scope.rows,
        sequence: 0,
        history: [],
        historyBytes: 0,
        pending: "",
        exited: false,
        exitCode: null,
        paused: false,
        viewers: new Set(),
      };
      this.sessions.set(scope.projectId, session);
      pty.onData((data) => {
        if (session.exited) return;
        session.pending += data;
        if (session.pending.length >= 16_000) this.flush(session);
        else session.flush ??= setTimeout(() => this.flush(session), 8);
      });
      pty.onExit(({ exitCode }) => {
        this.flush(session);
        session.exited = true;
        session.exitCode = exitCode;
        for (const viewer of session.viewers)
          viewer.send({ kind: "exit", sessionId: session.id, exitCode });
      });
      return session;
    })();
    this.opening.set(scope.projectId, task);
    try {
      return await task;
    } finally {
      this.opening.delete(scope.projectId);
    }
  }
  private flush(session: Session) {
    clearTimeout(session.flush);
    session.flush = undefined;
    while (session.pending) {
      // Keep UTF-16 surrogate pairs together at frame boundaries.
      let end = Math.min(16_000, session.pending.length);
      const last = session.pending.charCodeAt(end - 1);
      if (end < session.pending.length && last >= 0xd800 && last <= 0xdbff) end--;
      const data = session.pending.slice(0, end);
      session.pending = session.pending.slice(end);
      const chunk = { sequence: ++session.sequence, data, bytes: Buffer.byteLength(data) };
      session.history.push(chunk);
      session.historyBytes += chunk.bytes;
      while (session.historyBytes > HISTORY_BYTES)
        session.historyBytes -= session.history.shift()!.bytes;
      for (const viewer of session.viewers) {
        viewer.pending.set(chunk.sequence, chunk.bytes);
        viewer.bytes += chunk.bytes;
        viewer.send({ kind: "data", sessionId: session.id, sequence: chunk.sequence, data });
      }
    }
    this.flow(session);
  }
  private flow(session: Session) {
    for (const viewer of session.viewers) {
      if (viewer.bytes >= WINDOW_BYTES)
        viewer.timer ??= setTimeout(() => {
          viewer.send({
            kind: "error",
            message:
              "Terminal output paused because this viewer stopped responding. Reconnect the terminal.",
          });
          session.viewers.delete(viewer);
          this.flow(session);
        }, 15_000);
      else {
        clearTimeout(viewer.timer);
        viewer.timer = undefined;
      }
    }
    const pause = [...session.viewers].some((v) => v.bytes >= WINDOW_BYTES);
    if (!session.exited && pause !== session.paused) {
      session.paused = pause;
      if (pause) session.pty.pause();
      else session.pty.resume();
    }
  }
  async watch(
    raw: TerminalScope,
    send: Viewer["send"],
    admitted = () => true,
  ): Promise<TerminalWatch> {
    if (this.closed) throw new Error("Tidy is closing.");
    const scope = terminalScopeSchema.parse(raw);
    if ([...this.sessions.values()].reduce((n, s) => n + s.viewers.size, 0) >= MAX_VIEWERS)
      throw new Error("Too many terminal viewers.");
    const session = await this.open(scope, admitted);
    if (this.closed || !admitted()) throw new Error("The terminal viewer closed.");
    this.flush(session);
    const viewer: Viewer = { send, bytes: 0, pending: new Map() };
    const resume =
      scope.resume?.sessionId === session.id &&
      scope.resume.sequence <= session.sequence &&
      scope.resume.sequence >= (session.history[0]?.sequence ?? session.sequence + 1) - 1;
    const data = session.history
      .filter((chunk) => !resume || chunk.sequence > scope.resume!.sequence)
      .map((chunk) => chunk.data)
      .join("");
    // Attach before publishing a snapshot; subsequent output is ordered after it.
    session.viewers.add(viewer);
    viewer.pending.set(session.sequence, Buffer.byteLength(data));
    viewer.bytes = Buffer.byteLength(data);
    send({
      kind: "snapshot",
      sessionId: session.id,
      sequence: session.sequence,
      data,
      reset: !resume,
      cols: session.cols,
      rows: session.rows,
      exited: session.exited,
      exitCode: session.exitCode,
    });
    if (!resume && !session.exited && session.history.length) {
      // Request a fresh full-screen repaint after a bounded history replay.
      session.pty.resize(session.cols === 500 ? 499 : session.cols + 1, session.rows);
      session.pty.resize(session.cols, session.rows);
    }
    this.flow(session);
    let closed = false;
    return {
      input: (raw) => {
        if (closed || this.closed || !session.viewers.has(viewer)) return;
        const input = terminalInputSchema.parse(raw);
        if (input.sessionId !== session.id || this.sessions.get(session.projectId) !== session)
          return;
        this.input(session, viewer, input);
      },
      close: () => {
        closed = true;
        clearTimeout(viewer.timer);
        session.viewers.delete(viewer);
        this.flow(session);
      },
    };
  }
  private input(session: Session, viewer: Viewer, input: TerminalInput) {
    if (input.kind === "ack") {
      if (input.sequence > session.sequence) return;
      for (const [sequence, bytes] of viewer.pending)
        if (sequence <= input.sequence) {
          viewer.bytes -= bytes;
          viewer.pending.delete(sequence);
        }
      this.flow(session);
      return;
    }
    if (session.exited) return;
    if (input.kind === "write") session.pty.write(input.data);
    else if (session.cols !== input.cols || session.rows !== input.rows) {
      session.cols = input.cols;
      session.rows = input.rows;
      session.pty.resize(input.cols, input.rows);
    }
  }
  end(projectId: string, sessionId: string) {
    if (this.sessions.get(projectId)?.id === sessionId) this.removeProject(projectId);
  }
  removeProject(projectId: string) {
    const session = this.sessions.get(projectId);
    if (!session) return;
    this.sessions.delete(projectId);
    clearTimeout(session.flush);
    for (const viewer of session.viewers) clearTimeout(viewer.timer);
    if (!session.exited) {
      try {
        session.pty.kill();
      } catch {}
    }
  }
  async stopAll() {
    await Promise.allSettled(this.opening.values());
    for (const id of this.sessions.keys()) this.removeProject(id);
  }
  async close() {
    this.closed = true;
    await this.stopAll();
  }
}
