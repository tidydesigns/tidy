"use client";

import { useState } from "react";
import Image from "next/image";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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
  const [error, setError] = useState("");
  if (!providers.length) return null;

  async function signIn(provider: "google" | "github") {
    setPending(provider);
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: next,
        newUserCallbackURL: next === "/" ? "/onboarding/organization" : next,
        errorCallbackURL: `${page}?next=${encodeURIComponent(next)}`,
      });
      if (result.error || !result.data?.url) {
        setError(
          result.error?.status === 429
            ? "Too many sign-in attempts. Wait a moment and try again."
            : "Unable to connect. Please try again.",
        );
        setPending(null);
      }
    } catch {
      setError("Unable to connect. Please try again.");
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          disabled={disabled || pending !== null}
          className="flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-primary-grey bg-surface px-4 text-sm font-semibold text-primary-black transition-transform hover:bg-hover-surface active:bg-pressed-surface active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-black disabled:cursor-wait disabled:opacity-60"
          onClick={() => void signIn(provider)}
        >
          <span
            aria-hidden="true"
            className={`flex size-6 shrink-0 items-center justify-center ${provider === "google" ? "rounded-full bg-white" : ""}`}
          >
            {provider === "google" ? (
              <Image
                src="/icons/google.png"
                alt=""
                width={200}
                height={204}
                unoptimized
                loading="eager"
                className="size-5 shrink-0 -translate-x-[0.5px] object-contain"
              />
            ) : (
              <Icon name="github" size={20} />
            )}
          </span>
          <span>
            {pending === provider
              ? "Connecting…"
              : `Continue with ${provider === "google" ? "Google" : "GitHub"}`}
          </span>
        </Button>
      ))}
      {error && <FormMessage>{error}</FormMessage>}
      <p className="pt-2 text-center text-sm text-primary-black/60">or use your email</p>
    </div>
  );
}
