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
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow } from "electron";

// Synthetic projects and harnesses only. No developer credentials or model inference.
const temporary = await mkdtemp(join(tmpdir(), "tidy-security-smoke-"));
const exportProbe = join(temporary, "native-svg.js");
execFileSync(
  "bun",
  [
    "build",
    fileURLToPath(new URL("./fixtures/native-svg.mjs", import.meta.url)),
    "--target=browser",
    "--format=iife",
    "--outfile",
    exportProbe,
  ],
  { stdio: "pipe" },
);
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
      assert.deepEqual(await api("updateState"), { status: "unsupported" });
      await assert.rejects(api("installUpdate"), /No desktop update is ready/);
      const exported = await evaluate(
        `${await readFile(exportProbe, "utf8")};globalThis.__tidyExportSecurityResult`,
      );
      assert.equal(exported.length, 4);
      for (const { svg, unsupported } of exported) {
        assert.deepEqual(unsupported, []);
        assert.match(svg, /M0 0L100 0L100 50Z/);
        assert.match(svg, /stroke-width="2"/);
        assert.match(svg, /fill="#ff0000"/);
        assert.doesNotMatch(svg, /script|onload|onerror|foreignObject|parsererror/);
      }
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
      await assert.rejects(
        api("installHarnessUpdate", "codex; echo bad"),
        /Invalid harness update request/,
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
      for (const name of [
        "update-state",
        "check-updates",
        "install-update",
        "harness-updates",
        "install-harness-update",
      ]) {
        const message = await foreign.webContents.executeJavaScript(
          `window.probe.invoke(${JSON.stringify(name)}).then(()=>null,error=>error.message)`,
        );
        assert.match(message, /Untrusted desktop request/);
      }

      // Synthetic states exercise the real grouped notice without upgrading a CLI.
      const harnessNotice = {
        id: "codex",
        status: "available",
        installedVersion: "0.1.0",
        latestVersion: "0.2.0",
        canInstall: true,
      };
      const otherNotices = ["claude", "opencode"].map((id) => ({ ...harnessNotice, id }));
      page.send("tidy:harness-updates", [harnessNotice, ...otherNotices]);
      await wait("document.querySelector('[aria-label=\"Update Codex\"]')!==null");
      assert.equal(await evaluate("document.querySelectorAll('.harness-update-notice').length"), 1);
      assert.equal(
        await evaluate("document.querySelectorAll('.harness-update-row .harness-icon').length"),
        3,
      );
      assert.equal(await evaluate("document.querySelectorAll('.tidy-toast-viewport').length"), 1);
      const notices = await evaluate(`(() => {
        const bounds = document.querySelector('.tidy-toast-viewport').getBoundingClientRect();
        return { right: innerWidth - bounds.right, bottom: innerHeight - bounds.bottom };
      })()`);
      assert.equal(notices.right, 20);
      assert.equal(notices.bottom, 20);
      await evaluate("document.querySelector('[aria-label=\"Update Codex\"]').click();true");
      await wait("document.body.textContent.includes('Couldn’t start the update')");
      page.send("tidy:harness-updates", [
        { ...harnessNotice, status: "queued", waitReason: "turn" },
        ...otherNotices,
      ]);
      await wait("document.querySelector('[data-harness=codex][data-state=queued]')!==null");
      assert.equal(
        await evaluate(
          "document.querySelector('[data-harness=codex] .harness-update-spinner')===null",
        ),
        true,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[data-harness=codex]').textContent.includes('After its active responses')",
        ),
        true,
      );
      page.send("tidy:harness-updates", [
        { ...harnessNotice, status: "installing" },
        ...otherNotices.map((entry) => ({ ...entry, status: "queued", waitReason: "installer" })),
      ]);
      await wait("document.querySelector('[data-harness=codex] .harness-update-spinner')!==null");
      assert.equal(
        await evaluate("document.querySelectorAll('.harness-update-spinner').length"),
        1,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[data-harness=claude]').textContent.includes('Next in line')",
        ),
        true,
      );
      assert.equal(
        await evaluate(`getComputedStyle(document.querySelector('.harness-update-spinner')).animationName ===
        (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'harness-update-spin')`),
        true,
      );
      page.send("tidy:harness-updates", [
        { ...harnessNotice, status: "error", message: "Fixture update failed." },
      ]);
      await wait("document.querySelector('[aria-label=\"Retry updating Codex\"]')!==null");
      await evaluate(
        "document.querySelector('[aria-label=\"Dismiss harness updates\"]').click();true",
      );
      await wait("document.querySelector('.harness-update-notice')===null");
      page.send("tidy:harness-updates", [{ ...harnessNotice, status: "installing" }]);
      await wait("document.querySelector('.harness-update-spinner')!==null");
      page.send("tidy:harness-updates", [
        { ...harnessNotice, status: "updated", installedVersion: "0.2.0" },
      ]);
      await wait("document.querySelector('[data-harness=codex][data-state=updated]')!==null");
      assert.equal(
        await evaluate("document.querySelector('[data-harness=codex] .harness-icon')!==null"),
        true,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[data-harness=codex] .harness-update-state').textContent",
        ),
        "Updated",
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.harness-update-spinner').length"),
        0,
      );
      page.send("tidy:harness-updates", []);

      // Exercise renderer update-state rendering and its sidebar action with synthetic events.
      assert.equal(await evaluate("document.querySelector('.app-update-button')===null"), true);
      for (const status of ["checking", "downloading", "installing"]) {
        page.send("tidy:update", { status, version: "0.1.0-beta.999" });
        await wait("document.querySelector('.app-update-button[aria-busy=\"true\"]')!==null");
        // Native keyboard/focus assertions need the primary renderer to own focus.
        window.focus();
        page.focus();
        assert.equal(
          await evaluate(
            "document.querySelector('.app-update-button').getAttribute('aria-disabled')",
          ),
          "true",
        );
        // Busy controls remain focusable so their status can be inspected without activating them.
        await evaluate(
          "document.querySelector('.app-update-button').focus();document.querySelector('.app-update-button').click();true",
        );
        await wait(
          "getComputedStyle(document.querySelector('.app-update-tooltip')).visibility==='visible'",
        );
        assert.equal(
          await evaluate("document.querySelector('.app-update-button').getAttribute('aria-busy')"),
          "true",
        );
        page.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        page.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await wait(
          "getComputedStyle(document.querySelector('.app-update-tooltip')).visibility==='hidden'",
        );
        await evaluate("document.querySelector('.app-update-button').blur();true");
        assert.equal(
          await evaluate(`(() => {
          const icon=document.querySelector('.app-update-spinning');
          return Boolean(icon) && getComputedStyle(icon).animationName ===
            (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'app-update-spin');
        })()`),
          true,
        );
      }
      page.send("tidy:update", { status: "ready", version: "0.1.0-beta.999" });
      await wait("document.querySelector('.app-update-button[aria-busy=\"false\"]')!==null");
      assert.equal(
        await evaluate(`(() => {
          const button=document.querySelector('.app-update-button');
          const sidebar=document.querySelector('.desktop-navigation');
          return button.getAttribute('aria-label')==='Restart to update' &&
            document.getElementById(button.getAttribute('aria-describedby')).textContent==='Restart to update to Tidy 0.1.0-beta.999' &&
            document.querySelector('.app-update-ready')!==null &&
            button.getBoundingClientRect().bottom <= sidebar.getBoundingClientRect().bottom &&
            sidebar.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom < 20;
        })()`),
        true,
      );
      const updateFooterHeight = await evaluate(
        "document.querySelector('.sidebar-update').offsetHeight",
      );
      const updateBounds = await evaluate(`(() => {
        const rect=document.querySelector('.app-update-button').getBoundingClientRect();
        return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
      })()`);
      // Escape may have dismissed an existing hover; start outside before entering again.
      page.sendInputEvent({ type: "mouseMove", x: 350, y: 100 });
      await wait("!document.querySelector('.app-update-control').matches(':hover')");
      page.sendInputEvent({ type: "mouseMove", ...updateBounds });
      await wait(
        "getComputedStyle(document.querySelector('.app-update-tooltip')).visibility==='visible'",
      );
      page.sendInputEvent({ type: "mouseMove", x: 350, y: 100 });
      await wait(
        "getComputedStyle(document.querySelector('.app-update-tooltip')).visibility==='hidden'",
      );
      // There is intentionally no staged native update: installation must fail safely and retry.
      await evaluate("document.querySelector('.app-update-button').click();true");
      await wait("document.querySelector('.app-update-warning')!==null");
      assert.equal(
        await evaluate(
          "document.querySelector('.app-update-button').getAttribute('aria-disabled')",
        ),
        "false",
      );
      assert.equal(await evaluate("document.querySelector('.app-update-error')===null"), true);
      assert.equal(
        await evaluate("document.querySelector('.sidebar-update').offsetHeight"),
        updateFooterHeight,
      );
      assert.equal(
        await evaluate(
          "getComputedStyle(document.querySelector('.app-update-tooltip')).visibility",
        ),
        "hidden",
      );
      await evaluate("document.querySelector('.app-update-button').focus();true");
      await wait(
        "getComputedStyle(document.querySelector('.app-update-tooltip')).visibility==='visible'",
      );
      assert.match(
        await evaluate("document.querySelector('.app-update-tooltip').textContent"),
        /Couldn’t restart.*retry/,
      );
      page.send("tidy:update", { status: "idle" });
      await wait("document.querySelector('.app-update-button')===null");

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
        "PASS: sandbox, protocol resources, canvas, native SVG export injection rejection, IPC authorization and validation, event confidentiality, model controls, Enter to send, native approvals, replay rejection, private runtime state, navigation and popup denial.",
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
