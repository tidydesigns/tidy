export type RasterTile = { base64: string; x: number; y: number; width: number; height: number };

// Keep lossless pixels at the original resolution. Split large PNGs into tiles
// instead of blurring the forest to satisfy the per-asset upload limit.
export async function rasterTiles(base64: string): Promise<RasterTile[]> {
  if (base64.length <= 2_600_000) return [{ base64, x: 0, y: 0, width: 1, height: 1 }];
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  const result: RasterTile[] = [];
  const quantum = Number.isInteger(window.devicePixelRatio)
    ? Math.max(1, window.devicePixelRatio)
    : 1;
  const halfSize = (size: number) => Math.max(1, Math.floor(size / 2 / quantum) * quantum);
  const split = (x: number, y: number, width: number, height: number, depth: number) => {
    if (depth > 6 || result.length >= 64) throw new Error("Raster group exceeds the tile limit.");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable.");
    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    const data = canvas.toDataURL("image/png").split(",")[1]!;
    if (data.length <= 2_600_000) {
      result.push({
        base64: data,
        x: x / image.naturalWidth,
        y: y / image.naturalHeight,
        width: width / image.naturalWidth,
        height: height / image.naturalHeight,
      });
    } else if (width >= height && width > 1) {
      const half = halfSize(width);
      split(x, y, half, height, depth + 1);
      split(x + half, y, width - half, height, depth + 1);
    } else if (height > 1) {
      const half = halfSize(height);
      split(x, y, width, half, depth + 1);
      split(x, y + half, width, height - half, depth + 1);
    } else throw new Error("Raster tile exceeds the asset limit.");
  };
  split(0, 0, image.naturalWidth, image.naturalHeight, 0);
  return result;
}
