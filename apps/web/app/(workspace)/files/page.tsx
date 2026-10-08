import { Suspense } from "react";
import { FilesSkeleton } from "@/components/workspace/page-skeletons";
import { filesPage } from "@/components/workspace/page-layout";
import { getWorkspace } from "@/lib/workspace/server";
import { observeOperation } from "@/lib/operation-observability";
import { can } from "@/lib/organizations/roles";
import { notFound } from "next/navigation";
import { listBrowserFiles, listBrowserFolders } from "@/lib/design/browser-queries";
import { FilesBrowser } from "@/app/files/files-browser";

export default async function FilesPage({ searchParams }: PageProps<"/files">) {
  const query = await searchParams;
  // Search-param transitions reuse the page segment. Key its data boundary so
  // Files/Archive/folders stream a new fallback instead of retaining old content.
  return (
    <Suspense
      key={`${query.view ?? "files"}:${query.folder ?? "root"}`}
      fallback={<FilesSkeleton />}
    >
      <FilesContent query={query} />
    </Suspense>
  );
}

async function FilesContent({ query }: { query: Awaited<PageProps<"/files">["searchParams"]> }) {
  const archived = query.view === "archive";
  const folderId = !archived && typeof query.folder === "string" ? query.folder : null;
  const { requestHeaders, session, organization, role } = await getWorkspace();

  const [folders, files] = await Promise.all([
    observeOperation(requestHeaders, "files.folders", () =>
      listBrowserFolders(session.user.id, organization.id),
    ),
    observeOperation(requestHeaders, "files.list", () =>
      listBrowserFiles(session.user.id, organization.id, archived, folderId),
    ),
  ]);
  const currentFolder = folderId ? folders.find((folder) => folder.id === folderId) : null;
  if (folderId && !currentFolder) notFound();

  return (
    <main className={filesPage} data-page-content="files">
      <FilesBrowser
        thumbnailScope={session.user.id}
        canEdit={can(role, "edit")}
        key={archived ? "archive" : (folderId ?? "files")}
        files={files.map((file) => ({
          ...file,
          updatedAt: file.updatedAt.toISOString(),
          createdAt: file.createdAt.toISOString(),
        }))}
        folders={folders.map((folder) => ({
          ...folder,
          updatedAt: folder.updatedAt.toISOString(),
          createdAt: folder.createdAt.toISOString(),
        }))}
        currentFolder={
          currentFolder
            ? {
                ...currentFolder,
                updatedAt: currentFolder.updatedAt.toISOString(),
                createdAt: currentFolder.createdAt.toISOString(),
              }
            : null
        }
        archived={archived}
        asOf={new Date().toISOString()}
      />
    </main>
  );
}
