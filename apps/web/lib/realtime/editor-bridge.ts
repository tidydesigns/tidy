import {
  editorExportResultSchema,
  type EditorExportRequest,
  type EditorExportResult,
  type Peer,
} from "./protocol";

/** Viewports are caller-only context, not collaborator presence. */
export function collaborationPeer(peer: Peer): Omit<Peer, "viewport"> {
  const shared = { ...peer };
  delete shared.viewport;
  return shared;
}
export function ownEditorSessions(
  peers: Iterable<Peer>,
  sessions: ReadonlySet<string>,
  userId: string,
  now = Date.now(),
) {
  return [...peers]
    .filter(
      (p) =>
        p.userId === userId && sessions.has(p.sessionId) && !p.away && p.updatedAt > now - 90000,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({
      sessionId: p.sessionId,
      pageId: p.pageId,
      selectedIds: p.selectedIds,
      viewport: p.viewport ?? null,
      updatedAt: p.updatedAt,
    }));
}
/** Exports stay ephemeral, bounded and tied to one authenticated socket. */
export class EditorBridge {
  private pending = new Map<
    string,
    {
      sessionId: string;
      resolve: (value: EditorExportResult) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private timeoutMs = 15000) {}
  request(
    sessionId: string,
    request: EditorExportRequest,
    send: () => void,
  ): Promise<EditorExportResult> {
    if (this.pending.size >= 3 || this.pending.has(request.requestId))
      throw new Error("An editor export is already in progress. Try again shortly.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("Editor export timed out. Keep the target page open and try again."));
      }, this.timeoutMs);
      this.pending.set(request.requestId, { sessionId, resolve, reject, timer });
      try {
        send();
      } catch {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(new Error("Editor disconnected. Open the file and try again."));
      }
    });
  }
  receive(sessionId: string, value: unknown) {
    const parsed = editorExportResultSchema.safeParse(value);
    if (!parsed.success) return false;
    const result = parsed.data,
      pending = this.pending.get(result.requestId);
    if (!pending || pending.sessionId !== sessionId || JSON.stringify(result).length > 3000000)
      return false;
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    pending.resolve(result);
    return true;
  }
  waiting(sessionId: string) {
    return [...this.pending.values()].some((p) => p.sessionId === sessionId);
  }
  disconnect(sessionId: string) {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error("Editor disconnected. Open the file and try again."));
    }
  }
}
