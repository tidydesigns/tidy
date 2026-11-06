import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserService } from "./browser-service";
import { browserVideoPacket } from "../../shared/browser-video";
import type { BrowserOutput, BrowserScope, BrowserWatch } from "../../shared/contracts/browser";

const enabled = process.env.TIDY_TEST_BROWSER_VIDEO === "1" && !process.versions.bun;

test(
  "video streams preserve sessions, isolate workspaces, handle slow viewers, and fall back per viewer",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const previous = process.env.TIDY_BROWSER_STREAMING;
    process.env.TIDY_BROWSER_STREAMING = "voxl";
    const service = new BrowserService(async () => {});
    const app = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><input id="name"><canvas></canvas><script>const c=document.querySelector("canvas").getContext("2d");let i=0;setInterval(()=>{c.fillStyle=++i%2?"red":"blue";c.fillRect(0,0,200,100)},30)</script>',
      );
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const scope: BrowserScope = { projectId: randomUUID(), threadId: randomUUID() };
    const otherScope = { ...scope, threadId: randomUUID() };
    const watches: BrowserWatch[] = [];
    const outputs: BrowserOutput[] = [];
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(condition(), JSON.stringify(outputs.filter((event) => event.kind === "error")));
    };
    const attach = async (
      scope: BrowserScope,
      receive: (event: BrowserOutput) => void,
      ack = true,
    ) => {
      const connection: { watch?: BrowserWatch } = {};
      connection.watch = await service.watch(scope, randomUUID(), (event) => {
        receive(event);
        if (event.kind === "frame" && ack)
          connection.watch?.input({
            tabId: event.tabId,
            viewId: event.viewId,
            input: { kind: "ack", frameId: event.frameId },
          });
      });
      watches.push(connection.watch);
      return connection.watch;
    };
    try {
      const watch = await attach(scope, (event) => outputs.push(event));
      const opened = await service.command(scope, { kind: "open", url });
      const tab = opened.state.tabs[0];
      assert.ok(tab);
      await waitFor(() =>
        outputs.some((event) => event.kind === "frame" && event.codec === "h264"),
      );
      const first = outputs.find((event) => event.kind === "frame" && event.codec === "h264");
      assert.ok(first?.kind === "frame");
      assert.ok(browserVideoPacket(first.data).key);
      await service.command(scope, {
        kind: "fill",
        tabId: tab.id,
        selector: "#name",
        text: "Session survives reconnect",
      });
      for (let restart = 0; restart < 3; restart++) {
        const beforeRestart = outputs.filter(
          (event) => event.kind === "frame" && event.codec === "h264",
        ).length;
        const children = await promisify(execFile)("ps", [
          "--ppid",
          String(process.pid),
          "-o",
          "pid=,args=",
        ]);
        const streamProcess = children.stdout
          .split("\n")
          .find(
            (line) => line.includes("--audio-enabled=false") && line.includes("--framerate=60"),
          );
        const pid = Number(streamProcess?.trim().split(/\s+/)[0]);
        assert.ok(
          Number.isInteger(pid) && pid > 0,
          "The test's streaming child must be identifiable before fault injection.",
        );
        process.kill(pid, "SIGKILL");
        await waitFor(
          () =>
            outputs.filter((event) => event.kind === "frame" && event.codec === "h264").length >
            beforeRestart + 10,
        );
      }
      watch.close();
      const reconnected: BrowserOutput[] = [];
      const second = await attach(scope, (event) => reconnected.push(event));
      await waitFor(() =>
        reconnected.some((event) => event.kind === "frame" && event.codec === "h264"),
      );
      second.input({
        tabId: tab.id,
        viewId: tab.viewId,
        input: { kind: "visibility", visible: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 10500));
      const shownAt = reconnected.length;
      second.input({
        tabId: tab.id,
        viewId: tab.viewId,
        input: { kind: "visibility", visible: true },
      });
      await waitFor(() =>
        reconnected
          .slice(shownAt)
          .some((event) => event.kind === "frame" && event.codec === "h264"),
      );
      assert.ok(
        !reconnected
          .slice(shownAt)
          .some((event) => event.kind === "stream-status" && event.reason === "unavailable"),
        "A long-hidden viewer must receive a fresh keyframe without an expired waiting timeout.",
      );
      const snapshot = await service.command(scope, { kind: "snapshot", tabId: tab.id });
      assert.ok(snapshot.output?.includes("Session survives reconnect"));
      const other: BrowserOutput[] = [];
      await attach(otherScope, (event) => other.push(event));
      const otherOpened = await service.command(otherScope, { kind: "open", url });
      const otherTab = otherOpened.state.tabs[0];
      assert.ok(otherTab);
      await waitFor(() => other.some((event) => event.kind === "frame"));
      assert.ok(other.every((event) => event.kind !== "frame" || event.tabId === otherTab.id));
      assert.ok(reconnected.every((event) => event.kind !== "frame" || event.tabId === tab.id));
      second.input({ tabId: tab.id, viewId: tab.viewId, input: { kind: "take-control" } });
      for (const [width, height] of [
        [999, 777],
        [1280, 800],
      ]) {
        const beforeResize = reconnected.length;
        second.input({
          tabId: tab.id,
          viewId: tab.viewId,
          input: { kind: "resize", width, height },
        });
        await waitFor(() =>
          reconnected
            .slice(beforeResize)
            .some(
              (event) =>
                event.kind === "state" &&
                event.state.tabs.some((tab) => tab.width === width && tab.height === height),
            ),
        );
        const state = await service.state(scope);
        const resized = state.tabs.find((entry) => entry.id === tab.id);
        assert.ok(resized);
        await waitFor(() =>
          reconnected
            .slice(beforeResize)
            .some(
              (event) =>
                event.kind === "frame" && event.codec === "h264" && event.viewId === resized.viewId,
            ),
        );
      }
      const fallbackAt = reconnected.length;
      second.input({ tabId: tab.id, viewId: tab.viewId, input: { kind: "video-disabled" } });
      await waitFor(() =>
        reconnected.slice(fallbackAt).some((event) => event.kind === "frame" && !event.codec),
      );
      await waitFor(
        () =>
          reconnected.slice(fallbackAt).filter((event) => event.kind === "frame" && !event.codec)
            .length >= 10,
      );
      const jpeg = reconnected
        .slice(fallbackAt)
        .find((event) => event.kind === "frame" && !event.codec);
      assert.ok(jpeg?.kind === "frame");
      assert.equal(jpeg.data[0], 255);
      assert.equal(jpeg.data[1], 216);
      const beforeScreenshot = reconnected.filter(
        (event) => event.kind === "frame" && !event.codec,
      ).length;
      await service.command(scope, { kind: "screenshot", tabId: tab.id });
      const joined: BrowserOutput[] = [];
      await attach(scope, (event) => joined.push(event));
      await waitFor(() => joined.some((event) => event.kind === "frame" && event.codec === "h264"));
      await waitFor(
        () =>
          reconnected.filter((event) => event.kind === "frame" && !event.codec).length >
          beforeScreenshot + 10,
      );
      const delayed: { watch?: BrowserWatch } = {};
      const timers = new Set<ReturnType<typeof setTimeout>>();
      delayed.watch = await attach(
        scope,
        (event) => {
          if (event.kind !== "frame") return;
          const timer = setTimeout(() => {
            timers.delete(timer);
            delayed.watch?.input({
              tabId: event.tabId,
              viewId: event.viewId,
              input: { kind: "ack", frameId: event.frameId },
            });
          }, 350);
          timers.add(timer);
        },
        false,
      );
      const fastBefore = joined.filter(
        (event) => event.kind === "frame" && event.codec === "h264",
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      for (const timer of timers) clearTimeout(timer);
      delayed.watch.close();
      assert.ok(
        joined.filter((event) => event.kind === "frame" && event.codec === "h264").length >
          fastBefore + 35,
        "A continuously slow acknowledging viewer must not gate the healthy viewer.",
      );
      const cold: BrowserOutput[] = [];
      let coldWatch: BrowserWatch | undefined;
      let firstAck: ReturnType<typeof setTimeout> | undefined;
      let primed = false;
      let primingFrames = 0;
      try {
        coldWatch = await attach(
          scope,
          (event) => {
            cold.push(event);
            if (event.kind !== "frame") return;
            const acknowledge = () =>
              coldWatch?.input({
                tabId: event.tabId,
                viewId: event.viewId,
                input: { kind: "ack", frameId: event.frameId },
              });
            if (event.codec === "h264" && !primed) {
              if (firstAck === undefined)
                firstAck = setTimeout(() => {
                  primingFrames = cold.filter(
                    (event) => event.kind === "frame" && event.codec === "h264",
                  ).length;
                  primed = true;
                  acknowledge();
                }, 2000);
            } else acknowledge();
          },
          false,
        );
        await waitFor(() => firstAck !== undefined);
        const healthyBefore = joined.filter(
          (event) => event.kind === "frame" && event.codec === "h264",
        ).length;
        await new Promise((resolve) => setTimeout(resolve, 1800));
        assert.ok(
          cold.filter((event) => event.kind === "frame" && event.codec === "h264").length <= 48,
        );
        assert.ok(
          joined.filter((event) => event.kind === "frame" && event.codec === "h264").length >
            healthyBefore + 30,
          "A cold decoder must not gate an already healthy viewer.",
        );
        await waitFor(
          () =>
            primed &&
            cold.filter((event) => event.kind === "frame" && event.codec === "h264").length >
              primingFrames + 2,
        );
        const resumed = cold.filter(
          (event): event is Extract<BrowserOutput, { kind: "frame" }> =>
            event.kind === "frame" && event.codec === "h264",
        );
        const initial = resumed[0];
        assert.equal(
          primingFrames,
          48,
          "The cold decoder must exercise the bounded priming pause.",
        );
        const next = resumed[primingFrames];
        assert.ok(initial && next);
        assert.ok(
          browserVideoPacket(next.data).key,
          "Skipped deltas require a fresh keyframe after priming.",
        );
        const primingIndex = cold.indexOf(initial);
        assert.ok(
          !cold
            .slice(primingIndex)
            .some(
              (event) =>
                (event.kind === "frame" && !event.codec) ||
                (event.kind === "stream-status" && event.mode === "jpeg"),
            ),
          "A two-second decoder startup must not trigger JPEG fallback.",
        );
      } finally {
        if (firstAck !== undefined) clearTimeout(firstAck);
        coldWatch?.close();
      }
    } finally {
      for (const watch of watches) watch.close();
      await service.close();
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
      if (previous === undefined) delete process.env.TIDY_BROWSER_STREAMING;
      else process.env.TIDY_BROWSER_STREAMING = previous;
    }
  },
);

