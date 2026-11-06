import { coalesceBrowserInput } from "../../shared/browser-input";
import type { BrowserInputEnvelope } from "../../shared/contracts/browser";

type Entry = { envelope: BrowserInputEnvelope; generation: number };

export class BrowserInputQueue {
  private pending: Entry[] = [];
  private running = false;

  constructor(
    private readonly options: {
      dispatch(envelope: BrowserInputEnvelope, generation: number): Promise<void>;
      failed(error: unknown): void;
    },
  ) {}

  push(envelope: BrowserInputEnvelope, generation = 0) {
    const entry = { envelope, generation };
    const previous = this.pending.at(-1);
    const merged =
      previous &&
      previous.generation === generation &&
      coalesceBrowserInput(previous.envelope, envelope);
    if (merged) previous.envelope = merged;
    else {
      if (this.pending.length >= 64) return false;
      this.pending.push(entry);
    }
    if (!this.running) void this.drain();
    return true;
  }

  clear() {
    this.pending.length = 0;
  }

  private async drain() {
    this.running = true;
    try {
      let entry: Entry | undefined;
      while ((entry = this.pending.shift())) {
        try {
          await this.options.dispatch(entry.envelope, entry.generation);
        } catch (error) {
          this.options.failed(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
