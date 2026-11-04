import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignDocument,
} from "@tidy/design/document";
import { PreviewCamera } from "../../features/designs/thread-preview/camera";
import type { PreviewCameraMemory } from "../../features/designs/thread-preview/navigation";

function NavigationFixture({
  content,
  memory,
  pageId,
  width,
}: {
  content: DesignDocument;
  memory: PreviewCameraMemory;
  pageId: string;
  width: number;
}) {
  const surface = useRef<HTMLButtonElement>(null);
  const suppressClick = useRef(false);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => setReady(true), []);
  return (
    <button
      ref={surface}
      data-navigation-preview
      style={{ position: "relative", display: "block", width, height: 200, padding: 0, border: 0 }}
    >
      {ready && (
        <PreviewCamera
          value={{
            id: "navigation",
            name: "Navigation",
            path: "/fixtures/navigation.json",
            updatedAt: "2026-11-04T10:00:00.000Z",
            version: "1",
            document: content,
            assets: {},
          }}
          memory={memory}
          surface={surface}
          suppressClick={suppressClick}
          enabled
          pageId={pageId}
          onError={(error) => {
            throw error;
          }}
        />
      )}
    </button>
  );
}

export async function runPreviewNavigationTests(root: Root, host: HTMLElement) {
  const memory: PreviewCameraMemory = {};
  const first = buildDrawnNode("first", "artboard", null, { x: 0, y: 0, width: 280, height: 150 });
  const second = buildDrawnNode("second", "artboard", null, {
    x: 0,
    y: 0,
    width: 400,
    height: 1000,
  });
  second.pageId = "page-2";
  const content = parseDesignDocument({
    ...blankDesignDocument(),
    pages: [
      { id: "page-1", name: "First" },
      { id: "page-2", name: "Second" },
    ],
    nodes: [first, second],
  });
  async function until(predicate: () => boolean) {
    const deadline = performance.now() + 3000;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error(`Navigation did not settle: ${JSON.stringify(memory.current)}`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }
  function render(key: string, pageId: string, document = content, width = 280) {
    flushSync(() =>
      root.render(
        <NavigationFixture
          key={key}
          content={document}
          memory={memory}
          pageId={pageId}
          width={width}
        />,
      ),
    );
  }
  const zoomIs = (zoom: number) => Math.abs((memory.current?.zoom ?? 0) - zoom) < 0.001;
  render("first-open", "page-1");
  await until(() => zoomIs(280 / 328));
  render("second-open", "page-2");
  await until(() => zoomIs(200 / 1064));
  const enlarged = parseDesignDocument({
    ...content,
    nodes: [{ ...first, box: { ...first.box, height: 700 } }, second],
  });
  render("first-reopened", "page-1", enlarged);
  await until(() => zoomIs(200 / 748));
  render("first-reopened", "page-1", content);
  await until(() => zoomIs(280 / 328));
  render("first-reopened", "page-1", content, 160);
  await until(() => zoomIs(160 / 328));
  const surface = host.querySelector<HTMLButtonElement>("[data-navigation-preview]");
  if (!surface) throw new Error("Missing navigation surface");
  surface.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      clientX: 80,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    }),
  );
  const navigated = memory.current;
  if (!navigated || memory.autoFitted?.has(navigated))
    throw new Error("Wheel navigation retained automatic camera tracking");
  render("second-reopened", "page-2");
  await until(() => zoomIs(200 / 1064));
  render("first-manual-restored", "page-1", enlarged, 320);
  await until(
    () => host.querySelector("[data-preview-page]")?.getAttribute("data-preview-page") === "page-1",
  );
  if (memory.current !== navigated)
    throw new Error("Reopening a page discarded its manually navigated camera");
  render("first-manual-restored", "page-1", content, 1280);
  await until(() => host.querySelector("svg")?.viewBox.baseVal.width === 1280);
  if (memory.current !== navigated)
    throw new Error("Resizing discarded a manually navigated camera");
}
