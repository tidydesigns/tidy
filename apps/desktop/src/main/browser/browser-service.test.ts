import { afterEach, test } from "node:test";
import { z } from "zod";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../workspace/project-store";
import { WorkspaceService } from "../workspace/workspace-service";
import { randomUUID } from "node:crypto";
import { BrowserService } from "./browser-service";
import { browserEditingCommand } from "../../renderer/src/features/browser/browser-keyboard";
import { BrowserAgentBridge } from "./agent-bridge";
import {
  emptyBrowserState,
  type BrowserOutput,
  type BrowserState,
  type BrowserInputEnvelope,
  type BrowserScope,
} from "../../shared/contracts/browser";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const browserTest = (name: string, run: () => Promise<void>, timeout = 30000) =>
  test(name, { skip: Boolean(process.versions.bun), timeout }, run);

async function fixture(authorize = async () => {}) {
  const server = createServer((request, response) => {
    if (request.url === "/slow") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.write("<!doctype html><title>Loading</title>");
      return;
    }
    if (request.url === "/download") {
      response.setHeader("Content-Disposition", 'attachment; filename="fixture.txt"');
      response.end("Downloaded on host");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>${request.url === "/next" ? "Second page" : "Browser fixture"}</title><style>body{font:18px sans-serif;margin:32px}input{display:block;margin:12px 0}button{padding:12px}</style><h1>Browser fixture</h1><input id="file" type="file"><a id="download" href="/download">Download</a><label>Name<input id="name"></label><button id="submit" onclick="document.querySelector('h1').textContent=document.querySelector('#name').value">Apply</button><a href="/next">Next page</a><button id="popup" onclick="window.open('/next')">Popup</button><script>console.info('fixture ready')</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address.");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const projectId = randomUUID();
  const scope = { projectId, threadId: randomUUID() };
  const browser = new BrowserService(async (input) => {
    await authorize();
    if (input.projectId !== projectId) throw new Error("Project access denied.");
  });
  cleanups.push(() => browser.close());
  return { browser, scope, url: `http://127.0.0.1:${address.port}` };
}

async function watchBrowser({
  browser,
  scope,
  id,
  receive,
}: {
  browser: BrowserService;
  scope: BrowserScope;
  id: string;
  receive(event: BrowserOutput): void;
}) {
  let state: BrowserState = emptyBrowserState;
  const viewer = await browser.watch(scope, id, (event) => {
    if (event.kind === "state") state = event.state;
    receive(event);
  });
  return {
    close: viewer.close,
    input: ({
      viewId,
      ...input
    }: Omit<BrowserInputEnvelope, "viewId"> & Partial<Pick<BrowserInputEnvelope, "viewId">>) =>
      viewer.input({
        ...input,
        viewId:
          viewId === undefined
            ? (state.tabs.find((tab) => tab.id === input.tabId)?.viewId ?? null)
            : viewId,
      }),
  };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Browser condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

browserTest(
  "real browser navigation, input, isolation, console and screenshot",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No browser tab.");
    await browser.command(scope, { kind: "fill", tabId, selector: "#name", text: "Tested live" });
    await browser.command(scope, { kind: "click", tabId, selector: "#submit" });
    assert.equal(
      (
        await browser.command(scope, {
          kind: "evaluate",
          tabId,
          expression: "document.querySelector('h1').textContent",
        })
      ).output,
      '"Tested live"',
    );
    assert.ok(
      (await browser.command(scope, { kind: "console", tabId })).output?.includes("fixture ready"),
    );
    const screenshot = (await browser.command(scope, { kind: "screenshot", tabId })).output;
    assert.equal(
      screenshot && Buffer.from(screenshot, "base64").subarray(0, 2).toString("hex"),
      "ffd8",
    );
    assert.ok(
      (await browser.command(scope, { kind: "snapshot", tabId })).output?.includes(
        "Browser fixture",
      ),
    );
    await assert.rejects(
      browser.command({ ...scope, threadId: randomUUID() }, { kind: "snapshot", tabId }),
      new RegExp("no longer open"),
    );
    await assert.rejects(
      browser.command({ ...scope, projectId: randomUUID() }, { kind: "open", url }),
      new RegExp("denied"),
    );
    await assert.rejects(
      browser.command(scope, { kind: "navigate", tabId, url: "file:///etc/passwd" }),
    );
    await browser.command(scope, { kind: "navigate", tabId, url: `${url}/next` });
    assert.equal(
      (await browser.command(scope, { kind: "evaluate", tabId, expression: "document.title" }))
        .output,
      '"Second page"',
    );
    await browser.command(scope, { kind: "back", tabId });
    assert.equal(
      (await browser.command(scope, { kind: "evaluate", tabId, expression: "document.title" }))
        .output,
      '"Browser fixture"',
    );
    await browser.command(scope, { kind: "close", tabId });
    assert.equal((await browser.state(scope)).tabs.length, 0);
  },
  180000,
);

browserTest(
  "viewer backpressure, control handoff, resize and reconnect retain the host tab",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No browser tab.");
    const events: BrowserOutput[] = [];
    const viewerId = randomUUID();
    const viewer = await watchBrowser({
      browser,
      scope,
      id: viewerId,
      receive: (event) => events.push(event),
    });
    await until(() => events.some((event) => event.kind === "frame"));
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression:
        "window.paintTimer=setInterval(()=>document.body.style.background=`rgb(${Math.random()*255},0,0)`,20)",
    });
    await until(() => events.filter((event) => event.kind === "frame").length === 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(events.filter((event) => event.kind === "frame").length, 3);
    const first = events.find((event) => event.kind === "frame");
    if (!first || first.kind !== "frame") throw new Error("No frame.");
    viewer.input({ tabId, input: { kind: "ack", frameId: first.frameId } });
    await until(() => events.filter((event) => event.kind === "frame").length === 4);
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression: "clearInterval(window.paintTimer)",
    });
    viewer.input({ tabId, input: { kind: "take-control" } });
    assert.equal((await browser.state(scope, viewerId)).control, "you");
    await assert.rejects(
      browser.command(scope, { kind: "evaluate", tabId, expression: "1+1" }),
      new RegExp("viewer has control"),
    );
    viewer.input({ tabId, input: { kind: "resize", width: 390, height: 844 } });
    await until(() =>
      events.some((event) => event.kind === "state" && event.state.tabs[0]?.width === 390),
    );
    viewer.input({ tabId, input: { kind: "visibility", visible: false } });
    assert.equal((await browser.state(scope)).control, "available");
    viewer.close();
    const nextEvents: BrowserOutput[] = [];
    const nextViewerId = randomUUID();
    const next = await watchBrowser({
      browser,
      scope,
      id: nextViewerId,
      receive: (event) => nextEvents.push(event),
    });
    await until(() => nextEvents.some((event) => event.kind === "frame"));
    assert.equal((await browser.state(scope)).activeTabId, tabId);
    const reconnectedFrame = nextEvents.find((event) => event.kind === "frame");
    assert.equal(
      reconnectedFrame &&
        reconnectedFrame.kind === "frame" &&
        reconnectedFrame.frameId > first.frameId,
      true,
    );
    next.input({ tabId, input: { kind: "take-control" } });
    await browser.command(scope, { kind: "close", tabId }, { actor: nextViewerId });
    assert.equal((await browser.state(scope)).control, "available");
    next.close();
  },
  30000,
);

