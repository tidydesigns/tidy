import {
  documentAssetIds,
  designDocumentSchema,
  parseDesignDocument,
  type DesignDocument,
} from "./document";
import { layoutReport } from "./layout-diagnostics";
import { codeRuntimeSource } from "./code-runtime.generated";
import { resolveNodeTokens } from "./design-tokens";
import { mergeNodeChanges } from "./component-variants";
import { fontFamilies, genericFonts, googleFontUrl, webFontByName } from "./fonts/catalog";
import {
  componentFamily,
  componentSubtreeIds,
  resolveVariantNodes,
  standaloneVariants,
} from "./component-variants";

export type ExportAsset = { id: string; mimeType: string; base64: string };
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function componentExportDocument(input: DesignDocument, rootId: string): DesignDocument {
  const document = parseDesignDocument(input);
  const root = document.nodes.find((node) => node.id === rootId);
  if (!root) throw new Error("Export root not found.");
  const ids = componentSubtreeIds(document.nodes, rootId);
  const families = new Set(
    document.nodes
      .filter((node) => ids.has(node.id) && componentFamily(document.nodes, node))
      .map((node) => node.id),
  );
  const bases = resolveVariantNodes(document.nodes, new Map(), families);
  const normalizeFont = (value: string | undefined) =>
    ["var(--font-instrument-sans)", "var(--font-instrument-serif)"].includes(value ?? "")
      ? JSON.stringify(fontFamilies(value!)[0])
      : value;
  // Strip private source paths and editor history from deliverable code.
  // Prototype destinations may be outside the selected subtree; retain them as metadata for onAction.
  return designDocumentSchema.parse({
    schemaVersion: 1,
    pages: document.pages,
    tokens: document.tokens,
    designTokens: document.designTokens
      ? Object.fromEntries(
          Object.entries(document.designTokens).map(([name, token]) => [
            name,
            token.type === "typography" && "value" in token
              ? {
                  ...token,
                  value: { ...token.value, fontFamily: normalizeFont(token.value.fontFamily) },
                }
              : token,
          ]),
        )
      : undefined,
    warnings: [],
    nodes: bases
      .filter((node) => ids.has(node.id))
      .map((node) => {
        const variants = standaloneVariants(document.nodes, node);
        return {
          ...node,
          parentId: node.id === rootId ? null : node.parentId,
          style: { ...node.style, fontFamily: normalizeFont(node.style.fontFamily) },
          variants: variants
            ? {
                ...variants,
                options: Object.fromEntries(
                  Object.entries(variants.options).map(([name, option]) => {
                    const normalizeChanges = (changes: typeof option.root) =>
                      changes?.style
                        ? {
                            ...changes,
                            style: {
                              ...changes.style,
                              fontFamily: normalizeFont(changes.style.fontFamily),
                            },
                          }
                        : changes;
                    return [
                      name,
                      {
                        root: normalizeChanges(option.root),
                        children: option.children
                          ? Object.fromEntries(
                              Object.entries(option.children).map(([id, changes]) => [
                                id,
                                normalizeChanges(changes),
                              ]),
                            )
                          : undefined,
                      },
                    ];
                  }),
                ),
              }
            : undefined,
          isComponent: variants ? true : node.isComponent,
          sourceKey: undefined,
          sourcePath: undefined,
          importKey: undefined,
          instanceOf: undefined,
          componentSourceId: undefined,
          instanceOverrides: undefined,
          styleId: undefined,
          styleOverrides: undefined,
          librarySource: undefined,
          libraryNodeId: undefined,
        };
      }),
  });
}

