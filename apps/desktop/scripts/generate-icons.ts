import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMacIcons } from "./generate-macos-icons";

// Rebuild macOS channel icons and the existing Windows artwork on macOS.
if (process.platform !== "darwin")
  throw new Error("Icon generation requires macOS sips and iconutil.");
execFileSync("oxipng", ["--version"], { stdio: "ignore" });
/** Losslessly compress a PNG while retaining the RGBA encoding native icons require. */
const optimizePng = (path: string) =>
  execFileSync("oxipng", ["-o", "max", "-z", "--fast", "--strip", "safe", "--quiet", "--nx", path]);
const resources = fileURLToPath(new URL("../resources/", import.meta.url));
const master = await readFile(join(resources, "icon.png"));
if (master[24] !== 8 || master[25] !== 6)
  throw new Error("Export the master as an 8-bit RGBA PNG to preserve Windows ICO compatibility.");
const temporary = await mkdtemp(join(tmpdir(), "tidy-icon-"));
try {
  await generateMacIcons();

  // ICO entries can contain PNG bytes. Include common Windows display sizes.
  const sizes = [16, 32, 48, 64, 128, 256];
  const images: Buffer[] = [];
  for (const size of sizes) {
    const output = join(temporary, `${size}.png`);
    execFileSync(
      "sips",
      ["-z", String(size), String(size), join(resources, "icon.png"), "--out", output],
      { stdio: "ignore" },
    );
    // Windows PNG entries in ICO files require 32bpp RGBA.
    optimizePng(output);
    images.push(await readFile(output));
  }
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  await writeFile(join(resources, "icon.ico"), Buffer.concat([header, ...images]));
  // Keep the master RGBA so future sips resizes also retain the ICO alpha channel.
  optimizePng(join(resources, "icon.png"));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
