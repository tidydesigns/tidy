/** Show each completed external snapshot while coalescing newer disk events.
 * Only local writes invalidate a read; another external event must not starve it. */
export class CanvasRefresh<T> {
  private wanted = false;
  private running?: Promise<void>;

  constructor(
    private options: {
      read(): Promise<T>;
      apply(value: T): void;
      blocked(): boolean;
      generation(): number;
    },
  ) {}

  request = () => {
    this.wanted = true;
    return this.resume();
  };

  /** Share active reads and hand queued work across the drain's cleanup window. */
  resume = (): Promise<void> => {
    if (this.running) return this.running;
    if (!this.wanted || this.options.blocked()) return Promise.resolve();
    this.running = this.drain().then(
      () => {
        this.running = undefined;
        // A write can unblock after drain exits but before this callback runs.
        // Chain the resumed work so existing callers also observe its failure.
        return this.resume();
      },
      (error: unknown) => {
        this.running = undefined;
        // Invalid files wait for another event; cleanup must not spin on them.
        throw error;
      },
    );
    return this.running;
  };

  private async drain() {
    while (this.wanted && !this.options.blocked()) {
      this.wanted = false;
      const generation = this.options.generation();
      try {
        const value = await this.options.read();
        if (this.options.blocked() || generation !== this.options.generation()) {
          this.wanted = true;
          continue;
        }
        this.options.apply(value);
      } catch (error) {
        // A repair/event may have arrived while this failed read was pending.
        // Consume that queued retry now rather than waiting for a third event.
        if (this.wanted || generation !== this.options.generation()) {
          this.wanted = true;
          continue;
        }
        // Retry on the next event or completed write, never spin on a bad file.
        this.wanted = true;
        throw error;
      }
    }
  }
}
