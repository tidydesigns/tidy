import { authEmailConfigured } from "@/lib/auth-email";
import { agentsEnabled } from "@/lib/agents/config";
import { SettingsSkeleton } from "@/components/workspace/page-skeletons";

export default function SettingsLoading() {
  return <SettingsSkeleton showThreads={agentsEnabled()} emailConfigured={authEmailConfigured()} />;
}
