"use client";

import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { useState, type FormEvent } from "react";
import { passwordAuthClient, identifyPostHogUser } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { TextField } from "@/components/ui/text-field";
import { verificationCallbackPath } from "@/lib/auth-return-path";
import { SocialSignIn } from "@/components/auth/social-sign-in";
import { VerificationForm } from "@/components/auth/verification-form";
import { AuthShell } from "@/components/auth/auth-shell";

export function LoginForm({
  next = "/",
  providers = [],
  emailConfigured = false,
  initialError = "",
}: {
  next?: string;
  providers?: ("google" | "github")[];
  emailConfigured?: boolean;
  initialError?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      const form = new FormData(event.currentTarget);
      const result = await passwordAuthClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
        callbackURL: verificationCallbackPath(next),
      });

      if (result.error || !result.data) {
        if (result.error?.code === "EMAIL_NOT_VERIFIED") {
          setVerificationEmail(String(form.get("email")));
          return;
        }
        setError(
          result.error?.status === 429
            ? "Too many sign-in attempts. Wait a moment and try again."
            : result.error && result.error.status >= 500
              ? "Tidy is temporarily unavailable. Please try again in a moment."
              : "Unable to sign in. Check your email and password.",
        );
        return;
      }

      identifyPostHogUser(result.data.user);
      await navigateWithFreshSession(next);
    } catch (cause) {
      unstable_rethrow(cause);
      setError("Unable to sign in. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (verificationEmail !== null)
    return (
      <AuthShell
        title="Verify your email."
        description="Open the link in your inbox to finish signing in."
      >
        <VerificationForm
          next={next}
          email={verificationEmail}
          sent
          emailConfigured={emailConfigured}
        />
      </AuthShell>
    );

  return (
    <AuthShell title="Welcome back." description="Sign in to your Tidy account.">
      <form onSubmit={handleSubmit} className="mt-10 space-y-5">
        <SocialSignIn providers={providers} next={next} page="/login" disabled={pending} />
        <TextField
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
        <TextField
          id="password"
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {error && <FormMessage>{error}</FormMessage>}
        <Link
          href="/forgot-password"
          className="block text-sm underline decoration-primary-orange underline-offset-4"
        >
          Forgot password?
        </Link>
        <Link
          href={verificationCallbackPath(next)}
          className="block text-sm underline decoration-primary-orange underline-offset-4"
        >
          Verify your email
        </Link>
        <Button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-primary-black/70">
        New to Tidy?{" "}
        <Link
          href={next === "/" ? "/sign-up" : `/sign-up?next=${encodeURIComponent(next)}`}
          className="font-medium text-primary-black underline decoration-primary-orange underline-offset-4"
        >
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
