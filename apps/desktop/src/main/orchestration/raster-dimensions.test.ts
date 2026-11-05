import { expect, test } from "bun:test";
import { rasterDimensions } from "./raster-dimensions";

function webp(...chunks: { kind: string; data: Buffer }[]) {
  const bytes = Buffer.alloc(
    12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length + (chunk.data.length % 2), 0),
  );
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8);
  let offset = 12;
  for (const chunk of chunks) {
    bytes.write(chunk.kind, offset);
    bytes.writeUInt32LE(chunk.data.length, offset + 4);
    chunk.data.copy(bytes, offset + 8);
    offset += 8 + chunk.data.length + (chunk.data.length % 2);
  }
  return bytes;
}

test("PNG, JPEG and all WebP header forms expose dimensions without decoding and reject malformed headers", () => {
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(30, 16);
  png.writeUInt32BE(20, 20);
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xff,
    0xd9,
  ]);
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(29, 4, 3);
  extended.writeUIntLE(19, 7, 3);
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(29 | (19 << 14), 1);
  const lossy = Buffer.alloc(10);
  Buffer.from("9d012a", "hex").copy(lossy, 3);
  lossy.writeUInt16LE(30, 6);
  lossy.writeUInt16LE(20, 8);
  for (const [mime, bytes] of [
    ["image/png", png],
    ["image/jpeg", jpeg],
    ...[
      { kind: "VP8X", data: extended },
      { kind: "VP8L", data: lossless },
      { kind: "VP8 ", data: lossy },
    ].map((chunk) => ["image/webp", webp(chunk)] as const),
  ] as const) {
    expect(rasterDimensions(bytes, mime)).toEqual({ width: 30, height: 20 });
    expect(rasterDimensions(bytes.subarray(0, 12), mime)).toBeUndefined();
  }
  const conflicting = Buffer.from(extended);
  conflicting.writeUIntLE(9999, 4, 3);
  expect(
    rasterDimensions(
      webp({ kind: "VP8X", data: conflicting }, { kind: "VP8 ", data: lossy }),
      "image/webp",
    ),
  ).toBeUndefined();
  expect(
    rasterDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg"),
  ).toBeUndefined();
});
