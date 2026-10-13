"use client";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { NavigationLink } from "@/components/ui/navigation-link";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { authClient, resetPostHogUser } from "@/lib/auth-client";
import { ReauthDialog } from "./reauth-dialog";

class ReauthRequired extends Error {}
class OwnershipRequired extends Error {}

type BlockingOrganization = { id: string; name: string };

function OwnershipAlert({
  organizations,
  onClose,
}: {
  organizations: BlockingOrganization[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    dialog.current?.showModal();
    document.getElementById(`${id}-cancel`)?.focus();
  }, [id]);
  return (
    <Dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={onClose}
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Resolve organization ownership first
      </h2>
      <p id={`${id}-description`} className="my-4 text-sm text-secondary-ink">
        You’re the last owner of{" "}
        {organizations.length === 1 ? "this organization" : "these organizations"}. Before you can
        delete your account, delete {organizations.length === 1 ? "it" : "each one"} or transfer
        ownership to another member in organization settings. Your account has not been deleted.
      </p>
      <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <NavigationLink
              href={`/settings?tab=organization&organization=${encodeURIComponent(organization.id)}&returnTo=account`}
              onNavigate={() => dialog.current?.close()}
              className="inline-flex min-h-9 items-center underline underline-offset-4"
            >
              Open {organization.name} settings
            </NavigationLink>
          </li>
        ))}
      </ul>
      <Button id={`${id}-cancel`} className="mt-6" onClick={() => dialog.current?.close()}>
        Cancel
      </Button>
    </Dialog>
  );
}

export function PrivacyControls({ email }: { email: string }) {
  const [operation, setOperation] = useState<"export" | "check-delete" | "delete" | null>(null);
  const pending = operation !== null;
  const [organizations, setOrganizations] = useState<BlockingOrganization[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [authOperation, setAuthOperation] = useState<"delete" | "export" | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  async function request(operation: "delete" | "export", checkOnly = false) {
    const response = await fetch(
      checkOnly ? "/api/privacy/reauth?check=1" : `/api/privacy/${operation}`,
      checkOnly
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Tidy-Privacy": "1",
            },
            body: JSON.stringify(operation === "delete" ? { confirmation } : {}),
          },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        organizations?: { id: string; name: string }[];
      } | null;
      if (result?.code === "ORGANIZATION_OWNERSHIP_REQUIRED") {
        dialog.current?.close();
        setOrganizations(result.organizations ?? []);
        if (result.organizations?.length) throw new OwnershipRequired();
      }
      if (result?.code === "REAUTH_REQUIRED") {
        dialog.current?.close();
        setError("");
        setAuthOperation(operation);
        throw new ReauthRequired();
      }
      throw new Error(result?.error ?? "Could not complete your request. Please try again.");
    }
    return response;
  }
  function confirmDeletion() {
    setConfirmation("");
    setDialogOpen(true);
    dialog.current?.showModal();
  }
  async function beginDeletion() {
    if (pending) return;
    setOperation("check-delete");
    setError("");
    setOrganizations([]);
    try {
      await request("delete", true);
      confirmDeletion();
    } catch (error) {
      if (!(error instanceof ReauthRequired) && !(error instanceof OwnershipRequired))
        setError(
          error instanceof Error ? error.message : "Could not check authentication. Try again.",
        );
    } finally {
      setOperation(null);
    }
  }
  async function download() {
    if (pending) return;
    setOperation("export");
    setError("");
    setOrganizations([]);
    setMessage("");
    try {
      const response = await request("export");
      const data = await response.json();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tidy-personal-data.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage("Your personal data download is ready.");
    } catch (error) {
      if (!(error instanceof ReauthRequired) && !(error instanceof OwnershipRequired))
        setError(error instanceof Error ? error.message : "Download failed.");
    } finally {
      setOperation(null);
    }
  }
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setOperation("delete");
    setError("");
    try {
      await request("delete");
      resetPostHogUser();
      await authClient.signOut().catch(() => {});
      window.location.replace("/login?deleted=1");
    } catch (error) {
      if (!(error instanceof ReauthRequired) && !(error instanceof OwnershipRequired))
        setError(error instanceof Error ? error.message : "Deletion failed.");
      setOperation(null);
    }
  }
  function verified() {
    const operation = authOperation;
    setAuthOperation(null);
    setError("");
    if (operation === "export") void download();
    else {
      // Reauthentication never submits a destructive action automatically.
      void beginDeletion();
    }
  }
  const cancelAuth = useCallback(() => setAuthOperation(null), []);
  const status = (
    <>
      {error && (
        <p role="alert" className="my-4 text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
  return (
    <div id="account-data" className="scroll-mt-8 space-y-10">
      <section
        aria-labelledby={`${id}-export`}
        className="space-y-4 border-t border-primary-grey pt-6"
      >
        <h2 id={`${id}-export`} className="text-lg font-semibold">
          Export personal data
        </h2>
        <p className="text-sm text-secondary-ink">
          Download your profile, memberships, comments, connections, agent conversations and designs
          you created, plus feedback stored in Tidy, as JSON. Passwords and access tokens are
          excluded. Export complete design files with images from the editor. For historical
          analytics, legacy feedback or other records held outside Tidy, contact the operator. We’ll
          ask you to authenticate again when needed.
        </p>
        <Button disabled={pending} onClick={() => void download()}>
          {operation === "export" ? "Working…" : "Download my data"}
        </Button>
        <p role="status" className="text-sm">
          {message}
        </p>
      </section>
      <section
        aria-labelledby={`${id}-delete`}
        className="space-y-4 border-t border-primary-grey pt-6"
      >
        <h2 id={`${id}-delete`} className="text-lg font-semibold">
          Delete account
        </h2>
        <p className="text-sm text-secondary-ink">
          Permanently delete your account, personal credentials and comments, and revoke all
          sessions and agent access. Shared designs remain with the organization under “Deleted
          user”. Transfer ownership or delete organizations where you are the last owner first.
          External storage and analytics cleanup continues after your account closes.
        </p>
        <Button
          id={`${id}-delete-button`}
          variant="text"
          className="min-h-11 rounded-md text-sm font-medium text-danger hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4"
          disabled={pending}
          onClick={() => void beginDeletion()}
        >
          {operation === "check-delete" ? "Checking…" : "Delete my account"}
        </Button>
      </section>
      {!dialogOpen && status}
      {organizations.length > 0 && (
        <OwnershipAlert
          organizations={organizations}
          onClose={() => {
            setOrganizations([]);
            document.getElementById(`${id}-delete-button`)?.focus();
          }}
        />
      )}
      {authOperation && <ReauthDialog email={email} onVerified={verified} onCancel={cancelAuth} />}
      <Dialog
        ref={dialog}
        onClose={() => setDialogOpen(false)}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Permanently delete your account?
        </h2>
        <p id={`${id}-description`} className="my-4 text-sm">
          This cannot be undone. Download any data you need before continuing.
        </p>
        <form onSubmit={remove} className="space-y-4">
          <TextField
            id={`${id}-email`}
            label={`Enter ${email} to confirm`}
            type="email"
            autoComplete="email"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            disabled={pending}
          />
          {status}
          <div className="flex gap-4">
            <Button
              type="button"
              autoFocus
              disabled={pending}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || confirmation !== email}
              className="min-h-12 rounded-lg bg-danger-fill px-4 text-sm font-semibold text-on-danger focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {pending ? "Deleting…" : "Permanently delete account"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
