"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";

export function ConsentChoice({ oauthQuery, approval }: { oauthQuery: string; approval: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function decide(accept: boolean) {
    setPending(true);
    setError("");
    try {
      const request = { accept, oauth_query: oauthQuery, tidy_consent: approval };
      const response = await authClient.oauth2.consent(request);
      if (response.error)
        setError(
          "Could not complete authorization. Try again, or restart your agent's login command if it timed out.",
        );
    } catch {
      setError(
        "Could not complete authorization. Try again, or restart your agent's login command if it timed out.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-8 space-y-4">
      {error && <FormMessage>{error}</FormMessage>}
      <div className="flex gap-3">
        <Button type="button" disabled={pending} onClick={() => void decide(true)}>
          {pending ? "Connecting…" : "Allow access"}
        </Button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void decide(false)}
          className="rounded-lg px-4 text-sm font-medium text-primary-black/70 hover:text-primary-black"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
