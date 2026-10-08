export type LocalFaceName = {
  family: string;
  fullName: string;
  style: string;
  postscriptName?: string;
};
export type LocalAxis = { tag: string; name: string; min: number; default: number; max: number };
export type LocalInstance = {
  name: string;
  postscriptName?: string;
  coordinates: Record<string, number>;
};
type Table = { offset: number; length: number };
const normalized = (name: string) => name.replace(/[\s_-]+/g, "").toLowerCase();
const tag = (view: DataView, offset: number) =>
  String.fromCharCode(...[0, 1, 2, 3].map((index) => view.getUint8(offset + index)));
function tables(view: DataView, start: number): Map<string, Table> | undefined {
  if (
    start + 12 > view.byteLength ||
    ![0x00010000, 0x4f54544f, 0x74727565, 0x74797031].includes(view.getUint32(start))
  )
    return;
  const count = view.getUint16(start + 4);
  if (!count || start + 12 + count * 16 > view.byteLength) return;
  const result = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const record = start + 12 + i * 16,
      offset = view.getUint32(record + 8),
      length = view.getUint32(record + 12);
    if (offset + length > view.byteLength) return;
    const name = tag(view, record);
    if (result.has(name)) return;
    result.set(name, { offset, length });
  }
  return result;
}
function names(view: DataView, table?: Table) {
  const result = new Map<number, string>();
  if (!table || table.length < 6) return result;
  const { offset, length } = table,
    count = view.getUint16(offset + 2),
    strings = view.getUint16(offset + 4);
  if (6 + count * 12 > length || strings > length) return result;
  for (let i = 0; i < count; i++) {
    const record = offset + 6 + i * 12,
      platform = view.getUint16(record),
      language = view.getUint16(record + 4),
      id = view.getUint16(record + 6);
    const size = view.getUint16(record + 8),
      start = strings + view.getUint16(record + 10);
    if (
      ![0, 3].includes(platform) ||
      size % 2 ||
      start + size > length ||
      (result.has(id) && language !== 0x409)
    )
      continue;
    const value = new TextDecoder("utf-16be").decode(
      new Uint8Array(view.buffer, view.byteOffset + offset + start, size),
    );
    if (value && value.length <= 200 && !/[\u0000-\u001f]/.test(value)) result.set(id, value);
  }
  return result;
}
export function localFontMetadata(
  buffer: ArrayBuffer,
  face: LocalFaceName,
  fallbackWeight: number,
  fallbackItalic: boolean,
) {
  const view = new DataView(buffer),
    fallback = {
      weight: fallbackWeight,
      italic: fallbackItalic,
      axes: [] as LocalAxis[],
      instances: [] as LocalInstance[],
      features: [] as string[],
      collection: false,
      valid: false,
    };
  if (view.byteLength < 12) return fallback;
  const collection = view.getUint32(0) === 0x74746366;
  const starts = collection
    ? (() => {
        const count = view.getUint32(8);
        return count > 0 && count <= 1024 && 12 + count * 4 <= view.byteLength
          ? Array.from({ length: count }, (_, i) => view.getUint32(12 + i * 4))
          : [];
      })()
    : [0];
  for (const start of starts) {
    const directory = tables(view, start);
    if (!directory) continue;
    const labels = names(view, directory.get("name"));
    if (
      collection &&
      normalized(labels.get(4) ?? "") !== normalized(face.fullName) &&
      (!face.postscriptName || normalized(labels.get(6) ?? "") !== normalized(face.postscriptName))
    )
      continue;
    const result = { ...fallback, collection, valid: true };
    const os2 = directory.get("OS/2");
    if (os2 && os2.length >= 64) {
      const weight = view.getUint16(os2.offset + 4);
      if (weight >= 1 && weight <= 1000) result.weight = weight;
      result.italic = Boolean(view.getUint16(os2.offset + 62) & 1);
    }
    const fvar = directory.get("fvar");
    if (fvar) {
      // OS/2 describes the default instance, not necessarily the enumerated named face.
      result.weight = fallbackWeight;
      result.italic = fallbackItalic;
      if (fvar.length < 16 || view.getUint16(fvar.offset) !== 1) return { ...result, valid: false };
      const base = fvar.offset,
        axesStart = view.getUint16(base + 4),
        axisCount = view.getUint16(base + 8),
        axisSize = view.getUint16(base + 10),
        instanceCount = view.getUint16(base + 12),
        instanceSize = view.getUint16(base + 14);
      if (
        axesStart < 16 ||
        !axisCount ||
        axisCount > 64 ||
        axisSize < 20 ||
        instanceCount > 4096 ||
        instanceSize < 4 + axisCount * 4 ||
        axesStart + axisCount * axisSize + instanceCount * instanceSize > fvar.length
      )
        return { ...result, valid: false };
      result.axes = Array.from({ length: axisCount }, (_, i) => {
        const offset = base + axesStart + i * axisSize,
          axisTag = tag(view, offset);
        return {
          tag: axisTag,
          name: labels.get(view.getUint16(offset + 18)) ?? axisTag,
          min: view.getInt32(offset + 4) / 65536,
          default: view.getInt32(offset + 8) / 65536,
          max: view.getInt32(offset + 12) / 65536,
        };
      });
      if (
        result.axes.some((axis) => axis.min > axis.default || axis.default > axis.max) ||
        new Set(result.axes.map((axis) => axis.tag)).size !== axisCount
      )
        return { ...result, valid: false };
      result.instances = Array.from({ length: instanceCount }, (_, i) => {
        const offset = base + axesStart + axisCount * axisSize + i * instanceSize;
        return {
          name: labels.get(view.getUint16(offset)) ?? "",
          coordinates: Object.fromEntries(
            result.axes.map((axis, index) => [
              axis.tag,
              view.getInt32(offset + 4 + index * 4) / 65536,
            ]),
          ),
          postscriptName:
            instanceSize >= 6 + axisCount * 4
              ? labels.get(view.getUint16(offset + 4 + axisCount * 4))
              : undefined,
        };
      }).filter(
        (instance) =>
          instance.name &&
          result.axes.every(
            (axis) =>
              instance.coordinates[axis.tag] >= axis.min &&
              instance.coordinates[axis.tag] <= axis.max,
          ),
      );
      const instance = result.instances.find(
        (instance) =>
          normalized(instance.name) === normalized(face.style) ||
          normalized(`${face.family} ${instance.name}`) === normalized(face.fullName) ||
          (face.postscriptName &&
            instance.postscriptName &&
            normalized(instance.postscriptName) === normalized(face.postscriptName)),
      );
      if (instance) {
        const weight = instance.coordinates.wght;
        if (weight >= 1 && weight <= 1000) result.weight = Math.round(weight);
        if (instance.coordinates.ital !== undefined)
          result.italic = instance.coordinates.ital >= 0.5;
        else if (instance.coordinates.slnt !== undefined)
          result.italic = instance.coordinates.slnt !== 0;
      }
    }
    const features = new Set<string>();
    for (const key of ["GSUB", "GPOS"]) {
      const table = directory.get(key);
      if (!table || table.length < 10) continue;
      const list = view.getUint16(table.offset + 6);
      if (!list || list + 2 > table.length) continue;
      const count = view.getUint16(table.offset + list);
      if (list + 2 + count * 6 > table.length) continue;
      for (let i = 0; i < count; i++) features.add(tag(view, table.offset + list + 2 + i * 6));
    }
    result.features = [...features].sort();
    return result;
  }
  return { ...fallback, collection };
}
export function localFontExportError(buffer: ArrayBuffer, face: LocalFaceName): string | undefined {
  const info = localFontMetadata(buffer, face, 400, false);
  if (info.collection)
    return `${face.fullName} belongs to a font collection. Choose a standalone TTF/OTF face or replace this family with a web font before exporting.`;
  if (!info.valid)
    return `The font data for ${face.fullName} could not be read. Re-enable local font access or choose a web font before exporting.`;
  if (info.axes.length)
    return `${face.fullName} is a local variable font (${info.axes.map((axis) => axis.tag).join(", ")}). Choose its web version or a standalone static face before exporting.`;
}
