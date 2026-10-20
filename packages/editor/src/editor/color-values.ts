export type Hsva = { h: number; s: number; v: number; a: number };
export const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));

export function hexToHsva(hex: string): Hsva {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const v = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = v - min;
  const hue =
    delta === 0
      ? 0
      : v === r
        ? ((g - b) / delta) % 6
        : v === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  return {
    h: (hue * 60 + 360) % 360,
    s: v === 0 ? 0 : delta / v,
    v,
    a: hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1,
  };
}

export function hsvaToHex({ h, s, v, a }: Hsva): string {
  const chroma = v * s,
    x = chroma * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = v - chroma;
  const rgb =
    h < 60
      ? [chroma, x, 0]
      : h < 120
        ? [x, chroma, 0]
        : h < 180
          ? [0, chroma, x]
          : h < 240
            ? [0, x, chroma]
            : h < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const byte = (value: number) =>
    Math.round(clamp(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${rgb.map((value) => byte(value + m)).join("")}${a < 1 ? byte(a) : ""}`;
}
