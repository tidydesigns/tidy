import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { FilesBrowser } from "@/app/files/files-browser";
import {
  performanceDocument,
  selectionPerformanceDocument,
} from "@/lib/design/examples/performance";
import { thumbnailVersion } from "@/lib/design/thumbnail-version";
import { ThumbnailPrewarmFixture } from "./thumbnail-prewarm-fixture";
export default async function PerformancePreview({
  searchParams,
}: PageProps<"/dev/performance-preview">) {
  if (process.env.NODE_ENV !== "development") {
    // Opt-in production-build diagnostics are restricted to loopback requests.
    const host = (await headers()).get("host")?.split(":")[0];
    if (
      process.env.TIDY_LOCAL_PERFORMANCE_FIXTURES !== "1" ||
      (host !== "localhost" && host !== "127.0.0.1")
    )
      notFound();
  }
  const query = await searchParams;
  if (query.prewarm === "1") return <ThumbnailPrewarmFixture />;
  if (query.workspace === "1") {
    const count = Math.min(500, Math.max(1, Number(query.files) || 20));
    const timestamp = "2026-10-03T12:00:00.000Z";
    const files = Array.from({ length: count }, (_, index) => ({
      id: `benchmark-${index}`,
      name: `File ${index}`,
      folderId: null,
      updatedAt: timestamp,
      createdAt: timestamp,
      creatorName: "Local fixture",
      creatorImage: null,
      frameCount: 0,
      rectangleCount: 0,
      nodeCount: 100,
      documentRevision: 1,
      thumbnailVersion:
        query.cached === "1"
          ? thumbnailVersion(`1:${timestamp}`)
          : query.cached === "legacy"
            ? `1:${timestamp}`
            : null,
    }));
    return (
      <main className="mx-auto max-w-6xl p-6">
        <FilesBrowser
          files={files}
          folders={[]}
          currentFolder={null}
          archived={false}
          thumbnailScope="local-fixture"
          canEdit={query.edit === "1"}
          asOf={timestamp}
        />
      </main>
    );
  }
  const count = [100, 1000, 5000].includes(Number(query.nodes)) ? Number(query.nodes) : 1000;
  const selectionCount = [100, 1000, 4999].includes(Number(query.selection))
    ? Number(query.selection)
    : null;
  return (
    <FileEditor
      fileId="performance-fixture"
      fileName={selectionCount ? `${selectionCount} selectable siblings` : `${count} layers`}
      organizationName="Local performance fixture"
      backHref="/files"
      initialDocument={{
        revision: 1,
        content: selectionCount
          ? selectionPerformanceDocument(selectionCount)
          : performanceDocument(count),
      }}
      local
      initialPanelsOpen={query.compact !== "1"}
    />
  );
}
