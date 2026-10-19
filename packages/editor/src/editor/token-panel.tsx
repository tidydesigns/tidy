"use client";

import { useId, useMemo, useState } from "react";
import { type DesignDocument, nodePageId } from "../design/document";
import {
  resolvedDesignTokens,
  tokenTypeSchema,
  type DesignToken,
} from "../design/design-tokens";
import { componentSubtreeIds } from "../design/component-variants";
import {
  availableTokenName,
  createAndBindColor,
  putDesignToken,
  tokenDefaults,
  tokenNameError,
  unboundPageColors,
} from "../design/token-catalog";
import { SelectMenu } from "../components/ui/select-menu";
import { DesignTokenEditor } from "./design-token-editor";

const groups = [
  ["color", "Color", ""],
  ["radius", "Radius", "▢"],
  ["spacing", "Spacing", "↔"],
  ["dimension", "Dimensions", "↗"],
  ["number", "Numbers", "#"],
  ["typography", "Text styles", "Aa"],
] as const;
const typeLabel = (type: DesignToken["type"]) =>
  groups.find(([kind]) => kind === type)?.[1] ?? type;
const focusClass = "focus-visible:outline-2 focus-visible:outline-primary-orange";

function TokenSwatch({ token }: { token: DesignToken }) {
  return token.type === "color" && "value" in token ? (
    <span
      className="h-5 w-5 shrink-0 rounded border border-primary-grey/70"
      style={{ backgroundColor: token.value }}
    />
  ) : (
    <span className="w-5 shrink-0 text-center text-secondary-ink" aria-hidden="true">
      {groups.find(([kind]) => kind === token.type)?.[2]}
    </span>
  );
}

