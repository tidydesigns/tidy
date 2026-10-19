"use client";

import { useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { authClient, resetPostHogUser } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";

export function SignOutButton() {
  const [, startTransition] = useTransition();
  const signingOut = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    setPending(true);
    setError("");
    startTransition(signOutAction);
  }

  async function signOutAction() {
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("Unable to sign out. Please try again.");
        return;
      }
      resetPostHogUser();
      await navigateWithFreshSession("/login");
    } catch (cause) {
      unstable_rethrow(cause);
      setError("Unable to sign out. Please try again.");
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
      {error && <FormMessage>{error}</FormMessage>}
    </>
  );
}
