"use client";

import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { useState, type FormEvent } from "react";
import posthog from "posthog-js";
import { createOrganization } from "./actions";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { TextField } from "@/components/ui/text-field";

export function OrganizationForm({
  inviteTeam = true,
  onPendingChange,
}: {
  inviteTeam?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onPendingChange?.(true);
    setError("");

    try {
      const name = String(new FormData(event.currentTarget).get("name")).trim();
      const result = await createOrganization(name);

      if (result.error || !result.data) {
        setError(result.error?.message || "Unable to create your organisation.");
        return;
      }

      posthog.capture("organization_created", { invite_team: inviteTeam });
      await navigateWithFreshSession(
        inviteTeam
          ? `/onboarding/team?organizationId=${encodeURIComponent(result.data.id)}`
          : "/files",
        false,
      );
    } catch (cause) {
      unstable_rethrow(cause);
      setError("Unable to create your organisation. Please try again.");
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-10 space-y-5">
      <TextField
        id="name"
        name="name"
        label="Organisation name"
        placeholder="Your company or team"
        maxLength={100}
        autoFocus
        required
      />
      {error && <FormMessage>{error}</FormMessage>}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating organisation…" : inviteTeam ? "Continue" : "Create organization"}
      </Button>
    </form>
  );
}
