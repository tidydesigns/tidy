import { readFile } from "node:fs/promises";
import { parseDesignDocument } from "@/lib/design/document";
import { notFound } from "next/navigation";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { FilesBrowser } from "@/app/files/files-browser";
import {
  performanceDocument,
  componentPerformanceDocument,
  largeFramePerformanceDocument,
} from "@/lib/design/examples/performance";
export default async function PerformancePreview({
  searchParams,
}: PageProps<"/dev/performance-preview">) {
  if (process.env.NODE_ENV !== "development") notFound();
  const query = await searchParams;
  if (query.document === "local" && process.env.TIDY_PERFORMANCE_DOCUMENT) {
    const content = parseDesignDocument(
      JSON.parse(await readFile(process.env.TIDY_PERFORMANCE_DOCUMENT, "utf8")),
    );
    return (
      <FileEditor
        fileId="local-document-fixture"
        fileName="Local document fixture"
        organizationName="Local performance fixture"
        backHref="/files"
        initialDocument={{ revision: 1, content }}
        local
        initialPanelsOpen={query.compact !== "1"}
      />
    );
  }
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
      thumbnailVersion: null,
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
  const count = [100, 1000, 5000, 9000].includes(Number(query.nodes)) ? Number(query.nodes) : 1000;
  return (
    <FileEditor
      fileId="performance-fixture"
      fileName={`${count} layers`}
      organizationName="Local performance fixture"
      backHref="/files"
      initialDocument={{
        revision: 1,
        content:
          query.large === "1"
            ? largeFramePerformanceDocument({
                count,
                layersPerFrame: query.frameLayers === "all" ? count : 1000,
              })
            : query.components === "1"
              ? componentPerformanceDocument(count)
              : performanceDocument(count),
      }}
      local
      initialPanelsOpen={query.compact !== "1"}
    />
  );
}
