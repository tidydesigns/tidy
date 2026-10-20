import { notFound } from "next/navigation";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "@/lib/design/document";

export default async function SnappingPreview({
  searchParams,
}: PageProps<"/dev/snapping-preview">) {
  if (process.env.NODE_ENV !== "development") notFound();
  const query = await searchParams;
  const count = Math.min(9000, Math.max(0, Math.floor(Number(query.nodes) || 0)));
  const document = blankDesignDocument();
  for (const [id, x, y] of [
    ["moving", 100, 200],
    ["target", 400, 100],
    ["competitor", 404, 350],
  ] as const) {
    document.nodes.push({
      ...buildDrawnNode(id, "container", null, { x, y, width: 80, height: 60 }),
      name: id,
      style: { fill: id === "moving" ? "#8facbd" : "#d1d6da" },
    });
  }
  document.nodes.push({
    ...buildDrawnNode("occluder", "container", null, { x: 250, y: 80, width: 80, height: 120 }),
    name: "Overlapping artwork",
    style: { fill: "#50555c" },
  });
  document.nodes.push({
    ...buildDrawnNode("board", "artboard", null, { x: 40, y: 480, width: 600, height: 180 }),
    name: "Imported artwork",
    style: { fill: "#24282d", overflow: "hidden" },
  });
  for (let i = 0; i < count; i++) {
    document.nodes.push({
      ...buildDrawnNode(`detail-${i}`, "container", "board", {
        x: 10 + (i % 100) * 5,
        y: 10 + Math.floor(i / 100) * 1.5,
        width: 3,
        height: 1,
      }),
      name: `Imported detail ${i}`,
      style: { fill: "#586373" },
    });
  }
  return (
    <FileEditor
      fileId={`snapping-fixture-${count}`}
      fileName="Alignment study"
      organizationName="Local preview"
      backHref="/files"
      initialDocument={{ revision: 1, content: parseDesignDocument(document) }}
      local
      initialPanelsOpen
    />
  );
}
