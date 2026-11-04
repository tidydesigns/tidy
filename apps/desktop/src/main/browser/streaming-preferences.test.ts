import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../platform/private-state";
import { BrowserStreamingPreferences } from "./streaming-preferences";
import { BrowserService } from "./browser-service";

test("saved streaming choices survive restart and malformed choices safely disable video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-streaming-choice-"));
  const storage = new PrivateState(directory);
  try {
    await storage.initialize();
    const preferences = new BrowserStreamingPreferences(() => storage);
    await preferences.choose(false);
    const restored = new BrowserStreamingPreferences(() => storage);
    await restored.initialize();
    assert.equal(restored.enabled, false);
    if (process.platform === "linux") {
      await Promise.all([
        preferences.choose(true),
        preferences.choose(false),
        preferences.choose(true),
      ]);
      const latest = new BrowserStreamingPreferences(() => storage);
      await latest.initialize();
      assert.equal(latest.enabled, true);
    }
    await storage.write("browser-streaming", { enabled: "true" });
    const malformed = new BrowserStreamingPreferences(() => storage);
    await malformed.initialize();
    assert.equal(malformed.enabled, false);
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, "unavailable");
    await assert.rejects(preferences.choose(false));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "streaming choices affect new workspaces while preserving existing viewers and host isolation",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    const host = new BrowserService(async () => {});
    const other = new BrowserService(async () => {});
    const first = { projectId: randomUUID(), threadId: randomUUID() };
    const second = { ...first, threadId: randomUUID() };
    try {
      await host.chooseStreaming(false);
      await other.chooseStreaming(false);
      const firstViewer = await host.watch(first, randomUUID(), () => {});
      await host.chooseStreaming(true);
      assert.equal(host.videoForScope(first), false);
      const secondViewer = await host.watch(second, randomUUID(), () => {});
      assert.equal(host.videoForScope(second), true);
      assert.equal((await other.streamingState()).enabled, false);
      await host.chooseStreaming(false);
      assert.equal(host.videoForScope(second), true);
      firstViewer.close();
      secondViewer.close();
      const reopened = await host.watch(second, randomUUID(), () => {});
      assert.equal(host.videoForScope(second), false);
      reopened.close();
    } finally {
      await host.close();
      await other.close();
    }
  },
);
