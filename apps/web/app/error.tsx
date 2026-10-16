"use client";

import { useNavigationRecovery } from "@/components/workspace/navigation-recovery";
import { useEffect } from "react";
import posthog from "@/lib/posthog-client";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const recovering = useNavigationRecovery(retry);
  useEffect(() => {
    posthog.captureException(error, { app_error_operation: "page_render" });
  }, [error]);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      {recovering ? (
        <p role="status">Opening page…</p>
      ) : (
        <>
          <p data-ph-public>Could not load this page. Please try again.</p>
          <button
            data-ph-public
            type="button"
            onClick={retry}
            className="rounded-md border border-primary-grey px-4 py-2"
          >
            Try again
          </button>
        </>
      )}
    </main>
  );
}
