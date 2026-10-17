"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { NavigationLink } from "@/components/ui/navigation-link";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { workspaceMobileHeader, workspaceSidebar } from "./page-layout";

const CloseNavigationContext = createContext<(() => void) | undefined>(undefined);

export function useCloseWorkspaceNavigation() {
  return useContext(CloseNavigationContext);
}

export const workspaceMenuButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-secondary-ink hover:bg-hover-surface active:bg-pressed-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

export function WorkspaceNavigation({ children }: { children: ReactNode }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const desktopHome = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    dialog.current?.close();
    setOpen(false);
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");
    function syncLayout() {
      if (!desktop.matches || !dialog.current?.open) return;
      // Let an organization/upgrade/feedback dialog finish before moving its
      // invoker back into the desktop sidebar.
      if (document.querySelector("dialog[open]:not([data-workspace-navigation])")) return;
      close();
      desktopHome.current?.focus();
    }
    desktop.addEventListener("change", syncLayout);
    document.addEventListener("close", syncLayout, true);
    window.addEventListener("popstate", close);
    return () => {
      desktop.removeEventListener("change", syncLayout);
      document.removeEventListener("close", syncLayout, true);
      window.removeEventListener("popstate", close);
    };
  }, [close]);

  return (
    <CloseNavigationContext value={close}>
      <header className={workspaceMobileHeader}>
        <NavigationLink
          data-ph-public
          href="/files"
          prefetch={true}
          aria-label="Tidy files"
          className="inline-flex min-h-11 items-center rounded focus-visible:outline-2 focus-visible:outline-accent"
        >
          <TidyLogo />
        </NavigationLink>
        <Button
          data-ph-public
          variant="text"
          className={workspaceMenuButton}
          aria-haspopup="dialog"
          aria-controls={id}
          aria-expanded={open}
          onClick={() => {
            dialog.current?.showModal();
            setOpen(true);
          }}
        >
          <Icon name="menu" size={20} />
          <span>Menu</span>
        </Button>
      </header>
      <aside className={workspaceSidebar}>
        <NavigationLink
          ref={desktopHome}
          data-ph-public
          href="/files"
          prefetch={true}
          aria-label="Tidy files"
          className="shrink-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <TidyLogo />
        </NavigationLink>
        {!open && children}
      </aside>
      <Dialog
        ref={dialog}
        id={id}
        data-workspace-navigation
        aria-label="Workspace menu"
        padded={false}
        className="workspace-navigation-dialog"
        onCancel={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        onClose={(event) => {
          if (event.target === event.currentTarget && !event.currentTarget.open) setOpen(false);
        }}
      >
        <div className="flex min-h-dvh flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-10">
          <div className={`${workspaceMobileHeader} sticky top-0 z-10 bg-primary-white`}>
            <NavigationLink
              data-ph-public
              href="/files"
              prefetch={true}
              onNavigate={close}
              aria-label="Tidy files"
              className="inline-flex min-h-11 items-center rounded focus-visible:outline-2 focus-visible:outline-accent"
            >
              <TidyLogo />
            </NavigationLink>
            <Button
              data-ph-public
              variant="text"
              autoFocus
              className={workspaceMenuButton}
              onClick={close}
            >
              <Icon name="xmark" size={20} />
              <span>Close</span>
            </Button>
          </div>
          {open && children}
        </div>
      </Dialog>
    </CloseNavigationContext>
  );
}
