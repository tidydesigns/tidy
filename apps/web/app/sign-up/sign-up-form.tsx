"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { TextField } from "@/components/ui/text-field";
import { verificationCallbackPath } from "@/lib/auth-return-path";
import { SocialSignIn } from "@/components/auth/social-sign-in";
import { VerificationForm } from "@/components/auth/verification-form";
import { AuthShell } from "@/components/auth/auth-shell";

export function SignUpForm({
  next = "/onboarding/organization",
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
      const password = String(form.get("password"));

      if (password !== form.get("confirmPassword")) {
        setError("Passwords do not match.");
        return;
      }

      const result = await authClient.signUp.email({
        name: String(form.get("name")),
        email: String(form.get("email")),
        password,
        callbackURL: verificationCallbackPath(next),
      });

      if (result.error || !result.data) {
        setError(result.error?.message || "Unable to create your account.");
        return;
      }

      setVerificationEmail(String(form.get("email")));
    } catch {
      setError("Unable to create your account. Please try again.");
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
    <AuthShell title="Create your account." description="Get started with Tidy.">
      <form method="post" onSubmit={handleSubmit} className="mt-10 space-y-5">
        <SocialSignIn providers={providers} next={next} page="/sign-up" disabled={pending} />
        <TextField replayLabel id="name" label="Name" name="name" autoComplete="name" required />
        <TextField
          replayLabel
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
        <TextField
          replayLabel
          id="password"
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
        <TextField
          replayLabel
          id="confirm-password"
          label="Confirm password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
        {error && <FormMessage>{error}</FormMessage>}
        {!emailConfigured && (
          <FormMessage>
            <span data-ph-public style={{ display: "contents" }}>
              Email sign-up is temporarily unavailable. Please try again later.
            </span>
          </FormMessage>
        )}
        <Button type="submit" disabled={pending || !emailConfigured}>
          <span data-ph-public style={{ display: "contents" }}>
            {pending ? "Creating account…" : "Create account"}
          </span>
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-primary-black/70">
        <span data-ph-public style={{ display: "contents" }}>
          Already have an account?
        </span>{" "}
        <Link
          href={
            next === "/onboarding/organization"
              ? "/login"
              : `/login?next=${encodeURIComponent(next)}`
          }
          className="font-medium text-primary-black underline decoration-primary-orange underline-offset-4"
        >
          <span data-ph-public style={{ display: "contents" }}>
            Sign in
          </span>
        </Link>
      </p>
    </AuthShell>
  );
}
