import { app, BrowserWindow } from "electron";
import { canvasTransitionCases } from "./canvas-transition-cases.mjs";

const [, , origin, profile] = process.argv;
app.setPath("userData", profile);
console.info("Canvas transitions: starting Electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const page = window.webContents;
  const evaluate = (expression) => page.executeJavaScript(expression);
  async function click(label) {
    console.info(`Canvas transitions: click ${label}`);
    page.focus();
    const point = await evaluate(
      `(() => {const b=Array.from(document.querySelectorAll('button,textarea,input,[contenteditable="true"]')).find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(label)} && e.getBoundingClientRect().width && getComputedStyle(e).visibility!=='hidden');if(!b)throw Error('Missing control: '+${JSON.stringify(label)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    );
    page.sendInputEvent({ type: "mouseMove", ...point });
    page.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    page.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
  }
  try {
    const passed = await canvasTransitionCases(
      {
        evaluate,
        click,
        navigate: (url) => {
          console.info(`Canvas transitions: navigate ${url}`);
          return page.loadURL(url);
        },
        fill: async (label, text) => {
          await click(label);
          const modifiers = [process.platform === "darwin" ? "meta" : "control"];
          page.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers });
          page.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers });
          await page.insertText(text);
        },
      },
      origin,
      { coldOrigin: origin },
    );
    for (const name of passed) console.info(`PASS: ${name}`);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
