"use client";

import { useErrorNotice } from "@/lib/use-error-notice";
import { UserFacingError, errorMessage } from "@tidy/ui/errors";
import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

export function ResetPasswordForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useErrorNotice("", "user_action", "inline");
  const [complete, setComplete] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    const notifyError = setError("");
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("password"));
    if (newPassword !== data.get("confirmation")) {
      notifyError("The passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.resetPassword({ token, newPassword });
      if (result.error)
        throw new UserFacingError(
          errorMessage(result.error, "Could not reset your password. Please try again."),
          { cause: result.error },
        );
      form.reset();
      setComplete(true);
    } catch (error) {
      notifyError(error, "Could not reset your password.");
    } finally {
      setPending(false);
    }
  }
  if (complete)
    return (
      <div className="mt-8 space-y-4">
        <p data-ph-public role="status" className="text-sm">
          Password changed. Your previous sessions have ended.
        </p>
        <Link
          href="/login"
          className="text-sm underline decoration-primary-orange underline-offset-4"
        >
          <span data-ph-public style={{ display: "contents" }}>
            Sign in
          </span>
        </Link>
      </div>
    );
  return (
    <form method="post" onSubmit={submit} className="mt-8 space-y-5">
      <TextField
        replayLabel
        id="reset-password"
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        required
        disabled={pending}
      />
      <TextField
        replayLabel
        id="reset-confirmation"
        label="Confirm new password"
        name="confirmation"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        required
        disabled={pending}
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}{" "}
          <Link href="/forgot-password" className="underline">
            <span data-ph-public style={{ display: "contents" }}>
              Request a new link
            </span>
          </Link>
          <span data-ph-public style={{ display: "contents" }}>
            .
          </span>
        </p>
      )}
      <Button type="submit" disabled={pending}>
        <span data-ph-public style={{ display: "contents" }}>
          {pending ? "Resetting…" : "Reset password"}
        </span>
      </Button>
    </form>
  );
}
