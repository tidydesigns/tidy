import { buildImageEditorDocument, imageEditorAssetId } from "@/lib/design/examples/image-editor";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { EDITOR_TOOLBAR_COOKIE, editorToolbarPlacement } from "@/lib/editor-preferences";
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
  const loginDocument = buildLoginDocument(cropTest ? cropTestAssetId : undefined);
  if (query.captureHistory === "1") {
    const importKey = "example.org:web-capture/00000000-0000-4000-8000-000000000001";
    loginDocument.nodes = loginDocument.nodes.map((node) => ({ ...node, importKey }));
    // Reproduce a file that reached the old deletion-history limit after captures.
    loginDocument.deletedSourceKeys = Array.from({ length: 5000 }, (_, index) => ({
      importKey: "example.org:web-capture/00000000-0000-4000-8000-000000000002",
      sourceKey: `deleted-${index}`,
    }));
  }
  return (
    <FileEditor
      fileId={typeof query.file === "string" ? query.file.slice(0, 120) : "preview"}
      fileName={query.images === "1" ? "Coastal study" : "Login · import preview"}
      organizationName="Local preview"
      agentSetup={{
        resourceUrl: new URL(
          "/api/mcp",
          process.env.BETTER_AUTH_URL || "http://localhost:3000",
        ).toString(),
        organizationId: "00000000-0000-4000-8000-000000000001",
      }}
      agents={
        query.agentTokens === "1"
          ? {
              organizationId: "token-preview",
              userId: "token-preview",
              canEdit: true,
              canManage: false,
              files: [{ id: "preview", name: "Token preview" }],
              initialThreads: [],
              initialSnapshot: null,
              connection: {
                configured: true,
                planSharingConfigured: true,
                provider: "codex",
                status: "connected",
                accountLabel: "Local browser fixture",
                usageUrl: "https://example.invalid/usage",
                helpUrl: "https://example.invalid/help",
              },
            }
          : undefined
      }
      backHref="/login"
      initialDocument={{
        revision: 1,
        content:
          query.images === "1"
            ? buildImageEditorDocument()
            : query.exports === "1"
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
                        : loginDocument,
      }}
      canEdit={query.viewer !== "1"}
      preview={query.edit !== "1"}
      local={query.edit === "1" && query.realtime !== "1"}
      initialPanelsOpen={query.compact !== "1"}
      initialFocusNodeId={typeof query.node === "string" ? query.node : undefined}
      initialToolbarPlacement={editorToolbarPlacement(
        (await cookies()).get(EDITOR_TOOLBAR_COOKIE)?.value,
      )}
      previewAssetUrls={
        query.images === "1"
          ? { [imageEditorAssetId]: "/image-editor-test.svg" }
          : query.exports === "1"
            ? { [exportImageId]: "/crop-test.svg", [exportMaskImageId]: "/export-mask-test.svg" }
            : cropTest
              ? { [cropTestAssetId]: "/crop-test.svg" }
              : undefined
      }
    />
  );
}
