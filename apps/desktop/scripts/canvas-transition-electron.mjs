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
  page.debugger.attach("1.3");
  const evaluate = (expression) => page.executeJavaScript(expression);
  async function click(label) {
    console.info(`Canvas transitions: click ${label}`);
    page.focus();
    const point = await evaluate(`(async () => {
      const label = ${JSON.stringify(label)};
      const deadline = Date.now() + 15_000;
      let previous;
      while (Date.now() < deadline) {
        const button = Array.from(document.querySelectorAll('button,textarea,input,[contenteditable="true"]'))
          .find(element => (element.getAttribute('aria-label') || element.textContent.trim()) === label && element.getBoundingClientRect().width && getComputedStyle(element).visibility !== 'hidden');
        if (button) {
          button.scrollIntoView({block: 'nearest'});
          const rect = button.getBoundingClientRect();
          const point = {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
          if (previous && Math.abs(point.x - previous.x) < 1 && Math.abs(point.y - previous.y) < 1 && button.contains(document.elementFromPoint(point.x, point.y))) {
            window.__canvasClick = new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(Error('Native click not received: ' + label)), 15_000);
              button.addEventListener('click', () => {
                clearTimeout(timeout);
                requestAnimationFrame(() => requestAnimationFrame(resolve));
              }, {once: true});
            });
            return point;
          }
          previous = point;
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw Error('Control is not clickable: ' + label);
    })()`);
    page.sendInputEvent({ type: "mouseMove", ...point });
    page.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    page.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await evaluate("window.__canvasClick");
  }
  try {
    const passed = await canvasTransitionCases(
      {
        evaluate,
        click,
        navigate: async (url) => {
          console.info(`Canvas transitions: navigate ${url}`);
          await page.loadURL(url);
          console.info(
            "Canvas transitions: host reduced motion",
            await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),
          );
          await page.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
          });
        },
        fill: async (label, text) => {
          await click(label);
          const modifiers = [process.platform === "darwin" ? "meta" : "control"];
          page.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers });
          page.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers });
          page.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
          page.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
          await page.insertText(text);
          await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
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
