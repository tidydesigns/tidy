import { randomInt } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import type { Page } from "puppeteer-core";
import type { BrowserState } from "../../shared/contracts/browser";
import type { BrowserStreamReason } from "../../shared/contracts/browser-streaming";
import { browserVideoPacket } from "../../shared/browser-video";
import { BrowserScreencast, type BrowserViewer } from "./screencast";
import type { BrowserVideoHost } from "./video-host";

type Pending = { upstream: number; sent: number; bytes: number };
type Peer = { attempt: number } & (
  | { kind: "waiting"; since: number | null }
  | {
      kind: "video";
      pending: Map<number, Pending>;
      bytes: number;
      started: number;
      lastAck: number | null;
      phase: "priming" | "priming-paused" | "keyframe" | "active";
    }
  | { kind: "jpeg"; retryAt: number }
  | { kind: "unsupported" }
);
type Upstream = { socket: WebSocket; pending: Map<number, Pending>; generation: number };

export class BrowserVideoStream {
  readonly viewers = new Set<BrowserViewer>();
  private readonly fallback: BrowserScreencast;
  private readonly peers = new Map<BrowserViewer, Peer>();
  private upstream?: Upstream;
  private sequence = randomInt(1, 2 ** 48);
  private generation = 0;
  private pauses = 0;
  private task?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private view = "";
  private retryAt = 0;
  private keyframeAt = -Infinity;
  private fallbackView = "";
  private readonly maintenance = setInterval(() => {
    const now = performance.now();
    for (const [viewer, peer] of this.peers) {
      if (viewer.closed || !this.viewers.has(viewer)) {
        this.peers.delete(viewer);
        this.fallback.viewers.delete(viewer);
      } else if (!viewer.visible) {
        if (peer.kind === "video") this.waitForKeyframe(viewer, peer.attempt);
      } else if (peer.kind === "video") {
        if (peer.phase === "keyframe" && peer.lastAck !== null && now - peer.lastAck > 10000) {
          this.cooldown(viewer, "unavailable");
          continue;
        }
        const oldest = peer.pending.values().next().value;
        if (
          oldest &&
          (peer.lastAck === null
            ? now - oldest.sent > 10000
            : now - oldest.sent > 2000 && now - peer.lastAck > 1000)
        )
          this.cooldown(viewer, "congestion");
      } else if (peer.kind === "jpeg" && peer.retryAt <= now) {
        this.waitForKeyframe(viewer, peer.attempt);
      } else if (peer.kind === "waiting" && peer.since !== null && now - peer.since > 10000) {
        this.cooldown(viewer, "unavailable");
      }
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

  private status(viewer: BrowserViewer, mode: "video" | "jpeg", reason: BrowserStreamReason) {
    if (!viewer.closed) viewer.send({ kind: "stream-status", mode, reason });
  }

  private clear(viewer: BrowserViewer) {
    viewer.pending = undefined;
    viewer.inflight.clear();
    viewer.view = null;
  }

  private waitForKeyframe(viewer: BrowserViewer, attempt = 0) {
    this.clear(viewer);
    this.peers.set(viewer, {
      kind: "waiting",
      attempt,
      since: viewer.visible ? performance.now() : null,
    });
  }

  private cooldown(viewer: BrowserViewer, reason: BrowserStreamReason) {
    const attempt = Math.min(5, (this.peers.get(viewer)?.attempt ?? 0) + 1);
    this.clear(viewer);
    this.peers.set(viewer, {
      kind: "jpeg",
      attempt,
      retryAt: performance.now() + Math.min(30000, 1000 * 2 ** attempt),
    });
    this.status(viewer, "jpeg", reason);
  }

  private stopVideo() {
    this.generation++;
    this.probes.clear();
    const previous = this.upstream;
    this.upstream = undefined;
    previous?.socket.terminate();
    for (const [viewer, peer] of this.peers)
      if (peer.kind === "video") this.waitForKeyframe(viewer, peer.attempt);
  }

  invalidate() {
    this.fallback.invalidate();
    this.fallbackView = "";
    this.stopVideo();
    this.view = "";
  }

  reset() {
    this.fallback.reset();
    this.invalidate();
  }

  resync(viewer: BrowserViewer) {
    if (this.peers.get(viewer)?.kind === "unsupported") return;
    this.cooldown(viewer, "decoder");
    this.refresh();
  }

  disable(viewer: BrowserViewer, reason: "unsupported" | "decoder" = "unsupported") {
    if (reason === "decoder") this.cooldown(viewer, reason);
    else {
      this.clear(viewer);
      viewer.videoDisabled = true;
      this.peers.set(viewer, { kind: "unsupported", attempt: 0 });
      this.status(viewer, "jpeg", "unsupported");
    }
    this.refresh();
  }

  acknowledge(viewer: BrowserViewer, frameId: number) {
    const peer = this.peers.get(viewer);
    const pending = peer?.kind === "video" ? peer.pending.get(frameId) : undefined;
    if (peer?.kind !== "video" || !pending) {
      this.fallback.acknowledge(viewer, frameId);
      return;
    }
    const now = performance.now();
    peer.lastAck = now;
    if (peer.phase === "priming") {
      peer.phase = "active";
    } else if (peer.phase === "priming-paused") {
      peer.phase = "keyframe";
      peer.pending.clear();
      peer.bytes = 0;
      viewer.inflight.clear();
      this.requestKeyframe();
      this.refresh();
    }
    if (now - peer.started > 10000) peer.attempt = 0;
    for (const [id, frame] of peer.pending) {
      if (id > frameId) break;
      peer.bytes -= frame.bytes;
      peer.pending.delete(id);
      viewer.inflight.delete(id);
    }
    const upstream = this.upstream;
    if (!upstream?.pending.has(frameId) || upstream.socket.readyState !== WebSocket.OPEN) return;
    upstream.socket.send(`a,${pending.upstream}`);
    for (const id of upstream.pending.keys()) {
      if (id > frameId) break;
      upstream.pending.delete(id);
    }
  }

  pong(viewer: BrowserViewer, nonce: number) {
    if (!viewer.visible || this.peers.get(viewer)?.kind !== "video") return;
    const upstream = this.upstream;
    if (upstream?.socket.readyState === WebSocket.OPEN && this.probes.delete(nonce))
      upstream.socket.send(`po,${nonce}`);
  }
  private readonly probes = new Set<number>();

  async pauseWhile<T>({ run }: { run(): Promise<T> }) {
    this.pauses++;
    this.stopVideo();
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
    for (const [viewer, peer] of this.peers) {
      if ((!viewer.visible || viewer.closed) && peer.kind === "video")
        this.waitForKeyframe(viewer, peer.attempt);
      else if (peer.kind === "waiting")
        peer.since = viewer.visible ? (peer.since ?? performance.now()) : null;
    }
    this.dirty = true;
    if (this.task) return;
    this.task = (async () => {
      while (this.dirty && !this.stopped && !this.options.closed()) {
        this.dirty = false;
        try {
          await this.update();
        } catch {
          this.stopVideo();
          this.retryAt = performance.now() + 2000;
          for (const viewer of this.viewers)
            if (viewer.visible && !viewer.closed && this.peers.get(viewer)?.kind !== "unsupported")
              this.cooldown(viewer, "unavailable");
          this.syncFallback();
        }
      }
    })().finally(() => {
      this.task = undefined;
      if (this.dirty) this.refresh();
    });
  }

  private syncFallback() {
    for (const viewer of this.fallback.viewers) {
      const peer = this.peers.get(viewer);
      if (viewer.closed || !this.viewers.has(viewer) || peer?.kind === "video")
        this.fallback.viewers.delete(viewer);
    }
    for (const [viewer, peer] of this.peers)
      if (this.viewers.has(viewer) && !viewer.closed && peer.kind !== "video")
        this.fallback.viewers.add(viewer);
    const tab = this.options.currentTab();
    const visible = [...this.fallback.viewers].filter((viewer) => viewer.visible && !viewer.closed);
    const view = `${tab?.state.id}:${tab?.state.viewId}:${visible.map((viewer) => viewer.id).join(",")}`;
    if (view !== this.fallbackView) {
      this.fallbackView = view;
      this.fallback.refresh();
    }
  }

  private requestKeyframe() {
    const now = performance.now();
    if (this.upstream?.socket.readyState === WebSocket.OPEN && now - this.keyframeAt > 2000) {
      this.keyframeAt = now;
      this.upstream.socket.send("kf");
    }
  }

  private async update() {
    for (const viewer of this.viewers) {
      if (viewer.closed || this.peers.has(viewer)) continue;
      if (viewer.videoDisabled) this.peers.set(viewer, { kind: "unsupported", attempt: 0 });
      else this.waitForKeyframe(viewer);
    }
    this.syncFallback();
    const tab = this.options.currentTab();
    const eligible = [...this.peers].filter(
      ([viewer, peer]) =>
        !viewer.closed &&
        viewer.visible &&
        this.viewers.has(viewer) &&
        (peer.kind === "video" || peer.kind === "waiting"),
    );
    if (this.pauses || !tab || tab.state.url === "about:blank" || !eligible.length) {
      if (this.upstream) this.stopVideo();
      return;
    }
    const view = `${tab.state.id}:${tab.state.viewId}`;
    if (this.view !== view) {
      this.stopVideo();
      this.view = view;
    }
    if (this.upstream) {
      if (
        eligible.some(
          ([, peer]) =>
            peer.kind === "waiting" || (peer.kind === "video" && peer.phase === "keyframe"),
        )
      )
        this.requestKeyframe();
      return;
    }
    if (performance.now() < this.retryAt) return;
    const host = this.options.host();
    if (!host) {
      for (const [viewer] of eligible) {
        this.clear(viewer);
        this.peers.set(viewer, { kind: "jpeg", attempt: 5, retryAt: Infinity });
        this.status(viewer, "jpeg", "unavailable");
      }
      this.syncFallback();
      return;
    }
    const generation = this.generation;
    await host.prepare(tab.page, tab.state.width, tab.state.height);
    if (generation !== this.generation || this.stopped || this.pauses) return;
    const socket = await host.connect();
    socket.on("error", () => socket.terminate());
    if (generation !== this.generation || this.stopped || this.pauses) {
      socket.terminate();
      return;
    }
    const upstream: Upstream = { socket, pending: new Map(), generation };
    this.upstream = upstream;
    socket.once("open", () => {
      socket.send("v,1");
      socket.send("kf");
      this.keyframeAt = performance.now();
    });
    socket.once("close", () => {
      if (this.upstream !== upstream) return;
      this.stopVideo();
      this.retryAt = performance.now() + 500;
      for (const [viewer, peer] of this.peers)
        if (peer.kind === "waiting") this.status(viewer, "jpeg", "restarting");
      this.refresh();
    });
    socket.on("message", (raw, binary) => {
      if (this.upstream !== upstream || generation !== this.generation) return;
      if (!binary) {
        try {
          const message: unknown = JSON.parse(raw.toString());
          const ping = videoPingSchema.safeParse(message);
          if (ping.success) {
            if (this.probes.size >= 16) {
              const oldest = this.probes.values().next().value;
              if (oldest !== undefined) this.probes.delete(oldest);
            }
            this.probes.add(ping.data.s);
            for (const [viewer, peer] of this.peers)
              if (peer.kind === "video" && viewer.visible && !viewer.closed)
                viewer.send({ kind: "video-ping", nonce: ping.data.s });
          }
        } catch {}
        return;
      }
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      if (data[0] !== 1) return;
      try {
        const packet = browserVideoPacket(data);
        const frameId = ++this.sequence;
        const pending: Pending = {
          upstream: data.readUInt32BE(2),
          bytes: data.length,
          sent: performance.now(),
        };
        const recipients: BrowserViewer[] = [];
        for (const [viewer, previous] of this.peers) {
          if (!viewer.visible || viewer.closed || !this.viewers.has(viewer)) continue;
          let peer = previous;
          if (peer.kind === "waiting" && packet.key && packet.codec) {
            this.fallback.viewers.delete(viewer);
            this.clear(viewer);
            peer = {
              kind: "video",
              attempt: peer.attempt,
              pending: new Map(),
              bytes: 0,
              started: performance.now(),
              lastAck: null,
              phase: "priming",
            };
            this.peers.set(viewer, peer);
            this.status(viewer, "video", "ready");
          }
          if (peer.kind !== "video") continue;
          if (peer.phase === "priming-paused") continue;
          if (peer.phase === "keyframe") {
            if (!packet.key || !packet.codec) continue;
            peer.phase = "active";
          }
          if (peer.pending.size >= 48 || peer.bytes + data.length > 8 * 1024 * 1024) {
            if (peer.phase === "priming" && peer.pending.size) {
              peer.phase = "priming-paused";
              continue;
            }
            this.cooldown(viewer, "congestion");
            continue;
          }
          peer.pending.set(frameId, pending);
          peer.bytes += data.length;
          viewer.inflight.add(frameId);
          viewer.view = { tabId: tab.state.id, viewId: tab.state.viewId };
          recipients.push(viewer);
        }
        if (recipients.length) {
          upstream.pending.set(frameId, pending);
          if (upstream.pending.size > 64)
            throw new Error("Video relay backlog exceeded its limit.");
          for (const viewer of recipients)
            viewer.send({
              kind: "frame",
              tabId: tab.state.id,
              viewId: tab.state.viewId,
              frameId,
              codec: "h264",
              data,
            });
        } else {
          socket.send(`a,${pending.upstream}`);
          upstream.pending.clear();
        }
        this.syncFallback();
      } catch {
        socket.terminate();
      }
    });
  }

  async close() {
    this.stopped = true;
    clearInterval(this.maintenance);
    this.stopVideo();
    await this.task;
    this.peers.clear();
    this.fallback.viewers.clear();
    await this.fallback.close();
  }
}

const videoPingSchema = z.object({
  t: z.literal("ping"),
  s: z.number().int().nonnegative().safe(),
});
