"use client";
import { useState } from "react";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import {
  createReusableStyle,
  applyReusableStyle,
  updateReusableStyle,
  detachReusableStyle,
  removeReusableStyle,
} from "@/lib/design/reusable-styles";
import { SelectMenu } from "@/components/ui/select-menu";
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
    <Section title="Style">
      <div className="space-y-2">
        {styles.length > 0 && (
          <SelectMenu
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
              className={button}
              onClick={() => onDocument((doc) => applyReusableStyle(doc, ids, node.styleId!))}
            >
              Reset style overrides
            </button>
            <button
              className={button}
              onClick={() => onDocument((doc) => removeReusableStyle(doc, node.styleId!))}
            >
              Delete style
            </button>
          </div>
        )}{" "}
        {!node.styleId && selected.length === 1 && (
          <details>
            <summary className="cursor-pointer text-xs text-secondary-ink">
              Create reusable style
            </summary>
            <div className="mt-2 space-y-2">
              <PropertyField label="Style name" value={name} onCommit={setName} />
              <button
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
