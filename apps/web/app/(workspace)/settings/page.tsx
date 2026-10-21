import { reportHandledError } from "@/lib/handled-error";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import {
  EDITOR_PANELS_COOKIE,
  EDITOR_TOOLBAR_COOKIE,
  editorToolbarPlacement,
} from "@/lib/editor-preferences";
import { getWorkspace } from "@/lib/workspace/server";
import { authEmailConfigured } from "@/lib/auth-email";
import { listWorkspaceMembers, listPendingInvitations } from "@/lib/organizations/queries";
import { listAccountSessions } from "@/lib/account/sessions";
import { settingsAvailability } from "@/lib/settings-availability";
import { settingsTab } from "@/lib/settings-navigation";
import { SettingsTabs } from "@/app/settings/settings-tabs";
import { connectionStatus } from "@/lib/github/connections";
import { billingStatus } from "@/lib/billing/server";
import { billingPlansAvailable } from "@/lib/billing/plan-server";
import { linearStatus } from "@/lib/linear/connections";
import { functionalFeatureFlags } from "@/lib/functional-feature-flags";

import { agentsEnabled } from "@/lib/agents/config";
import { agentsSchemaReady } from "@/lib/agents/store";
import { connectionStatus as agentConnectionStatus } from "@/lib/agents/connections";

export const metadata: Metadata = { title: "Settings · Tidy" };

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const flagsPromise = functionalFeatureFlags();
  const params = await searchParams;
  const requestedTab = settingsTab(params.tab);

  const { session, organization, role, canInvite } = await getWorkspace(
    typeof params.organization === "string"
      ? params.organization
      : typeof params.connectorOrganization === "string"
        ? params.connectorOrganization
        : undefined,
  );

  // Resolve navigation separately from usage, sessions and connection details.
  // The first paint must have the final tabs, including on a prefetched visit.
  const [cookieStore, flags, showAgents, showBilling] = await Promise.all([
    cookies(),
    flagsPromise,
    agentsEnabled()
      ? settingsAvailability("settings.agents_availability", agentsSchemaReady)
      : false,
    settingsAvailability("settings.billing_availability", billingPlansAvailable),
  ]);
  const githubUnavailable = {
    configured: false,
    ready: false,
    login: null,
    connections: [],
    installations: [],
    error: "GitHub is temporarily unavailable.",
    installUrl: "",
  };
  const linearUnavailable = {
    configured: false,
    ready: false,
    connections: [],
    error: "Linear is temporarily unavailable.",
  };
  const github =
    flags["settings-connectors"] && flags["github-connector"]
      ? connectionStatus(session.user.id, organization.id).catch((cause) => {
          reportHandledError(cause);
          return githubUnavailable;
        })
      : githubUnavailable;
  const linear = flags["settings-connectors"]
    ? linearStatus(session.user.id, organization.id).catch((cause) => {
        reportHandledError(cause);
        return linearUnavailable;
      })
    : linearUnavailable;
  // Start independent reads together and stream them into their own sections.
  const members = listWorkspaceMembers(session.user.id, organization.id);
  const agents = showAgents ? agentConnectionStatus(session.user.id) : undefined;
  const sessions = listAccountSessions(session.user.id);
  const billing = showBilling ? billingStatus(session.user.id, organization.id, true) : undefined;
  const invitations = canInvite ? listPendingInvitations(session.user.id, organization.id) : [];

  const callbackStatus = params.github;
  return (
    <SettingsTabs
      key={organization.id}
      sessions={sessions}
      currentSessionId={session.session.id}
      emailConfigured={authEmailConfigured()}
      verificationError={typeof params.error === "string"}
      initialTab={requestedTab ?? "profile"}
      flags={flags}
      showBilling={showBilling}
      showAgents={showAgents}
      initialEditorPanelsOpen={cookieStore.get(EDITOR_PANELS_COOKIE)?.value === "open"}
      initialEditorToolbarPlacement={editorToolbarPlacement(
        cookieStore.get(EDITOR_TOOLBAR_COOKIE)?.value,
      )}
      organization={{ id: organization.id, name: organization.name, logo: organization.logo }}
      user={{
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        image: session.user.image,
      }}
      invitations={invitations}
      role={role}
      canInvite={canInvite}
      members={members}
      github={github}
      linear={linear}
      selectedConnector={
        params.tab === "github"
          ? "github"
          : typeof params.connector === "string"
            ? params.connector
            : undefined
      }
      linearCallbackStatus={typeof params.linear === "string" ? params.linear : undefined}
      agents={agents}
      billing={billing}
      githubCallbackStatus={typeof callbackStatus === "string" ? callbackStatus : undefined}
    />
  );
}
