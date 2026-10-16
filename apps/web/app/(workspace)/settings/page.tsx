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
import { settingsTab } from "@/lib/settings-navigation";
import { SettingsTabs } from "@/app/settings/settings-tabs";
import { connectionStatus } from "@/lib/github/connections";
import { billingStatus } from "@/lib/billing/server";
import { linearStatus } from "@/lib/linear/connections";
import { functionalFeatureFlags } from "@/lib/functional-feature-flags";

import { agentsEnabled } from "@/lib/agents/config";
import { agentsSchemaReady } from "@/lib/agents/store";
import { connectionStatus as agentConnectionStatus } from "@/lib/agents/connections";

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

  const agentStatus = async () =>
    agentsEnabled() && (await agentsSchemaReady())
      ? agentConnectionStatus(session.user.id)
      : undefined;
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
  const github = flagsPromise.then((flags) =>
    flags["settings-connectors"] && flags["github-connector"]
      ? connectionStatus(session.user.id, organization.id).catch(() => githubUnavailable)
      : githubUnavailable,
  );
  const linear = flagsPromise.then((flags) =>
    flags["settings-connectors"]
      ? linearStatus(session.user.id, organization.id).catch(() => linearUnavailable)
      : linearUnavailable,
  );
  // Start independent reads together and stream them into their own sections.
  const members = listWorkspaceMembers(session.user.id, organization.id);
  const sessions = listAccountSessions(session.user.id);
  const billing = billingStatus(session.user.id, organization.id, true);
  const invitations = canInvite ? listPendingInvitations(session.user.id, organization.id) : [];
  const agents = agentStatus();
  const callbackStatus = params.github;
  const cookieStore = await cookies();
  return (
    <SettingsTabs
      key={organization.id}
      sessions={sessions}
      currentSessionId={session.session.id}
      emailConfigured={authEmailConfigured()}
      verificationError={typeof params.error === "string"}
      initialTab={requestedTab ?? "profile"}
      flags={flagsPromise}
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
