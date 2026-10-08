import type { FontFamily } from "./font-utils";
let catalog: typeof import("./catalog") | undefined;
let loading: Promise<typeof import("./catalog")> | undefined;
export const loadedWebFonts = () => catalog?.webFonts ?? EMPTY;
export const loadedWebFont = (name: string) => catalog?.webFontByName.get(name.toLowerCase());
export function loadFontCatalog() {
  return (loading ??= import("./catalog").then((value) => {
    catalog = value;
    return value;
  }));
}
const EMPTY: FontFamily[] = [];
