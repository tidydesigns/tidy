"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

export default function ErrorPage({
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <p>Could not load this page. Please try again.</p>
      <button
        type="button"
        onClick={retry}
        className="rounded-md border border-primary-grey px-4 py-2"
      >
        Try again
      </button>
    </main>
  );
}
