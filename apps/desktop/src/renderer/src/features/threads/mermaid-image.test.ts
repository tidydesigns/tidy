import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { diagramImage } from "./mermaid-image";
import { renderMermaid } from "./mermaid-renderer";
import { MermaidRenderError } from "./mermaid-error";

async function withSvgDom(check: () => void | Promise<void>) {
  const window = new Window();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["DOMParser", "XMLSerializer"] as const) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
  }
  try {
    await check();
  } finally {
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const image = (content: string, bounds = "0 0 400 180") =>
  diagramImage(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds}" style="max-width:100%;--_s:var(--pele-surface);font:14px Arial">${content}</svg>`,
  );

test("SVG previews preserve natural size, accessible descriptions and isolated theme bindings", async () => {
  await withSvgDom(() => {
    const result = image(
      "<title>Workspace</title><desc>Run to completion</desc><text>王秀英 👩🏽‍💻</text>",
    );
    expect(result.width).toBe(400);
    expect(result.height).toBe(180);
    expect(result.description).toBe("Workspace. Run to completion");
    const xml = decodeURIComponent(result.url.split(",").slice(1).join(","));
    expect(xml).toContain('width="400"');
    expect(xml).not.toContain("max-width");
    expect(xml).toContain("--_s: var(--pele-surface)");
    expect(xml).toContain("font: 14px Arial");
    expect(xml).toContain("--pele-fg: #292929");
    expect(
      decodeURIComponent(
        diagramImage(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text>Dark</text></svg>',
          true,
        ).url,
      ),
    ).toContain("--pele-fg: #ededed");
    expect(image("<g><title>Actor</title><circle r='5'/></g>").description).toContain("Use Code");
  });
});

test("SVG previews reject external resources, invalid dimensions and empty diagram output", async () => {
  await withSvgDom(async () => {
    for (const content of [
      "<defs><marker><path d='M0 0L1 1'/></marker></defs>",
      "<foreignObject><div>Hidden label</div></foreignObject><text>Other</text>",
      '<image href="https://example.invalid/image.png"/>',
    ])
      expect(() => image(content)).toThrow();
    for (const bounds of ["0 0 0 20", "0 0 -1 10", "0 0 NaN 10", "0 0 10 Infinity"])
      expect(() => image("<text>Value</text>", bounds)).toThrow();
    expect(() =>
      diagramImage('<not-svg viewBox="0 0 20 20"><text>Value</text></not-svg>'),
    ).toThrow();
    const empty = renderMermaid({
      source: "flowchart TD\n",
      dark: false,
      signal: new AbortController().signal,
    });
    await expect(empty).rejects.toBeInstanceOf(MermaidRenderError);
    await expect(empty).rejects.toThrow("no content");
  });
});

test("concurrent previews isolate cancellation and reuse a completed render", async () => {
  await withSvgDom(async () => {
    const source = "flowchart LR\n A[Concurrent] --> B[Ready]";
    const controller = new AbortController();
    const cancelled = renderMermaid({ source, dark: false, signal: controller.signal });
    controller.abort();
    const active = () =>
      renderMermaid({ source, dark: false, signal: new AbortController().signal });
    await expect(cancelled).rejects.toThrow();
    const [first, second] = await Promise.all([active(), active()]);
    expect(second).toBe(first);
  });
});
