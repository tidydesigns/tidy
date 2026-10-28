import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const source = path.join(root, "design/product-captures");
const destination = path.join(root, "apps/site/public/product");
await mkdir(destination, { recursive: true });
const captures = {};
for (const name of ["canvas-dark", "canvas-light", "desktop-dark", "desktop-light"]) {
  const image = sharp(path.join(source, `${name}.png`));
  const { width, height } = await image.metadata();
  if (!width || !height) throw new Error(`Invalid capture: ${name}`);
  const files = [];
  for (const size of [
    ...new Set([640, 960, 1280, 1920, 2400, 3200, width].filter((size) => size <= width)),
  ]) {
    const result = await image
      .clone()
      .resize({ width: size, withoutEnlargement: true })
      // UI text and thin strokes must survive export without lossy compression
      // or chroma subsampling. Responsive widths keep the download bounded.
      .webp({ lossless: true, effort: 6 })
      .toBuffer({ resolveWithObject: true });
    const filename = `${name}-${size}.webp`;
    await writeFile(path.join(destination, filename), result.data);
    files.push({
      src: `/product/${filename}`,
      width: result.info.width,
      bytes: result.data.length,
    });
  }
  captures[name] = { width, height, files };
}
await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(captures, null, 2)}\n`);
console.info("Exported four real app captures as responsive WebP images.");
