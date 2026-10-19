/** Server-owned randomness: request headers and cookies cannot force sampling. */
export function sampleDiagnostics(rate = 0.01) {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return false;
  if (rate === 1) return true;
  return crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000 < rate;
}
