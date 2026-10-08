import type { Peer } from "./protocol";

function userEqual(a: Peer, b: Peer) {
  return (
    a.sessionId === b.sessionId &&
    a.userId === b.userId &&
    a.name === b.name &&
    a.image === b.image &&
    a.color === b.color &&
    a.away === b.away &&
    a.action === b.action
  );
}
function decorationEqual(a: Peer, b: Peer) {
  const x = a.preview,
    y = b.preview;
  return (
    userEqual(a, b) &&
    a.pageId === b.pageId &&
    a.selectedIds.length === b.selectedIds.length &&
    a.selectedIds.every((id, index) => id === b.selectedIds[index]) &&
    (x === y ||
      (x !== null &&
        y !== null &&
        x.nodeId === y.nodeId &&
        x.text === y.text &&
        x.box?.x === y.box?.x &&
        x.box?.y === y.box?.y &&
        x.box?.width === y.box?.width &&
        x.box?.height === y.box?.height))
  );
}
function visualEqual(a: Peer, b: Peer) {
  return (
    decorationEqual(a, b) &&
    a.cursor?.x === b.cursor?.x &&
    a.cursor?.y === b.cursor?.y &&
    Boolean(a.cursor) === Boolean(b.cursor)
  );
}
function same(a: Peer[], b: Peer[], equal: (a: Peer, b: Peer) => boolean) {
  return a.length === b.length && a.every((peer, index) => equal(peer, b[index]));
}
/** Pointer traffic subscribes here, independently of the document editor. */
export class PresenceStore {
  private latest: Peer[] = [];
  private peers: Peer[] = [];
  private decorations: Peer[] = [];
  private users: Peer[] = [];
  private listeners = new Set<() => void>();
  private ownSession = "";
  getSnapshot = () => this.peers;
  getDecorationsSnapshot = () => this.decorations;
  getUsersSnapshot = () => this.users;
  getServerSnapshot = () => EMPTY;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    let changed = false;
    if (!same(this.latest, this.peers, visualEqual)) {
      this.peers = this.latest;
      changed = true;
    }
    if (!same(this.latest, this.decorations, decorationEqual)) {
      this.decorations = this.latest;
      changed = true;
    }
    if (!same(this.latest, this.users, userEqual)) {
      this.users = this.latest;
      changed = true;
    }
    if (changed) for (const listener of this.listeners) listener();
  }
  identify(sessionId: string) {
    this.ownSession = sessionId;
  }
  replace(peers: Peer[]) {
    this.latest = peers.filter((peer) => peer.sessionId !== this.ownSession);
    this.changed();
  }
  update(peer: Peer) {
    if (peer.sessionId === this.ownSession) return;
    const index = this.latest.findIndex((item) => item.sessionId === peer.sessionId);
    this.latest =
      index < 0
        ? [...this.latest, peer]
        : this.latest.map((item, i) => (i === index ? peer : item));
    this.changed();
  }
  remove(sessionId: string) {
    this.latest = this.latest.filter((peer) => peer.sessionId !== sessionId);
    this.changed();
  }
  expire() {
    const now = Date.now();
    const next = this.latest
      .filter((peer) => peer.updatedAt > now - 60_000)
      .map((peer) =>
        peer.preview && peer.updatedAt < now - 5000 ? { ...peer, preview: null } : peer,
      );
    if (next.length !== this.latest.length || next.some((peer, i) => peer !== this.latest[i])) {
      this.latest = next;
      this.changed();
    }
  }
}
const EMPTY: Peer[] = [];
