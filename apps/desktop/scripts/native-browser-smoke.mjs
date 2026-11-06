import { app, BrowserWindow, session } from "electron";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket } from "ws";
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
    `export {NativeBrowserRuntime} from ${JSON.stringify(join(root, "src/main/browser/native-runtime.ts"))};\nexport {BrowserService} from ${JSON.stringify(join(root, "src/main/browser/browser-service.ts"))};\nexport {serveNativeBrowser} from ${JSON.stringify(join(root, "src/main/browser/native-broker.ts"))};\nexport {connectNativeBrowser} from ${JSON.stringify(join(root, "src/main/browser/native-connection.ts"))};`,
  );
  execFileSync(
    "bun",
    ["build", entry, "--target=node", "--format=esm", "--external=electron", "--outfile=" + bundle],
    { stdio: "pipe" },
  );
  const { NativeBrowserRuntime, BrowserService, serveNativeBrowser, connectNativeBrowser } =
    await import(pathToFileURL(bundle).href);
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
  presenter.layout({ x: 100, y: 100, width: 500, height: 350, zoom: 0.5 });
  await until(() => Math.abs(state.tabs[0].width - 1000) <= 1);
  presenter.layout({ x: 100, y: 100, width: 500, height: 350, zoom: 0.5, occluded: true });
  await until(() => posterCount === 1);
  presenter.layout({ x: 100, y: 100, width: 500, height: 350, zoom: 0.5, occluded: true });
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
  const target = await bridge.page(shared);
  assert.ok(target);
  assert.equal(
    await target.view.webContents.executeJavaScript('document.querySelector("#name").value'),
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
  survivingWatch.close();
  await surviving.close();
  await tick(50);
  bridgeStopped = true;
  await stopBridge();
  server.closeAllConnections();
  server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(
    "Native browser smoke passed: shared automation, direct input, Retina, control, isolation, downloads, uploads, popups, view lifecycle, overlay posters, and private backend reconnection.",
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
