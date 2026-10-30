type Waiting = { start(): void; priority(): boolean };

export class VideoTaskQueue {
  private active = 0;
  private waiting: Waiting[] = [];
  constructor(private limit: number) {}

  async run<T>({
    task,
    signal,
    priority = () => true,
  }: {
    task(): Promise<T>;
    signal: AbortSignal;
    priority?: () => boolean;
  }): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((item) => item !== waiting);
        reject(signal.reason);
      };
      const waiting: Waiting = {
        priority,
        start: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiting);
      this.drain();
    });
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      return await Promise.race([task(), cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
      this.active--;
      this.drain();
    }
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const index = this.waiting.findIndex((item) => item.priority());
      const [next] = this.waiting.splice(index < 0 ? 0 : index, 1);
      if (!next) return;
      this.active++;
      next.start();
    }
  }
}

export const videoFileTransfers = new VideoTaskQueue(2);
export const videoChunkTransfers = new VideoTaskQueue(4);
