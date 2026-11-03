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
      const first = outputs.find((event) => event.kind === "frame");
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
      let slowFrames = 0;
      const slow = await attach(
        scope,
        (event) => {
          if (event.kind === "frame") slowFrames++;
        },
        false,
      );
      await waitFor(() => slowFrames >= 3);
      const before = reconnected.filter((event) => event.kind === "frame").length;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.ok(reconnected.filter((event) => event.kind === "frame").length > before + 10);
      slow.close();
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
