"use client";
import type { SelectionInspectorProps } from "./types";
import type { SelectionFeatures } from "./selection";
import { PropertyField } from "../property-field";
import { Section } from "../inspector-controls";
import { SelectMenu } from "../../components/ui/select-menu";
import { InstanceControls } from "../instance-controls";
import { owningInstance } from "../../design/component-instance";
import { componentFamily } from "../../design/component-variants";

type Props = Pick<
  SelectionInspectorProps,
  "selected" | "document" | "readOnly" | "onPatch" | "onDocument" | "onGoToMaster"
> & { inspect: boolean } & Pick<SelectionFeatures, "text" | "image" | "vector">;
export function IdentitySection({
  selected,
  document,
  readOnly,
  onPatch,
  onDocument,
  onGoToMaster,
  inspect,
  text,
  image,
  vector,
}: Props) {
  const multi = selected.length > 1;
  const node = selected[0];
  const instance = !multi ? owningInstance(document.nodes, node.id) : undefined;
  const family = !multi ? componentFamily(document.nodes, node) : undefined;
  const inspectorHeader = (
    <>
      <div className="inspector-identity flex items-center gap-2 border-b border-primary-grey px-4 py-3 [&_input]:font-semibold">
        <div className="min-w-0 flex-1">
          {multi ? (
            <p className="text-xs font-medium">
              {selected.length}{" "}
              <span data-ph-public style={{ display: "contents" }}>
                layers
              </span>
            </p>
          ) : inspect ? (
            <p className="truncate text-xs font-medium">{node.name}</p>
          ) : (
            <PropertyField
              replayLabel
              layout="embedded"
              disabled={readOnly}
              label="Layer name"
              value={node.name}
              onCommit={(name) => {
                if (name.trim()) onPatch({ name: name.trim() });
              }}
            />
          )}
        </div>
        {!multi && (
          <span className="shrink-0 text-[10px] text-secondary-ink">
            {instance
              ? "Instance"
              : node.isComponent
                ? "Component"
                : text
                  ? "Text"
                  : image
                    ? "Image"
                    : vector
                      ? "Vector"
                      : node.type === "artboard"
                        ? "Frame"
                        : "Container"}
          </span>
        )}
      </div>
    </>
  );
  const componentControls = (family || instance) && (
    <Section replayTitle title="Component">
      {family && !inspect && (
        <div onKeyDown={(event) => event.stopPropagation()}>
          <SelectMenu
            replayLabel
            label="Variant"
            value={node.variant ?? family.variants.default}
            disabled={readOnly}
            options={Object.keys(family.variants.options).map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={(variant) => onPatch({ variant })}
          />
        </div>
      )}
      {instance && (
        <InstanceControls
          node={instance}
          fromChild={instance.id !== node.id}
          document={document}
          readOnly={inspect}
          onDocument={onDocument}
          onGoToMaster={onGoToMaster}
        />
      )}
    </Section>
  );

  return (
    <>
      {inspectorHeader}
      {componentControls}
    </>
  );
}
