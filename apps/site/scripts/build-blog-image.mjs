import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const site = fileURLToPath(new URL("..", import.meta.url));

export async function buildBlogImage(input, name, destination = site) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? "")) {
    throw new Error("Choose a kebab-case image name, for example design-to-code-workflow.");
  }
  const source = await readFile(input);
  const metadata = await sharp(source).metadata();
  const isAvif = metadata.format === "heif" && metadata.compression === "av1";
  if (!["png", "jpeg", "webp"].includes(metadata.format) && !isAvif) {
    throw new Error("Use a PNG, JPEG, WebP or AVIF image.");
  }
  // A single crop makes cards, article covers and social previews consistent.
  const master = await sharp(source)
    .rotate()
    .resize(1600, 900, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();
  // Include the encoder settings in the key; changed files always get new URLs.
  const hash = createHash("sha256")
    .update(master)
    .update("cover-v1-avif50-webp82-jpeg85")
    .digest("hex")
    .slice(0, 16);
  const output = path.join(destination, "public/blog");
  const manifests = path.join(destination, "content/blog/covers");
  await Promise.all([mkdir(output, { recursive: true }), mkdir(manifests, { recursive: true })]);
  const sources = { avif: [], webp: [] };
  for (const width of [320, 640, 960, 1280, 1600]) {
    for (const format of ["avif", "webp"]) {
      const pipeline = sharp(master).resize({ width });
      const buffer = await (
        format === "avif"
          ? pipeline.avif({ quality: 50, effort: 5 })
          : pipeline.webp({ quality: 82, effort: 5 })
      ).toBuffer();
      const filename = `${name}-${hash}-${width}.${format}`;
      await writeFile(path.join(output, filename), buffer);
      sources[format].push({ src: `/blog/${filename}`, width });
    }
  }
  // JPEG remains compatible with social crawlers that cannot read AVIF/WebP.
  const share = `/blog/${name}-${hash}-share.jpg`;
  await sharp(master)
    .resize(1200, 675)
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(path.join(destination, "public", share));
  const manifest = { width: 1600, height: 900, sources, share };
  await writeFile(path.join(manifests, `${name}.json`), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, name] = process.argv.slice(2);
  if (!input || !name)
    throw new Error('Usage: bun run blog:image -- "/path/to/image.png" image-name');
  await buildBlogImage(input, name);
  console.log(
    `Generated responsive covers and a social preview. Add to your post:\n\ncover: "${name}"\ncoverAlt: "Describe what the image shows"\n\nCommit public/blog/${name}-* and content/blog/covers/${name}.json with the post.`,
  );
}
