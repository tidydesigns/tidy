import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const resources = fileURLToPath(new URL("../resources/", import.meta.url));
const optimizePng = (path: string) =>
  execFileSync("oxipng", ["-o", "4", "-z", "--fast", "--strip", "safe", "--quiet", "--nx", path]);

/** Native assets are generated offline; normal builds only select committed files. */
export async function generateMacIcons() {
  if (process.platform !== "darwin") throw new Error("macOS icon generation requires macOS.");
  execFileSync("oxipng", ["--version"], { stdio: "ignore" });
  const temporary = await mkdtemp(join(tmpdir(), "tidy-macos-icons-"));
  try {
    for (const channel of ["beta", "production"] as const) {
      const source = join(resources, "macos", `${channel}.png`);
      const master = await readFile(source);
      if (
        master.readUInt32BE(16) !== 1024 ||
        master.readUInt32BE(20) !== 1024 ||
        master[24] !== 8 ||
        master[25] !== 6
      )
        throw new Error("Export 1024px 8-bit RGBA channel masters before generating native icons.");
      // The export already contains the design's rounded mask. Applying Apple's
      // mask again would change the approved rim. Keep the proven legacy inset.
      const macMaster = join(
        resources,
        channel === "beta" ? "icon-macos-beta.png" : "icon-macos.png",
      );
      execFileSync("xcrun", [
        "swift",
        fileURLToPath(new URL("./macos-icon/main.swift", import.meta.url)),
        source,
        macMaster,
      ]);
      optimizePng(macMaster);
      const iconset = join(temporary, `${channel}.iconset`);
      await mkdir(iconset);
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          const path = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
          if (size * scale === 1024) await copyFile(macMaster, path);
          else
            execFileSync(
              "sips",
              ["-z", String(size * scale), String(size * scale), macMaster, "--out", path],
              { stdio: "ignore" },
            );
        }
      }
      const destination = join(resources, channel === "beta" ? "icon-beta.icns" : "icon.icns");
      execFileSync("iconutil", ["-c", "icns", iconset, "-o", destination]);
      // iconutil re-encodes PNGs. Compress every embedded rendition losslessly,
      // preserving native resolutions, profiles and RGBA for macOS shape detection.
      const icns = await readFile(destination);
      const entries = [Buffer.from(icns.subarray(0, 8))];
      const signature = Buffer.from("89504e470d0a1a0a", "hex");
      for (let offset = 8; offset < icns.length;) {
        const length = icns.readUInt32BE(offset + 4);
        if (length < 8 || offset + length > icns.length) throw new Error("Invalid ICNS entry.");
        let data = icns.subarray(offset + 8, offset + length);
        if (data.subarray(0, 8).equals(signature)) {
          const path = join(temporary, "rendition.png");
          await writeFile(path, data);
          optimizePng(path);
          data = await readFile(path);
        }
        const header = Buffer.from(icns.subarray(offset, offset + 8));
        header.writeUInt32BE(data.length + 8, 4);
        entries.push(header, data);
        offset += length;
      }
      const optimized = Buffer.concat(entries);
      optimized.writeUInt32BE(optimized.length, 4);
      await writeFile(destination, optimized);
      console.info(`Generated ${channel} macOS icon (${optimized.length} bytes).`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await generateMacIcons();
