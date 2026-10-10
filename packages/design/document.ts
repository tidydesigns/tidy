import * as z from "zod";
import { richTextSchema, richTextPlain } from "./rich-text";
import { vectorPathSchema } from "./vector-schema";
import { validateVectorRelationships } from "./vector-relationships";
import { validateResponsiveLayout } from "./responsive-layout";
import { validateComponentVariants } from "./component-variants";
import { designTokensSchema, tokenBindingsSchema } from "./token-schema";
import { resolveNodeTokens, resolvedDesignTokens } from "./design-tokens";
import { prototypeInteractionSchema, validatePrototype } from "./prototype";

const number = z.number().finite();
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const tokenName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const box = z.object({
  x: number.min(-100000).max(100000),
  y: number.min(-100000).max(100000),
  width: number.min(1).max(5000),
  height: number.min(1).max(5000),
});
const gridTrack = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("fr"), value: number.min(0.1).max(100) }).strict(),
  z.object({ unit: z.literal("px"), value: number.min(1).max(5000) }).strict(),
  z.object({ unit: z.literal("auto") }).strict(),
]);
const responsiveBreakpoint = z
  .object({
    id: z.string().uuid(),
    frameMaxWidth: number.int().min(1).max(5000),
    layout: z.enum(["absolute", "flex-row", "flex-column", "grid"]).optional(),
    gap: number.min(-1000).max(1000).optional(),
    columnGap: number.min(0).max(1000).optional(),
    rowGap: number.min(0).max(1000).optional(),
    padding: number.min(0).max(1000).optional(),
    paddingTop: number.min(0).max(1000).optional(),
    paddingRight: number.min(0).max(1000).optional(),
    paddingBottom: number.min(0).max(1000).optional(),
    paddingLeft: number.min(0).max(1000).optional(),
    gridColumns: z.number().int().min(1).max(12).optional(),
    gridColumnTracks: z.array(gridTrack).min(1).max(12).optional(),
    gridRowTracks: z.array(gridTrack).max(12).optional(),
    wrap: z.boolean().optional(),
    align: z.enum(["start", "center", "end", "stretch", "baseline"]).optional(),
    justify: z.enum(["start", "center", "end", "space-between"]).optional(),
    widthMode: z.enum(["fixed", "fill", "hug"]).optional(),
    heightMode: z.enum(["fixed", "fill", "hug"]).optional(),
    minWidth: number.min(0).max(5000).optional(),
    maxWidth: number.min(1).max(5000).optional(),
    minHeight: number.min(0).max(5000).optional(),
    maxHeight: number.min(1).max(5000).optional(),
  })
  .strict();
const gradientPoint = z
  .object({ x: number.min(-5000).max(5001), y: number.min(-5000).max(5001) })
  .strict();
const imageAdjustmentAmount = z.number().finite().min(-1).max(1).optional();
export const imageAdjustmentsSchema = z
  .object({
    exposure: imageAdjustmentAmount,
    contrast: imageAdjustmentAmount,
    saturation: imageAdjustmentAmount,
    temperature: imageAdjustmentAmount,
    tint: imageAdjustmentAmount,
    highlights: imageAdjustmentAmount,
    shadows: imageAdjustmentAmount,
  })
  .strict();
const imageCrop = z
  .object({
    x: number.min(0).max(1),
    y: number.min(0).max(1),
    width: number.min(0.000001).max(1),
    height: number.min(0.000001).max(1),
    sourceWidth: number.min(1).max(1000000),
    sourceHeight: number.min(1).max(1000000),
  })
  .strict()
  .refine(
    (crop) => crop.x + crop.width <= 1.00000001 && crop.y + crop.height <= 1.00000001,
    "Crop must stay inside the image.",
  );
const paintBase = {
  id: z.string().min(1).max(120),
  opacity: number.min(0).max(1).default(1),
  visible: z.boolean().default(true),
  blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten"]).optional(),
};
const stops = z
  .array(
    z
      .object({
        id: z.string().min(1).max(120),
        position: number.min(0).max(1),
        color,
        token: tokenName.optional(),
      })
      .strict(),
  )
  .min(2)
  .max(20)
  .refine(
    (values) => new Set(values.map((stop) => stop.id)).size === values.length,
    "Gradient stop IDs must be unique.",
  );