browserTest(
  "agent bridge is scoped, rejects origins and revokes access at the end of a run",
  async () => {
    const permission = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let delayed = false;
    const { browser, scope } = await fixture(async () => {
      if (delayed) {
        started.resolve();
        await permission.promise;
      }
    });
    const bridge = new BrowserAgentBridge(browser);
    cleanups.push(() => bridge.close());
    const session = await bridge.session(scope);
    const configuration = await readFile(session.configuration, "utf8");
    const endpoint = configuration.match(/^url = "([^"]+)"/m)?.[1];
    const token = configuration.match(/Bearer ([a-f0-9]{64})/)?.[1];
    assert.ok(endpoint && token);
    if (process.platform !== "win32")
      assert.equal((await stat(session.configuration)).mode & 0o777, 0o600);
    assert.ok(!session.instructions.includes(token));
    const run = promisify(execFile);
    const state = await run("curl", [
      "--silent",
      "--fail",
      "--config",
      session.configuration,
      "--data",
      '{"kind":"state"}',
    ]);
    assert.equal(JSON.parse(state.stdout).state.phase.kind, "idle");
    const request = (headers: Record<string, string>) =>
      fetch(endpoint, { method: "POST", headers, body: '{"kind":"state"}' });
    assert.equal((await request({})).status, 403);
    assert.equal(
      (await request({ Authorization: `Bearer ${token}`, Origin: "https://example.com" })).status,
      403,
    );
    assert.equal((await request({ Authorization: `Bearer ${token}` })).status, 200);
    delayed = true;
    const opening = fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "open", url: "about:blank" }),
    });
    await started.promise;
    session.close();
    delayed = false;
    permission.resolve();
    assert.equal((await opening).status, 400);
    assert.equal((await browser.state(scope)).tabs.length, 0);
    assert.equal((await request({ Authorization: `Bearer ${token}` })).status, 403);
    const next = await bridge.session(scope);
    const continued = await run("curl", [
      "--silent",
      "--fail",
      "--config",
      next.configuration,
      "--data",
      '{"kind":"state"}',
    ]);
    assert.equal(JSON.parse(continued.stdout).state.phase.kind, "idle");
    assert.notEqual(next.configuration, session.configuration);
    await bridge.close();
    await assert.rejects(access(next.configuration));
  },
  30000,
);

