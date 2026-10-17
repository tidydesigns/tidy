"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/icon";

import { workspaceNavClass } from "./workspace-nav-style";
import { workspaceDestinations as destinations } from "./workspace-nav-data";
import { useCloseWorkspaceNavigation } from "./workspace-navigation";

export function WorkspaceNav({
  showThreads,
  showVault,
}: {
  showThreads: boolean;
  showVault: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const closeNavigation = useCloseWorkspaceNavigation();
  const current =
    pathname === "/files" && searchParams.get("view") === "archive"
      ? "archive"
      : pathname?.split("/")[1];
  return (
    <nav
      data-ph-public-label
      data-ph-public
      aria-label="Workspace"
      className="-mx-3 mt-6 flex w-[calc(100%+1.5rem)] shrink-0 flex-col items-start gap-1 lg:mt-13"
    >
      {destinations
        .filter(
          (item) => (item.id !== "threads" || showThreads) && (item.id !== "vault" || showVault),
        )
        .map(({ id, href, label, icon }) => (
          <Link
            key={id}
            href={href}
            prefetch={true}
            onNavigate={closeNavigation}
            aria-current={current === id ? "page" : undefined}
            className={workspaceNavClass}
          >
            <Icon name={icon} size={18} />
            <span
              className={
                current === id ? "underline decoration-current underline-offset-4" : undefined
              }
            >
              {label}
            </span>
          </Link>
        ))}
    </nav>
  );
}
