"use client";
import { useState } from "react";
import { componentFamily } from "@bella/design/component-variants";
import type { PrototypeInteraction, PrototypeState } from "@bella/design/prototype";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { SelectMenu } from "@/components/ui/select-menu";
import { PropertyField } from "./property-field";
import { Section, ColorField, applyColor, type Patch } from "./inspector-controls";

const button =
  "rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20 disabled:opacity-40";
const stateOptions = ["default", "hover", "pressed", "focus", "disabled"] as const;
export function PrototypeInspector({
  node,
  document,
  readOnly,
  onPatch,
  onPreview,
}: {
  node: DesignNode;
  document: DesignDocument;
  readOnly: boolean;
  onPatch: (patch: Patch) => void;
  onPreview: () => void;
}) {
  const [chosen, setChosen] = useState("");
  const [state, setState] = useState<Exclude<PrototypeState, "default">>("hover");
  const interactions = node.interactions ?? [];
  const active = interactions.find((item) => item.id === chosen) ?? interactions[0];
  const frames = document.nodes.filter((item) => item.type === "artboard" && item.visible);
  const families = document.nodes.filter((item) => componentFamily(document.nodes, item));
  const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
  function update(change: (interaction: PrototypeInteraction) => PrototypeInteraction) {
    if (!active) return;
    onPatch((current) => ({
      interactions: current.interactions?.map((item) =>
        item.id === active.id ? change(item) : item,
      ),
    }));
  }
  function add(target = node.linkTo ?? frames[0]?.id) {
    const id = crypto.randomUUID();
    setChosen(id);
    onPatch((current) => ({
      ...(current.linkTo ? { linkTo: undefined } : {}),
      interactions: [
        ...(current.interactions ?? []),
        {
          id,
          trigger: { type: "click" },
          action: target
            ? { type: "navigate", target }
            : { type: "setState", target: current.id, state: "default" },
          transition: { type: "instant", duration: 0 },
        },
      ],
    }));
  }
  const action = active?.action;
  return (
    <>
      <Section
        replayTitle
        title="Prototype"
        action={
          <button data-ph-public className={button} onClick={onPreview} disabled={!frames.length}>
            Preview
          </button>
        }
      >
        <fieldset disabled={readOnly} className="space-y-3">
          {node.linkTo && (
            <button data-ph-public className={button} onClick={() => add(node.linkTo)}>
              Edit existing click link
            </button>
          )}
          {!!interactions.length && (
            <SelectMenu
              replayLabel
              label="Interaction"
              size="sm"
              value={active?.id ?? ""}
              onChange={setChosen}
              options={interactions.map((item, index) => ({
                value: item.id,
                label: `${index + 1} · ${item.trigger.type} → ${item.action.type}`,
              }))}
            />
          )}
          {active && (
            <div className="space-y-3">
              <SelectMenu
                replayOptions
                replayLabel
                label="Trigger"
                size="sm"
                value={active.trigger.type}
                onChange={(type) =>
                  update((current) => ({
                    ...current,
                    trigger:
                      type === "key"
                        ? { type, key: "Enter" }
                        : type === "afterDelay"
                          ? { type, delay: 500 }
                          : { type: type as "click" | "hover" },
                  }))
                }
                options={options(["click", "hover", "key", "afterDelay"])}
              />
              {active.trigger.type === "key" && (
                <SelectMenu
                  replayLabel
                  label="Trigger key"
                  size="sm"
                  value={active.trigger.key}
                  onChange={(key) =>
                    update((current) => ({ ...current, trigger: { type: "key", key } }))
                  }
                  options={options([
                    ...new Set([
                      active.trigger.key,
                      "Enter",
                      " ",
                      "Escape",
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      ..."abcdefghijklmnopqrstuvwxyz".split(""),
                    ]),
                  ]).map((option) =>
                    option.value === " " ? { ...option, label: "Space" } : option,
                  )}
                />
              )}
              {active.trigger.type === "afterDelay" && (
                <PropertyField
                  replayLabel
                  label="Delay (ms)"
                  min={100}
                  max={60000}
                  step={100}
                  value={active.trigger.delay}
                  numeric
                  integer
                  validate={(value) => value !== ""}
                  onCommit={(value) =>
                    update((current) => ({
                      ...current,
                      trigger: { type: "afterDelay", delay: Number(value) },
                    }))
                  }
                />
              )}
              <SelectMenu
                replayOptions
                replayLabel
                label="Action"
                size="sm"
                value={action!.type}
                onChange={(type) =>
                  update((current) => ({
                    ...current,
                    action:
                      type === "navigate"
                        ? { type, target: frames[0].id }
                        : type === "openOverlay"
                          ? { type, target: frames[0].id, position: "center", dismissOutside: true }
                          : type === "setState"
                            ? { type, target: node.id, state: "hover" }
                            : type === "setVariant"
                              ? {
                                  type,
                                  target: families[0].id,
                                  variant: componentFamily(document.nodes, families[0])!.variants
                                    .default,
                                }
                              : { type: type as "back" | "closeOverlay" },
                  }))
                }
                options={options([
                  ...(frames.length ? ["navigate", "openOverlay"] : []),
                  "back",
                  "closeOverlay",
                  "setState",
                  ...(families.length ? ["setVariant"] : []),
                ])}
              />
              {action && "target" in action && (
                <SelectMenu
                  replayLabel
                  label="Destination"
                  size="sm"
                  value={action.target}
                  onChange={(target) =>
                    update((current) => ({
                      ...current,
                      action:
                        "target" in current.action
                          ? {
                              ...current.action,
                              target,
                              ...(current.action.type === "setVariant"
                                ? {
                                    variant: componentFamily(
                                      document.nodes,
                                      document.nodes.find((node) => node.id === target)!,
                                    )!.variants.default,
                                  }
                                : {}),
                            }
                          : current.action,
                    }))
                  }
                  options={(action.type === "setState"
                    ? document.nodes
                    : action.type === "setVariant"
                      ? families
                      : frames
                  ).map((item) => ({
                    value: item.id,
                    label: `${document.pages.find((page) => page.id === (item.pageId ?? "page-1"))?.name ?? "Page"} · ${item.name}`,
                  }))}
                />
              )}
              {action?.type === "setState" && (
                <SelectMenu
                  replayOptions
                  replayLabel
                  label="Destination state"
                  size="sm"
                  value={action.state}
                  onChange={(state) =>
                    update((current) => ({
                      ...current,
                      action:
                        current.action.type === "setState"
                          ? { ...current.action, state: state as PrototypeState }
                          : current.action,
                    }))
                  }
                  options={options(stateOptions)}
                />
              )}
              {action?.type === "setVariant" && (
                <SelectMenu
                  replayLabel
                  label="Destination variant"
                  size="sm"
                  value={action.variant}
                  onChange={(variant) =>
                    update((current) => ({
                      ...current,
                      action:
                        current.action.type === "setVariant"
                          ? { ...current.action, variant }
                          : current.action,
                    }))
                  }
                  options={options(
                    Object.keys(
                      componentFamily(
                        document.nodes,
                        document.nodes.find((node) => node.id === action.target)!,
                      )!.variants.options,
                    ),
                  )}
                />
              )}
              {action?.type === "openOverlay" && (
                <>
                  <SelectMenu
                    replayOptions
                    replayLabel
                    label="Overlay position"
                    size="sm"
                    value={action.position}
                    onChange={(position) =>
                      update((current) => ({
                        ...current,
                        action:
                          current.action.type === "openOverlay"
                            ? {
                                ...current.action,
                                position: position as "center" | "top" | "bottom",
                              }
                            : current.action,
                      }))
                    }
                    options={options(["center", "top", "bottom"])}
                  />
                  <SelectMenu
                    replayOptions
                    replayLabel
                    label="Outside click"
                    size="sm"
                    value={action.dismissOutside ? "dismiss" : "keep"}
                    onChange={(value) =>
                      update((current) => ({
                        ...current,
                        action:
                          current.action.type === "openOverlay"
                            ? { ...current.action, dismissOutside: value === "dismiss" }
                            : current.action,
                      }))
                    }
                    options={[
                      { value: "dismiss", label: "Dismiss overlay" },
                      { value: "keep", label: "Keep open" },
                    ]}
                  />
                </>
              )}
              {action?.type !== "setState" && action?.type !== "setVariant" && (
                <SelectMenu
                  replayOptions
                  replayLabel
                  label="Transition"
                  size="sm"
                  value={active.transition.type}
                  onChange={(type) =>
                    update((current) => ({
                      ...current,
                      transition: {
                        type: type as "instant" | "fade" | "slide",
                        duration: type === "instant" ? 0 : current.transition.duration || 200,
                      },
                    }))
                  }
                  options={options(["instant", "fade", "slide"])}
                />
              )}
              {active.transition.type !== "instant" &&
                action?.type !== "setState" &&
                action?.type !== "setVariant" && (
                  <PropertyField
                    replayLabel
                    label="Duration (ms)"
                    min={0}
                    max={2000}
                    step={50}
                    value={active.transition.duration}
                    numeric
                    integer
                    validate={(value) => value !== ""}
                    onCommit={(value) =>
                      update((current) => ({
                        ...current,
                        transition: { ...current.transition, duration: Number(value) },
                      }))
                    }
                  />
                )}
              <button
                data-ph-public
                className={button}
                onClick={() =>
                  onPatch((current) => ({
                    interactions: current.interactions?.filter((item) => item.id !== active.id),
                  }))
                }
              >
                Remove interaction
              </button>
            </div>
          )}
          {interactions.length < 20 && (
            <button data-ph-public className={button} onClick={() => add()}>
              Add interaction
            </button>
          )}
          <details>
            <summary data-ph-public className="cursor-pointer text-xs">
              Paint states
            </summary>
            <div className="mt-3 space-y-3">
              <SelectMenu
                replayOptions
                replayLabel
                label="Paint state"
                size="sm"
                value={state}
                onChange={(value) => setState(value as typeof state)}
                options={options(["hover", "pressed", "focus", "disabled"])}
              />
              {(["fill", "color", "borderColor"] as const).map((property) => (
                <ColorField
                  replayLabel
                  key={property}
                  label={`${state} ${property}`}
                  nodes={[node]}
                  get={(node) =>
                    node.states?.[state]?.[property] ?? node.style[property] ?? "#000000"
                  }
                  onChange={(value) =>
                    onPatch((current) => ({
                      states: {
                        ...current.states,
                        [state]: {
                          ...current.states?.[state],
                          [property]: applyColor(
                            value,
                            current.states?.[state]?.[property] ??
                              current.style[property] ??
                              "#000000",
                          ),
                        },
                      },
                    }))
                  }
                />
              ))}
              <PropertyField
                replayLabel
                label={`${state} opacity`}
                min={0}
                max={1}
                step={0.1}
                value={node.states?.[state]?.opacity ?? node.style.opacity ?? 1}
                numeric
                validate={(value) => value !== ""}
                onCommit={(value) =>
                  onPatch((current) => ({
                    states: {
                      ...current.states,
                      [state]: { ...current.states?.[state], opacity: Number(value) },
                    },
                  }))
                }
              />
              {node.states?.[state] && (
                <button
                  className={button}
                  onClick={() =>
                    onPatch((current) => ({ states: { ...current.states, [state]: undefined } }))
                  }
                >
                  <span data-ph-public style={{ display: "contents" }}>
                    Reset{" "}
                  </span>
                  {state}{" "}
                  <span data-ph-public style={{ display: "contents" }}>
                    paint
                  </span>
                </button>
              )}
            </div>
          </details>
        </fieldset>
      </Section>
    </>
  );
}
