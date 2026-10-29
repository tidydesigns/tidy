import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, net, protocol } from "electron";
import { z } from "zod";
import type { Thread } from "../src/shared/contracts/desktop";
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
  const root = await mkdtemp(join(tmpdir(), "tidy-browser-integration-"));
  const desktop = resolve(import.meta.dirname, "..");
  app.setPath("userData", join(root, "electron"));
  app.on("window-all-closed", () => {});
  await app.whenReady();
  protocol.handle(APP_SCHEME, (request) =>
    net.fetch(pathToFileURL(rendererAssetPath(join(desktop, "out/renderer"), request.url)).href),
  );
  const projectId = randomUUID(),
    threadId = randomUUID();
  const viewerIds = new Map<WorkspaceService, string>();
  const viewerScopes = new Map<WorkspaceService, { projectId: string; threadId: string }>();
  const makeService = async (label: string) => {
    const store = new ProjectStore(join(root, label, "state"));
    await store.initialize();
    const path = join(root, label, "project");
    await mkdir(join(path, ".tidy"), { recursive: true });
    await writeFile(
      join(path, ".tidy", "project.json"),
      JSON.stringify({ version: 1, id: projectId }),
    );
    const project = (await store.open(path)).project;
    await store.writeThread({
      id: threadId,
      projectId: project.id,
      revision: 0,
      title: `${label} browser test`,
      harness: "codex",
      designIds: [],
      status: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: randomUUID(),
          role: "assistant",
          text: "Preview the application beside this conversation.",
        },
      ],
    });
    const service = new WorkspaceService(store, undefined, async () => null);
    const watch = service.browser.watch.bind(service.browser);
    service.browser.watch = async (scope, id, send) => {
      viewerIds.set(service, id);
      viewerScopes.set(service, scope);
      return watch(scope, id, send);
    };
    return { service, scope: { projectId: project.id, threadId } };
  };
  const local = await makeService("Local"),
    remote = await makeService("Remote");
  const sessions = new SessionStore(join(root, "sessions"));
  const identity = { hostId: randomUUID(), instanceId: randomUUID(), buildId: "browser-test" };
  const host = createRemoteHost({
    service: remote.service,
    identity,
    sessions,
    receipts: new RequestReceipts(join(root, "receipts")),
  });
  const port = await host.listen();
  const machine = {
    id: randomUUID(),
    target: "test@browser-host",
    hostId: identity.hostId,
    lastConnectedAt: null,
  };
  let online = true;
  let drop = () => {};
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: join(desktop, "out/preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const errors: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const client = new RemoteClient({
    machine,
    bundlePath: "unused",
    temporaryDirectory: root,
    connected: async () => {},
    event: (event) => {
      if (!window.isDestroyed()) window.webContents.send("tidy:machine-event", machine.id, event);
    },
    statusChanged: (status) => {
      if (!window.isDestroyed()) {
        window.webContents.send("tidy:machine-status", machine.id, status);
        window.webContents.send("tidy:machines-changed");
      }
    },
    connector: async () => {
      if (!online) throw new RemoteFailure("unavailable", "Fixture disconnected.");
      return {
        host: {
          ...identity,
          protocol: 3,
          pid: process.pid,
          port,
          managed: false,
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
  registerWorkspaceIPC(local.service, APP_URL, {
    get: () => undefined,
    getMachine: (id) => (id === machine.id ? client : undefined),
    list: () => [
      { id: "local", label: "This machine", status: null },
      { id: machine.id, label: machine.target, status: client.status },
    ],
    open: async () => {},
    machines: () => [machine],
    discover: async () => [],
    forget: async () => {},
  });
  const fixture = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>Project preview</title><style>body{font:16px system-ui;background:#fafafa;color:#27272a;margin:0}main{max-width:580px;margin:48px auto;padding:24px}h1{font-size:34px;letter-spacing:-1px}label{display:block;margin-top:24px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #d4d4d8;border-radius:7px;margin:8px 0 16px}button{background:#27272a;color:white;border:0;border-radius:7px;padding:12px 20px}small{color:#71717a}#result{margin-top:20px}</style><main><small>PROJECT PREVIEW</small><h1>Make something useful.</h1><p>Test your app in the same browser as your agent.</p><label>Your name<input id="name" placeholder="Enter your name"></label><button onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value">Continue</button><button id="rename" onclick="document.querySelector('#prompt-result').textContent='Prompt: '+JSON.stringify(prompt('Project name','Default name'))">Rename</button><p id="result"></p><p id="prompt-result"></p></main>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureAddress = fixture.address();
  if (!fixtureAddress || typeof fixtureAddress === "string")
    throw new Error("Fixture unavailable.");
  const url = `http://127.0.0.1:${fixtureAddress.port}`;
  const evaluate = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression).catch((error: unknown) => {
      throw new Error("Renderer evaluation failed: " + expression, { cause: error });
    });
  const callRenderer = async (functionDeclaration: string, args: unknown[]) => {
    const debuggerAPI = window.webContents.debugger;
    if (!debuggerAPI.isAttached()) debuggerAPI.attach("1.3");
    const { result } = z
      .object({ result: z.object({ objectId: z.string() }) })
      .parse(await debuggerAPI.sendCommand("Runtime.evaluate", { expression: "globalThis" }));
    try {
      const resultValue: unknown = await debuggerAPI.sendCommand("Runtime.callFunctionOn", {
        objectId: result.objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      });
      assert.ok(
        !z.object({ exceptionDetails: z.unknown().optional() }).parse(resultValue).exceptionDetails,
      );
    } finally {
      await debuggerAPI.sendCommand("Runtime.releaseObject", { objectId: result.objectId });
    }
  };
  const shortcut = (keyCode: string) => {
    const modifiers = [process.platform === "darwin" ? "meta" : "control"] satisfies NonNullable<
      Electron.KeyboardInputEvent["modifiers"]
    >;
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  async function until(check: () => Promise<unknown> | boolean, name: string) {
    const end = Date.now() + 15000;
    while (!(await check())) {
      if (Date.now() > end)
        throw new Error(
          `Timed out: ${name}. Renderer errors: ${errors.join("\n")}. UI: ${await evaluate("document.body.innerText.slice(0,1600)")}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  for (const value of [local, remote]) {
    const thread = await value.service.readThread(value.scope.projectId, value.scope.threadId);
    thread.messages.push({
      id: randomUUID(),
      role: "assistant",
      text: `Preview [Open app](${url}) on this project's host.`,
    });
    thread.revision++;
    await value.service.store.writeThread(thread);
  }
  client.start();
  try {
    for (const [label, value, machineId] of [
      ["local", local, "local"],
      ["remote", remote, machine.id],
    ] as const) {
      await window.loadURL(APP_URL);
      await evaluate(
        `sessionStorage.setItem('tidy:navigation:machine', ${JSON.stringify(JSON.stringify(machineId))}); sessionStorage.setItem(${JSON.stringify(`tidy:navigation:${machineId === "local" ? "" : machineId + ":"}mode`)}, '"code"'); sessionStorage.setItem(${JSON.stringify(`tidy:navigation:${machineId === "local" ? "" : machineId + ":"}threads`)}, ${JSON.stringify(JSON.stringify({ [value.scope.projectId]: value.scope.threadId }))}); true`,
      );
      await window.loadURL(APP_URL);
      window.show();
      window.focus();
      window.webContents.focus();
      await until(
        () => evaluate('Boolean(document.querySelector(".browser-toggle-button"))'),
        `${label} browser toggle`,
      );
      assert.equal(
        await evaluate(
          'matchMedia("(hover: hover) and (pointer: fine)").matches && getComputedStyle(document.querySelector(".thread-done")).position === "absolute"',
        ),
        true,
        "Desktop fixture must use mouse input and the desktop thread layout.",
      );
      if (label === "remote") {
        await until(
          () => evaluate('Boolean(document.querySelector(".chat-web-link"))'),
          "remote chat link",
        );
        await evaluate('document.querySelector(".chat-web-link").click()');
      } else await evaluate('document.querySelector(".browser-toggle-button").click()');
      await until(
        () =>
          evaluate(
            'Boolean(document.querySelector(".browser-workspace:not([hidden]) .browser-navigation input"))',
          ),
        `${label} panel`,
      );
      if (label === "local") {
        assert.equal(await evaluate('Boolean(document.querySelector(".browser-new-tab"))'), true);
        await until(
          () =>
            evaluate(
              'document.body.textContent.includes("Preview the application beside this conversation.")',
            ),
          "conversation ready",
        );
        await writeFile(
          join(tmpdir(), "tidy-browser-empty.png"),
          (await window.webContents.capturePage()).toPNG(),
        );
        await evaluate('document.querySelector(".browser-new-tab").click()');
        await until(
          async () => (await value.service.browser.state(value.scope)).tabs.length === 1,
          "first preview from plus",
        );
        await until(
          () =>
            evaluate('document.activeElement?.getAttribute("aria-label") === "Browser address"'),
          "first preview address focus",
        );
        await evaluate(
          `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.browser-navigation input'), ${JSON.stringify(url)}); document.querySelector('.browser-navigation input').dispatchEvent(new Event('input',{bubbles:true})); true`,
        );
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      }
      await until(
        () => evaluate('Boolean(document.querySelector(".browser-canvas:not([hidden])"))'),
        `${label} first frame`,
      );
      const state = await value.service.browser.state(value.scope);
      assert.equal(state.tabs.length, 1);
      const tabId = state.activeTabId;
      assert.ok(tabId);
      const apiExpression = `window.tidyMachines.workspace(${JSON.stringify(machineId)}).api.browser`;
      const mountedApi = apiExpression;
      const result = await evaluate(
        `${mountedApi}.command(${JSON.stringify({ ...value.scope, action: { kind: "snapshot", tabId } })})`,
      );
      assert.ok(JSON.stringify(result).includes("Make something useful"));
      if (label === "remote") {
        const receipts = join(root, "receipts");
        const before = (await readdir(receipts)).filter((name) => name.endsWith(".json")).length;
        const screenshot = z
          .object({ output: z.string() })
          .parse(
            await evaluate(
              `${mountedApi}.command(${JSON.stringify({ ...value.scope, action: { kind: "screenshot", tabId } })})`,
            ),
          );
        assert.equal(
          Buffer.from(screenshot.output, "base64").subarray(0, 2).toString("hex"),
          "ffd8",
        );
        assert.equal(
          (await readdir(receipts)).filter((name) => name.endsWith(".json")).length,
          before,
        );
      }

      let bounds = z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .parse(
          await evaluate(
            '(()=>{const r=document.querySelector(".browser-canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()',
          ),
        );
      assert.ok(bounds.width > 300 && bounds.height > 200);
      await until(
        async () =>
          (await value.service.browser.state(value.scope)).tabs[0]?.width ===
          Math.round(bounds.width),
        `${label} responsive viewport`,
      );
      bounds = z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .parse(
          await evaluate(
            '(()=>{const r=document.querySelector(".browser-canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()',
          ),
        );
      await evaluate('document.querySelector(".browser-control-button").click()');
      await until(
        () =>
          evaluate(
            'document.querySelector(".browser-control-button")?.textContent === "Take control"',
          ),
        `${label} release control`,
      );
      await assert.rejects(
        evaluate(
          `${mountedApi}.command(${JSON.stringify({ ...value.scope, action: { kind: "open", url: "about:blank" } })})`,
        ),
      );
      const coordinates = await value.service.browser.command(value.scope, {
        kind: "evaluate",
        tabId,
        expression:
          "(() => { const input=document.querySelector('#name').getBoundingClientRect(), button=document.querySelector('main button').getBoundingClientRect(), rename=document.querySelector('#rename').getBoundingClientRect(); return {input:{x:input.x+15,y:input.y+15},button:{x:button.x+15,y:button.y+15},rename:{x:rename.x+15,y:rename.y+15}}; })()",
      });
      const coordinateOutput = z.object({ output: z.string() }).parse(coordinates).output;
      const pointSchema = z.object({ x: z.number(), y: z.number() });
      const points = z
        .object({ input: pointSchema, button: pointSchema, rename: pointSchema })
        .parse(JSON.parse(coordinateOutput));
      await evaluate('document.querySelector(".browser-control-button").click()');
      await until(
        () =>
          evaluate('document.querySelector(".browser-control-button")?.textContent === "Release"'),
        `${label} take control`,
      );
      await until(
        () =>
          evaluate('document.querySelector(".browser-surface")?.dataset.interactive === "true"'),
        `${label} current page frame`,
      );
      const viewport = (await value.service.browser.state(value.scope)).tabs[0];
      assert.ok(viewport);
      const clickPoint = (point: { x: number; y: number }, clickCount = 1) => {
        const x = Math.round(bounds.x + (point.x * bounds.width) / viewport.width),
          y = Math.round(bounds.y + (point.y * bounds.height) / viewport.height);
        window.webContents.sendInputEvent({
          type: "mouseDown",
          x,
          y,
          button: "left",
          clickCount,
        });
        window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount });
      };
      clickPoint(points.input);
      await until(
        () => evaluate('document.activeElement?.classList.contains("browser-keyboard")'),
        `${label} keyboard focus`,
      );
      window.webContents.focus();
      const pasted = "a".repeat(15999) + "😀" + "b".repeat(33000);
      await callRenderer(
        "function(text) { const data = new DataTransfer(); data.setData('text/plain', text); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }",
        [pasted],
      );
      await until(async () => {
        const result = await value.service.browser.command(value.scope, {
          kind: "snapshot",
          tabId,
        });
        return z
          .array(
            z.object({
              role: z.string().optional(),
              name: z.string().optional(),
              value: z.string().optional(),
            }),
          )
          .parse(JSON.parse(result.output ?? "[]"))
          .some(
            (node) => node.role === "textbox" && node.name === "Your name" && node.value === pasted,
          );
      }, `${label} long Unicode paste`);
      const viewerId = viewerIds.get(value.service);
      assert.ok(viewerId);
      const inspectPage = async (expression: string) =>
        (
          await value.service.browser.command(
            value.scope,
            { kind: "evaluate", tabId, expression },
            { actor: viewerId },
          )
        ).output;
      const editingSelection = () =>
        inspectPage(
          "(()=>{const input=document.querySelector('#name');return [input.value,input.selectionStart,input.selectionEnd]})()",
        );
      const clearPageInput = async () => {
        shortcut("A");
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await until(
          async () => (await editingSelection()) === '["",0,0]',
          `${label} cleared input`,
        );
      };
      await clearPageInput();
      await window.webContents.insertText("alpha beta");
      await until(
        async () => (await editingSelection()) === '["alpha beta",10,10]',
        `${label} editing fixture`,
      );
      await evaluate(
        `globalThis.fixturePlatformDescriptor=Object.getOwnPropertyDescriptor(navigator,'platform');Object.defineProperty(navigator,'platform',{value:'MacIntel',configurable:true});true`,
      );
      const macKey = async (
        key: string,
        keyCode: number,
        modifiers: { altKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
      ) => {
        await callRenderer(
          "function(key, keyCode, modifiers) { const target = document.querySelector('.browser-keyboard'); for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, bubbles: true, cancelable: true, ...modifiers })); }",
          [key, keyCode, modifiers],
        );
      };
      try {
        await macKey("ArrowLeft", 37, { altKey: true });
        await until(
          async () => (await editingSelection()) === '["alpha beta",6,6]',
          `${label} Mac word navigation`,
        );
        await macKey("ArrowLeft", 37, { metaKey: true });
        await until(
          async () => (await editingSelection()) === '["alpha beta",0,0]',
          `${label} Mac line navigation`,
        );
        await macKey("ArrowRight", 39, { metaKey: true });
        await until(
          async () => (await editingSelection()) === '["alpha beta",10,10]',
          `${label} Mac line end`,
        );
        await macKey("ArrowLeft", 37, { altKey: true, shiftKey: true });
        await until(
          async () => (await editingSelection()) === '["alpha beta",6,10]',
          `${label} Mac word selection`,
        );
        await macKey("ArrowRight", 39, { metaKey: true });
        await until(
          async () => (await editingSelection()) === '["alpha beta",10,10]',
          `${label} reset caret`,
        );
        await macKey("Backspace", 8, { metaKey: true });
        await until(
          async () => (await editingSelection()) === '["",0,0]',
          `${label} Mac line deletion`,
        );
        await inspectPage(
          "window.keySequence=[];document.onkeydown=e=>{if(e.code==='KeyA')keySequence.push('down')};document.onkeyup=e=>{if(e.code==='KeyA')keySequence.push('up')}",
        );
        await evaluate(
          `(()=>{const target=document.querySelector('.browser-keyboard');target.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',keyCode:65,metaKey:true,bubbles:true,cancelable:true}));target.dispatchEvent(new KeyboardEvent('keyup',{key:'a',code:'KeyA',keyCode:65,bubbles:true,cancelable:true}));return true})()`,
        );
        await until(
          async () => (await inspectPage("window.keySequence")) === '["down","up"]',
          `${label} shortcut key release after modifier release`,
        );
      } finally {
        await evaluate(
          `if(globalThis.fixturePlatformDescriptor)Object.defineProperty(navigator,'platform',globalThis.fixturePlatformDescriptor);else delete navigator.platform;true`,
        );
      }
      await clearPageInput();
      await window.webContents.insertText("Preview user");
      await until(
        async () =>
          (
            await value.service.browser.command(value.scope, { kind: "snapshot", tabId })
          ).output?.includes("Preview user"),
        `${label} typed input`,
      );
      clickPoint(points.input, 2);
      await evaluate('document.querySelector(".browser-control-button").click()');
      await until(
        () =>
          evaluate(
            'document.querySelector(".browser-control-button")?.textContent === "Take control"',
          ),
        `${label} inspect double click selection`,
      );
      const selection = await value.service.browser.command(value.scope, {
        kind: "evaluate",
        tabId,
        expression:
          "(()=>{const input=document.querySelector('#name');return input.value.slice(input.selectionStart,input.selectionEnd)})()",
      });
      assert.equal(selection.output, '"Preview"', "Double click selects a word in the host page.");
      await evaluate('document.querySelector(".browser-control-button").click()');
      await until(
        () =>
          evaluate('document.querySelector(".browser-surface")?.dataset.interactive === "true"'),
        `${label} resume page input`,
      );
      clickPoint(points.button);
      await until(
        async () =>
          (
            await value.service.browser.command(value.scope, { kind: "snapshot", tabId })
          ).output?.includes("Hello, Preview user"),
        `${label} clicked submit`,
      );
      shortcut("F");
      await until(
        () => evaluate('document.activeElement?.getAttribute("aria-label") === "Find in page"'),
        `${label} find shortcut`,
      );
      await window.webContents.insertText("Make something useful");
      await evaluate('document.querySelector(".browser-find").requestSubmit()');
      await until(
        () =>
          evaluate(
            'document.querySelector(".browser-find [role=status]")?.textContent === "Found"',
          ),
        `${label} real page search`,
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until(
        async () =>
          !(await evaluate('Boolean(document.querySelector(".browser-find"))')) &&
          (await value.service.browser.state(value.scope)).tabs[0]?.height === viewport.height,
        `${label} close find`,
      );
      clickPoint(points.rename);
      await until(
        () => evaluate('document.activeElement?.getAttribute("aria-label") === "Page prompt"'),
        `${label} prompt focus`,
      );
      assert.equal(
        await evaluate('document.querySelector(".browser-dialog input").value'),
        "Default name",
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      await until(
        () => evaluate('document.querySelector(".browser-dialog input").value === ""'),
        `${label} clear prompt default`,
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await until(async () => {
        const snapshot = await value.service.browser.command(value.scope, {
          kind: "snapshot",
          tabId,
        });
        return z
          .array(z.object({ name: z.string().optional() }))
          .parse(JSON.parse(snapshot.output ?? "[]"))
          .some((node) => node.name === 'Prompt: ""');
      }, `${label} explicitly empty prompt`);
      await evaluate(
        'document.querySelector(".browser-new-tab").click();document.querySelector(".browser-new-tab").click()',
      );
      await until(
        async () => (await value.service.browser.state(value.scope)).tabs.length === 2,
        `${label} rapid plus clicks open one preview`,
      );
      await until(
        () => evaluate('document.activeElement?.getAttribute("aria-label") === "Browser address"'),
        `${label} new-tab address focus`,
      );
      shortcut("W");
      await until(
        async () => (await value.service.browser.state(value.scope)).tabs.length === 1,
        `${label} close-tab shortcut`,
      );
      assert.equal((await value.service.browser.state(value.scope)).activeTabId, tabId);
      await until(
        () =>
          evaluate(
            `document.querySelector('[aria-label="Browser address"]').value === ${JSON.stringify(new URL(url).href)}`,
          ),
        `${label} restored tab address`,
      );
      await until(
        () => evaluate('Boolean(document.querySelector(".browser-canvas:not([hidden])"))'),
        `${label} restored tab frame`,
      );
      if (label === "local") {
        for (let i = 0; i < 8; i++) {
          await evaluate('document.querySelector(".browser-new-tab").click()');
          await until(
            () =>
              evaluate(
                `document.querySelectorAll('.browser-tab').length === ${i + 2} && document.querySelector('.browser-new-tab').getAttribute('aria-busy') === 'false'`,
              ),
            "additional overflow preview",
          );
        }
        await until(
          () => evaluate('document.querySelectorAll(".browser-tab").length === 9'),
          "overflowing preview tabs",
        );
        assert.equal(
          await evaluate(
            '(()=>{const strip=document.querySelector(".browser-tabs"),plus=document.querySelector(".browser-new-tab").getBoundingClientRect(),pane=document.querySelector(".browser-workspace").getBoundingClientRect();return strip.scrollWidth>strip.clientWidth && plus.left>=pane.left && plus.right<=pane.right})()',
          ),
          true,
          "New preview remains reachable when tabs overflow.",
        );
        for (let count = 8; count >= 1; count--) {
          await evaluate(
            'document.querySelector(".browser-tab:last-child .browser-tab-close").click()',
          );
          await until(
            async () => (await value.service.browser.state(value.scope)).tabs.length === count,
            "close overflow preview",
          );
        }
        await until(
          () => evaluate('document.querySelectorAll(".browser-tab").length === 1'),
          "closing overflow previews retains original tab",
        );
        await evaluate(
          'document.querySelector(".browser-new-tab").click(); document.querySelector("#thread-prompt").focus()',
        );
        await until(
          () =>
            evaluate(
              'document.querySelectorAll(".browser-tab").length === 2 && document.querySelector(".browser-new-tab").getAttribute("aria-busy") === "false"',
            ),
          "preview finishes after focus moves to composer",
        );
        assert.equal(
          await evaluate("document.activeElement?.id"),
          "thread-prompt",
          "A completed preview request cannot steal focus from the conversation.",
        );
        await evaluate(
          'document.querySelector(".browser-tab:last-child .browser-tab-close").click()',
        );
        await until(
          async () => (await value.service.browser.state(value.scope)).tabs.length === 1,
          "close focus-check preview",
        );
      }
      const paneWidth = z
        .number()
        .parse(await evaluate('document.querySelector(".browser-workspace").clientWidth'));
      await evaluate('document.querySelector(".browser-resize-handle").focus()');
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
      await until(
        () =>
          evaluate(
            `(()=>{const pane=document.querySelector('.browser-workspace');return pane.clientWidth > ${paneWidth} && Number(document.querySelector('.browser-resize-handle').getAttribute('aria-valuenow')) === Math.round(pane.clientWidth)})()`,
          ),
        `${label} keyboard pane resize`,
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(
        join(tmpdir(), `tidy-browser-${label}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
      await evaluate('document.querySelector(".browser-options [aria-haspopup]").click()');
      await evaluate(
        'Array.from(document.querySelectorAll("[role=menuitemcheckbox]")).find(item=>item.textContent.includes("Mobile")).click()',
      );
      await until(async () => {
        const tab = (await value.service.browser.state(value.scope)).tabs[0];
        return tab?.width === 390 && tab.height === 844;
      }, `${label} mobile viewport`);
      window.setSize(900, 760);
      await until(
        () =>
          evaluate(
            '(()=>{const pane=document.querySelector(".browser-workspace").getBoundingClientRect();const work=document.querySelector("#workspace-panel-code").getBoundingClientRect();return innerWidth<=1000 && Math.abs(pane.width-work.width)<2 && Math.abs(pane.height-work.height)<2})()',
          ),
        `${label} compact layout`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(
        join(tmpdir(), `tidy-browser-${label}-compact.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
      await inspectPage("document.body.style.height='4000px'");
      try {
        const displayedWidth = z
          .number()
          .parse(
            await evaluate(
              'document.querySelector(".browser-canvas").getBoundingClientRect().width',
            ),
          );
        for (const [mode, delta, expected] of [
          [0, 120, (120 * 390) / displayedWidth],
          [1, 3, 48],
          [2, 1, 844],
        ]) {
          await inspectPage("scrollTo(0,0)");
          await evaluate(
            `(()=>{const canvas=document.querySelector('.browser-canvas'),bounds=canvas.getBoundingClientRect();canvas.dispatchEvent(new WheelEvent('wheel',{clientX:bounds.left+20,clientY:bounds.top+20,deltaY:${delta},deltaMode:${mode},bubbles:true,cancelable:true}));return true})()`,
          );
          await until(
            async () => Math.abs(Number(await inspectPage("scrollY")) - expected) < 2,
            `${label} scaled wheel mode ${mode}`,
          );
        }
      } finally {
        await inspectPage("document.body.style.height='';scrollTo(0,0)");
      }
      await evaluate('document.querySelector(".browser-options [aria-haspopup]").click()');
      await evaluate(
        'Array.from(document.querySelectorAll("[role=menuitemcheckbox]")).find(item=>item.textContent.includes("Fit pane")).click()',
      );
      window.setSize(1440, 960);
      await until(() => evaluate("innerWidth >= 1400"), `${label} restored window`);
      if (label === "remote") {
        online = false;
        drop();
        client.wake("network", false);
        await until(
          () => evaluate('Boolean(document.querySelector(".browser-reconnecting"))'),
          "remote disconnect overlay",
        );
        assert.equal(remote.service.browser.activeCount, 1);
        online = true;
        client.retry();
        await until(
          () =>
            evaluate(
              '!document.querySelector(".browser-reconnecting") && Boolean(document.querySelector(".browser-canvas:not([hidden])"))',
            ),
          "remote stream reconnect",
        );
        assert.equal((await remote.service.browser.state(remote.scope)).activeTabId, tabId);
      }
      await evaluate('document.querySelector(".sidebar-new-thread").click()');
      await until(
        () => viewerScopes.get(value.service)?.threadId !== value.scope.threadId,
        `${label} draft preview attached`,
      );
      const draftScope = viewerScopes.get(value.service);
      assert.ok(draftScope);
      await until(
        () => evaluate('Boolean(document.querySelector(".browser-new-tab"))'),
        `${label} draft preview ready`,
      );
      await evaluate('document.querySelector(".browser-new-tab").click()');
      await until(
        async () => (await value.service.browser.state(draftScope)).tabs.length === 1,
        `${label} draft tab opened`,
      );
      const draftTabId = (await value.service.browser.state(draftScope)).activeTabId;
      await evaluate('document.querySelector(".thread-select").click()');
      await until(
        () => viewerScopes.get(value.service)?.threadId === value.scope.threadId,
        `${label} existing thread selected`,
      );
      await evaluate('document.querySelector(".sidebar-new-thread").click()');
      await until(
        () => viewerScopes.get(value.service)?.threadId === draftScope.threadId,
        `${label} draft preview restored`,
      );
      assert.equal((await value.service.browser.state(draftScope)).activeTabId, draftTabId);
      await until(
        () => evaluate('Boolean(document.querySelector(".browser-tab-close"))'),
        `${label} restored draft rendered`,
      );
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      if (label === "local") {
        for (let visit = 0; visit < 2; visit++) {
          await evaluate(`document.querySelector('[aria-label="Switch project"]').click()`);
          await until(
            () =>
              evaluate(
                'Array.from(document.querySelectorAll(".machine-project-group")).filter(group => group.querySelector(".machine-project-row")).length === 2',
              ),
            "machine projects ready",
          );
          await callRenderer(
            "function(label) { const group = Array.from(document.querySelectorAll('.machine-project-group')).find(group => group.querySelector('summary').textContent.includes(label)); group.open = true; group.querySelector('.machine-project-row').click(); }",
            [visit === 0 ? machine.target : "This machine"],
          );
          const expectedMachine = visit === 0 ? machine.id : "local";
          await until(
            async () =>
              (await evaluate("sessionStorage.getItem('tidy:navigation:machine')")) ===
              JSON.stringify(expectedMachine),
            "machine selection persisted",
          );
          await until(
            () => evaluate('!document.querySelector(".machine-project-panel")'),
            "machine menu closed",
          );
        }
        await evaluate('document.querySelector(".browser-toggle-button").click()');
        await until(
          () => viewerScopes.get(value.service)?.threadId === draftScope.threadId,
          "draft preview survives machine switch",
        );
        assert.equal((await value.service.browser.state(draftScope)).activeTabId, draftTabId);
      }
      await until(
        () => evaluate('Boolean(document.querySelector(".browser-tab-close"))'),
        `${label} restored draft tab closable`,
      );
      if (label === "local") {
        const startThread = value.service.startThread.bind(value.service);
        const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Thread>>>();
        value.service.startThread = (input) => {
          assert.ok(input.threadId);
          const result = Promise.withResolvers<Thread>();
          pending.set(input.threadId, result);
          return result.promise;
        };
        const submitDraft = async (text: string) => {
          await callRenderer(
            "function(text) { const prompt = document.getElementById('thread-prompt'); prompt.focus(); prompt.replaceChildren(document.createTextNode(text)); prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); }",
            [text],
          );
          await until(
            () =>
              evaluate(
                '!document.getElementById("thread-prompt").closest("form").querySelector("button[type=submit]").disabled',
              ),
            "draft can be submitted",
          );
          await evaluate(
            'document.getElementById("thread-prompt").closest("form").requestSubmit()',
          );
        };
        try {
          await submitDraft("First draft task");
          await until(() => pending.has(draftScope.threadId), "first draft start pending");
          await evaluate('document.querySelector(".sidebar-new-thread").click()');
          await until(
            () => viewerScopes.get(value.service)?.threadId !== draftScope.threadId,
            "pending start reserves its browser ID",
          );
          const nextDraft = viewerScopes.get(value.service);
          assert.ok(nextDraft);
          await until(
            () => evaluate('Boolean(document.querySelector(".browser-new-tab"))'),
            "next draft browser ready",
          );
          await evaluate('document.querySelector(".browser-new-tab").click()');
          await until(
            async () => (await value.service.browser.state(nextDraft)).tabs.length === 1,
            "next draft tab opened",
          );
          await callRenderer(
            "function(url) { const input = document.querySelector('.browser-navigation input'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, url); input.dispatchEvent(new Event('input', { bubbles: true })); }",
            [url],
          );
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          await until(
            () => evaluate('Boolean(document.querySelector(".browser-canvas:not([hidden])"))'),
            "next draft application preview loaded",
          );
          const completed = {
            ...(await value.service.readThread(value.scope.projectId, value.scope.threadId)),
            id: draftScope.threadId,
            title: "First draft task",
          };
          await value.service.store.writeThread(completed);
          pending.get(draftScope.threadId)?.resolve(completed);
          await until(
            () => evaluate('document.getElementById("thread-prompt").isContentEditable'),
            "new draft editable after earlier start succeeds",
          );
          await submitDraft("Second draft task");
          await until(
            () => pending.has(nextDraft.threadId),
            "second draft uses a fresh browser ID",
          );
          assert.equal(pending.size, 2);
          pending.get(nextDraft.threadId)?.reject(new Error("Fixture start rejected"));
          await until(
            () =>
              evaluate(
                'document.getElementById("thread-prompt").textContent.includes("Second draft task") && !document.querySelector(".thread-item.selected")',
              ),
            "failed start returns to its draft",
          );
          assert.equal(viewerScopes.get(value.service)?.threadId, nextDraft.threadId);
          assert.equal((await value.service.browser.state(nextDraft)).tabs.length, 1);
          await until(
            () =>
              evaluate(
                'Boolean(document.querySelector(".browser-canvas:not([hidden])")) && !document.querySelector(".browser-error")',
              ),
            "failed start retains a working preview",
          );
          await evaluate(
            `${mountedApi}.discardDraft(${JSON.stringify({ ...draftScope, ownerProjectId: value.scope.projectId })})`,
          );
          assert.equal((await value.service.browser.state(draftScope)).tabs.length, 1);
          await assert.rejects(
            evaluate(
              `${mountedApi}.discardDraft(${JSON.stringify({ ...nextDraft, ownerProjectId: randomUUID() })})`,
            ),
          );
          assert.equal((await value.service.browser.state(nextDraft)).tabs.length, 1);
          const previousStart = pending.get(nextDraft.threadId);
          await submitDraft("Abandoned draft task");
          await until(
            () => pending.get(nextDraft.threadId) !== previousStart,
            "abandoned draft start pending",
          );
          await evaluate('document.querySelector(".sidebar-new-thread").click()');
          await until(
            () => viewerScopes.get(value.service)?.threadId !== nextDraft.threadId,
            "replacement draft attached",
          );
          const replacementDraft = viewerScopes.get(value.service);
          assert.ok(replacementDraft);
          await until(
            () => evaluate('Boolean(document.querySelector(".browser-new-tab"))'),
            "replacement draft ready",
          );
          await evaluate('document.querySelector(".browser-new-tab").click()');
          await until(
            async () => (await value.service.browser.state(replacementDraft)).tabs.length === 1,
            "replacement draft tab opened",
          );
          pending.get(nextDraft.threadId)?.reject(new Error("Fixture abandoned start rejected"));
          await until(
            async () => (await value.service.browser.state(nextDraft)).tabs.length === 0,
            "abandoned failed preview cleaned up",
          );
          assert.equal((await value.service.browser.state(replacementDraft)).tabs.length, 1);
        } finally {
          value.service.startThread = startThread;
        }
      }
      if (label === "remote") {
        const abandoned = { projectId: value.scope.projectId, threadId: randomUUID() };
        await value.service.browser.command(abandoned, { kind: "open", url: "about:blank" });
        await evaluate(
          `${mountedApi}.discardDraft(${JSON.stringify({ ...abandoned, ownerProjectId: value.scope.projectId })})`,
        );
        assert.equal((await value.service.browser.state(abandoned)).tabs.length, 0);
        assert.equal((await value.service.browser.state(draftScope)).tabs.length, 1);
      }
      await evaluate('document.querySelector(".browser-tab-close").click()');
      await until(
        () => value.service.browser.activeCount === (label === "local" ? 2 : 1),
        `${label} draft tab cleaned up`,
      );
      await evaluate('document.querySelector(".browser-window-actions button:last-child").click()');
      assert.equal(value.service.browser.activeCount, label === "local" ? 2 : 1);
      console.log(
        `PASS: ${label} Electron browser panel, real input, Unicode paste, find, prompts, tab shortcuts, mobile viewport, compact layout, authenticated stream, hide without closing${label === "remote" ? ", reconnect retains tab" : ""}.`,
      );
    }
  } finally {
    client.close();
    await host.close();
    await remote.service.close();
    await local.service.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    window.destroy();
    await rm(root, { recursive: true, force: true });
  }
}

void run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error);
    app.exit(1);
  },
);