browserTest(
  "local file selection and remote downloads stay scoped to their tab",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    await browser.command(scope, { kind: "click", tabId, selector: "#file" });
    let chooser = (await browser.state(scope)).fileChooser;
    await until(async () => Boolean((await browser.state(scope)).fileChooser));
    chooser = (await browser.state(scope)).fileChooser;
    if (!chooser) throw new Error("No file picker.");
    await assert.rejects(
      browser.command(scope, {
        kind: "upload",
        tabId,
        chooserId: chooser.id,
        files: [{ name: "..", data: Buffer.from("invalid").toString("base64") }],
      }),
      /Invalid file name/,
    );
    await browser.command(scope, {
      kind: "upload",
      tabId,
      chooserId: chooser.id,
      files: [{ name: "uploaded.txt", data: Buffer.from("Selected on viewer").toString("base64") }],
    });
    assert.equal(
      (
        await browser.command(scope, {
          kind: "evaluate",
          tabId,
          expression: "document.querySelector('#file').files[0].text()",
        })
      ).output,
      '"Selected on viewer"',
    );
    await browser.command(scope, { kind: "click", tabId, selector: "#download" });
    let download = (await browser.state(scope)).downloads.find((item) => item.status === "ready");
    const deadline = Date.now() + 10000;
    while (!download) {
      if (Date.now() > deadline) throw new Error("Download timed out.");
      await new Promise((resolve) => setTimeout(resolve, 20));
      download = (await browser.state(scope)).downloads.find((item) => item.status === "ready");
    }
    const result = await browser.command(scope, {
      kind: "download",
      tabId,
      downloadId: download.id,
    });
    assert.equal(Buffer.from(result.output ?? "", "base64").toString(), "Downloaded on host");
    await browser.command(scope, { kind: "close", tabId });
    assert.equal((await browser.state(scope)).downloads.length, 0);
  },
  30000,
);

browserTest(
  "taking control cancels a waiting agent action before a later element can be clicked",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    const viewerId = randomUUID();
    const viewer = await watchBrowser({ browser, scope, id: viewerId, receive: () => {} });
    const clicking = browser.command(scope, { kind: "click", tabId, selector: "#appears-later" });
    await until(async () => (await browser.state(scope)).control === "agent");
    viewer.input({ tabId, input: { kind: "take-control" } });
    await assert.rejects(clicking);
    await browser.command(
      scope,
      {
        kind: "evaluate",
        tabId,
        expression:
          "window.wasClicked=false;const button=document.createElement('button');button.id='appears-later';button.onclick=()=>{window.wasClicked=true};document.body.append(button)",
      },
      { actor: viewerId },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      (
        await browser.command(
          scope,
          { kind: "evaluate", tabId, expression: "window.wasClicked" },
          { actor: viewerId },
        )
      ).output,
      "false",
    );
    viewer.close();
  },
  30000,
);

