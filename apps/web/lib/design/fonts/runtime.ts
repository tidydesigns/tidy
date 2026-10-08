import {
  closestFontStyle,
  fontFamilies,
  fontStyleLabel,
  genericFonts,
  googleFontUrl,
  systemFonts,
  type FontFamily,
} from "./font-utils";
import { loadedWebFont, loadFontCatalog } from "./catalog-loader";
import { mapConcurrent } from "../../map-concurrent";
import { localFontMetadata, localFontExportError } from "./local-metadata";
import { fontCssForText } from "./export-css";
export type FontStatus = "loading" | "loaded" | "missing" | "error";
type LocalFont = {
  family: string;
  fullName: string;
  style: string;
  postscriptName?: string;
  blob: () => Promise<Blob>;
};
type LocalFontWindow = Window & { queryLocalFonts?: () => Promise<LocalFont[]> };
const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
type FontSource = FontFamily["source"];
const fontKey = (
  family: string,
  weight: number,
  italic: boolean,
  source?: FontSource,
  face?: string,
) =>
  `${family.toLowerCase()}|${weight}|${italic}|${source ?? "auto"}|${source === "local" ? (face ?? "") : ""}`;

let measurementContext: CanvasRenderingContext2D | null | undefined;
export function installedFont(family: string, sample = "mmmmmmmmWWiiii0123456789") {
  if (genericFonts.has(family.toLowerCase())) return true;
  const context = (measurementContext ??= document.createElement("canvas").getContext("2d"));
  if (!context) return false;
  return ["monospace", "serif", "sans-serif"].some((fallback) => {
    context.font = `32px ${fallback}`;
    const width = context.measureText(sample).width;
    context.font = `32px ${JSON.stringify(family)}, ${fallback}`;
    return Math.abs(context.measureText(sample).width - width) > 0.01;
  });
}
function localWeight(style: string) {
  const value = style.toLowerCase().replace(/[ -]/g, "");
  return /thin/.test(value)
    ? 100
    : /extralight|ultralight/.test(value)
      ? 200
      : /light/.test(value)
        ? 300
        : /medium/.test(value)
          ? 500
          : /semibold|demibold/.test(value)
            ? 600
            : /extrabold|ultrabold/.test(value)
              ? 800
              : /black|heavy/.test(value)
                ? 900
                : /bold/.test(value)
                  ? 700
                  : 400;
}
export function sfntStyle(buffer: ArrayBuffer, fallbackWeight: number, fallbackItalic: boolean) {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint32(0) === 0x74746366)
    return { weight: fallbackWeight, italic: fallbackItalic };
  for (let i = 0; i < view.getUint16(4); i++) {
    const table = 12 + i * 16;
    if (table + 16 > view.byteLength) break;
    if (view.getUint32(table) !== 0x4f532f32) continue;
    const offset = view.getUint32(table + 8),
      length = view.getUint32(table + 12);
    if (offset + length > view.byteLength || length < 64) break;
    const weight = view.getUint16(offset + 4);
    return {
      weight: weight >= 1 && weight <= 1000 ? weight : fallbackWeight,
      italic: Boolean(view.getUint16(offset + 62) & 1),
    };
  }
  return { weight: fallbackWeight, italic: fallbackItalic };
}

