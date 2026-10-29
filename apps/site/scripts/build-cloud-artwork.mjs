import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const site = fileURLToPath(new URL("..", import.meta.url));
const masters = path.resolve(site, "../../design/brand/clouds/masters");
const destination = path.join(site, "public/artwork");
await mkdir(destination, { recursive: true });
const designDestination = path.resolve(masters, "../design");
await mkdir(designDestination, { recursive: true });

const manifest = { version: 1, assets: {} };
for (const name of ["cloud-atmosphere", "cloud-spectrum", "cloud-coral"]) {
  const input = path.join(masters, `${name}.png`);
  const bytes = await readFile(input);
  const metadata = await sharp(bytes).metadata();
  const { width, height } = metadata;
  if (!width || !height) throw new Error(`Missing image dimensions: ${name}`);
  const outputs = [];
  // Decorative textures use delivery-quality exports; design masters stay untouched.
  const sizes = [...new Set([320, 480, 768, 1024, width].filter((size) => size <= width))];
  for (const size of sizes) {
    for (const format of ["avif", "webp"]) {
      let image = sharp(bytes).rotate();
      if (name === "cloud-atmosphere") image = image.greyscale();
      image = image.resize({ width: size, withoutEnlargement: true });
      const result = await (
        format === "avif"
          ? image.avif({ quality: name === "cloud-atmosphere" ? 40 : 50, effort: 6 })
          : image.webp({ quality: name === "cloud-atmosphere" ? 72 : 80, effort: 6 })
      ).toBuffer({ resolveWithObject: true });
      const filename = `${name}-${size}.${format}`;
      await writeFile(path.join(destination, filename), result.data);
      outputs.push({
        src: `/artwork/${filename}`,
        format,
        width: result.info.width,
        height: result.info.height,
        bytes: result.data.length,
      });
    }
  }
  // The design file gets a native-size, high-quality asset, independently of HTML limits.
  const design = sharp(bytes).rotate();
  const designBytes = await (name === "cloud-atmosphere" ? design.greyscale() : design)
    .webp({ quality: 98, effort: 6 })
    .toBuffer();
  await writeFile(path.join(designDestination, `${name}.webp`), designBytes);
  manifest.assets[name] = {
    master: `design/brand/clouds/masters/${name}.png`,
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    outputs,
    design: { src: `design/brand/clouds/design/${name}.webp`, bytes: designBytes.length },
  };
}
await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
