import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { BrowserGlyph, Glyph, BrowserIconButton } from "./browser-controls";
import type { BrowserState } from "../../../../shared/contracts/browser";
export const previewViewports = {
  responsive: { label: "Fit pane", size: null },
  "1440x900": { label: "Desktop · 1440", size: { width: 1440, height: 900 } },
  "768x1024": { label: "Tablet · 768", size: { width: 768, height: 1024 } },
  "390x844": { label: "Mobile · 390", size: { width: 390, height: 844 } },
};
export type PreviewViewport = keyof typeof previewViewports;
export function BrowserTabs({
  state,
  disabled,
  creating,
  expanded,
  onExpand,
  onHide,
  onSelect,
  onClose,
  onNew,
  embedded = false,
}: {
  state: Pick<BrowserState, "tabs" | "activeTabId">;
  disabled: boolean;
  creating: boolean;
  expanded: boolean;
  onExpand?(): void;
  onHide?(): void;
  embedded?: boolean;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}) {
  return (
    <header className="browser-topline flex min-h-11 shrink-0 items-center justify-between gap-2 px-2 py-1.5">
      <div
        className="browser-tabs flex h-8 min-w-0 flex-[0_1_auto] items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        role="tablist"
        aria-label="Browser tabs"
      >
        {state.tabs.length === 0 && (
          <span className="browser-tab-placeholder flex items-center gap-[7px] rounded-md bg-hover-surface px-[9px] py-1.5 whitespace-nowrap text-ink">
            <BrowserGlyph size={14} />
            {embedded ? "Preview" : "Browser"}
          </span>
        )}
        {state.tabs.map((item) => (
          <div
            className={`browser-tab flex h-[31px] min-w-[100px] max-w-[210px] flex-[0_1_175px] items-center rounded-md border border-transparent text-secondary-ink ${item.id === state.activeTabId ? "is-active" : ""}`}
            key={item.id}
          >
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-[7px] border-0 bg-transparent pr-1.5 pl-[9px] text-left text-inherit"
              role="tab"
              aria-selected={item.id === state.activeTabId}
              tabIndex={item.id === state.activeTabId ? 0 : -1}
              title={item.url}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || disabled)
                  return;
                event.preventDefault();
                const index = state.tabs.findIndex((tab) => tab.id === item.id);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? state.tabs.length - 1
                      : (index + (event.key === "ArrowRight" ? 1 : state.tabs.length - 1)) %
                        state.tabs.length;
                const target = state.tabs[next];
                if (!target) return;
                onSelect(target.id);
                event.currentTarget
                  .closest("[role=tablist]")
                  ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
                  [next]?.focus();
              }}
              disabled={disabled}
            >
              <span className={item.loading ? "opacity-50" : ""}>
                <BrowserGlyph size={13} />
              </span>
              <span className="truncate">
                {item.title === "New tab" || item.url === "about:blank" ? "Preview" : item.title}
              </span>
            </button>
            <Button
              type="button"
              className="browser-tab-close mr-[3px] inline-flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border border-transparent bg-transparent p-0 text-secondary-ink disabled:cursor-default disabled:opacity-35 [&>svg]:size-3"
              aria-label={`Close ${item.title}`}
              disabled={disabled}
              onClick={() => onClose(item.id)}
            >
              <Glyph name="close" />
            </Button>
          </div>
        ))}
      </div>

      <BrowserIconButton
        type="button"
        className="browser-new-tab"
        aria-label="New preview"
        aria-busy={creating}
        title="New preview"
        disabled={disabled || creating || state.tabs.length >= 12}
        onClick={onNew}
      >
        <Glyph name="plus" />
      </BrowserIconButton>
      <div className="browser-window-actions ml-auto flex gap-0.5">
        {onExpand && (
          <BrowserIconButton
            type="button"
            title={expanded ? "Restore browser size" : "Expand browser"}
            aria-label={expanded ? "Restore browser size" : "Expand browser"}
            onClick={onExpand}
          >
            <Glyph name="expand" />
          </BrowserIconButton>
        )}
        {onHide && (
          <BrowserIconButton
            type="button"
            title="Hide browser"
            aria-label="Hide browser"
            onClick={onHide}
          >
            <Glyph name="close" />
          </BrowserIconButton>
        )}
      </div>
    </header>
  );
}

export function BrowserOptions({
  state,
  connected,
  machineLabel,
  viewport,
  onViewportChange,
  canCopy,
  consoleOpen,
  onFind,
  onCopy,
  onConsole,
  onDownloads,
}: {
  state: BrowserState;
  connected: boolean;
  machineLabel: string;
  viewport: PreviewViewport;
  onViewportChange(viewport: PreviewViewport): void;
  canCopy: boolean;
  consoleOpen: boolean;
  onFind(): void;
  onCopy(): void;
  onConsole(): void;
  onDownloads(): void;
}) {
  const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const canInput = connected && state.control === "you";
  const canNavigate = connected && (state.control === "you" || state.control === "available");
  return (
    <SelectMenu
      value={viewport}
      label="Preview options"
      size="sm"
      align="end"
      className="browser-options shrink-0"
      triggerClassName="browser-icon-button inline-flex size-7 shrink-0 items-center justify-center rounded-[5px] border border-transparent bg-transparent p-0 text-secondary-ink"
      triggerContent={<Glyph name="more" />}
      actionMenu
      menuHeader={
        <div className="browser-menu-context mb-1 flex flex-col gap-[5px] border-b border-border p-2 text-[11px] text-muted-ink">
          <span className="browser-host flex min-w-0 items-center gap-2 text-secondary-ink">
            <span
              className={`browser-connection-dot size-[5px] shrink-0 rounded-full bg-muted-ink ${connected ? "is-connected" : ""}`}
            />
            {machineLabel}
          </span>
          <span>
            {state.control === "you"
              ? "You have control"
              : state.control === "agent"
                ? "Agent is browsing"
                : state.control === "another-viewer"
                  ? "Another viewer has control"
                  : "Control available"}
          </span>
        </div>
      }
      options={[
        ...Object.entries(previewViewports).map(([value, preset]) => ({
          value,
          label: preset.label,
          disabled: !canInput || !tab,
          checked: value === viewport,
        })),
        { value: "find", label: "Find in page", disabled: !tab || !canNavigate },
        { value: "copy", label: "Copy selected text", disabled: !canCopy },
        {
          value: "console",
          label: consoleOpen ? "Hide console" : "Show console",
          disabled: !tab,
        },
        ...(state.downloads.length
          ? [{ value: "downloads", label: `Downloads · ${state.downloads.length}` }]
          : []),
      ]}
      onChange={(value) => {
        switch (value) {
          case "find":
            onFind();
            break;
          case "copy":
            onCopy();
            break;
          case "console":
            onConsole();
            break;
          case "downloads":
            onDownloads();
            break;
          case "responsive":
          case "1440x900":
          case "768x1024":
          case "390x844":
            onViewportChange(value);
            break;
        }
      }}
    />
  );
}
