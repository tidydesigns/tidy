import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, net } from "electron";

// A real shell in a synthetic project. No provider accounts, model calls, or user shell profiles.
const temporary = await mkdtemp(join(tmpdir(), "tidy-terminal-smoke-"));
const root = join(temporary, "project");
const data = join(temporary, "user-data");
const projectId = randomUUID();
for (const path of [root, join(root, ".tidy"), join(data, "workspace"), join(temporary, "home")])
  await mkdir(path, { recursive: true });
await writeFile(join(root, ".tidy/project.json"), JSON.stringify({ version: 1, id: projectId }));
await writeFile(join(root, "terminal-fixture.txt"), "Tidy terminal smoke\nTrue colour Neovim\n");
await writeFile(
  join(data, "workspace/projects.json"),
  JSON.stringify({
    version: 1,
    activeProjectId: projectId,
    projects: [
      {
        id: projectId,
        name: "Terminal fixture",
        path: await realpath(root),
        openedAt: new Date().toISOString(),
      },
    ],
  }),
);
app.setPath("userData", data);
process.env.TIDY_HOST_STATE = join(temporary, "host");
await writeFile(
  join(temporary, "shell"),
  `#!/bin/sh\nexport HOME='${join(temporary, "home")}'\nexec /bin/sh -i\n`,
);
await chmod(join(temporary, "shell"), 0o700);
process.chdir(temporary);
process.env.SHELL = join(temporary, "shell");
delete process.env.ELECTRON_RENDERER_URL;
if (process.env.TIDY_TERMINAL_ENTRY) {
  Object.defineProperty(app, "isPackaged", { get: () => true });
  const fetch = net.fetch.bind(net);
  net.fetch = (url, init) =>
    String(url).startsWith("https://api.github.com/repos/tidydesigns/tidy/releases?")
      ? Promise.resolve(new Response("[]"))
      : fetch(url, init);
}
let result = 1;
const deadline = setTimeout(() => {
  console.error("Terminal smoke timed out.");
  app.quit();
}, 60_000);
let primary;
app.on("browser-window-created", (_event, window) => {
  if (primary) return;
  primary = window;
  window.show = () => {}; // Keep the synthetic fixture from taking the user's keyboard focus.
  window.hide();
  window.webContents.setBackgroundThrottling(false);
  const page = window.webContents;
  page.on("did-fail-load", (_event, code, description) =>
    console.error("Terminal load failed", code, description),
  );
  const evaluate = (value) => page.executeJavaScript(value);
  const wait = async (expression) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  page.once("did-finish-load", () => {
    void (async () => {
      try {
        await wait("document.querySelector('.terminal-launcher')!==null");
        assert.equal(await evaluate("typeof require"), "undefined");
        assert.equal(await evaluate("document.querySelector('.terminal-dock').hidden"), true);
        await evaluate(
          "window.addEventListener('error',e=>console.error(e.error?.stack));document.querySelector('.terminal-launcher').click(); true",
        );
        await wait(
          "document.querySelector('.terminal-surface canvas')!==null && !document.querySelector('.terminal-status')",
        );
        await evaluate(
          `window.terminalEvents=[]; window.terminalWatch=window.tidy.terminal.watch({projectId:${JSON.stringify(projectId)},terminalId:document.querySelector('.terminal-tab[role=tab][aria-selected=true]').id.replace('terminal-tab-',''),cols:80,rows:24},output=>{window.terminalEvents.push(output);if(output.kind==='snapshot'||output.kind==='data')queueMicrotask(()=>window.terminalWatch.input({kind:'ack',sessionId:output.sessionId,sequence:output.sequence}));}); true`,
        );
        await wait("window.terminalEvents.some(e=>e.kind==='snapshot')");
        const send = async (data) => {
          await evaluate(
            `window.terminalWatch.input({kind:'write',sessionId:window.terminalEvents.find(e=>e.kind==='snapshot').sessionId,data:${JSON.stringify(data)}}); true`,
          );
        };
        const output = "window.terminalEvents.filter(e=>e.kind==='data').map(e=>e.data).join('')";
        const key = async (keyCode, modifiers) => {
          page.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          page.sendInputEvent({ type: "keyUp", keyCode, modifiers });
          await new Promise((resolve) => setTimeout(resolve, 25));
        };
        const mod = process.platform === "darwin" ? "meta" : "control";

        for (const selector of [".terminal-surface", ".terminal-surface textarea"]) {
          assert.equal(
            await evaluate(
              `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).caretColor`,
            ),
            "rgba(0, 0, 0, 0)",
          );
        }
        const font =
          "Number(/([0-9.]+)px/.exec(document.querySelector('.terminal-session:not([hidden]) canvas').getContext('2d').font)[1])";
        const checkZoom = async () => {
          await evaluate(
            "document.querySelector('.terminal-session:not([hidden]) textarea').focus();true",
          );
          await wait(`${font}===13`);
          const toolbarHeight = await evaluate(
            "document.querySelector('.terminal-toolbar').getBoundingClientRect().height",
          );
          await key("=", [mod]);
          await wait(`${font}===14`);
          await key("=", [mod, "shift"]);
          await wait(`${font}===15`);
          await key("-", [mod]);
          await wait(`${font}===14`);
          assert.equal(page.getZoomFactor(), 1, "terminal zoom must not zoom the application");
          assert.equal(
            await evaluate(
              "document.querySelector('.terminal-toolbar').getBoundingClientRect().height",
            ),
            toolbarHeight,
          );
          await key("0", [mod]);
          await wait(`${font}===13`);
        };
        await checkZoom();

        await send(
          "printf '\\033[38;2;18;52;86mTIDY_COLOR\\033[0m\\n'; printf 'TERM=%s COLORTERM=%s\\n' \"$TERM\" \"$COLORTERM\"; pwd\r",
        );
        await wait(`${output}.includes('TERM=xterm-256color COLORTERM=truecolor')`);
        assert.ok((await evaluate(output)).includes(await realpath(root)));
        assert.ok((await evaluate(output)).includes("\x1b[38;2;18;52;86mTIDY_COLOR"));
        // Check actual Canvas pixels, rather than only trusting ANSI bytes on the wire.
        await wait(
          "Array.from(document.querySelector('.terminal-surface canvas').getContext('2d').getImageData(0,0,document.querySelector('.terminal-surface canvas').width,document.querySelector('.terminal-surface canvas').height).data).some((v,i,a)=>i%4===0&&v===18&&a[i+1]===52&&a[i+2]===86)",
        );
        await evaluate("document.querySelector('[aria-label=\"Hide terminal\"]').click(); true");
        assert.equal(await evaluate("document.querySelector('.terminal-dock').hidden"), true);
        await send("printf 'TIDY_HIDDEN_SESSION\\n'\r");
        await wait(`${output}.includes('TIDY_HIDDEN_SESSION\\r\\n')`);
        await evaluate("document.querySelector('.terminal-launcher').click(); true");
        assert.equal(
          await evaluate("window.terminalEvents.filter(e=>e.kind==='snapshot').length"),
          1,
        );
        await evaluate("document.querySelector('.terminal-surface textarea').focus(); true");
        page.focus();
        for (const key of "echo tidykeyboard") {
          page.sendInputEvent({ type: "keyDown", keyCode: key === " " ? "Space" : key });
          page.sendInputEvent({ type: "keyUp", keyCode: key === " " ? "Space" : key });
        }
        page.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        page.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        await wait(`${output}.includes('tidykeyboard\\r\\n')`);
        if (process.env.TIDY_TEST_NVIM) {
          await send("nvim --clean -i NONE terminal-fixture.txt\r");
          await wait(`${output}.includes('Tidy terminal smoke')`);
          await send(":set termguicolors\r:highlight Normal guifg=#123456 guibg=#18181b\r");
          await wait(
            "Array.from(document.querySelector('.terminal-surface canvas').getContext('2d').getImageData(0,0,document.querySelector('.terminal-surface canvas').width,document.querySelector('.terminal-surface canvas').height).data).some((v,i,a)=>i%4===0&&v===18&&a[i+1]===52&&a[i+2]===86)",
          );
          await checkZoom();
          await send(":vsplit\r");
          await wait(`${output}.includes('│')`);
          const previousWidth = await evaluate(
            "document.querySelector('.terminal-surface canvas').width",
          );
          window.setSize(1050, 760);
          await wait(`document.querySelector('.terminal-surface canvas').width!==${previousWidth}`);
          if (process.env.TIDY_TEST_SCREENSHOT)
            await writeFile(process.env.TIDY_TEST_SCREENSHOT, (await page.capturePage()).toPNG());
          await send("\x1b:qa!\r");
          await wait(`${output}.includes('\\u001b[?1049l')`);
          await send("printf 'TIDY_NVIM_RETURNED\\n'\r");
          await wait(`${output}.includes('TIDY_NVIM_RETURNED\\r\\n')`);
        }
        const initialWidth = await evaluate(
          "document.querySelector('.terminal-dock').getBoundingClientRect().width",
        );
        await evaluate(
          "document.querySelector('[aria-label=\"Full screen terminal\"]').click();true",
        );
        await wait(
          "document.querySelector('.terminal-dock-fullscreen')!==null && document.querySelector('.desktop-sidebar-hidden')!==null",
        );
        assert.ok(
          await evaluate(
            `document.querySelector('.terminal-dock').getBoundingClientRect().width>${initialWidth}`,
          ),
        );
        assert.ok(
          await evaluate(
            "document.querySelector('.terminal-dock').getBoundingClientRect().height>500",
          ),
        );
        if (process.env.TIDY_TEST_SCREENSHOT)
          await writeFile(
            process.env.TIDY_TEST_SCREENSHOT + ".fullscreen.png",
            (await page.capturePage()).toPNG(),
          );
        assert.equal(
          await evaluate("document.querySelector('.workspace-view:not([hidden])').inert"),
          true,
        );
        await evaluate("document.querySelector('[aria-label=\"Restore terminal\"]').click();true");
        await wait("!document.querySelector('.terminal-dock-fullscreen')");
        await send("export TIDY_TAB_ISOLATION=first\r");
        await evaluate("document.querySelector('.terminal-surface textarea').focus();true");
        await key("=", [mod]);
        await wait(`${font}===14`);
        await key("t", [mod]);
        await wait(
          "document.querySelectorAll('.terminal-tab[role=tab]').length===2 && !document.querySelector('.terminal-session:not([hidden]) .terminal-status')",
        );
        await wait(`${font}===14`);
        await evaluate(
          `window.secondEvents=[];window.secondWatch=window.tidy.terminal.watch({projectId:${JSON.stringify(projectId)},terminalId:document.querySelector('.terminal-tab[role=tab][aria-selected=true]').id.replace('terminal-tab-',''),cols:80,rows:24},o=>{window.secondEvents.push(o);if(o.kind==='snapshot'||o.kind==='data')queueMicrotask(()=>window.secondWatch.input({kind:'ack',sessionId:o.sessionId,sequence:o.sequence}));});true`,
        );
        await wait("window.secondEvents.some(e=>e.kind==='snapshot')");
        await evaluate(
          `window.secondWatch.input({kind:'write',sessionId:window.secondEvents.find(e=>e.kind==='snapshot').sessionId,data:${JSON.stringify("printf 'SECOND=%s\\n' \"$TIDY_TAB_ISOLATION\"; printf '\\033]2;second-shell\\007'\r")}});true`,
        );
        await wait(
          "window.secondEvents.some(e=>e.kind==='data'&&e.data.includes('SECOND=\\r\\n'))",
        );
        await wait(
          "document.querySelector('.terminal-tab[role=tab][aria-selected=true]').textContent==='second-shell'",
        );
        assert.equal(
          await evaluate(
            "window.secondEvents.find(e=>e.kind==='snapshot').sessionId!==window.terminalEvents.find(e=>e.kind==='snapshot').sessionId",
          ),
          true,
        );
        await key("Tab", ["control"]);
        await wait(
          "document.querySelectorAll('.terminal-tab[role=tab]')[0].getAttribute('aria-selected')==='true'",
        );
        await key("2", [mod]);
        await wait(
          "document.querySelectorAll('.terminal-tab[role=tab]')[1].getAttribute('aria-selected')==='true'",
        );
        await key("Return", [mod]);
        await wait("document.querySelector('.terminal-dock-fullscreen')!==null");
        await key("Return", [mod]);
        await wait("!document.querySelector('.terminal-dock-fullscreen')");
        await key("w", [mod]);
        await wait(
          "document.querySelectorAll('.terminal-tab[role=tab]').length===1 && window.secondEvents.some(e=>e.kind==='exit')",
        );
        assert.equal(window.isDestroyed(), false);
        assert.equal(await evaluate("window.terminalEvents.some(e=>e.kind==='exit')"), false);
        await send("printf 'FIRST=%s\\n' \"$TIDY_TAB_ISOLATION\"\r");
        await wait(`${output}.includes('FIRST=first\\r\\n')`);
        for (let step = 0; step < 30; step++) await key("=", [mod]);
        await wait(`${font}===32`);
        for (let step = 0; step < 30; step++) await key("-", [mod]);
        await wait(`${font}===8`);
        await key("0", [mod]);
        await wait(`${font}===13`);
        await key("=", [mod]);
        await wait(`${font}===14`);
        const firstSession = await evaluate(
          "window.terminalEvents.find(e=>e.kind==='snapshot').sessionId",
        );
        await evaluate("window.secondWatch.close();window.terminalWatch.close();true");
        const loaded = new Promise((resolve) => page.once("did-finish-load", resolve));
        page.reload();
        await loaded;
        await wait(
          "document.querySelector('.terminal-session:not([hidden]) canvas')!==null && !document.querySelector('.terminal-status')",
        );
        assert.equal(await evaluate("document.querySelectorAll('.terminal-tab').length"), 1);
        await wait(`${font}===14`);
        await evaluate(
          `window.terminalEvents=[];window.terminalWatch=window.tidy.terminal.watch({projectId:${JSON.stringify(projectId)},terminalId:document.querySelector('.terminal-tab').id.replace('terminal-tab-',''),cols:80,rows:24},o=>{window.terminalEvents.push(o);if(o.kind==='snapshot'||o.kind==='data')queueMicrotask(()=>window.terminalWatch.input({kind:'ack',sessionId:o.sessionId,sequence:o.sequence}));});true`,
        );
        await wait("window.terminalEvents.some(e=>e.kind==='snapshot')");
        assert.equal(
          await evaluate("window.terminalEvents.find(e=>e.kind==='snapshot').sessionId"),
          firstSession,
        );
        await evaluate("document.querySelector('.terminal-tab-close').click();true");
        await wait("window.terminalEvents.some(e=>e.kind==='exit')");
        await evaluate("window.terminalWatch.close();true");
        assert.equal(
          await evaluate(
            "document.querySelector('.terminal-surface')===null && document.querySelector('.terminal-dock').hidden",
          ),
          true,
        );
        console.info(
          `PASS: real Electron shell, CSP/WASM, native PTY, project cwd, true-colour Canvas pixels, keyboard input, hide/reopen persistence, isolated tabs, shell titles, one-click fullscreen, native tab shortcuts, terminal font zoom with stable app scale, suppressed browser caret, reload reattachment, close-tab cleanup${process.env.TIDY_TEST_NVIM ? ", Neovim full-screen/splits/resize/return to shell" : ""}.`,
        );
        result = 0;
      } catch (error) {
        console.error(error);
        console.error(await evaluate("document.body.innerText"));
        console.error(await evaluate("JSON.stringify(window.terminalEvents?.slice(-6))"));
      }
      clearTimeout(deadline);
      app.quit();
    })();
  });
});
app.on("will-quit", (event) => {
  event.preventDefault();
  clearTimeout(deadline);
  void rm(temporary, { recursive: true, force: true }).finally(() => app.exit(result));
});
const entry = process.env.TIDY_TERMINAL_ENTRY
  ? pathToFileURL(process.env.TIDY_TERMINAL_ENTRY).href
  : new URL("../out/main/index.js", import.meta.url).href;
await import(entry);
