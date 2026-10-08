"use client";
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
  onDocument,
  onGoToMaster,
}: {
  node: DesignNode;
  document: DesignDocument;
  readOnly: boolean;
  onDocument: (change: (document: DesignDocument) => DesignDocument) => void;
  onGoToMaster?: (id: string) => void;
}) {
  const sources = document.nodes.filter(
    (item) => item.isComponent && !componentSubtreeIds(document.nodes, item.id).has(node.id),
  );
  return (
    <div className="space-y-2" onKeyDown={(event) => event.stopPropagation()}>
      <SelectMenu
        label="Swap component"
        value={node.instanceOf!}
        disabled={readOnly}
        size="sm"
        options={sources.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(id) => onDocument((content) => swapInstance(content, node.id, id))}
      />
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={buttonClass}
          disabled={readOnly}
          onClick={() => onDocument((content) => resetInstance(content, node.id))}
        >
          Reset overrides
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={readOnly}
          onClick={() => onDocument((content) => detachInstance(content, node.id))}
        >
          Detach instance
        </button>
        {onGoToMaster && (
          <button
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
