import {
  codeControlClassName,
  codeMenuClassName,
  codeFavoriteClassName,
  codeScrollbarClassName,
} from "../../styles/code-ui";
import type { HarnessCatalog, ModelSelection } from "./harness-catalog";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useModelFavorites } from "./use-model-favorites";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { HarnessId } from "../../../../shared/contracts/desktop";
import { ComposerChevron, ComposerIcon } from "../composer/composer-icon";
import { ModelProviderIcon } from "./model-provider-icon";

const modelProviderClassName =
  "grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-muted-ink hover:enabled:bg-hover-surface hover:enabled:text-ink aria-pressed:bg-hover-surface aria-pressed:text-ink disabled:cursor-default disabled:opacity-30";

const modelMenuClassName = [
  codeMenuClassName,
  "model-picker-menu",
  "[&&]:w-[230px] [&&]:min-w-0 [&&]:overflow-hidden [&&]:p-0",
  "[&&_[data-slot=select-menu-label]]:text-sm",
  "[&_.select-menu-columns]:flex [&_.select-menu-columns]:h-(--model-list-height) [&_.select-menu-columns]:min-h-20",
  "[&_.select-menu-options]:min-w-0 [&_.select-menu-options]:flex-1 [&_.select-menu-options]:overflow-y-auto [&_.select-menu-options]:p-1 [&_.select-menu-options]:max-h-[205px]",
  "[&_.select-menu-option-row]:flex [&_.select-menu-option-row]:items-center [&_.select-menu-option-row]:rounded-md [&_.select-menu-option-row]:px-1",
  "[&_.select-menu-option-row:hover]:bg-hover-surface",
  "[&_.select-menu-option-row:focus-within]:bg-hover-surface",
  "[&&_[role=menuitemradio]]:min-w-0 [&&_[role=menuitemradio]]:flex-1 [&&_[role=menuitemradio]]:gap-[3px] [&&_[role=menuitemradio]]:bg-transparent [&&_[role=menuitemradio]]:px-1 [&&_[role=menuitemradio]]:py-[7px]",
  "[&_[data-slot=select-menu-content]]:min-w-0 [&_[data-slot=select-menu-content]]:flex-1",
  "[&_[data-slot=select-menu-text]]:min-w-0 [&_[data-slot=select-menu-text]]:flex-1",
  "[&_.select-menu-empty]:m-0 [&_.select-menu-empty]:p-2.5 [&_.select-menu-empty]:text-[11px] [&_.select-menu-empty]:text-muted-ink",
].join(" ");

export function ModelPicker({
  harness,
  modelId,
  catalogs,
  disabled,
  onChange,
  onHarnessChange,
  onRefresh,
}: {
  harness: HarnessId;
  modelId?: string;
  catalogs: HarnessCatalog[];
  disabled: boolean;
  onChange(selection: ModelSelection): void;
  onHarnessChange?: (harness: HarnessId) => void;
  onRefresh(): void;
}) {
  const favoriteToggle = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { favorites, toggleFavorite } = useModelFavorites();
  useLayoutEffect(() => {
    if (document.activeElement === document.body)
      favoriteToggle.current?.focus({ preventScroll: true });
  }, [favorites]);
  const available = catalogs.filter(
    (catalog) => onHarnessChange || catalog.connection.id === harness,
  );
  const models = available.flatMap(({ connection, details }) =>
    (details?.models ?? []).map((model) => ({
      ...model,
      harness: connection.id,
      value: `${connection.id}:${model.id}`,
    })),
  );
  const selected = models.find(
    (model) => model.harness === harness && model.id === (modelId ?? "default"),
  );
  const current = catalogs.find((catalog) => catalog.connection.id === harness);
  const search = query.trim().toLowerCase();
  const options = models.filter(
    (model) =>
      (favoritesOnly
        ? favorites.includes(model.value)
        : search
          ? true
          : model.harness === harness) &&
      `${model.name} ${model.id}`.toLowerCase().includes(search),
  );
  const largestList = Math.max(
    models.filter((model) => favorites.includes(model.value)).length,
    ...available.map((catalog) => catalog.details?.models.length ?? 0),
  );
  const menuStyle: CSSProperties & { "--model-list-height": string } = {
    "--model-list-height": `${Math.min(205, Math.max(80, largestList * 32 + 8))}px`,
  };
  return (
    <div className="contents" style={menuStyle}>
      <SelectMenu
        label="Model"
        placement="top"
        align="start"
        disabled={disabled}
        value={`${harness}:${selected?.id ?? modelId ?? ""}`}
        options={options.map((model) => ({ value: model.value, label: model.name }))}
        triggerClassName={`${codeControlClassName} model-trigger [&>span:not(.model-provider-icon)]:max-w-40 [&>span:not(.model-provider-icon)]:truncate`}
        triggerContent={
          <>
            <ModelProviderIcon harness={harness} />
            <span data-ph-private>{selected?.name ?? modelId ?? "Choose model"}</span>
            <ComposerChevron />
          </>
        }
        menuClassName={modelMenuClassName}
        optionsClassName={codeScrollbarClassName}
        menuHeader={
          <div className="model-search flex items-center gap-[7px] border-b border-border px-2 py-[7px] [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-ink">
            <ComposerIcon name="search" />
            <input
              data-select-search
              className="w-full min-w-0 border-0 bg-transparent text-xs text-ink outline-none"
              data-ph-private
              aria-label="Search models"
              placeholder="Search models…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className={codeFavoriteClassName}
              ref={favoriteToggle}
              aria-label="Show favorite models"
              aria-pressed={favoritesOnly}
              title="Favorites"
              onClick={() => setFavoritesOnly(!favoritesOnly)}
            >
              <ComposerIcon name="star" />
            </button>
          </div>
        }
        menuSidebar={
          <div
            className="model-providers flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border py-[5px]"
            aria-label="Model providers"
          >
            {available.map(({ connection }) => (
              <button
                type="button"
                key={connection.id}
                className={modelProviderClassName}
                disabled={connection.status !== "ready"}
                title={`${connection.name}${connection.status !== "ready" ? " · Not connected" : ""}`}
                aria-label={`${connection.name} models`}
                aria-pressed={!favoritesOnly && connection.id === harness}
                onClick={() => {
                  setFavoritesOnly(false);
                  setQuery("");
                  if (connection.id !== harness) onHarnessChange?.(connection.id);
                }}
              >
                <ModelProviderIcon harness={connection.id} />
              </button>
            ))}
            {(current?.error || !current?.details) && (
              <button
                type="button"
                className={modelProviderClassName}
                title={current?.error ?? "Load models"}
                aria-label="Refresh models"
                disabled={current?.loading}
                onClick={onRefresh}
              >
                ↻
              </button>
            )}
          </div>
        }
        optionAction={(option) => (
          <button
            type="button"
            className={codeFavoriteClassName}
            aria-label={`${favorites.includes(option.value) ? "Unfavorite" : "Favorite"} ${option.label}`}
            aria-pressed={favorites.includes(option.value)}
            onClick={(event) => {
              event.stopPropagation();
              toggleFavorite(option.value);
            }}
          >
            <ComposerIcon name="star" />
          </button>
        )}
        onChange={(value) => {
          const model = models.find((item) => item.value === value);
          if (model)
            onChange({
              harness: model.harness,
              settings: { model: model.id, effort: model.defaultEffort },
            });
        }}
      />
    </div>
  );
}
