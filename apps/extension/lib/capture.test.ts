import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { parseDesignDocument } from "@bella/design/document";
import { captureElement, cssColor } from "./capture";

type Listener = (
  message: { type: string; mode?: string },
  sender: { id: string },
  respond: (value: unknown) => void,
) => unknown;
const listeners = new Set<Listener>();
const sent = mock(async (_message: object) => {
  void _message;
  return true;
});
mock.module("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "bella-test",
      sendMessage: sent,
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  },
}));
const { default: contentScript } = await import("../entrypoints/capture.content");

let win: Window;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  listeners.clear();
  sent.mockClear();
  win = new Window({
    url: "https://example.com/page?token=private#secret",
    width: 1000,
    height: 800,
  });
  for (const name of [
    "window",
    "document",
    "location",
    "Element",
    "Node",
    "DOMRect",
    "Image",
    "HTMLCanvasElement",
    "HTMLImageElement",
    "getComputedStyle",
  ]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      name === "window"
        ? win
        : name === "getComputedStyle"
          ? win.getComputedStyle.bind(win)
          : (win as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(win.Range.prototype, "getBoundingClientRect", {
    value: () => new win.DOMRect(120, 140, 150, 24),
    configurable: true,
  });
});
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  void win.happyDOM.close();
});
function bounds(element: Element, x: number, y: number, width: number, height: number) {
  element.getBoundingClientRect = () => new win.DOMRect(x, y, width, height) as unknown as DOMRect;
}

