import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, net, protocol } from "electron";
import { ProjectStore } from "../src/main/workspace/project-store";
import { WorkspaceService } from "../src/main/workspace/workspace-service";
import { registerWorkspaceIPC } from "../src/main/ipc/ipc";
import { APP_URL, APP_SCHEME, rendererAssetPath } from "../src/main/app/renderer-security";
import { RemoteClient } from "../src/main/remote/client";
import { RemoteFailure } from "../src/main/remote/errors";
import { createRemoteHost } from "../src/main/remote/host";
import { RequestReceipts } from "../src/main/remote/receipts";
import { SessionStore } from "../src/main/remote/session-store";

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function run() {
  const root = await mkdtemp(join(tmpdir(), "tidy-remote-integration-"));
  const desktop = resolve(import.meta.dirname, "..");
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const name of ["codex", "claude"]) {
    await copyFile(join(desktop, "src/main/fixtures/harness.mjs"), join(bin, name));
    await chmod(join(bin, name), 0o700);
  }
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  app.setPath("userData", join(root, "electron"));
  await app.whenReady();
  protocol.handle(APP_SCHEME, async (request) =>
    net.fetch(pathToFileURL(rendererAssetPath(join(desktop, "out/renderer"), request.url)).href),
  );
  const store = new ProjectStore(join(root, "state"));
  await store.initialize();
  await mkdir(join(root, "Demo project"));
  const project = (await store.open(join(root, "Demo project"))).project;
  const threadId = randomUUID();
  await store.writeThread({
    id: threadId,
    projectId: project.id,
    revision: 0,
    title: "Remote connection demo",
    harness: "codex",
    designIds: [],
    status: "completed",
    updatedAt: new Date().toISOString(),
    messages: [
      { id: randomUUID(), role: "user", text: "Show where this thread runs." },
      {
        id: randomUUID(),
        role: "assistant",
        text: "This thread belongs to demo@remote-workstation. The backend in this simulator runs locally over a real authenticated WebSocket.",
      },
    ],
  });
  const localStore = new ProjectStore(join(root, "local-state"));
  await localStore.initialize();
  await mkdir(join(root, "Local project"));
  const localProject = (await localStore.open(join(root, "Local project"))).project;
  await localStore.writeThread({
    id: threadId,
    projectId: localProject.id,
    revision: 0,
    title: "Local thread demo",
    harness: "codex",
    designIds: [],
    status: "completed",
    updatedAt: new Date().toISOString(),
    messages: [{ id: randomUUID(), role: "assistant", text: "This thread stays on this machine." }],
  });
  const localService = new WorkspaceService(localStore);
  let runs = 0;
  const service = new WorkspaceService(
    store,
    (input) => {
      runs++;
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let ticks = 0;
      const messageId = randomUUID();
      const timer = setInterval(() => {
        input.onUpdate({
          type: "message",
          id: messageId,
          text: `Simulated remote work: ${++ticks} steps completed.`,
          append: false,
        });
        if (ticks >= 30) {
          clearInterval(timer);
          finish();
        }
      }, 1000);
      return {
        done,
        stop() {
          clearInterval(timer);
          finish();
        },
        respondToApproval: () => true,
      };
    },
    async () => join(bin, "codex"),
    async () => {},
  );
  const sessions = new SessionStore(join(root, "sessions"));
  const identity = { hostId: randomUUID(), instanceId: randomUUID(), buildId: "local-test" };
  const host = createRemoteHost({
    service,
    sessions,
    identity,
    receipts: new RequestReceipts(join(root, "receipts")),
  });
  const port = await host.listen();
  const machine = {
    id: randomUUID(),
    target: "demo@remote-workstation",
    hostId: identity.hostId,
    lastConnectedAt: null,
  };
  let online = true;
  let authenticationRequired = false;
  let drop = () => {};
  const window = new BrowserWindow({
    title: "Tidy · Local remote simulator",
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: join(desktop, "out/preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const client = new RemoteClient({
    machine,
    bundlePath: "unused",
    temporaryDirectory: root,
    event: (event) => {
      if (!window.isDestroyed()) window.webContents.send("tidy:machine-event", machine.id, event);
    },
    statusChanged: (status) => {
      if (!window.isDestroyed()) window.webContents.send("tidy:machine-status", machine.id, status);
      if (!window.isDestroyed()) window.webContents.send("tidy:machines-changed");
    },
    connected: async () => {},
    connector: async () => {
      if (authenticationRequired)
        throw new RemoteFailure(
          "authentication",
          "Sign-in expired in this fixture. Restore the connection before retrying.",
        );
      if (!online) throw new RemoteFailure("unavailable", "Simulated connection loss.");
      return {
        host: {
          ...identity,
          protocol: 3,
          pid: process.pid,
          port,
          managed: true,
          clientId: machine.id,
          token: await sessions.issue(machine.id),
        },
        origin: `http://127.0.0.1:${port}`,
        close() {},
        onClose(listener) {
          drop = listener;
        },
      };
    },
  });
  registerWorkspaceIPC(localService, APP_URL, {
    get: () => undefined,
    getMachine: (id) => (id === machine.id ? client : undefined),
    list: () => [
      { id: "local", label: "This machine", status: null },
      { id: machine.id, label: machine.target, status: client.status },
    ],
    open: async () => window.focus(),
    machines: () => [machine],
    discover: async () => [],
    forget: async () => {},
  });
  const disconnect = (offline: boolean) => {
    online = false;
    drop();
    if (offline) client.wake("network", false);
  };
  const restore = () => {
    online = true;
    authenticationRequired = false;
    client.retry();
  };
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  client.start();
  await window.loadURL(APP_URL);
  const evaluate = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression);
  async function until(check: () => Promise<unknown> | boolean) {
    const end = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("Remote integration assertion timed out.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    client.close();
    await host.close();
    await service.close();
    await localService.close();
    if (!window.isDestroyed()) window.destroy();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(process.exitCode === 1 ? 1 : 0);
  }
  app.on("before-quit", (event) => {
    event.preventDefault();
    void close();
  });
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  const watchdog = setTimeout(() => {
    process.exitCode = 1;
    void close();
  }, 60_000);
  try {
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(desktop, "out/preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    try {
      await foreign.loadURL("data:text/html,<html><body>Untrusted frame</body></html>");
      for (const expression of [
        "window.tidyMachines.list()",
        "window.tidyRemote.machines()",
        "window.tidyRemote.discover()",
        "window.tidyRemote.tailnet()",
        "window.tidyRemote.connect('user@fixture')",
        "window.tidyRemote.status()",
        "window.tidyRemote.retry()",
        "window.tidy.bootstrap()",
      ])
        await assert.rejects(
          foreign.webContents.executeJavaScript(expression),
          /Untrusted desktop request/,
        );
    } finally {
      foreign.destroy();
    }
    assert.equal(await evaluate("window.tidyRemote.status()"), null);
    await assert.rejects(evaluate("window.tidyRemote.connect('-oProxyCommand=invalid')"));
    await until(() => client.status.kind === "connected");
    await evaluate(`globalThis.remoteApi = window.tidyMachines.workspace('${machine.id}').api;
      globalThis.localApi = window.tidyMachines.workspace('local').api;
      globalThis.remoteEvents = [];
      globalThis.localEvents = [];
      remoteApi.onEvent(event => remoteEvents.push(event));
      localApi.onEvent(event => localEvents.push(event)); true;`);
    assert.equal(
      await evaluate(
        `remoteApi.readThread('${project.id}', '${threadId}').then(thread => thread.title)`,
      ),
      "Remote connection demo",
    );
    assert.equal(
      await evaluate(
        `localApi.readThread('${localProject.id}', '${threadId}').then(thread => thread.title)`,
      ),
      "Local thread demo",
    );
    await evaluate(
      `remoteApi.sendMessage({projectId:'${project.id}',threadId:'${threadId}',text:'Keep working through a disconnection'})`,
    );
    await until(() =>
      evaluate(
        "remoteEvents.some(event => event.type === 'thread' || event.type === 'thread-patch')",
      ),
    );
    assert.equal(await evaluate("localEvents.length"), 0);
    disconnect(true);
    await until(() => client.status.kind === "offline");
    assert.equal(
      await evaluate(`remoteApi.createDesign('${project.id}').then(() => false, () => true)`),
      true,
    );
    await evaluate(`localApi.createDesign('${localProject.id}')`);
    assert.equal((await localStore.designs(localProject.id)).length, 1);
    assert.equal((await store.designs(project.id)).length, 0);
    assert.equal(
      await evaluate(
        `window.tidyMachines.workspace('${randomUUID()}').api.createDesign('${localProject.id}').then(() => false, () => true)`,
      ),
      true,
    );
    assert.equal(service.activeRunCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const latestText = (await service.readThread(project.id, threadId)).messages.at(-1)?.text ?? "";
    assert.match(latestText, /steps completed/);
    restore();
    await until(() => client.status.kind === "connected");
    const recovered = await evaluate(
      `remoteApi.readThread('${project.id}', '${threadId}').then(thread => thread.messages.at(-1).text)`,
    );
    assert.match(String(recovered), /steps completed/);
    assert.equal(runs, 1);
    authenticationRequired = true;
    drop();
    client.retry();
    await until(() => client.status.kind === "blocked");
    restore();
    await until(() => client.status.kind === "connected");
    assert.equal(
      await evaluate(
        `remoteApi.readThread('${project.id}', '${threadId}').then(thread => thread.id)`,
      ),
      threadId,
    );
    console.log(
      "PASS: scoped IPC, identical thread IDs on separate machines, event isolation, disconnected mutation rejection, local work while remote is offline, unknown-machine rejection, continuing agent, reconnect without duplicate execution, and authentication recovery.",
    );
    clearTimeout(watchdog);
    await close();
  } catch (error) {
    console.error(error);
    console.error(await evaluate("document.body.innerText").catch(() => "Renderer closed"));
    process.exitCode = 1;
    clearTimeout(watchdog);
    await close();
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