test(
  "native video dependencies removed after enablement preserve a usable JPEG browser",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const server = createServer((_request, response) =>
      response.end(
        '<!doctype html><input id="name"><script>setInterval(()=>document.body.style.background=Date.now()%2?"white":"#eee",30)</script>',
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      for (const key of [
        "TIDY_VOXL_EXECUTABLE",
        "TIDY_XVFB_EXECUTABLE",
        "TIDY_XRANDR_EXECUTABLE",
        "TIDY_BROWSER_WINDOW_MANAGER_EXECUTABLE",
      ]) {
        const previous = process.env[key];
        const service = new BrowserService(async () => {});
        await service.chooseStreaming(true);
        process.env[key] = "/missing-native-video-fixture";
        const scope = { projectId: randomUUID(), threadId: randomUUID() };
        let jpeg = 0;
        let reason = "";
        const watched = await service.watch(scope, randomUUID(), (event) => {
          if (event.kind === "frame" && !event.codec) jpeg++;
          if (event.kind === "stream-status") reason = event.reason;
        });
        try {
          const opened = await service.command(scope, {
            kind: "open",
            url: `http://127.0.0.1:${address.port}`,
          });
          const tab = opened.state.tabs[0];
          assert.ok(tab);
          const deadline = Date.now() + 10000;
          while ((!jpeg || reason !== "unavailable") && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 20));
          assert.ok(jpeg > 0, `${key}: JPEG must still render`);
          assert.equal(reason, "unavailable");
          await service.command(scope, {
            kind: "fill",
            tabId: tab.id,
            selector: "#name",
            text: "Fallback stays interactive",
          });
          const snapshot = await service.command(scope, { kind: "snapshot", tabId: tab.id });
          assert.ok(snapshot.output?.includes("Fallback stays interactive"));
        } finally {
          watched.close();
          await service.close();
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "existing JPEG workspaces do not consume the video workspace allowance",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Workspace limit</title>"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const service = new BrowserService(async () => {});
    try {
      await service.chooseStreaming(false);
      for (let index = 0; index < 4; index++)
        await service.command(
          { projectId: randomUUID(), threadId: randomUUID() },
          { kind: "open", url: `http://127.0.0.1:${address.port}` },
        );
      await service.chooseStreaming(true);
      const opened = await service.command(
        { projectId: randomUUID(), threadId: randomUUID() },
        { kind: "open", url: `http://127.0.0.1:${address.port}` },
      );
      assert.equal(opened.state.tabs.length, 1);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
