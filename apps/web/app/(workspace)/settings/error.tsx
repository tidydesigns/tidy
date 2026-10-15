"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import posthog from "@/lib/posthog-client";

export default function SettingsError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    posthog.captureException(error, { source: "next_error_boundary", digest: error.digest });
  }, [error]);

  return (
    <main className="flex flex-col items-start gap-4" role="alert">
      <p>Could not load settings. Please try again.</p>
      <Button variant="text" type="button" onClick={retry}>
        Try again
      </Button>
    </main>
  );
}
