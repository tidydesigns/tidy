import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "puppeteer-core";
import { BrowserScreencast, type BrowserViewer } from "./screencast";
import type { BrowserOutput } from "../../shared/contracts/browser";

// Model Chrome's sendLastFrame mode: only encode when an ACK frees its one slot.
async function fixture() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  let busy = false;
  let latest: Buffer | undefined;
  let encoded = 0;
  const session = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "Page.screencastFrameAck") {
        busy = false;
        flush();
      }
    },
    detach: async () => {},
  });
  const flush = () => {
    if (busy || !latest) return;
    const data = latest;
    latest = undefined;
    busy = true;
    encoded++;
    queueMicrotask(() =>
      session.emit("Page.screencastFrame", { data: data.toString("base64"), sessionId: 1 }),
    );
  };
  const page = {
    bringToFront: async () => {},
    createCDPSession: async () => session,
  } as unknown as Page;
  const state = {
    id: "tab",
    viewId: "view",
    url: "http://localhost",
    title: "Fixture",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    width: 1000,
    height: 700,
    deviceScaleFactor: 2,
  };
  const stream = new BrowserScreencast({
    currentTab: () => ({ page, state }),
    closed: () => false,
  });
  const viewer = () => {
    const frames: Array<Extract<BrowserOutput, { kind: "frame" }>> = [];
    const value: BrowserViewer = {
      id: String(stream.viewers.size),
      visible: true,
      send: (event) => {
        if (event.kind === "frame") frames.push(event);
      },
      inflight: null,
      closed: false,
      view: null,
    };
    stream.viewers.add(value);
    return { value, frames };
  };
  const first = viewer();
  stream.refresh();
  for (let i = 0; i < 10 && !calls.some((call) => call.method === "Page.startScreencast"); i++)
    await Promise.resolve();
  const publish = async (data: Buffer) => {
    latest = data;
    flush();
    await Promise.resolve();
  };
  return { calls, stream, first, viewer, publish, encoded: () => encoded };
}

test("Chrome holds the latest frame while a viewer is busy, without encoding or restarting capture", async () => {
  const { calls, stream, first, publish, encoded } = await fixture();
  try {
    expect(calls.find((call) => call.method === "Page.startScreencast")?.params).toMatchObject({
      maxWidth: 2000,
      maxHeight: 1400,
      quality: 90,
      maxFramesInFlight: 1,
      sendLastFrame: true,
    });
    for (let i = 0; i < 50; i++) await publish(Buffer.from([i]));
    expect(first.frames).toHaveLength(1);
    expect(encoded()).toBe(1);
    stream.acknowledge(first.value, first.frames[0]!.frameId);
    await Promise.resolve();
    expect(first.frames).toHaveLength(2);
    expect(first.frames.at(-1)?.data).toEqual(Buffer.from([49]));
    expect(encoded()).toBe(2);
    expect(calls.filter((call) => call.method === "Page.stopScreencast")).toHaveLength(0);
  } finally {
    await stream.close();
  }
});

test("a stalled viewer cannot block a fast viewer or accumulate encoded frames", async () => {
  const { stream, first, viewer, publish } = await fixture();
  const second = viewer();
  try {
    for (let i = 0; i < 10; i++) {
      await publish(Buffer.from([i]));
      stream.acknowledge(second.value, second.frames.at(-1)!.frameId);
      await Promise.resolve();
    }
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(10);
    stream.acknowledge(first.value, first.frames[0]!.frameId);
    expect(first.frames).toHaveLength(2);
    expect(first.frames[1]?.data).toEqual(Buffer.from([9]));
  } finally {
    await stream.close();
  }
});

test("large frames stay one at a time and stale ACKs cannot release a newer frame", async () => {
  const { calls, stream, first, publish } = await fixture();
  try {
    await publish(Buffer.alloc(5 * 1024 * 1024, 1));
    await publish(Buffer.alloc(5 * 1024 * 1024, 2));
    const old = first.frames[0]!.frameId;
    stream.acknowledge(first.value, old);
    await Promise.resolve();
    expect(first.frames).toHaveLength(2);
    expect(first.frames[1]?.data[0]).toBe(2);
    const acknowledgements = calls.filter(
      (call) => call.method === "Page.screencastFrameAck",
    ).length;
    stream.acknowledge(first.value, old);
    expect(first.value.inflight).toBe(first.frames[1]!.frameId);
    expect(calls.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(
      acknowledgements,
    );
  } finally {
    await stream.close();
  }
});

test("a late viewer gets the cached frame and unblocks Chrome when the original viewer stalls", async () => {
  const { calls, stream, first, viewer, publish } = await fixture();
  try {
    await publish(Buffer.from([1]));
    await publish(Buffer.from([2]));
    const second = viewer();
    stream.refresh();
    await Promise.resolve();
    expect(second.frames[0]?.data).toEqual(Buffer.from([1]));
    stream.acknowledge(second.value, second.frames[0]!.frameId);
    await Promise.resolve();
    expect(second.frames[1]?.data).toEqual(Buffer.from([2]));
    expect(first.frames).toHaveLength(1);
    expect(calls.filter((call) => call.method === "Page.startScreencast")).toHaveLength(1);
  } finally {
    await stream.close();
  }
});