describe("rendered webpage capture", () => {
  test("converts an element into editable layers with local positions and excludes form values", async () => {
    win.document.body.innerHTML =
      '<section id="card" style="background:rgb(255,255,255)"><h1 style="font-size:24px;color:rgb(20,20,20)">Hello Bella</h1><input value="private-password"><script>secret</script></section>';
    const root = win.document.querySelector("section")!;
    bounds(root as unknown as Element, 100, 100, 400, 300);
    bounds(win.document.querySelector("h1")! as unknown as Element, 120, 140, 150, 24);
    const capture = await captureElement(root as unknown as Element, "element");
    const parsed = parseDesignDocument(capture.document);
    const text = parsed.nodes.find((node) => node.type === "text")!;
    expect(text.text).toBe("Hello Bella");
    expect(text.box).toEqual({ x: 20, y: 40, width: 150, height: 24 });
    expect(text.style.fontSize).toBe(24);
    expect(capture.url).toBe("https://example.com/page");
    expect(JSON.stringify(capture)).not.toContain("private-password");
    expect(parsed.warnings.some((warning) => warning.message.includes("Form values"))).toBe(true);
  });
  test("imports gradient stacks as editable fills in paint order and warns on unsupported forms", async () => {
    win.document.body.innerHTML =
      '<section id="gradients" style="background-color:rgb(255,255,255);background-image:linear-gradient(90deg, rgba(255,0,0,0.5), rgba(0,0,255,0)),radial-gradient(ellipse 80px 20px at 25% 40%, rgb(0,255,0), rgb(0,0,255))"><span>Editable text</span></section>';
    const root = win.document.querySelector("section")!;
    bounds(root as unknown as Element, 100, 100, 400, 200);
    const capture = await captureElement(root as unknown as Element, "element");
    const parsed = parseDesignDocument(capture.document);
    const fills = parsed.nodes.find(
      (node) => node.name === "gradients" && node.type === "container",
    )!.style.paints!;
    expect(fills.map((paint) => paint.type)).toEqual(["linear", "radial", "solid"]);
    expect(fills[0]).toMatchObject({ stops: [{ color: "#ff000080" }, { color: "#0000ff00" }] });
    expect(fills[1]).toMatchObject({ centerX: 0.25, centerY: 0.4, radiusX: 0.2, radiusY: 0.1 });
    expect(parsed.nodes.some((node) => node.text === "Editable text")).toBe(true);
    expect(parsed.warnings.some((warning) => warning.message.includes("gradient"))).toBe(false);
    root.style.backgroundImage = "repeating-linear-gradient(rgb(255,0,0), rgb(0,0,255))";
    const unsupported = await captureElement(root as unknown as Element, "element");
    expect(
      unsupported.document.warnings.some((warning) =>
        warning.message.includes("Unsupported CSS gradients"),
      ),
    ).toBe(true);
  });
  test("splits a long page into valid frames instead of truncating its height", async () => {
    Object.defineProperty(win.document.documentElement, "scrollHeight", { value: 12000 });
    const capture = await captureElement(win.document.body as unknown as Element, "page");
    const frames = parseDesignDocument(capture.document).nodes.filter(
      (node) => node.type === "artboard",
    );
    expect(frames.map((node) => node.box.height)).toEqual([5000, 5000, 2000]);
    expect(frames[1].box.x).toBe(1120);
  });
  test("preserves color alpha and omits fully transparent fills", () => {
    expect(cssColor("rgba(10, 20, 30, 0.5)")).toBe("#0a141e80");
    expect(cssColor("rgba(0, 0, 0, 0)")).toBeUndefined();
    expect(cssColor("rgb(255 100 0 / 50%)")).toBe("#ff640080");
  });
  test("element selection prevents website navigation and cleans up immediately", () => {
    win.document.body.innerHTML = '<a href="/other">Link</a>';
    const invalidated: (() => void)[] = [];
    contentScript.main({
      onInvalidated: (callback: () => void) => invalidated.push(callback),
    } as never);
    const listener = [...listeners][0];
    listener({ type: "bella:pick" }, { id: "bella-test" }, () => {});
    const link = win.document.querySelector("a")!;
    link.dispatchEvent(new win.PointerEvent("pointermove", { bubbles: true, composed: true }));
    const navigated = link.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }),
    );
    expect(navigated).toBe(false);
    expect(sent).toHaveBeenCalledWith({ type: "bella:picked" });
    expect(win.document.querySelector("[data-bella-picker]")).toBeNull();
    for (const callback of invalidated) callback();
    expect(listeners.size).toBe(0);
  });
  test("Escape cancels selection and invalidation removes the picker listener", () => {
    const invalidated: (() => void)[] = [];
    contentScript.main({
      onInvalidated: (callback: () => void) => invalidated.push(callback),
    } as never);
    const listener = [...listeners][0];
    listener({ type: "bella:pick" }, { id: "bella-test" }, () => {});
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(sent).toHaveBeenCalledWith({ type: "bella:cancelled" });
    expect(win.document.querySelector("[data-bella-picker]")).toBeNull();
    listener({ type: "bella:pick" }, { id: "bella-test" }, () => {});
    expect(win.document.querySelector("[data-bella-picker]")).not.toBeNull();
    for (const callback of invalidated) callback();
    expect(listeners.size).toBe(0);
    expect(win.document.querySelector("[data-bella-picker]")).toBeNull();
  });
});

