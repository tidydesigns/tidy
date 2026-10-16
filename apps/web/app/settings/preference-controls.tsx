"use client";

import { PrivacyChoicesButton } from "@/components/privacy/privacy-choices-button";
import { ThemePreferenceControl } from "@/components/ui/theme-preference";
import { EditorPanelPreferenceControl } from "@/components/ui/editor-panel-preference";
import { EditorToolbarPreferenceControl } from "@/components/ui/editor-toolbar-preference";
import { DeferredSection } from "@/components/ui/deferred-section";
import { McpAnalyticsChoice } from "@/components/privacy/mcp-analytics-choice";
import type { EditorToolbarPlacement } from "@/lib/editor-preferences";

export function PreferenceControls({
  initialMcpAnalytics,
  initialEditorPanelsOpen,
  initialEditorToolbarPlacement,
}: {
  initialMcpAnalytics?: { enabled: boolean } | null | Promise<{ enabled: boolean } | null>;
  initialEditorPanelsOpen?: boolean;
  initialEditorToolbarPlacement?: EditorToolbarPlacement;
}) {
  return (
    <div className="max-w-xl space-y-8">
      <section aria-labelledby="appearance-heading" className="space-y-5">
        <h2 data-ph-public id="appearance-heading" className="text-xl font-semibold tracking-tight">
          Appearance
        </h2>
        <ThemePreferenceControl />
      </section>
      <section
        aria-labelledby="editor-preferences-heading"
        className="space-y-5 border-t border-primary-grey pt-8"
      >
        <h2
          data-ph-public
          id="editor-preferences-heading"
          className="text-xl font-semibold tracking-tight"
        >
          File editor
        </h2>
        <EditorPanelPreferenceControl initialOpen={initialEditorPanelsOpen} />
        <EditorToolbarPreferenceControl initialPlacement={initialEditorToolbarPlacement} />
      </section>
      <section
        aria-labelledby="privacy-preferences-heading"
        className="space-y-5 border-t border-primary-grey pt-8"
      >
        <h2
          data-ph-public
          id="privacy-preferences-heading"
          className="text-xl font-semibold tracking-tight"
        >
          Privacy
        </h2>
        <PrivacyChoicesButton />
        {initialMcpAnalytics && (
          <DeferredSection value={initialMcpAnalytics} label="MCP privacy choice">
            {(choice) => (choice ? <McpAnalyticsChoice initialEnabled={choice.enabled} /> : null)}
          </DeferredSection>
        )}
      </section>
    </div>
  );
}
