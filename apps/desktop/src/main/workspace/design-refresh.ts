/** Coalesce file events without waiting for a quiet period or overlapping scans.
 * Writes during a scan request one more pass so the last disk state is observed. */
export class DesignRefresh {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private dirty = false;
  private closed = false;

  constructor(private refresh: () => Promise<void>) {}

  request = () => {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dirty = false;
      this.running = true;
      void this.refresh()
        .catch(() => {})
        .finally(() => {
          this.running = false;
          if (this.dirty) this.request();
        });
    }, 16);
  };

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
