import type { WebContents } from "electron";
import { trustedRendererURL } from "../app/renderer-security";
import { terminalShortcut } from "../../shared/models/terminal-shortcuts";

const focus = new WeakMap<WebContents, { active: boolean }>();
/** Intercept native menu accelerators only while a terminal owns keyboard focus. */
export function terminalKeyboardFocus(contents: WebContents, active: boolean, rendererURL: string) {
  let state = focus.get(contents);
  if (state) {
    state.active = active;
    return;
  }
  state = { active };
  focus.set(contents, state);
  const current = state;
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) current.active = false;
  });
  contents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown" ||
      input.isComposing ||
      !trustedRendererURL(contents.mainFrame.url, rendererURL)
    )
      return;
    const shortcut = terminalShortcut(input, current.active, process.platform === "darwin");
    if (!shortcut || (input.isAutoRepeat && !shortcut.startsWith("zoom-"))) return;
    event.preventDefault();
    contents.send("tidy:terminal-shortcut", shortcut);
  });
}