describe("effect screenshot fallbacks", () => {
  function screenshotCanvas() {
    const drawImage = mock(() => {}),
      fillRect = mock(() => {});
    Object.defineProperty(win.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage, fillRect, fillStyle: "" }),
    });
    Object.defineProperty(win.HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: () => "data:image/png;base64,aGVsbG8=",
    });
    Object.defineProperty(win.HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: async () => {},
    });
    Object.defineProperty(win.HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(win.HTMLImageElement.prototype, "naturalHeight", {
      configurable: true,
      get: () => 1600,
    });
    return { drawImage, fillRect };
  }
  test("perspective captures the rendered composite once, including overflowing children", async () => {
    const { drawImage } = screenshotCanvas();
    win.document.body.innerHTML =
      '<section><h1>Editable heading</h1><div id="laptop" style="perspective:800px;opacity:0.5;border-radius:12px"><div id="screen">Flattened screen</div></div></section>';
    const root = win.document.querySelector("section")!;
    bounds(root as unknown as Element, 0, 0, 1000, 800);
    bounds(win.document.querySelector("#laptop")! as unknown as Element, 200, 250, 400, 0);
    bounds(win.document.querySelector("#screen")! as unknown as Element, 180, 240, 450, 300);
    const capture = await captureElement(
      root as unknown as Element,
      "element",
      "data:image/png;base64,aGVsbG8=",
    );
    const parsed = parseDesignDocument(capture.document);
    const raster = parsed.nodes.find((node) => node.type === "image")!;
    expect(raster.box).toEqual({ x: 180, y: 240, width: 450, height: 300 });
    expect(raster.style).toEqual({ objectFit: "fill" }); // No second opacity, border or shadow.
    expect(parsed.nodes.filter((node) => node.type === "text").map((node) => node.text)).toEqual([
      "Editable heading",
    ]);
    expect(capture.assets).toHaveLength(1);
    expect(drawImage.mock.calls[0].slice(1)).toEqual([360, 480, 900, 600, 0, 0, 900, 600]);
    expect(parsed.warnings.some((item) => item.message.includes("3D perspective flattened"))).toBe(
      true,
    );
  });
  test("redacts controls outside the subtree that overlap a screenshot crop", async () => {
    const { fillRect } = screenshotCanvas();
    win.document.body.innerHTML =
      '<div id="laptop" style="perspective:800px"></div><input value="secret"><div id="shadow"></div>';
    const root = win.document.querySelector("#laptop")!;
    bounds(root as unknown as Element, 100, 100, 500, 400);
    bounds(win.document.querySelector("input")! as unknown as Element, 150, 150, 100, 30);
    const shadow = win.document.querySelector("#shadow")!.attachShadow({ mode: "open" });
    shadow.innerHTML = "<textarea>private</textarea>";
    bounds(shadow.querySelector("textarea")! as unknown as Element, 300, 150, 100, 30);
    const capture = await captureElement(
      root as unknown as Element,
      "element",
      "data:image/png;base64,aGVsbG8=",
    );
    expect(fillRect).toHaveBeenCalledTimes(2);
    expect(capture.document.warnings.some((item) => item.message.includes("redacted"))).toBe(true);
    expect(JSON.stringify(capture)).not.toContain("secret");
  });
  test("warns when a perspective scene is clipped by the viewport", async () => {
    screenshotCanvas();
    win.document.body.innerHTML = '<div style="perspective:800px"></div>';
    const root = win.document.querySelector("div")!;
    bounds(root as unknown as Element, 100, 600, 400, 400);
    const capture = await captureElement(
      root as unknown as Element,
      "element",
      "data:image/png;base64,aGVsbG8=",
    );
    expect(capture.document.nodes.find((node) => node.type === "image")?.box.height).toBe(200);
    expect(
      capture.document.warnings.some((item) =>
        item.message.includes("Offscreen content was omitted"),
      ),
    ).toBe(true);
  });
  test("rejects a stale screenshot rather than using pixels from a different scroll position", async () => {
    const { drawImage } = screenshotCanvas();
    win.document.body.innerHTML = '<div style="perspective:800px"></div>';
    const root = win.document.querySelector("div")!;
    bounds(root as unknown as Element, 100, 100, 400, 300);
    const capture = await captureElement(
      root as unknown as Element,
      "element",
      "data:image/png;base64,aGVsbG8=",
      { width: 1000, height: 800, scrollX: 0, scrollY: 200 },
    );
    expect(drawImage).not.toHaveBeenCalled();
    expect(
      capture.document.warnings.some((item) => item.message.includes("could not be rasterized")),
    ).toBe(true);
  });
  test("sorts decorative siblings behind content with a higher z-index", async () => {
    win.document.body.innerHTML =
      '<section><div style="position:relative;z-index:4">CTA</div><div style="position:absolute;z-index:0;background:#00ff00"></div></section>';
    const root = win.document.querySelector("section")!;
    bounds(root as unknown as Element, 0, 0, 1000, 800);
    for (const element of root.children) bounds(element as unknown as Element, 100, 100, 400, 300);
    const capture = await captureElement(root as unknown as Element, "element");
    expect(capture.document.nodes.at(-1)?.text).toBe("CTA");
  });
});
