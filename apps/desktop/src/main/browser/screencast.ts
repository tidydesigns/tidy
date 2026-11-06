import { randomInt } from "node:crypto";
import { browserFrameSize } from "../../shared/browser-viewport";
import type { CDPSession, Page } from "puppeteer-core";
import type { BrowserOutput, BrowserState } from "../../shared/contracts/browser";

type FrameView = Pick<Extract<BrowserOutput, { kind: "frame" }>, "tabId" | "viewId">;
export type BrowserViewer = {
  id: string;
  visible: boolean;
  native?: {
    update(page: Page | undefined, state: BrowserState, visible: boolean): void;
    close(): void;
  };
  send(event: BrowserOutput): void;
  inflight: Map<number, number>;
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
  stalled: boolean;
  stallTimer?: ReturnType<typeof setTimeout>;
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
    clearTimeout(this.capture?.stallTimer);
    this.capture = undefined;
    for (const viewer of this.viewers) {
      viewer.pending = undefined;
      viewer.inflight.clear();
      viewer.view = null;
    }
  }

  acknowledge(viewer: BrowserViewer, frameId: number) {
    if (!viewer.inflight.delete(frameId)) return;
    const capture = this.capture;
    if (capture) {
      clearTimeout(capture.stallTimer);
      capture.stallTimer = undefined;
      capture.stalled = false;
    }
    this.pushFrame(viewer);
    this.updateBackpressure();
    this.acknowledgeCapture();
    if (capture?.paused) this.refresh();
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
    clearTimeout(this.capture?.stallTimer);
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
            if (
              viewer.visible &&
              !viewer.closed &&
              !(viewer.native && this.options.currentTab()?.state.nativeTargetId)
            )
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
      !this.hasCredit(viewer) ||
      !viewer.pending ||
      !viewer.view
    )
      return;
    const frame = viewer.pending;
    viewer.pending = undefined;
    const frameId = ++this.frameSequence;
    viewer.inflight.set(frameId, frame.byteLength);
    viewer.send({
      kind: "frame",
      ...viewer.view,
      frameId,
      data: frame,
    });
  }

  private hasCredit(viewer: BrowserViewer) {
    const bytes = [...viewer.inflight.values()].reduce((total, size) => total + size, 0);
    return viewer.inflight.size < 3 && bytes + (viewer.pending?.byteLength ?? 0) <= 8 * 1024 * 1024;
  }

  private updateBackpressure() {
    const capture = this.capture;
    if (!capture || capture.paused) return;
    const blocked = ![...this.viewers].some(
      (viewer) =>
        viewer.visible &&
        !viewer.closed &&
        !(viewer.native && this.options.currentTab()?.state.nativeTargetId) &&
        this.hasCredit(viewer),
    );
    if (!blocked) {
      clearTimeout(capture.stallTimer);
      capture.stallTimer = undefined;
      capture.stalled = false;
    } else if (!capture.stallTimer) {
      // Brief decode/network delays should drop old frames, not restart Chrome's capture.
      capture.stallTimer = setTimeout(() => {
        capture.stallTimer = undefined;
        if (this.capture !== capture) return;
        capture.stalled = true;
        this.refresh();
      }, 500);
      capture.stallTimer.unref();
    }
  }

  private acknowledgeCapture() {
    const capture = this.capture;
    if (!capture || capture.paused) return;
    for (const sessionId of capture.acknowledgements.splice(0))
      void capture.session.send("Page.screencastFrameAck", { sessionId }).catch(ignored);
  }

  private async stream() {
    const selected = this.options.currentTab();
    const tab = selected?.state.url === "about:blank" ? undefined : selected;
    const viewers = this.pauses
      ? []
      : [...this.viewers].filter(
          (viewer) =>
            viewer.visible &&
            !viewer.closed &&
            !(viewer.native && this.options.currentTab()?.state.nativeTargetId),
        );
    const current = this.capture;
    const size = tab ? browserFrameSize(tab.state) : undefined;
    if (
      tab &&
      viewers.length &&
      current?.tabId === tab.state.id &&
      current.viewId === tab.state.viewId &&
      current.width === size?.width &&
      current.height === size?.height
    ) {
      for (const viewer of viewers) {
        if (viewer.view?.tabId === current.tabId && viewer.view.viewId === current.viewId) continue;
        viewer.view = { tabId: current.tabId, viewId: current.viewId };
        viewer.pending = current.lastFrame;
        this.pushFrame(viewer);
      }
      const blocked = !viewers.some((viewer) => this.hasCredit(viewer));
      if (blocked && current.stalled && !current.paused) {
        current.paused = true;
        await current.session.send("Page.stopScreencast");
      } else if (!blocked && current.paused) {
        current.paused = false;
        this.acknowledgeCapture();
        await this.startCapture(current);
      }
      this.updateBackpressure();
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
      clearTimeout(current.stallTimer);
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
      ...browserFrameSize(tab.state),
      acknowledgements: [],
      paused: false,
      stalled: false,
    };
    this.capture = capture;
    const view: FrameView = { tabId: capture.tabId, viewId: capture.viewId };
    const publish = (data: string) => {
      if (generation !== this.generation || this.options.closed() || capture.paused) return;
      capture.lastFrame = Buffer.from(data, "base64");
      for (const viewer of this.viewers) {
        if (
          !viewer.visible ||
          viewer.closed ||
          (viewer.native && this.options.currentTab()?.state.nativeTargetId)
        )
          continue;
        viewer.view = view;
        viewer.pending = capture.lastFrame;
        this.pushFrame(viewer);
      }
      this.updateBackpressure();
    };
    session.on("Page.screencastFrame", (frame) => {
      publish(frame.data);
      capture.acknowledgements.push(frame.sessionId);
      this.acknowledgeCapture();
    });
    try {
      await this.startCapture(capture);
    } catch (error) {
      if (this.capture === capture) this.capture = undefined;
      await session.detach().catch(ignored);
      if (
        generation !== this.generation ||
        this.dirty ||
        this.options.closed() ||
        this.options.currentTab()?.state.loading
      )
        return;
      throw error;
    }
  }

  private startCapture(capture: Capture) {
    return capture.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 90,
      maxWidth: capture.width,
      maxHeight: capture.height,
      everyNthFrame: 1,
    });
  }
}
