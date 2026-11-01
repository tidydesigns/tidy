import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { desktopMacIcon } from "./app-name";

const resources = new URL("../../resources/", import.meta.url);
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

for (const [channel, version, option] of [
  ["beta", "0.1.0-beta.99", 17],
  ["production", "1.0.0", 13],
] as const) {
  test(`${channel} ICNS preserves Retina artwork, RGBA encoding and native padding`, async () => {
    const source = JSON.parse(await readFile(new URL("macos/source.json", resources), "utf8"));
    const provenance = source.exports.find((item: { channel: string }) => item.channel === channel);
    const master = await readFile(new URL(`macos/${channel}.png`, resources));
    expect(provenance.option).toBe(option);
    expect(createHash("sha256").update(master).digest("hex")).toBe(provenance.pngSha256);
    const png = await readFile(new URL(desktopMacIcon(version, "png"), resources));
    const icns = await readFile(new URL(desktopMacIcon(version, "icns"), resources));
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const sizes = new Set<number>();
    const tags = new Set<string>();
    let retina: Buffer | undefined;
    for (let offset = 8; offset < icns.length;) {
      const length = icns.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(offset + length).toBeLessThanOrEqual(icns.length);
      tags.add(icns.toString("ascii", offset, offset + 4));
      const data = icns.subarray(offset + 8, offset + length);
      if (data.subarray(0, 8).equals(pngSignature)) {
        expect(data[24]).toBe(8);
        expect(data[25]).toBe(6);
        const width = data.readUInt32BE(16);
        expect(data.readUInt32BE(20)).toBe(width);
        sizes.add(width);
        if (width === 1024) retina = data;
      }
      offset += length;
    }
    expect([...sizes].sort((a, b) => a - b)).toEqual([32, 64, 128, 256, 512, 1024]);
    expect(tags.has("ic04") || tags.has("is32") || tags.has("icp4")).toBe(true); // 16px ARGB, legacy or PNG.
    expect(retina).toBeDefined();
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const embedded = await sharp(retina!).ensureAlpha().raw().toBuffer();
    expect(decoded.data.equals(embedded)).toBe(true); // Compression is pixel-lossless.
    expect(decoded.info.width).toBe(1024);
    expect(decoded.info.height).toBe(1024);
    let minX = 1024,
      minY = 1024,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        if (decoded.data[(y * 1024 + x) * 4 + 3]) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    expect([minX, minY, maxX, maxY]).toEqual([100, 100, 923, 923]);
  });
}
