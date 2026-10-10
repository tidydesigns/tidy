"use client";

import { ThemePreferenceControl } from "@/components/ui/theme-preference";
import { EditorPanelPreferenceControl } from "@/components/ui/editor-panel-preference";
import { EditorToolbarPreferenceControl } from "@/components/ui/editor-toolbar-preference";
import type { EditorToolbarPlacement } from "@/lib/editor-preferences";

export function PreferenceControls({
  initialEditorPanelsOpen,
  initialEditorToolbarPlacement,
}: {
  initialEditorPanelsOpen?: boolean;
  initialEditorToolbarPlacement?: EditorToolbarPlacement;
}) {
  return (
    <div className="max-w-xl space-y-8">
      <section aria-labelledby="appearance-heading" className="space-y-5">
        <h2 id="appearance-heading" className="text-xl font-semibold tracking-tight">
          Appearance
        </h2>
        <ThemePreferenceControl />
      </section>
      <section
        aria-labelledby="editor-preferences-heading"
        className="space-y-5 border-t border-primary-grey pt-8"
      >
        <h2 id="editor-preferences-heading" className="text-xl font-semibold tracking-tight">
          File editor
        </h2>
        <EditorPanelPreferenceControl initialOpen={initialEditorPanelsOpen} />
        <EditorToolbarPreferenceControl initialPlacement={initialEditorToolbarPlacement} />
      </section>
    </div>
  );
}
