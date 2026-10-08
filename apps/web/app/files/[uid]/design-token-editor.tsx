"use client";
import { useState } from "react";
import { buildDrawnNode, parseDesignDocument, type DesignDocument } from "@/lib/design/document";
import {
  resolvedDesignTokens,
  tokenTypeSchema,
  typographyProperties,
  type DesignToken,
} from "@/lib/design/design-tokens";
import { renameDesignToken, removeDesignToken } from "@/lib/design/tokens";
import { Choice } from "./inspector-controls";
import { PropertyField } from "./property-field";
import { FontPicker } from "./font-picker";

type Change = (transform: (document: DesignDocument) => DesignDocument) => void;
const defaults: Record<DesignToken["type"], DesignToken> = {
  color: { type: "color", value: "#ff5d00" },
  radius: { type: "radius", value: 8 },
  spacing: { type: "spacing", value: 8 },
  dimension: { type: "dimension", value: 100 },
  number: { type: "number", value: 1 },
  typography: {
    type: "typography",
    value: {
      fontFamily: "system-ui",
      fontSource: "system",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.35,
      lineHeightMode: "percent",
    },
  },
};
const label = (type: string) =>
  type === "typography" ? "Text style" : type[0].toUpperCase() + type.slice(1);
export function AddToken({ onChange }: { onChange: Change }) {
  const [type, setType] = useState<DesignToken["type"]>("color");
  return (
    <div className="space-y-2">
      <Choice
        label="Token type"
        value={type}
        choices={tokenTypeSchema.options.map((type) => [type, label(type)])}
        onChange={(value) => setType(value as DesignToken["type"])}
      />
      <button
        type="button"
        className="w-full rounded-md border border-primary-grey/70 px-3 py-2 text-left text-xs hover:bg-primary-grey/20"
        onClick={() =>
          onChange((content) => {
            let index = 1;
            while (
              Object.hasOwn(content.tokens, `${type}_${index}`) ||
              Object.hasOwn(content.designTokens ?? {}, `${type}_${index}`)
            )
              index++;
            const name = `${type}_${index}`;
            return parseDesignDocument({
              ...content,
              designTokens: { ...content.designTokens, [name]: defaults[type] },
            });
          })
        }
      >
        + {label(type)} token
      </button>
    </div>
  );
}

