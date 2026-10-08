"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/icon";

import { workspaceNavClass } from "./workspace-nav-style";
import { workspaceDestinations as destinations } from "./workspace-nav-data";

export function WorkspaceNav({
  showThreads,
  showVault,
}: {
  showThreads: boolean;
  showVault: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current =
    pathname === "/files" && searchParams.get("view") === "archive"
      ? "archive"
      : pathname?.split("/")[1];
  return (
    <nav
      aria-label="Workspace"
      className="-mx-3 mt-10 flex w-[calc(100%+1.5rem)] shrink-0 flex-wrap items-start gap-x-3 gap-y-1 lg:mt-13 lg:flex-col"
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
            aria-current={current === id ? "page" : undefined}
            className={`${workspaceNavClass} max-lg:w-auto`}
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
