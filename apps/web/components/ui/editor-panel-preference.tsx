"use client";

import { useId, useSyncExternalStore } from "react";
import { EDITOR_PANELS_COOKIE } from "@/lib/editor-preferences";
import { SelectMenu } from "./select-menu";

const choices = [
  { value: "closed", label: "Closed by default" },
  { value: "open", label: "Open by default" },
];
const changeEvent = "tidy-editor-panels-change";

function currentPreference() {
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim() === `${EDITOR_PANELS_COOKIE}=open`);
}

function subscribe(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  return () => window.removeEventListener(changeEvent, listener);
}

export function useEditorPanelsOpen(initialOpen = false) {
  return useSyncExternalStore(subscribe, currentPreference, () => initialOpen);
}

export function EditorPanelPreferenceControl({ initialOpen = false }: { initialOpen?: boolean }) {
  const open = useEditorPanelsOpen(initialOpen);
  const labelId = useId();

  return (
    <div className="text-sm font-medium">
      <span id={labelId}>Editor panels</span>
      <SelectMenu
        value={open ? "open" : "closed"}
        options={choices}
        label="Editor panels"
        labelledBy={labelId}
        onChange={(next) => {
          if (next !== "open" && next !== "closed") return;
          document.cookie = `${EDITOR_PANELS_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
          window.dispatchEvent(new Event(changeEvent));
        }}
        className="mt-2 w-full max-w-xs"
      />
    </div>
  );
}
