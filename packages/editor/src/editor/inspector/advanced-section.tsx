"use client";
import type { SelectionInspectorProps } from "./types";
import { selectionFields } from "./fields";
import { ComponentPropertiesInspector } from "../component-properties-inspector";
import { ReusableStylesInspector } from "../reusable-styles-inspector";
import { TokenBindings } from "../token-bindings";
import { ResponsiveBreakpoints } from "../responsive-breakpoints";
import { InspectorDisclosure } from "../inspector-presentation";

type Props = Pick<SelectionInspectorProps, "selected" | "document" | "onPatch" | "onDocument"> & {
  sourceSelection: SelectionInspectorProps["selected"];
};
export function AdvancedSection({
  selected,
  sourceSelection,
  document,
  onPatch,
  onDocument,
}: Props) {
  return (
    <InspectorDisclosure title="Advanced">
      <AdvancedControls
        selected={selected}
        sourceSelection={sourceSelection}
        document={document}
        onPatch={onPatch}
        onDocument={onDocument}
      />
    </InspectorDisclosure>
  );
}

function AdvancedControls({ selected, sourceSelection, document, onPatch, onDocument }: Props) {
  const multi = selected.length > 1;
  const node = selected[0];
  const { numberField } = selectionFields(selected, onPatch);
  return (
    <>
      <TokenBindings selected={selected} document={document} onPatch={onPatch} />
      {!multi && (
        <ComponentPropertiesInspector
          key={`properties:${node.id}`}
          mode="authoring"
          node={node}
          document={document}
          onDocument={onDocument}
        />
      )}
      <ReusableStylesInspector
        key={`styles:${selected.map((n) => n.id).join(",")}`}
        selected={sourceSelection}
        document={document}
        onDocument={onDocument}
      />
      {!multi && (
        <div className="px-4 py-3">
          <ResponsiveBreakpoints node={node} document={document} onPatch={onPatch} />
        </div>
      )}
      <details className="border-b border-primary-grey/60">
        <summary data-ph-public className="cursor-pointer px-4 py-3 text-xs font-medium">
          Sizing limits
        </summary>
        <div className="grid grid-cols-2 gap-1.5 px-4 pb-3">
          {(["minWidth", "maxWidth", "minHeight", "maxHeight"] as const).map((key) =>
            numberField(
              key.replace(/([A-Z])/g, " $1"),
              (item) => item[key],
              (value) => ({ [key]: value }),
              key.startsWith("max") ? 1 : 0,
              5000,
              true,
            ),
          )}
        </div>
      </details>
    </>
  );
}
