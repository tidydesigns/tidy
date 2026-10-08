"use client";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

export function ForgotPasswordForm({ emailConfigured }: { emailConfigured: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const email = String(new FormData(event.currentTarget).get("email"));
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      if (result.error) throw new Error("Could not send a reset link. Please try again later.");
      setSent(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send a reset link.");
    } finally {
      setPending(false);
    }
  }
  if (!emailConfigured)
    return (
      <p role="status" className="mt-8 text-sm">
        Password recovery is unavailable until email delivery is configured.
      </p>
    );
  if (sent)
    return (
      <p role="status" className="mt-8 text-sm">
        If that address has a Tidy account, a reset link is on its way. Check your inbox.
      </p>
    );
  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <TextField
        id="reset-email"
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        maxLength={320}
        required
        disabled={pending}
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
