import * as z from "zod";
import {
  designNodeSchema,
  parseDesignDocument,
  blankDesignDocument,
  type DesignNode,
} from "./document";
import { layoutReport } from "./layout-diagnostics";

const properties = designNodeSchema.omit({ parentId: true, box: true, layout: true }).extend({
  box: designNodeSchema.shape.box.optional(),
  layout: designNodeSchema.shape.layout.removeDefault().optional(),
});
export type ComponentTree = z.input<typeof properties> & { children?: ComponentTree[] };
export const componentTreeSchema: z.ZodType<ComponentTree> = z.lazy(() =>
  properties.extend({ children: z.array(componentTreeSchema).max(250).optional() }),
);

/** Layout-first authoring is separate from measured imports, whose absolute geometry must remain intact. */
export function composeComponent(input: ComponentTree) {
  const nodes: DesignNode[] = [];
  function visit(
    value: ComponentTree,
    parentId: string | null,
    parentLayout?: DesignNode["layout"],
    depth = 0,
  ) {
    if (depth > 40 || nodes.length >= 250)
      throw new Error("A component can have at most 250 nodes and depth 40.");
    const { children = [], ...properties } = value;
    if (["container", "artboard"].includes(value.type) && value.layout === undefined)
      throw new Error(`Set an explicit flex, grid or absolute layout on ${value.id}.`);
    if (
      (value.type === "artboard" ||
        parentLayout === "absolute" ||
        value.positionMode === "absolute") &&
      !value.box
    )
      throw new Error(`Provide measured bounds for frame or absolute layer ${value.id}.`);
    const node = designNodeSchema.parse({
      ...properties,
      parentId,
      box: value.box ?? { x: 0, y: 0, width: 1, height: 1 },
      widthMode: value.widthMode ?? (value.box ? "fixed" : "hug"),
      heightMode: value.heightMode ?? (value.box ? "fixed" : "hug"),
      isComponent: parentId === null && value.type !== "artboard" ? true : value.isComponent,
    });
    nodes.push(node);
    for (const child of children) visit(child, node.id, node.layout, depth + 1);
  }
  visit(componentTreeSchema.parse(input), null);
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes });
  const report = layoutReport(document);
  if (!report.valid)
    throw new Error(
      report.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.nodeId}: ${issue.message}`)
        .join("\n"),
    );
  return { document, ...report };
}
