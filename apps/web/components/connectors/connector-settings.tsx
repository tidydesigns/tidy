"use client";

import { connectorList, connectorSummary } from "@/components/workspace/page-layout";
import { ConnectorDetailsSkeleton } from "@/components/workspace/page-skeletons";

import { Suspense, use } from "react";
import { GitHubSettings } from "@/components/github/connection-settings";
import type { ConnectionStatus } from "@/lib/github/connections";
import { connectorProviders, type ConnectorStatus } from "@/lib/connectors/catalog";
import { LinearSettings } from "./linear-settings";
import { ConnectorIcon } from "./connector-icon";

export function ConnectorSettings({
  organizationId,
  canManage,
  github,
  linear,
  githubCallbackStatus,
  linearCallbackStatus,
  selected,
}: {
  organizationId: string;
  canManage: boolean;
  github: ConnectionStatus | Promise<ConnectionStatus>;
  linear: ConnectorStatus | Promise<ConnectorStatus>;
  githubCallbackStatus?: string;
  linearCallbackStatus?: string;
  selected?: string;
}) {
  return (
    <div className={connectorList}>
      {connectorProviders.map((provider) => (
        <details
          key={provider.id}
          open={
            selected === provider.id ||
            Boolean(provider.id === "github" ? githubCallbackStatus : linearCallbackStatus)
          }
          className="group rounded-xl border border-border bg-surface"
        >
          <summary className={connectorSummary}>
            <span className="ml-1 inline-flex items-center gap-2 align-middle text-sm font-semibold">
              <ConnectorIcon src={provider.icon} />
              {provider.name}
            </span>
            <span className="mt-1 block pl-5 text-sm text-secondary-ink">
              {provider.description}
            </span>
          </summary>
          <div className="border-t border-border px-5 py-5">
            <Suspense fallback={<ConnectorDetailsSkeleton />}>
              {provider.id === "github" ? (
                <LoadedGitHub
                  initial={github}
                  organizationId={organizationId}
                  canManage={canManage}
                  callbackStatus={githubCallbackStatus}
                />
              ) : (
                <LoadedLinear
                  initial={linear}
                  organizationId={organizationId}
                  callbackStatus={linearCallbackStatus}
                />
              )}
            </Suspense>
          </div>
        </details>
      ))}
    </div>
  );
}
function LoadedGitHub({
  initial,
  ...props
}: {
  initial: ConnectionStatus | Promise<ConnectionStatus>;
  organizationId: string;
  canManage: boolean;
  callbackStatus?: string;
}) {
  const status = "then" in initial ? use(initial) : initial;
  return <GitHubSettings {...props} initial={status} />;
}
function LoadedLinear({
  initial,
  ...props
}: {
  initial: ConnectorStatus | Promise<ConnectorStatus>;
  organizationId: string;
  callbackStatus?: string;
}) {
  const status = "then" in initial ? use(initial) : initial;
  return <LinearSettings {...props} initial={status} />;
}
