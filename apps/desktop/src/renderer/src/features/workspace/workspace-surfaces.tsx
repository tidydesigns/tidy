import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { z } from "zod";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { useMediaQuery, usePanelDialog } from "../../components/panel-dialog";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import { lazyView } from "../../components/lazy-view";
import { useSessionState } from "../../app/session-state";
import { BrowserGlyph, Glyph } from "../browser/browser-controls";
import { RepositoryIcon } from "../repository/repository-icons";
import type { RepositoryBrowser as RepositoryComponent } from "../repository/repository-browser";
import type { RepositoryAPI } from "../repository/use-repository-files";
import type { BrowserWorkspace as BrowserComponent } from "../browser/browser-workspace";
import type { MobileWorkspace as MobileComponent } from "../mobile/mobile-workspace";
import { DeviceGlyph } from "../mobile/device-glyph";

const RepositoryBrowser = lazyView<ComponentProps<typeof RepositoryComponent>>(
  () =>
    import("../repository/repository-browser").then((module) => ({
      default: module.RepositoryBrowser,
    })),
  { label: "repository files" },
);
const BrowserWorkspace = lazyView<ComponentProps<typeof BrowserComponent>>(
  () =>
    import("../browser/browser-workspace").then((module) => ({ default: module.BrowserWorkspace })),
  { label: "browser" },
);
const MobileWorkspace = lazyView<ComponentProps<typeof MobileComponent>>(
  () =>
    import("../mobile/mobile-workspace").then((module) => ({ default: module.MobileWorkspace })),
  { label: "devices" },
);
const surfaceSchema = z.enum(["files", "diff", "browser", "devices"]);
const panelSchema = z
  .object({
    tabs: z.array(surfaceSchema).max(4),
    active: surfaceSchema.nullable(),
  })
  .refine(
    (value) =>
      new Set(value.tabs).size === value.tabs.length &&
      (value.active === null || value.tabs.includes(value.active)),
  );
type Surface = z.infer<typeof surfaceSchema>;
export type SurfaceRequest = { id: string; surface: Surface };
export type BrowserSurface = Omit<
  ComponentProps<typeof BrowserComponent>,
  "open" | "active" | "onClose" | "embedded"
>;
const workspaceIconButtonClassName =
  "workspace-icon-button grid shrink-0 cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent p-0 text-[12px] text-muted-ink hover:bg-(--color-hover-surface) hover:text-ink active:scale-[0.96]";