browserTest(
  "popups share their thread context without sharing storage with another thread",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression: "localStorage.setItem('thread-storage','private')",
    });
    await browser.command(scope, { kind: "click", tabId, selector: "#popup" });
    await until(async () => (await browser.state(scope)).tabs.length === 2);
    const popupId = (await browser.state(scope)).activeTabId;
    if (!popupId) throw new Error("No popup.");
    assert.equal(
      (
        await browser.command(scope, {
          kind: "evaluate",
          tabId: popupId,
          expression: "localStorage.getItem('thread-storage')",
        })
      ).output,
      '"private"',
    );
    const otherScope = { ...scope, threadId: randomUUID() };
    const other = await browser.command(otherScope, { kind: "open", url });
    if (!other.state.activeTabId) throw new Error("No isolated tab.");
    assert.equal(
      (
        await browser.command(otherScope, {
          kind: "evaluate",
          tabId: other.state.activeTabId,
          expression: "localStorage.getItem('thread-storage')",
        })
      ).output,
      "null",
    );
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression: "(()=>{for(let i=0;i<16;i++)window.open('/next');return true})()",
    });
    await until(async () => (await browser.state(scope)).tabs.length === 12);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await browser.state(scope)).tabs.length, 12);
  },
  30000,
);

browserTest(
  "selecting an older tab keeps its live stream updating",
  async () => {
    const { browser, scope, url } = await fixture();
    const first = await browser.command(scope, { kind: "open", url });
    const tabId = first.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    await browser.command(scope, { kind: "open", url: `${url}/next` });
    await browser.command(scope, { kind: "select", tabId });
    let frames = 0;
    const viewer = await watchBrowser({
      browser,
      scope,
      id: randomUUID(),
      receive: (event) => {
        if (event.kind !== "frame") return;
        assert.equal(event.tabId, tabId);
        frames++;
      },
    });
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression:
        "window.paintTimer=setInterval(()=>document.body.style.background=`rgb(${Math.random()*255},0,0)`,30)",
    });
    await until(() => frames === 3);
    viewer.close();
  },
  30000,
);

browserTest(
  "delayed input for another tab cannot type into the newly selected page",
  async () => {
    const { browser, scope, url } = await fixture();
    const first = await browser.command(scope, { kind: "open", url });
    const second = await browser.command(scope, { kind: "open", url });
    const oldTabId = first.state.activeTabId,
      tabId = second.state.activeTabId;
    if (!oldTabId || !tabId) throw new Error("No tabs.");
    const viewerId = randomUUID();
    const viewer = await watchBrowser({ browser, scope, id: viewerId, receive: () => {} });
    viewer.input({ tabId, input: { kind: "take-control" } });
    await browser.command(
      scope,
      { kind: "evaluate", tabId, expression: "document.querySelector('#name').focus()" },
      { actor: viewerId },
    );
    viewer.input({ tabId: oldTabId, input: { kind: "text", text: "wrong" } });
    viewer.input({ tabId, input: { kind: "text", text: "right" } });
    await until(
      async () =>
        (await browser.command(scope, { kind: "snapshot", tabId })).output?.includes("right") ??
        false,
    );
    assert.equal(
      (
        await browser.command(
          scope,
          { kind: "evaluate", tabId, expression: "document.querySelector('#name').value" },
          { actor: viewerId },
        )
      ).output,
      '"right"',
    );
    viewer.close();
  },
  30000,
);

browserTest(
  "input waiting on authorization expires when control is released and retaken",
  async () => {
    const permission = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let delayed = false;
    const { browser, scope, url } = await fixture(async () => {
      if (delayed) {
        started.resolve();
        await permission.promise;
      }
    });
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression: "document.querySelector('#name').focus()",
    });
    const viewerId = randomUUID();
    const viewer = await watchBrowser({ browser, scope, id: viewerId, receive: () => {} });
    viewer.input({ tabId, input: { kind: "take-control" } });
    delayed = true;
    viewer.input({ tabId, input: { kind: "text", text: "stale" } });
    await started.promise;
    viewer.input({ tabId, input: { kind: "release-control" } });
    viewer.input({ tabId, input: { kind: "take-control" } });
    delayed = false;
    permission.resolve();
    viewer.input({ tabId, input: { kind: "text", text: "fresh" } });
    let value: string | undefined;
    await until(async () => {
      value = (
        await browser.command(
          scope,
          { kind: "evaluate", tabId, expression: "document.querySelector('#name').value" },
          { actor: viewerId },
        )
      ).output;
      return Boolean(value?.includes("fresh"));
    });
    assert.equal(value, '"fresh"');
    viewer.close();
  },
  30000,
);

