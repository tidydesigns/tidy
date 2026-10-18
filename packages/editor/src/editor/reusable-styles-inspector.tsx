"use client";
import { useState } from "react";
import type { DesignDocument, DesignNode } from "../design/document";
import {
  createReusableStyle,
  applyReusableStyle,
  updateReusableStyle,
  detachReusableStyle,
  removeReusableStyle,
} from "../design/reusable-styles";
import { SelectMenu } from "../components/ui/select-menu";
import { PropertyField } from "./property-field";
import { Section } from "./inspector-controls";
const button = "rounded border border-primary-grey/70 px-2 py-1 text-xs hover:bg-primary-grey/15";
export function ReusableStylesInspector({
  selected,
  document,
  onDocument,
}: {
  selected: DesignNode[];
  document: DesignDocument;
  onDocument: (update: (doc: DesignDocument) => DesignDocument) => void;
}) {
  const [name, setName] = useState("");
  const node = selected[0],
    ids = selected.map((n) => n.id),
    styles = Object.entries(document.reusableStyles ?? {});
  return (
    <Section replayTitle title="Style">
      <div className="space-y-2">
        {styles.length > 0 && (
          <SelectMenu
            replayLabel
            label="Reusable style"
            value={selected.every((n) => n.styleId === node.styleId) ? (node.styleId ?? "") : ""}
            options={[
              { value: "", label: "Local style" },
              ...styles.map(([id, s]) => ({ value: id, label: s.name })),
            ]}
            onChange={(id) =>
              onDocument((doc) =>
                id ? applyReusableStyle(doc, ids, id) : detachReusableStyle(doc, ids),
              )
            }
          />
        )}{" "}
        {node.styleId && (
          <div className="flex flex-wrap gap-2">
            <button
              data-ph-public
              className={button}
              onClick={() =>
                onDocument((doc) =>
                  updateReusableStyle(
                    doc,
                    node.styleId!,
                    doc.nodes.find((n) => n.id === node.id)!.style,
                  ),
                )
              }
            >
              Update style from layer
            </button>
            <button
              data-ph-public
              className={button}
              onClick={() => onDocument((doc) => applyReusableStyle(doc, ids, node.styleId!))}
            >
              Reset style overrides
            </button>
            <button
              data-ph-public
              className={button}
              onClick={() => onDocument((doc) => removeReusableStyle(doc, node.styleId!))}
            >
              Delete style
            </button>
          </div>
        )}{" "}
        {!node.styleId && selected.length === 1 && (
          <details>
            <summary data-ph-public className="cursor-pointer text-xs text-secondary-ink">
              Create reusable style
            </summary>
            <div className="mt-2 space-y-2">
              <PropertyField replayLabel label="Style name" value={name} onCommit={setName} />
              <button
                data-ph-public
                className={button}
                disabled={!name.trim()}
                onClick={() => {
                  const id = crypto.randomUUID();
                  onDocument((doc) => createReusableStyle(doc, node.id, id, name.trim()));
                  setName("");
                }}
              >
                Create style
              </button>
            </div>
          </details>
        )}
      </div>
    </Section>
  );
}
