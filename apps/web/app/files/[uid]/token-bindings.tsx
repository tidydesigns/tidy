"use client";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import {
  bindingKinds,
  resolvedDesignTokens,
  typographyProperties,
  type TokenBinding,
} from "@/lib/design/design-tokens";
import { Choice, shared, type Patch } from "./inspector-controls";

export function TokenBindings({
  selected,
  document,
  onPatch,
}: {
  selected: DesignNode[];
  document: DesignDocument;
  onPatch: (patch: Patch) => void;
}) {
  const tokens = resolvedDesignTokens(document);
  const fields = (Object.keys(bindingKinds) as TokenBinding[]).filter((key) => {
    if (
      (key === "textStyle" || (typographyProperties as readonly string[]).includes(key)) &&
      !selected.every((node) => node.type === "text")
    )
      return false;
    return [...tokens.values()].some((token) => token.type === bindingKinds[key]);
  });
  if (!fields.length) return null;
  return (
    <details className="border-b border-primary-grey/60 px-4 py-3">
      <summary className="cursor-pointer text-xs font-medium">Token bindings</summary>
      <div className="mt-2 max-h-64 space-y-2 overflow-y-auto overscroll-contain">
        {fields.map((key) => (
          <Choice
            key={key}
            label={`${key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())} token`}
            value={shared(selected, (node) => node.tokenBindings?.[key] ?? "")}
            choices={[
              ["", "Custom"],
              ...[...tokens]
                .filter(([, token]) => token.type === bindingKinds[key])
                .map(([name]): [string, string] => [name, name]),
            ]}
            onChange={(name) =>
              onPatch({
                tokenBindings: { [key]: name || null },
                ...(key === "width"
                  ? { widthMode: "fixed" }
                  : key === "height"
                    ? { heightMode: "fixed" }
                    : {}),
              })
            }
          />
        ))}
      </div>
    </details>
  );
}
