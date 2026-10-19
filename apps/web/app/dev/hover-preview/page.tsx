import { notFound } from "next/navigation";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { buildHoverDocument, buildNestedHoverDocument } from "@/lib/design/examples/hover";

export default async function HoverPreview({ searchParams }: PageProps<"/dev/hover-preview">) {
  if (process.env.NODE_ENV !== "development") notFound();
  const query = await searchParams;
  const count = Math.min(9000, Math.max(0, Math.floor(Number(query.nodes) || 0)));
  return (
    <FileEditor
      fileId={`hover-fixture-${count}`}
      fileName={count ? `${count} layers in one artboard` : "Layer exploration"}
      organizationName="Local hover fixture"
      backHref="/files"
      initialDocument={{
        revision: 1,
        content: query.complex === "1" ? buildNestedHoverDocument() : buildHoverDocument(count),
      }}
      local
      active={query.active !== "0"}
      initialPanelsOpen
      canEdit={query.viewer !== "1"}
    />
  );
}
