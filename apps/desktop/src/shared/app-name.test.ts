import { expect, test } from "bun:test";
import { desktopAppName, desktopMacIcon } from "./app-name";

test("macOS beta names and native assets stay on the same channel across releases", () => {
  for (const version of ["0.1.0-beta.1", "0.1.0-beta.99", "2.0.0-beta.420"]) {
    expect(desktopAppName(version, "darwin")).toBe("Tidy (Beta)");
    expect(desktopMacIcon(version, "icns")).toBe("icon-beta.icns");
    expect(desktopMacIcon(version, "png")).toBe("icon-macos-beta.png");
  }
  for (const version of ["0.1.0", "1.0.0", "2.10.4"]) {
    expect(desktopAppName(version, "darwin")).toBe("Tidy");
    expect(desktopMacIcon(version, "icns")).toBe("icon.icns");
    expect(desktopMacIcon(version, "png")).toBe("icon-macos.png");
  }
  for (const platform of ["win32", "linux"] as const)
    expect(desktopAppName("0.1.0-beta.99", platform)).toBe("Tidy");
});
