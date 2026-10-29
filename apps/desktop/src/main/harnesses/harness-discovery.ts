import type { HarnessConnection } from "../../shared/contracts/desktop";
import { checkHarnesses } from "./harnesses";

/** Agent CLI probes must never hold up project lists or the first workspace paint. */
export class HarnessDiscovery {
  private value: HarnessConnection[] = [];
  private pending?: Promise<HarnessConnection[]>;
  private checkedAt = -Infinity;

  constructor(private check = checkHarnesses) {}

  snapshot(): HarnessConnection[] {
    if (Date.now() - this.checkedAt >= 30_000) void this.refresh().catch(() => {});
    return this.value;
  }

  refresh(): Promise<HarnessConnection[]> {
    if (this.pending) return this.pending;
    const request = Promise.resolve()
      .then(this.check)
      .then((value) => {
        this.value = value;
        this.checkedAt = Date.now();
        return value;
      });
    this.pending = request;
    void request
      .finally(() => {
        if (this.pending === request) this.pending = undefined;
      })
      .catch(() => {});
    return request;
  }
}
