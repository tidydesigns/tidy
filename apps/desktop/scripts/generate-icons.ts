import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run on macOS with Xcode 26+ after replacing the 1024px Tidy export.
if (process.platform !== "darwin")
  throw new Error("Icon generation requires macOS sips and iconutil.");
execFileSync("oxipng", ["--version"], { stdio: "ignore" });
const optimizePng = (path: string) =>
  execFileSync("oxipng", ["-o", "max", "-z", "--fast", "--strip", "safe", "--quiet", "--nx", path]);
const resources = fileURLToPath(new URL("../resources/", import.meta.url));
const master = await readFile(join(resources, "icon.png"));
if (master[24] !== 8 || master[25] !== 6)
  throw new Error("Export the master as an 8-bit RGBA PNG to preserve Windows ICO compatibility.");
const temporary = await mkdtemp(join(tmpdir(), "tidy-icon-"));
try {
  // A full-bleed square ICNS triggers macOS's legacy-icon backplate. Use Apple's
  // mask, then the legacy 824px artwork / 100px transparent inset on each side.
  const composer = join(temporary, "Tidy.icon");
  await mkdir(join(composer, "Assets"), { recursive: true });
  await copyFile(join(resources, "icon.png"), join(composer, "Assets/Wordmark.png"));
  await writeFile(
    join(composer, "icon.json"),
    JSON.stringify({
      fill: { solid: "srgb:1,1,1,1" },
      groups: [
        {
          layers: [{ glass: false, "image-name": "Wordmark.png", name: "Tidy" }],
          shadow: { kind: "neutral", opacity: 0 },
          translucency: { enabled: false, value: 0 },
          specular: false,
        },
      ],
      "supported-platforms": { squares: "shared" },
    }),
  );
  const developer = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
  const masked = join(temporary, "masked.png");
  execFileSync(
    join(developer, "../Applications/Icon Composer.app/Contents/Executables/ictool"),
    [
      composer,
      "--export-image",
      "--output-file",
      masked,
      "--platform",
      "macOS",
      "--rendition",
      "Default",
      "--width",
      "1024",
      "--height",
      "1024",
      "--scale",
      "1",
    ],
    { stdio: "ignore" },
  );
  const macMaster = join(resources, "icon-macos.png");
  execFileSync("xcrun", [
    "swift",
    fileURLToPath(new URL("./pad-macos-icon.swift", import.meta.url)),
    masked,
    macMaster,
  ]);
  optimizePng(macMaster);

  const iconset = join(temporary, "Tidy.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const output = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
      if (size * scale === 1024) await copyFile(macMaster, output);
      else
        execFileSync(
          "sips",
          ["-z", String(size * scale), String(size * scale), macMaster, "--out", output],
          { stdio: "ignore" },
        );
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);

  // iconutil re-encodes its inputs. Compress the final PNG entries while retaining
  // every native resolution, legacy bitmap and color profile.
  const icns = await readFile(join(resources, "icon.icns"));
  const entries = [Buffer.from(icns.subarray(0, 8))];
  const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) throw new Error("Invalid ICNS entry.");
    let data = icns.subarray(offset + 8, offset + length);
    if (data.subarray(0, 8).equals(pngSignature)) {
      const path = join(temporary, "entry.png");
      await writeFile(path, data);
      // Keep RGBA: macOS's legacy-icon shape detection adds a backplate to
      // grayscale PNG entries even when their decoded alpha is identical.
      optimizePng(path);
      data = await readFile(path);
    }
    const header = Buffer.from(icns.subarray(offset, offset + 8));
    header.writeUInt32BE(data.length + 8, 4);
    entries.push(header, data);
    offset += length;
  }
  const optimizedIcns = Buffer.concat(entries);
  optimizedIcns.writeUInt32BE(optimizedIcns.length, 4);
  await writeFile(join(resources, "icon.icns"), optimizedIcns);

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
