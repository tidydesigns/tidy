"use client";

import type { DesignNode } from "@/lib/design/document";
import { framePresets } from "@/lib/design/frame-presets";
import { FontPicker } from "./font-picker";
import { PropertyField } from "./property-field";
import { Choice, ColorField, Section, applyColor, type Patch } from "./inspector-controls";
import { EditorAgentConnection, type EditorAgentSetup } from "./editor-agent-connection";

const presetGroups: readonly {
  label: string;
  ids: readonly (typeof framePresets)[number]["id"][];
}[] = [
  { label: "Phone", ids: ["mobile"] },
  { label: "Tablet", ids: ["tablet"] },
  { label: "Desktop", ids: ["desktop", "full-hd"] },
  { label: "Social", ids: ["square", "portrait"] },
];

export function TextToolInspector({
  node,
  onPatch,
}: {
  node: DesignNode;
  onPatch: (patch: Patch) => void;
}) {
  const lineHeightMode =
    node.style.lineHeightMode ?? (node.style.lineHeight === undefined ? "auto" : "percent");
  const lineHeightPixels =
    lineHeightMode === "px"
      ? (node.style.lineHeightPx ?? (node.style.fontSize ?? 16) * (node.style.lineHeight ?? 1.35))
      : (node.style.fontSize ?? 16) *
        (lineHeightMode === "auto" ? 1.2 : (node.style.lineHeight ?? 1.35));
  return (
    <>
      <Section replayTitle title="Text">
        <FontPicker replayLabel selected={[node]} onPatch={onPatch} />
        <div className="grid grid-cols-2 gap-2">
          <PropertyField
            replayLabel
            label="Font size"
            numeric
            required
            min={6}
            max={300}
            value={node.style.fontSize ?? 16}
            onCommit={(value) => onPatch({ style: { fontSize: Number(value) } })}
          />
          <PropertyField
            replayLabel
            label="Letter spacing"
            numeric
            min={-100}
            max={100}
            value={node.style.letterSpacing ?? 0}
            onCommit={(value) => onPatch({ style: { letterSpacing: Number(value) } })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Choice
            replayLabel
            replayOptions
            label="Line height mode"
            value={lineHeightMode}
            choices={[
              ["auto", "Auto"],
              ["percent", "%"],
              ["px", "px"],
            ]}
            onChange={(mode) =>
              onPatch({
                style:
                  mode === "auto"
                    ? { lineHeightMode: mode }
                    : mode === "px"
                      ? {
                          lineHeightMode: mode,
                          lineHeightPx: Math.max(0.1, Math.min(1200, lineHeightPixels)),
                        }
                      : {
                          lineHeightMode: mode,
                          lineHeight: Math.max(
                            0.0001,
                            Math.min(200, lineHeightPixels / (node.style.fontSize ?? 16)),
                          ),
                        },
              })
            }
          />
          {lineHeightMode !== "auto" && (
            <PropertyField
              replayLabel
              label={lineHeightMode === "px" ? "Line height px" : "Line height %"}
              numeric
              min={lineHeightMode === "px" ? 0.1 : 0.01}
              max={lineHeightMode === "px" ? 1200 : 20000}
              value={
                lineHeightMode === "px" ? lineHeightPixels : (node.style.lineHeight ?? 1.35) * 100
              }
              onCommit={(value) =>
                onPatch({
                  style:
                    value === ""
                      ? {
                          lineHeightMode: "auto",
                          lineHeight: undefined,
                          lineHeightPx: undefined,
                        }
                      : lineHeightMode === "px"
                        ? { lineHeightMode: "px", lineHeightPx: Number(value) }
                        : {
                            lineHeightMode: "percent",
                            lineHeight: Number(value) / 100,
                          },
                })
              }
            />
          )}
        </div>
        <div>
          <Choice
            replayLabel
            replayOptions
            label="Text alignment"
            value={node.style.textAlign ?? "left"}
            choices={[
              ["left", "Left"],
              ["center", "Center"],
              ["right", "Right"],
            ]}
            onChange={(value) => onPatch({ style: { textAlign: value } })}
          />
        </div>
      </Section>
      <Section replayTitle title="Fill">
        <ColorField
          replayLabel
          label="Text color"
          nodes={[node]}
          get={(item) => item.style.color ?? "#1e1e1e"}
          onChange={(value) =>
            onPatch({
              style: {
                color: applyColor(value, node.style.color ?? "#1e1e1e"),
              },
            })
          }
        />
      </Section>
    </>
  );
}

export function ToolInspector({
  tool,
  textNode,
  onTextPatch,
  onFrame,
  pageNode,
  onBackground,
  agentSetup,
  readOnly,
}: {
  tool: "frame" | "text" | null;
  textNode: DesignNode;
  onTextPatch: (patch: Patch) => void;
  onFrame: (preset: (typeof framePresets)[number]) => void;
  pageNode: DesignNode;
  onBackground: (color: string) => void;
  agentSetup?: EditorAgentSetup;
  readOnly: boolean;
}) {
  if (!readOnly && tool === "frame")
    return (
      <Section replayTitle title="Frame">
        <div className="-mx-2">
          {presetGroups.map((group) => (
            <details key={group.label} className="group/preset">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-primary-grey/15 focus-visible:outline-2 focus-visible:outline-primary-orange">
                <span aria-hidden="true" className="text-secondary-ink group-open/preset:rotate-90">
                  ›
                </span>
                {group.label}
              </summary>
              <div className="space-y-1 pb-2 pl-4">
                {framePresets
                  .filter((preset) => group.ids.includes(preset.id))
                  .map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onFrame(preset)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
                    >
                      <span>{preset.label.split(" · ")[0]}</span>
                      <span className="text-[10px] tabular-nums text-secondary-ink">
                        {preset.width} × {preset.height}
                      </span>
                    </button>
                  ))}
              </div>
            </details>
          ))}
        </div>
      </Section>
    );
  if (!readOnly && tool === "text")
    return <TextToolInspector node={textNode} onPatch={onTextPatch} />;
  return (
    <>
      <Section replayTitle title="Page">
        <fieldset disabled={readOnly}>
          <ColorField
            replayLabel
            label="Canvas color"
            nodes={[pageNode]}
            get={(node) => node.style.fill ?? "#f3f3f3"}
            onChange={(value) => onBackground(applyColor(value, pageNode.style.fill ?? "#f3f3f3"))}
          />
        </fieldset>
      </Section>
      {agentSetup && (
        <Section replayTitle title="MCP">
          <EditorAgentConnection setup={agentSetup} />
        </Section>
      )}
    </>
  );
}
