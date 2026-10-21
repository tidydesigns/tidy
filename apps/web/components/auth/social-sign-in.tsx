"use client";

import { useErrorNotice } from "@/lib/use-error-notice";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { SocialProviderButton } from "./social-provider-button";
import { FormMessage } from "@/components/ui/form-message";

export function SocialSignIn({
  providers,
  next,
  page,
  disabled = false,
}: {
  providers: ("google" | "github")[];
  next: string;
  page: "/login" | "/sign-up";
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<"google" | "github" | null>(null);
  const [error, setError] = useErrorNotice("", "sign_in", "inline");
  if (!providers.length) return null;

  async function signIn(provider: "google" | "github") {
    const notifyError = setError("");
    setPending(provider);

    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: next,
        newUserCallbackURL: next === "/" ? "/onboarding/organization" : next,
        errorCallbackURL: `${page}?next=${encodeURIComponent(next)}`,
      });
      if (result.error || !result.data?.url) {
        notifyError(
          result.error ?? result,
          result.error?.status === 429
            ? "Too many sign-in attempts. Wait a moment and try again."
            : "Unable to connect. Please try again.",
        );
        setPending(null);
      }
    } catch (cause) {
      notifyError(cause, "Unable to connect. Please try again.");
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <SocialProviderButton
          key={provider}
          provider={provider}
          disabled={disabled || pending !== null}
          pending={pending === provider}
          onClick={() => void signIn(provider)}
        />
      ))}
      {error && <FormMessage>{error}</FormMessage>}
      <p data-ph-public className="pt-2 text-center text-sm text-secondary-ink">
        or use your email
      </p>
    </div>
  );
}