class FontRegistry {
  private listeners = new Set<() => void>();
  private version = 0;
  private states = new Map<string, FontStatus>();
  private stylesheets = new Map<string, Promise<string>>();
  private requests = new Map<string, Promise<void>>();
  private locals = new Map<string, LocalFont[]>();
  private localMetadata = new Map<string, Promise<void>>();
  private localFamilies = new Map<string, FontFamily>();
  private styleElements = new Map<string, HTMLStyleElement>();
  private owners = new Map<symbol, Set<string>>();
  private localList: FontFamily[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  serverSnapshot = () => 0;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  private status(
    family: string,
    weight: number,
    italic: boolean,
    status: FontStatus,
    source?: FontSource,
    face?: string,
  ) {
    const key = fontKey(family, weight, italic, source, face);
    if (this.states.get(key) !== status) {
      this.states.set(key, status);
      this.changed();
    }
  }
  getStatus(family: string, weight: number, italic: boolean, source?: FontSource, face?: string) {
    return this.states.get(
      fontKey(fontFamilies(family)[0] ?? "system-ui", weight, italic, source, face),
    );
  }
  font(family: string, source?: FontSource) {
    const web = loadedWebFont(family),
      local = this.localFamilies.get(family.toLowerCase()),
      system = systemFonts.find((font) => font.family.toLowerCase() === family.toLowerCase());
    return source === "web"
      ? web
      : source === "local"
        ? local
        : source === "system"
          ? system
          : (web ?? system ?? local);
  }
  localFonts() {
    return this.localList;
  }
  supportsLocal() {
    return typeof window !== "undefined" && Boolean((window as LocalFontWindow).queryLocalFonts);
  }
  async connectLocal() {
    const query = (window as LocalFontWindow).queryLocalFonts;
    if (!query) throw new Error("Local font access is unavailable in this browser.");
    const fonts = await query.call(window);
    this.locals.clear();
    this.localFamilies.clear();
    this.localMetadata.clear();
    for (const key of this.requests.keys()) if (key.includes("|local|")) this.requests.delete(key);
    for (const key of this.states.keys()) if (key.includes("|local|")) this.states.delete(key);
    for (const font of fonts) {
      if (font.family.length > 100 || font.fullName.length > 200) continue;
      const key = font.family.toLowerCase(),
        entries = this.locals.get(key) ?? [];
      if (!entries.some((item) => item.fullName === font.fullName))
        this.locals.set(key, [...entries, font]);
    }
    for (const [key, entries] of this.locals)
      this.localFamilies.set(key, {
        family: entries[0].family,
        source: "local",
        category: "Local",
        metadataReady: false,
        styles: entries.map((entry) => {
          const weight = localWeight(entry.style),
            italic = /italic|oblique/i.test(entry.style);
          return {
            weight,
            italic,
            label: entry.style || fontStyleLabel(weight, italic),
            face: entry.fullName,
          };
        }),
      });
    this.localList = [...this.localFamilies.values()];
    this.changed();
  }
  private prepareLocal(family: FontFamily) {
    const key = family.family.toLowerCase(),
      existing = this.localMetadata.get(key);
    if (existing) return existing;
    const request = Promise.all(
      this.locals.get(key)!.map(async (entry) => {
        const blob = await entry.blob(),
          buffer = await blob.arrayBuffer();
        const metadata = localFontMetadata(
          buffer,
          entry,
          localWeight(entry.style),
          /italic|oblique/i.test(entry.style),
        );
        if (!metadata.valid)
          throw new Error(
            `The font data for ${entry.fullName} could not be read. Re-enable local font access or choose a web font.`,
          );
        const style = { weight: metadata.weight, italic: metadata.italic };
        const face = new FontFace(entry.fullName, `local(${JSON.stringify(entry.fullName)})`, {
          weight: String(style.weight),
          style: style.italic ? "italic" : "normal",
        });
        await face.load();
        document.fonts.add(face);
        return {
          ...style,
          label: entry.style || fontStyleLabel(style.weight, style.italic),
          face: entry.fullName,
        };
      }),
    ).then((styles) => {
      this.localFamilies.set(key, { ...family, styles, metadataReady: true });
      this.localList = [...this.localFamilies.values()];
      this.changed();
    });
    this.localMetadata.set(key, request);
    void request.catch(() => this.localMetadata.delete(key));
    return request;
  }
  retainFamilies(families: string[]) {
    const owner = Symbol();
    this.owners.set(
      owner,
      new Set(families.map((value) => (fontFamilies(value)[0] ?? "system-ui").toLowerCase())),
    );
    return () => {
      this.owners.delete(owner);
      this.pruneStylesheets();
    };
  }
  private pruneStylesheets(protectedKey?: string) {
    const active = new Set([...this.owners.values()].flatMap((families) => [...families]));
    for (const [key, element] of this.styleElements) {
      if (this.styleElements.size <= 64) break;
      if (active.has(key) || key === protectedKey) continue;
      element.remove();
      this.styleElements.delete(key);
      this.stylesheets.delete(key);
      for (const request of this.requests.keys())
        if (request.startsWith(key + "|")) this.requests.delete(request);
      for (const state of this.states.keys())
        if (state.startsWith(key + "|")) this.states.delete(state);
    }
  }
  private stylesheet(font: FontFamily) {
    const key = font.family.toLowerCase(),
      existing = this.stylesheets.get(key);
    if (existing) {
      const element = this.styleElements.get(key);
      if (element) {
        this.styleElements.delete(key);
        this.styleElements.set(key, element);
      }
      return existing;
    }
    const request = fetch(googleFontUrl(font)).then(async (response) => {
      if (!response.ok) throw new Error("Could not load this font.");
      const css = await response.text();
      if (!css.includes("@font-face")) throw new Error("This font is unavailable.");
      const style = document.createElement("style");
      style.dataset.designFont = font.family;
      style.textContent = css;
      document.head.appendChild(style);
      this.styleElements.set(key, style);
      this.pruneStylesheets(key);
      return css;
    });
    this.stylesheets.set(key, request);
    void request.catch(() => this.stylesheets.delete(key));
    return request;
  }
  async load(
    value: string,
    weight = 400,
    italic = false,
    text = "Aa",
    source?: FontSource,
    faceName?: string,
  ) {
    faceName = source === "local" ? faceName : undefined;
    const family = fontFamilies(value)[0] ?? "system-ui";
    if (
      source === "web" ||
      (!source &&
        !genericFonts.has(family.toLowerCase()) &&
        !systemFonts.some((font) => font.family.toLowerCase() === family.toLowerCase()) &&
        !this.localFamilies.has(family.toLowerCase()))
    )
      await loadFontCatalog();
    const font = this.font(family, source);
    const key = `${fontKey(family, weight, italic, source, faceName)}|${[...new Set(text)].sort().join("")}`;
    const existing = this.requests.get(key);
    if (existing) return existing;
    if (source === "web" && !font) {
      this.status(family, weight, italic, "missing", source, faceName);
      return;
    }
    if ((!font || font.source === "system") && !(source === "local" && faceName)) {
      this.status(
        family,
        weight,
        italic,
        installedFont(family, text + "mmmmWWii") ? "loaded" : "missing",
        source,
        faceName,
      );
      this.requests.set(key, Promise.resolve());
      while (this.requests.size > 256) this.requests.delete(this.requests.keys().next().value!);
      return;
    }
    this.status(family, weight, italic, "loading", source, faceName);
    const request = (async () => {
      try {
        if (font?.source === "web") await this.stylesheet(font);
        else if (font?.source === "local") await this.prepareLocal(font);
        if (
          source === "local" &&
          faceName &&
          ![...document.fonts].some((face) => face.family.replace(/['"]/g, "") === faceName)
        ) {
          const face = new FontFace(faceName, `local(${JSON.stringify(faceName)})`, {
            weight: String(weight),
            style: italic ? "italic" : "normal",
          });
          await face.load();
          document.fonts.add(face);
        }
        const actualFamily = faceName ?? family;
        const faces = await document.fonts.load(
          `${italic ? "italic" : "normal"} ${weight} 16px ${JSON.stringify(actualFamily)}`,
          text || font?.sample || "Aa",
        );
        // A script-specific font may not contain the preview's Latin characters.
        if (!faces.length) {
          const face = [...document.fonts].find(
            (face) => face.family.replace(/['"]/g, "").toLowerCase() === actualFamily.toLowerCase(),
          );
          if (face) await face.load();
          else if (!installedFont(actualFamily, text + "mmmmWWii"))
            throw new Error("This font is unavailable.");
        }
        this.status(family, weight, italic, "loaded", source, faceName);
      } catch {
        this.status(
          family,
          weight,
          italic,
          source === "local" ? "missing" : "error",
          source,
          faceName,
        );
        this.requests.delete(key);
      }
    })();
    this.requests.set(key, request);
    while (this.requests.size > 256) this.requests.delete(this.requests.keys().next().value!);
    return request;
  }
  async retry(
    family: string,
    weight: number,
    italic: boolean,
    text: string,
    source?: FontSource,
    face?: string,
  ) {
    for (const key of this.requests.keys())
      if (key.startsWith(fontKey(fontFamilies(family)[0] ?? family, weight, italic, source, face)))
        this.requests.delete(key);
    return this.load(family, weight, italic, text, source, face);
  }
  async exportCss(
    values: {
      family: string;
      weight: number;
      italic: boolean;
      text: string;
      source?: FontSource;
      face?: string;
    }[],
  ) {
    const css: string[] = [];
    for (const value of values) {
      await this.load(
        value.family,
        value.weight,
        value.italic,
        value.text,
        value.source,
        value.face,
      );
      const family = fontFamilies(value.family)[0],
        font = this.font(family, value.source);
      if (value.source === "local") {
        const selectedFace =
          value.face ??
          (font ? closestFontStyle(font, value.weight, value.italic).face : undefined);
        const entry = [...this.locals.values()]
          .flat()
          .find(
            (font) => selectedFace && font.fullName.toLowerCase() === selectedFace.toLowerCase(),
          );
        const blob = await entry?.blob();
        if (!blob || !entry)
          throw new Error(
            this.supportsLocal()
              ? `Enable local fonts and select an installed face for ${family}, or replace it with a web font before exporting.`
              : `This browser cannot access local font bytes for ${family}. Choose a web font, or export from a browser with local font access.`,
          );
        const error = localFontExportError(await blob.arrayBuffer(), entry);
        if (error) throw new Error(error);
        css.push(
          `@font-face{font-family:${JSON.stringify(value.face ?? family)};font-weight:${value.weight};font-style:${value.italic ? "italic" : "normal"};src:url(${await asDataUrl(blob)});}`,
        );
        continue;
      }
      if (
        ["missing", "error"].includes(
          this.getStatus(value.family, value.weight, value.italic, value.source, value.face) ?? "",
        )
      )
        throw new Error(
          `${family} is unavailable on this device. Retry loading it or replace this family before exporting.`,
        );
      if (!font || font.source !== "web") continue;
      if (
        this.getStatus(value.family, value.weight, value.italic, value.source, value.face) !==
        "loaded"
      )
        throw new Error(`Load ${family} before exporting.`);
      const fallback = closestFontStyle(font, value.weight, value.italic);
      const weight = font.weightRange
        ? Math.max(font.weightRange[0], Math.min(font.weightRange[1], value.weight))
        : fallback.weight;
      css.push(fontCssForText(await this.stylesheet(font), weight, fallback.italic, value.text));
    }
    const combined = [...new Set(css)].join("\n"),
      urls = [
        ...new Set(
          [...combined.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(
            (match) => match[1],
          ),
        ),
      ];
    const replacements = await mapConcurrent(urls, 4, async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not include a font in the export.");
      const blob = await response.blob();
      const data = await asDataUrl(blob);
      return [url, data] as const;
    });
    return replacements.reduce((css, [url, data]) => css.split(url).join(data), combined);
  }
}
export const fontRegistry = new FontRegistry();
