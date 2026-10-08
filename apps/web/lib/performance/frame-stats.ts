export class FrameStats {
  readonly bins = new Uint32Array(201);
  frames = 0;
  total = 0;
  maximum = 0;
  slow = 0;
  add(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.frames++;
    this.total += milliseconds;
    this.maximum = Math.max(this.maximum, milliseconds);
    if (milliseconds > 34) this.slow++;
    this.bins[Math.min(200, Math.ceil(milliseconds))]++;
  }
  percentile(fraction: number) {
    let count = 0;
    const target = Math.ceil(this.frames * fraction);
    for (let bin = 0; bin < this.bins.length; bin++) {
      count += this.bins[bin];
      if (count >= target) return bin;
    }
    return 0;
  }
}
export const nodeBucket = (count: number) =>
  count <= 100 ? "up-to-100" : count <= 1000 ? "101-1000" : "1001-5000";
