"use client";
import { isLayerLocked } from "@/lib/design/edit-document";
import { SelectMenu } from "@/components/ui/select-menu";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { componentSubtreeIds } from "@/lib/design/component-variants";
import { detachInstance, resetInstance, swapInstance } from "@/lib/design/component-instance";

const buttonClass =
  "rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary-orange";
export function InstanceControls({
  node,
  document,
  readOnly,
  fromChild = false,
  onDocument,
  onGoToMaster,
}: {
  node: DesignNode;
  document: DesignDocument;
  readOnly: boolean;
  fromChild?: boolean;
  onDocument: (change: (document: DesignDocument) => DesignDocument) => void;
  onGoToMaster?: (id: string) => void;
}) {
  const sources = document.nodes.filter(
    (item) => item.isComponent && !componentSubtreeIds(document.nodes, item.id).has(node.id),
  );
  const disabled = readOnly || isLayerLocked(document.nodes, node.id);
  return (
    <div className="space-y-2" onKeyDown={(event) => event.stopPropagation()}>
      {fromChild && <p className="text-xs text-secondary-ink">Instance: {node.name}</p>}
      {!readOnly && (
        <p className="text-xs text-secondary-ink">
          Detach to add, remove or rearrange layers. This instance will stop receiving component
          updates.
        </p>
      )}
      <SelectMenu
        replayLabel
        label="Swap component"
        value={node.instanceOf!}
        disabled={disabled}
        size="sm"
        options={sources.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(id) => onDocument((content) => swapInstance(content, node.id, id))}
      />
      <div className="flex flex-wrap gap-1.5">
        <button
          data-ph-public
          type="button"
          className={buttonClass}
          disabled={disabled}
          onClick={() => onDocument((content) => resetInstance(content, node.id))}
        >
          Reset overrides
        </button>
        <button
          data-ph-public
          type="button"
          className={buttonClass}
          disabled={disabled}
          onClick={() => onDocument((content) => detachInstance(content, node.id))}
        >
          Detach instance
        </button>
        {onGoToMaster && (
          <button
            data-ph-public
            type="button"
            className={buttonClass}
            onClick={() => onGoToMaster(node.instanceOf!)}
          >
            Go to master
          </button>
        )}
      </div>
    </div>
  );
}