browserTest(
  "slow viewers, screenshots and rapid resizes preserve bounded, current frames",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression:
        "window.paintTimer=setInterval(()=>document.body.style.background=`rgb(${Math.random()*255},0,0)`,30)",
    });
    let firstFrames = 0,
      secondFrames = 0;
    const streamErrors: string[] = [];
    const first = await watchBrowser({
      browser,
      scope,
      id: randomUUID(),
      receive: (event) => {
        if (event.kind === "error") streamErrors.push(event.message);
        if (event.kind !== "frame") return;
        firstFrames++;
      },
    });
    const secondId = randomUUID();
    let lastFrame: Uint8Array | undefined;
    const second: Awaited<ReturnType<typeof watchBrowser>> = await watchBrowser({
      browser,
      scope,
      id: secondId,
      receive: (event) => {
        if (event.kind === "error") streamErrors.push(event.message);
        if (event.kind !== "frame") return;
        secondFrames++;
        lastFrame = event.data;
        setTimeout(
          () => second.input({ tabId, input: { kind: "ack", frameId: event.frameId } }),
          0,
        );
      },
    });
    await until(() => firstFrames === 3 && secondFrames >= 5).catch((error) => {
      throw new Error(JSON.stringify({ firstFrames, secondFrames, streamErrors }), {
        cause: error,
      });
    });
    assert.equal(firstFrames, 3);
    first.input({ tabId, input: { kind: "visibility", visible: false } });
    const beforeHide = secondFrames;
    await until(() => secondFrames >= beforeHide + 5);
    const beforeScreenshot = secondFrames;
    const screenshot = await browser.command(scope, { kind: "screenshot", tabId });
    assert.equal(
      Buffer.from(screenshot.output ?? "", "base64")
        .subarray(0, 2)
        .toString("hex"),
      "ffd8",
    );
    await until(() => secondFrames >= beforeScreenshot + 5);
    first.close();
    const beforeClose = secondFrames;
    await until(() => secondFrames >= beforeClose + 5);
    second.input({ tabId, input: { kind: "take-control" } });
    const concurrentScreenshot = browser.command(scope, { kind: "screenshot", tabId });
    second.input({ tabId, input: { kind: "resize", width: 640, height: 480 } });
    second.input({ tabId, input: { kind: "resize", width: 800, height: 600 } });
    await concurrentScreenshot;
    await until(async () => (await browser.state(scope)).tabs[0]?.width === 800);
    const beforeResize = secondFrames;
    await until(() => secondFrames >= beforeResize + 3);
    assert.ok(lastFrame);
    assert.equal(
      (
        await browser.command(
          scope,
          {
            kind: "evaluate",
            tabId,
            expression: `fetch("data:image/jpeg;base64,${Buffer.from(lastFrame).toString("base64")}").then(r=>r.blob()).then(createImageBitmap).then(bitmap=>{const dimensions=[bitmap.width,bitmap.height,innerWidth,innerHeight];bitmap.close();return dimensions})`,
          },
          { actor: secondId },
        )
      ).output,
      "[800,600,800,600]",
    );
    second.close();
  },
  30000,
);

browserTest(
  "find selects matching text on the host and reports missing text",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    if (!tabId) throw new Error("No tab.");
    assert.equal(
      (
        await browser.command(scope, {
          kind: "find",
          tabId,
          text: "Browser fixture",
          backwards: false,
        })
      ).output,
      "true",
    );
    assert.equal(
      (
        await browser.command(scope, {
          kind: "evaluate",
          tabId,
          expression: "window.getSelection().toString()",
        })
      ).output,
      '"Browser fixture"',
    );
    assert.equal(
      (await browser.command(scope, { kind: "find", tabId, text: "No such text", backwards: true }))
        .output,
      "false",
    );
  },
  30000,
);

