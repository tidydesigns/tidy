"use client";

import { useErrorNotice } from "@/lib/use-error-notice";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

export function ForgotPasswordForm({ emailConfigured }: { emailConfigured: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useErrorNotice("", "user_action", "inline");
  const [sent, setSent] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    const notifyError = setError("");
    event.preventDefault();
    setPending(true);

    const email = String(new FormData(event.currentTarget).get("email"));
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      if (result.error) throw new Error("Could not send a reset link. Please try again later.");
      setSent(true);
    } catch (error) {
      notifyError(error, "Could not send a reset link.");
    } finally {
      setPending(false);
    }
  }
  if (!emailConfigured)
    return (
      <p data-ph-public role="status" className="mt-8 text-sm">
        Password recovery is unavailable until email delivery is configured.
      </p>
    );
  if (sent)
    return (
      <p data-ph-public role="status" className="mt-8 text-sm">
        If that address has a Tidy account, a reset link is on its way. Check your inbox.
      </p>
    );
  return (
    <form method="post" onSubmit={submit} className="mt-8 space-y-5">
      <TextField
        replayLabel
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
        <span data-ph-public style={{ display: "contents" }}>
          {pending ? "Sending…" : "Send reset link"}
        </span>
      </Button>
    </form>
  );
}
