import type { DesignDocument } from "./document";
import { resolvedDocumentNodes, resolvedColorTokens } from "./design-tokens";
import { textFontSegments } from "@bella/design/rich-text";
import { resolveVariantNodes, componentSubtreeIds } from "./component-variants";
import { fontRegistry } from "./fonts/runtime";
import { embedDesignImages } from "./export-images";
import {
  exportRoots,
  exportDimensions,
  exportFilename,
  exportNames,
  type ExportRequest,
  type ExportBounds,
} from "./export-plan";
import { selectionBounds, exportClone, foreignObjectSvg } from "./export-dom";
import { nativeSvg } from "./export-native-svg";
export type ExportFile = { name: string; blob: Blob };
export async function rasterizeExport(
  svg: string,
  width: number,
  height: number,
  mime: "image/png" | "image/webp" = "image/png",
) {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error("Could not render the export. Check its images and fonts."));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is unavailable in this browser.");
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("The browser could not create this image.")),
      mime,
    ),
  );
  canvas.width = 0;
  canvas.height = 0;
  if (blob.type !== mime)
    throw new Error(
      `${mime === "image/webp" ? "WebP" : "PNG"} output is unavailable in this browser.`,
    );
  return blob;
}
export async function createSelectionExport(
  content: DesignDocument,
  elements: ReadonlyMap<string, HTMLElement>,
  request: ExportRequest,
): Promise<{ files: ExportFile[]; warnings: string[] }> {
  const document = { ...content, nodes: resolveVariantNodes(resolvedDocumentNodes(content)) },
    roots = exportRoots(document, request.ids),
    nodes = new Map(document.nodes.map((n) => [n.id, n]));
  const groups = request.mode === "batch" ? roots.map((root) => [root]) : [roots];
  const plans = groups.map((group) => ({
    group,
    bounds: selectionBounds(group, elements, document),
  }));
  const dimensions = plans.map((plan) => exportDimensions(plan.bounds, request.scale));
  if (dimensions.reduce((sum, size) => sum + size.width * size.height, 0) > 128_000_000)
    throw new Error("The batch exceeds 128 megapixels. Choose fewer layers or a smaller scale.");
  const ids = new Set(roots.flatMap((root) => [...componentSubtreeIds(document.nodes, root.id)]));
  const text = document.nodes.filter((n) => ids.has(n.id) && n.visible && n.type === "text");
  const fontCss = await fontRegistry.exportCss(
    text.flatMap((n) =>
      textFontSegments({ ...n, text: n.text ?? "" }).map((segment) => ({
        family: n.style.fontFamily ?? "system-ui",
        ...segment,
        source: n.style.fontSource,
      })),
    ),
  );
  await window.document.fonts.ready;
  const warnings: string[] = [],
    prepared: {
      bounds: ExportBounds;
      width: number;
      height: number;
      html: string;
      native: string;
    }[] = [];
  for (let index = 0; index < plans.length; index++) {
    const { group, bounds } = plans[index],
      { width, height } = dimensions[index],
      clones = group.map((n) => exportClone(elements.get(n.id)!, n, nodes, bounds));
    for (const clone of clones) await embedDesignImages(clone);
    const html = foreignObjectSvg(clones, bounds, width, height, fontCss);
    let native = html;
    if (request.format === "svg") {
      const result = nativeSvg(
        clones,
        nodes,
        resolvedColorTokens(document),
        bounds,
        width,
        height,
        fontCss,
      );
      if (result.unsupported.length)
        warnings.push(
          ...result.unsupported.map((reason) => `SVG retained HTML rendering for ${reason}.`),
        );
      else native = result.svg;
    }
    prepared.push({ bounds, width, height, html, native });
  }
  const names =
    request.mode === "batch"
      ? exportNames(roots, request.scale, request.format)
      : [
          exportFilename(
            roots.length === 1 ? roots[0].name : "Selection",
            request.scale,
            request.format,
          ),
        ];
  if (request.format === "pdf") {
    const { PDFDocument } = await import("pdf-lib"),
      pdf = await PDFDocument.create();
    pdf.setProducer("Tidy");
    pdf.setTitle(roots.length === 1 ? roots[0].name : "Selected layers");
    for (const page of prepared) {
      const png = await rasterizeExport(page.html, page.width, page.height),
        image = await pdf.embedPng(await png.arrayBuffer()),
        width = page.width * 0.75,
        height = page.height * 0.75;
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
    const bytes = await pdf.save();
    return {
      files: [
        {
          name:
            request.mode === "batch" && roots.length > 1
              ? exportFilename("Layers", request.scale, "pdf")
              : names[0],
          blob: new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
        },
      ],
      warnings,
    };
  }
  const files: ExportFile[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const page = prepared[i],
      blob =
        request.format === "svg"
          ? new Blob([page.native], { type: "image/svg+xml" })
          : await rasterizeExport(
              page.html,
              page.width,
              page.height,
              request.format === "webp" ? "image/webp" : "image/png",
            );
    files.push({ name: names[i], blob });
  }
  if (request.mode === "batch" && files.length > 1) {
    const { zipSync } = await import("fflate"),
      archive: Record<string, Uint8Array> = {};
    for (const file of files) archive[file.name] = new Uint8Array(await file.blob.arrayBuffer());
    return {
      files: [
        {
          name: exportFilename("Layers", request.scale, "zip"),
          blob: new Blob([new Uint8Array(zipSync(archive, { level: 0 }))], {
            type: "application/zip",
          }),
        },
      ],
      warnings,
    };
  }
  return { files, warnings };
}
