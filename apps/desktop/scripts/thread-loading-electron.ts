import { app, BrowserWindow } from "electron";
import { z } from "zod";

const [, , html, preload, userData] = process.argv;
if (!html || !preload || !userData) throw new Error("Missing renderer test paths.");
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-gpu");
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    width: 1100,
    height: 800,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(html);
    const result: unknown = await window.webContents.executeJavaScript(
      "window.runThreadLoadingTests()",
    );
    const cases = z.array(z.string()).min(1).parse(result);
    for (const name of cases) console.info(`PASS: ${name}`);
    for (const width of [900, 390, 320]) {
      window.setContentSize(width, 800);
      for (const filter of [
        "workspace sidebar adapts",
        "workspace panel preserves",
        "composer controls retain",
      ]) {
        const responsive: unknown = await window.webContents.executeJavaScript(`(async () => {
          for (const element of [document.documentElement, document.body, document.getElementById("root")]) element.style.width = "100%";
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (window.innerWidth !== ${width}) throw new Error("Responsive viewport did not resize to ${width}px");
          return window.runThreadLoadingTests(${JSON.stringify(filter)});
        })()`);
        for (const name of z.array(z.string()).min(1).parse(responsive))
          console.info(`PASS (${width}px): ${name}`);
      }
    }
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
