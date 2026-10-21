"use client";

import { useErrorNotice } from "@/lib/use-error-notice";

import { useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { authClient, resetPostHogUser } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const [, startTransition] = useTransition();
  const signingOut = useRef(false);
  const [pending, setPending] = useState(false);
  const [, setError] = useErrorNotice("", "user_action");

  function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    setPending(true);
    setError("");
    startTransition(signOutAction);
  }

  async function signOutAction() {
    const notifyError = setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) {
        notifyError(result.error, "Unable to sign out. Please try again.");
        return;
      }
      resetPostHogUser();
      await navigateWithFreshSession("/login");
    } catch (cause) {
      unstable_rethrow(cause);
      notifyError(cause, "Unable to sign out. Please try again.");
    } finally {
      signingOut.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Button type="button" variant="text" onClick={signOut} disabled={pending}>
        <span data-ph-public style={{ display: "contents" }}>
          {pending ? "Signing out…" : "Sign out"}
        </span>
      </Button>
    </>
  );
}
