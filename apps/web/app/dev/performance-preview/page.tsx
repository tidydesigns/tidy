import { notFound } from "next/navigation";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { FilesBrowser } from "@/app/files/files-browser";
import { performanceDocument } from "@/lib/design/examples/performance";
import { thumbnailVersion } from "@/lib/design/thumbnail-version";
import { ThumbnailPrewarmFixture } from "./thumbnail-prewarm-fixture";
export default async function PerformancePreview({
  searchParams,
}: PageProps<"/dev/performance-preview">) {
  if (process.env.NODE_ENV !== "development") notFound();
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
  return (
    <FileEditor
      fileId="performance-fixture"
      fileName={`${count} layers`}
      organizationName="Local performance fixture"
      backHref="/files"
      initialDocument={{ revision: 1, content: performanceDocument(count) }}
      local
      initialPanelsOpen={query.compact !== "1"}
    />
  );
}
