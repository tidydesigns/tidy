"use client";

import { memo, useCallback, useRef, useState, type RefObject } from "react";
import { type DesignDocument } from "../design/document";
import {
  resolvedDesignTokens,
  tokenTypeSchema,
  type DesignToken,
} from "../design/design-tokens";
import {
  availableTokenName,
  putDesignToken,
  tokenDefaults,
  tokenNameError,
} from "../design/token-catalog";
import { SelectMenu } from "../components/ui/select-menu";
import { DesignTokenEditor } from "./design-token-editor";
import { TokenEditorPopover } from "./token-editor-popover";
import { removeDesignToken } from "../design/tokens";

const groups = [
  ["color", "Color"],
  ["radius", "Radius"],
  ["spacing", "Spacing"],
  ["dimension", "Dimensions"],
  ["number", "Numbers"],
  ["typography", "Text styles"],
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
    <svg
      className="h-5 w-5 shrink-0 text-secondary-ink"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {token.type === "radius" ? (
        <path d="M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4m0 6v4a1 1 0 0 1-1 1h-4m-6 0H5a1 1 0 0 1-1-1v-4" />
      ) : token.type === "spacing" ? (
        <path d="M4 4v16m16-16v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3" />
      ) : token.type === "dimension" ? (
        <path d="M4 9V4h5m6 16h5v-5M4 4l16 16M9 4H4v5m11 11h5v-5" />
      ) : token.type === "number" ? (
        <path d="m10 4-4 16M18 4l-4 16M4 9h16M3 15h16" />
      ) : (
        <path d="M4 6h16M12 6v14M8 20h8M4 9V6m16 3V6" />
      )}
    </svg>
  );
}

// Only the previous and next active rows need to render when switching editors.
const TokenRow = memo(function TokenRow({
  name,
  token,
  alias,
  active,
  anchor,
  onSelect,
}: {
  name: string;
  token: DesignToken;
  alias: string | undefined;
  active: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  onSelect: (name: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        aria-label={`Edit token ${name}`}
        data-token-name={name}
        ref={active ? anchor : undefined}
        aria-haspopup="dialog"
        aria-expanded={active}
        onClick={() => onSelect(name)}
        className={`flex min-h-9 w-full items-center gap-2.5 rounded-md py-1.5 pr-3 pl-6 text-left text-[13px] ${active ? "bg-primary-grey/25" : "hover:bg-primary-grey/15"} ${focusClass}`}
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
    </div>
  );
});

export function TokenPanel({
  document,
  readOnly = false,
  onChange,
}: {
  document: DesignDocument;
  readOnly?: boolean;
  onChange: (transform: (content: DesignDocument) => DesignDocument) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [active, setActive] = useState<string>();
  const anchor = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<DesignToken["type"]>>(new Set());
  const tokens = resolvedDesignTokens(document);
  const atLimit = tokens.size >= 1000;
  const activeToken = active ? tokens.get(active) : undefined;
  const search = query.trim().toLowerCase();
  const matches = [...tokens].filter(([name]) => name.toLowerCase().includes(search));
  const selectToken = useCallback((name: string) => {
    setActive((current) => (current === name ? undefined : name));
  }, []);
  const add = (value: string) => {
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
        if (
          event.key === "Escape" &&
          !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
        ) {
          setActive(undefined);
          event.stopPropagation();
        }
      }}
    >
      <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-3 border-b border-primary-grey/50 bg-surface px-4 py-3">
        <div className="flex h-7 items-center gap-1">
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
      </div>
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
            className="group/token-group mb-4"
          >
            <summary
              className={`flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden ${focusClass}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3 w-3 text-secondary-ink group-open/token-group:rotate-90"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="m6 4 4 4-4 4" />
              </svg>
              {title}
            </summary>
            <div className="mt-1">
              {entries.map(([name, token]) => {
                const definition = document.designTokens?.[name] ?? token;
                const alias = "alias" in definition ? definition.alias : undefined;
                return (
                  <TokenRow
                    key={name}
                    name={name}
                    token={token}
                    alias={alias}
                    active={active === name}
                    anchor={anchor}
                    onSelect={selectToken}
                  />
                );
              })}
            </div>
          </details>
        );
      })}
      {active && activeToken && (
        <TokenEditorPopover
          anchor={anchor}
          name={active}
          title={typeLabel(activeToken.type)}
          readOnly={readOnly}
          onRemove={() => onChange((content) => removeDesignToken(content, active))}
          onClose={() => setActive(undefined)}
        >
          <DesignTokenEditor
            document={document}
            name={active}
            token={document.designTokens?.[active] ?? activeToken}
            onChange={onChange}
            onRename={setActive}
          />
        </TokenEditorPopover>
      )}
      {!matches.length && (
        <p className="py-2 text-xs text-secondary-ink">
          {tokens.size ? "No matching tokens." : "No tokens yet."}
        </p>
      )}
    </div>
  );
}
