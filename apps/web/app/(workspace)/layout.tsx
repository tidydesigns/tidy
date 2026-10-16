import { can } from "@/lib/organizations/roles";
import { authEmailConfigured } from "@/lib/auth-email";
import { Suspense, type ReactNode } from "react";
import { WorkspaceSkeleton } from "@/components/workspace/page-skeletons";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { agentsEnabled } from "@/lib/agents/config";
import { getWorkspace } from "@/lib/workspace/server";

async function Workspace({ children }: { children: ReactNode }) {
  const { session, organization, organizations, role } = await getWorkspace();
  return (
    <WorkspaceShell
      organizationId={organization.id}
      owner={can(role, "own")}
      organizations={organizations.map(({ id, name, logo }) => ({ id, name, logo }))}
      user={{ id: session.user.id, name: session.user.name, image: session.user.image }}
    >
      {children}
    </WorkspaceShell>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  // Stream a cold visit while authentication and sidebar metadata are read.
  // Data-heavy pages own their loading boundaries; MCP and Settings retain
  // the current page during an uncached transition instead of flashing a skeleton.
  return (
    <Suspense
      fallback={
        <WorkspaceSkeleton showThreads={agentsEnabled()} emailConfigured={authEmailConfigured()} />
      }
    >
      <Workspace>{children}</Workspace>
    </Suspense>
  );
}
