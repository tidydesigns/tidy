"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { workspaceDestinations } from "./workspace-nav-data";
import { workspaceNavClass } from "./workspace-nav-style";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { EditorSkeleton, type EditorSkeletonPreferences } from "@/components/files/editor-skeleton";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { connectorProviders } from "@/lib/connectors/catalog";
import { settingsTabs, settingsLabels, settingsTab } from "@/lib/settings-navigation";
import { PageLoading } from "@/components/ui/page-loading";
import {
  filesPage,
  settingsPage,
  mcpPage,
  filesHeader,
  filesGrid,
  settingsTabList,
  settingsTabButton,
  settingsPanel,
  threadsPage,
  workspaceFrame,
  workspaceSidebar,
  workspaceContent,
  memberList,
  memberRow,
  connectorList,
  connectorSummary,
} from "./page-layout";

function Block({ className = "" }: { className?: string }) {
  return <div className={`rounded bg-subtle-fill motion-safe:animate-pulse ${className}`} />;
}

function Surface({
  name,
  className,
  children,
}: {
  name: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <main
      role="status"
      aria-label={`Loading ${name}`}
      data-page-skeleton={name}
      className={className}
    >
      <span className="sr-only">Loading {name}…</span>
      <div
        aria-hidden="true"
        className={name === "threads" ? "flex min-h-0 flex-1 flex-col" : undefined}
      >
        {children}
      </div>
    </main>
  );
}

export function FilesSkeleton() {
  return (
    <Suspense fallback={<FilesLayoutSkeleton archived={false} folder={false} />}>
      <FilesQuerySkeleton />
    </Suspense>
  );
}

function FilesQuerySkeleton() {
  const query = useSearchParams();
  const archived = query.get("view") === "archive";
  return <FilesLayoutSkeleton archived={archived} folder={!archived && query.has("folder")} />;
}

