import type { DesignDocument } from "./document";
import { resolvedDocumentNodes, resolvedColorTokens } from "./design-tokens";
import { textFontSegments } from "@bella/design/rich-text-runtime";
import { resolveVariantNodes, componentSubtreeIds } from "./component-variants";
import { fontRegistry } from "./fonts/runtime";
import { createExportImageSession, embedDesignImages } from "./export-images";
import {
  exportRoots,
  exportDimensions,
  exportFilename,
  exportNames,
  type ExportRequest,
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
  let sampled: HTMLCanvasElement | undefined;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image export is unavailable in this browser.");
    // Paint vectors and text at higher resolution before reducing them. Merely
    // increasing an SVG image's intrinsic size still paints at the draw target's
    // resolution. Bound the extra surface and process one export at a time.
    const sampling = Math.min(
      2,
      8192 / width,
      8192 / height,
      Math.sqrt(32_000_000 / (width * height)),
    );
    if (sampling >= 1.25) {
      sampled = document.createElement("canvas");
      sampled.width = Math.floor(width * sampling);
      sampled.height = Math.floor(height * sampling);
      const highResolution = sampled.getContext("2d");
      if (!highResolution) throw new Error("Image export is unavailable in this browser.");
      highResolution.drawImage(image, 0, 0, sampled.width, sampled.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(sampled, 0, 0, width, height);
      sampled.width = 0;
      sampled.height = 0;
    } else context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("The browser could not create this image.")),
        mime,
      ),
    );
    if (blob.type !== mime)
      throw new Error(
        `${mime === "image/webp" ? "WebP" : "PNG"} output is unavailable in this browser.`,
      );
    return blob;
  } finally {
    if (sampled) {
      sampled.width = 0;
      sampled.height = 0;
    }
    canvas.width = 0;
    canvas.height = 0;
    image.onload = null;
    image.onerror = null;
    image.src = "";
  }
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
  const warnings: string[] = [];
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
  const pdf =
    request.format === "pdf" ? await (await import("pdf-lib")).PDFDocument.create() : undefined;
  if (pdf) {
    pdf.setProducer("Tidy");
    pdf.setTitle(roots.length === 1 ? roots[0].name : "Selected layers");
  }
  const files: ExportFile[] = [];
  // One clone already deduplicates its sources; avoid retaining an extra cache
  // for a single selected root.
  const images = roots.length > 1 ? createExportImageSession() : undefined;
  try {
    for (let index = 0; index < plans.length; index++) {
      const { group, bounds } = plans[index],
        { width, height } = dimensions[index],
        clones = group.map((n) => exportClone(elements.get(n.id)!, n, nodes, bounds));
      for (const clone of clones) await embedDesignImages(clone, undefined, images);
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
      // Encode each page before preparing the next: do not retain a batch of
      // HTML/SVG strings containing full-quality base64 images in memory.
      if (pdf) {
        const png = await rasterizeExport(html, width, height),
          image = await pdf.embedPng(await png.arrayBuffer()),
          pageWidth = width * 0.75,
          pageHeight = height * 0.75;
        pdf.addPage([pageWidth, pageHeight]).drawImage(image, {
          x: 0,
          y: 0,
          width: pageWidth,
          height: pageHeight,
        });
      } else {
        const blob =
          request.format === "svg"
            ? new Blob([native], { type: "image/svg+xml" })
            : await rasterizeExport(
                html,
                width,
                height,
                request.format === "webp" ? "image/webp" : "image/png",
              );
        files.push({ name: names[index], blob });
      }
    }
  } finally {
    images?.dispose();
  }
  if (pdf) {
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
