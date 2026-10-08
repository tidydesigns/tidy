import { authEmailConfigured } from "@/lib/auth-email";
import { RouteSkeleton } from "@/components/workspace/page-skeletons";
import { agentsEnabled } from "@/lib/agents/config";

export default function Loading() {
  return <RouteSkeleton showThreads={agentsEnabled()} emailConfigured={authEmailConfigured()} />;
}
