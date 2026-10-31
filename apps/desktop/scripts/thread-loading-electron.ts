import { app, BrowserWindow } from "electron";
import { z } from "zod";

const [html, preload, userData] = process.argv.slice(-3);
if (!html || !preload || !userData) throw new Error("Missing renderer test paths.");
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-gpu");
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
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
    window.webContents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width: 1100, height: 800 },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: 1100, height: 800 },
      deviceScaleFactor: 1,
      scale: 1,
    });
    const result: unknown = await window.webContents.executeJavaScript(
      "window.runThreadLoadingTests()",
    );
    const cases = z.array(z.string()).min(1).parse(result);
    for (const name of cases) console.info(`PASS: ${name}`);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
