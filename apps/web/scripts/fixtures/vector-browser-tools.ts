import { inspectSvgImport } from "../../lib/design/svg-path-import";
import { parsePathContours, serializeContours } from "@bella/design/vector-geometry";
Object.assign(globalThis, {
  vectorBrowserTools: { inspectSvgImport, parsePathContours, serializeContours },
});
