import { fileEventsQuery } from "./events";
import { roomConnectionQuery, roomSessionsQuery } from "./authorization";
import { can } from "../organizations/roles";
import { DurableObject } from "cloudflare:workers";
import { Client } from "pg";
import {
  actorColor,
  EMPTY_PRESENCE,
  presenceSchema,
  type FileEvent,
  type Peer,
  type RoomMessage,
} from "./protocol";
import { verifyTicket } from "./ticket";
import {
  agentActivitySchema,
  AgentActivityStore,
  type AgentActivity,
  type ActivityCheckpoint,
} from "./agent-activity";

// Socket attachments have a 2 KB limit. Identity/selection live in per-session
// storage; high-frequency cursor traffic stays in this compact attachment.
type Attachment = {
  canEdit: boolean;
  sessionId: string;
  authSessionId: string;
  expiresAt: number;
  updatedAt: number;
  pageId: string;
  cursor: Peer["cursor"];
  action: Peer["action"];
  away: boolean;
  windowAt: number;
  count: number;
};
export class FileRoom extends DurableObject<CloudflareEnv> {
  private sequence = 0;
  private fileId: string | null = null;
  private syncing: Promise<void> | null = null;
  private participants = new Map<string, Peer>();
  private activities = new AgentActivityStore();
  private authorizedAt = 0;
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.sequence = (await this.ctx.storage.get<number>("sequence")) ?? 0;
      this.fileId = (await this.ctx.storage.get<string>("fileId")) ?? null;
      const checkpoint = await this.ctx.storage.get<ActivityCheckpoint>("activityCheckpoint");
      if (checkpoint) this.activities.restore(checkpoint);
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as Attachment | null;
        if (!attachment) continue;
        const peer = await this.ctx.storage.get<Peer>(`peer:${attachment.sessionId}`);
        if (peer)
          this.participants.set(peer.sessionId, {
            ...peer,
            pageId: attachment.pageId,
            cursor: attachment.cursor,
            action: attachment.action,
            away: attachment.away,
            updatedAt: attachment.updatedAt,
            preview: null,
          });
      }
    });
  }
  async fetch(request: Request) {
    const ticket = await verifyTicket(
      request.headers.get("X-Bella-Ticket") ?? "",
      this.env.BETTER_AUTH_SECRET,
    );
    if (!ticket || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 403 });
    if (this.fileId && this.fileId !== ticket.fileId) return new Response(null, { status: 403 });
    if (this.ctx.getWebSockets().length >= 100) return new Response(null, { status: 429 });
    await this.ctx.storage.put("fileId", ticket.fileId);
    this.fileId = ticket.fileId;
    const client = this.databaseClient();
    let canEdit = false;
    try {
      await client.connect();
      const access = await client.query<{ role: string }>(roomConnectionQuery, [
        ticket.fileId,
        ticket.userId,
        ticket.authSessionId,
        ticket.organizationId,
      ]);
      if (!access.rowCount) return new Response(null, { status: 403 });
      canEdit = can(access.rows[0].role, "edit");
    } finally {
      await client.end();
    }
    const pair = new WebSocketPair();
    const peer: Peer = {
      ...EMPTY_PRESENCE,
      userId: ticket.userId,
      name: ticket.name,
      image: ticket.image,
      sessionId: ticket.sessionId,
      color: actorColor(ticket.userId),
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(`peer:${peer.sessionId}`, peer);
    this.participants.set(peer.sessionId, peer);
    pair[1].serializeAttachment({
      canEdit,
      sessionId: ticket.sessionId,
      authSessionId: ticket.authSessionId,
      expiresAt: ticket.expiresAt,
      updatedAt: peer.updatedAt,
      cursor: null,
      pageId: peer.pageId,
      action: null,
      away: false,
      windowAt: Date.now(),
      count: 0,
    } satisfies Attachment);
    this.ctx.acceptWebSocket(pair[1]);
    this.send(pair[1], {
      type: "peers",
      peers: [...this.participants.values()].filter((item) => item.updatedAt > Date.now() - 60_000),
    });
    this.activities.expire();
    this.send(pair[1], { type: "activities", activities: this.activities.getSnapshot() });
    this.broadcast({ type: "presence", peer }, pair[1]);
    this.send(pair[1], { type: "ready" });
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
    this.ctx.waitUntil(this.sync(ticket.fileId));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private send(socket: WebSocket, message: RoomMessage) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.remove(socket);
    }
  }
  private broadcast(message: RoomMessage, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets())
      if (socket !== except) this.send(socket, message);
  }
  private remove(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    socket.serializeAttachment(null);
    try {
      socket.close(1000, "Session ended");
    } catch {
      /* Already closed. */
    }
    if (attachment) {
      this.participants.delete(attachment.sessionId);
      this.ctx.waitUntil(this.ctx.storage.delete(`peer:${attachment.sessionId}`));
      this.broadcast({ type: "leave", sessionId: attachment.sessionId }, socket);
    }
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    const peer = attachment ? this.participants.get(attachment.sessionId) : undefined;
    if (!attachment || !peer || attachment.expiresAt <= Date.now()) {
      this.remove(socket);
      return;
    }
    if (typeof message !== "string" || message.length > 24_000) {
      socket.close(1009, "Message too large");
      this.remove(socket);
      return;
    }
    if (Date.now() - attachment.windowAt > 1000) {
      attachment.windowAt = Date.now();
      attachment.count = 0;
    }
    if (++attachment.count > 60) {
      socket.close(1008, "Rate limit");
      this.remove(socket);
      return;
    }
    try {
      const input = JSON.parse(message);
      if (input.type === "ping") {
        if (peer.preview && peer.updatedAt < Date.now() - 5000) {
          peer.preview = null;
          peer.action = null;
        }
        peer.updatedAt = attachment.updatedAt = Date.now();
        socket.serializeAttachment(attachment);
        this.send(socket, { type: "pong" });
        this.broadcast({ type: "presence", peer }, socket);
        return;
      }
      if (input.type !== "presence") throw new Error("Unknown message");
      const presence = presenceSchema.parse(input.presence);
      if (!attachment.canEdit) {
        presence.preview = null;
        if (
          presence.action !== "comment" &&
          presence.action !== "select" &&
          presence.action !== "hand"
        )
          presence.action = null;
      }
      const next = { ...peer, ...presence, updatedAt: Date.now() };
      // Identity is immutable and always comes from the signed server ticket.
      const selectionChanged =
        JSON.stringify(peer.selectedIds) !== JSON.stringify(next.selectedIds);
      this.participants.set(peer.sessionId, next);
      Object.assign(attachment, {
        pageId: next.pageId,
        cursor: next.cursor,
        action: next.action,
        away: next.away,
        updatedAt: next.updatedAt,
      });
      socket.serializeAttachment(attachment);
      this.broadcast({ type: "presence", peer: next }, socket);
      if (selectionChanged)
        await this.ctx.storage.put(`peer:${peer.sessionId}`, { ...next, preview: null });
    } catch {
      socket.close(1008, "Invalid message");
      this.remove(socket);
    }
  }
  webSocketClose(socket: WebSocket) {
    this.remove(socket);
  }
  webSocketError(socket: WebSocket) {
    this.remove(socket);
  }
  /** Private binding RPC only. Browser messages cannot publish agent activity. */
  async activity(input: AgentActivity) {
    const activity = agentActivitySchema.parse(input);
    if (this.fileId && this.fileId !== activity.fileId) throw new Error("Wrong file room.");
    if (activity.expiresAt > Date.now() + 65_000 || activity.updatedAt > Date.now() + 5000)
      throw new Error("Invalid activity lease.");
    if (!this.fileId) {
      this.fileId = activity.fileId;
      await this.ctx.storage.put("fileId", this.fileId);
    }
    if (this.ctx.getWebSockets().length && this.authorizedAt < Date.now() - 15_000) {
      const client = this.databaseClient();
      try {
        await client.connect();
        await this.authorizeSockets(client, activity.fileId);
      } finally {
        await client.end();
      }
    }
    const before = this.activities.getSnapshot();
    this.activities.update(activity);
    if (before === this.activities.getSnapshot()) return;
    const accepted = this.activities.getSnapshot().find((item) => item.id === activity.id);
    if (!accepted) return;
    await this.ctx.storage.put("activityCheckpoint", this.activities.checkpoint());
    this.broadcast({ type: "activity", activity: accepted });
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }
  async sync(fileId: string): Promise<void> {
    if (this.fileId && this.fileId !== fileId) throw new Error("Wrong file room.");
    if (this.syncing) {
      await this.syncing;
      return this.sync(fileId);
    }
    this.syncing = this.readEvents(fileId);
    try {
      await this.syncing;
    } finally {
      this.syncing = null;
    }
  }
  private databaseClient() {
    const connectionString = this.env.HYPERDRIVE?.connectionString ?? this.env.DATABASE_URL;
    if (!connectionString) throw new Error("Room database is not configured.");
    return new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  }
  private async readEvents(fileId: string) {
    const client = this.databaseClient();
    try {
      await client.connect();
      await this.authorizeSockets(client, fileId);
      for (;;) {
        const rows = await client.query<{ sequence: string; kind: FileEvent["kind"] }>(
          fileEventsQuery,
          [fileId, this.sequence],
        );
        if (!rows.rows.length) break;
        const events = rows.rows.map((row) => ({ kind: row.kind, sequence: Number(row.sequence) }));
        this.broadcast({ type: "events", events });
        this.sequence = events.at(-1)!.sequence;
        await this.ctx.storage.put("sequence", this.sequence);
        if (events.length < 200) break;
      }
    } finally {
      await client.end();
    }
  }
  private async authorizeSockets(client: Client, fileId: string) {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length) {
      const authSessionIds = sockets.flatMap((socket) => {
        const attachment = socket.deserializeAttachment() as Attachment | null;
        return attachment ? [attachment.authSessionId] : [];
      });
      const sessions = await client.query<{ id: string; role: string }>(roomSessionsQuery, [
        fileId,
        authSessionIds,
      ]);
      const allowed = new Map(sessions.rows.map((session) => [session.id, session.role]));
      for (const socket of sockets) {
        const attachment = socket.deserializeAttachment() as Attachment | null;
        if (
          !attachment ||
          attachment.expiresAt <= Date.now() ||
          !allowed.has(attachment.authSessionId)
        )
          this.remove(socket);
        else {
          const canEdit = can(allowed.get(attachment.authSessionId), "edit");
          if (attachment.canEdit !== canEdit) {
            attachment.canEdit = canEdit;
            socket.serializeAttachment(attachment);
            this.send(socket, { type: "access", canEdit });
            const peer = this.participants.get(attachment.sessionId);
            if (!canEdit && peer) {
              peer.preview = null;
              peer.action = null;
              this.broadcast({ type: "presence", peer }, socket);
            }
          }
        }
      }
    }
    this.authorizedAt = Date.now();
  }
  async alarm() {
    this.activities.expire();
    await this.ctx.storage.put("activityCheckpoint", this.activities.checkpoint());
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (
        !attachment ||
        attachment.expiresAt <= Date.now() ||
        attachment.updatedAt < Date.now() - 60_000
      )
        this.remove(socket);
    }
    if (this.ctx.getWebSockets().length && this.fileId) {
      try {
        await this.sync(this.fileId);
      } finally {
        await this.ctx.storage.setAlarm(Date.now() + 15_000);
      }
    } else if (this.activities.getSnapshot().length)
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }
}
