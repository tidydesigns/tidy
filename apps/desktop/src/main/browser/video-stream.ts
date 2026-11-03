import { randomInt } from "node:crypto";
import { WebSocket } from "ws";
import type { Page } from "puppeteer-core";
import type { BrowserState } from "../../shared/contracts/browser";
import { BrowserScreencast, type BrowserViewer } from "./screencast";
import type { BrowserVideoHost } from "./video-host";

type Connection = {
  socket: WebSocket;
  pending: Map<number, { upstream: number; sent: number; pong?: number }>;
  pong?: number;
  acknowledged: boolean;
  generation: number;
};

export class BrowserVideoStream {
  readonly viewers = new Set<BrowserViewer>();
  private readonly fallback: BrowserScreencast;
  private lastError = "";
  private retryAt = 0;
  private readonly connections = new Map<BrowserViewer, Connection>();
  private sequence = randomInt(1, 2 ** 48);
  private generation = 0;
  private pauses = 0;
  private task?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private view = "";
  private readonly maintenance = setInterval(() => {
    for (const [viewer, connection] of this.connections) {
      const oldest = connection.pending.values().next().value;
      if (viewer.closed || !viewer.visible) this.disconnect(viewer);
      else if (
        oldest &&
        performance.now() - oldest.sent >
          (connection.acknowledged || this.connections.size > 1 ? 500 : 2000)
      )
        this.disable(viewer);
    }
    this.refresh();
  }, 250);

  constructor(
    private readonly options: {
      currentTab(): { page: Page; state: BrowserState["tabs"][number] } | undefined;
      closed(): boolean;
      host(): BrowserVideoHost | undefined;
    },
  ) {
    this.fallback = new BrowserScreencast(options);
    this.maintenance.unref();
  }

  private disconnect(viewer: BrowserViewer) {
    const connection = this.connections.get(viewer);
    this.connections.delete(viewer);
    viewer.inflight.clear();
    viewer.view = null;
    connection?.socket.terminate();
  }

  invalidate() {
    this.fallback.invalidate();
    this.generation++;
    this.view = "";
    for (const viewer of this.connections.keys()) this.disconnect(viewer);
  }

  reset() {
    this.fallback.reset();
    this.invalidate();
  }
  resync(viewer: BrowserViewer) {
    this.disconnect(viewer);
    this.refresh();
  }

  disable(viewer: BrowserViewer) {
    this.disconnect(viewer);
    viewer.videoDisabled = true;
    this.refresh();
  }

  acknowledge(viewer: BrowserViewer, frameId: number) {
    const connection = this.connections.get(viewer);
    const pending = connection?.pending.get(frameId);
    if (!connection || !pending) {
      this.fallback.acknowledge(viewer, frameId);
      return;
    }
    connection.acknowledged = true;
    connection.pending.delete(frameId);
    viewer.inflight.delete(frameId);
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(`a,${pending.upstream}`);
      if (pending.pong !== undefined) connection.socket.send(`po,${pending.pong}`);
    }
  }

  async pauseWhile<T>({ run }: { run(): Promise<T> }) {
    this.pauses++;
    this.invalidate();
    try {
      while (this.task) await this.task;
      return await this.fallback.pauseWhile({ run });
    } finally {
      this.pauses--;
      this.refresh();
    }
  }

  refresh() {
    if (this.stopped || this.options.closed()) return;
    this.dirty = true;
    if (this.task) return;
    this.task = (async () => {
      while (this.dirty && !this.stopped && !this.options.closed()) {
        this.dirty = false;
        try {
          await this.update();
        } catch (error) {
          this.retryAt = performance.now() + 1000;
          const message = error instanceof Error ? error.message : "Browser video unavailable.";
          if (message === this.lastError) continue;
          this.lastError = message;
          for (const viewer of this.viewers)
            if (viewer.visible && !viewer.closed)
              viewer.send({
                kind: "error",
                message: error instanceof Error ? error.message : "Browser video unavailable.",
              });
        }
      }
    })().finally(() => {
      this.task = undefined;
    });
  }

  private async update() {
    for (const viewer of this.fallback.viewers)
      if (viewer.closed || !this.viewers.has(viewer)) this.fallback.viewers.delete(viewer);
    for (const viewer of this.viewers) if (viewer.videoDisabled) this.fallback.viewers.add(viewer);
    this.fallback.refresh();
    for (const viewer of this.connections.keys())
      if (viewer.closed || !viewer.visible) this.disconnect(viewer);
    const selected = this.options.currentTab();
    const tab = selected?.state.url === "about:blank" ? undefined : selected;
    const visible = this.pauses
      ? []
      : [...this.viewers].filter(
          (viewer) => !viewer.closed && viewer.visible && !viewer.videoDisabled,
        );
    if (!tab || !visible.length) {
      if (this.connections.size) this.invalidate();
      return;
    }
    if (performance.now() < this.retryAt) return;
    const host = this.options.host();
    if (!host) return;
    const view = `${tab.state.id}:${tab.state.viewId}`;
    if (view !== this.view) this.invalidate();
    if (view !== this.view || visible.some((viewer) => !this.connections.has(viewer))) {
      const generation = this.generation;
      await host.prepare(tab.page, tab.state.width, tab.state.height);
      if (generation !== this.generation || this.stopped || this.pauses) return;
      this.view = view;
    }
    const generation = this.generation;
    for (const viewer of visible) {
      if (this.connections.has(viewer)) continue;
      const socket = await host.connect();
      socket.on("error", () => socket.terminate());
      if (
        generation !== this.generation ||
        this.stopped ||
        this.pauses ||
        viewer.closed ||
        !viewer.visible
      ) {
        socket.terminate();
        continue;
      }
      const connection: Connection = {
        socket,
        pending: new Map(),
        generation,
        acknowledged: false,
      };
      this.connections.set(viewer, connection);
      viewer.view = { tabId: tab.state.id, viewId: tab.state.viewId };
      socket.once("open", () => {
        this.lastError = "";
        socket.send("v,1");
      });
      socket.once("close", () => {
        if (this.connections.get(viewer) === connection) this.disconnect(viewer);
      });
      socket.on("message", (raw, binary) => {
        if (
          generation !== this.generation ||
          this.connections.get(viewer) !== connection ||
          viewer.closed ||
          !viewer.visible
        )
          return;
        if (!binary) {
          try {
            const message: unknown = JSON.parse(raw.toString());
            if (
              typeof message === "object" &&
              message !== null &&
              "t" in message &&
              message.t === "ping" &&
              "s" in message &&
              typeof message.s === "number"
            )
              connection.pong = message.s;
          } catch {}
          return;
        }
        const data = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        if (data[0] !== 1) return;
        if (
          data.length <= 16 ||
          data[10] !== 0 ||
          data[11] !== 1 ||
          data[12] !== 1 ||
          connection.pending.size >= 16
        ) {
          this.disable(viewer);
          return;
        }
        const frameId = ++this.sequence;
        connection.pending.set(frameId, {
          upstream: data.readUInt32BE(2),
          sent: performance.now(),
          pong: connection.pong,
        });
        connection.pong = undefined;
        viewer.inflight.add(frameId);
        viewer.send({
          kind: "frame",
          tabId: tab.state.id,
          viewId: tab.state.viewId,
          frameId,
          codec: "h264",
          data,
        });
      });
    }
  }

  async close() {
    this.stopped = true;
    clearInterval(this.maintenance);
    this.invalidate();
    await this.task;
    await this.fallback.close();
  }
}
