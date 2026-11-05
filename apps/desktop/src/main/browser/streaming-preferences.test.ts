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
    const keys = [
      "TIDY_VOXL_EXECUTABLE",
      "TIDY_XVFB_EXECUTABLE",
      "TIDY_XRANDR_EXECUTABLE",
      "TIDY_BROWSER_WINDOW_MANAGER_EXECUTABLE",
    ];
    const previous = keys.map((key) => process.env[key]);
    for (const key of keys) process.env[key] = process.execPath;
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
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }
    }
  },
);

test(
  "authoritative reads wait for pending choices and failed verification does not persist enablement",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tidy-streaming-pending-"));
    const storage = new PrivateState(directory);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await storage.initialize();
      const preferences = new BrowserStreamingPreferences(() => storage);
      await preferences.choose(false);
      const write = preferences.choose(true, () => gate);
      let completed = false;
      const read = preferences.current().then((value) => {
        completed = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(completed, false);
      release();
      await write;
      assert.equal(await read, true);
      await preferences.choose(false);
      await assert.rejects(
        preferences.choose(true, async () => {
          throw new Error("Host unavailable");
        }),
        /Host unavailable/,
      );
      assert.equal(await preferences.current(), false);
      const restored = new BrowserStreamingPreferences(() => storage);
      assert.equal(await restored.current(), false);
    } finally {
      release();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "missing streaming prerequisites reject enablement and explain previously saved opt-in",
  { skip: process.platform !== "linux" },
  async () => {
    const keys = [
      "TIDY_VOXL_EXECUTABLE",
      "TIDY_XVFB_EXECUTABLE",
      "TIDY_XRANDR_EXECUTABLE",
      "TIDY_BROWSER_WINDOW_MANAGER_EXECUTABLE",
      "TIDY_BROWSER_EXECUTABLE",
    ];
    const previous = keys.map((key) => process.env[key]);
    const directory = await mkdtemp(join(tmpdir(), "tidy-streaming-tools-"));
    const storage = new PrivateState(directory);
    const service = new BrowserService(
      async () => {},
      () => storage,
    );
    try {
      await storage.initialize();
      await service.chooseStreaming(false);
      for (const key of keys) {
        for (const name of keys) process.env[name] = process.execPath;
        process.env[key] = join(directory, "missing");
        await assert.rejects(service.chooseStreaming(true), /Install or configure/);
        const state = await service.streamingState();
        assert.equal(state.enabled, false);
        assert.ok(state.unavailableReason);
        await storage.write("browser-streaming", { enabled: true });
        const restored = new BrowserService(
          async () => {},
          () => storage,
        );
        try {
          assert.equal((await restored.streamingState()).enabled, true);
          assert.ok((await restored.streamingState()).unavailableReason);
          await restored.chooseStreaming(false);
        } finally {
          await restored.close();
        }
      }
      for (const key of keys) process.env[key] = process.execPath;
      assert.equal((await service.chooseStreaming(true)).enabled, true);
      assert.equal((await service.streamingState()).unavailableReason, undefined);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }
    }
  },
);
