import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { preparedHostSchema, runtimeSchema, hostDescriptorSchema } from "../../shared/remote";
import { ProjectStore } from "../workspace/project-store";
import { migrateWorkspaceRegistry } from "./workspace-host";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test("desktop and remote clients share one service and attached clients do not own its lifetime", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import {mkdir,writeFile,readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {ProjectStore} from './src/main/workspace/project-store.ts';
    import {WorkspaceService} from './src/main/workspace/workspace-service.ts';
    import {RemoteClient} from './src/main/remote/client.ts';
    import {ensureWorkspaceHost,workspaceRuntime} from './src/main/remote/workspace-host.ts';
    import {lockHost} from './src/main/remote/host-lock.ts';
    import {projectLocks} from './src/main/remote/project-locks.ts';
    const root = process.argv[1];
    const clients = [], hosts = [];
    let starts = 0;
    const createService = async () => {
      starts++;
      const locks = projectLocks(join(root, 'project-locks'));
      const store = new ProjectStore(join(root, 'workspace'), "/__tidy/assets", locks.claim);
      await store.initialize(); await store.recover();
      return {service:new WorkspaceService(store, () => ({done:Promise.resolve(),stop(){}}), async () => '/fixture', async () => {}), release:()=>locks.close()};
    };
    const options = {directory:root,buildId:'fixture',createService};
    try {
      const owner = await ensureWorkspaceHost(options); hosts.push(owner);
      const attached = await ensureWorkspaceHost(options); hosts.push(attached);
      assert.equal(starts, 1); assert.equal(attached.host.instanceId,owner.host.instanceId);
      function connect(backend) {
        const client = new RemoteClient({
          machine:{id:backend.host.clientId,target:'shared',hostId:backend.host.hostId,lastConnectedAt:null},
          bundlePath:'unused',temporaryDirectory:root,event(){},statusChanged(){},connected:async()=>{},
          connector:async()=>({host:backend.host,origin:'http://127.0.0.1:'+backend.host.port,close(){},onClose(){}}),
        });
        clients.push(client); client.start(); return client;
      }
      const local = connect(owner), remote = connect(attached);
      const deadline = Date.now()+5000;
      while(local.status.kind!=='connected'||remote.status.kind!=='connected') {
        if(Date.now()>deadline) throw new Error(JSON.stringify([local.status,remote.status]));
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const path = join(root,'project'); await mkdir(path);
      const project = await local.operation('open-project',undefined,{projectPath:path});
      const thread = await remote.operation('start-thread',{projectId:project.project.id,harness:'codex',prompt:'shared fixture',designIds:[]});
      assert.equal((await local.operation('read-thread',{projectId:project.project.id,threadId:thread.id})).id,thread.id);
      await attached.close(); assert.equal((await local.operation('bootstrap')).projects.length,1);
      local.close(); remote.close(); await owner.close();
      const stale = {...owner.host,pid:process.pid};
      const runtimePath = join(root,'runtime.json');
      await writeFile(runtimePath,JSON.stringify(stale));
      const release = lockHost(join(root,'host.lock'));
      try {
        await assert.rejects(workspaceRuntime(root), /alive but unresponsive/);
        assert.ok(await readFile(runtimePath,'utf8'));
      } finally { release(); }
      assert.equal(await workspaceRuntime(root),null);
      await assert.rejects(readFile(runtimePath,'utf8'), {code:'ENOENT'});
      const replacement = await ensureWorkspaceHost(options); hosts.push(replacement);
      assert.equal(starts,2); assert.equal(replacement.host.hostId,owner.host.hostId);
      assert.notEqual(replacement.host.instanceId,owner.host.instanceId);
      assert.equal(replacement.service.store.projects.length,1);
    } finally {
      for(const client of clients) client.close();
      for(const host of hosts.reverse()) await host.close();
    }
  `;
  const child = spawn("node", ["--import", "tsx", "--input-type=module", "-e", script, root], {
    cwd: new URL("../../..", import.meta.url),
    stdio: "pipe",
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  expect(errors).not.toContain("Error:");
  expect(code).toBe(0);
}, 10000);

test("legacy registry migration preserves private thread authority and never overwrites shared state", async () => {
  const root = await mkdtemp(join(tmpdir(), "migrate-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "old"),
    destination = join(root, "new");
  await mkdir(join(source, "thread-authority"), { recursive: true });
  const id = randomUUID();
  await writeFile(
    join(source, "projects.json"),
    JSON.stringify({
      version: 1,
      activeProjectId: id,
      projects: [{ id, name: "project", path: "/fixture", openedAt: "now" }],
    }),
  );
  const authority = `${"a".repeat(64)}.json`;
  await writeFile(
    join(source, "thread-authority", authority),
    JSON.stringify({ harness: "codex" }),
  );
  await migrateWorkspaceRegistry(source, destination);
  expect(
    JSON.parse(await readFile(join(destination, "projects.json"), "utf8")).activeProjectId,
  ).toBe(id);
  expect(
    JSON.parse(await readFile(join(destination, "thread-authority", authority), "utf8")),
  ).toEqual({ harness: "codex" });
  await writeFile(join(source, "projects.json"), "{}");
  await migrateWorkspaceRegistry(source, destination);
  expect(
    JSON.parse(await readFile(join(destination, "projects.json"), "utf8")).activeProjectId,
  ).toBe(id);
});

test("a stalled shutdown fails within its deadline while retaining workspace ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "stalled-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import {mkdir,readFile,readdir} from 'node:fs/promises';
    import {join} from 'node:path';
    import {ProjectStore} from './src/main/workspace/project-store.ts';
    import {WorkspaceService} from './src/main/workspace/workspace-service.ts';
    import {RemoteClient} from './src/main/remote/client.ts';
    import {ensureWorkspaceHost} from './src/main/remote/workspace-host.ts';
    import {lockHost} from './src/main/remote/host-lock.ts';
    import {projectLocks} from './src/main/remote/project-locks.ts';
    import {RequestReceipts} from './src/main/remote/receipts.ts';
    const root = process.argv[1];
    let released = false, started = false, serviceClosed = false;
    let project;
    const owner = await ensureWorkspaceHost({
      directory:root, buildId:'fixture', drainTimeoutMs:30,
      createService: async () => {
        const locks = projectLocks(join(root,'project-locks'));
        const store = new ProjectStore(join(root,'workspace'), undefined, locks.claim);
        await store.initialize();
        await mkdir(join(root,'project'));
        project = (await store.open(join(root,'project'))).project;
        store.createDesign = async () => { started = true; return new Promise(() => {}); };
        const service = new WorkspaceService(store);
        const closeService = service.close.bind(service);
        service.close = async () => { serviceClosed = true; await closeService(); };
        return {service,release:() => { released = true; locks.close(); }};
      }
    });
    const client = new RemoteClient({
      machine:{id:owner.host.clientId,target:'fixture',hostId:owner.host.hostId,lastConnectedAt:null},
      bundlePath:'unused',temporaryDirectory:root,event(){},statusChanged(){},connected:async()=>{},
      connector:async()=>({host:owner.host,origin:'http://127.0.0.1:'+owner.host.port,close(){},onClose(){}}),
    });
    client.start();
    while(client.status.kind !== 'connected') await new Promise(resolve => setTimeout(resolve,5));
    void client.request('create-design',{projectId:project.id}).catch(()=>{});
    while(!started) await new Promise(resolve => setTimeout(resolve,5));
    client.close();
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    await assert.rejects(closing,/shutdown timed out/);
    assert.equal(released,false);
    assert.equal(serviceClosed,false);
    assert.throws(() => lockHost(join(root,'host.lock')));
    const other = projectLocks(join(root,'project-locks'));
    try { assert.throws(() => other.claim(project.path)); } finally { other.close(); }
    assert.ok(JSON.parse(await readFile(join(root,'runtime.json'),'utf8')).pid);
    const files = (await readdir(join(root,'receipts'))).filter(name => name.endsWith('.json'));
    assert.equal(files.length,1);
    const receipt = JSON.parse(await readFile(join(root,'receipts',files[0]),'utf8'));
    assert.equal(receipt.kind,'pending');
    const receipts = new RequestReceipts(join(root,'receipts'));
    assert.equal((await receipts.status(files[0].slice(0,36),files[0].slice(37,-5))).kind,'interrupted');
    process.exit(0);
  `;
  const child = spawn("node", ["--import", "tsx", "--input-type=module", "-e", script, root], {
    cwd: new URL("../../..", import.meta.url),
    stdio: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  expect(errors).not.toContain("Error:");
  expect(code).toBe(0);
}, 10000);

for (const blockPublication of [false, true]) {
  test(
    blockPublication
      ? "failed runtime publication exits and allows a replacement backend to claim the project"
      : "source backend ensure forwards the TypeScript loader to its managed serve child",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "source-host-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const home = join(root, "home");
      await mkdir(home);
      const environment = { ...process.env, HOME: home, TIDY_HOST_STATE: root };
      if (blockPublication) {
        const store = new ProjectStore(join(root, "workspace"));
        await store.initialize();
        await mkdir(join(root, "project"));
        await store.open(join(root, "project"));
        await mkdir(join(root, "runtime.json"));
        const failed = spawn("node", ["--import", "tsx", "scripts/host.ts", "serve", "--managed"], {
          cwd: new URL("../../..", import.meta.url),
          env: environment,
          stdio: "pipe",
          timeout: 5000,
          killSignal: "SIGKILL",
        });
        let errors = "";
        failed.stderr.on("data", (chunk) => {
          errors += chunk.toString();
        });
        failed.stdout.resume();
        const code = await new Promise<number | null>((resolve, reject) => {
          failed.once("exit", resolve);
          failed.once("error", reject);
        });
        expect(code).toBe(1);
        expect(errors).toContain('"event":"host.failed"');
        await rm(join(root, "runtime.json"), { recursive: true });
      }
      const child = spawn("node", ["--import", "tsx", "scripts/host.ts", "ensure", randomUUID()], {
        cwd: new URL("../../..", import.meta.url),
        env: environment,
        stdio: "pipe",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.resume();
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("exit", resolve);
          child.once("error", reject);
        });
        expect(code).toBe(0);
        const host = preparedHostSchema.parse(JSON.parse(output));
        const response = await fetch(`http://127.0.0.1:${host.port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(200);
        expect(hostDescriptorSchema.parse(await response.json()).hostId).toBe(host.hostId);
      } finally {
        const runtime = await readFile(join(root, "runtime.json"), "utf8")
          .then((data) => runtimeSchema.parse(JSON.parse(data)))
          .catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          });
        if (runtime) {
          process.kill(runtime.pid, "SIGTERM");
          let removed = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            removed = await readFile(join(root, "runtime.json")).then(
              () => false,
              () => true,
            );
            if (removed) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (!removed) process.kill(runtime.pid, "SIGKILL");
          expect(removed).toBe(true);
        }
      }
    },
    10000,
  );
}
