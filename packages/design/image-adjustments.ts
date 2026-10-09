export const imageAdjustmentLabels = {
  exposure: "Exposure",
  contrast: "Contrast",
  saturation: "Saturation",
  temperature: "Temperature",
  tint: "Tint",
  highlights: "Highlights",
  shadows: "Shadows",
} as const;
export type ImageAdjustment = keyof typeof imageAdjustmentLabels;
export type ImageAdjustments = Partial<Record<ImageAdjustment, number>>;
export const hasImageAdjustments = (value?: ImageAdjustments) =>
  Object.values(value ?? {}).some((amount) => amount !== undefined && amount !== 0);

/** Generated exclusively from bounded numbers; shared by live rendering and SVG export.
 * Tone masks use luminance, leaving alpha and unrelated layer content untouched.
 * These are Tidy's adjustment curves, not an emulation of another editor's filters.
 */
export function imageAdjustmentFilter(id: string, value: ImageAdjustments = {}) {
  // This exported helper is also consumed through innerHTML. Escape at the
  // markup boundary rather than relying on callers to supply a generated ID.
  const escapedId = id
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  if (!hasImageAdjustments(value))
    return `<filter id="${escapedId}"><feComponentTransfer/></filter>`;
  const safe = (key: ImageAdjustment) => Math.max(-1, Math.min(1, value[key] || 0));
  const exposure = 2 ** (safe("exposure") * 2);
  const contrast = 2 ** (safe("contrast") * 2);
  const warmth = safe("temperature") * 0.2,
    tint = safe("tint") * 0.15;
  let body = `<feComponentTransfer in="SourceGraphic" result="light">${["R", "G", "B"]
    .map((channel, index) => {
      const balance = [warmth + tint / 2, -tint, -warmth + tint / 2][index]!;
      // Bounded curves preserve endpoints rather than clipping large bright areas.
      const curve = Array.from({ length: 33 }, (_, index) => {
        const input = index / 32;
        const exposed = (input * exposure) / (1 + input * (exposure - 1));
        const light = exposed ** contrast / (exposed ** contrast + (1 - exposed) ** contrast);
        return Math.max(0, Math.min(1, light + balance * light * (1 - light) * 2)).toFixed(6);
      }).join(" ");
      return `<feFunc${channel} type="table" tableValues="${curve}"/>`;
    })
    .join(
      "",
    )}</feComponentTransfer><feColorMatrix in="light" type="saturate" values="${1 + safe("saturation")}" result="colour"/>`;
  let source = "colour";
  for (const key of ["highlights", "shadows"] as const) {
    const amount = safe(key);
    if (!amount) continue;
    const weights = Array.from({ length: 17 }, (_, index) => {
      const luminance = index / 16;
      const t =
        key === "highlights"
          ? Math.max(0, (luminance - 0.35) / 0.65)
          : Math.max(0, (0.65 - luminance) / 0.65);
      return (t * t * (3 - 2 * t) * Math.abs(amount) * 0.65).toFixed(5);
    }).join(" ");
    body += `<feColorMatrix in="colour" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2126 0.7152 0.0722 0 0" result="luminance"/><feComponentTransfer in="luminance" result="mask"><feFuncA type="table" tableValues="${weights}"/></feComponentTransfer><feFlood flood-color="${amount > 0 ? "white" : "black"}" result="tone"/><feComposite in="tone" in2="mask" operator="in" result="overlay"/><feComposite in="overlay" in2="${source}" operator="atop" result="${key}"/>`;
    source = key;
  }
  return `<filter id="${escapedId}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">${body}</filter>`;
}
