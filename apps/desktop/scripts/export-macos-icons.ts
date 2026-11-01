import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { parseDesignDocument, type DesignNode } from "@tidy/design/document";

// This deliberately exports only the approved, simple icon subtrees. Unsupported
// effects fail instead of silently changing a future design during export.
const selections = [
  { channel: "beta", nodeId: "prism-v4-206", option: 17 },
  { channel: "production", nodeId: "prism-v4-10", option: 13 },
] as const;
const output = fileURLToPath(new URL("../resources/macos/", import.meta.url));
const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const input = process.argv[2];
if (!input || process.argv.length !== 3)
  throw new Error(
    "Usage: bun apps/desktop/scripts/export-macos-icons.ts /path/to/local-design.json",
  );
const designPath = resolve(input);
const file = JSON.parse(await readFile(designPath, "utf8"));
const document = parseDesignDocument(file.document);
const children = (id: string) => document.nodes.filter((node) => node.parentId === id);
const supported = new Set(["fill", "radius", "overflow", "opacity", "objectFit"]);
const provenance = [];
await mkdir(output, { recursive: true });

for (const selection of selections) {
  const root = document.nodes.find((node) => node.id === selection.nodeId);
  if (!root || !root.name.includes("Production"))
    throw new Error("Approved production icon missing.");
  const exportedNodes: DesignNode[] = [];
  const assetHashes: Record<string, string> = {};
  const render = async (node: DesignNode): Promise<string> => {
    if (!node.visible) return "";
    exportedNodes.push(node);
    if (node.layout !== "absolute" || Object.keys(node.style).some((key) => !supported.has(key)))
      throw new Error(`Unsupported icon layout or style: ${node.name}`);
    const { width, height } = node.box;
    let body = "";
    if (node.vectorPath) {
      const { d, viewBox: v, fillRule } = node.vectorPath;
      body = `<svg width="${width}" height="${height}" viewBox="${v.x} ${v.y} ${v.width} ${v.height}" preserveAspectRatio="none"><path d="${xml(d)}" fill-rule="${fillRule}" fill="${node.style.fill ?? "none"}"/></svg>`;
    } else if (node.type === "image" && node.assetId) {
      const asset = JSON.parse(
        await readFile(join(dirname(designPath), "../assets", `${node.assetId}.json`), "utf8"),
      );
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(asset.dataUrl))
        throw new Error("Expected a local raster icon asset.");
      const bytes = Buffer.from(asset.dataUrl.split(",")[1], "base64");
      assetHashes[node.assetId] = createHash("sha256").update(bytes).digest("hex");
      // librsvg does not support embedded WebP. Decode the design's original
      // asset losslessly into PNG, without a resize or a new lossy encode.
      const png = await sharp(bytes).ensureAlpha().toColourspace("srgb").png().toBuffer();
      body = `<image width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${png.toString("base64")}"/>`;
    } else if (node.type === "container") {
      if (node.style.fill)
        body += `<rect width="${width}" height="${height}" rx="${node.style.radius ?? 0}" fill="${node.style.fill}"/>`;
      for (const child of children(node.id)) {
        if (child.id !== node.mask?.sourceId) body += await render(child);
      }
      if (node.mask?.enabled) {
        const source = children(node.id).find((child) => child.id === node.mask?.sourceId);
        if (!source?.vectorPath || node.mask.mode !== "alpha")
          throw new Error("Unsupported icon mask.");
        body = `<defs><mask id="${node.id}" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">${await render(source)}</mask></defs><g mask="url(#${node.id})">${body}</g>`;
      }
    } else throw new Error(`Unsupported icon node: ${node.name}`);
    const x = node.id === root.id ? 0 : node.box.x;
    const y = node.id === root.id ? 0 : node.box.y;
    return `<g transform="translate(${x} ${y})" opacity="${node.style.opacity ?? 1}">${body}</g>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 ${root.box.width} ${root.box.height}">${await render(root)}</svg>`;
  const png = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .toColourspace("srgb")
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  await writeFile(join(output, `${selection.channel}.png`), png);
  provenance.push({
    ...selection,
    designId: file.id,
    nodesSha256: createHash("sha256").update(JSON.stringify(exportedNodes)).digest("hex"),
    assetHashes,
    pngSha256: createHash("sha256").update(png).digest("hex"),
  });
}
await writeFile(
  join(output, "source.json"),
  `${JSON.stringify({ schemaVersion: 1, size: 1024, exports: provenance }, null, 2)}\n`,
);
console.info("Exported option 17 for beta and option 13 for production, without badges.");
