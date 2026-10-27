import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { agentSupervisor } from "./agent-supervisor";

test.skipIf(process.platform !== "linux")(
  "remote agent supervisor forwards normal output and exit status",
  async () => {
    const child = spawn(
      "node",
      [
        "-e",
        agentSupervisor,
        String(process.pid),
        "node",
        "-e",
        "process.stdout.write('ready'); process.exit(7)",
      ],
      { detached: true },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(output).toBe("ready");
    expect(code).toBe(7);
  },
);

test.skipIf(process.platform !== "linux")(
  "backend death stops the supervised agent process group",
  async () => {
    const parentCode = `
    const { spawn } = require('node:child_process');
    spawn('node', ['-e', ${JSON.stringify(agentSupervisor)}, String(process.pid), 'node', '-e', "console.log(process.pid); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    setInterval(() => {}, 1000);
  `;
    const parent = spawn("node", ["-e", parentCode]);
    let pid = 0;
    try {
      pid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Agent did not start")), 3000);
        parent.once("error", reject);
        parent.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(chunk.toString().trim()));
        });
      });
      expect(pid).toBeGreaterThan(0);
      parent.kill("SIGKILL");
      const end = Date.now() + 3000;
      let running = true;
      while (running && Date.now() < end) {
        try {
          running = !(await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") running = false;
          else throw error;
        }
        if (running) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(running).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  },
);
