"use client";

import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { SelectMenu } from "@/components/ui/select-menu";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { handoffCss, handoffFacts, layerHandoff } from "@/lib/design/handoff";
import { renderedNodeBox } from "@/lib/design/canvas-geometry";
import { canvasElements } from "./canvas-elements";
import { Section } from "./inspector-controls";
import { useEditorEvent } from "./use-editor-event";

const buttonClass =
  "rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange";
function Values({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="space-y-2 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          <dt className="break-words text-secondary-ink">{label}</dt>
          <dd className="break-words font-mono text-[11px]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HandoffInspector({
  selected,
  document,
  viewport,
}: {
  selected: DesignNode[];
  document: DesignDocument;
  viewport?: RefObject<HTMLDivElement | null>;
}) {
  const [chosen, setChosen] = useState(selected[0].id);
  const id = selected.some((node) => node.id === chosen) ? chosen : selected[0].id;
  const model = useMemo(() => layerHandoff(document, id)!, [document, id]);
  const [snapshot, setSnapshot] = useState<{
    id: string;
    css: string;
    facts: [string, string][];
    measured: boolean;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ css: string; message: string } | null>(null);
  const read = useEditorEvent(() => {
    const element = canvasElements(viewport?.current).get(id);
    const style = { ...model.style };
    if (element && model.node.type === "text") {
      const computed = getComputedStyle(element);
      style.fontFamily ??= computed.fontFamily;
      style.fontSize ??= computed.fontSize;
      style.fontWeight ??= computed.fontWeight;
      style.lineHeight ??= computed.lineHeight;
      style.letterSpacing ??= computed.letterSpacing;
      style.color ??= computed.color;
    }
    return {
      id,
      css: handoffCss(model.style, element, model.node.type === "text"),
      facts: handoffFacts(model.node, style, element ? renderedNodeBox(element) : undefined),
      measured: Boolean(element),
    };
  });
  const measure = useEditorEvent(() => {
    const next = read();
    setSnapshot((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  });
  useLayoutEffect(measure, [model, measure]);
  useLayoutEffect(() => {
    const element = canvasElements(viewport?.current).get(id);
    if (!element) return;
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    if (element.parentElement) resize.observe(element.parentElement);
    const mutations = new MutationObserver(measure);
    mutations.observe(element, {
      attributes: true,
      attributeFilter: ["style", "src", "viewBox"],
      childList: true,
      subtree: true,
    });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [id, measure, viewport]);
  const current =
    snapshot?.id === id
      ? snapshot
      : {
          id,
          css: handoffCss(model.style),
          facts: handoffFacts(model.node, model.style),
          measured: false,
        };
  async function copy() {
    const latest = read();
    try {
      await navigator.clipboard.writeText(latest.css);
      setCopyStatus({ css: latest.css, message: "CSS copied" });
    } catch {
      setCopyStatus({
        css: latest.css,
        message: "Could not copy. Select the CSS below to copy it manually.",
      });
    }
  }
  return (
    <div data-handoff-inspector>
      {selected.length > 1 && (
        <div className="px-4 py-3">
          <SelectMenu
            label="Inspect layer"
            value={id}
            options={selected.map((node) => ({ value: node.id, label: node.name }))}
            onChange={setChosen}
            size="sm"
          />
        </div>
      )}
      <Section title="Rendered values">
        <Values rows={current.facts} />
        <p className="text-[10px] text-secondary-ink">
          {current.measured
            ? "Size measured on canvas."
            : "Stored size; layer is not currently rendered."}{" "}
          Frame: {model.frameWidth}px.
        </p>
        {model.breakpoints.length > 0 && (
          <p className="text-[10px] text-secondary-ink">
            Active responsive rules: {model.breakpoints.map((width) => `≤ ${width}px`).join(", ")}.
          </p>
        )}
        {model.component && (
          <Values
            rows={[
              ["Component", model.component.name],
              ...(model.component.variant
                ? [["Variant", model.component.variant] as [string, string]]
                : []),
            ]}
          />
        )}
      </Section>
      <Section
        title="Generated CSS"
        action={
          <button type="button" className={buttonClass} onClick={() => void copy()}>
            Copy CSS
          </button>
        }
      >
        <p className="text-[10px] text-secondary-ink">
          Current renderer values, not original source CSS. Child selectors require the matching
          text, paint, or crop markup.
        </p>
        <pre
          tabIndex={0}
          aria-label="Generated layer CSS"
          className="max-h-64 overflow-auto whitespace-pre rounded-md bg-primary-grey/10 p-2 text-[10px] leading-relaxed select-text"
        >
          <code>{current.css}</code>
        </pre>
        {copyStatus?.css === current.css && (
          <p role="status" className="text-xs text-secondary-ink">
            {copyStatus.message}
          </p>
        )}
      </Section>
      {model.bindings.length > 0 && (
        <Section title="Color tokens">
          <Values
            rows={model.bindings.map((binding) => [
              binding.property,
              `${binding.name} → ${binding.value ?? "unset"}${binding.missing ? " (missing; fallback)" : ""}`,
            ])}
          />
        </Section>
      )}
      {model.assets.length > 0 && (
        <details className="border-b border-primary-grey/60 px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium">
            Assets ({model.assets.length})
          </summary>
          <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
            {model.assets.map((asset) => (
              <li key={asset}>
                <a
                  className="break-all font-mono text-[10px] underline"
                  href={`/api/assets/${asset}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {asset}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
      {model.node.type === "text" && (
        <Section title="Font">
          <Values
            rows={[
              ["Source", model.node.style.fontSource ?? "automatic"],
              ...(model.node.style.fontFace
                ? [["Face", model.node.style.fontFace] as [string, string]]
                : []),
            ]}
          />
        </Section>
      )}
      {model.source.length > 0 && (
        <details className="border-b border-primary-grey/60 px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium">Imported source</summary>
          <div className="mt-3 max-h-48 overflow-auto">
            <Values rows={model.source} />
          </div>
        </details>
      )}
    </div>
  );
}
