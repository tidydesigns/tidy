"use client";
import { useEffect } from "react";
export function ReauthResult({ success }: { success: boolean }) {
  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage({ type: "tidy-privacy-reauth", success }, window.location.origin);
      window.close();
    }
  }, [success]);
  return (
    <main className="mx-auto max-w-md p-8">
      <p role="status">
        {success
          ? "Authentication complete. Return to Tidy to continue."
          : "Authentication was not completed. Return to Tidy and try again with an account linked to Tidy."}
      </p>
    </main>
  );
}
