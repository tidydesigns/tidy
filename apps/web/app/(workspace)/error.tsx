"use client";

import { useEffect, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useNavigationRecovery } from "@/components/workspace/navigation-recovery";
import posthog from "@/lib/posthog-client";

export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const recovering = useNavigationRecovery(retry);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    posthog.captureException(error, { app_error_operation: "workspace_render" });
  }, [error]);
  return (
    <main className="flex flex-col items-start gap-4 p-6">
      {recovering ? (
        <p role="status">Opening page…</p>
      ) : (
        <>
          <p role="alert">Could not load this page. Please try again.</p>
          <Button type="button" disabled={pending} onClick={() => startTransition(retry)}>
            {pending ? "Retrying…" : "Try again"}
          </Button>
        </>
      )}
    </main>
  );
}