const labels = {
  files: "Files",
  diff: "Changes",
  browser: "Browser",
  devices: "Devices",
} satisfies Record<Surface, string>;
function SurfaceIcon({ surface }: { surface: Surface }) {
  return surface === "devices" ? (
    <DeviceGlyph size={14} />
  ) : surface === "files" ? (
    <Icon name="folder" size={14} />
  ) : surface === "diff" ? (
    <RepositoryIcon name="diff" />
  ) : (
    <BrowserGlyph size={14} />
  );
}
export function WorkspaceSurfaces({
  projectId,
  repositoryAPI,
  browser,
  mobile,
  active,
  open,
  request,
  onClose,
}: {
  projectId: string;
  repositoryAPI?: RepositoryAPI;
  browser?: BrowserSurface;
  mobile?: Omit<ComponentProps<typeof MobileComponent>, "active" | "projectId">;
  active: boolean;
  open: boolean;
  request?: SurfaceRequest;
  onClose(): void;
}) {
  const [panel, setPanel] = useSessionState<z.infer<typeof panelSchema>>(
    `repository-surfaces:${projectId}`,
    panelSchema,
    {
      tabs: repositoryAPI ? ["files"] : browser ? ["browser"] : [],
      active: repositoryAPI ? "files" : browser ? "browser" : null,
    },
  );
  const [width, setWidth] = useSessionState(
    `workspace-panel-width:${projectId}`,
    z.number().int().min(0).max(4096).nullable(),
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const [repositoryMounted, setRepositoryMounted] = useState(false);
  const [mobileMounted, setMobileMounted] = useState(false);
  const [browserMounted, setBrowserMounted] = useState<string | null>(null);
  const pane = useRef<HTMLDialogElement>(null);
  const compact = useMediaQuery("(max-width: 980px)");
  usePanelDialog(pane, open && active, compact);
  const separator = useRef<HTMLDivElement>(null);
  const resizing = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const browserKey = browser ? `${browser.scope.projectId}:${browser.scope.threadId}` : null;
  const hasBrowser = Boolean(browser),
    hasMobile = Boolean(mobile),
    hasRepository = Boolean(repositoryAPI);
  const available = useCallback(
    (surface: Surface) =>
      surface === "devices" ? hasMobile : surface === "browser" ? hasBrowser : hasRepository,
    [hasBrowser, hasRepository, hasMobile],
  );
  const selected = panel.active && available(panel.active) ? panel.active : null;
  const tabs = panel.tabs.filter(available);
  const openSurface = useCallback(
    (surface: Surface) => {
      if (!available(surface)) return;
      setPanel((current) => ({
        tabs: current.tabs.includes(surface) ? current.tabs : [...current.tabs, surface],
        active: surface,
      }));
    },
    [available, setPanel],
  );
  useLayoutEffect(() => {
    if (request) openSurface(request.surface);
  }, [request?.id, openSurface]);
  useEffect(() => {
    if (selected === "browser") setBrowserMounted(browserKey);
    else if (selected === "devices") setMobileMounted(true);
    else if (selected) setRepositoryMounted(true);
  }, [selected, browserKey]);
  const previousFocus = useRef({ open: false });
  const [focusRequest, setFocusRequest] = useState(0);
  const handledFocusRequest = useRef(0);
  const focusSelectedTab = useCallback(() => {
    pane.current
      ?.querySelector<HTMLButtonElement>(
        selected ? `#workspace-tab-${selected}` : "#workspace-add-surface",
      )
      ?.focus();
  }, [selected]);
  useLayoutEffect(() => {
    const opening = open && !previousFocus.current.open;
    if (opening && tabs.length === 0 && !request) {
      if (hasRepository) openSurface("files");
      else if (hasBrowser) openSurface("browser");
      else if (hasMobile) openSurface("devices");
    }
    const changed = opening || focusRequest !== handledFocusRequest.current;
    previousFocus.current = { open };
    handledFocusRequest.current = focusRequest;
    if (active && changed) focusSelectedTab();
  }, [
    active,
    open,
    panel.active,
    focusSelectedTab,
    focusRequest,
    tabs.length,
    request,
    hasRepository,
    hasBrowser,
    hasMobile,
    openSurface,
  ]);
  useLayoutEffect(() => {
    const node = pane.current,
      parent = node?.parentElement;
    if (!node || !parent || compact) return;
    const update = () => {
      const maximum = Math.max(0, parent.clientWidth - Math.min(280, parent.clientWidth * 0.45));
      if (width === null) parent.style.removeProperty("--workspace-panel-width");
      else
        parent.style.setProperty(
          "--workspace-panel-width",
          `${Math.max(Math.min(320, maximum), Math.min(width, maximum))}px`,
        );
      separator.current?.setAttribute("aria-valuenow", String(Math.round(node.clientWidth)));
      separator.current?.setAttribute("aria-valuemax", String(Math.round(maximum)));
      separator.current?.setAttribute("aria-valuemin", String(Math.round(Math.min(320, maximum))));
    };
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    update();
    return () => {
      observer.disconnect();
      parent.style.removeProperty("--workspace-panel-width");
    };
  }, [width, open, expanded, compact]);
  const resize = (requested: number) => {
    const parent = pane.current?.parentElement;
    if (!parent) return 0;
    const maximum = parent.clientWidth - Math.min(280, parent.clientWidth * 0.45);
    const value = Math.round(Math.max(Math.min(320, maximum), Math.min(maximum, requested)));
    parent.style.setProperty("--workspace-panel-width", `${value}px`);
    separator.current?.setAttribute("aria-valuenow", String(value));
    return value;
  };
  return (
    <Dialog
      ref={pane}
      padded={false}
      id="workspace-side-panel"
      className={`workspace-side-panel flex min-h-0 min-w-0 flex-col overflow-clip border-l border-border bg-(--color-surface) text-[13px] leading-[1.5] text-ink [--workspace-hairline:color-mix(in_srgb,var(--color-border)_65%,transparent)] [&]:max-h-none [&]:rounded-none [&:not([open])]:hidden ${compact ? "[&]:fixed [&]:bottom-0 [&]:top-(--desktop-titlebar-height) [&]:right-0 [&]:left-auto [&]:m-0 [&]:h-[calc(100dvh-var(--desktop-titlebar-height,0px))] [&]:w-[min(88vw,28rem)] [&]:max-w-none" : "[&]:relative [&]:inset-auto [&]:m-0 [&]:h-full [&]:w-auto [&]:max-w-none [&]:border-y-0 [&]:border-r-0 [&]:shadow-none"}`}
      role={compact ? "dialog" : "complementary"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label="Workspace surfaces"
      data-expanded={(!compact && expanded) || undefined}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !compact &&
          selected !== "browser" &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        ref={separator}
        hidden={compact}
        className="workspace-resize-handle absolute inset-y-0 left-0 z-3 w-[5px] cursor-col-resize touch-none hover:bg-border focus-visible:-outline-offset-1 focus-visible:outline focus-visible:outline-(--color-control-border) in-data-[expanded]:hidden"
        role="separator"
        aria-label="Resize side panel"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuenow={0}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "Home") setWidth(null);
          else
            setWidth(
              resize((pane.current?.clientWidth ?? 0) + (event.key === "ArrowLeft" ? 16 : -16)),
            );
        }}
        onPointerDown={(event) => {
          if (resizing.current || !event.isPrimary || event.button !== 0 || !pane.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizing.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width: pane.current.clientWidth,
          };
        }}
        onPointerMove={(event) => {
          const start = resizing.current;
          if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX);
        }}
        onPointerUp={(event) => {
          if (resizing.current?.pointerId !== event.pointerId) return;
          resizing.current = null;
          setWidth(Math.round(pane.current?.clientWidth ?? 0));
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          resizing.current = null;
          setWidth(Math.round(pane.current?.clientWidth ?? 0));
        }}
      />
      <header className="workspace-surface-header flex h-[42px] min-h-[42px] shrink-0 items-center gap-1 border-b border-(--workspace-hairline) bg-panel px-2.5 py-1">
        <div
          role="tablist"
          aria-label="Workspace surfaces"
          className="workspace-surface-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-0.5"
        >
          {tabs.map((surface, index) => (
            <div
              className={`workspace-surface-tab flex shrink-0 items-center rounded-md border ${selected === surface ? "border-(--workspace-hairline) bg-(--color-surface) shadow-[0_1px_2px_#00000004]" : "border-transparent"}`}
              key={surface}
            >
              <Button
                id={`workspace-tab-${surface}`}
                className="flex cursor-pointer items-center gap-1.5 rounded-[5px] border-0 bg-transparent px-2 py-1 text-[12px] text-muted-ink hover:bg-(--color-hover-surface) aria-selected:font-medium aria-selected:text-ink"
                role="tab"
                aria-selected={selected === surface}
                aria-controls={`workspace-surface-${surface}`}
                tabIndex={selected === surface || (selected === null && index === 0) ? 0 : -1}
                onClick={() => {
                  setFocusRequest((value) => value + 1);
                  openSurface(surface);
                }}
                onPointerEnter={() => {
                  void (
                    surface === "devices"
                      ? MobileWorkspace
                      : surface === "browser"
                        ? BrowserWorkspace
                        : RepositoryBrowser
                  )
                    .preload()
                    .catch(() => {});
                }}
                onKeyDown={(event) => {
                  if (event.key === "Delete") {
                    event.preventDefault();
                    setFocusRequest((value) => value + 1);
                    const remaining = panel.tabs.filter((tab) => tab !== surface);
                    setPanel({
                      tabs: remaining,
                      active:
                        selected === surface
                          ? (remaining.filter(available).at(-1) ?? null)
                          : panel.active,
                    });
                  } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : (index + (event.key === "ArrowLeft" ? tabs.length - 1 : 1)) %
                            tabs.length;
                    setFocusRequest((value) => value + 1);
                    openSurface(tabs[next]);
                  }
                }}
              >
                <SurfaceIcon surface={surface} />
                {labels[surface]}
              </Button>
              <Button
                className={`${workspaceIconButtonClassName} mr-0.5 h-[26px] min-h-[26px] w-6 [&_svg]:size-3`}
                aria-label={`Close ${labels[surface]} surface`}
                onClick={() => {
                  setFocusRequest((value) => value + 1);
                  const remaining = panel.tabs.filter((tab) => tab !== surface);
                  setPanel({
                    tabs: remaining,
                    active:
                      selected === surface
                        ? (remaining.filter(available).at(-1) ?? null)
                        : panel.active,
                  });
                }}
              >
                <RepositoryIcon name="close" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          id="workspace-add-surface"
          className={`${workspaceIconButtonClassName} size-7 min-h-7`}
          aria-label="Open a tab"
          title="Open a tab"
          onClick={() => {
            setFocusRequest((value) => value + 1);
            setPanel((current) => ({ ...current, active: null }));
          }}
        >
          <RepositoryIcon name="plus" />
        </Button>
        <Button
          className={`${workspaceIconButtonClassName} size-7 min-h-7`}
          hidden={compact}
          aria-label={expanded ? "Restore side panel size" : "Expand side panel"}
          title={expanded ? "Restore side panel size" : "Expand side panel"}
          onClick={() => setExpanded((value) => !value)}
        >
          <Glyph name="expand" />
        </Button>
        <Button
          className={`${workspaceIconButtonClassName} size-7 min-h-7`}
          aria-label="Close side panel"
          title="Close side panel"
          onClick={onClose}
        >
          <RepositoryIcon name="panel" />
        </Button>
      </header>
      {selected === null && (
        <div
          className="workspace-surface-launcher grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_auto_minmax(0,3fr)] place-items-center overflow-y-auto px-5 py-6"
          aria-label="Open a tab"
        >
          <div className="row-start-2 grid w-full max-w-56 gap-1">
            {(["files", "diff", "browser", "devices"] as const).filter(available).map((surface) => (
              <Button
                key={surface}
                className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-[13px] text-(--color-secondary-ink) hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--color-control-border) [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-muted-ink"
                onClick={() => {
                  setFocusRequest((value) => value + 1);
                  openSurface(surface);
                }}
                onPointerEnter={() => {
                  void (
                    surface === "devices"
                      ? MobileWorkspace
                      : surface === "browser"
                        ? BrowserWorkspace
                        : RepositoryBrowser
                  )
                    .preload()
                    .catch(() => {});
                }}
              >
                <SurfaceIcon surface={surface} />
                {labels[surface]}
              </Button>
            ))}
          </div>
        </div>
      )}
      {repositoryAPI && (repositoryMounted || selected === "files" || selected === "diff") && (
        <div
          className="workspace-surface-content flex min-h-0 min-w-0 flex-1 overflow-hidden"
          hidden={selected !== "files" && selected !== "diff"}
        >
          <RepositoryBrowser
            api={repositoryAPI}
            projectId={projectId}
            active={active && (selected === "files" || selected === "diff")}
            surface={selected === "diff" ? "diff" : "files"}
          />
        </div>
      )}
      {mobile && (mobileMounted || selected === "devices") && (
        <div
          id="workspace-surface-devices"
          className="workspace-surface-content flex min-h-0 min-w-0 flex-1 overflow-hidden"
          role="tabpanel"
          aria-labelledby="workspace-tab-devices"
          hidden={selected !== "devices"}
        >
          <MobileWorkspace
            {...mobile}
            projectId={projectId}
            active={active && selected === "devices"}
          />
        </div>
      )}
      {browser && (browserMounted === browserKey || selected === "browser") && (
        <div
          id="workspace-surface-browser"
          className="workspace-surface-content flex min-h-0 min-w-0 flex-1 overflow-hidden"
          role="tabpanel"
          aria-labelledby="workspace-tab-browser"
          hidden={selected !== "browser"}
        >
          <BrowserWorkspace
            key={browserKey}
            {...browser}
            embedded
            open={active && selected === "browser"}
            active={active && selected === "browser"}
          />
        </div>
      )}
    </Dialog>
  );
}
