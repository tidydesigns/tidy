type Entry = { size: number; priority(): boolean; evict(): void };

export class VideoMemoryBudget {
  private entries = new Map<object, Entry>();
  private bytes = 0;
  constructor(private limit: number) {}

  retain(entry: Entry) {
    if (entry.size <= 0 || entry.size > this.limit)
      throw new Error("The recording exceeds the preview memory budget.");
    while (this.bytes + entry.size > this.limit) {
      const oldest =
        [...this.entries].find(([, value]) => !value.priority()) ??
        this.entries.entries().next().value;
      if (!oldest) break;
      const [key, value] = oldest;
      this.entries.delete(key);
      this.bytes -= value.size;
      value.evict();
    }
    const key = {};
    this.entries.set(key, entry);
    this.bytes += entry.size;
    return {
      touch: () => {
        if (!this.entries.has(key)) return;
        this.entries.delete(key);
        this.entries.set(key, entry);
      },
      release: () => {
        if (!this.entries.delete(key)) return;
        this.bytes -= entry.size;
      },
    };
  }
}

export const videoMemoryBudget = new VideoMemoryBudget(256 * 1024 * 1024);
