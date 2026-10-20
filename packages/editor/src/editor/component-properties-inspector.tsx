"use client";
import { useState } from "react";
import type { DesignDocument, DesignNode } from "../design/document";
import { componentSubtreeIds, resolveVariantNodes } from "../design/component-variants";
import {
  exposeComponentProperty,
  propertyTarget,
  propertyValue,
  setComponentProperty,
} from "../design/component-properties";
import { SelectMenu } from "../components/ui/select-menu";
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
  mode = "all",
}: {
  mode?: "all" | "properties" | "authoring";
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
  const subtreeIds = componentSubtreeIds(document.nodes, master.id);
  const targets = document.nodes.filter((node) => subtreeIds.has(node.id));
  const target = targets.find((n) => n.id === targetId) ?? targets[0];
  return (
    <>
      {mode !== "properties" && master.librarySource && (
        <Section replayTitle title="Library">
          <p className="text-xs text-secondary-ink">
            <span data-ph-public style={{ display: "contents" }}>
              Library revision{" "}
            </span>
            {master.librarySource.revision}{" "}
            <span data-ph-public style={{ display: "contents" }}>
              ·
            </span>{" "}
            <span data-ph-public style={{ display: "contents" }}>
              {master.librarySource.status === "unavailable"
                ? "Source unavailable; cached instance"
                : master.librarySource.status === "update-available"
                  ? "Update available in Components"
                  : "Linked instance"}
            </span>
          </p>
        </Section>
      )}
      {bindings.length > 0 && (
        <Section replayTitle title={mode === "authoring" ? "Manage properties" : "Properties"}>
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
                  <div hidden={mode === "authoring"}>
                    {binding.property === "visible" ? (
                      <Choice
                        replayOptions
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
                        onChange={(change) =>
                          update(applyColor(change, String(value ?? "#000000")))
                        }
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
                  </div>
                  {mode === "authoring" && <p className="text-xs">{binding.name}</p>}
                  {mode !== "properties" && author && (
                    <button
                      data-ph-public
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
      {mode !== "properties" && author && (
        <Section replayTitle title="Expose property">
          <div className="space-y-2">
            <SelectMenu
              replayLabel
              label="Property layer"
              value={target.id}
              options={targets.map((n) => ({ value: n.id, label: n.name }))}
              onChange={setTargetId}
            />
            <SelectMenu
              replayOptions
              replayLabel
              label="Property"
              value={property}
              options={properties
                .filter((p) => p !== "text" || target.type === "text")
                .map((p) => ({ value: p, label: p }))}
              onChange={(v) => setProperty(v as Binding["property"])}
            />
            <PropertyField replayLabel label="Property name" value={name} onCommit={setName} />
            <button
              data-ph-public
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
