"use client";

import { useSearchParams } from "next/navigation";
import { Activity, useState, type ReactNode, type KeyboardEvent } from "react";
import { TeamInvites, type Invite } from "@/app/onboarding/team/team-invites";
import { roleLabel } from "@/lib/organizations/roles";
import { DeleteOrganization } from "./delete-organization";
import { AvatarControl } from "./avatar-control";
import { OrganizationName } from "./organization-name";
import { ProfileControls, type AccountSession } from "./profile-controls";
import { PreferenceControls } from "./preference-controls";
import {
  settingsTabs,
  settingsLabels,
  settingsTab,
  type SettingsTab,
} from "@/lib/settings-navigation";
import { MemberControls } from "./member-controls";
import { OrganizationMembership } from "./organization-membership";
import { useOrganizationNames } from "@/components/workspace/organization-names";
import { ConnectorSettings } from "@/components/connectors/connector-settings";
import type { ConnectorStatus } from "@/lib/connectors/catalog";
import type { ConnectionStatus } from "@/lib/github/connections";
import type { BillingStatus } from "@/lib/billing/server";
import { BillingSettings } from "./billing-settings";
import type { EditorToolbarPlacement } from "@/lib/editor-preferences";
import { FeatureFlagsProvider } from "@/lib/use-feature-flag";
import { FLAGS_OFF, type FunctionalFlags } from "@/lib/feature-flags";
import { useDeferredData } from "@/lib/use-deferred-data";
import { DeferredSection, SectionLoading } from "@/components/ui/deferred-section";

import { AgentConnectionSettings } from "@/components/agents/connection-settings";
import type { ConnectionStatus as AgentConnection } from "@/lib/agents/protocol";

import {
  settingsPage,
  settingsTabList,
  settingsTabButton,
  settingsPanel,
} from "@/components/workspace/page-layout";

export type Tab = SettingsTab;
export type Member = { id: string; userId: string; name: string; email: string; role: string };

function SettingsPanel({
  item,
  selected,
  children,
}: {
  item: Tab;
  selected: Tab;
  children: ReactNode;
}) {
  return (
    <Activity mode={selected === item ? "visible" : "hidden"}>
      <div
        id={`settings-panel-${item}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${item}`}
        tabIndex={0}
        className={settingsPanel}
      >
        {children}
      </div>
    </Activity>
  );
}