export function DesignTokenEditor({
  document,
  name,
  token,
  onChange,
}: {
  document: DesignDocument;
  name: string;
  token: DesignToken;
  onChange: Change;
}) {
  const resolved = resolvedDesignTokens(document).get(name)!;
  if (!("value" in resolved)) return null;
  const update = (change: (current: DesignToken) => DesignToken) =>
    onChange((content) =>
      parseDesignDocument({
        ...content,
        designTokens: {
          ...content.designTokens,
          [name]: change(resolvedDesignTokens(content).get(name)!),
        },
      }),
    );
  const aliases = [...resolvedDesignTokens(document)]
    .filter(([candidate, value]) => {
      if (value.type !== token.type) return false;
      const visited = new Set([name]);
      let next: string | undefined = candidate;
      while (next) {
        if (visited.has(next)) return false;
        visited.add(next);
        const entry: DesignToken | undefined = document.designTokens?.[next];
        next = entry && "alias" in entry ? entry.alias : undefined;
      }
      return true;
    })
    .map(([name]) => name);
  const text = resolved.type === "typography" ? resolved.value : undefined;
  const textNode = {
    ...buildDrawnNode("token-preview", "text", null, { x: 0, y: 0, width: 100, height: 40 }),
    style: text ?? {},
  };
  const textValue = (key: keyof NonNullable<typeof text>, value: unknown) =>
    update((current) =>
      current.type === "typography" && "value" in current
        ? { ...current, value: { ...current.value, [key]: value } }
        : current,
    );
  return (
    <details className="rounded-md border border-primary-grey/60 p-2">
      <summary className="cursor-pointer truncate text-xs">
        {name} <span className="text-secondary-ink">· {label(token.type)}</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <PropertyField
              label="Token name"
              value={name}
              onCommit={(next) =>
                onChange((content) => renameDesignToken(content, name, next.trim()))
              }
            />
          </div>
          <button
            type="button"
            aria-label={`Remove token ${name}`}
            className="h-8 w-7 rounded text-secondary-ink hover:bg-primary-grey/25"
            onClick={() => onChange((content) => removeDesignToken(content, name))}
          >
            −
          </button>
        </div>
        <Choice
          label="Token source"
          value={"alias" in token ? "alias" : "value"}
          choices={[
            ["value", "Value"],
            ...(aliases.length ? [["alias", "Alias"] as [string, string]] : []),
          ]}
          onChange={(source) =>
            update((current) =>
              source === "value" ? current : { type: token.type, alias: aliases[0] },
            )
          }
        />
        {"alias" in token ? (
          <Choice
            label="Alias target"
            value={token.alias}
            choices={aliases.map((name) => [name, name])}
            onChange={(alias) => update(() => ({ type: token.type, alias }))}
          />
        ) : text ? (
          <>
            <FontPicker
              familyOnly
              selected={[textNode]}
              onPatch={(patch) => {
                const changes = typeof patch === "function" ? patch(textNode) : patch;
                update((current) =>
                  current.type === "typography" && "value" in current
                    ? {
                        ...current,
                        value: {
                          ...current.value,
                          ...Object.fromEntries(
                            Object.entries(changes.style ?? {}).filter(([key]) =>
                              (typographyProperties as readonly string[]).includes(key),
                            ),
                          ),
                        },
                      }
                    : current,
                );
              }}
            />
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["Font size", "fontSize", 16, 6, 300],
                  ["Font weight", "fontWeight", 400, 1, 1000],
                  ["Letter spacing", "letterSpacing", 0, -100, 100],
                  ["Paragraph spacing", "paragraphSpacing", 0, 0, 1000],
                ] as const
              ).map(([label, key, fallback, min, max]) => (
                <PropertyField
                  key={key}
                  label={label}
                  numeric
                  min={min}
                  max={max}
                  value={text[key] ?? fallback}
                  onCommit={(value) => textValue(key, Number(value))}
                />
              ))}
            </div>
            <Choice
              label="Line height unit"
              value={text.lineHeightMode ?? "percent"}
              choices={[
                ["auto", "Auto"],
                ["percent", "Percent"],
                ["px", "Pixels"],
              ]}
              onChange={(value) => textValue("lineHeightMode", value)}
            />
            {text.lineHeightMode !== "auto" && (
              <PropertyField
                label="Line height"
                numeric
                min={text.lineHeightMode === "px" ? 0.1 : 0.01}
                max={text.lineHeightMode === "px" ? 1200 : 20000}
                value={
                  text.lineHeightMode === "px"
                    ? (text.lineHeightPx ?? 22)
                    : (text.lineHeight ?? 1.35) * 100
                }
                onCommit={(value) =>
                  textValue(
                    text.lineHeightMode === "px" ? "lineHeightPx" : "lineHeight",
                    Number(value) / (text.lineHeightMode === "px" ? 1 : 100),
                  )
                }
              />
            )}
            <Choice
              label="Font style"
              value={text.fontStyle ?? "normal"}
              choices={[
                ["normal", "Normal"],
                ["italic", "Italic"],
              ]}
              onChange={(value) => textValue("fontStyle", value)}
            />
          </>
        ) : (
          <PropertyField
            label={token.type === "color" ? "Color" : "Value"}
            value={resolved.value as string | number}
            numeric={token.type !== "color"}
            onCommit={(value) =>
              update(
                (current) =>
                  ({
                    ...current,
                    value: token.type === "color" ? value : Number(value),
                  }) as DesignToken,
              )
            }
          />
        )}
      </div>
    </details>
  );
}
