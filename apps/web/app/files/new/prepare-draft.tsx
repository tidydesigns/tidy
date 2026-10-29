import { designFileName } from "@/lib/design/file-name";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace/server";
import { can } from "@/lib/organizations/roles";
import { getEditorFile } from "@/lib/design/document-service";
import { blankDesignDocument } from "@tidy/design/document";
import { listBrowserFolders } from "@/lib/design/browser-queries";
import { FeedbackProvider } from "@/components/workspace/send-feedback";
import { DeferredFeatureFlagsProvider } from "@/lib/use-feature-flag";
import { functionalFeatureFlags } from "@/lib/functional-feature-flags";
import {
  EDITOR_PANELS_COOKIE,
  EDITOR_TOOLBAR_COOKIE,
  editorToolbarPlacement,
} from "@/lib/editor-preferences";
import { FileEditor } from "../[uid]/file-editor";

// This read-only branch is safe to prefetch. The same editor component and route
// remain mounted after creation, including subsequent action revalidations.
export async function prepareDraft(
  uid: string,
  query: Awaited<PageProps<"/files/[uid]">["searchParams"]>,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid))
    notFound();
  const { session, organization, role } = await getWorkspace(
    typeof query.organization === "string" ? query.organization : undefined,
  );
  // Reloads and browser history must load the actual content of committed drafts.
  if (await getEditorFile(session.user.id, uid)) return null;
  if (!can(role, "edit")) notFound();
  const folderId = typeof query.folder === "string" ? query.folder : null;
  if (
    folderId &&
    !(await listBrowserFolders(session.user.id, organization.id)).some(
      (folder) => folder.id === folderId,
    )
  )
    notFound();
  const preferences = await cookies();
  return (
    <DeferredFeatureFlagsProvider flags={functionalFeatureFlags()}>
      <FeedbackProvider>
        <FileEditor
          key={uid}
          fileId={uid}
          fileName={designFileName(uid)}
          organizationName={organization.name}
          creation={{ id: uid, organizationId: organization.id, folderId }}
          backHref={folderId ? `/files?folder=${encodeURIComponent(folderId)}` : "/files"}
          initialDocument={{ revision: 1, content: blankDesignDocument() }}
          user={{ name: session.user.name, image: session.user.image }}
          viewerId={session.user.id}
          initialPanelsOpen={preferences.get(EDITOR_PANELS_COOKIE)?.value === "open"}
          initialToolbarPlacement={editorToolbarPlacement(
            preferences.get(EDITOR_TOOLBAR_COOKIE)?.value,
          )}
        />
      </FeedbackProvider>
    </DeferredFeatureFlagsProvider>
  );
}
