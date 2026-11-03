"use client";
import "@/lib/schema-design-config";
import { FileEditor as SharedFileEditor } from "@tidy/editor";
import { EditorAgentConnection } from "./editor-agent-connection";
import { EditorHostProvider } from "@tidy/editor/host";
import Image from "next/image";
import { NavigationLink } from "@/components/ui/navigation-link";
import { renameDesignFile } from "../actions";
import posthog, { appErrorReporter } from "@/lib/posthog-client";
import { EditorThumbnail } from "../editor-thumbnail";
import { useEditorPerformance } from "./use-editor-performance";
import { useEffect, useMemo, type ComponentProps } from "react";
import { recordCommunityDesign } from "@/components/community/community-progress";
import { useFileCreation, type FileCreation } from "../new/use-file-creation";
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
export function FileEditor({
  creation,
  ...props
}: ComponentProps<typeof SharedFileEditor> & { creation?: FileCreation }) {
  const { persistenceReady, statusControl } = useFileCreation(creation);
  const { viewerId, fileId, canEdit = true, local, archived } = props;
  useEffect(() => {
    if (!viewerId || !canEdit || local || archived) return;
    let cancelled = false;
    const record = () => {
      if (cancelled) return;
      try {
        recordCommunityDesign(window.localStorage, viewerId, fileId);
      } catch {
        // Storage restrictions must not prevent the editor from opening.
      }
    };
    if (persistenceReady) void persistenceReady.then(record, () => {});
    else record();
    return () => {
      cancelled = true;
    };
  }, [viewerId, fileId, canEdit, local, archived, persistenceReady]);
  const editorHost = useMemo(
    () =>
      persistenceReady
        ? {
            ...host,
            persistenceReady,
            renameFile: async (fileId: string, name: string) => {
              await persistenceReady;
              return renameDesignFile(fileId, name);
            },
          }
        : host,
    [persistenceReady],
  );
  return (
    <EditorHostProvider value={editorHost}>
      <div className="h-dvh">
        <SharedFileEditor {...props} statusControl={statusControl ?? props.statusControl} />
      </div>
    </EditorHostProvider>
  );
}