browserTest(
  "input-triggered dialogs do not deadlock and stale answers cannot accept a follow-up prompt",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    assert.ok(tabId);
    const actor = randomUUID();
    const viewer = await watchBrowser({ browser, scope, id: actor, receive: () => {} });
    viewer.input({ tabId, input: { kind: "take-control" } });
    await browser.command(
      scope,
      {
        kind: "evaluate",
        tabId,
        expression:
          "document.querySelector('#name').focus();document.querySelector('#name').oninput=()=>{window.promptResults=[prompt('First','Default'),prompt('Second','Default')]}",
      },
      { actor },
    );
    viewer.input({ tabId, input: { kind: "text", text: "Trigger prompt" } });
    await until(async () => Boolean((await browser.state(scope)).dialog));
    const first = (await browser.state(scope)).dialog;
    assert.ok(first);
    viewer.input({ tabId, input: { kind: "dialog", dialogId: first.id, accept: true, text: "" } });
    await until(async () => {
      const dialog = (await browser.state(scope)).dialog;
      return Boolean(dialog && dialog.id !== first.id);
    });
    const second = (await browser.state(scope)).dialog;
    assert.ok(second);
    viewer.input({
      tabId,
      input: { kind: "dialog", dialogId: first.id, accept: true, text: "stale" },
    });
    viewer.input({
      tabId,
      input: { kind: "dialog", dialogId: second.id, accept: true, text: "fresh" },
    });
    await until(async () => !(await browser.state(scope)).dialog);
    assert.equal(
      (
        await browser.command(
          scope,
          { kind: "evaluate", tabId, expression: "window.promptResults" },
          { actor },
        )
      ).output,
      '["","fresh"]',
    );
    viewer.close();
  },
  30000,
);

browserTest(
  "input from a previous view cannot type after navigation, resizing, or a client-side route change",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    const viewId = opened.state.tabs[0]?.viewId;
    assert.ok(tabId && viewId);
    const actor = randomUUID();
    const viewer = await watchBrowser({ browser, scope, id: actor, receive() {} });
    viewer.input({ tabId, input: { kind: "take-control" } });
    await browser.command(scope, { kind: "navigate", tabId, url: `${url}/next` }, { actor });
    assert.notEqual((await browser.state(scope)).tabs[0]?.viewId, viewId);
    await browser.command(
      scope,
      { kind: "evaluate", tabId, expression: "document.querySelector('#name').focus()" },
      { actor },
    );
    viewer.input({ tabId, viewId, input: { kind: "text", text: "stale" } });
    viewer.input({ tabId, input: { kind: "text", text: "fresh" } });
    let value: string | undefined;
    await until(async () => {
      value = (
        await browser.command(
          scope,
          { kind: "evaluate", tabId, expression: "document.querySelector('#name').value" },
          { actor },
        )
      ).output;
      return Boolean(value?.includes("fresh"));
    });
    assert.equal(value, '"fresh"');
    for (const change of ["resize", "route"] as const) {
      const oldView = (await browser.state(scope)).tabs[0]?.viewId;
      assert.ok(oldView);
      await browser.command(
        scope,
        {
          kind: "evaluate",
          tabId,
          expression:
            "window.shiftHeld=false;window.shiftReleased=false;document.onkeydown=e=>{if(e.key==='Shift')window.shiftHeld=true};document.onkeyup=e=>{if(e.key==='Shift')window.shiftReleased=true}",
        },
        { actor },
      );
      viewer.input({
        tabId,
        input: {
          kind: "key",
          action: "down",
          key: "Shift",
          code: "ShiftLeft",
          keyCode: 16,
          text: "",
          modifiers: 8,
        },
      });
      await until(
        async () =>
          (
            await browser.command(
              scope,
              { kind: "evaluate", tabId, expression: "window.shiftHeld" },
              { actor },
            )
          ).output === "true",
      );
      if (change === "resize") {
        viewer.input({ tabId, input: { kind: "resize", width: 390, height: 844 } });
        await until(async () => (await browser.state(scope)).tabs[0]?.width === 390);
      } else {
        await browser.command(
          scope,
          { kind: "evaluate", tabId, expression: "history.pushState({},'', '/route')" },
          { actor },
        );
      }
      await until(async () => (await browser.state(scope)).tabs[0]?.viewId !== oldView);
      await until(
        async () =>
          (
            await browser.command(
              scope,
              { kind: "evaluate", tabId, expression: "window.shiftReleased" },
              { actor },
            )
          ).output === "true",
      );
      await browser.command(
        scope,
        {
          kind: "evaluate",
          tabId,
          expression:
            "document.querySelector('#name').value='';document.querySelector('#name').focus()",
        },
        { actor },
      );
      viewer.input({ tabId, viewId: oldView, input: { kind: "text", text: "stale" } });
      viewer.input({ tabId, input: { kind: "text", text: "fresh" } });
      await until(
        async () =>
          (
            await browser.command(
              scope,
              { kind: "evaluate", tabId, expression: "document.querySelector('#name').value" },
              { actor },
            )
          ).output?.includes("fresh") ?? false,
      );
      assert.equal(
        (
          await browser.command(
            scope,
            { kind: "evaluate", tabId, expression: "document.querySelector('#name').value" },
            { actor },
          )
        ).output,
        '"fresh"',
      );
    }
    viewer.close();
  },
  30000,
);

