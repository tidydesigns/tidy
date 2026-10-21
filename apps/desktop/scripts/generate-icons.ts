import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run on macOS after replacing the 1024px PNG exported from the Tidy icon design.
if (process.platform !== "darwin")
  throw new Error("Icon generation requires macOS sips and iconutil.");
const resources = fileURLToPath(new URL("../resources/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tidy-icon-"));
try {
  const iconset = join(temporary, "Tidy.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const output = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
      if (size * scale === 1024) await copyFile(join(resources, "icon.png"), output);
      else
        execFileSync(
          "sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            join(resources, "icon.png"),
            "--out",
            output,
          ],
          { stdio: "ignore" },
        );
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);

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
} finally {
  await rm(temporary, { recursive: true, force: true });
}
