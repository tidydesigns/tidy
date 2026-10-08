"use client";
import { useState } from "react";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { componentSubtreeIds, resolveVariantNodes } from "@/lib/design/component-variants";
import {
  exposeComponentProperty,
  propertyTarget,
  propertyValue,
  setComponentProperty,
} from "@/lib/design/component-properties";
import { SelectMenu } from "@/components/ui/select-menu";
import { PropertyField } from "./property-field";
import { Choice, Section, ColorField, applyColor } from "./inspector-controls";
const button = "rounded border border-primary-grey/70 px-2 py-1 text-xs hover:bg-primary-grey/15";
type Binding = NonNullable<DesignNode["componentProperties"]>[string];
const properties: Binding["property"][] = [
  "text",
  "visible",
  "width",
  "height",
  "fill",
  "color",
  "fontSize",
  "radius",
];
export function ComponentPropertiesInspector({
  node,
  document,
  onDocument,
}: {
  node: DesignNode;
  document: DesignDocument;
  onDocument: (update: (doc: DesignDocument) => DesignDocument) => void;
}) {
  const master = node.isComponent
    ? node
    : document.nodes.find((n) => n.id === node.componentSourceId && n.isComponent);
  const [targetId, setTargetId] = useState("");
  const [property, setProperty] = useState<Binding["property"]>("visible");
  const [name, setName] = useState("");
  if (!master) return null;
  const bindings = Object.entries(master.componentProperties ?? {});
  const author = node.id === master.id && !master.librarySource;
  const targets = document.nodes.filter((n) =>
    componentSubtreeIds(document.nodes, master.id).has(n.id),
  );
  const target = targets.find((n) => n.id === targetId) ?? targets[0];
  return (
    <>
      {master.librarySource && (
        <Section title="Library">
          <p className="text-xs text-secondary-ink">
            Library revision {master.librarySource.revision} ·{" "}
            {master.librarySource.status === "unavailable"
              ? "Source unavailable; cached instance"
              : master.librarySource.status === "update-available"
                ? "Update available in Components"
                : "Linked instance"}
          </p>
        </Section>
      )}
      {bindings.length > 0 && (
        <Section title="Properties">
          <div className="space-y-2">
            {bindings.map(([key, binding]) => {
              const bound = propertyTarget(document, node, binding);
              if (!bound) return null;
              const value = propertyValue(
                  resolveVariantNodes(document.nodes).find((n) => n.id === bound.id) ?? bound,
                  binding,
                ),
                numeric = ["width", "height", "fontSize", "radius"].includes(binding.property);
              const update = (value: string | number | boolean) =>
                onDocument((doc) => setComponentProperty(doc, node.id, key, value));
              return (
                <div key={key}>
                  {binding.property === "visible" ? (
                    <Choice
                      label={binding.name}
                      value={String(value)}
                      choices={[
                        ["true", "Visible"],
                        ["false", "Hidden"],
                      ]}
                      onChange={(v) => update(v === "true")}
                    />
                  ) : binding.property === "fill" || binding.property === "color" ? (
                    <ColorField
                      label={binding.name}
                      nodes={[bound]}
                      get={() => String(value ?? "#000000")}
                      onChange={(change) => update(applyColor(change, String(value ?? "#000000")))}
                    />
                  ) : (
                    <PropertyField
                      label={binding.name}
                      value={typeof value === "boolean" ? String(value) : value}
                      numeric={numeric}
                      min={binding.property === "radius" ? 0 : 1}
                      max={5000}
                      onCommit={(v) => update(numeric ? Number(v) : v)}
                    />
                  )}
                  {author && (
                    <button
                      className={`${button} mt-1`}
                      aria-label={`Remove property ${binding.name}`}
                      onClick={() =>
                        onDocument((doc) => ({
                          ...doc,
                          nodes: doc.nodes.map((n) => {
                            if (n.id !== master.id) return n;
                            const definitions = { ...n.componentProperties };
                            delete definitions[key];
                            return { ...n, componentProperties: definitions };
                          }),
                        }))
                      }
                    >
                      Remove property
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {author && (
        <Section title="Expose property">
          <div className="space-y-2">
            <SelectMenu
              label="Property layer"
              value={target.id}
              options={targets.map((n) => ({ value: n.id, label: n.name }))}
              onChange={setTargetId}
            />
            <SelectMenu
              label="Property"
              value={property}
              options={properties
                .filter((p) => p !== "text" || target.type === "text")
                .map((p) => ({ value: p, label: p }))}
              onChange={(v) => setProperty(v as Binding["property"])}
            />
            <PropertyField label="Property name" value={name} onCommit={setName} />
            <button
              className={button}
              disabled={!name.trim() || (property === "text" && target.type !== "text")}
              onClick={() => {
                const key = crypto.randomUUID();
                onDocument((doc) =>
                  exposeComponentProperty(doc, master.id, key, {
                    name: name.trim(),
                    targetId: target.id,
                    property,
                  }),
                );
                setName("");
              }}
            >
              Expose property
            </button>
          </div>
        </Section>
      )}
    </>
  );
}