browserTest(
  "removing a project cancels its browser work without closing another project's tab",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tidy-browser-projects-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new ProjectStore(join(root, "state"));
    await store.initialize();
    const service = new WorkspaceService(store, undefined, async () => null);
    cleanups.push(() => service.close());
    const scopes: BrowserScope[] = [];
    for (const name of ["first", "second"]) {
      const directory = join(root, name);
      await mkdir(directory);
      const { project } = await store.open(directory);
      scopes.push({ projectId: project.id, threadId: randomUUID() });
    }
    const [first, second] = scopes;
    assert.ok(first && second);
    const opened = await service.browser.command(first, { kind: "open", url: "about:blank" });
    const other = await service.browser.command(second, { kind: "open", url: "about:blank" });
    const tabId = opened.state.activeTabId;
    assert.ok(tabId);
    const waiting = service.browser.command(first, {
      kind: "click",
      tabId,
      selector: "[data-never-created]",
    });
    const cancelled = assert.rejects(waiting, /removed/);
    await until(async () => (await service.browser.state(first)).control === "agent");
    await service.removeProject(first.projectId);
    await cancelled;
    assert.equal(service.browser.activeCount, 1);
    assert.equal((await service.browser.state(second)).activeTabId, other.state.activeTabId);
    await assert.rejects(service.browser.state(first), /Open this project/);
  },
  30000,
);

browserTest("stopping navigation preserves a clean state for the next navigation", async () => {
  const { browser, scope, url } = await fixture();
  const opened = await browser.command(scope, { kind: "open", url });
  const tabId = opened.state.activeTabId;
  assert.ok(tabId);
  const pending = browser.command(scope, { kind: "navigate", tabId, url: `${url}/slow` });
  await until(async () => (await browser.state(scope)).tabs[0]?.url === `${url}/slow`);
  await browser.command(scope, { kind: "stop", tabId });
  await pending;
  assert.equal((await browser.state(scope)).tabs[0]?.error, null);
  const next = await browser.command(scope, { kind: "navigate", tabId, url: `${url}/next` });
  assert.equal(next.state.tabs[0]?.error, null);
  assert.equal(next.state.tabs[0]?.loading, false);
  await until(async () => (await browser.state(scope)).tabs[0]?.title === "Second page");
});

browserTest(
  "upload staging is bounded across repeated selections and freed on tab close",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    const tabId = opened.state.activeTabId;
    assert.ok(tabId);
    for (let index = 0; index < 33; index++) {
      await browser.command(scope, { kind: "click", tabId, selector: "#file" });
      await until(async () => Boolean((await browser.state(scope)).fileChooser));
      const chooser = (await browser.state(scope)).fileChooser;
      assert.ok(chooser);
      const upload = browser.command(scope, {
        kind: "upload",
        tabId,
        chooserId: chooser.id,
        files: [{ name: "fixture.txt", data: Buffer.from(String(index)).toString("base64") }],
      });
      if (index === 32) await assert.rejects(upload, /Upload storage is full/);
      else await upload;
    }
    await browser.command(scope, { kind: "close", tabId });
    const reopened = await browser.command(scope, { kind: "open", url });
    const nextId = reopened.state.activeTabId;
    assert.ok(nextId);
    await browser.command(scope, { kind: "click", tabId: nextId, selector: "#file" });
    await until(async () => Boolean((await browser.state(scope)).fileChooser));
    const chooser = (await browser.state(scope)).fileChooser;
    assert.ok(chooser);
    await browser.command(scope, {
      kind: "upload",
      tabId: nextId,
      chooserId: chooser.id,
      files: [{ name: "fixture.txt", data: "eA==" }],
    });
  },
);

