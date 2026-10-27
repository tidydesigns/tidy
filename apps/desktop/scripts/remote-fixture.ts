import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, chmod, mkdir, mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, net, protocol, shell } from "electron";
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
  let openedTarget: string | null = null;
  let forgotten = false;
  let reuseLocalBackend = false;
  registerWorkspaceIPC(localService, APP_URL, {
    get: () => (reuseLocalBackend ? client : undefined),
    getMachine: (id) => (id === machine.id ? client : undefined),
    list: () => [
      { id: "local", label: "This machine", status: null },
      ...(!forgotten ? [{ id: machine.id, label: machine.target, status: client.status }] : []),
    ],
    open: async (target) => {
      openedTarget = target;
      window.focus();
    },
    machines: () => [machine],
    discover: async () => [],
    forget: async (id) => {
      assert.equal(id, machine.id);
      forgotten = true;
      client.close();
      window.webContents.send("tidy:machines-changed");
    },
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
    window.webContents.executeJavaScript(expression).catch((error: unknown) => {
      throw new Error("Renderer check failed: " + expression, { cause: error });
    });
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
    await evaluate(
      `globalThis.machineChanges = []; globalThis.stopMachineChanges = window.tidyMachines.onChanged((...args) => machineChanges.push(args.length)); true;`,
    );
    window.webContents.send("tidy:machines-changed", { unexpected: "payload" });
    await until(() => evaluate("machineChanges.length > 0"));
    assert.equal(await evaluate("machineChanges.every(count => count === 0)"), true);
    const changeCount = await evaluate("machineChanges.length");
    await evaluate("stopMachineChanges(); true;");
    window.webContents.send("tidy:machines-changed");
    await evaluate("window.tidyMachines.list()");
    assert.equal(await evaluate("machineChanges.length"), changeCount);

    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Settings"]'))`));
    await evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
    await until(() => evaluate('Boolean(document.querySelector(".settings-sections"))'));
    await evaluate(
      'Array.from(document.querySelectorAll(".settings-section")).find(button => button.textContent === "Remote machines").click()',
    );
    await until(() => evaluate('Boolean(document.querySelector("#remote-destination"))'));
    await evaluate(
      `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(document.querySelector('#remote-destination'), '-oProxyCommand=invalid'); document.querySelector('#remote-destination').dispatchEvent(new Event('input', {bubbles:true})); true;`,
    );
    await evaluate('document.querySelector(".remote-connect").requestSubmit()');
    await until(() =>
      evaluate('document.querySelector(".remote-error")?.textContent.includes("SSH alias")'),
    );
    assert.equal(openedTarget, null);
    await evaluate(
      `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(document.querySelector('#remote-destination'), '${machine.target}'); document.querySelector('#remote-destination').dispatchEvent(new Event('input', {bubbles:true})); true;`,
    );
    await evaluate('document.querySelector(".remote-connect").requestSubmit()');
    await until(() => openedTarget === machine.target);
    await until(() =>
      evaluate('document.querySelector(".remote-machine-status")?.textContent === "Connected"'),
    );
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
    const openedLinks: string[] = [];
    const openExternal = shell.openExternal;
    const showItemInFolder = shell.showItemInFolder;
    const revealedFiles: string[] = [];
    shell.showItemInFolder = (path) => {
      revealedFiles.push(path);
    };
    shell.openExternal = async (url) => {
      openedLinks.push(url);
    };
    try {
      await evaluate(`remoteApi.openChatLink('${project.id}', 'https://example.org/review')`);
      assert.deepEqual(openedLinks, ["https://example.org/review"]);
      for (const href of ["file:///etc/passwd", "src/main.ts:2", "javascript:alert(1)"])
        await assert.rejects(
          evaluate(`remoteApi.openChatLink('${project.id}', ${JSON.stringify(href)})`),
        );
      assert.equal(openedLinks.length, 1);
      const file = join(project.path, "reused-backend.ts");
      await writeFile(file, "export const ready = true;");
      reuseLocalBackend = true;
      await evaluate(`window.tidy.openChatLink('${project.id}', 'reused-backend.ts:2')`);
      await evaluate(`localApi.openChatLink('${project.id}', 'reused-backend.ts:2')`);
      assert.deepEqual(revealedFiles, [await realpath(file), await realpath(file)]);
      await assert.rejects(
        evaluate(`remoteApi.openChatLink('${project.id}', 'reused-backend.ts:2')`),
      );
      await assert.rejects(evaluate(`localApi.openChatLink('${project.id}', '../private.ts')`));
      assert.equal(revealedFiles.length, 2);
    } finally {
      reuseLocalBackend = false;
      shell.openExternal = openExternal;
      shell.showItemInFolder = showItemInFolder;
    }
    await evaluate(`remoteApi.harnessDetails('${project.id}', 'codex', false)`);
    await evaluate(`remoteApi.setThreadSettings('${project.id}', '${threadId}', {})`);
    await evaluate(`remoteApi.setThreadDone('${project.id}', '${threadId}', true)`);
    await evaluate(`remoteApi.setThreadDone('${project.id}', '${threadId}', false)`);
    assert.match(
      String(
        await evaluate(
          `remoteApi.respondToApproval('${project.id}', '${threadId}', '${randomUUID()}', 'allow').then(() => '', error => error.message)`,
        ),
      ),
      /no longer active/,
    );
    await evaluate(
      `remoteApi.addAttachment('${project.id}', 'fixture.txt', 'data:text/plain;base64,aGVsbG8=').then(value => { globalThis.attachment = value; return true; })`,
    );
    assert.equal(
      await evaluate(
        `remoteApi.readAttachment('${project.id}', attachment.id).then(value => value.name)`,
      ),
      "fixture.txt",
    );
    await evaluate(
      `remoteApi.createDesignFolder('${project.id}', 'Before').then(value => { globalThis.folder = value; return true; })`,
    );
    assert.equal(
      await evaluate(
        `remoteApi.renameDesignFolder('${project.id}', folder.id, 'After').then(value => value.name)`,
      ),
      "After",
    );
    await evaluate(
      `remoteApi.createDesign('${project.id}').then(value => { globalThis.design = value; return true; })`,
    );
    assert.equal(
      await evaluate(`remoteApi.refreshDesign('${project.id}', design.id, design.version)`),
      null,
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
    await until(() =>
      evaluate('document.querySelector(".remote-machine-status")?.textContent === "Offline"'),
    );
    assert.equal(
      await evaluate(`remoteApi.createDesign('${project.id}').then(() => false, () => true)`),
      true,
    );
    await evaluate(`localApi.createDesign('${localProject.id}')`);
    assert.equal((await localStore.designs(localProject.id)).length, 1);
    assert.equal((await store.designs(project.id)).length, 1);
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
    online = true;
    authenticationRequired = false;
    await evaluate(
      `Array.from(document.querySelectorAll('.remote-machine button')).find(button => button.textContent === 'Retry').click()`,
    );
    await until(() => client.status.kind === "connected");
    await until(() =>
      evaluate('document.querySelector(".remote-machine-status")?.textContent === "Connected"'),
    );
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
    await until(() =>
      evaluate('document.querySelector(".remote-machine-status")?.textContent === "Connected"'),
    );
    assert.equal(
      await evaluate(
        `remoteApi.readThread('${project.id}', '${threadId}').then(thread => thread.id)`,
      ),
      threadId,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.remote-machine button')).find(button => button.textContent === 'Remove').click()`,
    );
    await until(() => forgotten);
    await until(() => evaluate('document.querySelectorAll(".remote-machine").length === 0'));
    assert.equal(service.activeRunCount, 1);
    console.log(
      "PASS: Settings connection validation, status, retry and removal, scoped IPC, identical thread IDs on separate machines, event isolation, disconnected mutation rejection, local work while remote is offline, unknown-machine rejection, continuing agent, reconnect without duplicate execution, and authentication recovery.",
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
