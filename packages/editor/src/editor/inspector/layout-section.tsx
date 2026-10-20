"use client";
import type { SelectionInspectorProps } from "./types";
import type { SelectionFeatures, SelectionLayout } from "./selection";
import { selectionFields, inspectorButtonClass as buttonClass } from "./fields";
import { Section, Choice } from "../inspector-controls";
import { InspectorDisclosure } from "../inspector-presentation";
import { GridTracks } from "./grid-tracks";
import { reparentLayer } from "../../design/document-operations";
import { canvasElements } from "../canvas-elements";
import { renderedNodeBox } from "../../design/canvas-geometry";
type Props = Pick<
  SelectionInspectorProps,
  "selected" | "document" | "onPatch" | "onDocument" | "viewport" | "onGroup"
> &
  Pick<SelectionFeatures, "containers"> &
  SelectionLayout;

export function LayoutSection({
  selected,
  document,
  onPatch,
  onDocument,
  viewport,
  onGroup,
  containers,
  gridChild,
  flowChild,
}: Props) {
  const { common } = selectionFields(selected, onPatch);
  const layoutSummary = containers
    ? (common((item) => {
        const flow =
          item.layout === "grid"
            ? `Grid · ${item.gridColumnTracks?.length ?? item.gridColumns ?? 2} columns`
            : item.layout === "flex-row"
              ? "Horizontal"
              : item.layout === "flex-column"
                ? "Vertical"
                : "Free position";
        return item.layout === "absolute" ? flow : `${flow} · Gap ${item.gap ?? 0}`;
      }) ?? "Mixed layouts")
    : gridChild
      ? "Grid item"
      : flowChild
        ? "In flow"
        : "Absolute";

  return (
    <InspectorDisclosure title="Layout" summary={layoutSummary}>
      <LayoutControls
        selected={selected}
        document={document}
        onPatch={onPatch}
        onDocument={onDocument}
        viewport={viewport}
        onGroup={onGroup}
        containers={containers}
      />
    </InspectorDisclosure>
  );
}

