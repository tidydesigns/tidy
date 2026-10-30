import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserInstallBusyError, lockBrowserInstall } from "./install-lock";

test("browser installation uses a real exclusive lock and releases it for the next installer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-browser-install-lock-"));
  try {
    const release = lockBrowserInstall(join(directory, "install.lock"));
    try {
      expect(() => lockBrowserInstall(join(directory, "install.lock"))).toThrow(
        BrowserInstallBusyError,
      );
    } finally {
      release();
    }
    const next = lockBrowserInstall(join(directory, "install.lock"));
    next();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
