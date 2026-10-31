import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUsage } from "./harness-usage";
import { readOpenCodeUsage } from "./opencode-usage";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const value = await realpath(await mkdtemp(join(tmpdir(), "tidy-usage-")));
  directories.push(value);
  return value;
}
for (const harness of ["codex", "claude"] as const)
  test(`${harness} usage discovery never starts a turn or discovers a model catalog`, async () => {
    const cwd = await directory(),
      executable = join(cwd, "harness");
    await copyFile(new URL("../fixtures/harness.mjs", import.meta.url), executable);
    await chmod(executable, 0o700);
    const result = await inspectUsage(executable, harness, cwd);
    const invocation = JSON.parse(await readFile(join(cwd, "capability-invocation.json"), "utf8"));
    expect(invocation.methods).not.toContain("model/list");
    expect(invocation.methods).not.toContain("turn/start");
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    if (harness === "codex") expect(result.windows[0].usedPercent).toBe(25);
  });
async function openCodeFixture(mode: string) {
  const cwd = await directory(),
    executable = join(cwd, "opencode");
  await writeFile(join(cwd, "mode"), mode);
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const mode=readFileSync('mode','utf8');
if(process.argv[2]==='--version'){console.log(mode==='legacy'?'1.19.5':'2.2.5');process.exit(0);}
const password=process.env.OPENCODE_SERVER_PASSWORD;
if(!password || password.length<32 || process.env.OPENCODE_SERVER_USERNAME!=='opencode')process.exit(3);
writeFileSync('invocation.json',JSON.stringify({args:process.argv.slice(2),database:process.env.DATABASE_URL,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)}));
const server=createServer((request,response)=>{
 const authenticated=request.headers.authorization==='Basic '+Buffer.from('opencode:'+password).toString('base64');
 appendFileSync('requests.jsonl',JSON.stringify({method:request.method,url:request.url,authenticated})+'\\n');
 if(!authenticated&&mode!=='insecure'){response.writeHead(401);response.end();return;}
 if(mode==='unsupported'){response.writeHead(404);response.end();return;}
 if(mode==='redirect'){response.writeHead(302,{Location:'/should-not-follow'});response.end();return;}
 if(mode==='stalled'){return;}
 response.setHeader('Content-Type','application/json');
 response.end(JSON.stringify({location:{},data:mode==='disconnected'?null:{workspace:{id:'private',name:'Studio'},go:{rolling:{percent:20,limited:false,resetsAt:2000000000000},weekly:{percent:40,limited:false,resetsAt:2000000000000},monthly:{percent:60,limited:false,resetsAt:2000000000000}},budgets:[]}}));
});
server.listen(0,'127.0.0.1',()=>{writeFileSync('port',String(server.address().port));console.log('OpenCode listening on http://127.0.0.1:'+server.address().port);});
`,
  );
  await chmod(executable, 0o700);
  return { cwd, executable };
}
test("OpenCode reads allowances over authenticated loopback and closes its disposable server", async () => {
  const { cwd, executable } = await openCodeFixture("ready");
  const value = await readOpenCodeUsage(executable, cwd);
  expect(value.windows.map((window) => window.usedPercent)).toEqual([20, 40, 60]);
  const requests = (await readFile(join(cwd, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests.map((item) => item.authenticated)).toEqual([false, true]);
  expect(
    requests.every(
      (item) => item.method === "GET" && item.url.startsWith("/api/experimental/usage/limits?"),
    ),
  ).toBe(true);
  const invocation = JSON.parse(await readFile(join(cwd, "invocation.json"), "utf8"));
  expect(invocation.args).toEqual(["--pure", "serve", "--hostname", "127.0.0.1", "--port", "0"]);
  expect(invocation.database).toBeUndefined();
  expect(invocation.config.experimental.schedules).toBe(false);
  expect(invocation.config.server.mdns).toBe(false);
  const port = await readFile(join(cwd, "port"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
});
for (const mode of ["legacy", "insecure", "disconnected", "unsupported"])
  test(`OpenCode ${mode} capability reports unknown rather than empty capacity`, async () => {
    const { cwd, executable } = await openCodeFixture(mode);
    const value = await readOpenCodeUsage(executable, cwd);
    expect(value.state).toBe("unknown");
    expect(value.windows).toEqual([]);
    expect(value.note).toBeTruthy();
    if (mode === "insecure") {
      const requests = (await readFile(join(cwd, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0].authenticated).toBe(false);
    }
  });

test("OpenCode usage cannot follow redirects to another endpoint", async () => {
  const { cwd, executable } = await openCodeFixture("redirect");
  await expect(readOpenCodeUsage(executable, cwd)).rejects.toThrow();
  const requests = (await readFile(join(cwd, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !request.url.includes("should-not-follow"))).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "OpenCode discovery terminates if its owning host dies",
  async () => {
    const { cwd, executable } = await openCodeFixture("stalled");
    const modulePath = new URL("./opencode-usage.ts", import.meta.url).pathname;
    const script = `import {readOpenCodeUsage} from ${JSON.stringify(modulePath)}; await readOpenCodeUsage(${JSON.stringify(executable)},${JSON.stringify(cwd)});`;
    const parent = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    try {
      let port: string | undefined;
      const deadline = Date.now() + 4000;
      while (!port && Date.now() < deadline) {
        port = await readFile(join(cwd, "port"), "utf8").catch(() => undefined);
        if (!port) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(port).toBeTruthy();
      parent.kill("SIGKILL");
      let closed = false;
      const cleanupDeadline = Date.now() + 2500;
      while (!closed && Date.now() < cleanupDeadline) {
        closed = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
          const finish = (value: boolean) => {
            socket.destroy();
            resolve(value);
          };
          socket.setTimeout(250);
          socket.once("connect", () => finish(false));
          socket.once("timeout", () => finish(false));
          socket.once("error", (error: NodeJS.ErrnoException) =>
            finish(error.code === "ECONNREFUSED"),
          );
        });
        if (!closed) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(closed).toBe(true);
    } finally {
      parent.kill("SIGKILL");
    }
  },
);

test.skipIf(process.platform === "win32")(
  "OpenCode discovery quotes executable paths and does not depend on Node-mode Electron",
  async () => {
    const fixture = await openCodeFixture("ready");
    const executable = join(fixture.cwd, "opencode $(touch injected)");
    await rename(fixture.executable, executable);
    const value = await readOpenCodeUsage(executable, fixture.cwd);
    expect(value.windows).toHaveLength(3);
    await expect(stat(join(fixture.cwd, "injected"))).rejects.toThrow();
  },
);
