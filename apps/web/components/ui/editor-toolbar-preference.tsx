"use client";

import { useId, useSyncExternalStore } from "react";
import {
  EDITOR_TOOLBAR_COOKIE,
  editorToolbarPlacement,
  type EditorToolbarPlacement,
} from "@/lib/editor-preferences";
import { SelectMenu } from "./select-menu";

const changeEvent = "tidy-editor-toolbar-change";
const choices = [
  { value: "left", label: "Left (vertical)" },
  { value: "bottom", label: "Bottom (horizontal)" },
];

function currentPlacement() {
  const value = document.cookie
    .split(";")
    .find((cookie) => cookie.trim().startsWith(`${EDITOR_TOOLBAR_COOKIE}=`))
    ?.trim()
    .slice(EDITOR_TOOLBAR_COOKIE.length + 1);
  return editorToolbarPlacement(value);
}

function subscribe(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  window.addEventListener("focus", listener);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("focus", listener);
  };
}

export function useEditorToolbarPlacement(initialPlacement: EditorToolbarPlacement = "left") {
  return useSyncExternalStore(subscribe, currentPlacement, () => initialPlacement);
}

export function EditorToolbarPreferenceControl({
  initialPlacement = "left",
}: {
  initialPlacement?: EditorToolbarPlacement;
}) {
  const placement = useEditorToolbarPlacement(initialPlacement);
  const labelId = useId();

  return (
    <div className="text-sm font-medium">
      <span id={labelId}>Minimised toolbar</span>
      <SelectMenu
        value={placement}
        options={choices}
        label="Minimised toolbar"
        labelledBy={labelId}
        onChange={(next) => {
          if (next !== "left" && next !== "bottom") return;
          document.cookie = `${EDITOR_TOOLBAR_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
          window.dispatchEvent(new Event(changeEvent));
        }}
        className="mt-2 w-full max-w-xs"
      />
    </div>
  );
}
