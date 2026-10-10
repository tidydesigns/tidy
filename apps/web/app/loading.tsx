import { authEmailConfigured } from "@/lib/auth-email";
import { RouteSkeleton } from "@/components/workspace/page-skeletons";
import { agentsEnabled } from "@/lib/agents/config";
import { cookies } from "next/headers";
import {
  EDITOR_PANELS_COOKIE,
  EDITOR_TOOLBAR_COOKIE,
  editorToolbarPlacement,
} from "@/lib/editor-preferences";

export default async function Loading() {
  const cookieStore = await cookies();
  return (
    <RouteSkeleton
      showThreads={agentsEnabled()}
      emailConfigured={authEmailConfigured()}
      initialPanelsOpen={cookieStore.get(EDITOR_PANELS_COOKIE)?.value === "open"}
      initialToolbarPlacement={editorToolbarPlacement(
        cookieStore.get(EDITOR_TOOLBAR_COOKIE)?.value,
      )}
    />
  );
}
