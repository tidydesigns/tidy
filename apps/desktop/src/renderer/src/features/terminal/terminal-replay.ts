export type TerminalReplayEvent = { data: string } | { cols: number; rows: number };
type Snapshot = { cols: number; rows: number; events: TerminalReplayEvent[] };

// This cache belongs to the renderer, never storage. Bound both text and resize
// metadata; long sessions fall back to the host's existing bounded snapshot.
export class TerminalReplay {
  private snapshot: Snapshot | undefined;
  private units = 0;
  constructor(private readonly maxUnits = 512 * 1024) {}

  reset(cols: number, rows: number) {
    this.snapshot = { cols, rows, events: [] };
    this.units = 0;
  }

  write(data: string) {
    const snapshot = this.snapshot;
    if (!snapshot || !data) return;
    this.units += data.length;
    if (this.units > this.maxUnits) {
      this.snapshot = undefined;
      return;
    }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 16_000, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      snapshot.events.push({ data: data.slice(offset, end) });
      offset = end;
    }
    if (snapshot.events.length > 8192) this.snapshot = undefined;
  }

  resize(cols: number, rows: number) {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    if (!snapshot.events.length && snapshot.cols === cols && snapshot.rows === rows) return;
    snapshot.events.push({ cols, rows });
    if (snapshot.events.length > 8192) this.snapshot = undefined;
  }

  // The live event list includes output arriving while a replacement is built.
  capture() {
    return this.snapshot;
  }
  valid(snapshot: Snapshot) {
    return this.snapshot === snapshot;
  }
}
