import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { useMediaQuery, usePanelDialog } from "../components/panel-dialog";

const SidebarContext = createContext({ visible: true, compact: false, toggle: () => {} });

export function SidebarNavigation({ className, hidden, ...props }: ComponentProps<typeof Dialog>) {
  const { visible, compact, toggle } = useContext(SidebarContext);
  const dialog = useRef<HTMLDialogElement>(null);
  usePanelDialog(dialog, visible && !hidden, compact);
  return (
    <Dialog
      {...props}
      ref={dialog}
      padded={false}
      role={compact ? "dialog" : "navigation"}
      onCancel={(event) => {
        event.preventDefault();
        toggle();
      }}
      className={`${className ?? ""} [&]:m-0 [&]:overflow-visible [&]:max-h-none [&]:max-w-none [&]:rounded-none [&]:border-y-0 [&]:border-l-0 [&:not([open])]:hidden ${compact ? "[&]:fixed [&]:bottom-0 [&]:top-(--desktop-titlebar-height) [&]:left-0 [&]:right-auto [&]:h-[calc(100dvh-var(--desktop-titlebar-height,0px))] [&]:w-[min(88vw,264px)]" : "[&]:relative [&]:inset-auto [&]:h-auto [&]:w-auto [&]:shadow-none"}`}
    />
  );
}

export function SidebarToggle() {
  const { visible, toggle } = useContext(SidebarContext);
  const label = visible ? "Hide sidebar" : "Show sidebar";
  return (
    <Button
      type="button"
      className="desktop-sidebar-toggle grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-[5px] border border-transparent bg-transparent p-0 text-muted-ink [app-region:no-drag] hover:border-border hover:bg-hover-surface hover:text-ink active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      aria-label={label}
      title={label}
      aria-expanded={visible}
      aria-controls="desktop-navigation"
      onClick={toggle}
    >
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      >
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
        <path d="M7.5 3.5v13" />
      </svg>
    </Button>
  );
}

export function DesktopShell({
  canvasFocused,
  settingsOpen = false,
  children,
}: {
  canvasFocused: boolean;
  settingsOpen?: boolean;
  children: ReactNode;
}) {
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const compact = useMediaQuery("(max-width: 800px)");
  const sidebarVisible =
    settingsOpen || (!canvasFocused && (compact ? mobileOpen : (sidebarPreference ?? true)));
  const inlineSidebar = sidebarVisible && (!compact || settingsOpen);
  const shell = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (sidebarPreference === null) return;
    shell.current
      ?.querySelector<HTMLButtonElement>(
        sidebarPreference
          ? ".workspace-header .desktop-sidebar-toggle"
          : ".desktop-sidebar-reopen .desktop-sidebar-toggle",
      )
      ?.focus();
  }, [sidebarPreference]);

  return (
    <SidebarContext
      value={{
        visible: sidebarVisible,
        compact,
        toggle: () =>
          compact ? setMobileOpen(!sidebarVisible) : setSidebarPreference(!sidebarVisible),
      }}
    >
      <div
        ref={shell}
        className={`desktop relative grid h-dvh grid-rows-[auto_minmax(0,1fr)] overflow-hidden [--desktop-titlebar-height:0px] ${inlineSidebar ? "grid-cols-[var(--project-sidebar-width)_minmax(0,1fr)]" : "desktop-sidebar-hidden grid-cols-[minmax(0,1fr)]"} ${canvasFocused ? "desktop-canvas-focused" : ""} ${!settingsOpen ? "min-[801px]:[--project-sidebar-width:264px]" : ""}`}
      >
        <header className="desktop-titlebar hidden" />
        {children}
        {!inlineSidebar && !canvasFocused && !settingsOpen && (
          <div className="desktop-sidebar-reopen absolute top-1.5 left-1 z-[3] [app-region:no-drag]">
            <SidebarToggle />
          </div>
        )}
      </div>
    </SidebarContext>
  );
}