export function exportComponent(
  input: DesignDocument,
  rootId: string,
  componentName: string,
  assets: ExportAsset[] = [],
) {
  if (
    !/^[A-Z][a-zA-Z0-9]*$/.test(componentName) ||
    ["React", "TidyDesign", "ComponentPropsWithoutRef", "Omit", "Record"].includes(componentName)
  )
    throw new Error(
      "Use a PascalCase component name that does not shadow React or TypeScript helpers.",
    );
  const document = parseDesignDocument(input);
  const selected = componentExportDocument(document, rootId);
  const root = selected.nodes.find((node) => node.id === rootId)!;
  const ids = new Set(selected.nodes.map((node) => node.id));
  const report = layoutReport({
    ...selected,
    nodes: selected.nodes.map((node) => resolveNodeTokens(node, selected)),
  });
  if (!report.valid)
    throw new Error(
      `Resolve layout errors before exporting:\n${report.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.nodeId}: ${issue.message}`)
        .join("\n")}`,
    );
  const assetPaths: Record<string, string> = {};
  const assetFiles = documentAssetIds(selected).map((id) => {
    const asset = assets.find((asset) => asset.id === id);
    if (!asset || !extensions[asset.mimeType])
      throw new Error(`Export asset ${id} is missing or unsupported.`);
    const path = `public/tidy-assets/${id}.${extensions[asset.mimeType]}`;
    assetPaths[id] = `/tidy-assets/${id}.${extensions[asset.mimeType]}`;
    return { path, encoding: "base64" as const, content: asset.base64 };
  });
  const warnings = [
    ...report.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
    ...document.warnings
      .filter((warning) => !warning.nodeId || ids.has(warning.nodeId))
      .map((warning) => warning.message),
  ];
  const fontUrls = new Set<string>();
  function includeFont(nodeName: string, fontStyle: typeof root.style) {
    for (const family of fontFamilies(fontStyle.fontFamily ?? "system-ui")) {
      const font = webFontByName.get(family.toLowerCase());
      if (font && fontStyle.fontSource !== "local" && fontStyle.fontSource !== "system")
        fontUrls.add(googleFontUrl(font));
      else if (!genericFonts.has(family.toLowerCase()))
        warnings.push(
          `${nodeName}: supply the ${family} font in the destination app; local font bytes are not stored in this document.`,
        );
    }
  }
  for (const node of selected.nodes) {
    if (node.interactions?.length)
      warnings.push(
        `${node.name}: prototype interactions require a playback session; wire application behavior through onTrigger.`,
      );
    if (node.linkTo)
      warnings.push(
        `${node.name}: linkTo is a canvas prototype destination. Wire the application's navigation through onAction.`,
      );
    if (node.type === "text") includeFont(node.name, resolveNodeTokens(node, selected).style);
    for (const [name, option] of Object.entries(node.variants?.options ?? {})) {
      if (option.root && (option.root.style?.fontFamily || option.root.tokenBindings?.textStyle))
        includeFont(
          `${node.name}/${name}`,
          resolveNodeTokens(mergeNodeChanges(node, option.root), selected).style,
        );
      for (const [id, changes] of Object.entries(option.children ?? {})) {
        const child = selected.nodes.find((item) => item.id === id);
        if ((changes.style?.fontFamily || changes.tokenBindings?.textStyle) && child)
          includeFont(
            `${child.name}/${name}`,
            resolveNodeTokens(mergeNodeChanges(child, changes), selected).style,
          );
      }
    }
  }
  const tag = root.semantics?.element ?? (root.type === "text" ? "span" : "div");
  const variantNames = root.variants ? Object.keys(root.variants.options) : [];
  const variantType = variantNames.length
    ? `export type ${componentName}Variant = ${variantNames.map((name) => JSON.stringify(name)).join(" | ")};\n\n`
    : "";
  const variantProp = variantNames.length ? `variant?: ${componentName}Variant; ` : "";
  const variantDefault = root.variants
    ? `variant = ${JSON.stringify(root.variant ?? root.variants.default)}, `
    : "";
  const variantArgument = root.variants ? " variant={variant}" : "";
  const source = `"use client";\n\nimport type { ComponentPropsWithoutRef } from "react";\nimport { TidyDesign } from "./tidy-runtime.js";\n${fontUrls.size ? `import "./${componentName}.css";\n` : ""}\nconst document = ${JSON.stringify(selected, null, 2)};\nconst defaultAssets = ${JSON.stringify(assetPaths, null, 2)};\n\n${variantType}export type ${componentName}Props = Omit<ComponentPropsWithoutRef<${JSON.stringify(tag)}>, "children"> & { ${variantProp}assets?: Record<string, string>; text?: Record<string, string>; frameWidth?: number; onAction?: (nodeId: string) => void };\n\nexport function ${componentName}({ ${variantDefault}assets = defaultAssets, text, frameWidth, onAction, ...props }: ${componentName}Props) {\n  return <TidyDesign document={document} rootId=${JSON.stringify(rootId)} assets={assets} rootProps={props} frameWidth={frameWidth} onAction={onAction} text={text}${variantArgument} />;\n}\n`;
  const files = [
    { path: `${componentName}.tsx`, encoding: "utf8" as const, content: source },
    {
      path: "tidy-runtime.js",
      encoding: "utf8" as const,
      content: `"use client";\n${codeRuntimeSource}`,
    },
    {
      path: "tidy-runtime.d.ts",
      encoding: "utf8" as const,
      content:
        'import type { ReactElement } from "react";\nexport declare function TidyDesign(props: { document: unknown; rootId: string; assets: Record<string, string>; rootProps?: object; variant?: string; text?: Record<string, string>; frameWidth?: number; onAction?: (nodeId: string) => void }): ReactElement | null;\n',
    },
    ...(fontUrls.size
      ? [
          {
            path: `${componentName}.css`,
            encoding: "utf8" as const,
            content:
              [...fontUrls].map((url) => `@import url(${JSON.stringify(url)});`).join("\n") + "\n",
          },
        ]
      : []),
    ...assetFiles,
  ];
  return {
    componentName,
    rootId,
    variants: variantNames,
    defaultVariant: root.variants ? (root.variant ?? root.variants.default) : undefined,
    files,
    warnings: [...new Set(warnings)],
    visualVerification: "required" as const,
    instructions:
      "Copy the text files together into your React app and decode base64 assets into the listed public/ paths. Named variants share one component and are selected using the typed variant prop. Use native root props (including onClick), onAction(nodeId) for nested controls/prototype links, text keyed by layer ID for labels, and assets to override asset URLs. Responsive rules measure the exported root; pass frameWidth when embedding a component in a different frame context. Load the listed fonts and compare at the intended viewport before accepting visual fidelity.",
  };
}
