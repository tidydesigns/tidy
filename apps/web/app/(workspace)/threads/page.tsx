import { getWorkspace, workspaceAccount } from "@/lib/workspace/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { listDesignFiles } from "@/lib/design/service";
import { can } from "@/lib/organizations/roles";
import { agentsEnabled } from "@/lib/agents/config";
import { agentsSchemaReady, getAgentThread, listAgentThreads } from "@/lib/agents/store";
import { connectionStatus } from "@/lib/agents/connections";
import { ThreadsWorkspace } from "@/components/agents/threads-workspace";

export default async function ThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string; file?: string }>;
}) {
  if (!agentsEnabled()) notFound();
  const { session } = await workspaceAccount();
  const query = await searchParams;
  const ready = await agentsSchemaReady();
  let snapshot = null;
  if (ready && query.thread) {
    const id = z.uuid().safeParse(query.thread);
    if (!id.success) notFound();
    try {
      snapshot = await getAgentThread(session.user.id, id.data);
    } catch {
      notFound();
    }
  }
  const { organization, role } = await getWorkspace(snapshot?.thread.organizationId);
  const [threads, connection, files] = ready
    ? await Promise.all([
        listAgentThreads(session.user.id, organization.id, query.file),
        connectionStatus(session.user.id),
        listDesignFiles(session.user.id, organization.id),
      ])
    : [[], null, []];
  return connection ? (
    <ThreadsWorkspace
      key={organization.id}
      organizationId={organization.id}
      userId={session.user.id}
      canEdit={can(role, "edit")}
      canManage={can(role, "manage")}
      initialThreads={threads}
      initialSnapshot={snapshot}
      files={files}
      connection={connection}
      fileId={query.file}
    />
  ) : (
    <p className="text-sm text-secondary-ink">Threads are not available yet.</p>
  );
}
