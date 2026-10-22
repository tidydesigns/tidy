import { useState, type ReactNode } from "react";
import { Button } from "@tidy/ui/button";

/** Keep sidebar changes local so the active workspace stays mounted and does not rerender. */
export function DesktopShell({
  canvasFocused,
  children,
}: {
  canvasFocused: boolean;
  children: ReactNode;
}) {
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(null);
  const sidebarVisible = sidebarPreference ?? !canvasFocused;
  const label = sidebarVisible ? "Hide sidebar" : "Show sidebar";

  return (
    <div className={`desktop ${sidebarVisible ? "" : "desktop-sidebar-hidden"}`}>
      <header className="desktop-titlebar">
        <Button
          type="button"
          className="desktop-sidebar-toggle"
          aria-label={label}
          title={label}
          aria-expanded={sidebarVisible}
          aria-controls="desktop-navigation"
          onClick={() => setSidebarPreference(!sidebarVisible)}
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
      </header>
      {children}
    </div>
  );
}
