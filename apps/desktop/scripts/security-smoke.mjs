import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

// Synthetic projects and harnesses only. No developer credentials or model inference.
const temporary = await mkdtemp(join(tmpdir(), "tidy-security-smoke-"));
const projectId = randomUUID();
const root = join(temporary, "project");
const data = join(temporary, "user-data");
const bin = join(temporary, "bin");
for (const directory of [
  root,
  data,
  bin,
  join(data, "workspace"),
  join(root, ".tidy"),
  ...["threads", "designs", "folders", "assets", "attachments"].map((name) =>
    join(root, ".tidy", name),
  ),
])
  await mkdir(directory);
await writeFile(join(root, ".tidy/project.json"), JSON.stringify({ version: 1, id: projectId }));
await writeFile(
  join(data, "workspace/projects.json"),
  JSON.stringify({
    version: 1,
    activeProjectId: projectId,
    projects: [
      {
        id: projectId,
        name: "Security fixture",
        path: await realpath(root),
        openedAt: new Date().toISOString(),
      },
    ],
  }),
);
for (const name of ["codex", "claude"]) {
  const path = join(bin, name);
  await copyFile(new URL("../src/main/fixtures/harness.mjs", import.meta.url), path);
  await chmod(path, 0o700);
}
const probePreload = join(temporary, "probe.cjs");
await writeFile(
  probePreload,
  `const {contextBridge,ipcRenderer}=require('electron');let events=0;ipcRenderer.on('tidy:event',()=>events++);contextBridge.exposeInMainWorld('probe',{invoke:(name,input)=>ipcRenderer.invoke('tidy:'+name,input),events:()=>events});`,
);
app.setPath("userData", data);
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.ELECTRON_RENDERER_URL;
let result = 1;
const deadline = setTimeout(() => {
  console.error("Desktop security smoke timed out.");
  app.quit();
}, 60_000);
let primary;
app.on("browser-window-created", (_event, window) => {
  if (primary) return;
  primary = window;
  const page = window.webContents;
  const evaluate = (expression) => page.executeJavaScript(expression);
  const api = (method, ...args) =>
    evaluate(`window.tidy[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const wait = async (expression) => {
    const until = Date.now() + 12_000;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Condition did not become true: ${expression}`);
  };
  page.once("did-finish-load", async () => {
    try {
      assert.equal(page.getURL(), "tidy://app/index.html");
      const preferences = page.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.webSecurity, true);
      assert.equal(preferences.webviewTag, false);
      await wait("document.querySelector('#workspace-tab-code')!==null");
      await wait("document.querySelector('[aria-label=\"New file options\"]')!==null");
      assert.equal(await evaluate("typeof require"), "undefined");
      assert.equal(await evaluate("typeof window.tidy.invoke"), "undefined");
      assert.equal(
        await evaluate(
          "document.querySelector('meta[http-equiv=Content-Security-Policy]').content.includes(\"frame-src 'none'\")",
        ),
        true,
      );
      await assert.rejects(
        api("readThread", projectId, "../../outside"),
        /Invalid desktop request/,
      );
      await assert.rejects(api("readThread", randomUUID(), randomUUID()), /Open this project/);
      await assert.rejects(
        api("startThread", {
          projectId,
          harness: "codex",
          prompt: "bad",
          designIds: [],
          settings: { model: "--dangerously-skip-permissions" },
        }),
        /Invalid desktop request/,
      );
      const resource = await evaluate(
        `Promise.all([fetch('tidy://app/../../main/index.js'),fetch('tidy://other/index.html')].map(async promise=>{try{return (await promise).status}catch{return 0}}))`,
      );
      assert.ok(resource.every((status) => status === 0 || status === 404));
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: probePreload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      await foreign.loadURL("data:text/html,<title>Untrusted fixture</title>");
      const denied = await foreign.webContents.executeJavaScript(
        "window.probe.invoke('bootstrap')",
      );
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Untrusted desktop request/);

      // A real canvas must still work under the restricted custom protocol.
      const design = await api("createDesign", projectId);
      await wait(
        `Array.from(document.querySelectorAll('.local-file-card')).some(card=>card.textContent.includes(${JSON.stringify(design.name)}))`,
      );
      await evaluate("document.querySelector('.file-open-overlay').click();true");
      await wait("document.querySelector('[aria-label=\"Design canvas\"]')!==null");
      await wait(
        `document.querySelector('[data-node-id="${design.document.nodes[0].id}"]')!==null`,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[aria-label=\"Design canvas\"]').getBoundingClientRect().width>0",
        ),
        true,
      );
      await evaluate("document.querySelector('#workspace-tab-code').click();true");
      await wait("document.querySelector('#thread-prompt')!==null");
      await wait("document.querySelector('[aria-label^=\"Model:\"]')?.disabled===false");
      assert.equal(
        await evaluate("document.querySelector('[aria-label^=\"Model:\"]').textContent"),
        "Fixture Codex",
      );
      assert.equal(
        await evaluate("document.querySelector('[aria-label^=\"Effort:\"]').textContent"),
        "High",
      );
      await evaluate("document.querySelector('#thread-prompt').focus();true");
      await page.insertText("permission-fixture");
      page.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      page.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await wait("document.querySelector('.approval-request')!==null");
      const snapshot = await api("bootstrap");
      const threadId = snapshot.activeProject.threads[0].id;
      const live = await api("readThread", projectId, threadId);
      await assert.rejects(
        api("respondToApproval", projectId, threadId, randomUUID(), "allow"),
        /no longer/,
      );
      await api("respondToApproval", projectId, threadId, live.pendingApprovals[0].id, "deny");
      await wait(
        "!document.querySelector('.approval-request') && document.querySelector('.transcript').textContent.includes('Action declined.')",
      );
      await assert.rejects(
        api("respondToApproval", projectId, threadId, live.pendingApprovals[0].id, "allow"),
        /no longer/,
      );
      assert.equal(await foreign.webContents.executeJavaScript("window.probe.events()"), 0);
      const stored = JSON.parse(
        await readFile(join(root, ".tidy/threads", `${threadId}.json`), "utf8"),
      );
      assert.equal(stored.pendingApprovals, undefined);
      assert.equal(stored.sessionId, undefined);
      assert.equal(stored.settings?.permissionMode, undefined);
      const markup =
        '<img src="x" onerror="window.__injected=true"><script>window.__injected=true</script>';
      await wait("document.querySelector('[aria-label^=\"Model:\"]')?.disabled===false");
      await evaluate("document.querySelector('#thread-prompt').focus();true");
      await page.insertText(markup);
      page.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      page.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await wait("document.querySelectorAll('.message-user').length===2");
      assert.equal(
        await evaluate(
          `document.querySelectorAll('.message-user')[1].textContent.includes(${JSON.stringify(markup)})`,
        ),
        true,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.message-user img, .message-user script')===null && window.__injected===undefined",
        ),
        true,
      );
      await wait("document.querySelector('[aria-label^=\"Model:\"]')?.disabled===false");
      const popupCount = BrowserWindow.getAllWindows().length;
      await evaluate("window.open('https://attacker.invalid/');true");
      assert.equal(BrowserWindow.getAllWindows().length, popupCount);
      await evaluate("location.href='https://attacker.invalid/';true");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(page.getURL(), "tidy://app/index.html");
      foreign.destroy();
      console.info(
        "PASS: sandbox, protocol resources, canvas, IPC authorization and validation, event confidentiality, model controls, Enter to send, native approvals, replay rejection, private runtime state, navigation and popup denial.",
      );
      clearTimeout(deadline);
      result = 0;
      app.quit();
    } catch (error) {
      console.error(error);
      console.error(await evaluate("document.body.innerText"));
      clearTimeout(deadline);
      app.quit();
    }
  });
});
app.on("will-quit", (event) => {
  event.preventDefault();
  clearTimeout(deadline);
  void rm(temporary, { recursive: true, force: true }).finally(() => app.exit(result));
});
await import("../out/main/index.js");
