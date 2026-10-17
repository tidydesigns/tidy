import { Suspense, type ReactNode } from "react";
import { workspaceFrame, workspaceContent } from "./page-layout";
import { WorkspaceNavigation } from "./workspace-navigation";
import { WorkspaceNav } from "./workspace-nav";
import { workspaceNavClass as navClass } from "./workspace-nav-style";
import { OrganizationSwitcher } from "./organization-switcher";
import { OrganizationNamesProvider } from "./organization-names";
import { UpgradeDialog } from "./upgrade-dialog";
import { billingStatus, type BillingStatus } from "@/lib/billing/server";
import { FeedbackProvider, SendFeedback } from "./send-feedback";
import { organizationCreationStatus } from "@/lib/organizations/creation";
import { agentsEnabled } from "@/lib/agents/config";
import { vaultEnabled } from "@/lib/vault/feature-flag";

type WorkspaceShellProps = {
  organizationId: string;
  owner: boolean;
  billing?: BillingStatus;
  organizations: { id: string; name: string; logo?: string | null }[];
  user: { id: string; name: string; image?: string | null };
  children: ReactNode;
};

export async function WorkspaceShell({
  organizationId,
  organizations,
  user,
  owner,
  billing: initialBilling,
  children,
}: WorkspaceShellProps) {
  const [billing, creation, showVault] = await Promise.all([
    initialBilling ?? billingStatus(user.id, organizationId),
    organizationCreationStatus(user.id),
    vaultEnabled(user.id),
  ]);
  const canUpgrade =
    billing.ready &&
    billing.proLimits !== null &&
    billing.tier === "free" &&
    (!billing.status || ["canceled", "incomplete_expired"].includes(billing.status));
  return (
    <FeedbackProvider key={`${user.id}:${organizationId}`}>
      <OrganizationNamesProvider>
        <div className={workspaceFrame}>
          <a
            href="#workspace-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-4 focus:py-3 focus:text-ink focus:outline-2 focus:outline-accent"
          >
            Skip to content
          </a>
          <WorkspaceNavigation>
            <Suspense fallback={null}>
              <WorkspaceNav showThreads={agentsEnabled()} showVault={showVault} />
            </Suspense>
            <div className="relative -mx-3 mt-auto flex w-[calc(100%+1.5rem)] shrink-0 flex-col gap-4 pt-8 lg:max-w-70 lg:pt-5">
              <div className="flex w-full flex-col gap-1">
                <SendFeedback showIcon className={navClass} />
                {canUpgrade && billing.proLimits && (
                  <UpgradeDialog
                    showIcon
                    organizationId={organizationId}
                    owner={owner}
                    firstMonthUsed={billing.firstMonthUsed}
                    limits={billing.proLimits}
                    triggerClassName={navClass}
                  />
                )}
              </div>
              <OrganizationSwitcher
                organizationId={organizationId}
                organizations={organizations}
                user={user}
                canCreateOrganization={creation.canCreateOrganization}
              />
            </div>
          </WorkspaceNavigation>
          <div id="workspace-content" tabIndex={-1} className={workspaceContent}>
            {children}
          </div>
        </div>
      </OrganizationNamesProvider>
    </FeedbackProvider>
  );
}
