"use client";

import { canvasElements } from "./canvas-elements";
import { useState, type RefObject, type ReactNode } from "react";
import type { DesignNode, DesignPaint } from "@/lib/design/document";
import {
  convertPaint,
  nodePaints as fillPaints,
  paintBackground,
  paintStyle as fillStyle,
} from "@/lib/design/paints";
import { nodeStrokePaints, strokeWidths } from "@/lib/design/strokes";
import { initialImageCrop, loadedImageSize } from "@/lib/design/image-crop";
import { Choice, ColorField, Section, shared, applyColor, type Patch } from "./inspector-controls";
import {
  gradientSize,
  linearGradientAngle,
  setLinearGradientAngle,
} from "@/lib/design/gradient-geometry";
import { PropertyField } from "./property-field";
import { SelectMenu } from "@/components/ui/select-menu";
type Stop = Extract<DesignPaint, { type: "linear" }>["stops"][number];
type FillCrop = NonNullable<Extract<DesignPaint, { type: "image" }>["crop"]>;
const button =
  "rounded border border-primary-grey/70 px-2 py-1 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-30";
function updateCrop(
  crop: FillCrop,
  key: "x" | "y" | "width" | "height",
  percentage: number,
): FillCrop {
  const value = percentage / 100;
  return {
    ...crop,
    [key]:
      key === "x"
        ? Math.min(value, 1 - crop.width)
        : key === "y"
          ? Math.min(value, 1 - crop.height)
          : key === "width"
            ? Math.min(value, 1 - crop.x)
            : Math.min(value, 1 - crop.y),
  };
}
export function FillInspector({
  selected,
  tokens,
  onPatch: applyPatch,
  onUpload,
  editingGradientId,
  onGradientEdit,
  viewport,
  mode = "fill",
  children,
}: {
  mode?: "fill" | "stroke";
  children?: ReactNode;
  selected: DesignNode[];
  tokens: Record<string, string>;
  editingGradientId?: string;
  onGradientEdit?: (id: string | null) => void;
  onPatch: (changes: Patch) => void;
  onUpload?: (index: number, file: File) => Promise<void>;
  viewport?: RefObject<HTMLDivElement | null>;
}) {
  const vector = selected.some((node) => node.vectorPath),
    stroke = mode === "stroke",
    noun = stroke ? "Stroke" : "Fill",
    lower = noun.toLowerCase();
  const nodePaints = stroke ? nodeStrokePaints : fillPaints;
  const paintStyle = (paints: DesignPaint[]): Partial<DesignNode["style"]> =>
    stroke
      ? {
          strokePaints: paints.filter((paint) => paint.type !== "image"),
          borderColor: undefined,
          borderColorToken: undefined,
        }
      : fillStyle(paints);
  const paintSize = (node: DesignNode) => (stroke ? node.box : gradientSize(node));
  const onPatch = (patch: Patch) =>
    applyPatch((node) => {
      const changes = typeof patch === "function" ? patch(node) : patch;
      return stroke &&
        changes.style?.strokePaints?.length &&
        !strokeWidths(node.style).some((width) => width > 0)
        ? {
            ...changes,
            style: {
              ...changes.style,
              borderWidth: 1,
              borderTopWidth: undefined,
              borderRightWidth: undefined,
              borderBottomWidth: undefined,
              borderLeftWidth: undefined,
            },
          }
        : changes;
    });
  const [active, setActive] = useState(0),
    [uploading, setUploading] = useState(false);
  const [cropError, setCropError] = useState("");
  const lists = selected.map(nodePaints),
    count = Math.min(...lists.map((paints) => paints.length));
  const index = Math.min(active, Math.max(0, count - 1)),
    paint = lists[0][index];
  const type = shared(selected, (node) => nodePaints(node)[index]?.type);
  const read = <T,>(get: (paint: DesignPaint, node: DesignNode) => T) =>
    shared(selected, (node) => get(nodePaints(node)[index], node));
  const update = (change: (paint: DesignPaint, node: DesignNode) => DesignPaint) =>
    onPatch((node) => ({
      style: paintStyle(
        nodePaints(node).map((paint, i) => (i === index ? change(paint, node) : paint)),
      ),
    }));
  const number = (
    label: string,
    get: (paint: DesignPaint, node: DesignNode) => number,
    change: (paint: DesignPaint, value: number, node: DesignNode) => DesignPaint,
    min: number,
    max: number,
  ) => (
    <PropertyField
      label={label}
      value={read(get)}
      numeric
      min={min}
      max={max}
      step="any"
      onCommit={(value) => {
        if (value !== "") update((paint, node) => change(paint, Number(value), node));
      }}
    />
  );
  const token = (label: string, name: string | undefined, onChange: (name: string) => void) =>
    Object.keys(tokens).length ? (
      <Choice
        label={label}
        value={name}
        choices={[
          ["", "No token"],
          ...Object.keys(tokens).map((name): [string, string] => [name, name]),
        ]}
        onChange={onChange}
      />
    ) : null;
  const prefix = index === 0 ? noun : `${noun} ${index + 1}`;
  const cropped = lists.every(
    (paints) => paints[index]?.type === "image" && Boolean(paints[index].crop),
  );
  function enableCrop() {
    const sources = new Map(
      selected.map((node) => {
        const current = nodePaints(node)[index];
        const element = canvasElements(viewport?.current).get(node.id);
        const fill = [...(element?.querySelectorAll<HTMLElement>("[data-fill-id]") ?? [])].find(
          (item) => item.dataset.fillId === current.id,
        );
        const image = loadedImageSize(fill?.querySelector("img"));
        return [
          node.id,
          {
            box: node.box,
            width:
              current.type === "image" ? (current.crop?.sourceWidth ?? image?.width) : undefined,
            height:
              current.type === "image" ? (current.crop?.sourceHeight ?? image?.height) : undefined,
          },
        ] as const;
      }),
    );
    if ([...sources.values()].some((size) => !size.width || !size.height)) {
      setCropError("Wait for the fill image to load before cropping.");
      return;
    }
    setCropError("");
    update((paint, node) =>
      paint.type === "image"
        ? {
            ...paint,
            fit: "cover",
            crop:
              paint.crop ??
              initialImageCrop(
                {
                  ...node,
                  style: {
                    ...node.style,
                    objectFit: "cover",
                    objectPositionX: paint.positionX,
                    objectPositionY: paint.positionY,
                    imageCrop: undefined,
                    objectScale: 1,
                  },
                },
                sources.get(node.id)!.box,
                sources.get(node.id)!.width!,
                sources.get(node.id)!.height!,
                true,
              ),
          }
        : paint,
    );
  }
  return (
    <Section
      title={noun}
      action={
        <button
          type="button"
          aria-label={`Add ${lower}`}
          disabled={lists.some((paints) => paints.length >= 20)}
          className={button}
          onClick={() => {
            const id = crypto.randomUUID();
            onPatch((node) => ({
              style: paintStyle([
                { id, type: "solid", color: "#ffffff", opacity: 1, visible: true },
                ...nodePaints(node),
              ]),
            }));
            setActive(0);
            onGradientEdit?.(null);
          }}
        >
          +
        </button>
      }
    >
      {children}
      {Array.from({ length: count }, (_, i) => {
        const current = lists[0][i],
          kind = shared(selected, (node) => nodePaints(node)[i].type);
        return (
          <div
            key={i}
            className={`flex items-center gap-1 rounded-md p-1 ${index === i ? "bg-primary-grey/25" : ""}`}
          >
            <button
              type="button"
              aria-label={`Edit ${lower} ${i + 1}`}
              aria-pressed={index === i}
              onClick={() => {
                setActive(i);
                if (editingGradientId && editingGradientId !== current.id) onGradientEdit?.(null);
              }}
              className="h-7 w-7 shrink-0 rounded border border-primary-grey/70"
              style={{
                background:
                  current.type === "image" && current.assetId
                    ? `url("/api/assets/${current.assetId}") center / cover no-repeat`
                    : (paintBackground(current, tokens, paintSize(selected[0])) ?? "#ffffff"),
              }}
            />
            <SelectMenu
              label={i === 0 ? `${noun} type` : `${noun} ${i + 1} type`}
              value={kind ?? "mixed"}
              size="sm"
              className="flex-1"
              options={[
                ...(!kind ? [{ value: "mixed", label: "Mixed", disabled: true }] : []),
                ...[
                  ["solid", "Solid"],
                  ["linear", "Linear gradient"],
                  ["radial", "Radial gradient"],
                  ["image", "Image"],
                ]
                  .filter(([value]) => !(stroke || vector) || value !== "image")
                  .map(([value, label]) => ({ value, label })),
              ]}
              onChange={(value) => {
                const type = value as DesignPaint["type"];
                setActive(i);
                if (editingGradientId && editingGradientId !== current.id) onGradientEdit?.(null);
                onPatch((node) => ({
                  style: paintStyle(
                    nodePaints(node).map((paint, j) =>
                      i === j ? convertPaint(paint, type) : paint,
                    ),
                  ),
                }));
              }}
            />
            <button
              type="button"
              aria-label={`${current.visible ? "Hide" : "Show"} ${lower} ${i + 1}`}
              aria-pressed={current.visible}
              title={`Toggle ${lower} visibility`}
              className={button}
              onClick={() =>
                onPatch((node) => ({
                  style: paintStyle(
                    nodePaints(node).map((paint, j) =>
                      i === j ? { ...paint, visible: !current.visible } : paint,
                    ),
                  ),
                }))
              }
            >
              {current.visible ? "◉" : "○"}
            </button>
            <button
              type="button"
              aria-label={`Move ${lower} ${i + 1} up`}
              disabled={i === 0}
              className={button}
              onClick={() => {
                onPatch((node) => {
                  const paints = [...nodePaints(node)];
                  [paints[i - 1], paints[i]] = [paints[i], paints[i - 1]];
                  return { style: paintStyle(paints) };
                });
                setActive(i - 1);
                if (editingGradientId && editingGradientId !== current.id) onGradientEdit?.(null);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${lower} ${i + 1} down`}
              disabled={i === count - 1}
              className={button}
              onClick={() => {
                onPatch((node) => {
                  const paints = [...nodePaints(node)];
                  [paints[i + 1], paints[i]] = [paints[i], paints[i + 1]];
                  return { style: paintStyle(paints) };
                });
                setActive(i + 1);
                if (editingGradientId && editingGradientId !== current.id) onGradientEdit?.(null);
              }}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={i === 0 ? `Remove ${lower}` : `Remove ${lower} ${i + 1}`}
              className={button}
              onClick={() =>
                onPatch((node) => ({
                  style: paintStyle(nodePaints(node).filter((_, j) => j !== i)),
                }))
              }
            >
              −
            </button>
          </div>
        );
      })}
      {count > 0 && (
        <div key={index} className="space-y-2">
          {number(
            `${prefix} opacity %`,
            (paint) => paint.opacity * 100,
            (paint, value) => ({ ...paint, opacity: value / 100 }),
            0,
            100,
          )}
          <Choice
            label={`${prefix} blend mode`}
            value={read((paint) => paint.blendMode ?? "normal")}
            choices={["normal", "multiply", "screen", "overlay", "darken", "lighten"].map(
              (mode) => [mode, mode],
            )}
            onChange={(value) =>
              update((paint) => ({ ...paint, blendMode: value as DesignPaint["blendMode"] }))
            }
          />
          {type === "solid" && (
            <>
              <ColorField
                label={`${prefix} color`}
                nodes={selected}
                tokens={tokens}
                get={(node) => {
                  const paint = nodePaints(node)[index];
                  return paint.type === "solid"
                    ? paint.token
                      ? (tokens[paint.token] ?? paint.color)
                      : paint.color
                    : "#ffffff";
                }}
                onChange={(color) =>
                  update((paint) =>
                    paint.type === "solid"
                      ? {
                          ...paint,
                          color: applyColor(
                            color,
                            paint.token ? (tokens[paint.token] ?? paint.color) : paint.color,
                          ),
                          token: undefined,
                        }
                      : paint,
                  )
                }
              />
              {token(
                `${prefix} token`,
                read((paint) => (paint.type === "solid" ? (paint.token ?? "") : "")),
                (name) =>
                  update((paint) =>
                    paint.type === "solid" ? { ...paint, token: name || undefined } : paint,
                  ),
              )}
            </>
          )}
          {(type === "linear" || type === "radial") &&
            (paint.type === "linear" || paint.type === "radial") && (
              <>
                {selected.length === 1 && paint.visible && onGradientEdit && (
                  <button
                    type="button"
                    aria-pressed={editingGradientId === paint.id}
                    className={button}
                    onClick={() => onGradientEdit(editingGradientId === paint.id ? null : paint.id)}
                  >
                    {editingGradientId === paint.id ? "Finish gradient" : "Edit gradient"}
                  </button>
                )}
                {type === "linear" &&
                  number(
                    "Gradient angle",
                    (paint, node) =>
                      paint.type === "linear" ? linearGradientAngle(paint, paintSize(node)) : 180,
                    (paint, value, node) =>
                      paint.type === "linear"
                        ? setLinearGradientAngle(paint, value, paintSize(node))
                        : paint,
                    0,
                    360,
                  )}
                {type === "radial" &&
                  number(
                    "Gradient rotation",
                    (paint) => (paint.type === "radial" ? (paint.rotation ?? 0) : 0),
                    (paint, value) =>
                      paint.type === "radial" ? { ...paint, rotation: value } : paint,
                    -360,
                    360,
                  )}
                {type === "radial" && (
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["centerX", "centerY", "radiusX", "radiusY"] as const).map((key) => (
                      <div key={key}>
                        {number(
                          `Gradient ${key === "centerX" ? "X" : key === "centerY" ? "Y" : key === "radiusX" ? "radius X" : "radius Y"} %`,
                          (paint) => (paint.type === "radial" ? paint[key] * 100 : 50),
                          (paint, value) =>
                            paint.type === "radial" ? { ...paint, [key]: value / 100 } : paint,
                          key.startsWith("radius") ? 0.1 : -300,
                          key.startsWith("radius") ? 300 : 400,
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {Array.from(
                  {
                    length: Math.min(
                      ...lists.map((paints) => {
                        const paint = paints[index];
                        return paint.type === "linear" || paint.type === "radial"
                          ? paint.stops.length
                          : 0;
                      }),
                    ),
                  },
                  (_, stopIndex) => {
                    const get = (node: DesignNode) => {
                      const paint = nodePaints(node)[index];
                      return paint.type === "linear" || paint.type === "radial"
                        ? paint.stops[stopIndex]
                        : undefined;
                    };
                    const stop = get(selected[0])!;
                    const updateStop = (change: (stop: Stop) => Stop) =>
                      update((paint) =>
                        paint.type === "linear" || paint.type === "radial"
                          ? {
                              ...paint,
                              stops: paint.stops.map((entry, i) =>
                                i === stopIndex ? change(entry) : entry,
                              ),
                            }
                          : paint,
                      );
                    return (
                      <div
                        key={stop.id}
                        className="space-y-1.5 rounded-md border border-primary-grey/60 p-2"
                      >
                        <div className="flex items-end gap-2">
                          <PropertyField
                            label={`Stop ${stopIndex + 1} position %`}
                            value={shared(selected, (node) => get(node)!.position * 100)}
                            numeric
                            min={0}
                            max={100}
                            step="any"
                            onCommit={(value) => {
                              if (value !== "")
                                updateStop((stop) => ({ ...stop, position: Number(value) / 100 }));
                            }}
                          />
                          <button
                            type="button"
                            aria-label={`Remove stop ${stopIndex + 1}`}
                            disabled={lists.some((paints) => {
                              const paint = paints[index];
                              return (
                                (paint.type === "linear" || paint.type === "radial") &&
                                paint.stops.length <= 2
                              );
                            })}
                            className={button}
                            onClick={() =>
                              update((paint) =>
                                paint.type === "linear" || paint.type === "radial"
                                  ? {
                                      ...paint,
                                      stops: paint.stops.filter((_, i) => i !== stopIndex),
                                    }
                                  : paint,
                              )
                            }
                          >
                            −
                          </button>
                        </div>
                        <ColorField
                          label={`Stop ${stopIndex + 1} color`}
                          nodes={selected}
                          tokens={tokens}
                          get={(node) => {
                            const stop = get(node)!;
                            return stop.token ? (tokens[stop.token] ?? stop.color) : stop.color;
                          }}
                          onChange={(color) =>
                            updateStop((stop) => ({
                              ...stop,
                              color: applyColor(
                                color,
                                stop.token ? (tokens[stop.token] ?? stop.color) : stop.color,
                              ),
                              token: undefined,
                            }))
                          }
                        />
                        {token(
                          `Stop ${stopIndex + 1} token`,
                          shared(selected, (node) => get(node)?.token ?? ""),
                          (name) => updateStop((stop) => ({ ...stop, token: name || undefined })),
                        )}
                      </div>
                    );
                  },
                )}
                <button
                  type="button"
                  aria-label="Add gradient stop"
                  disabled={lists.some((paints) => {
                    const paint = paints[index];
                    return (
                      (paint.type === "linear" || paint.type === "radial") &&
                      paint.stops.length >= 20
                    );
                  })}
                  className={button}
                  onClick={() => {
                    const id = crypto.randomUUID();
                    update((paint) =>
                      paint.type === "linear" || paint.type === "radial"
                        ? {
                            ...paint,
                            stops: [...paint.stops, { id, position: 0.5, color: "#ffffff" }],
                          }
                        : paint,
                    );
                  }}
                >
                  + Stop
                </button>
              </>
            )}
          {type === "image" && (
            <>
              {!cropped && (
                <>
                  <Choice
                    label="Fill image fit"
                    value={read((paint) => (paint.type === "image" ? paint.fit : "cover"))}
                    choices={[
                      ["cover", "Fill"],
                      ["contain", "Fit"],
                      ["fill", "Stretch"],
                    ]}
                    onChange={(fit) =>
                      update((paint) =>
                        paint.type === "image"
                          ? { ...paint, fit: fit as "cover" | "contain" | "fill" }
                          : paint,
                      )
                    }
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["positionX", "positionY"] as const).map((key) => (
                      <div key={key}>
                        {number(
                          `Fill image ${key === "positionX" ? "X" : "Y"} %`,
                          (paint) => (paint.type === "image" ? paint[key] : 50),
                          (paint, value) =>
                            paint.type === "image" ? { ...paint, [key]: value } : paint,
                          0,
                          100,
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {lists.every(
                (paints) => paints[index]?.type === "image" && Boolean(paints[index].assetId),
              ) &&
                (cropped ? (
                  <>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(["x", "y", "width", "height"] as const).map((key) => (
                        <div key={key}>
                          {number(
                            `${prefix} crop ${key} %`,
                            (paint) =>
                              paint.type === "image" ? (paint.crop?.[key] ?? 0) * 100 : 0,
                            (paint, value) =>
                              paint.type === "image" && paint.crop
                                ? { ...paint, crop: updateCrop(paint.crop, key, value) }
                                : paint,
                            key === "width" || key === "height" ? 0.0001 : 0,
                            100,
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className={button}
                      onClick={() =>
                        update((paint) =>
                          paint.type === "image" ? { ...paint, crop: undefined } : paint,
                        )
                      }
                    >
                      Reset fill crop
                    </button>
                  </>
                ) : (
                  <button type="button" className={button} onClick={enableCrop}>
                    Crop fill image
                  </button>
                ))}
              {cropError && (
                <p role="alert" className="text-[10px] text-danger">
                  {cropError}
                </p>
              )}
              {onUpload && (
                <label className={`${button} inline-block cursor-pointer`}>
                  {uploading
                    ? "Uploading…"
                    : paint.type === "image" && paint.assetId
                      ? "Replace fill image"
                      : "Choose fill image"}
                  <input
                    aria-label="Fill image"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="sr-only"
                    disabled={uploading}
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.currentTarget.value = "";
                      if (file) {
                        setUploading(true);
                        try {
                          await onUpload(index, file);
                        } finally {
                          setUploading(false);
                        }
                      }
                    }}
                  />
                </label>
              )}
            </>
          )}
        </div>
      )}
      {lists.some((paints) => paints.length !== count) && (
        <p className="text-[10px] text-secondary-ink">Mixed {lower} counts</p>
      )}
    </Section>
  );
}
