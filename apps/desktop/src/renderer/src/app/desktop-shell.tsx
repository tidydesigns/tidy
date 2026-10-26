import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@tidy/ui/button";

const SidebarContext = createContext({ visible: true, toggle: () => {} });

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
  codeWorkspace = false,
  settingsOpen = false,
  children,
}: {
  canvasFocused: boolean;
  codeWorkspace?: boolean;
  settingsOpen?: boolean;
  children: ReactNode;
}) {
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(null);
  const sidebarVisible = settingsOpen || (!canvasFocused && (sidebarPreference ?? true));
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
        toggle: () => setSidebarPreference(!sidebarVisible),
      }}
    >
      <div
        ref={shell}
        className={`desktop relative grid h-dvh grid-rows-[auto_minmax(0,1fr)] overflow-hidden [--desktop-titlebar-height:0px] ${sidebarVisible ? "grid-cols-[var(--project-sidebar-width)_minmax(0,1fr)]" : "desktop-sidebar-hidden grid-cols-[minmax(0,1fr)]"} ${canvasFocused ? "desktop-canvas-focused" : ""} ${codeWorkspace ? "min-[801px]:[--project-sidebar-width:264px]" : ""}`}
      >
        <header className="desktop-titlebar hidden" />
        {!sidebarVisible && !canvasFocused && !settingsOpen && (
          <div className="desktop-sidebar-reopen absolute top-[calc(var(--desktop-titlebar-height)_+_6px)] left-1 z-[3]">
            <SidebarToggle />
          </div>
        )}
        {children}
      </div>
    </SidebarContext>
  );
}
