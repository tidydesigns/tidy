import type { HarnessCatalog, ModelSelection } from "./harness-catalog";
import { useLayoutEffect, useRef, useState } from "react";
import { useModelFavorites } from "./use-model-favorites";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { HarnessId } from "../../shared/contracts";
import { ComposerChevron, ComposerIcon, ModelProviderIcon } from "./composer-icon";

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
  return (
    <SelectMenu
      label="Model"
      placement="top"
      align="start"
      disabled={disabled}
      value={`${harness}:${selected?.id ?? modelId ?? ""}`}
      options={options.map((model) => ({ value: model.value, label: model.name }))}
      triggerClassName="harness-setting-trigger model-trigger"
      triggerContent={
        <>
          <ModelProviderIcon harness={harness} />
          <span data-ph-private>{selected?.name ?? modelId ?? "Choose model"}</span>
          <ComposerChevron />
        </>
      }
      menuClassName="model-picker-menu compact-composer-menu"
      menuHeader={
        <div className="model-search">
          <ComposerIcon name="search" />
          <input
            data-select-search
            data-ph-private
            aria-label="Search models"
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="model-star"
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
        <div className="model-providers" aria-label="Model providers">
          {available.map(({ connection }) => (
            <button
              type="button"
              key={connection.id}
              disabled={connection.status !== "ready"}
              title={`${connection.name}${connection.status !== "ready" ? " · Not connected" : ""}`}
              aria-label={`${connection.id === "codex" ? "OpenAI" : "Anthropic"} models`}
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
          className="model-star"
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
  );
}
