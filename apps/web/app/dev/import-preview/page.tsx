import { notFound } from "next/navigation";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { buildComponentsDocument } from "@/lib/design/examples/components";
import { buildVectorEditingDocument } from "@/lib/design/examples/vector-editing";
import { buildVectorCompositeDocument } from "@/lib/design/examples/vector-composites";
import { buildComponentLibraryDocument } from "@/lib/design/examples/component-libraries";
import {
  buildExportDocument,
  exportImageId,
  exportMaskImageId,
} from "@/lib/design/examples/export";
import { buildLoginDocument } from "@/lib/design/examples/login";
import { buildTokenDocument } from "@/lib/design/examples/token-bindings";

export default async function ImportPreview({ searchParams }: PageProps<"/dev/import-preview">) {
  if (process.env.NODE_ENV !== "development") notFound();
  const query = await searchParams;
  const cropTestAssetId = "00000000-0000-4000-8000-000000000001";
  const cropTest = query.crop === "1";
  return (
    <FileEditor
      fileId={typeof query.file === "string" ? query.file.slice(0, 120) : "preview"}
      fileName="Login · import preview"
      organizationName="Local preview"
      backHref="/login"
      initialDocument={{
        revision: 1,
        content:
          query.exports === "1"
            ? buildExportDocument()
            : query.libraries === "1"
              ? buildComponentLibraryDocument()
              : query.composites === "1"
                ? buildVectorCompositeDocument()
                : query.vector === "1"
                  ? buildVectorEditingDocument()
                  : query.components === "1"
                    ? buildComponentsDocument()
                    : query.tokens === "1"
                      ? buildTokenDocument()
                      : buildLoginDocument(cropTest ? cropTestAssetId : undefined),
      }}
      canEdit={query.viewer !== "1"}
      preview={query.edit !== "1"}
      local={query.edit === "1" && query.realtime !== "1"}
      initialPanelsOpen={query.compact !== "1"}
      previewAssetUrls={
        query.exports === "1"
          ? { [exportImageId]: "/crop-test.svg", [exportMaskImageId]: "/export-mask-test.svg" }
          : cropTest
            ? { [cropTestAssetId]: "/crop-test.svg" }
            : undefined
      }
    />
  );
}
