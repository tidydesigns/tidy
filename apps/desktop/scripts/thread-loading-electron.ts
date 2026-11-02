import { app, BrowserWindow } from "electron";
import { z } from "zod";

const [html, preload, userData] = process.argv.slice(-3);
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
    window.webContents.focus();
    window.webContents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width: 1100, height: 800 },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: 1100, height: 800 },
      deviceScaleFactor: 1,
      scale: 1,
    });
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    const result: unknown = await window.webContents.executeJavaScript(
      "window.runThreadLoadingTests()",
    );
    const cases = z.array(z.string()).min(1).parse(result);
    for (const name of cases) console.info(`PASS: ${name}`);
    await window.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    const touch: unknown = await window.webContents.executeJavaScript(`
      if (!matchMedia("(hover: none), (pointer: coarse)").matches)
        throw new Error("Touch input emulation is unavailable.");
      window.runThreadLoadingTests("touch sidebar");
    `);
    for (const name of z.array(z.string()).min(1).parse(touch))
      console.info(`PASS (touch): ${name}`);
    await window.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled: false,
    });
    for (const width of [900, 390, 320]) {
      window.setContentSize(width, 800);
      window.webContents.enableDeviceEmulation({
        screenPosition: "desktop",
        screenSize: { width, height: 800 },
        viewPosition: { x: 0, y: 0 },
        viewSize: { width, height: 800 },
        deviceScaleFactor: 1,
        scale: 1,
      });
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
