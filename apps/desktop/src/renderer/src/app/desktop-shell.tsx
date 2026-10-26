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
      className="desktop-sidebar-toggle"
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
        className={`desktop ${sidebarVisible ? "" : "desktop-sidebar-hidden"} ${canvasFocused ? "desktop-canvas-focused" : ""}`}
      >
        <header className="desktop-titlebar" />
        {!sidebarVisible && !canvasFocused && !settingsOpen && (
          <div className="desktop-sidebar-reopen">
            <SidebarToggle />
          </div>
        )}
        {children}
      </div>
    </SidebarContext>
  );
}