export function TokenPanel({
  document,
  pageId,
  selectedIds,
  readOnly = false,
  onChange,
}: {
  document: DesignDocument;
  pageId: string;
  selectedIds: string[];
  readOnly?: boolean;
  onChange: (transform: (content: DesignDocument) => DesignDocument) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [active, setActive] = useState<string>();
  const [discover, setDiscover] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<DesignToken["type"]>>(new Set());
  const [scope, setScope] = useState<"page" | "selection">("page");
  const tokens = resolvedDesignTokens(document);
  const atLimit = tokens.size >= 1000;
  const nodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (scope === "selection") {
      for (const id of selectedIds)
        for (const child of componentSubtreeIds(document.nodes, id)) ids.add(child);
    } else {
      for (const node of document.nodes) if (nodePageId(node) === pageId) ids.add(node.id);
    }
    return ids;
  }, [document.nodes, pageId, scope, selectedIds]);
  const colors = useMemo(() => unboundPageColors(document, nodeIds), [document, nodeIds]);
  const matches = [...tokens].filter(([name]) =>
    name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const add = (value: string) => {
    if (value === "discover") {
      setScope(selectedIds.length ? "selection" : "page");
      setDiscover(true);
      return;
    }
    const type = tokenTypeSchema.parse(value);
    const name = availableTokenName(document, type);
    onChange((content) =>
      tokenNameError(content, name) ? content : putDesignToken(content, name, tokenDefaults[type]),
    );
    setCollapsed((current) => new Set([...current].filter((entry) => entry !== type)));
    setSearchOpen(false);
    setQuery("");
    setActive(name);
  };
  return (
    <div
      className="p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setActive(undefined);
          setDiscover(false);
          event.stopPropagation();
        }
      }}
    >
      <div className="mb-3 flex h-7 items-center gap-1">
        <span className="flex-1 text-xs text-secondary-ink" aria-live="polite">
          {tokens.size} {tokens.size === 1 ? "token" : "tokens"}
        </span>
        <button
          type="button"
          aria-label="Search tokens"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen(!searchOpen);
            setQuery("");
          }}
          className={`h-7 w-7 rounded text-secondary-ink hover:bg-primary-grey/20 ${focusClass}`}
        >
          <svg
            viewBox="0 0 20 20"
            className="mx-auto h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
        </button>
        {!readOnly && (
          <SelectMenu
            actionMenu
            replayLabel
            replayOptions
            label="Add token"
            value=""
            triggerContent={
              <span aria-hidden="true" className="text-xl font-light">
                +
              </span>
            }
            triggerClassName={`flex h-7 w-7 items-center justify-center rounded text-secondary-ink hover:bg-primary-grey/20 ${focusClass}`}
            options={[
              ...tokenTypeSchema.options.map((type) => ({
                value: type,
                label: typeLabel(type),
                disabled: atLimit,
              })),
              { value: "discover", label: "From design…", disabled: atLimit },
            ]}
            onChange={add}
          />
        )}
      </div>
      {searchOpen && (
        <input
          autoFocus
          aria-label="Find tokens"
          type="search"
          placeholder="Find tokens…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`mb-3 h-8 w-full rounded-md border border-control-border bg-surface px-2 text-xs ${focusClass}`}
        />
      )}
      {atLimit && !readOnly && (
        <p className="mb-3 text-xs text-secondary-ink">Token limit reached (1,000).</p>
      )}
      {discover && !readOnly && (
        <section
          aria-label="Colors from design"
          className="mb-4 border-b border-primary-grey/60 pb-3"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium">Colors from design</span>
            <button
              type="button"
              aria-label="Close colors from design"
              className={`rounded px-1 text-secondary-ink ${focusClass}`}
              onClick={() => setDiscover(false)}
            >
              ×
            </button>
          </div>
          <SelectMenu
            replayLabel
            replayOptions
            label="Color source"
            value={scope}
            options={[
              { value: "page", label: "Current page" },
              {
                value: "selection",
                label: "Selection and children",
                disabled: !selectedIds.length,
              },
            ]}
            onChange={(value) => setScope(value === "selection" ? "selection" : "page")}
          />
          <p className="my-2 text-[10px] leading-relaxed text-secondary-ink">
            Unlinked fills, strokes and text. Hidden and locked layers are excluded.
          </p>
          <div className="max-h-72 space-y-1 overflow-y-auto overscroll-contain">
            {colors.map(({ color, count }) => (
              <ColorCandidate
                key={`${scope}-${color}`}
                document={document}
                color={color}
                count={count}
                disabled={atLimit}
                onCreate={(name) =>
                  onChange((content) =>
                    createAndBindColor({ document: content, nodeIds, color, name }),
                  )
                }
              />
            ))}
          </div>
          {!colors.length && (
            <p className="py-2 text-xs text-secondary-ink">
              {scope === "selection" && !selectedIds.length
                ? "Select layers to find colors."
                : "No unlinked colors in this source."}
            </p>
          )}
        </section>
      )}
      {groups.map(([type, title]) => {
        const entries = matches.filter(([, token]) => token.type === type);
        if (!entries.length) return null;
        return (
          <details
            key={type}
            open={!collapsed.has(type)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setCollapsed((current) => {
                if (current.has(type) === !open) return current;
                const next = new Set(current);
                if (open) next.delete(type);
                else next.add(type);
                return next;
              });
            }}
            className="mb-3"
          >
            <summary className={`cursor-pointer rounded py-1 text-xs font-medium ${focusClass}`}>
              {title}
            </summary>
            <div className="mt-1 space-y-0.5">
              {entries.map(([name, token]) => {
                const definition = document.designTokens?.[name] ?? token;
                const alias = "alias" in definition ? definition.alias : undefined;
                return (
                  <div key={name}>
                    <button
                      type="button"
                      aria-label={`Edit token ${name}`}
                      aria-expanded={active === name}
                      onClick={() => setActive(active === name ? undefined : name)}
                      className={`flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs ${active === name ? "bg-primary-grey/25" : "hover:bg-primary-grey/15"} ${focusClass}`}
                      title={alias ? `${name} → ${alias}` : name}
                    >
                      <TokenSwatch token={token} />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="max-w-16 truncate text-[10px] text-secondary-ink">
                        {alias
                          ? `↳ ${alias}`
                          : "value" in token && typeof token.value === "number"
                            ? token.value
                            : ""}
                      </span>
                    </button>
                    {active === name && (
                      <fieldset
                        disabled={readOnly}
                        className="my-2 max-h-96 min-w-0 overflow-y-auto overscroll-contain"
                      >
                        <DesignTokenEditor
                          document={document}
                          name={name}
                          token={definition}
                          onChange={onChange}
                          onRename={setActive}
                        />
                      </fieldset>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
      {!matches.length && (
        <p className="py-2 text-xs text-secondary-ink">
          {tokens.size ? "No matching tokens." : "No tokens yet."}
        </p>
      )}
    </div>
  );
}

function ColorCandidate({
  document,
  color,
  count,
  disabled,
  onCreate,
}: {
  document: DesignDocument;
  color: string;
  count: number;
  disabled: boolean;
  onCreate: (name: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => availableTokenName(document, `color-${color.slice(1)}`));
  const error = tokenNameError(document, name);
  return (
    <div className="rounded border border-primary-grey/50">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Create token from ${color}`}
        onClick={() => setOpen(!open)}
        className={`flex min-h-9 w-full items-center gap-2 px-2 text-left text-xs hover:bg-primary-grey/15 ${focusClass}`}
      >
        <TokenSwatch token={{ type: "color", value: color }} />
        <span className="flex-1">{color}</span>
        <span className="text-[10px] text-secondary-ink">
          {count} {count === 1 ? "layer" : "layers"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 p-2 pt-0">
          <div className="text-[10px] text-secondary-ink">
            <label htmlFor={id}>New token name</label>
            <input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${id}-error` : undefined}
              className={`mt-1 h-8 w-full rounded-md border border-control-border bg-surface px-2 text-xs text-primary-black ${focusClass}`}
            />
            {error && (
              <p id={`${id}-error`} role="alert" className="mt-1 text-danger">
                {error}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={disabled || Boolean(error)}
            onClick={() => onCreate(name)}
            className={`w-full rounded-md bg-primary-black px-2 py-2 text-xs text-surface disabled:opacity-40 ${focusClass}`}
          >
            Create and link {count} {count === 1 ? "layer" : "layers"}
          </button>
        </div>
      )}
    </div>
  );
}