export const designPaintSchema = z.discriminatedUnion("type", [
  z.object({ ...paintBase, type: z.literal("solid"), color, token: tokenName.optional() }).strict(),
  z
    .object({
      ...paintBase,
      type: z.literal("linear"),
      stops,
      angle: number.min(0).max(360).default(180),
      start: gradientPoint.optional(),
      end: gradientPoint.optional(),
    })
    .strict()
    .refine(
      (paint) =>
        Boolean(paint.start) === Boolean(paint.end) &&
        (!paint.start ||
          Math.hypot(paint.start.x - paint.end!.x, paint.start.y - paint.end!.y) > 0.000001),
      "Gradient endpoints must be a distinct pair.",
    ),
  z
    .object({
      ...paintBase,
      type: z.literal("radial"),
      stops,
      rotation: number.min(-360).max(360).optional(),
      centerX: number.min(-3).max(4).default(0.5),
      centerY: number.min(-3).max(4).default(0.5),
      radiusX: number.min(0.001).max(3).default(0.5),
      radiusY: number.min(0.001).max(3).default(0.5),
    })
    .strict(),
  z
    .object({
      ...paintBase,
      type: z.literal("image"),
      assetId: z.string().uuid().optional(),
      fit: z.enum(["contain", "cover", "fill"]).default("cover"),
      positionX: number.min(0).max(100).default(50),
      positionY: number.min(0).max(100).default(50),
      crop: imageCrop.optional(),
      adjustments: imageAdjustmentsSchema.optional(),
    })
    .strict(),
]);
export type DesignPaint = z.infer<typeof designPaintSchema>;
export const designStrokePaintSchema = z.union([
  designPaintSchema.options[0],
  designPaintSchema.options[1],
  designPaintSchema.options[2],
]);
export type DesignStrokePaint = z.infer<typeof designStrokePaintSchema>;
export const designEffectSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: z.enum(["blur", "brightness", "contrast", "grayscale", "saturation", "hueRotate"]),
    amount: number.min(-360).max(360),
    visible: z.boolean().default(true),
  })
  .strict()
  .refine(
    (effect) =>
      effect.type === "hueRotate" ||
      (effect.amount >= 0 &&
        effect.amount <= (["blur", "grayscale"].includes(effect.type) ? 100 : 200)),
    "Effect amount is outside its supported range.",
  );