browserTest("capture delivers the final page state after a viewer catches up", async () => {
  const { browser, scope, url } = await fixture();
  const opened = await browser.command(scope, { kind: "open", url });
  const tabId = opened.state.activeTabId;
  assert.ok(tabId);
  const frames: Array<Extract<BrowserOutput, { kind: "frame" }>> = [];
  let acknowledge = false;
  const viewer = await watchBrowser({
    browser,
    scope,
    id: randomUUID(),
    receive(event) {
      if (event.kind !== "frame") return;
      frames.push(event);
      if (acknowledge) viewer.input({ tabId, input: { kind: "ack", frameId: event.frameId } });
    },
  });
  await browser.command(scope, {
    kind: "evaluate",
    tabId,
    expression:
      "window.paintTimer=setInterval(()=>document.body.style.background=`rgb(${Math.random()*255},0,0)`,10)",
  });
  await until(() => frames.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await browser.command(scope, {
    kind: "evaluate",
    tabId,
    expression: "clearInterval(window.paintTimer);document.body.style.background='rgb(0,255,0)'",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  acknowledge = true;
  for (const frame of [...frames])
    viewer.input({ tabId, input: { kind: "ack", frameId: frame.frameId } });
  await until(async () => {
    const latest = frames.at(-1);
    if (!latest) return false;
    const pixel = await browser.command(scope, {
      kind: "evaluate",
      tabId,
      expression: `fetch("data:image/jpeg;base64,${Buffer.from(latest.data).toString("base64")}").then(r=>r.blob()).then(createImageBitmap).then(bitmap=>{try{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);return Array.from(context.getImageData(1,1,1,1).data)}finally{bitmap.close()}})`,
    });
    const channels = z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .parse(JSON.parse(pixel.output ?? "null"));
    return channels[1] > 210 && channels[0] < 50;
  });
  viewer.close();
});

browserTest(
  "Mac editing commands preserve word, line and selection behavior on the host",
  async () => {
    const { browser, scope, url } = await fixture();
    const opened = await browser.command(scope, { kind: "open", url });
    assert.equal(opened.state.keyboardCommands, true);
    const tabId = opened.state.activeTabId;
    assert.ok(tabId);
    const actor = randomUUID(),
      viewer = await watchBrowser({ browser, scope, id: actor, receive() {} });
    viewer.input({ tabId, input: { kind: "take-control" } });
    const evaluate = async (expression: string) =>
      (await browser.command(scope, { kind: "evaluate", tabId, expression }, { actor })).output;
    const cases = [
      {
        key: "ArrowLeft",
        altKey: true,
        metaKey: false,
        shiftKey: false,
        expected: ["alpha beta", 6, 6],
      },
      {
        key: "ArrowLeft",
        altKey: true,
        metaKey: false,
        shiftKey: true,
        expected: ["alpha beta", 6, 10],
      },
      {
        key: "ArrowLeft",
        altKey: false,
        metaKey: true,
        shiftKey: false,
        expected: ["alpha beta", 0, 0],
      },
      { key: "Backspace", altKey: false, metaKey: true, shiftKey: false, expected: ["", 0, 0] },
      {
        key: "Backspace",
        altKey: true,
        metaKey: false,
        shiftKey: false,
        expected: ["alpha ", 6, 6],
      },
    ];
    for (const value of cases) {
      await evaluate(
        "(()=>{const input=document.querySelector('#name');input.value='alpha beta';input.focus();input.setSelectionRange(10,10)})()",
      );
      const command = browserEditingCommand({ ...value, ctrlKey: false });
      assert.ok(command);
      const modifiers = (value.altKey ? 1 : 0) | (value.metaKey ? 4 : 0) | (value.shiftKey ? 8 : 0);
      for (const action of ["down", "up"] as const)
        viewer.input({
          tabId,
          input: {
            kind: "key",
            action,
            key: value.key,
            code: value.key,
            keyCode: value.key === "Backspace" ? 8 : 37,
            text: "",
            modifiers,
            ...(action === "down" ? { command } : {}),
          },
        });
      await until(
        async () =>
          (await evaluate(
            "(()=>{const input=document.querySelector('#name');return [input.value,input.selectionStart,input.selectionEnd]})()",
          )) === JSON.stringify(value.expected),
      );
    }
    await evaluate(
      "(()=>{const input=document.querySelector('#name');input.value='alpha beta';input.setSelectionRange(10,10);window.handled=false;input.onkeydown=e=>{e.preventDefault();window.handled=true}})()",
    );
    viewer.input({
      tabId,
      input: {
        kind: "key",
        action: "down",
        key: "ArrowLeft",
        code: "ArrowLeft",
        keyCode: 37,
        text: "",
        modifiers: 1,
        command: "moveWordLeft",
      },
    });
    await until(async () => (await evaluate("window.handled")) === "true");
    assert.equal(await evaluate("document.querySelector('#name').selectionStart"), "10");
    viewer.close();
  },
);
