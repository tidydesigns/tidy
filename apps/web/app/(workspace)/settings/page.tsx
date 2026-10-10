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
import { SettingsTabs, type Tab } from "@/app/settings/settings-tabs";
import { connectionStatus } from "@/lib/github/connections";
import { billingStatus } from "@/lib/billing/server";
import { linearStatus } from "@/lib/linear/connections";

import { agentsEnabled } from "@/lib/agents/config";
import { agentsSchemaReady } from "@/lib/agents/store";
import { connectionStatus as agentConnectionStatus } from "@/lib/agents/connections";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const params = await searchParams;
  const requestedTab = settingsTab(params.tab);

  const { session, organization, role, canInvite } = await getWorkspace(
    typeof params.connectorOrganization === "string" ? params.connectorOrganization : undefined,
  );

  const agentStatus = async () =>
    agentsEnabled() && (await agentsSchemaReady())
      ? agentConnectionStatus(session.user.id)
      : undefined;
  const github = connectionStatus(session.user.id, organization.id).catch(() => ({
    configured: false,
    ready: false,
    login: null,
    connections: [],
    installations: [],
    error: "GitHub is temporarily unavailable.",
    installUrl: "",
  }));
  const linear = linearStatus(session.user.id, organization.id).catch(() => ({
    configured: false,
    ready: false,
    connections: [],
    error: "Linear is temporarily unavailable.",
  }));
  const [members, sessions, billing, invitations, agents] = await Promise.all([
    listWorkspaceMembers(session.user.id, organization.id),
    listAccountSessions(session.user.id),
    billingStatus(session.user.id, organization.id, true),
    listPendingInvitations(session.user.id, organization.id),
    agentStatus(),
  ]);
  const initialTab: Tab =
    requestedTab &&
    (requestedTab !== "billing" || billing.proLimits) &&
    (requestedTab !== "agents" || agents)
      ? (requestedTab as Tab)
      : "profile";
  const callbackStatus = (await searchParams).github;
  const cookieStore = await cookies();
  return (
    <SettingsTabs
      key={organization.id}
      sessions={sessions}
      currentSessionId={session.session.id}
      emailConfigured={authEmailConfigured()}
      verificationError={typeof (await searchParams).error === "string"}
      initialTab={initialTab}
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