export type DesignEffect = z.infer<typeof designEffectSchema>;
const style = z
  .object({
    strokeCap: z.enum(["butt", "round", "square"]).optional(),
    strokeJoin: z.enum(["miter", "round", "bevel"]).optional(),
    strokeStart: z.enum(["none", "arrow", "triangle", "circle"]).optional(),
    strokeEnd: z.enum(["none", "arrow", "triangle", "circle"]).optional(),
    strokePosition: z.enum(["inside", "center", "outside"]).optional(),
    strokePaints: z
      .array(designStrokePaintSchema)
      .max(20)
      .refine(
        (values) => new Set(values.map((paint) => paint.id)).size === values.length,
        "Stroke paint IDs must be unique.",
      )
      .optional(),
    cornerSmoothing: number.min(0).max(1).optional(),
    effects: z
      .array(designEffectSchema)
      .max(20)
      .refine(
        (values) => new Set(values.map((effect) => effect.id)).size === values.length,
        "Effect IDs must be unique.",
      )
      .optional(),
    paints: z
      .array(designPaintSchema)
      .max(20)
      .refine(
        (values) => new Set(values.map((paint) => paint.id)).size === values.length,
        "Fill IDs must be unique.",
      )
      .optional(),
    fill: color.optional(),
    color: color.optional(),
    borderColor: color.optional(),
    borderWidth: number.min(0).max(40).optional(),
    radius: number.min(0).max(5000).optional(),
    radiusTopLeft: number.min(0).max(5000).optional(),
    radiusTopRight: number.min(0).max(5000).optional(),
    radiusBottomRight: number.min(0).max(5000).optional(),
    radiusBottomLeft: number.min(0).max(5000).optional(),
    borderTopWidth: number.min(0).max(40).optional(),
    borderRightWidth: number.min(0).max(40).optional(),
    borderBottomWidth: number.min(0).max(40).optional(),
    borderLeftWidth: number.min(0).max(40).optional(),
    borderStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
    opacity: number.min(0).max(1).optional(),
    fontSize: number.min(6).max(300).optional(),
    fontWeight: z.number().int().min(1).max(1000).optional(),
    lineHeight: number.min(0.0001).max(200).optional(),
    lineHeightMode: z.enum(["auto", "percent", "px"]).optional(),
    lineHeightPx: number.min(0.1).max(1200).optional(),
    paragraphSpacing: number.min(0).max(1000).optional(),
    textVerticalAlign: z.enum(["top", "center", "bottom"]).optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    textOverflow: z.enum(["clip", "ellipsis"]).optional(),
    fontFamily: z.string().max(100).optional(),
    fontSource: z.enum(["web", "local", "system"]).optional(),
    fontFace: z.string().max(200).optional(),
    objectFit: z.enum(["contain", "cover", "fill"]).optional(),
    shadow: z.string().max(160).optional(),
    shadows: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120).optional(),
            x: number.min(-1000).max(1000),
            y: number.min(-1000).max(1000),
            blur: number.min(0).max(1000),
            spread: number.min(-1000).max(1000),
            color,
            inset: z.boolean().default(false),
            visible: z.boolean().default(true),
          })
          .strict(),
      )
      .max(20)
      .refine((values) => {
        const ids = values.flatMap((shadow) => (shadow.id ? [shadow.id] : []));
        return new Set(ids).size === ids.length;
      }, "Shadow IDs must be unique.")
      .optional(),
    backdropBlur: number.min(0).max(100).optional(),
    saturation: number.min(0).max(200).optional(),
    hueRotate: number.min(-360).max(360).optional(),
    objectPositionX: number.min(0).max(100).optional(),
    objectPositionY: number.min(0).max(100).optional(),
    objectScale: number.min(1).max(10).optional(),
    imageCrop: imageCrop.optional(),
    imageAdjustments: imageAdjustmentsSchema.optional(),
    textCase: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
    textWrap: z.enum(["wrap", "nowrap"]).optional(),
    maxLines: z.number().int().min(1).max(100).optional(),
    innerShadow: z.string().max(160).optional(),
    blur: number.min(0).max(100).optional(),
    brightness: number.min(0).max(200).optional(),
    contrast: number.min(0).max(200).optional(),
    grayscale: number.min(0).max(100).optional(),
    blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten"]).optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    gradientFrom: color.optional(),
    gradientTo: color.optional(),
    gradientAngle: number.min(0).max(360).optional(),
    outlineColor: color.optional(),
    outlineWidth: number.min(0).max(40).optional(),
    rotation: number.min(-360).max(360).optional(),
    letterSpacing: number.min(-100).max(100).optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    textDecoration: z.enum(["none", "underline", "line-through"]).optional(),
    overflow: z.enum(["visible", "hidden", "auto"]).optional(),
    fillToken: tokenName.optional(),
    colorToken: tokenName.optional(),
    borderColorToken: tokenName.optional(),
  })
  .strict();

export const elementSchema = z.enum([
  "div",
  "span",
  "button",
  "a",
  "section",
  "nav",
  "header",
  "footer",
  "main",
  "article",
  "ul",
  "ol",
  "li",
  "p",
  "h1",
  "h2",
  "h3",
]);
// Interaction states change paint, not the component's layout or typography.
const stateStyle = style.pick({
  fill: true,
  color: true,
  borderColor: true,
  opacity: true,
  shadow: true,
  innerShadow: true,
  outlineColor: true,
  outlineWidth: true,
  fillToken: true,
  colorToken: true,
  borderColorToken: true,
});
export const semanticsSchema = z
  .object({
    element: elementSchema,
    label: z.string().trim().min(1).max(240).optional(),
    hidden: z.boolean().optional(),
    href: z
      .string()
      .max(2000)
      .refine(
        (value) =>
          /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(value) && !/[\u0000-\u0020]/.test(value),
        "Use an http(s), mailto, tel, root-relative or fragment URL.",
      )
      .optional(),
    buttonType: z.enum(["button", "submit", "reset"]).optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.href !== undefined && value.element !== "a")
      ctx.addIssue({ code: "custom", message: "Only links can have href." });
    if (
      (value.disabled !== undefined || value.buttonType !== undefined) &&
      value.element !== "button"
    )
      ctx.addIssue({ code: "custom", message: "Only buttons can have disabled or buttonType." });
  });

