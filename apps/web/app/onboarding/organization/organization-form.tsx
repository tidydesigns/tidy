"use client";

import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { useRef, useTransition, useState, type FormEvent } from "react";
import posthog from "@/lib/posthog-client";
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
  const [, startTransition] = useTransition();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    onPendingChange?.(true);
    setError("");
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    startTransition(() => submit(name));
  }

  async function submit(name: string) {
    try {
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
      submitting.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-10 space-y-5">
      <TextField
        replayLabel
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
        <span data-ph-public style={{ display: "contents" }}>
          {pending ? "Creating organisation…" : inviteTeam ? "Continue" : "Create organization"}
        </span>
      </Button>
    </form>
  );
}
