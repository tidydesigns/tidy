import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type MobileProcess = {
  process: ChildProcessWithoutNullStreams;
  done: Promise<string>;
  stop(): void;
};

/** No shell interpolation. Every build/SDK process has a bounded lifetime and output. */
export function mobileProcess(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeout?: number;
    output?(text: string): void;
  } = {},
): MobileProcess {
  options.signal?.throwIfAborted();
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "pipe",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      /* The process may have just exited. */
    }
    const force = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }, 2000);
    force.unref();
    child.once("close", () => clearTimeout(force));
  };
  let output = "";
  const receive = (chunk: Buffer) => {
    const text = chunk.toString("utf8").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
    output = (output + text).slice(-64_000);
    options.output?.(text);
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  const done = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The device command timed out. Retry from Devices."));
    }, options.timeout ?? 30_000);
    timer.unref();
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    // A child may close stdin before a write completes (for example Flutter or pbcopy).
    // Handle stream errors independently of the process's exit/error events.
    child.stdin.on("error", (error) => {
      cleanup();
      stop();
      reject(error);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (code !== 0)
        reject(new Error(output.trim().slice(-2000) || `${executable} exited (${code}).`));
      else resolve(output);
    });
  });
  // Background processes may terminate before their owner has awaited completion.
  void done.catch(() => {});
  return { process: child, done, stop };
}

export const mobileExec = (
  executable: string,
  args: string[],
  options?: Parameters<typeof mobileProcess>[2],
) => mobileProcess(executable, args, options).done;
