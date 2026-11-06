import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useNativeBrowser } from "../../features/browser/use-native-browser";
import {
  emptyBrowserState,
  type BrowserAPI,
  type BrowserNativeBounds,
} from "../../../../shared/contracts/browser";

const scope = { projectId: crypto.randomUUID(), threadId: crypto.randomUUID() };
let latest: BrowserNativeBounds | null = null;
let presentations = 0;
let measurements = 0;
const api: BrowserAPI = {
  present: (_scope, bounds) => {
    latest = bounds;
    presentations++;
  },
  watch: () => () => {},
  input: () => {},
  copy: async () => {},
  download: async () => {},
  discardDraft: async () => {},
  command: async () => ({ state: emptyBrowserState }),
};
const root = createRoot(document.getElementById("root")!);
function Fixture({ preset = false }: { preset?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useNativeBrowser({
    api,
    scope,
    element,
    enabled: true,
    viewport: preset ? { width: 1440, height: 900 } : null,
  });
  return (
    <div
      ref={element}
      id="surface"
      style={{ position: "absolute", left: 300, top: 100, width: 320, height: 200 }}
    />
  );
}
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const frames = async (count = 3) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
async function run() {
  flushSync(() => root.render(<Fixture />));
  const surface = document.getElementById("surface")!;
  const measure = surface.getBoundingClientRect.bind(surface);
  surface.getBoundingClientRect = () => {
    measurements++;
    return measure();
  };
  // Let the operating system finish presenting the isolated test window.
  await frames(24);
  check(latest && !latest.occluded, "Visible preview did not attach");
  const chat = document.createElement("div");
  document.body.append(chat);
  await frames();
  measurements = 0;
  const before = presentations;
  for (let i = 0; i < 20; i++) {
    chat.append(document.createTextNode("text"));
    await frames(1);
  }
  await frames();
  check(
    measurements === 0 && presentations === before,
    `Streaming chat remeasured an unchanged preview (${measurements} reads, ${presentations - before} updates)`,
  );
  Object.assign(chat.style, {
    position: "absolute",
    left: "5px",
    top: "400px",
    width: "200px",
    height: "30px",
    overflow: "auto",
  });
  const tall = document.createElement("div");
  tall.style.height = "2000px";
  chat.append(tall);
  await frames();
  measurements = 0;
  for (let i = 0; i < 20; i++) {
    chat.scrollTop += 10;
    await frames(1);
  }
  await frames();
  check(measurements === 0, "Scrolling chat remeasured an unrelated native preview");
  const wrapper = document.createElement("div"),
    menu = document.createElement("div");
  wrapper.append(menu);
  document.body.append(wrapper);
  menu.setAttribute("role", "menu");
  Object.assign(menu.style, {
    position: "fixed",
    left: "5px",
    top: "120px",
    width: "180px",
    height: "100px",
  });
  await frames();
  check(!latest!.occluded, "An unrelated side menu obscured the preview");
  menu.style.left = "350px";
  await frames();
  check(latest!.occluded, "Overlapping menu did not obscure native content");
  menu.style.visibility = "hidden";
  await frames();
  check(!latest!.occluded, "Invisible menu obscured native content");
  menu.style.visibility = "visible";
  menu.setAttribute("role", "dialog");
  await frames();
  check(latest!.occluded, "An existing non-modal dialog was missed");
  wrapper.hidden = true;
  await frames();
  check(!latest!.occluded, "Hiding an overlay ancestor left the preview obscured");
  wrapper.hidden = false;
  await frames();
  check(latest!.occluded, "Showing an overlay ancestor did not obscure native content");
  menu.style.left = "5px";
  menu.setAttribute("aria-modal", "true");
  await frames();
  check(latest!.occluded, "A modal backdrop failed to obscure native content");
  wrapper.remove();
  await frames();
  check(!latest!.occluded, "Closing the overlay did not restore native content");
  flushSync(() => root.render(<Fixture preset />));
  await frames();
  check(
    latest?.viewport?.width === 1440 && latest.viewport.height === 900 && latest.zoom! < 0.25,
    "The desktop preset lost its logical size in a small pane",
  );
  flushSync(() => root.unmount());
  check(latest === null, "Unmounting left the native view attached");
  chat.remove();
}
const result = globalThis as typeof globalThis & {
  nativeLayoutTest?: { passed: boolean; message?: string };
};
void run().then(
  () => {
    result.nativeLayoutTest = { passed: true };
  },
  (error: unknown) => {
    result.nativeLayoutTest = {
      passed: false,
      message: error instanceof Error ? error.stack : String(error),
    };
  },
);
