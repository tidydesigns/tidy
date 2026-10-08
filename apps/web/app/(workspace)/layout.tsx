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
  // The page loading boundary is below the layout. This boundary also streams
  // the first visit while authentication and sidebar metadata are being read.
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
