"use client";

import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { Avatar } from "@/components/ui/avatar";
import { avatarPath } from "@/lib/avatars";
import { Dialog } from "@/components/ui/dialog";
import { useId, useRef, useState } from "react";
import posthog from "posthog-js";
import { authClient } from "@/lib/auth-client";
import { SignOutButton } from "@/app/sign-out-button";
import { OrganizationForm } from "@/app/onboarding/organization/organization-form";
import { useOrganizationNames } from "./organization-names";
import { ThemePreferenceControl } from "@/components/ui/theme-preference";
import { SelectMenu } from "@/components/ui/select-menu";

export function OrganizationSwitcher({
  organizationId,
  organizations,
  user,
  canCreateOrganization,
}: {
  organizationId: string;
  organizations: { id: string; name: string; logo?: string | null }[];
  user: { id: string; name: string; image?: string | null };
  canCreateOrganization: boolean;
}) {
  const id = useId();
  const dropdown = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const { names, profileName, images } = useOrganizationNames();
  const currentOrganizations = organizations.map((org) => ({
    ...org,
    name: names[org.id] ?? org.name,
  }));
  const profilePath = avatarPath("user", user.id);
  const profileImage = profilePath in images ? images[profilePath] : user.image;
  const organizationPath = avatarPath("organization", organizationId);
  const active = currentOrganizations.find((org) => org.id === organizationId);

  async function switchOrganization(id: string) {
    if (pending || id === organizationId) return;
    setPending(true);
    setError("");
    try {
      const result = await authClient.organization.setActive({ organizationId: id });
      if (result.error) throw new Error(result.error.message || "Unable to switch organization.");
      posthog.capture("organization_switched");
      await navigateWithFreshSession("/files");
    } catch (error) {
      unstable_rethrow(error);
      setError(error instanceof Error ? error.message : "Unable to switch organization.");
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-label={`Switch organization, ${active?.name ?? "Organization"}`}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-ink hover:bg-hover-surface active:bg-pressed-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="relative shrink-0">
          <Avatar
            image={organizationPath in images ? images[organizationPath] : active?.logo}
            name={active?.name ?? ""}
            square
            className="size-8 text-xs"
          />
          <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-surface">
            <Avatar
              image={profileImage}
              name={profileName ?? user.name}
              className="size-4 text-[9px]"
            />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-5 font-medium">{active?.name}</span>
          <span className="block truncate text-xs leading-4 text-muted-ink">
            {profileName ?? user.name}
          </span>
        </span>
        <svg
          aria-hidden="true"
          className="shrink-0 text-secondary-ink"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div
        ref={dropdown}
        id={id}
        popover="auto"
        aria-label="Organizations"
        className="org-switcher-popover z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-primary-grey bg-primary-white p-1.5 text-primary-black shadow-lg"
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <SelectMenu
            label="Organization"
            value={organizationId}
            options={currentOrganizations.map((org) => ({ value: org.id, label: org.name }))}
            onChange={switchOrganization}
            disabled={pending}
            className="flex-1"
            placement="top"
          />
          {canCreateOrganization && (
            <button
              type="button"
              aria-label="Create organization"
              title="Create organization"
              disabled={pending}
              onClick={() => {
                dropdown.current?.hidePopover();
                setCreating(true);
                dialog.current?.showModal();
              }}
              className="flex size-10 shrink-0 items-center justify-center rounded-lg text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50"
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 3v10M3 8h10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-1 border-t border-primary-grey pt-1">
          <ThemePreferenceControl compact />
          <div className="px-3 py-2">
            <SignOutButton />
          </div>
        </div>
      </div>
      {canCreateOrganization && (
        <Dialog
          ref={dialog}
          aria-labelledby={`${id}-create-title`}
          onClose={() => setCreating(false)}
          onCancel={(event) => {
            if (createPending) event.preventDefault();
          }}
          size="sm"
        >
          <div className="flex items-center justify-between gap-4">
            <h2 id={`${id}-create-title`} className="text-lg font-semibold">
              Create organization
            </h2>
            <button
              type="button"
              aria-label="Close"
              disabled={createPending}
              onClick={() => dialog.current?.close()}
              className="size-8 rounded-lg text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
            >
              ×
            </button>
          </div>
          {creating && <OrganizationForm inviteTeam={false} onPendingChange={setCreatePending} />}
        </Dialog>
      )}
    </>
  );
}
