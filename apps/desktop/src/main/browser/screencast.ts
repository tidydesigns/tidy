import { randomInt } from "node:crypto";
import type { CDPSession, Page } from "puppeteer-core";
import type { BrowserOutput, BrowserState } from "../../shared/contracts/browser";

type FrameView = Pick<Extract<BrowserOutput, { kind: "frame" }>, "tabId" | "viewId">;
export type BrowserViewer = {
  id: string;
  visible: boolean;
  send(event: BrowserOutput): void;
  inflight: Set<number>;
  pending?: Uint8Array;
  closed: boolean;
  view: FrameView | null;
};
type Capture = FrameView & {
  session: CDPSession;
  width: number;
  height: number;
  lastFrame?: Uint8Array;
  acknowledgements: number[];
  paused: boolean;
};
const ignored = () => {};

export class BrowserScreencast {
  readonly viewers = new Set<BrowserViewer>();
  private frameSequence = randomInt(1, 2 ** 48);
  private generation = 0;
  private dirty = false;
  private pauses = 0;
  private task?: Promise<void>;
  private capture?: Capture;

  constructor(
    private readonly options: {
      currentTab(): { page: Page; state: BrowserState["tabs"][number] } | undefined;
      closed(): boolean;
    },
  ) {}

  invalidate() {
    this.generation++;
  }

  reset() {
    this.invalidate();
    this.capture = undefined;
    for (const viewer of this.viewers) {
      viewer.pending = undefined;
      viewer.inflight.clear();
      viewer.view = null;
    }
  }

  acknowledge(viewer: BrowserViewer, frameId: number) {
    if (viewer.inflight.delete(frameId)) this.pushFrame(viewer);
    this.acknowledgeCapture();
    if (this.capture?.paused) this.refresh();
  }

  async pauseWhile<T>({ run }: { run(): Promise<T> }) {
    this.pauses++;
    this.refresh();
    try {
      while (this.task) await this.task;
      return await run();
    } finally {
      this.pauses--;
      this.refresh();
    }
  }

  async close() {
    this.invalidate();
    await this.capture?.session.detach().catch(ignored);
    this.capture = undefined;
  }

  refresh() {
    if (this.options.closed()) return;
    this.dirty = true;
    if (this.task) return;
    this.task = (async () => {
      while (this.dirty && !this.options.closed()) {
        this.dirty = false;
        await this.stream().catch((error: unknown) => {
          for (const viewer of this.viewers)
            if (viewer.visible && !viewer.closed)
              viewer.send({
                kind: "error",
                message:
                  error instanceof Error ? error.message.slice(0, 1000) : "Browser capture failed.",
              });
        });
      }
    })().finally(() => {
      this.task = undefined;
      if (this.dirty && !this.options.closed()) this.refresh();
    });
  }

  private pushFrame(viewer: BrowserViewer) {
    if (
      viewer.closed ||
      !viewer.visible ||
      viewer.inflight.size >= 3 ||
      !viewer.pending ||
      !viewer.view
    )
      return;
    const frame = viewer.pending;
    viewer.pending = undefined;
    const frameId = ++this.frameSequence;
    viewer.inflight.add(frameId);
    viewer.send({
      kind: "frame",
      ...viewer.view,
      frameId,
      data: frame,
    });
  }

  private acknowledgeCapture() {
    const capture = this.capture;
    if (
      !capture ||
      ![...this.viewers].some(
        (viewer) => viewer.visible && !viewer.closed && viewer.inflight.size < 3,
      )
    )
      return;
    for (const sessionId of capture.acknowledgements.splice(0))
      void capture.session.send("Page.screencastFrameAck", { sessionId }).catch(ignored);
  }

  private async stream() {
    const tab = this.options.currentTab();
    const viewers = this.pauses
      ? []
      : [...this.viewers].filter((viewer) => viewer.visible && !viewer.closed);
    const current = this.capture;
    if (
      tab &&
      viewers.length &&
      current?.tabId === tab.state.id &&
      current.viewId === tab.state.viewId &&
      current.width === tab.state.width &&
      current.height === tab.state.height
    ) {
      for (const viewer of viewers) {
        if (viewer.view?.tabId === current.tabId && viewer.view.viewId === current.viewId) continue;
        viewer.view = { tabId: current.tabId, viewId: current.viewId };
        viewer.pending = current.lastFrame;
        this.pushFrame(viewer);
      }
      const blocked = !viewers.some((viewer) => viewer.inflight.size < 3);
      if (blocked && !current.paused) {
        current.paused = true;
        await current.session.send("Page.stopScreencast");
      } else if (!blocked && current.paused) {
        current.paused = false;
        this.acknowledgeCapture();
        await this.startCapture(current);
      }
      this.acknowledgeCapture();
      return;
    }
    const generation = ++this.generation;
    this.capture = undefined;
    for (const viewer of this.viewers) {
      viewer.pending = undefined;
      viewer.inflight.clear();
      viewer.view = null;
    }
    if (current) {
      await current.session.send("Page.stopScreencast").catch(ignored);
      await current.session.detach().catch(ignored);
    }
    if (!tab || !viewers.length || this.options.closed()) return;
    await tab.page.bringToFront();
    if (generation !== this.generation || this.options.closed()) return;
    const session = await tab.page.createCDPSession();
    if (generation !== this.generation || this.options.closed()) {
      await session.detach().catch(ignored);
      return;
    }
    const capture: Capture = {
      session,
      tabId: tab.state.id,
      viewId: tab.state.viewId,
      width: tab.state.width,
      height: tab.state.height,
      acknowledgements: [],
      paused: false,
    };
    this.capture = capture;
    const view: FrameView = { tabId: capture.tabId, viewId: capture.viewId };
    const publish = (data: string) => {
      if (generation !== this.generation || this.options.closed() || capture.paused) return;
      capture.lastFrame = Buffer.from(data, "base64");
      for (const viewer of this.viewers) {
        if (!viewer.visible || viewer.closed) continue;
        viewer.view = view;
        viewer.pending = capture.lastFrame;
        this.pushFrame(viewer);
      }
      if (
        ![...this.viewers].some(
          (viewer) => viewer.visible && !viewer.closed && viewer.inflight.size < 3,
        )
      )
        this.refresh();
    };
    session.on("Page.screencastFrame", (frame) => {
      publish(frame.data);
      capture.acknowledgements.push(frame.sessionId);
      this.acknowledgeCapture();
    });
    await this.startCapture(capture);
  }

  private startCapture(capture: Capture) {
    return capture.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: capture.width,
      maxHeight: capture.height,
      everyNthFrame: 1,
    });
  }
}