function LayoutControls({
  selected,
  document,
  onPatch,
  onDocument,
  viewport,
  onGroup,
  containers,
}: Omit<Props, "gridChild" | "flowChild">) {
  const multi = selected.length > 1;
  const node = selected[0];
  const { common, numberField } = selectionFields(selected, onPatch);
  const paddingKeys = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
  const separatePadding = selected.some((item) =>
    paddingKeys.some((key) => item[key] !== undefined),
  );
  return (
    <>
      {containers && (
        <div className="space-y-3">
          <Choice
            replayOptions
            replayLabel
            label="Flow"
            value={common((item) => item.layout)}
            choices={[
              ["absolute", "Free position"],
              ["flex-row", "Horizontal"],
              ["flex-column", "Vertical"],
              ["grid", "Grid"],
            ]}
            onChange={(value) =>
              onPatch((item) => ({
                layout: value,
                ...(value === "grid" && (item.gap ?? 0) < 0 ? { gap: 0 } : {}),
              }))
            }
          />
          {selected.some((item) => item.layout !== "absolute") && (
            <>
              {numberField(
                "Gap",
                (item) => item.gap ?? 0,
                (value) => ({ gap: value, columnGap: undefined, rowGap: undefined }),
                selected.some((item) => item.layout === "grid" || item.wrap) ? 0 : -1000,
                1000,
              )}
              <div className="grid grid-cols-2 gap-1.5">
                <Choice
                  replayOptions
                  replayLabel
                  label="Align"
                  value={common((item) => item.align ?? "start")}
                  choices={[
                    ["start", "Start"],
                    ["center", "Center"],
                    ["end", "End"],
                    ["stretch", "Stretch"],
                    ["baseline", "Baseline"],
                  ]}
                  onChange={(value) => onPatch({ align: value })}
                />
                <Choice
                  replayOptions
                  replayLabel
                  label="Distribute"
                  value={common((item) => item.justify ?? "start")}
                  choices={[
                    ["start", "Start"],
                    ["center", "Center"],
                    ["end", "End"],
                    ["space-between", "Space between"],
                    ["space-evenly", "Space evenly"],
                  ]}
                  onChange={(value) => onPatch({ justify: value })}
                />
              </div>
              {selected.some((item) => item.layout === "grid" || item.wrap) && (
                <div className="grid grid-cols-2 gap-1.5">
                  {numberField(
                    "Column gap",
                    (item) => item.columnGap ?? Math.max(0, item.gap ?? 0),
                    (value) => ({ columnGap: value }),
                    0,
                    1000,
                  )}
                  {numberField(
                    "Row gap",
                    (item) => item.rowGap ?? Math.max(0, item.gap ?? 0),
                    (value) => ({ rowGap: value }),
                    0,
                    1000,
                  )}
                </div>
              )}
              {selected.every((item) => item.layout === "grid") ? (
                numberField(
                  "Columns",
                  (item) => item.gridColumnTracks?.length ?? item.gridColumns ?? 2,
                  (value) => (item) => ({
                    gridColumns: value,
                    gridColumnTracks:
                      item.gridColumnTracks && value
                        ? Array.from(
                            { length: value },
                            (_, index) =>
                              item.gridColumnTracks?.[index] ?? {
                                unit: "fr" as const,
                                value: 1,
                              },
                          )
                        : undefined,
                  }),
                  1,
                  12,
                )
              ) : (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={common((item) => item.wrap ?? false) ?? false}
                    onChange={(event) => {
                      const wrap = event.target.checked;
                      onPatch((item) => ({
                        wrap,
                        ...(wrap && (item.gap ?? 0) < 0 ? { gap: 0 } : {}),
                      }));
                    }}
                  />
                  <span data-ph-public style={{ display: "contents" }}>
                    Wrap
                  </span>
                </label>
              )}
              {!multi && node.layout === "grid" && <GridTracks node={node} onPatch={onPatch} />}
              <div className="flex items-center justify-between">
                <span data-ph-public className="text-[10px] text-secondary-ink">
                  Padding
                </span>
                <button
                  data-ph-public
                  data-ph-public-label
                  type="button"
                  aria-label="Independent padding"
                  aria-pressed={separatePadding}
                  className={buttonClass}
                  onClick={() =>
                    onPatch((item) =>
                      separatePadding
                        ? {
                            padding: item.paddingTop ?? item.padding ?? 0,
                            paddingTop: undefined,
                            paddingRight: undefined,
                            paddingBottom: undefined,
                            paddingLeft: undefined,
                          }
                        : {
                            paddingTop: item.padding ?? 0,
                            paddingRight: item.padding ?? 0,
                            paddingBottom: item.padding ?? 0,
                            paddingLeft: item.padding ?? 0,
                          },
                    )
                  }
                >
                  {separatePadding ? "Link sides" : "Each side"}
                </button>
              </div>
              {separatePadding ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {paddingKeys.map((key, index) =>
                    numberField(
                      ["Padding top", "Padding right", "Padding bottom", "Padding left"][index],
                      (item) => item[key] ?? item.padding ?? 0,
                      (value) => ({ [key]: value }),
                      0,
                      1000,
                    ),
                  )}
                </div>
              ) : (
                numberField(
                  "Padding",
                  (item) => item.padding ?? 0,
                  (value) => ({ padding: value }),
                  0,
                  1000,
                )
              )}
            </>
          )}
          <Choice
            replayOptions
            replayLabel
            label="Overflow"
            value={common(
              (item) => item.style.overflow ?? (item.type === "artboard" ? "hidden" : "visible"),
            )}
            choices={[
              ["visible", "Visible"],
              ["hidden", "Clip"],
              ["auto", "Scroll"],
            ]}
            onChange={(value) => onPatch({ style: { overflow: value } })}
          />
        </div>
      )}
      {!multi && node.type !== "artboard" && (
        <Section replayTitle title="Structure">
          <Choice
            replayLabel
            label="Parent"
            value={node.parentId ?? ""}
            choices={[
              ["", "Canvas"],
              ...document.nodes
                .filter(
                  (item) =>
                    ["artboard", "container"].includes(item.type) &&
                    item.id !== node.id &&
                    (item.pageId ?? "page-1") === (node.pageId ?? "page-1"),
                )
                .map((item): [string, string] => [item.id, item.name]),
            ]}
            onChange={(parentId) =>
              onDocument((content) =>
                reparentLayer(
                  content,
                  node.id,
                  parentId || null,
                  new Map(
                    [...canvasElements(viewport?.current).values()].map((element) => [
                      element.dataset.nodeId!,
                      renderedNodeBox(element),
                    ]),
                  ),
                ),
              )
            }
          />
          <Choice
            replayOptions
            replayLabel
            label="Position in layout"
            value={node.positionMode ?? "auto"}
            choices={[
              ["auto", "In flow"],
              ["absolute", "Absolute"],
            ]}
            onChange={(value) => onPatch({ positionMode: value })}
          />
          <Choice
            replayOptions
            replayLabel
            label="Self alignment"
            value={node.alignSelf ?? "auto"}
            choices={[
              ["auto", "Parent default"],
              ["start", "Start"],
              ["center", "Center"],
              ["end", "End"],
              ["stretch", "Stretch"],
              ["baseline", "Baseline"],
            ]}
            onChange={(value) => onPatch({ alignSelf: value })}
          />
        </Section>
      )}
      {multi && (
        <div className="p-4">
          <button data-ph-public type="button" className={buttonClass} onClick={onGroup}>
            Group selection
          </button>
        </div>
      )}
    </>
  );
}
