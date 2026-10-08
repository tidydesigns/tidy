"use client";
import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

export function ResetPasswordForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("password"));
    if (newPassword !== data.get("confirmation")) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.resetPassword({ token, newPassword });
      if (result.error)
        throw new Error(result.error.message ?? "This reset link is invalid or expired.");
      form.reset();
      setComplete(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not reset your password.");
    } finally {
      setPending(false);
    }
  }
  if (complete)
    return (
      <div className="mt-8 space-y-4">
        <p role="status" className="text-sm">
          Password changed. Your previous sessions have ended.
        </p>
        <Link
          href="/login"
          className="text-sm underline decoration-primary-orange underline-offset-4"
        >
          Sign in
        </Link>
      </div>
    );
  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <TextField
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
            Request a new link
          </Link>
          .
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}
