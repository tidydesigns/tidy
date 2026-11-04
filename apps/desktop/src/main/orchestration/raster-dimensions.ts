/** Reads structural headers only; successful parsing does not establish decodability. */
export function rasterDimensions(bytes: Buffer, mime: string) {
  if (mime === "image/png") {
    if (
      bytes.length >= 33 &&
      bytes.toString("hex", 0, 8) === "89504e470d0a1a0a" &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString("ascii", 12, 16) === "IHDR"
    )
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    return;
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || marker === undefined) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) return;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    return;
  }
  if (
    mime !== "image/webp" ||
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return;
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 20) return;
  let dimensions: { width: number; height: number } | undefined;
  let offset = 12;
  while (offset + 8 <= end) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > end) return;
    let size: typeof dimensions;
    if (kind === "VP8X") {
      if (length < 10) return;
      size = {
        width: bytes.readUIntLE(offset + 4, 3) + 1,
        height: bytes.readUIntLE(offset + 7, 3) + 1,
      };
    } else if (kind === "VP8 ") {
      if (
        length < 10 ||
        bytes[offset] & 1 ||
        bytes.toString("hex", offset + 3, offset + 6) !== "9d012a"
      )
        return;
      size = {
        width: bytes.readUInt16LE(offset + 6) & 0x3fff,
        height: bytes.readUInt16LE(offset + 8) & 0x3fff,
      };
    } else if (kind === "VP8L") {
      if (length < 5 || bytes[offset] !== 0x2f || bytes[offset + 4] >>> 5) return;
      const bits = bytes.readUInt32LE(offset + 1);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (size) {
      if (dimensions && (dimensions.width !== size.width || dimensions.height !== size.height))
        return;
      dimensions = size;
    }
    offset += length + (length % 2);
  }
  return offset === end ? dimensions : undefined;
}
