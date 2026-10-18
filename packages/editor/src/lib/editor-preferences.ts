export const EDITOR_PANELS_COOKIE = "tidy-editor-panels";
export const EDITOR_TOOLBAR_COOKIE = "tidy-editor-toolbar";
export type EditorToolbarPlacement = "left" | "bottom";

export function editorToolbarPlacement(value: string | undefined): EditorToolbarPlacement {
  return value === "bottom" ? "bottom" : "left";
}
