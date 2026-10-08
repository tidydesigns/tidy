import { FeedbackProvider } from "@/components/workspace/send-feedback";
import { can } from "@/lib/organizations/roles";
import { cookies, headers } from "next/headers";
import { EDITOR_PANELS_COOKIE } from "@/lib/editor-preferences";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDesignFile } from "@/lib/design/service";
import { ensureEditorDocument, getArchivedEditorDocument } from "@/lib/design/document-service";
import { FileEditor } from "./file-editor";
import { agentsEnabled } from "@/lib/agents/config";
import { agentsSchemaReady, listAgentThreads } from "@/lib/agents/store";
import { connectionStatus as agentConnection } from "@/lib/agents/connections";
import { listDesignFiles } from "@/lib/design/service";
import { listReviews } from "@/lib/github/reviews";

export default async function DesignFilePage({ params, searchParams }: PageProps<"/files/[uid]">) {
  const { uid } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const file = await getDesignFile(session.user.id, uid, false, true);
  if (!file) notFound();
  const archived = file.archivedAt !== null;
  const githubReviews = archived
    ? undefined
    : listReviews(session.user.id, uid).catch((error) => {
        console.error("Could not preload file reviews.", error);
        return { ready: false, reviews: [] };
      });
  const documentPromise = archived
    ? getArchivedEditorDocument(session.user.id, uid)
    : ensureEditorDocument(session.user.id, uid);
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
  // The canvas needs the document, not the optional agent panel's queries.
  // Stream those separately so delayed integrations cannot block editing.
  const [document, query, cookieStore] = await Promise.all([
    documentPromise,
    searchParams,
    cookies(),
  ]);
  if (!document) notFound();
  const requestedReview = query.review;
  const initialPanelsOpen = cookieStore.get(EDITOR_PANELS_COOKIE)?.value === "open";
  return (
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
        initialPanelsOpen={initialPanelsOpen}
        agents={agentsPromise}
        user={{ name: session.user.name, image: session.user.image }}
        githubReviews={githubReviews}
        viewerId={session.user.id}
        initialReviewId={typeof requestedReview === "string" ? requestedReview : undefined}
      />
    </FeedbackProvider>
  );
}
