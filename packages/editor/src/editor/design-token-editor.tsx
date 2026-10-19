"use client";
import { buildDrawnNode, type DesignDocument } from "../design/document";
import {
  resolvedDesignTokens,
  typographyProperties,
  type DesignToken,
} from "../design/design-tokens";
import { renameDesignToken } from "../design/tokens";
import { Choice, ColorField, applyColor } from "./inspector-controls";
import { PropertyField } from "./property-field";
import { FontPicker } from "./font-picker";
import { putDesignToken, tokenNameError } from "../design/token-catalog";

type Change = (transform: (document: DesignDocument) => DesignDocument) => void;
const numericBounds = {
  radius: [0, 5000],
  spacing: [-1000, 1000],
  dimension: [0, 5000],
  number: [-100000, 100000],
} as const;
export function DesignTokenEditor({
  document,
  name,
  token,
  onChange,
  onRename,
}: {
  document: DesignDocument;
  name: string;
  token: DesignToken;
  onChange: Change;
  onRename: (name: string) => void;
}) {
  const resolved = resolvedDesignTokens(document).get(name);
  if (!resolved || !("value" in resolved)) return null;
  const update = (change: (current: DesignToken) => DesignToken) =>
    onChange((content) => {
      const current = resolvedDesignTokens(content).get(name);
      return current ? putDesignToken(content, name, change(current)) : content;
    });
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
  const bounds =
    resolved.type === "typography" || resolved.type === "color"
      ? undefined
      : numericBounds[resolved.type];
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
    <div className="space-y-3">
      {resolved.type === "color" && (
        <div
          className="token-color-preview mb-4 h-40 overflow-hidden rounded-lg border border-primary-grey/40"
          role="img"
          aria-label={`Color preview ${resolved.value}`}
        >
          <div className="h-full w-full" style={{ backgroundColor: resolved.value }} />
        </div>
      )}
      <PropertyField
        replayLabel
        layout="inline"
        label="Name"
        value={name}
        validate={(next) => tokenNameError(document, next.trim(), name)}
        onCommit={(next) => {
          const trimmed = next.trim();
          onChange((content) => renameDesignToken(content, name, trimmed));
          onRename(trimmed);
        }}
      />
      {!("alias" in token) &&
        (text ? (
          <>
            <FontPicker
              replayLabel
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
                  replayLabel
                  key={key}
                  label={label}
                  numeric
                  integer={key === "fontWeight"}
                  required={key === "fontSize" || key === "fontWeight"}
                  min={min}
                  max={max}
                  value={text[key] ?? fallback}
                  validate={
                    key === "fontSize" || key === "fontWeight"
                      ? (value) =>
                          value === ""
                            ? `Enter a ${label.toLowerCase()} from ${min} to ${max}.`
                            : undefined
                      : undefined
                  }
                  onCommit={(value) => textValue(key, Number(value))}
                />
              ))}
            </div>
            <Choice
              replayOptions
              replayLabel
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
                replayLabel
                label="Line height"
                numeric
                required
                min={text.lineHeightMode === "px" ? 0.1 : 0.01}
                max={text.lineHeightMode === "px" ? 1200 : 20000}
                value={
                  text.lineHeightMode === "px"
                    ? (text.lineHeightPx ?? 22)
                    : (text.lineHeight ?? 1.35) * 100
                }
                validate={(value) =>
                  value === ""
                    ? text.lineHeightMode === "px"
                      ? "Enter a line height in pixels."
                      : "Enter a line height as a percentage."
                    : undefined
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
              replayOptions
              replayLabel
              label="Font style"
              value={text.fontStyle ?? "normal"}
              choices={[
                ["normal", "Normal"],
                ["italic", "Italic"],
              ]}
              onChange={(value) => textValue("fontStyle", value)}
            />
          </>
        ) : resolved.type === "color" ? (
          <ColorField
            compact
            replayLabel
            label="Color"
            nodes={[textNode]}
            get={() => resolved.value}
            onChange={(value) =>
              update((current) =>
                current.type === "color" && "value" in current
                  ? { type: "color", value: applyColor(value, current.value) }
                  : current,
              )
            }
          />
        ) : typeof resolved.value === "number" ? (
          <PropertyField
            replayLabel
            label="Value"
            layout="inline"
            value={resolved.value}
            numeric
            required
            min={bounds?.[0]}
            max={bounds?.[1]}
            onCommit={(value) =>
              update((current) => {
                if (
                  !("value" in current) ||
                  current.type === "color" ||
                  current.type === "typography"
                )
                  return current;
                return { ...current, value: Number(value) };
              })
            }
          />
        ) : null)}
      {aliases.length > 0 && (
        <details className="text-xs" open={"alias" in token}>
          <summary className="cursor-pointer py-1 text-secondary-ink">Reference</summary>
          <div className="mt-2 space-y-2">
            <Choice
              replayOptions
              replayLabel
              label="Token source"
              value={"alias" in token ? "alias" : "value"}
              choices={[
                ["value", "Value"],
                ["alias", "Alias"],
              ]}
              onChange={(source) =>
                update((current) =>
                  source === "value" || !aliases[0]
                    ? current
                    : { type: token.type, alias: aliases[0] },
                )
              }
            />
            {"alias" in token ? (
              <Choice
                replayLabel
                label="Alias target"
                value={token.alias}
                choices={aliases.map((name) => [name, name])}
                onChange={(alias) => update(() => ({ type: token.type, alias }))}
              />
            ) : null}
          </div>
        </details>
      )}
    </div>
  );
}
