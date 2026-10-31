import { expect, test } from "bun:test";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CodeRow } from "./file-rows";
import { useVirtualWindow } from "./virtual-window";
import { rowAtOffset, useMeasuredWindow } from "./measured-window";

test("ignores horizontal scrolling and coalesces vertical events into one bounded window", async () => {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const node = document.createElement("div");
  Object.defineProperty(node, "clientHeight", { value: 480 });
  const root = createRoot(document.createElement("div"));
  let renders = 0;
  let current: ReturnType<typeof useVirtualWindow> | undefined;
  function Probe() {
    current = useVirtualWindow(20000, 24);
    renders++;
    useLayoutEffect(() => {
      current?.attach(node);
      return () => current?.attach(null);
    }, []);
    return null;
  }
  const flush = async () =>
    act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  try {
    await act(async () => root.render(createElement(Probe)));
    const baseline = renders;
    node.scrollLeft = 100;
    node.dispatchEvent(new Event("scroll"));
    await flush();
    expect(renders).toBe(baseline);
    for (let index = 1; index <= 100; index++) {
      node.scrollTop = index * 240;
      node.dispatchEvent(new Event("scroll"));
    }
    expect(frames.size).toBe(1);
    await flush();
    expect(renders).toBe(baseline + 1);
    expect(current?.start).toBe(992);
    expect((current?.end ?? 0) - (current?.start ?? 0)).toBeLessThanOrEqual(36);
    node.dispatchEvent(new Event("scroll"));
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    expect(frames.size).toBe(0);
  }
});

test("measured rows retain the visible anchor and discard measurements for a different file", async () => {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const observers = new Set<Observer>();
  class Observer {
    targets = new Set<Element>();
    constructor(
      readonly callback: (
        entries: { target: Element; borderBoxSize: { blockSize: number }[] }[],
      ) => void,
    ) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  }
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    ResizeObserver: Observer,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const node = document.createElement("div");
  Object.defineProperties(node, { clientHeight: { value: 480 }, clientWidth: { value: 600 } });
  const row = document.createElement("div");
  row.dataset.row = "94";
  let rowHeight = 24;
  Object.defineProperty(row, "getBoundingClientRect", { value: () => ({ height: rowHeight }) });
  node.append(row);
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<typeof useMeasuredWindow> | undefined;
  function Probe({ rows }: { rows: readonly CodeRow[] }) {
    current = useMeasuredWindow(rows);
    useLayoutEffect(() => {
      current?.attach(node);
      return () => current?.attach(null);
    }, []);
    return null;
  }
  const flush = async () =>
    act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  try {
    const rows = Array.from({ length: 20000 }, (): CodeRow => ({
      kind: "lines",
      before: null,
      after: null,
      changed: false,
    }));
    await act(async () => root.render(createElement(Probe, { rows })));
    await flush();
    node.scrollTop = 2400;
    node.dispatchEvent(new Event("scroll"));
    await flush();
    expect(current?.first).toBe(100);
    rowHeight = 72;
    for (const observer of [...observers])
      if (observer.targets.has(row))
        observer.callback([{ target: row, borderBoxSize: [{ blockSize: 72 }] }]);
    await flush();
    expect(node.scrollTop).toBe(2448);
    expect(current && rowAtOffset(current.offsets, node.scrollTop)).toBe(100);
    expect((current?.end ?? 0) - (current?.start ?? 0)).toBeLessThan(40);
    rowHeight = 24;
    await act(async () =>
      root.render(
        createElement(Probe, {
          rows: Array.from({ length: 200 }, (): CodeRow => ({
            kind: "lines",
            before: null,
            after: null,
            changed: false,
          })),
        }),
      ),
    );
    expect(current?.offsets[100]).toBe(2400);
    await act(async () =>
      root.render(
        createElement(Probe, {
          rows: Array.from({ length: 1000 }, (): CodeRow => ({
            kind: "lines",
            before: null,
            after: { text: "x".repeat(3000), number: 1 },
            changed: false,
          })),
        }),
      ),
    );
    expect((current?.end ?? 0) - (current?.start ?? 0)).toBeLessThan(6);
    expect(current?.first).toBe(current && rowAtOffset(current.offsets, node.scrollTop));
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    expect(observers.size).toBe(0);
    expect(frames.size).toBe(0);
  }
});
