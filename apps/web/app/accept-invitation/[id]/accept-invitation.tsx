"use client";

import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { useTransition, useState } from "react";
import { authClient, resetPostHogUser } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";

export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    setPending(true);
    setError("");

    try {
      const result = await authClient.organization.acceptInvitation({ invitationId });
      if (result.error || !result.data) {
        setError(result.error?.message || "Unable to accept this invitation.");
        return;
      }

      const active = await authClient.organization.setActive({
        organizationId: result.data.member.organizationId,
      });
      if (active.error) throw new Error(active.error.message);
      await navigateWithFreshSession("/");
    } catch (cause) {
      unstable_rethrow(cause);
      setError("Unable to accept this invitation. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-10 space-y-5">
      {error && <FormMessage>{error}</FormMessage>}
      <Button type="button" onClick={() => startTransition(accept)} disabled={pending}>
        <span data-ph-public style={{ display: "contents" }}>
          {pending ? "Joining…" : "Accept invitation"}
        </span>
      </Button>
    </div>
  );
}

export function SwitchAccountButton({ invitationId }: { invitationId: string }) {
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function switchAccount() {
    setPending(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("Unable to sign out. Please try again.");
        return;
      }
      resetPostHogUser();
      await navigateWithFreshSession(
        `/login?next=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`,
      );
    } catch (cause) {
      unstable_rethrow(cause);
      setError("Unable to sign out. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        data-ph-public
        type="button"
        onClick={() => startTransition(switchAccount)}
        disabled={pending}
        className="text-sm font-medium underline decoration-primary-orange underline-offset-4 hover:text-accent-ink disabled:opacity-60"
      >
        Switch account
      </button>
      {error && <FormMessage>{error}</FormMessage>}
    </div>
  );
}