function FilesLayoutSkeleton({ archived, folder }: { archived: boolean; folder: boolean }) {
  return (
    <Surface name="files" className={filesPage}>
      {folder && (
        <div className="mb-5 inline-flex items-center gap-2 text-sm">
          <Block className="size-4" />
          <Block className="h-5 w-12" />
        </div>
      )}
      <div className={filesHeader}>
        {folder ? (
          <Block className="h-9 w-48" />
        ) : (
          <h1 className="text-3xl font-semibold tracking-tight">
            {archived ? "Archive" : "Files"}
          </h1>
        )}
        <div className="flex items-center gap-2">
          {!archived && (
            <>
              <Block className="h-[42px] w-28" />
              <Block className="h-[42px] w-24" />
            </>
          )}
          <Block className="h-11 w-[88px]" />
        </div>
      </div>
      {!archived && !folder && (
        <div className={filesGrid}>
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="flex h-24 items-center gap-4 rounded-xl border border-primary-grey/70 px-5 pr-12"
            >
              <Block className="size-7 shrink-0" />
              <Block className="h-5 w-32" />
            </div>
          ))}
        </div>
      )}
      <div className={filesGrid}>
        {[0, 1, 2].map((item) => (
          <div key={item} className="overflow-hidden rounded-xl border border-primary-grey/70">
            <Block className="h-44 rounded-none border-b border-primary-grey/45" />
            <div className="p-4 pr-12">
              <Block className="h-5 w-3/4" />
              <Block className="mt-1 h-4 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </Surface>
  );
}

function FieldSkeleton() {
  return (
    <div className="space-y-2">
      <Block className="h-5 w-24" />
      <Block className="h-12 w-full" />
    </div>
  );
}

export function ConnectorDetailsSkeleton() {
  return (
    <div role="status" aria-label="Loading connection" className="max-w-xl space-y-5">
      <span className="sr-only">Loading connection…</span>
      <div aria-hidden="true">
        <Block className="h-10 w-40" />
        <Block className="mt-5 h-4 w-3/4" />
      </div>
    </div>
  );
}

type SkeletonOptions = { showThreads?: boolean; emailConfigured?: boolean };

function SettingsPanelSkeleton({
  tab,
  emailConfigured = true,
}: {
  tab: string;
  emailConfigured?: boolean;
}) {
  if (tab === "members")
    return (
      <>
        <Block className="h-7 w-32" />
        <div className={memberList}>
          {[0, 1, 2].map((item) => (
            <div key={item} className={memberRow}>
              <div>
                <Block className="h-6 w-36" />
                <Block className="h-5 w-48" />
              </div>
              <Block className="h-5 w-16" />
            </div>
          ))}
        </div>
        <div className="mt-10 space-y-5">
          <div className="space-y-2">
            <Block className="h-5 w-32" />
            <Block className="h-28 w-full" />
            <Block className="h-4 w-72 max-w-full" />
          </div>
          <FieldSkeleton />
          <Block className="h-12 w-28" />
        </div>
      </>
    );
  if (tab === "connectors")
    return (
      <div className={connectorList}>
        {connectorProviders.map((provider) => (
          <div key={provider.id} className="rounded-xl border border-border bg-surface">
            <div className={connectorSummary}>
              <span className="ml-1 inline-flex items-center gap-2 align-middle text-sm font-semibold">
                <ConnectorIcon src={provider.icon} />
                {provider.name}
              </span>
              <span className="mt-1 block pl-5 text-sm text-secondary-ink">
                {provider.description}
              </span>
            </div>
          </div>
        ))}
      </div>
    );
  if (tab === "profile")
    return (
      <div className="max-w-xl space-y-10">
        <div className="space-y-6">
          <h2 className="text-xl font-semibold tracking-tight">Profile</h2>
          <div className="flex items-center gap-4">
            <Block className="size-16 shrink-0 rounded-full" />
            <div>
              <p className="text-sm font-medium">Profile picture</p>
            </div>
          </div>
          <FieldSkeleton />
          <FieldSkeleton />
          {!emailConfigured && (
            <p className="text-sm text-secondary-ink">
              Email changes are unavailable until email delivery is configured.
            </p>
          )}
        </div>
        <div className="space-y-5 border-t border-primary-grey pt-6">
          <h2 className="text-lg font-semibold">Password</h2>
          <FieldSkeleton />
          <FieldSkeleton />
          <FieldSkeleton />
          <Block className="h-12 w-40" />
        </div>
      </div>
    );
  if (tab === "preferences")
    return (
      <div className="max-w-xl space-y-8">
        <section className="space-y-5">
          <h2 className="text-xl font-semibold tracking-tight">Appearance</h2>
          <div className="text-sm font-medium">
            <span>Theme</span>
            <Block className="mt-2 h-10 w-full max-w-xs" />
          </div>
        </section>
        <section className="space-y-5 border-t border-primary-grey pt-8">
          <h2 className="text-xl font-semibold tracking-tight">File editor</h2>
          <div className="text-sm font-medium">
            <span>Editor panels</span>
            <Block className="mt-2 h-10 w-full max-w-xs" />
          </div>
          <div className="text-sm font-medium">
            <span>Minimised toolbar</span>
            <Block className="mt-2 h-10 w-full max-w-xs" />
          </div>
        </section>
      </div>
    );
  if (tab === "billing")
    return (
      <div className="max-w-xl space-y-6">
        <div>
          <Block className="h-5 w-28" />
          <Block className="mt-1 h-7 w-20" />
        </div>
        <div className="divide-y divide-primary-grey/60">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex justify-between gap-4 py-3">
              <Block className="h-5 w-28" />
              <Block className="h-5 w-20" />
            </div>
          ))}
        </div>
        <Block className="h-4 w-full" />
        <Block className="h-10 w-36" />
      </div>
    );
  if (tab === "agents")
    return (
      <div className="max-w-lg space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Codex</h2>
          <Block className="mt-2 h-12 w-full" />
        </div>
        <Block className="h-12 w-36" />
      </div>
    );
  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-semibold tracking-tight">Organization</h2>
      <div className="mt-8 space-y-6">
        <Block className="size-16 rounded-xl" />
        <FieldSkeleton />
      </div>
      <div className="mt-6">
        <Block className="h-5 w-24" />
        <Block className="mt-1 h-6 w-16" />
      </div>
      <div className="mt-10 space-y-6 border-t border-primary-grey pt-6">
        <Block className="h-5 w-40" />
        <Block className="h-10 w-72 max-w-full" />
      </div>
      <div className="mt-10 border-t border-primary-grey pt-6">
        <Block className="h-[42px] w-44" />
      </div>
    </div>
  );
}

export function SettingsSkeleton(options: SkeletonOptions = {}) {
  return (
    <Suspense fallback={<SettingsLayoutSkeleton tab="profile" {...options} />}>
      <SettingsQuerySkeleton {...options} />
    </Suspense>
  );
}

function SettingsQuerySkeleton(options: SkeletonOptions) {
  const requested = useSearchParams().get("tab");
  return <SettingsLayoutSkeleton tab={settingsTab(requested) ?? "profile"} {...options} />;
}

function SettingsLayoutSkeleton({
  tab,
  showThreads = true,
  emailConfigured,
}: { tab: string } & SkeletonOptions) {
  return (
    <Surface name="settings" className={settingsPage}>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Settings</h1>
      <div className={settingsTabList}>
        {settingsTabs(true, showThreads).map((item) => (
          <span
            key={item}
            className={`${settingsTabButton} ${item === tab ? "font-semibold text-accent-ink" : "font-medium text-secondary-ink"}`}
          >
            {settingsLabels[item]}
          </span>
        ))}
      </div>
      <div className={settingsPanel} data-settings-panel-skeleton>
        <SettingsPanelSkeleton tab={tab} emailConfigured={emailConfigured} />
      </div>
    </Surface>
  );
}

