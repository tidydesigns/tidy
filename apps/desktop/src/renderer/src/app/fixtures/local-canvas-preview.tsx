import { useRef } from "react";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "@tidy/design/document";
import type { CanvasViewportMemory } from "@tidy/editor";
import type { DesktopAPI, LocalDesign } from "../../../../shared/contracts/desktop";
import { ThreadDesignWindow } from "../../features/designs/thread-preview/window";
import type { PreviewCameraMemory } from "../../features/designs/thread-preview/navigation";

const noop = () => {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function Fixture({
  api,
  value,
  onUpdate,
}: {
  api: DesktopAPI;
  value: LocalDesign;
  onUpdate(value: LocalDesign): void;
}) {
  const dock = useRef<HTMLSpanElement>(null);
  const viewport = useRef<CanvasViewportMemory>({});
  const preview = useRef<PreviewCameraMemory>({});
  return (
    <div className="thread-workspace" style={{ width: 1000, height: 700 }}>
      <span ref={dock} />
      <ThreadDesignWindow
        api={api}
        projectId="preview-project"
        summary={value}
        active
        working={false}
        floating
        warm
        slot={{ x: 0, y: 0, width: 300 }}
        placement={0}
        stackOrder={0}
        initialGeometry={{ x: 20, y: 20, width: 500, height: 400 }}
        viewportMemory={viewport.current}
        previewMemory={preview.current}
        dockTarget={dock}
        readPreview={() => Promise.resolve(value)}
        onDock={noop}
        onActivate={noop}
        onGeometry={noop}
        onDocked={noop}
        onUpdate={onUpdate}
        onPreviewError={(error) => {
          throw error;
        }}
      />
    </div>
  );
}

async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 8000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

export async function runLocalCanvasPreviewTests(
  root: Root,
  host: HTMLElement,
  nativeAPI: DesktopAPI,
) {
  const board = buildDrawnNode("live-board", "artboard", null, {
    x: 0,
    y: 0,
    width: 200,
    height: 200,
  });
  const shape = buildDrawnNode("live-shape", "container", board.id, {
    x: 20,
    y: 20,
    width: 50,
    height: 50,
  });
  let saved: LocalDesign = {
    id: "live-preview",
    name: "Live preview",
    path: "/fixtures/live-preview.json",
    updatedAt: "2026-11-04T10:00:00.000Z",
    version: "1",
    assets: {},
    document: parseDesignDocument({ ...blankDesignDocument(), nodes: [board, shape] }),
  };
  const writes: {
    request: Parameters<DesktopAPI["updateDesign"]>[0];
    result: ReturnType<typeof deferred<LocalDesign>>;
  }[] = [];
  const persisted: LocalDesign[] = [];
  const api: DesktopAPI = {
    ...nativeAPI,
    cloud: undefined,
    onEvent: () => noop,
    refreshDesign: async () => null,
    updateDesign(request) {
      const result = deferred<LocalDesign>();
      writes.push({ request, result });
      return result.promise;
    },
  };
  flushSync(() =>
    root.render(<Fixture api={api} value={saved} onUpdate={(value) => persisted.push(value)} />),
  );
  const expand = required(
    host.querySelector<HTMLButtonElement>('[aria-label="Expand canvas"]'),
    "expand button",
  );
  await until(
    () => Boolean(host.querySelector('[data-thumbnail-node="live-board"]')),
    "pane artwork",
  );
  expand.click();
  await until(
    () => Boolean(document.querySelector('[aria-label="Design canvas"]')),
    "canvas editor",
  );
  const canvas = required(
    document.querySelector<HTMLElement>('[aria-label="Design canvas"]'),
    "canvas",
  );
  await until(
    () =>
      document.querySelector('[aria-label="Live design canvas"]')?.getAttribute("data-phase") ===
      "open",
    "expanded canvas",
  );
  const key = (key: string, options: KeyboardEventInit = {}) => {
    canvas.focus();
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
    );
  };
  const phase = () =>
    document.querySelector('[aria-label="Live design canvas"]')?.getAttribute("data-phase");
  const minimise = () =>
    required(
      document.querySelector<HTMLButtonElement>('[aria-label="Minimise canvas"]'),
      "minimise",
    ).click();
  async function reopen() {
    await until(() => phase() === "closed", "canvas minimised");
    expand.click();
    await until(() => phase() === "open", "canvas reopened");
  }
  const paneX = () =>
    host.querySelector<HTMLElement>('[data-thumbnail-node="live-shape"]')?.style.left;
  const canvasX = () =>
    document.querySelector<HTMLElement>('[data-node-id="live-shape"]')?.style.left;
  key("a", { ctrlKey: true });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  key("Enter");
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  key("ArrowRight");
  await until(() => writes.length === 1 && canvasX() === "21px", "optimistic edit");
  minimise();
  await until(
    () =>
      document.querySelector('[aria-label="Live design canvas"]')?.getAttribute("data-phase") ===
      "closed",
    "minimise while save is pending",
  );
  if (paneX() !== "21px") throw new Error("Pane did not show latest edit when minimised");
  if (persisted.length !== 0 || writes.length !== 1)
    throw new Error("Minimise waited for persistence");
  await reopen();
  let hiddenChanges = 0;
  const hiddenPane = new MutationObserver((records) => {
    hiddenChanges += records.length;
  });
  hiddenPane.observe(required(host.querySelector(".thread-design-artwork"), "pane artwork"), {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  key("ArrowRight");
  await until(() => canvasX() === "22px", "second queued edit");
  key("z", { ctrlKey: true });
  await until(() => canvasX() === "21px", "undo while original writes are pending");
  key("z", { ctrlKey: true, shiftKey: true });
  await until(() => canvasX() === "22px", "redo while original writes are pending");
  if (writes.length !== 1) throw new Error("Queued edits escaped serialized persistence");
  hiddenChanges += hiddenPane.takeRecords().length;
  hiddenPane.disconnect();
  if (hiddenChanges) throw new Error("Hidden pane rendered during canvas edits");
  const acknowledge = (index: number) => {
    const write = required(writes[index], `write ${index}`);
    saved = {
      ...saved,
      document: write.request.document ?? saved.document,
      version: String(index + 2),
      updatedAt: `2026-11-04T10:00:0${index + 1}.000Z`,
    };
    write.result.resolve(saved);
  };
  acknowledge(0);
  await until(() => writes.length === 2, "second write submitted");
  minimise();
  await until(() => paneX() === "22px", "older acknowledgement preserves latest pending edit");
  await reopen();
  acknowledge(1);
  await until(() => writes.length === 3, "pending undo submitted");
  acknowledge(2);
  await until(() => writes.length === 4, "pending redo submitted");
  acknowledge(3);
  await until(() => persisted.length === 4, "writes and queued history acknowledged");
  key("z", { ctrlKey: true });
  await until(() => writes.length === 5 && canvasX() === "21px", "optimistic undo");
  acknowledge(4);
  await until(() => persisted.length === 5, "undo saved");
  key("z", { ctrlKey: true, shiftKey: true });
  await until(() => writes.length === 6 && canvasX() === "22px", "optimistic redo");
  minimise();
  await until(() => paneX() === "22px", "pane follows pending redo when minimised");
  writes[5].result.reject(new Error("Fixture disk write failed"));
  await until(
    () => canvasX() === "21px" && paneX() === "21px",
    "failed redo rolls both surfaces back",
  );
  flushSync(() => root.render(null));
  return "Live pane follows edits, queued acknowledgements, undo/redo and failed-write rollback; minimise remains instant during disk writes";
}
