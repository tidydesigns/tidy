import { test, expect } from "bun:test";
import { localFontMetadata, localFontExportError } from "./local-metadata";
const face = {
  family: "Example",
  fullName: "Example Book",
  style: "Book",
  postscriptName: "Example-Book",
};
function sfnt(entries: Record<string, ArrayBuffer>) {
  const values = Object.entries(entries);
  let offset = 12 + values.length * 16;
  const result = new ArrayBuffer(
      offset + values.reduce((sum, [, data]) => sum + data.byteLength, 0),
    ),
    view = new DataView(result);
  view.setUint32(0, 0x10000);
  view.setUint16(4, values.length);
  values.forEach(([tag, data], i) => {
    const record = 12 + i * 16;
    [...tag].forEach((c, n) => view.setUint8(record + n, c.charCodeAt(0)));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, data.byteLength);
    new Uint8Array(result, offset, data.byteLength).set(new Uint8Array(data));
    offset += data.byteLength;
  });
  return result;
}
function names(values: Record<number, string>) {
  const entries = Object.entries(values),
    start = 6 + entries.length * 12;
  const buffer = new ArrayBuffer(
      start + entries.reduce((sum, [, text]) => sum + text.length * 2, 0),
    ),
    view = new DataView(buffer);
  view.setUint16(2, entries.length);
  view.setUint16(4, start);
  let offset = 0;
  entries.forEach(([id, text], i) => {
    const record = 6 + i * 12;
    view.setUint16(record, 3);
    view.setUint16(record + 2, 1);
    view.setUint16(record + 4, 0x409);
    view.setUint16(record + 6, Number(id));
    view.setUint16(record + 8, text.length * 2);
    view.setUint16(record + 10, offset);
    [...text].forEach((c, n) => view.setUint16(start + offset + n * 2, c.charCodeAt(0)));
    offset += text.length * 2;
  });
  return buffer;
}
function os2(weight: number, italic = false) {
  const value = new ArrayBuffer(64),
    view = new DataView(value);
  view.setUint16(4, weight);
  view.setUint16(62, Number(italic));
  return value;
}
function variable() {
  const buffer = new ArrayBuffer(70),
    view = new DataView(buffer);
  view.setUint16(0, 1);
  view.setUint16(4, 16);
  view.setUint16(8, 2);
  view.setUint16(10, 20);
  view.setUint16(12, 1);
  view.setUint16(14, 14);
  for (const [i, tag, min, normal, max, name] of [
    [0, "wght", 100, 400, 900, 257],
    [1, "wdth", 50, 100, 200, 258],
  ] as const) {
    const offset = 16 + i * 20;
    [...tag].forEach((c, index) => view.setUint8(offset + index, c.charCodeAt(0)));
    view.setInt32(offset + 4, min * 65536);
    view.setInt32(offset + 8, normal * 65536);
    view.setInt32(offset + 12, max * 65536);
    view.setUint16(offset + 18, name);
  }
  view.setUint16(56, 256);
  view.setInt32(60, 350 * 65536);
  view.setInt32(64, 85 * 65536);
  view.setUint16(68, 259);
  return buffer;
}
test("named variable face metadata uses instance coordinates instead of the OS/2 default", () => {
  const buffer = sfnt({
    "OS/2": os2(400),
    name: names({
      4: "Example Regular",
      256: "Book",
      257: "Weight",
      258: "Width",
      259: "Example-Book",
    }),
    fvar: variable(),
  });
  const metadata = localFontMetadata(buffer, face, 400, false);
  expect(metadata).toMatchObject({ valid: true, weight: 350, italic: false, collection: false });
  expect(metadata.axes).toEqual([
    { tag: "wght", name: "Weight", min: 100, default: 400, max: 900 },
    { tag: "wdth", name: "Width", min: 50, default: 100, max: 200 },
  ]);
  expect(metadata.instances[0]).toMatchObject({
    name: "Book",
    postscriptName: "Example-Book",
    coordinates: { wght: 350, wdth: 85 },
  });
  expect(localFontExportError(buffer, face)).toContain(
    "Example Book is a local variable font (wght, wdth)",
  );
  expect(localFontExportError(buffer, face)).toContain("standalone static face");
});
test("collections resolve the selected physical face and exports name the required remedy", () => {
  const first = sfnt({
    "OS/2": os2(400),
    name: names({ 4: "Example Regular", 6: "Example-Regular" }),
  });
  const second = sfnt({
    "OS/2": os2(550, true),
    name: names({ 4: face.fullName, 6: face.postscriptName }),
  });
  const result = new ArrayBuffer(20 + first.byteLength + second.byteLength),
    view = new DataView(result);
  view.setUint32(0, 0x74746366);
  view.setUint32(4, 0x10000);
  view.setUint32(8, 2);
  [first, second].forEach((font, index) => {
    const start = 20 + (index ? first.byteLength : 0);
    view.setUint32(12 + index * 4, start);
    new Uint8Array(result, start, font.byteLength).set(new Uint8Array(font));
    for (let i = 0; i < new DataView(font).getUint16(4); i++) {
      const field = start + 12 + i * 16 + 8;
      view.setUint32(field, view.getUint32(field) + start);
    }
  });
  expect(localFontMetadata(result, face, 400, false)).toMatchObject({
    collection: true,
    valid: true,
    weight: 550,
    italic: true,
  });
  expect(localFontExportError(result, face)).toContain("Example Book belongs to a font collection");
  expect(localFontExportError(result, face)).toContain("standalone TTF/OTF face");
});
test("static fonts remain embeddable; malformed/truncated metadata fails safely", () => {
  const buffer = sfnt({ "OS/2": os2(550, true) });
  expect(localFontMetadata(buffer, face, 400, false)).toMatchObject({
    valid: true,
    weight: 550,
    italic: true,
  });
  expect(localFontExportError(buffer, face)).toBeUndefined();
  for (let length = 0; length < buffer.byteLength; length++)
    expect(localFontExportError(buffer.slice(0, length), face)).toContain("could not be read");
  const invalid = sfnt({ fvar: variable() });
  new DataView(invalid).setUint32(20, 0xfffffff0);
  expect(localFontMetadata(invalid, face, 700, true)).toMatchObject({
    valid: false,
    weight: 700,
    italic: true,
  });
});

test("OpenType feature evaluation reads the feature lists from both layout tables", () => {
  const layout = (tag: string) => {
    const buffer = new ArrayBuffer(22),
      view = new DataView(buffer);
    view.setUint16(0, 1);
    view.setUint16(6, 10);
    view.setUint16(10, 1);
    [...tag].forEach((c, i) => view.setUint8(12 + i, c.charCodeAt(0)));
    view.setUint16(16, 8);
    return buffer;
  };
  expect(
    localFontMetadata(sfnt({ GSUB: layout("liga"), GPOS: layout("kern") }), face, 400, false)
      .features,
  ).toEqual(["kern", "liga"]);
});