export function McpSkeleton() {
  return (
    <Surface name="mcp" className={mcpPage}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">MCP</h1>
        <Block className="h-[42px] w-36" />
      </div>
      <Block className="mt-4 h-5 w-full" />
      <div className="mt-10 border-t border-primary-grey/70 py-6">
        <div className="flex items-center justify-between">
          <Block className="h-7 w-28" />
          <Block className="h-5 w-20" />
        </div>
        <Block className="mt-2 h-4 w-3/4" />
      </div>
      <div className="border-t border-primary-grey/70 py-6">
        <Block className="h-7 w-44" />
        <Block className="mt-3 h-5 w-full" />
        <Block className="mt-5 h-[42px] w-32" />
      </div>
      <div className="border-t border-primary-grey/70 py-6">
        <h2 className="text-lg font-semibold">Connect an agent</h2>
        <Block className="mt-3 h-5 w-full" />
        <Block className="mt-5 h-5 w-12" />
        <Block className="mt-2 h-10 w-52" />
        <Block className="mt-4 h-14 w-full" />
      </div>
    </Surface>
  );
}

export function ThreadsSkeleton() {
  return (
    <Surface name="threads" className={threadsPage}>
      <div className="flex items-center justify-between gap-3 border-b border-primary-grey/65 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">Threads</h1>
        <Block className="h-8 w-28" />
      </div>
      <div className="grid min-h-0 flex-1 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="max-md:max-h-36 overflow-hidden space-y-3 border-primary-grey py-2 md:border-r">
          {[0, 1, 2].map((item) => (
            <Block key={item} className="h-16 w-full" />
          ))}
        </div>
        <div className="flex min-h-0 flex-col justify-end md:pl-5">
          <Block className="h-24 w-full" />
        </div>
      </div>
    </Surface>
  );
}

export function VaultSkeleton() {
  return (
    <Surface name="vault" className={filesPage}>
      <div className={filesHeader}>
        <h1 className="text-3xl font-semibold tracking-tight">Vault</h1>
        <Block className="h-[42px] w-28" />
      </div>
      <div className="mt-9 divide-y divide-primary-grey/70">
        {[0, 1, 2].map((item) => (
          <div key={item} className="flex items-center justify-between gap-4 py-5">
            <Block className="h-5 w-40" />
            <Block className="h-5 w-20" />
          </div>
        ))}
      </div>
    </Surface>
  );
}

export function WorkspacePageSkeleton(options: SkeletonOptions = {}) {
  const path = usePathname();
  if (path === "/settings") return <SettingsSkeleton {...options} />;
  if (path === "/mcp") return <McpSkeleton />;
  if (path === "/threads") return <ThreadsSkeleton />;
  if (path === "/vault") return <VaultSkeleton />;
  return <FilesSkeleton />;
}

export function WorkspaceSkeleton({ showThreads = true, emailConfigured }: SkeletonOptions) {
  return (
    <div className={workspaceFrame}>
      <aside aria-hidden="true" className={workspaceSidebar}>
        <div className="shrink-0">
          <TidyLogo />
        </div>
        <div className="-mx-3 mt-10 flex w-[calc(100%+1.5rem)] shrink-0 flex-wrap items-start gap-x-3 gap-y-1 lg:mt-13 lg:flex-col">
          {workspaceDestinations
            .filter((item) => item.id !== "vault" && (item.id !== "threads" || showThreads))
            .map(({ id, label, icon }) => (
              <div key={id} className={`${workspaceNavClass} max-lg:w-auto`}>
                <Icon name={icon} size={18} />
                <span>{label}</span>
              </div>
            ))}
        </div>
        <div className="relative -mx-3 mt-6 flex w-[calc(100%+1.5rem)] max-w-70 shrink-0 flex-col gap-4 lg:mt-auto lg:pt-5">
          <div className="flex w-full flex-col gap-1">
            <div className={workspaceNavClass}>
              <Icon name="feedback" size={18} />
              <span>Send feedback</span>
            </div>
          </div>
          <div className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2">
            <Block className="size-8 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <Block className="h-5 w-32 max-w-full" />
              <Block className="h-4 w-16" />
            </div>
            <Block className="size-3.5 shrink-0" />
          </div>
        </div>
      </aside>
      <div className={workspaceContent}>
        <WorkspacePageSkeleton showThreads={showThreads} emailConfigured={emailConfigured} />
      </div>
    </div>
  );
}

export function RouteSkeleton(options: SkeletonOptions & EditorSkeletonPreferences) {
  const path = usePathname();
  if (path?.startsWith("/files/")) return <EditorSkeleton {...options} />;
  if (["/files", "/settings", "/mcp", "/threads", "/vault"].includes(path))
    return <WorkspaceSkeleton {...options} />;
  return (
    <div className="p-6 sm:p-10">
      <PageLoading />
    </div>
  );
}