const baseNodeSchema = z
  .object({
    id: z.string().min(1).max(120),
    parentId: z.string().min(1).max(120).nullable(),
    name: z.string().min(1).max(120),
    pageId: z.string().min(1).max(120).optional(),
    type: z.enum(["artboard", "container", "text", "image", "vector"]),
    vectorPath: vectorPathSchema.optional(),
    vectorBoolean: z.enum(["union", "subtract", "intersect", "exclude"]).optional(),
    mask: z
      .object({
        sourceId: z.string().min(1).max(120),
        mode: z.enum(["alpha", "luminance"]).default("alpha"),
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional(),
    box,
    tokenBindings: tokenBindingsSchema.optional(),
    style: style.default({}),
    text: z.string().max(10000).optional(),
    richText: richTextSchema.optional(),
    assetId: z.string().uuid().optional(),
    visible: z.boolean().default(true),
    locked: z.boolean().default(false),
    sourceKey: z.string().max(240).optional(),
    sourcePath: z
      .string()
      .max(500)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.split("/").includes("..") &&
          !path.split("/").some((segment) => segment.startsWith(".env")),
        "Source path must be relative and must not reference environment files.",
      )
      .optional(),
    importKey: z.string().max(700).optional(),
    layout: z
      .enum(["absolute", "flex-row", "flex-column", "grid"])
      .default("absolute")
      .describe(
        "Choose explicit flex/grid for UI content; absolute is for measured free-positioned layers. Flow ignores child box.x/y.",
      ),
    gap: number.min(-1000).max(1000).optional(),
    padding: number.min(0).max(1000).optional(),
    columnGap: number.min(0).max(1000).optional(),
    rowGap: number.min(0).max(1000).optional(),
    paddingTop: number.min(0).max(1000).optional(),
    paddingRight: number.min(0).max(1000).optional(),
    paddingBottom: number.min(0).max(1000).optional(),
    paddingLeft: number.min(0).max(1000).optional(),
    positionMode: z.enum(["auto", "absolute"]).optional(),
    aspectRatioLocked: z.boolean().optional(),
    flowGapBefore: number.min(-5000).max(5000).optional(),
    flowCrossOffset: number.min(-5000).max(5000).optional(),
    horizontalConstraint: z.enum(["start", "center", "end", "stretch", "scale"]).optional(),
    verticalConstraint: z.enum(["start", "center", "end", "stretch", "scale"]).optional(),
    alignSelf: z.enum(["auto", "start", "center", "end", "stretch", "baseline"]).optional(),
    align: z
      .enum(["start", "center", "end", "stretch", "baseline"])
      .optional()
      .describe("Cross-axis alignment. Set explicitly on content containers and controls."),
    justify: z
      .enum(["start", "center", "end", "space-between"])
      .optional()
      .describe("Main-axis alignment. Set explicitly on content containers and controls."),
    wrap: z.boolean().optional(),
    gridColumns: z.number().int().min(1).max(12).optional(),
    gridColumnTracks: z.array(gridTrack).min(1).max(12).optional(),
    gridRowTracks: z.array(gridTrack).min(1).max(12).optional(),
    gridColumnSpan: z.number().int().min(1).max(12).optional(),
    gridRowSpan: z.number().int().min(1).max(12).optional(),
    responsiveBreakpoints: z.array(responsiveBreakpoint).max(8).optional(),
    widthMode: z.enum(["fixed", "fill", "hug"]).optional(),
    heightMode: z.enum(["fixed", "fill", "hug"]).optional(),
    minWidth: number.min(0).max(5000).optional(),
    maxWidth: number.min(1).max(5000).optional(),
    minHeight: number.min(0).max(5000).optional(),
    maxHeight: number.min(1).max(5000).optional(),
    linkTo: z.string().min(1).max(120).optional(),
    interactions: z
      .array(prototypeInteractionSchema)
      .max(20)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "Interaction IDs must be unique on a layer.",
      )
      .optional(),
    isComponent: z.boolean().optional(),
    instanceOf: z.string().min(1).max(120).optional(),
    componentSourceId: z.string().min(1).max(120).optional(),
    instanceOverrides: z.array(z.string().max(80)).max(200).optional(),
    componentProperties: z
      .record(
        z.string().min(1).max(80),
        z
          .object({
            name: z.string().trim().min(1).max(80),
            targetId: z.string().min(1).max(120),
            property: z.enum([
              "text",
              "visible",
              "width",
              "height",
              "fill",
              "color",
              "fontSize",
              "radius",
            ]),
          })
          .strict(),
      )
      .optional(),
    styleId: z.string().min(1).max(120).optional(),
    styleOverrides: z.array(z.string().min(1).max(80)).max(200).optional(),
    libraryNodeId: z.string().min(1).max(120).optional(),
    librarySource: z
      .object({
        fileUid: z.string().uuid(),
        componentId: z.string().min(1).max(120),
        revision: z.number().int().min(0),
        status: z.enum(["current", "update-available", "unavailable"]),
        availableRevision: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    semantics: semanticsSchema.optional(),
    states: z
      .object({
        hover: stateStyle.optional(),
        pressed: stateStyle.optional(),
        focus: stateStyle.optional(),
        disabled: stateStyle.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const variantNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,39}$/,
    "Use a lowercase variant name, such as primary or compact-primary.",
  );
// A variant reuses the same nodes. It can change appearance, sizing, text and visibility,
// but cannot replace the hierarchy, source links or native element type.
export const variantNodeChangesSchema = baseNodeSchema
  .pick({
    tokenBindings: true,
    style: true,
    text: true,
    richText: true,
    visible: true,
    assetId: true,
    vectorPath: true,
    states: true,
    layout: true,
    gap: true,
    padding: true,
    columnGap: true,
    rowGap: true,
    paddingTop: true,
    paddingRight: true,
    paddingBottom: true,
    paddingLeft: true,
    align: true,
    justify: true,
    wrap: true,
    alignSelf: true,
    gridColumns: true,
    gridColumnTracks: true,
    gridRowTracks: true,
    gridColumnSpan: true,
    gridRowSpan: true,
    responsiveBreakpoints: true,
    widthMode: true,
    heightMode: true,
    minWidth: true,
    maxWidth: true,
    minHeight: true,
    maxHeight: true,
  })
  .partial()
  .extend({
    style: style.optional(),
    visible: z.boolean().optional(),
    layout: baseNodeSchema.shape.layout.removeDefault().optional(),
    box: box.pick({ width: true, height: true }).partial().optional(),
  })
  .strict();
export const componentVariantSchema = z
  .object({
    root: variantNodeChangesSchema.optional(),
    children: z
      .record(z.string().min(1).max(120), variantNodeChangesSchema)
      .refine(
        (value) => Object.keys(value).length <= 250,
        "At most 250 child overrides per variant.",
      )
      .optional(),
  })
  .strict();
export const componentVariantsSchema = z
  .object({
    default: variantNameSchema,
    options: z
      .record(variantNameSchema, componentVariantSchema)
      .refine(
        (value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32,
        "Provide 1–32 named variants.",
      ),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value.options, value.default),
    "Default variant must exist in options.",
  );
export const designNodeSchema = baseNodeSchema.extend({
  variants: componentVariantsSchema
    .optional()
    .describe(
      "Named variants on a component master. Each option overrides the shared root/children; it never duplicates the tree.",
    ),
  variant: variantNameSchema
    .optional()
    .describe("Selected variant on a component or instance. Omit to follow the master's default."),
});

export const designNodeChangesSchema = designNodeSchema
  .pick({
    vectorPath: true,
    tokenBindings: true,
    name: true,
    assetId: true,
    vectorBoolean: true,
    mask: true,
    text: true,
    richText: true,
    style: true,
    visible: true,
    locked: true,
    layout: true,
    gap: true,
    padding: true,
    columnGap: true,
    rowGap: true,
    paddingTop: true,
    paddingRight: true,
    paddingBottom: true,
    paddingLeft: true,
    positionMode: true,
    aspectRatioLocked: true,
    flowGapBefore: true,
    flowCrossOffset: true,
    alignSelf: true,
    horizontalConstraint: true,
    verticalConstraint: true,
    align: true,
    justify: true,
    wrap: true,
    gridColumns: true,
    gridColumnTracks: true,
    gridRowTracks: true,
    gridColumnSpan: true,
    gridRowSpan: true,
    responsiveBreakpoints: true,
    widthMode: true,
    heightMode: true,
    minWidth: true,
    maxWidth: true,
    minHeight: true,
    maxHeight: true,
    linkTo: true,
    interactions: true,
    semantics: true,
    states: true,
    variants: true,
    variant: true,
    componentProperties: true,
  })
  .partial()
  .extend({
    // Zod applies inner defaults even inside optional fields. Edits must never apply creation defaults.
    box: box.partial().optional(),
    style: style.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    layout: designNodeSchema.shape.layout.removeDefault().optional(),
  })
  .strict();
export type DesignNodeChanges = z.infer<typeof designNodeChangesSchema>;
export type ComponentVariants = z.infer<typeof componentVariantsSchema>;
export type VariantNodeChanges = z.infer<typeof variantNodeChangesSchema>;

export const designDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    pages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            name: z.string().trim().min(1).max(120),
            guides: z
              .array(
                z
                  .object({
                    id: z.string().uuid(),
                    axis: z.enum(["x", "y"]),
                    position: number.min(-100000).max(100000),
                  })
                  .strict(),
              )
              .max(200)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .default(() => [{ id: "page-1", name: "Page 1" }]),
    commentPages: z.record(z.string().min(1).max(120), z.string().min(1).max(120)).optional(),
    legacyConverted: z.boolean().default(false),
    source: z
      .object({
        project: z.string().max(120),
        route: z.string().max(500),
        revision: z.string().max(120).optional(),
      })
      .optional(),
    // Fills and variants can reference more assets than the document's layer limit.
    assetMimeTypes: z.record(z.string().uuid(), z.string().max(120)).optional(),
    tokens: z.record(tokenName, color).default({}),
    designTokens: designTokensSchema.optional(),
    reusableStyles: z
      .record(
        z.string().min(1).max(120),
        z.object({ name: z.string().trim().min(1).max(120), style }).strict(),
      )
      .optional(),
    nodes: z.array(designNodeSchema).max(5000),
    warnings: z
      .array(
        z.object({
          nodeId: z.string().optional(),
          message: z.string().max(500),
          importKey: z.string().max(700).nullable().optional(),
          status: z.enum(["unread", "read", "dismissed"]).optional(),
        }),
      )
      .max(500),
    editedNodeIds: z.array(z.string().max(120)).max(5000).default([]),
    deletedSourceKeys: z
      .array(z.object({ importKey: z.string().max(700), sourceKey: z.string().max(240) }).strict())
      .max(5000)
      .default([]),
  })
  .strict();

export type DesignNode = z.infer<typeof designNodeSchema>;
export type DesignDocument = z.infer<typeof designDocumentSchema>;
import { DEFAULT_PAGE_ID } from "./document-defaults";
export { DEFAULT_PAGE_ID } from "./document-defaults";
export function nodePageId(node: DesignNode) {
  return node.pageId ?? DEFAULT_PAGE_ID;
}

export function buildDrawnNode(
  id: string,
  type: "artboard" | "container" | "text",
  parentId: string | null,
  box: DesignNode["box"],
): DesignNode {
  return {
    id,
    parentId,
    name: type === "artboard" ? "Frame" : type === "container" ? "Rectangle" : "Text",
    type,
    box,
    style:
      type === "text"
        ? { fontSize: 16, fontWeight: 400, color: "#1e1e1e" }
        : { fill: type === "artboard" ? "#ffffff" : "#dedede" },
    text: type === "text" ? "Text" : undefined,
    visible: true,
    locked: false,
    layout: "absolute",
  };
}

export { blankDesignDocument } from "./document-defaults";

export function parseDesignDocument(input: unknown): DesignDocument {
  const document = designDocumentSchema.parse(input);
  resolvedDesignTokens(document);
  const ids = new Set<string>();
  const sourceKeys = new Set<string>();
  const byId = new Map<string, DesignNode>();
  const pageIds = new Set(document.pages.map((page) => page.id));
  if (pageIds.size !== document.pages.length) throw new Error("Duplicate page ID.");
  for (const page of document.pages) {
    const guideIds = page.guides?.map((guide) => guide.id) ?? [];
    if (new Set(guideIds).size !== guideIds.length)
      throw new Error(`Duplicate guide ID on page ${page.id}.`);
  }
  for (const node of document.nodes) {
    if (node.tokenBindings) {
      const resolved = resolveNodeTokens(node, document);
      designNodeSchema.parse(resolved);
      validateResponsiveLayout(resolved);
    }
    for (const option of Object.values(node.variants?.options ?? {})) {
      for (const [id, patch] of [
        [node.id, option.root],
        ...Object.entries(option.children ?? {}),
      ] as const) {
        if (!patch?.tokenBindings) continue;
        const target = document.nodes.find((item) => item.id === id);
        if (target)
          designNodeSchema.parse(
            resolveNodeTokens({ ...target, tokenBindings: patch.tokenBindings }, document),
          );
      }
    }
    if (!pageIds.has(nodePageId(node)))
      throw new Error(`Layer ${node.id} belongs to a missing page.`);
    validateResponsiveLayout(node);
    if (node.richText && (node.type !== "text" || richTextPlain(node.richText) !== node.text))
      throw new Error(`Layer ${node.id}: rich text must match its plain text content.`);
    if (ids.has(node.id)) throw new Error(`Duplicate node ID: ${node.id}`);
    ids.add(node.id);
    byId.set(node.id, node);
    if (node.sourceKey && node.importKey) {
      const key = `${node.importKey}:${node.sourceKey}`;
      if (sourceKeys.has(key)) throw new Error(`Duplicate source key: ${key}`);
      sourceKeys.add(key);
    }
    if (node.type === "text" && node.text === undefined)
      throw new Error(`Text node ${node.id} needs text.`);
    if ((node.type === "image" || (node.type === "vector" && !node.vectorPath)) && !node.assetId)
      throw new Error(`Asset node ${node.id} needs an asset.`);
    if (
      (node.vectorPath || node.vectorBoolean) &&
      node.style.paints?.some((paint) => paint.type === "image")
    )
      throw new Error(`Path node ${node.id} supports solid and gradient fills.`);
    if (node.vectorPath && node.type !== "vector")
      throw new Error(`Path node ${node.id} must be a vector.`);
    if (node.type === "artboard" && node.parentId !== null)
      throw new Error(`Artboard ${node.id} must be a root.`);
  }
  for (const node of document.nodes) {
    if (node.linkTo && byId.get(node.linkTo)?.type !== "artboard")
      throw new Error(`Layer ${node.id} links to a missing frame.`);
    if (node.parentId && !byId.has(node.parentId))
      throw new Error(`Node ${node.id} has no parent.`);
    if (node.parentId && nodePageId(node) !== nodePageId(byId.get(node.parentId)!))
      throw new Error(`Node ${node.id} must share its parent's page.`);
    if (node.parentId && !["artboard", "container"].includes(byId.get(node.parentId)!.type))
      throw new Error(`Node ${node.id} has an invalid parent.`);
    let parentId = node.parentId;
    let depth = 0;
    while (parentId) {
      if (++depth > 40 || parentId === node.id)
        throw new Error(`Node ${node.id} has a cycle or exceeds depth 40.`);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  validateVectorRelationships(document.nodes);
  validateComponentVariants(document.nodes);
  for (const node of document.nodes) {
    if (node.componentProperties) {
      if (!node.isComponent) throw new Error("Exposed properties belong to component masters.");
      for (const property of Object.values(node.componentProperties)) {
        let target = byId.get(property.targetId);
        if (!target || (property.property === "text" && target.type !== "text"))
          throw new Error("Invalid exposed property target.");
        while (target && target.id !== node.id) target = byId.get(target.parentId ?? "");
        if (!target) throw new Error("Exposed properties must target their component subtree.");
      }
    }
    if (node.styleId && !document.reusableStyles?.[node.styleId])
      throw new Error("Reusable style source is missing.");
    if (node.librarySource && !node.isComponent)
      throw new Error("Library sources belong to cached component masters.");
  }
  validatePrototype(document.nodes);
  return document;
}

/** Every asset reference participates in authorization, capture validation and snapshots. */
export function nodeAssetIds(node: DesignNode): string[] {
  const variants = Object.values(node.variants?.options ?? {})
    .flatMap((option) => [option.root, ...Object.values(option.children ?? {})])
    .filter((changes) => changes !== undefined);
  return [
    ...new Set([
      ...(node.assetId ? [node.assetId] : []),
      ...(node.style.paints ?? []).flatMap((paint) =>
        paint.type === "image" && paint.assetId ? [paint.assetId] : [],
      ),
      ...variants.flatMap((changes) => [
        ...(changes.assetId ? [changes.assetId] : []),
        ...(changes.style?.paints ?? []).flatMap((paint) =>
          paint.type === "image" && paint.assetId ? [paint.assetId] : [],
        ),
      ]),
    ]),
  ];
}
export function documentAssetIds(document: DesignDocument): string[] {
  return [
    ...new Set([
      ...document.nodes.flatMap(nodeAssetIds),
      ...Object.values(document.reusableStyles ?? {}).flatMap((source) =>
        (source.style.paints ?? []).flatMap((p) =>
          p.type === "image" && p.assetId ? [p.assetId] : [],
        ),
      ),
    ]),
  ];
}
