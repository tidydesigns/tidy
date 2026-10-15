"use client";

import { unstable_rethrow } from "next/navigation";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { Dialog } from "@/components/ui/dialog";
import { useId, useRef, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { organizationConfirmationHeader } from "@/lib/organizations/constants";
import { TextField } from "@/components/ui/text-field";
import { NavigationLink } from "@/components/ui/navigation-link";

export function DeleteOrganization({
  organization,
  returnToAccount = false,
}: {
  organization: { id: string; name: string };
  returnToAccount?: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [billingRequired, setBillingRequired] = useState(false);

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || confirmation !== organization.name) return;
    setPending(true);
    setError("");
    setBillingRequired(false);
    try {
      const result = await authClient.organization.delete({
        organizationId: organization.id,
        fetchOptions: {
          headers: { [organizationConfirmationHeader]: encodeURIComponent(confirmation) },
        },
      });
      if (result.error) {
        setBillingRequired(result.error.code === "ORGANIZATION_BILLING_REQUIRED");
        throw new Error(result.error.message || "Unable to delete organization.");
      }
      // Workspace pages resolve another membership, or show the account options.
      await navigateWithFreshSession(returnToAccount ? "/account/privacy" : "/files");
    } catch (error) {
      unstable_rethrow(error);
      setError(error instanceof Error ? error.message : "Unable to delete organization.");
      setPending(false);
    }
  }

  return (
    <div className="mt-10 border-t border-primary-grey pt-6">
      <button
        data-ph-public
        type="button"
        onClick={() => {
          setConfirmation("");
          setError("");
          setBillingRequired(false);
          dialog.current?.showModal();
        }}
        className="rounded-lg border border-danger/25 px-4 py-2.5 text-sm font-medium text-danger hover:bg-danger/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
      >
        Delete organization
      </button>
      <Dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          <span data-ph-public style={{ display: "contents" }}>
            Delete{" "}
          </span>
          {organization.name}
          <span data-ph-public style={{ display: "contents" }}>
            ?
          </span>
        </h2>
        <p data-ph-public id={`${id}-description`} className="mt-3 text-sm text-secondary-ink">
          This permanently deletes the organization, its files, folders and team access for
          everyone. This cannot be undone.
        </p>
        <form onSubmit={remove} className="mt-6 space-y-4">
          <TextField
            id={`${id}-name`}
            label={`Enter “${organization.name}” to confirm`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            autoFocus
            required
            disabled={pending}
          />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {billingRequired && (
            <NavigationLink
              href={`/settings?tab=billing&organization=${encodeURIComponent(organization.id)}${returnToAccount ? "&returnTo=account" : ""}`}
              onNavigate={() => dialog.current?.close()}
              className="inline-flex min-h-9 items-center text-sm underline underline-offset-4"
            >
              <span data-ph-public style={{ display: "contents" }}>
                Open Billing
              </span>
            </NavigationLink>
          )}
          <div className="flex justify-end gap-3">
            <button
              data-ph-public
              type="button"
              disabled={pending}
              onClick={() => dialog.current?.close()}
              className="rounded-lg px-4 py-2.5 text-sm hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              data-ph-public
              type="submit"
              disabled={pending || confirmation !== organization.name}
              className="rounded-lg bg-danger-fill px-4 py-2.5 text-sm font-medium text-on-danger hover:bg-danger-fill-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Deleting…" : "Delete organization"}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
