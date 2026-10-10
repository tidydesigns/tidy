"use client";

import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { authClient } from "@/lib/auth-client";
import { profileNameSchema } from "@/lib/profile";
import { useOrganizationNames } from "@/components/workspace/organization-names";
import { ImmediateField } from "@/components/ui/immediate-field";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { AvatarControl } from "./avatar-control";
import { revokeAccountSession } from "./actions";

export type AccountSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
};
type User = {
  image?: string | null;
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

export function ProfileControls({
  user,
  sessions,
  onSessionsChange,
  onNameChange,
  currentSessionId,
  emailConfigured,
  verificationError,
}: {
  user: User;
  sessions: AccountSession[];
  currentSessionId: string;
  emailConfigured: boolean;
  verificationError: boolean;
  onSessionsChange: Dispatch<SetStateAction<AccountSession[]>>;
  onNameChange: (name: string) => void;
}) {
  const { profileName, updateProfileName } = useOrganizationNames();
  const [emailMessage, setEmailMessage] = useState("");
  const [emailError, setEmailError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");

  async function verifyEmail() {
    setVerifying(true);
    setEmailError("");
    setEmailMessage("");
    try {
      const result = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: "/settings?tab=profile",
      });
      if (result.error)
        throw new Error(result.error.message ?? "Could not send verification email.");
      setEmailMessage(`Verification sent to ${user.email}.`);
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "Could not send verification email.");
    } finally {
      setVerifying(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("newPassword"));
    setPasswordError("");
    setPasswordMessage("");
    if (newPassword !== data.get("confirmation")) {
      setPasswordError("The new passwords do not match.");
      return;
    }
    setPasswordPending(true);
    try {
      const result = await authClient.changePassword({
        currentPassword: String(data.get("currentPassword")),
        newPassword,
        revokeOtherSessions: false,
      });
      if (result.error) throw new Error(result.error.message ?? "Could not change your password.");
      form.reset();
      setPasswordMessage("Password changed.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Could not change your password.");
    } finally {
      setPasswordPending(false);
    }
  }

  return (
    <section aria-label="Your account" className="max-w-xl space-y-10">
      {verificationError && (
        <p role="alert" className="text-sm text-danger">
          That verification link is invalid or expired. Request the verification or email change
          again.
        </p>
      )}
      <div className="space-y-6">
        <h2 className="text-xl font-semibold tracking-tight">Profile</h2>
        <AvatarControl
          kind="user"
          id={user.id}
          name={profileName ?? user.name}
          image={user.image}
        />
        <ImmediateField
          label="Name"
          value={profileName ?? user.name}
          autoComplete="name"
          maxLength={100}
          onCommit={async (draft) => {
            const parsed = profileNameSchema.safeParse(draft);
            if (!parsed.success) throw new Error(parsed.error.issues[0].message);
            const result = await authClient.updateUser({ name: parsed.data });
            if (result.error)
              throw new Error(result.error.message ?? "Could not update your name.");
            updateProfileName(parsed.data);
            onNameChange(parsed.data);
            return parsed.data;
          }}
        />
        <ImmediateField
          label="Email"
          value={user.email}
          type="email"
          autoComplete="email"
          maxLength={320}
          disabled={!emailConfigured || verifying}
          onCommit={async (draft) => {
            const newEmail = draft.trim().toLowerCase();
            if (newEmail === user.email.toLowerCase()) return user.email;
            setEmailMessage("");
            setEmailError("");
            const result = await authClient.changeEmail({
              newEmail,
              callbackURL: "/settings?tab=profile",
            });
            if (result.error)
              throw new Error(result.error.message ?? "Could not request an email change.");
            setEmailMessage(
              user.emailVerified
                ? `Confirm this change in ${user.email}, then verify ${newEmail}.`
                : `Verify ${newEmail} to complete this change.`,
            );
            return user.email;
          }}
        />
        {!emailConfigured && (
          <p className="text-sm text-secondary-ink">
            Email changes are unavailable until email delivery is configured.
          </p>
        )}
        {!user.emailVerified && emailConfigured && (
          <button
            type="button"
            onClick={() => void verifyEmail()}
            disabled={verifying}
            className="text-sm font-medium underline decoration-primary-orange underline-offset-4 disabled:opacity-50"
          >
            {verifying ? "Sending…" : "Verify your email"}
          </button>
        )}
        {emailMessage && (
          <p role="status" className="text-sm">
            {emailMessage}
          </p>
        )}
        {emailError && (
          <p role="alert" className="text-sm text-danger">
            {emailError}
          </p>
        )}
      </div>
      <form onSubmit={changePassword} className="space-y-5 border-t border-primary-grey pt-6">
        <h2 className="text-lg font-semibold">Password</h2>
        <TextField
          id="current-password"
          label="Current password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={passwordPending}
        />
        <TextField
          id="new-password"
          label="New password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          disabled={passwordPending}
        />
        <TextField
          id="confirm-password"
          label="Confirm new password"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          disabled={passwordPending}
        />
        {passwordError && (
          <p role="alert" className="text-sm text-danger">
            {passwordError}
          </p>
        )}
        {passwordMessage && (
          <p role="status" className="text-sm">
            {passwordMessage}
          </p>
        )}
        <Button type="submit" disabled={passwordPending}>
          {passwordPending ? "Changing…" : "Change password"}
        </Button>
      </form>
      {sessions.some((session) => session.id !== currentSessionId) && (
        <div className="border-t border-primary-grey pt-6">
          <h2 className="text-lg font-semibold">Sessions</h2>
          <ul className="mt-4 space-y-4">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {session.id === currentSessionId
                      ? "This session"
                      : sessionBrowser(session.userAgent)}
                  </p>
                  <p className="mt-1 text-secondary-ink">
                    {session.ipAddress || "Unknown address"} · Signed in{" "}
                    {session.createdAt.slice(0, 16).replace("T", " ")} UTC
                  </p>
                </div>
                {session.id !== currentSessionId && (
                  <ConfirmAction
                    label="End session"
                    title="End this session?"
                    onConfirm={async () => {
                      const result = await revokeAccountSession(session.id);
                      if (result.error) throw new Error(result.error);
                      onSessionsChange((current) =>
                        current.filter((item) => item.id !== session.id),
                      );
                    }}
                  >
                    This device will need to sign in again.
                  </ConfirmAction>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function sessionBrowser(userAgent: string | null) {
  if (!userAgent) return "Other session";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const device = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac/.test(userAgent)
        ? "Mac"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "another device";
  return `${browser} on ${device}`;
}
