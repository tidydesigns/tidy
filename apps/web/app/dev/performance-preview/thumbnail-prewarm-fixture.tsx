"use client";
import { EditorThumbnail } from "@/app/files/editor-thumbnail";
import { performanceDocument } from "@/lib/design/examples/performance";
const snapshot = { revision: 1, content: performanceDocument(100) };
const getSnapshot = () => snapshot;
export function ThumbnailPrewarmFixture() {
  return (
    <EditorThumbnail
      fileId="benchmark-0"
      revision={1}
      enabled
      cacheScope="local-fixture"
      getSnapshot={getSnapshot}
    />
  );
}
