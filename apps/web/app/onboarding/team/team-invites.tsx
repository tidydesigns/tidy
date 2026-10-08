"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Icon } from "@/components/ui/icon";

export type Invite = { id: string; email: string; role: string | null };
import {
  canAssignRole,
  inviteRoleOptions,
  roleLabel,
  type OrganizationRole,
} from "@/lib/organizations/roles";
import { updateInvitationRole } from "@/app/settings/actions";
import { SelectMenu } from "@/components/ui/select-menu";

export function TeamInvites({
  organizationId,
  currentEmail,
  initialInvites,
  actorRole,
  onboarding = true,
}: {
  organizationId: string;
  currentEmail: string;
  initialInvites: Invite[];
  actorRole: string;
  onboarding?: boolean;
}) {
  const router = useRouter();
  const [role, setRole] = useState<OrganizationRole>("viewer");
  const [addresses, setAddresses] = useState("");
  const [invites, setInvites] = useState(initialInvites);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [cancellingId, setCancellingId] = useState("");

  async function cancelInvite(invite: Invite) {
    setCancellingId(invite.id);
    setError("");
    try {
      const result = await authClient.organization.cancelInvitation({ invitationId: invite.id });
      if (result.error) throw new Error(result.error.message || "Could not cancel the invitation.");
      setInvites((current) => current.filter((item) => item.id !== invite.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not cancel the invitation.");
    } finally {
      setCancellingId("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const emails = [
      ...new Set(
        addresses
          .split(/[\s,;]+/)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const invalid = emails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (invalid.length) {
      setError(`Check ${invalid.join(", ")} and try again.`);
      return;
    }

    const alreadyInvited = new Set(invites.map((invite) => invite.email.toLowerCase()));
    const newEmails = emails.filter(
      (email) => email !== currentEmail.toLowerCase() && !alreadyInvited.has(email),
    );
    if (newEmails.length === 0) {
      setError("Add an email address that hasn't been invited yet.");
      return;
    }

    setPending(true);
    const failed: string[] = [];
    const created: Invite[] = [];
    let failureReason = "";

    for (const email of newEmails) {
      try {
        const result = await authClient.organization.inviteMember({ email, role, organizationId });
        if (result.error || !result.data) {
          failed.push(email);
          failureReason ||= result.error?.message ?? "";
        } else
          created.push({ id: result.data.id, email: result.data.email, role: result.data.role });
      } catch {
        failed.push(email);
      }
    }

    setInvites((current) => [...current, ...created]);
    if (created.length)
      posthog.capture("team_invitations_created", { invitation_count: created.length });
    setAddresses(failed.join("\n"));
    if (failed.length)
      setError(failureReason || `Could not invite ${failed.join(", ")}. Please try again.`);
    setPending(false);
  }

  async function copyLink(invite: Invite) {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/accept-invitation/${invite.id}`,
      );
      setCopiedId(invite.id);
    } catch {
      setError("Could not copy the link. Please try again.");
    }
  }

  function finish() {
    posthog.capture("onboarding_completed", { invitation_count: invites.length });
    router.replace("/files");
  }

  return (
    <div className="mt-10">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="emails" className="block text-sm font-medium">
            Email addresses
          </label>
          <textarea
            id="emails"
            value={addresses}
            onChange={(event) => setAddresses(event.target.value)}
            placeholder="alex@example.com"
            rows={3}
            className="w-full resize-y rounded-lg border border-primary-grey bg-transparent px-4 py-3 text-sm outline-none placeholder:text-secondary-ink focus-visible:border-primary-black focus-visible:ring-2 focus-visible:ring-primary-orange"
          />
          <p className="text-xs text-secondary-ink">
            Add one or several, separated by commas or new lines.
          </p>
        </div>
        <div className="space-y-2">
          <SelectMenu
            label="Invite role"
            value={role}
            disabled={pending}
            options={inviteRoleOptions.filter((option) => canAssignRole(actorRole, option.value))}
            onChange={(value) => setRole(value as OrganizationRole)}
          />
          <p className="text-xs text-secondary-ink">
            Access applies to every file in this workspace.
          </p>
        </div>
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={pending || !addresses.trim()}>
          {pending ? "Creating links…" : "Create invite links"}
        </Button>
      </form>

      {invites.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold">Invite links</h2>
          <p className="mt-1 text-xs text-secondary-ink">
            Share each link with its matching email address. Links expire after 48 hours.
          </p>
          <ul className="mt-4 divide-y divide-primary-grey/60 border-y border-primary-grey/60">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-4 py-3 text-sm"
              >
                <span className="min-w-0 truncate">{invite.email}</span>
                <div className="flex shrink-0 flex-wrap items-center gap-4">
                  {canAssignRole(actorRole, invite.role ?? "") ? (
                    <SelectMenu
                      label={`Invite role for ${invite.email}`}
                      value={invite.role === "member" ? "editor" : (invite.role ?? "")}
                      disabled={Boolean(cancellingId)}
                      options={inviteRoleOptions.filter((option) =>
                        canAssignRole(actorRole, option.value),
                      )}
                      onChange={(value) => {
                        setCancellingId(invite.id);
                        setError("");
                        void updateInvitationRole(
                          organizationId,
                          invite.id,
                          value as OrganizationRole,
                        )
                          .then((result) => {
                            if (result.error) setError(result.error);
                            else
                              setInvites((current) =>
                                current.map((item) =>
                                  item.id === invite.id ? { ...item, role: value } : item,
                                ),
                              );
                          })
                          .catch(() => setError("Could not change this invitation’s role."))
                          .finally(() => setCancellingId(""));
                      }}
                    />
                  ) : (
                    <span className="text-secondary-ink">{roleLabel(invite.role)}</span>
                  )}
                  <button
                    type="button"
                    disabled={cancellingId === invite.id}
                    onClick={() => copyLink(invite)}
                    className="inline-flex shrink-0 items-center gap-2 font-medium text-primary-black underline decoration-primary-orange underline-offset-4 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-black"
                  >
                    <Icon name={copiedId === invite.id ? "check" : "copy"} size={18} />
                    {copiedId === invite.id ? "Copied" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(cancellingId) || !canAssignRole(actorRole, invite.role ?? "")}
                    onClick={() => void cancelInvite(invite)}
                    className="rounded-lg px-2 py-1 text-sm text-danger hover:bg-danger/5 focus-visible:outline-2 focus-visible:outline-danger disabled:opacity-50"
                  >
                    Cancel invite
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {onboarding && (
        <button
          type="button"
          onClick={finish}
          className="mt-8 inline-flex items-center gap-2 text-sm font-medium underline decoration-primary-orange underline-offset-4 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-black"
        >
          {invites.length ? "Continue to Tidy" : "Continue on my own"}
          <Icon name="arrowRight" size={18} />
        </button>
      )}
    </div>
  );
}
