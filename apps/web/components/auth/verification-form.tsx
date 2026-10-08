"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { verificationCallbackPath } from "@/lib/auth-return-path";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { FormMessage } from "@/components/ui/form-message";

export function VerificationForm({
  next,
  email = "",
  sent = false,
  emailConfigured,
  initialError = "",
}: {
  next: string;
  email?: string;
  sent?: boolean;
  emailConfigured: boolean;
  initialError?: string;
}) {
  const [pending, setPending] = useState(false);
  const [delivered, setDelivered] = useState(sent);
  const [error, setError] = useState(initialError);

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setDelivered(false);
    try {
      const form = new FormData(event.currentTarget);
      const result = await authClient.sendVerificationEmail({
        email: String(form.get("email")),
        callbackURL: verificationCallbackPath(next),
      });
      if (result.error) {
        setError(
          result.error.status === 429
            ? "Too many requests. Wait a moment before trying again."
            : "Could not send the verification email. Please try again later.",
        );
      } else setDelivered(true);
    } catch {
      setError("Could not send the verification email. Please try again later.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={resend} className="mt-10 space-y-5">
      {delivered && (
        <p role="status" className="text-sm text-primary-black/70">
          If this address has an account awaiting verification, a link has been sent. Check your
          inbox and spam folder. The link expires in one hour.
        </p>
      )}
      <TextField
        id="verification-email"
        name="email"
        type="email"
        label="Email"
        autoComplete="email"
        defaultValue={email}
        placeholder="you@example.com"
        required
      />
      {error && <FormMessage>{error}</FormMessage>}
      {!emailConfigured && (
        <FormMessage>
          Email verification is temporarily unavailable. Please try again later.
        </FormMessage>
      )}
      <Button type="submit" disabled={pending || !emailConfigured}>
        {pending ? "Sending…" : delivered ? "Resend verification email" : "Send verification email"}
      </Button>
      <Link
        href={`/login?next=${encodeURIComponent(next)}`}
        className="block text-center text-sm underline decoration-primary-orange underline-offset-4"
      >
        Back to sign in
      </Link>
    </form>
  );
}
