import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { Browser, BrowserContext } from "puppeteer-core";
import { blankDesignDocument } from "@tidy/design/document";
import { CloudCompute } from "../cloud/cloud-compute";
import { CloudComputeBusyError } from "../cloud/cloud-compute-errors";
import { BrowserRuntime } from "../browser/runtime";
import { CanvasRenderer } from "./render-service";
import type { CanvasSnapshot } from "./canvas-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  mock.restore();
});

test("cancelled markup releases preview admission while outstanding worker jobs stay bounded", async () => {
  const postMessage = Worker.prototype.postMessage;
  const held: { worker: Worker; message: unknown }[] = [];
  spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message) {
    if (
      typeof message === "object" &&
      message !== null &&
      "kind" in message &&
      message.kind === "render-markup"
    ) {
      held.push({ worker: this, message });
      return;
    }
    postMessage.call(this, message);
  });
  const get = spyOn(BrowserRuntime.prototype, "get");
  const renderer = new CanvasRenderer();
  cleanups.push(() => renderer.close());
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const pending = renderer.render({ ...snapshot(), signal: controller.signal });
    expect(held).toHaveLength(attempt + 1);
    controller.abort(new Error("Markup cancelled"));
    await expect(pending).rejects.toThrow("Markup cancelled");
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    await expect(renderer.render(snapshot())).rejects.toBeInstanceOf(CloudComputeBusyError);
  }
  expect(held).toHaveLength(4);
  expect(get).not.toHaveBeenCalled();
  const worker = held[0].worker;
  const drained = Promise.withResolvers<void>();
  let remaining = held.length;
  const received = () => {
    if (--remaining === 0) {
      worker.removeListener("message", received);
      drained.resolve();
    }
  };
  worker.on("message", received);
  for (const job of held) postMessage.call(job.worker, job.message);
  await drained.promise;
  const entered = Promise.withResolvers<void>();
  const startup = Promise.withResolvers<Browser>();
  get.mockImplementation(() => {
    entered.resolve();
    return startup.promise;
  });
  const controller = new AbortController();
  const pending = renderer.render({ ...snapshot(), signal: controller.signal });
  expect(held).toHaveLength(5);
  postMessage.call(held[4].worker, held[4].message);
  await entered.promise;
  controller.abort(new Error("Recovered preview cancelled"));
  await expect(pending).rejects.toThrow("Recovered preview cancelled");
  startup.reject(new Error("Late startup failure"));
  await startup.promise.catch(() => {});
});

test("cancelled browser startup releases the render gate without closing shared startup", async () => {
  const startup = Promise.withResolvers<Browser>();
  let entered = Promise.withResolvers<void>();
  spyOn(CloudCompute.prototype, "renderMarkup").mockResolvedValue("<div></div>");
  const get = spyOn(BrowserRuntime.prototype, "get").mockImplementation(() => {
    entered.resolve();
    return startup.promise;
  });
  const close = spyOn(BrowserRuntime.prototype, "close");
  const renderer = new CanvasRenderer();
  cleanups.push(() => renderer.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const pending = renderer.render({ ...snapshot(), signal: controller.signal });
    await entered.promise;
    controller.abort(new Error("Preview cancelled"));
    await expect(pending).rejects.toThrow("Preview cancelled");
    entered = Promise.withResolvers<void>();
  }
  expect(get).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
  startup.reject(new Error("Late startup failure"));
  await startup.promise.catch(() => {});
});

test("a browser context created after cancellation is closed once", async () => {
  const creation = Promise.withResolvers<BrowserContext>();
  const entered = Promise.withResolvers<void>();
  const close = mock(async () => {});
  const context = { close } as unknown as BrowserContext;
  const browser = {
    createBrowserContext: () => {
      entered.resolve();
      return creation.promise;
    },
  } as Browser;
  spyOn(CloudCompute.prototype, "renderMarkup").mockResolvedValue("<div></div>");
  spyOn(BrowserRuntime.prototype, "get").mockResolvedValue(browser);
  const renderer = new CanvasRenderer();
  cleanups.push(() => renderer.close());
  const controller = new AbortController();
  const pending = renderer.render({ ...snapshot(), signal: controller.signal });
  await entered.promise;
  controller.abort(new Error("Preview cancelled"));
  await expect(pending).rejects.toThrow("Preview cancelled");
  creation.resolve(context);
  await creation.promise;
  expect(close).toHaveBeenCalledTimes(1);
});
function snapshot(): CanvasSnapshot {
  const document = blankDesignDocument();
  document.nodes.push({
    id: "frame",
    parentId: null,
    pageId: document.pages[0].id,
    type: "artboard",
    name: "Frame",
    visible: true,
    locked: false,
    box: { x: 0, y: 0, width: 320, height: 180 },
    layout: "absolute",
    style: { fill: "#ffffff" },
  });
  return {
    document,
    rootId: document.nodes[0].id,
    projectId: "project",
    designId: "design",
    version: "revision",
    signal: new AbortController().signal,
    assets: {},
    width: 320,
    warnings: [],
  };
}
test("the packaged design worker prepares edits and shared-renderer markup away from the host", async () => {
  const worker = new CloudCompute(4);
  cleanups.push(() => worker.close());
  const value = snapshot();
  const updated = await worker.prepareCanvas(value.document, [
    { kind: "update", node_ids: [value.rootId], changes: { name: "Worker frame" } },
  ]);
  expect(updated.nodes[0].name).toBe("Worker frame");
  expect(value.document.nodes[0].name).not.toBe("Worker frame");
  const markup = await worker.renderMarkup(value);
  expect(markup).toContain("width:320px");
  expect(markup).toContain("height:180px");
  expect(markup).not.toContain("<script");
});
const browserTest = process.env.TIDY_TEST_CANVAS_BROWSER === "1" ? test : test.skip;
browserTest(
  "a real isolated browser renders a bounded PNG without changing the source document",
  async () => {
    const renderer = new CanvasRenderer();
    cleanups.push(() => renderer.close());
    const value = snapshot();
    const before = JSON.stringify(value.document);
    const result = await renderer.render(value);
    expect(result.kind).toBe("rendered");
    expect(result.width).toBe(320);
    expect(Buffer.from(result.data, "base64").subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect(result.limitations.length).toBeGreaterThan(0);
    expect(JSON.stringify(value.document)).toBe(before);
  },
  60_000,
);