export function SettingsTabs({
  flags = FLAGS_OFF,
  invitations = [],
  initialTab,
  organization,
  user,
  role,
  canInvite,
  members,
  github,
  agents,
  linear,
  selectedConnector,
  billing,
  githubCallbackStatus,
  linearCallbackStatus,
  sessions,
  currentSessionId,
  emailConfigured,
  verificationError,
  initialEditorPanelsOpen,
  initialEditorToolbarPlacement,
}: {
  flags?: FunctionalFlags | Promise<FunctionalFlags>;
  invitations?: Invite[] | Promise<Invite[]>;
  sessions: AccountSession[] | Promise<AccountSession[]>;
  currentSessionId: string;
  emailConfigured: boolean;
  verificationError: boolean;
  initialEditorPanelsOpen?: boolean;
  initialEditorToolbarPlacement?: EditorToolbarPlacement;
  initialTab: Tab;
  organization: { id: string; name: string; logo?: string | null };
  user: { image?: string | null; id: string; name: string; email: string; emailVerified: boolean };
  role: string;
  canInvite: boolean;
  members: Member[] | Promise<Member[]>;
  github: ConnectionStatus | Promise<ConnectionStatus>;
  linear: ConnectorStatus | Promise<ConnectorStatus>;
  selectedConnector?: string;
  linearCallbackStatus?: string;
  billing: BillingStatus | Promise<BillingStatus>;
  agents?: AgentConnection | Promise<AgentConnection | undefined>;
  githubCallbackStatus?: string;
}) {
  const searchParams = useSearchParams();
  const [editedMembers, setMembers] = useState<Member[]>();
  const [currentRole, setRole] = useState(role);
  const billingResult = useDeferredData(billing, true);
  const agentsResult = useDeferredData(agents, true);
  const flagsResult = useDeferredData(flags);
  const resolvedFlags = flagsResult.status === "ready" ? flagsResult.value : FLAGS_OFF;
  const requested = settingsTab(searchParams.get("tab"));
  // A deep link stays selected while its availability is unknown. Ordinary
  // navigation remains usable without waiting for optional tabs.
  const showBilling =
    billingResult.status === "ready"
      ? Boolean(billingResult.value.proLimits)
      : requested === "billing";
  const showAgents =
    agentsResult.status === "ready" ? Boolean(agentsResult.value) : requested === "agents";
  const showConnectors =
    resolvedFlags["settings-connectors"] ||
    (flagsResult.status === "pending" && requested === "connectors");
  const visibleTabs = settingsTabs(showBilling, showAgents, showConnectors);
  const { names, profileName } = useOrganizationNames();
  const currentOrganization = {
    ...organization,
    name: names[organization.id] ?? organization.name,
  };

  const tab =
    visibleTabs.find((item) => item === requested) ??
    (visibleTabs.includes(initialTab) && searchParams.has("tab") ? initialTab : "profile");

  function selectTab(next: Tab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "profile") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    window.history.pushState(null, "", query ? `/settings?${query}` : "/settings");
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, item: Tab) {
    const index = visibleTabs.indexOf(item);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % visibleTabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + visibleTabs.length) % visibleTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? visibleTabs.length - 1
              : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    selectTab(visibleTabs[nextIndex]);
    document.getElementById(`settings-tab-${visibleTabs[nextIndex]}`)?.focus();
  }

  return (
    <FeatureFlagsProvider flags={resolvedFlags}>
      <main className={settingsPage} data-page-content="settings">
        <h1 data-ph-public className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Settings
        </h1>
        <div
          data-ph-public-label
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="horizontal"
          className={settingsTabList}
        >
          {visibleTabs.map((item) => (
            <button
              key={item}
              id={`settings-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={`settings-panel-${item}`}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => selectTab(item)}
              onKeyDown={(event) => onTabKeyDown(event, item)}
              className={`${settingsTabButton} cursor-pointer ${tab === item ? "font-semibold text-accent-ink" : "font-medium text-secondary-ink hover:text-primary-black"}`}
            >
              <span data-ph-public>{settingsLabels[item]}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0">
          {showAgents && (
            <SettingsPanel item="agents" selected={tab}>
              <DeferredSection value={agents} label="agent connection">
                {(loaded) => (loaded ? <AgentConnectionSettings initial={loaded} /> : null)}
              </DeferredSection>
            </SettingsPanel>
          )}
          {showBilling && (
            <SettingsPanel item="billing" selected={tab}>
              <DeferredSection value={billing} label="billing">
                {(loaded) => (
                  <BillingSettings
                    organizationId={organization.id}
                    owner={currentRole.split(",").includes("owner")}
                    billing={loaded}
                  />
                )}
              </DeferredSection>
            </SettingsPanel>
          )}
          {showConnectors && (
            <SettingsPanel item="connectors" selected={tab}>
              {flagsResult.status === "pending" ? (
                <SectionLoading label="connectors" />
              ) : (
                <ConnectorSettings
                  key={organization.id}
                  organizationId={organization.id}
                  canManage={canInvite}
                  github={github}
                  linear={linear}
                  selected={selectedConnector}
                  githubCallbackStatus={githubCallbackStatus}
                  linearCallbackStatus={linearCallbackStatus}
                />
              )}
            </SettingsPanel>
          )}
          <SettingsPanel item="members" selected={tab}>
            <DeferredSection value={editedMembers ?? members} label="members">
              {(loadedMembers) => {
                const currentMembers = loadedMembers.map((member) =>
                  member.userId === user.id && profileName
                    ? { ...member, name: profileName }
                    : member,
                );
                return (
                  <section aria-labelledby="members-heading">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <h2 id="members-heading" className="text-xl font-semibold tracking-tight">
                        {currentMembers.length}{" "}
                        <span data-ph-public style={{ display: "contents" }}>
                          {currentMembers.length === 1 ? "member" : "members"}
                        </span>
                      </h2>
                    </div>
                    <MemberControls
                      organizationId={organization.id}
                      members={currentMembers}
                      userId={user.id}
                      role={currentRole}
                      onChange={(update) =>
                        setMembers((current) =>
                          typeof update === "function" ? update(current ?? currentMembers) : update,
                        )
                      }
                    />
                    {canInvite && (
                      <DeferredSection value={invitations} label="invitations">
                        {(loaded) => (
                          <TeamInvites
                            key={organization.id}
                            organizationId={organization.id}
                            currentEmail={user.email}
                            actorRole={currentRole}
                            initialInvites={loaded}
                            onboarding={false}
                          />
                        )}
                      </DeferredSection>
                    )}
                  </section>
                );
              }}
            </DeferredSection>
          </SettingsPanel>

          <SettingsPanel item="profile" selected={tab}>
            <ProfileControls
              user={user}
              sessions={sessions}
              currentSessionId={currentSessionId}
              emailConfigured={emailConfigured}
              verificationError={verificationError}
            />
          </SettingsPanel>

          <SettingsPanel item="preferences" selected={tab}>
            <PreferenceControls
              initialEditorPanelsOpen={initialEditorPanelsOpen}
              initialEditorToolbarPlacement={initialEditorToolbarPlacement}
            />
          </SettingsPanel>

          <SettingsPanel item="organization" selected={tab}>
            <section aria-labelledby="organization-heading" className="max-w-xl">
              <h2
                data-ph-public
                id="organization-heading"
                className="text-xl font-semibold tracking-tight"
              >
                Organization
              </h2>
              <div className="mt-8 space-y-6">
                <AvatarControl
                  kind="organization"
                  id={organization.id}
                  name={currentOrganization.name}
                  image={organization.logo}
                  editable={canInvite}
                />
                {canInvite ? (
                  <OrganizationName organization={currentOrganization} />
                ) : (
                  <dl>
                    <dt data-ph-public className="text-sm text-secondary-ink">
                      Name
                    </dt>
                    <dd className="mt-1 font-medium">{currentOrganization.name}</dd>
                  </dl>
                )}
              </div>
              <dl className="mt-6 space-y-6">
                <div>
                  <dt data-ph-public className="text-sm text-secondary-ink">
                    Your role
                  </dt>
                  <dd className="mt-1 font-medium">{roleLabel(currentRole)}</dd>
                </div>
              </dl>
              <DeferredSection value={editedMembers ?? members} label="organization membership">
                {(currentMembers) => (
                  <OrganizationMembership
                    organization={currentOrganization}
                    members={currentMembers}
                    userId={user.id}
                    role={currentRole}
                    onTransfer={(successorId) => {
                      setMembers((current) =>
                        (current ?? currentMembers).map((member) =>
                          member.id === successorId
                            ? { ...member, role: "owner" }
                            : member.userId === user.id
                              ? { ...member, role: "admin" }
                              : member,
                        ),
                      );
                      setRole("admin");
                    }}
                  />
                )}
              </DeferredSection>
              {currentRole.split(",").includes("owner") && (
                <DeleteOrganization
                  organization={currentOrganization}
                  returnToAccount={searchParams.get("returnTo") === "account"}
                />
              )}
            </section>
          </SettingsPanel>
        </div>
      </main>
    </FeatureFlagsProvider>
  );
}
