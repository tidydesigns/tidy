import { app, BrowserWindow, session, webContents, nativeImage } from "electron";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
app.on("window-all-closed", () => {});
const cleanups = [];
const deadline = setTimeout(() => {
  console.error("Native browser smoke timed out");
  app.exit(1);
}, 45000);
(async () => {
  const dir = await mkdtemp("/tmp/tidy-native-service-");
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  app.setPath("userData", dir);
  await app.whenReady();
  const root = fileURLToPath(new URL("..", import.meta.url));
  const entry = join(dir, "entry.ts"),
    bundle = join(dir, "browser.mjs");
  await writeFile(
    entry,
    `export {NativeBrowserRuntime} from ${JSON.stringify(join(root, "src/main/browser/native-runtime.ts"))};\nexport {BrowserService} from ${JSON.stringify(join(root, "src/main/browser/browser-service.ts"))};\nexport {serveNativeBrowser} from ${JSON.stringify(join(root, "src/main/browser/native-broker.ts"))};\nexport {connectNativeBrowser} from ${JSON.stringify(join(root, "src/main/browser/native-connection.ts"))};\nexport {serveBrowserStream} from ${JSON.stringify(join(root, "src/main/browser/stream-socket.ts"))};`,
  );
  execFileSync(
    "bun",
    ["build", entry, "--target=node", "--format=esm", "--external=electron", "--outfile=" + bundle],
    { stdio: "pipe" },
  );
  const {
    NativeBrowserRuntime,
    BrowserService,
    serveNativeBrowser,
    connectNativeBrowser,
    serveBrowserStream,
  } = await import(pathToFileURL(bundle).href);
  const runtime = new NativeBrowserRuntime(),
    browser = new BrowserService(async (s) => {
      if (s.projectId !== scope.projectId) throw Error("Project access denied.");
    });
  browser.useRuntime(runtime);
  cleanups.push(() => browser.close());
  const server = createServer((q, r) => {
    if (q.url === "/download") {
      r.setHeader("Content-Disposition", 'attachment; filename="hello.txt"');
      r.end("native download");
      return;
    }
    r.setHeader("Content-Type", "text/html");
    r.end(
      "<title>Native service</title><input id=name><input id=file type=file><button id=apply onclick=\"document.querySelector('h1').textContent=document.querySelector('#name').value\">Apply</button><h1>Hello</h1><button id=popup onclick=\"window.open('/next')\">Popup</button><a id=download href=/download>Download</a><button id=alert onclick=\"alert('works')\">Alert</button>",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });
  const scope = { projectId: randomUUID(), threadId: randomUUID() },
    viewerId = randomUUID();
  let state;
  let frames = 0;
  const window = new BrowserWindow({ show: true, width: 1000, height: 800 });
  cleanups.push(() => {
    if (!window.isDestroyed()) window.destroy();
  });
  await window.loadURL("about:blank");
  let watch;
  let posterCount = 0,
    shortcut;
  const presenter = runtime.createPresenter(
    window,
    () =>
      watch?.input({
        tabId: null,
        viewId: null,
        input: { kind: "resize", width: 320, height: 240 },
      }),
    (action) => {
      shortcut = action;
    },
    (frame) => {
      assert.equal(Buffer.from(frame.data).subarray(1, 4).toString(), "PNG");
      posterCount++;
    },
  );
  presenter.layout({ x: 100, y: 100, width: 800, height: 600 });
  watch = await browser.watch(
    scope,
    viewerId,
    (e) => {
      if (e.kind === "state") state = e.state;
      if (e.kind === "frame") frames++;
      if (e.kind === "error") console.log("watch error", e.message);
    },
    presenter,
  );
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f) => {
    for (let i = 0; i < 250; i++) {
      if (f()) return;
      await tick(20);
    }
    throw Error("condition timed out");
  };
  const result = await browser.command(scope, {
    kind: "open",
    url: "http://127.0.0.1:" + server.address().port,
  });
  const tabId = result.state.activeTabId;
  await browser.command(scope, {
    kind: "fill",
    tabId,
    selector: "#name",
    text: "same native page",
  });
  await browser.command(scope, { kind: "click", tabId, selector: "::-p-aria(Apply)" });
  assert.match(
    (
      await browser.command(scope, {
        kind: "evaluate",
        tabId,
        expression: 'document.querySelector("h1").textContent',
      })
    ).output,
    /same native page/,
  );
  await until(() => state.tabs[0].width < 1280);
  assert.equal(state.presentation, "native");
  assert.equal(frames, 0);
  const page = window.contentView.children.find((v) => v.webContents?.getURL().startsWith("http:"));
  const capture = (await page.webContents.capturePage()).getSize();
  const physical = await page.webContents.executeJavaScript(
    "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,node:typeof require})",
  );
  assert.equal(capture.width, Math.round(physical.width * physical.dpr));
  assert.equal(capture.height, Math.round(physical.height * physical.dpr));
  assert.equal(physical.node, "undefined");
  assert.notEqual(page.webContents.session, session.defaultSession);
  await assert.rejects(
    browser.state({ projectId: randomUUID(), threadId: randomUUID() }),
    /access denied/,
  );
  assert.match(
    (await browser.command(scope, { kind: "snapshot", tabId })).output,
    /same native page/,
  );
  assert.ok((await browser.command(scope, { kind: "screenshot", tabId })).output);
  watch.input({ tabId: null, viewId: null, input: { kind: "take-control" } });
  assert.equal(state.control, "you");
  await assert.rejects(
    browser.command(scope, { kind: "click", tabId, selector: "#apply" }),
    /viewer has control/,
  );
  page.webContents.focus();
  await page.webContents.executeJavaScript('document.querySelector("#name").focus()');
  page.webContents.insertText("direct input");
  await tick(60);
  assert.match(
    await page.webContents.executeJavaScript('document.querySelector("#name").value'),
    /direct input/,
  );
  page.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "L",
    modifiers: [process.platform === "darwin" ? "meta" : "control"],
  });
  await until(() => shortcut === "address");
  const methods = [
    [page, "setBounds"],
    [page, "setVisible"],
    [page.webContents, "setZoomMode"],
    [page.webContents, "getZoomFactor"],
    [page.webContents, "setZoomFactor"],
  ];
  let nativeCalls = 0;
  const originals = methods.map(([object, key]) => {
    const original = object[key];
    object[key] = (...args) => {
      nativeCalls++;
      return original.apply(object, args);
    };
    return original;
  });
  for (let i = 0; i < 1000; i++)
    presenter.update(
      { ...state, tabs: state.tabs.map((tab) => ({ ...tab, title: `Progress ${i}` })) },
      true,
    );
  methods.forEach(([object, key], i) => {
    object[key] = originals[i];
  });
  assert.equal(nativeCalls, 0, "Metadata must not relayout or refocus the native page");
  presenter.update(state, true);
  for (const zoom of [0.8, 1, 1.25]) {
    window.webContents.setZoomFactor(zoom);
    presenter.layout({
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      zoom: 320 / 1440,
      viewport: { width: 1440, height: 900 },
    });
    await until(() => state.tabs[0].width === 1440 && state.tabs[0].height === 900);
    assert.deepEqual(
      await page.webContents.executeJavaScript("({width:innerWidth,height:innerHeight})"),
      { width: 1440, height: 900 },
    );
    const point = await page.webContents.executeJavaScript(
      `(()=>{window.nativeClicks=0;document.querySelector('#apply').onclick=()=>window.nativeClicks++;const r=document.querySelector('#apply').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    const x = Math.round(((point.x * 320) / 1440) * zoom),
      y = Math.round(((point.y * 320) / 1440) * zoom);
    page.webContents.focus();
    page.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    page.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await tick(30);
    assert.equal(await page.webContents.executeJavaScript("window.nativeClicks"), 1);
  }
  window.webContents.setZoomFactor(1);
  presenter.layout({
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    zoom: 320 / 1440,
    viewport: { width: 1440, height: 900 },
  });
  await tick(50);
  let mirroredFrame;
  const mirrored = await browser.watch(scope, randomUUID(), (event) => {
    if (event.kind === "frame") mirroredFrame = event;
  });
  await until(() => mirroredFrame);
  assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(mirroredFrame.data)).getSize(), {
    width: Math.round(320 * physical.dpr),
    height: Math.round(200 * physical.dpr),
  });
  const painterBundle = join(dir, "painter.js");
  const painterEntry = join(dir, "painter-entry.ts");
  await writeFile(
    painterEntry,
    `import {createBrowserFramePainter} from ${JSON.stringify(join(root, "src/renderer/src/features/browser/browser-frame-painter.ts"))}; globalThis.BrowserFramePainter = {createBrowserFramePainter};`,
  );
  execFileSync(
    "bun",
    ["build", painterEntry, "--target=browser", "--format=iife", "--outfile=" + painterBundle],
    { stdio: "pipe" },
  );
  await window.webContents.executeJavaScript(await readFile(painterBundle, "utf8"));
  const painted = await window.webContents.executeJavaScript(`new Promise(resolve => {
    const canvas = document.createElement('canvas');
    let painted = false;
    const painter = BrowserFramePainter.createBrowserFramePainter({
      canvas: () => canvas,
      state: () => (${JSON.stringify({ ...state, presentation: undefined })}),
      visible: () => true,
      painted: () => { painted = true; },
      acknowledge: () => {
        painter.close();
        resolve({ painted, width: canvas.width, height: canvas.height });
      },
    });
    painter.draw({
      ...${JSON.stringify({ ...mirroredFrame, data: undefined })},
      data: Uint8Array.from(atob(${JSON.stringify(Buffer.from(mirroredFrame.data).toString("base64"))}), c => c.charCodeAt(0)),
    });
  })`);
  assert.deepEqual(painted, {
    painted: true,
    width: Math.round(320 * physical.dpr),
    height: Math.round(200 * physical.dpr),
  });
  mirrored.close();
  const secondWindow = new BrowserWindow({ show: true, width: 800, height: 600 });
  const secondPresenter = runtime.createPresenter(secondWindow);
  secondPresenter.layout({ x: 0, y: 0, width: 600, height: 400 });
  let secondState;
  const secondWatch = await browser.watch(
    scope,
    randomUUID(),
    (event) => {
      if (event.kind === "state") secondState = event.state;
    },
    secondPresenter,
  );
  assert.ok(window.contentView.children.includes(page));
  secondWatch.input({ tabId: null, viewId: null, input: { kind: "take-control" } });
  assert.ok(
    secondWindow.contentView.children.includes(page),
    "The controller must own the native page",
  );
  assert.equal(state.presentation, undefined, "Other viewers must fall back to frames");
  watch.input({ tabId: null, viewId: null, input: { kind: "take-control" } });
  assert.ok(window.contentView.children.includes(page));
  assert.equal(secondState.presentation, undefined);
  secondWatch.input({ tabId: null, viewId: null, input: { kind: "take-control" } });
  secondWindow.destroy();
  assert.equal(
    page.webContents.isDestroyed(),
    false,
    "Closing a viewer window must preserve the shared browser session",
  );
  watch.input({ tabId: null, viewId: null, input: { kind: "take-control" } });
  assert.ok(window.contentView.children.includes(page));
  secondWatch.close();
  secondPresenter.close();
  if (!secondWindow.isDestroyed()) secondWindow.destroy();
  assert.ok(
    window.contentView.children.includes(page),
    "Closing the former presenter must not detach the controller's page",
  );
  presenter.layout({
    x: 100,
    y: 100,
    width: 500,
    height: 350,
    zoom: 0.5,
    viewport: { width: 1000, height: 700 },
  });
  await until(() => Math.abs(state.tabs[0].width - 1000) <= 1);
  presenter.layout({
    x: 100,
    y: 100,
    width: 500,
    height: 350,
    zoom: 0.5,
    viewport: { width: 1000, height: 700 },
    occluded: true,
  });
  await until(() => posterCount === 1);
  presenter.layout({
    x: 100,
    y: 100,
    width: 500,
    height: 350,
    zoom: 0.5,
    viewport: { width: 1000, height: 700 },
    occluded: true,
  });
  await tick(30);
  assert.equal(posterCount, 1);
  presenter.layout({ x: 100, y: 100, width: 600, height: 500 });
  await tick(30);
  watch.input({ tabId: null, viewId: null, input: { kind: "release-control" } });
  await browser.command(scope, { kind: "click", tabId, selector: "#download" });
  await until(() => state.downloads.some((d) => d.status === "ready"));
  assert.equal(state.downloads[0].size, 15);
  await browser.command(scope, { kind: "click", tabId, selector: "#file" });
  await until(() => state.fileChooser);
  assert.equal(state.fileChooser.multiple, false);
  await browser.command(scope, {
    kind: "upload",
    tabId,
    chooserId: state.fileChooser.id,
    files: [{ name: "fixture.txt", data: Buffer.from("upload").toString("base64") }],
  });
  await browser.command(scope, { kind: "click", tabId, selector: "#popup" });
  await until(() => state.tabs.length === 2);
  assert.match(state.tabs[1].url, /next/);
  await browser.command(scope, { kind: "close", tabId: state.activeTabId });
  assert.equal(state.activeTabId, tabId);
  assert.ok(
    window.contentView.children.includes(page),
    "Closing the active popup must restore the original native tab",
  );
  const isolatedScope = { ...scope, threadId: randomUUID() };
  await browser.command(scope, {
    kind: "evaluate",
    tabId,
    expression: "document.cookie='preview_scope=one'",
  });
  const isolated = await browser.command(isolatedScope, {
    kind: "open",
    url: "http://127.0.0.1:" + server.address().port,
  });
  assert.equal(
    (
      await browser.command(isolatedScope, {
        kind: "evaluate",
        tabId: isolated.state.activeTabId,
        expression: "document.cookie",
      })
    ).output,
    '""',
  );
  const automation = await runtime.get();
  const automationPage = (await automation.pages()).find(
    (p) => p.url() === page.webContents.getURL(),
  );
  assert.ok(automationPage);
  const pageSession = await automationPage.createCDPSession();
  window.webContents.debugger.attach("1.3");
  const { targetInfo: trustedTarget } =
    await window.webContents.debugger.sendCommand("Target.getTargetInfo");
  window.webContents.debugger.detach();
  const forbiddenTargets = [trustedTarget.targetId, isolated.state.tabs[0].nativeTargetId];
  const browserSession = await automation.target().createCDPSession();
  const { browserContextIds } = await browserSession.send("Target.getBrowserContexts");
  for (const method of ["Target.attachToBrowserTarget", "Browser.crash"])
    await assert.rejects(
      browserSession.send(method, { browserContextId: browserContextIds[0] }),
      /Unsupported native browser command/,
    );
  const rootTargets = await browserSession.send("Target.getTargets");
  assert.ok(!rootTargets.targetInfos.some((target) => target.targetId === trustedTarget.targetId));
  await browserSession.detach();
  const discovered = await pageSession.send("Target.getTargets");
  for (const targetId of forbiddenTargets) {
    assert.ok(!discovered.targetInfos.some((target) => target.targetId === targetId));
    await assert.rejects(
      pageSession.send("Target.getTargetInfo", { targetId }),
      /Unknown native browser target/,
    );
    await assert.rejects(
      pageSession.send("Target.attachToTarget", { targetId, flatten: true }),
      /Unknown native browser target/,
    );
  }
  for (const method of [
    "Target.attachToBrowserTarget",
    "Target.autoAttachRelated",
    "Target.sendMessageToTarget",
    "Browser.crash",
  ])
    await assert.rejects(pageSession.send(method, {}), /Unsupported native browser command/);
  await automationPage.evaluate(() => {
    window.previewWorker = new Worker(
      URL.createObjectURL(
        new Blob(["self.onmessage = event => postMessage(event.data + 1)"], {
          type: "text/javascript",
        }),
      ),
    );
    const iframe = document.createElement("iframe");
    iframe.src = new URL("/frame", location.href).href;
    document.body.append(iframe);
  });
  await until(
    () =>
      automationPage.workers().length &&
      automationPage.frames().some((frame) => frame.url().endsWith("/frame")),
  );
  const workerSession = automationPage.workers()[0].client;
  assert.ok(workerSession);
  assert.equal(
    (await workerSession.send("Runtime.evaluate", { expression: "6 * 7", returnByValue: true }))
      .result.value,
    42,
  );
  for (const targetId of forbiddenTargets)
    await assert.rejects(
      workerSession.send("Target.attachToTarget", { targetId, flatten: true }),
      /Unknown native browser target/,
    );
  const iframe = automationPage.frames().find((frame) => frame.url().endsWith("/frame"));
  assert.equal(await iframe.evaluate(() => document.title), "Native service");
  await automationPage.evaluate(() => {
    window.previewWorker.terminate();
    document.querySelector("iframe").remove();
  });
  await pageSession.detach();
  await browser.command(scope, {
    kind: "evaluate",
    tabId,
    expression: "location.href='file:///etc/passwd'",
  });
  await tick(50);
  assert.match((await browser.state(scope)).tabs[0].url, /^http:/);
  presenter.layout(null);
  assert.equal(
    window.contentView.children.filter((v) => v.webContents?.getURL().startsWith("http:")).length,
    0,
  );
  presenter.layout({ x: 10, y: 10, width: 640, height: 480 });
  await tick(50);
  assert.equal(
    window.contentView.children.filter((v) => v.webContents?.getURL().startsWith("http:")).length,
    1,
  );
  assert.equal(frames, 0);
  watch.close();
  await browser.close();
  window.destroy();
  const layoutBundle = join(dir, "native-layout.js");
  execFileSync(
    "bun",
    [
      "build",
      join(root, "src/renderer/src/app/fixtures/native-browser.tsx"),
      "--target=browser",
      "--format=esm",
      "--outfile=" + layoutBundle,
    ],
    { stdio: "pipe" },
  );
  const layoutHTML = join(dir, "native-layout.html");
  await writeFile(
    layoutHTML,
    '<!doctype html><style>body{margin:0}</style><div id="root"></div><script type="module" src="./native-layout.js"></script>',
  );
  const layoutWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  cleanups.push(() => {
    if (!layoutWindow.isDestroyed()) layoutWindow.destroy();
  });
  layoutWindow.showInactive();
  await layoutWindow.loadFile(layoutHTML);
  let layoutResult;
  for (let i = 0; i < 250; i++) {
    layoutResult = await layoutWindow.webContents.executeJavaScript("window.nativeLayoutTest");
    if (layoutResult) break;
    await tick(20);
  }
  assert.equal(
    layoutResult?.passed,
    true,
    layoutResult?.message ?? "Native layout fixture timed out",
  );
  layoutWindow.destroy();
  const bridge = new NativeBrowserRuntime();
  process.env.TIDY_HOST_STATE = dir;
  const stopBridge = await serveNativeBrowser(bridge, dir);
  let bridgeStopped = false;
  cleanups.push(async () => {
    if (!bridgeStopped) {
      bridgeStopped = true;
      await stopBridge();
    }
  });
  const descriptor = JSON.parse(await readFile(join(dir, "native-browser.json"), "utf8"));
  assert.equal((await stat(join(dir, "native-browser.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(descriptor.socket)).mode & 0o777, 0o600);
  const rejected = async (headers) => {
    const socket = new WebSocket(`ws+unix://${descriptor.socket}:/cdp`, {
      headers,
      handshakeTimeout: 1000,
    });
    const opened = await new Promise((r) => {
      socket.once("open", () => r(true));
      socket.once("error", () => r(false));
    });
    socket.terminate();
    assert.equal(opened, false);
  };
  await rejected({ Authorization: "Bearer invalid" });
  await rejected({ Authorization: `Bearer ${descriptor.token}`, Origin: "http://untrusted.local" });
  const connection = await connectNativeBrowser();
  assert.ok(connection);
  const context = await connection.createBrowserContext(),
    shared = await context.newPage();
  await shared.goto("http://127.0.0.1:" + server.address().port);
  await shared.locator("#name").fill("private connection");
  const targetSession = await shared.createCDPSession();
  const { targetInfo } = await targetSession.send("Target.getTargetInfo");
  await targetSession.detach();
  const target = webContents.fromDevToolsTargetId(targetInfo.targetId);
  assert.ok(target);
  assert.equal(
    await target.executeJavaScript('document.querySelector("#name").value'),
    "private connection",
  );
  connection.disconnect();
  await tick(100);
  const reconnected = await connectNativeBrowser();
  assert.ok(reconnected);
  assert.equal((await reconnected.pages()).length, 0);
  reconnected.disconnect();
  await tick(50);
  const surviving = new BrowserService(async () => {});
  surviving.useNativeConnection(dir);
  cleanups.push(() => surviving.close());
  let survivingState,
    survivingFrames = 0;
  const survivingWatch = await surviving.watch(
    scope,
    randomUUID(),
    (event) => {
      if (event.kind === "state") survivingState = event.state;
      if (event.kind === "frame") survivingFrames++;
    },
    { update: () => {}, close: () => {} },
  );
  const survivingOpen = await surviving.command(scope, {
    kind: "open",
    url: "http://127.0.0.1:" + server.address().port,
  });
  assert.equal(survivingState.presentation, "native");
  assert.ok(survivingOpen.state.tabs[0].nativeTargetId);
  assert.equal(survivingFrames, 0);
  const streams = new WebSocketServer({ server, path: "/native-stream-test" });
  streams.on("connection", (socket) => {
    void serveBrowserStream({
      socket,
      browser: surviving,
      scope,
      viewerId: randomUUID(),
      native: true,
      authorized: async () => true,
    });
  });
  const streamed = new WebSocket(`ws://127.0.0.1:${server.address().port}/native-stream-test`);
  let streamState,
    pixels = 0;
  streamed.on("message", (data, binary) => {
    if (binary) pixels++;
    else {
      const event = JSON.parse(data.toString());
      if (event.kind === "state") streamState = event.state;
    }
  });
  await until(() => streamState?.presentation === "native");
  assert.equal(streamState.nativePresentationControl, true);
  assert.equal(pixels, 0);
  streamed.send(
    JSON.stringify({
      tabId: null,
      viewId: null,
      input: { kind: "native-presentation", enabled: false },
    }),
  );
  await until(() => pixels > 0);
  assert.equal(streamState.presentation, undefined);
  assert.equal(streamState.control, "available");
  streamed.send(
    JSON.stringify({
      tabId: null,
      viewId: null,
      input: { kind: "native-presentation", enabled: true },
    }),
  );
  await until(() => streamState.presentation === "native");
  const stoppedAt = pixels;
  await tick(50);
  assert.equal(pixels, stoppedAt);
  await new Promise((resolve) => {
    streamed.once("close", resolve);
    streamed.close();
  });
  await new Promise((resolve) => streams.close(resolve));
  survivingWatch.close();
  await surviving.close();
  await tick(50);
  bridgeStopped = true;
  await stopBridge();
  server.closeAllConnections();
  server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(
    "Native browser smoke passed: shared automation, direct input, Retina, control, isolation, downloads, uploads, popups, view lifecycle, overlay posters, renderer layout/occlusion, and private backend reconnection.",
  );
})()
  .then(async () => {
    clearTimeout(deadline);
    for (const cleanup of cleanups.reverse()) await cleanup();
    app.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    clearTimeout(deadline);
    for (const cleanup of cleanups.reverse())
      await Promise.resolve()
        .then(cleanup)
        .catch(() => {});
    app.exit(1);
  });
