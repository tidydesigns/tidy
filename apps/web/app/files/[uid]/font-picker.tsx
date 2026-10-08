"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignNode, DesignNodeChanges } from "@/lib/design/document";
import {
  closestFontStyle,
  fontFamilies,
  fontStyleLabel,
  systemFonts,
  type FontFamily,
} from "@/lib/design/fonts/font-utils";
import { loadedWebFonts, loadFontCatalog } from "@/lib/design/fonts/catalog-loader";
import { fontRegistry, installedFont } from "@/lib/design/fonts/runtime";
import { useFontRegistry } from "@/lib/design/fonts/use-document-fonts";
import { PropertyField } from "./property-field";
import { SelectMenu } from "@/components/ui/select-menu";
const control =
  "h-8 w-full rounded-md border border-primary-grey/70 bg-surface px-2 text-xs outline-none focus-visible:border-primary-orange";
type Patch = DesignNodeChanges | ((node: DesignNode) => DesignNodeChanges);

function FontOption({
  font,
  id,
  active,
  selected,
  onSelect,
  onHover,
}: {
  font: FontFamily;
  id: string;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!row.current || font.source === "system") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        const style = closestFontStyle(font, 400, false);
        void fontRegistry.load(
          font.family,
          style.weight,
          style.italic,
          font.sample ?? "Aa",
          font.source,
          style.face,
        );
        observer.disconnect();
      }
    });
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [font]);
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={row}
      id={id}
      type="button"
      role="option"
      disabled={font.source === "local" && !font.metadataReady}
      aria-label={`${font.family}${font.source === "local" ? " Local" : ""}`}
      aria-selected={selected}
      tabIndex={-1}
      onPointerMove={onHover}
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-xs ${active ? "bg-primary-grey/35" : "hover:bg-primary-grey/15"}`}
    >
      <span className="truncate">
        {font.family}
        {font.source === "local" && (
          <span className="ml-2 text-[10px] text-secondary-ink">Local</span>
        )}
      </span>
      <span
        aria-hidden="true"
        style={{
          fontFamily: JSON.stringify(closestFontStyle(font, 400, false).face ?? font.family),
        }}
        className="text-lg"
      >
        {font.sample ?? "Aa"}
      </span>
    </button>
  );
}

export function FontPicker({
  selected,
  onPatch,
  onChoose,
  familyOnly = false,
  label = "Font family",
}: {
  selected: DesignNode[];
  onPatch: (patch: Patch) => void;
  onChoose?: (font: FontFamily) => void;
  familyOnly?: boolean;
  label?: string;
}) {
  const registry = useFontRegistry(),
    id = useId();
  const [webFonts, setWebFonts] = useState(loadedWebFonts);
  useEffect(() => {
    let active = true;
    void loadFontCatalog().then((catalog) => {
      if (active) setWebFonts(catalog.webFonts);
    });
    return () => {
      active = false;
    };
  }, []);
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const [limit, setLimit] = useState(60);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [localBusy, setLocalBusy] = useState(false),
    [error, setError] = useState("");
  const first = selected[0],
    value = first.style.fontFamily ?? "system-ui";
  const family = selected.every((node) => (node.style.fontFamily ?? "system-ui") === value)
    ? fontFamilies(value)[0]
    : undefined;
  const weight = selected.every(
    (node) => (node.style.fontWeight ?? 400) === (first.style.fontWeight ?? 400),
  )
    ? (first.style.fontWeight ?? 400)
    : undefined;
  const italic = selected.every(
    (node) => (node.style.fontStyle === "italic") === (first.style.fontStyle === "italic"),
  )
    ? first.style.fontStyle === "italic"
    : undefined;
  const selectedFonts = selected.map((node) =>
    registry.font(fontFamilies(node.style.fontFamily ?? "system-ui")[0], node.style.fontSource),
  );
  const font = selectedFonts.every((font) => font === selectedFonts[0])
    ? selectedFonts[0]
    : undefined;
  const commonFace = selected.every((node) => node.style.fontFace === first.style.fontFace);
  const styleValue =
    weight !== undefined && italic !== undefined && commonFace
      ? JSON.stringify([weight, Number(italic), first.style.fontFace ?? null])
      : "";
  const styleOptions = selectedFonts.some((font) => font?.source === "local" && !font.metadataReady)
    ? []
    : (font?.styles ??
      selectedFonts[0]?.styles.filter((style) =>
        selectedFonts.every((font) =>
          font?.styles.some(
            (candidate) => candidate.weight === style.weight && candidate.italic === style.italic,
          ),
        ),
      ) ??
      []);
  const validStyle = Boolean(
    font &&
    weight !== undefined &&
    italic !== undefined &&
    (font.styles.some(
      (style) =>
        style.weight === weight &&
        style.italic === italic &&
        (font.source !== "local" || style.face === first.style.fontFace),
    ) ||
      (font.weightRange &&
        weight >= font.weightRange[0] &&
        weight <= font.weightRange[1] &&
        font.styles.some((style) => style.italic === italic))),
  );
  const status = registry.getStatus(
    value,
    first.style.fontWeight ?? 400,
    first.style.fontStyle === "italic",
    first.style.fontSource,
    first.style.fontFace,
  );
  const availableSystem = useMemo(
    () => (open ? systemFonts.filter((font) => installedFont(font.family)) : systemFonts),
    [open],
  );
  const localFonts = registry.localFonts();
  const options = useMemo(() => {
    const unique = [
      ...new Map(
        [...webFonts, ...availableSystem, ...localFonts].map((font) => [
          `${font.family.toLowerCase()}:${font.source}`,
          font,
        ]),
      ).values(),
    ];
    return unique
      .filter((font) => font.family.toLowerCase().includes(query.toLowerCase().trim()))
      .sort((a, b) => {
        const aCurrent = fontFamilies(value).includes(a.family),
          bCurrent = fontFamilies(value).includes(b.family);
        return Number(bCurrent) - Number(aCurrent) || a.family.localeCompare(b.family);
      });
  }, [webFonts, localFonts, availableSystem, query, value]);
  const visible = options.slice(0, limit);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    search.current?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const bounds = trigger.current.getBoundingClientRect(),
      size = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - size.width - 8, bounds.left)),
      top:
        bounds.bottom + size.height + 4 > window.innerHeight
          ? Math.max(8, bounds.top - size.height - 4)
          : bounds.bottom + 4,
    });
  }, [open, visible.length, error]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const reposition = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);
  const apply = (font: FontFamily) => {
    if (font.source === "local" && !font.metadataReady) return;
    if (onChoose) {
      onChoose(font);
      close();
      return;
    }
    onPatch((node) => {
      const style = closestFontStyle(
        font,
        node.style.fontWeight ?? 400,
        node.style.fontStyle === "italic",
      );
      return {
        style: {
          fontFamily: font.family,
          fontSource: font.source,
          fontFace: style.face,
          fontWeight: style.weight,
          fontStyle: style.italic ? "italic" : "normal",
        },
      };
    });
    close();
  };
  const failed = selected.filter((node) => {
    const status = registry.getStatus(
      node.style.fontFamily ?? "system-ui",
      node.style.fontWeight ?? 400,
      node.style.fontStyle === "italic",
      node.style.fontSource,
      node.style.fontFace,
    );
    return status === "missing" || status === "error";
  });
  const retryable = failed.filter(
    (node) =>
      registry.getStatus(
        node.style.fontFamily ?? "system-ui",
        node.style.fontWeight ?? 400,
        node.style.fontStyle === "italic",
        node.style.fontSource,
        node.style.fontFace,
      ) === "error",
  );
  const missing = failed.some((node) => !retryable.includes(node));
  return (
    <div className="space-y-2">
      <label className="block text-[10px] text-secondary-ink">
        {familyOnly ? "Replace throughout file" : label}
        <button
          ref={trigger}
          type="button"
          role="combobox"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={() => {
            setQuery("");
            setActive(0);
            setLimit(60);
            setError("");
            setOpen((value) => !value);
          }}
          className={`${control} mt-1 flex items-center justify-between text-left text-primary-black`}
        >
          <span className="truncate">
            {familyOnly ? "Choose replacement…" : (family ?? "Mixed")}
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
      </label>
      {!familyOnly && (
        <>
          {styleOptions.length > 0 && (
            <div className="text-[10px] text-secondary-ink">
              <span id={`${id}-style-label`}>Font style</span>
              <SelectMenu
                label="Font style"
                labelledBy={`${id}-style-label`}
                size="sm"
                value={styleValue}
                className="mt-1"
                onChange={(value) => {
                  const [weight, italic, face] = JSON.parse(value) as [
                    number,
                    number,
                    string | null,
                  ];
                  onPatch((node) => {
                    const target = registry.font(
                      fontFamilies(node.style.fontFamily ?? "system-ui")[0],
                      node.style.fontSource,
                    );
                    const style = target
                      ? closestFontStyle(target, weight, Boolean(italic))
                      : { weight, italic: Boolean(italic), face: undefined };
                    return {
                      style: {
                        fontWeight: weight,
                        fontStyle: italic ? "italic" : "normal",
                        fontFace: font ? (face ?? undefined) : style.face,
                      },
                    };
                  });
                }}
                options={[
                  ...(!styleValue ? [{ value: "", label: "Mixed", disabled: true }] : []),
                  ...(styleValue &&
                  !styleOptions.some(
                    (style) =>
                      JSON.stringify([style.weight, Number(style.italic), style.face ?? null]) ===
                      styleValue,
                  )
                    ? [
                        {
                          value: styleValue,
                          label: `${fontStyleLabel(weight!, italic!)}${validStyle ? "" : " · unavailable style"}`,
                        },
                      ]
                    : []),
                  ...styleOptions.map((style) => ({
                    value: JSON.stringify([style.weight, Number(style.italic), style.face ?? null]),
                    label: style.label,
                  })),
                ]}
              />
            </div>
          )}
          {font?.weightRange && (
            <PropertyField
              label="Font weight"
              value={weight}
              numeric
              integer
              min={font.weightRange[0]}
              max={font.weightRange[1]}
              onCommit={(value) => {
                if (value) onPatch({ style: { fontWeight: Number(value) } });
              }}
            />
          )}
          {status === "loading" && (
            <p role="status" className="text-[10px] text-secondary-ink">
              Loading font…
            </p>
          )}
          {failed.length > 0 && (
            <div
              role="status"
              className="flex items-center justify-between gap-2 text-[10px] text-secondary-ink"
            >
              <span>
                {missing
                  ? `${family ?? "A selected font"} is unavailable. Using a fallback.`
                  : "A selected font could not load."}
              </span>
              {retryable.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    for (const node of retryable)
                      void registry.retry(
                        node.style.fontFamily ?? "system-ui",
                        node.style.fontWeight ?? 400,
                        node.style.fontStyle === "italic",
                        node.text ?? "Aa",
                        node.style.fontSource,
                        node.style.fontFace,
                      );
                  }}
                  className="shrink-0 underline"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {font && (font.source !== "local" || font.metadataReady) && !validStyle && styleValue && (
            <p role="status" className="text-[10px] text-secondary-ink">
              Choose an available style for this font.
            </p>
          )}
        </>
      )}
      {open &&
        createPortal(
          <div
            ref={popup}
            className="fixed z-50 flex w-[280px] flex-col rounded-lg border border-primary-grey/80 bg-surface p-1 shadow-lg"
            style={{ ...position, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)" }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            <input
              ref={search}
              aria-label="Search fonts"
              aria-controls={`${id}-list`}
              aria-activedescendant={visible[active] ? `${id}-${active}` : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                setLimit(60);
              }}
              onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                  event.preventDefault();
                  const next = Math.max(
                    0,
                    Math.min(options.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)),
                  );
                  if (next >= limit) setLimit((value) => value + 60);
                  setActive(next);
                }
                if (event.key === "Enter" && visible[active]) {
                  event.preventDefault();
                  apply(visible[active]);
                }
              }}
              placeholder="Search fonts"
              className="h-9 w-full shrink-0 border-b border-primary-grey/60 px-2 text-xs outline-none"
            />
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label="Fonts"
              onScroll={(event) => {
                const element = event.currentTarget;
                if (
                  element.scrollTop + element.clientHeight >= element.scrollHeight - 40 &&
                  limit < options.length
                )
                  setLimit((value) => value + 60);
              }}
              className="max-h-[280px] overflow-y-auto py-1"
            >
              {visible.map((option, index) => (
                <FontOption
                  key={`${option.family}:${option.source}`}
                  id={`${id}-${index}`}
                  font={option}
                  active={index === active}
                  selected={option.family === family && option.source === font?.source}
                  onHover={() => setActive(index)}
                  onSelect={() => apply(option)}
                />
              ))}
            </div>
            {registry.supportsLocal() && (
              <button
                type="button"
                disabled={localBusy}
                onClick={async () => {
                  setLocalBusy(true);
                  setError("");
                  try {
                    await registry.connectLocal();
                  } catch {
                    setError("Local fonts were not enabled. You can try again.");
                  } finally {
                    setLocalBusy(false);
                  }
                }}
                className="shrink-0 border-t border-primary-grey/60 px-2 py-2 text-left text-xs hover:bg-primary-grey/15 disabled:opacity-40"
              >
                {localBusy ? "Reading local fonts…" : "Use local fonts"}
              </button>
            )}
            {!registry.supportsLocal() && (
              <p className="px-2 py-2 text-[10px] text-secondary-ink">
                This browser cannot list local fonts. Choose a web font, or open this file in a
                browser with local font access.
              </p>
            )}
            {error && (
              <p role="status" className="px-2 py-1 text-[10px] text-secondary-ink">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
