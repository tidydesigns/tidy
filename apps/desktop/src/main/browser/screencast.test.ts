import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "puppeteer-core";
import { BrowserScreencast, type BrowserViewer } from "./screencast";
import type { BrowserOutput } from "../../shared/contracts/browser";

async function fixture() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const session = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
    },
    detach: async () => {},
  });
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
  const frames: Array<Extract<BrowserOutput, { kind: "frame" }>> = [];
  const viewer: BrowserViewer = {
    id: "viewer",
    visible: true,
    send: (event) => {
      if (event.kind === "frame") frames.push(event);
    },
    inflight: new Map(),
    closed: false,
    view: null,
  };
  stream.viewers.add(viewer);
  stream.refresh();
  for (let i = 0; i < 10 && !calls.some((call) => call.method === "Page.startScreencast"); i++)
    await Promise.resolve();
  const publish = (data: Buffer) =>
    session.emit("Page.screencastFrame", { data: data.toString("base64"), sessionId: 1 });
  return { calls, stream, viewer, frames, publish };
}

test("capture uses Retina dimensions and keeps running through brief credit exhaustion", async () => {
  const { calls, stream, viewer, frames, publish } = await fixture();
  try {
    expect(calls.find((call) => call.method === "Page.startScreencast")?.params).toMatchObject({
      maxWidth: 2000,
      maxHeight: 1400,
      quality: 90,
    });
    for (let i = 0; i < 50; i++) publish(Buffer.from([i]));
    expect(frames).toHaveLength(3);
    expect(calls.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(50);
    expect(calls.filter((call) => call.method === "Page.stopScreencast")).toHaveLength(0);
    stream.acknowledge(viewer, frames[0]!.frameId);
    expect(frames.at(-1)?.data).toEqual(Buffer.from([49]));
    expect(viewer.inflight.size).toBe(3);
  } finally {
    await stream.close();
  }
});

test("large frames obey byte credits while a stalled viewer pauses and resumes capture", async () => {
  const { calls, stream, viewer, frames, publish } = await fixture();
  try {
    publish(Buffer.alloc(5 * 1024 * 1024, 1));
    publish(Buffer.alloc(5 * 1024 * 1024, 2));
    expect(frames).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(calls.filter((call) => call.method === "Page.stopScreencast")).toHaveLength(1);
    stream.acknowledge(viewer, frames[0]!.frameId);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.data[0]).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.method === "Page.startScreencast")).toHaveLength(2);
  } finally {
    await stream.close();
  }
});
