"use client";
import { FileEditor as SharedFileEditor } from "@tidy/editor";
import { EditorAgentConnection } from "./editor-agent-connection";
import { EditorHostProvider } from "@tidy/editor/host";
import Image from "next/image";
import { NavigationLink } from "@/components/ui/navigation-link";
import { renameDesignFile } from "../actions";
import posthog, { appErrorReporter } from "@/lib/posthog-client";
import { EditorThumbnail } from "../editor-thumbnail";
import { useEditorPerformance } from "./use-editor-performance";
import type { ComponentProps } from "react";
const host = {
  AgentConnection: EditorAgentConnection,
  Link: NavigationLink,
  Image,
  renameFile: renameDesignFile,
  reportError: appErrorReporter,
  capture: (event: string, properties: Record<string, unknown>) =>
    posthog.capture(event, properties),
  Thumbnail: EditorThumbnail,
  usePerformance: useEditorPerformance,
};
export function FileEditor(props: ComponentProps<typeof SharedFileEditor>) {
  return (
    <EditorHostProvider value={host}>
      <SharedFileEditor {...props} />
    </EditorHostProvider>
  );
}
