import { FeedbackProvider } from "@/components/workspace/send-feedback";
import { can } from "@/lib/organizations/roles";
import { cookies, headers } from "next/headers";
import {
  EDITOR_PANELS_COOKIE,
  EDITOR_TOOLBAR_COOKIE,
  editorToolbarPlacement,
} from "@/lib/editor-preferences";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getEditorFile } from "@/lib/design/document-service";
import { FileEditor } from "./file-editor";
import { agentsEnabled } from "@/lib/agents/config";
import { agentsSchemaReady, listAgentThreads } from "@/lib/agents/store";
import { connectionStatus as agentConnection } from "@/lib/agents/connections";
import { listDesignFiles } from "@/lib/design/service";
import { listReviews } from "@/lib/github/reviews";
import { functionalFeatureFlags } from "@/lib/functional-feature-flags";
import { DeferredFeatureFlagsProvider } from "@/lib/use-feature-flag";
import type { Metadata } from "next";
import { cache } from "react";

// Metadata and the page share the same authorized read within this request.
const editorData = cache(async (uid: string) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const loaded = await getEditorFile(session.user.id, uid);
  if (!loaded) notFound();
  return { session, ...loaded };
});

export async function generateMetadata({ params }: PageProps<"/files/[uid]">): Promise<Metadata> {
  const { uid } = await params;
  const { file } = await editorData(uid);
  return { title: `${file.name} · Tidy`, description: "Edit your Tidy design." };
}

export default async function DesignFilePage({ params, searchParams }: PageProps<"/files/[uid]">) {
  const { uid } = await params;
  const { session, file, document } = await editorData(uid);
  const flagsPromise = functionalFeatureFlags();
  const archived = file.archivedAt !== null;
  const githubReviews = archived
    ? undefined
    : flagsPromise.then((flags) =>
        flags["github-connector"]
          ? listReviews(session.user.id, uid).catch((error) => {
              console.error("Could not preload file reviews.", error);
              return { ready: false, reviews: [] };
            })
          : { ready: false, reviews: [] },
      );
  const agentsPromise = (async () => {
    if (archived || !agentsEnabled() || !(await agentsSchemaReady())) return undefined;
    const [files, initialThreads, connection] = await Promise.all([
      listDesignFiles(session.user.id, file.organizationId),
      listAgentThreads(session.user.id, file.organizationId, uid),
      agentConnection(session.user.id),
    ]);
    return {
      organizationId: file.organizationId,
      userId: session.user.id,
      canEdit: can(file.role, "edit"),
      canManage: can(file.role, "manage"),
      files: files.map(({ id, name }) => ({ id, name })),
      initialThreads,
      initialSnapshot: null,
      connection,
    };
  })().catch((error) => {
    console.error("Could not preload file agents.", error);
    return undefined;
  });
  // Optional rollout and integration requests must not hold up the canvas.
  const [query, cookieStore] = await Promise.all([searchParams, cookies()]);
  const requestedReview = query.review;
  const initialPanelsOpen = cookieStore.get(EDITOR_PANELS_COOKIE)?.value === "open";
  return (
    <DeferredFeatureFlagsProvider flags={flagsPromise}>
      <FeedbackProvider>
        <FileEditor
          canEdit={!archived && can(file.role, "edit")}
          archived={archived}
          key={uid}
          fileId={uid}
          fileName={file.name}
          organizationName={file.organizationName}
          backHref={
            archived
              ? "/files?view=archive"
              : file.folderId
                ? `/files?folder=${encodeURIComponent(file.folderId)}`
                : "/files"
          }
          initialDocument={document}
          agentSetup={{
            resourceUrl: new URL(
              "/api/mcp",
              process.env.BETTER_AUTH_URL || "http://localhost:3000",
            ).toString(),
            organizationId: file.organizationId,
          }}
          initialPanelsOpen={initialPanelsOpen}
          initialToolbarPlacement={editorToolbarPlacement(
            cookieStore.get(EDITOR_TOOLBAR_COOKIE)?.value,
          )}
          agents={agentsPromise}
          user={{ name: session.user.name, image: session.user.image }}
          githubReviews={githubReviews}
          viewerId={session.user.id}
          initialReviewId={typeof requestedReview === "string" ? requestedReview : undefined}
          initialFocusNodeId={typeof query.node === "string" ? query.node : undefined}
        />
      </FeedbackProvider>
    </DeferredFeatureFlagsProvider>
  );
}
