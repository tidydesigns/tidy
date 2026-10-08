"use client";

import { useState } from "react";
import type { DesignNode } from "@/lib/design/document";
import {
  effectControls,
  effectStyle,
  moveEffect,
  nodeEffects,
  nodeShadows,
  shadowStyle,
  type Shadow,
} from "@bella/design/effects";
import { Choice, ColorField, Section, applyColor, shared, type Patch } from "./inspector-controls";
import { PropertyField } from "./property-field";

type Effect = ReturnType<typeof nodeEffects>[number];
const button =
  "rounded-md border border-primary-grey/70 px-2 py-1 text-xs hover:bg-primary-grey/20 disabled:opacity-30";
function StackActions({
  label,
  visible,
  index,
  count,
  onToggle,
  onMove,
  onRemove,
}: {
  label: string;
  visible: boolean | undefined;
  index: number;
  count: number;
  onToggle: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-1">
      <button
        type="button"
        className={button}
        aria-label={`Toggle ${label}`}
        aria-pressed={visible ?? false}
        onClick={onToggle}
      >
        {visible ? "◉" : "○"}
      </button>
      <button
        type="button"
        className={button}
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className={button}
        aria-label={`Move ${label} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      <button type="button" className={button} aria-label={`Remove ${label}`} onClick={onRemove}>
        −
      </button>
    </div>
  );
}
export function EffectsInspector({
  selected,
  tokens,
  onPatch,
}: {
  selected: DesignNode[];
  tokens: Record<string, string>;
  onPatch: (patch: Patch) => void;
}) {
  const [adding, setAdding] = useState<Effect["type"]>("blur");
  const shadowLists = selected.map((node) => nodeShadows(node.style)),
    effectLists = selected.map((node) => nodeEffects(node.style));
  const shadowCount = Math.min(...shadowLists.map((list) => list.length)),
    effectCount = Math.min(...effectLists.map((list) => list.length));
  // Capture each selected layer's identity, then resolve it against the latest stack at commit time.
  function shadowEdit(index: number, edit: (shadows: Shadow[], id: string) => Shadow[]) {
    const ids = new Map(
      selected.map((node, position) => [node.id, shadowLists[position][index].id]),
    );
    onPatch((node) => {
      const id = ids.get(node.id),
        shadows = nodeShadows(node.style);
      return id && shadows.some((shadow) => shadow.id === id)
        ? { style: shadowStyle(node.style, edit(shadows, id)) }
        : {};
    });
  }
  function effectEdit(index: number, edit: (effects: Effect[], id: string) => Effect[]) {
    const ids = new Map(
      selected.map((node, position) => [node.id, effectLists[position][index].id]),
    );
    onPatch((node) => {
      const id = ids.get(node.id),
        effects = nodeEffects(node.style);
      return id && effects.some((effect) => effect.id === id)
        ? { style: effectStyle(edit(effects, id)) }
        : {};
    });
  }
  return (
    <>
      <Section
        title="Shadows"
        action={
          <button
            type="button"
            aria-label="Add shadow"
            className={button}
            disabled={shadowLists.some((list) => list.length >= 20)}
            onClick={() => {
              const id = crypto.randomUUID();
              onPatch((node) => ({
                style: shadowStyle(node.style, [
                  ...nodeShadows(node.style),
                  {
                    id,
                    x: 0,
                    y: 2,
                    blur: 8,
                    spread: 0,
                    color: "#00000033",
                    inset: false,
                    visible: true,
                  },
                ]),
              }));
            }}
          >
            +
          </button>
        }
      >
        {shadowCount > 0 && (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {Array.from({ length: shadowCount }, (_, index) => {
              const label = `shadow ${index + 1}`,
                get = (node: DesignNode) => nodeShadows(node.style)[index];
              const update = (change: (shadow: Shadow) => Shadow) =>
                shadowEdit(index, (list, id) =>
                  list.map((shadow) => (shadow.id === id ? change(shadow) : shadow)),
                );
              const visible = shared(selected, (node) => get(node).visible);
              return (
                <details
                  key={shadowLists[0][index].id}
                  className="rounded-md border border-primary-grey/60 p-2"
                >
                  <summary className="cursor-pointer text-xs">
                    Shadow {index + 1}
                    {visible === false ? " · Hidden" : ""}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <StackActions
                      label={label}
                      visible={visible}
                      index={index}
                      count={shadowCount}
                      onToggle={() => update((shadow) => ({ ...shadow, visible: !visible }))}
                      onMove={(direction) =>
                        shadowEdit(index, (list, id) => moveEffect(list, id, direction))
                      }
                      onRemove={() =>
                        shadowEdit(index, (list, id) => list.filter((shadow) => shadow.id !== id))
                      }
                    />
                    <Choice
                      label={`Shadow ${index + 1}`}
                      value={shared(selected, (node) => (get(node).inset ? "inner" : "outer"))}
                      choices={[
                        ["outer", "Drop shadow"],
                        ["inner", "Inner shadow"],
                      ]}
                      onChange={(value) =>
                        update((shadow) => ({ ...shadow, inset: value === "inner" }))
                      }
                    />
                    <div className="grid grid-cols-2 gap-1.5">
                      {(["x", "y", "blur", "spread"] as const).map((key) => (
                        <PropertyField
                          key={key}
                          label={`Shadow ${index + 1} ${key}`}
                          value={shared(selected, (node) => get(node)[key])}
                          numeric
                          min={key === "blur" ? 0 : -1000}
                          max={1000}
                          step="any"
                          onCommit={(value) => {
                            if (value !== "")
                              update((shadow) => ({ ...shadow, [key]: Number(value) }));
                          }}
                        />
                      ))}
                    </div>
                    <ColorField
                      label={`Shadow ${index + 1} color`}
                      nodes={selected}
                      tokens={tokens}
                      get={(node) => get(node).color}
                      onChange={(value) =>
                        update((shadow) => ({ ...shadow, color: applyColor(value, shadow.color) }))
                      }
                    />
                  </div>
                </details>
              );
            })}
          </div>
        )}
        {(["shadow", "innerShadow"] as const).map(
          (key) =>
            selected.some((node) => Boolean(shadowStyle(node.style, [])[key])) && (
              <PropertyField
                key={key}
                label={key === "shadow" ? "Imported shadow CSS" : "Imported inner shadow CSS"}
                value={shared(selected, (node) => node.style[key] ?? "")}
                onCommit={(value) => onPatch({ style: { [key]: value || undefined } })}
              />
            ),
        )}
      </Section>
      <Section title="Effects">
        <div className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <Choice
              label="New effect"
              value={adding}
              choices={Object.entries(effectControls).map(([type, control]) => [
                type,
                control.label,
              ])}
              onChange={(value) => setAdding(value as Effect["type"])}
            />
          </div>
          <button
            type="button"
            className={button}
            aria-label="Add effect"
            disabled={effectLists.some((list) => list.length >= 20)}
            onClick={() => {
              const id = crypto.randomUUID();
              onPatch((node) => ({
                style: effectStyle([
                  ...nodeEffects(node.style),
                  { id, type: adding, amount: effectControls[adding].initial, visible: true },
                ]),
              }));
            }}
          >
            +
          </button>
        </div>
        {effectCount > 0 && (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {Array.from({ length: effectCount }, (_, index) => {
              const type = shared(selected, (node) => nodeEffects(node.style)[index].type),
                label = `effect ${index + 1}`;
              const visible = shared(selected, (node) => nodeEffects(node.style)[index].visible);
              const update = (change: (effect: Effect) => Effect) =>
                effectEdit(index, (list, id) =>
                  list.map((effect) => (effect.id === id ? change(effect) : effect)),
                );
              return (
                <details
                  key={effectLists[0][index].id}
                  className="rounded-md border border-primary-grey/60 p-2"
                >
                  <summary className="cursor-pointer text-xs">
                    {type ? effectControls[type].label : "Mixed effect"}
                    {visible === false ? " · Hidden" : ""}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <StackActions
                      label={label}
                      visible={visible}
                      index={index}
                      count={effectCount}
                      onToggle={() => update((effect) => ({ ...effect, visible: !visible }))}
                      onMove={(direction) =>
                        effectEdit(index, (list, id) => moveEffect(list, id, direction))
                      }
                      onRemove={() =>
                        effectEdit(index, (list, id) => list.filter((effect) => effect.id !== id))
                      }
                    />
                    <Choice
                      label={`Effect ${index + 1} type`}
                      value={type}
                      choices={Object.entries(effectControls).map(([kind, control]) => [
                        kind,
                        control.label,
                      ])}
                      onChange={(value) =>
                        update((effect) => ({
                          ...effect,
                          type: value as Effect["type"],
                          amount: effectControls[value as Effect["type"]].initial,
                        }))
                      }
                    />
                    {type && (
                      <PropertyField
                        label={`${effectControls[type].label} ${effectControls[type].unit}`}
                        value={shared(selected, (node) => nodeEffects(node.style)[index].amount)}
                        numeric
                        min={effectControls[type].min}
                        max={effectControls[type].max}
                        step="any"
                        onCommit={(value) => {
                          if (value !== "")
                            update((effect) => ({ ...effect, amount: Number(value) }));
                        }}
                      />
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
        <PropertyField
          label="Backdrop blur"
          value={shared(selected, (node) => node.style.backdropBlur ?? 0)}
          numeric
          min={0}
          max={100}
          step="any"
          onCommit={(value) => {
            if (value !== "") onPatch({ style: { backdropBlur: Number(value) } });
          }}
        />
      </Section>
    </>
  );
}
