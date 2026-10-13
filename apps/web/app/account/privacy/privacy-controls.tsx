"use client";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { authClient, resetPostHogUser } from "@/lib/auth-client";

export function PrivacyControls({ email }: { email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reauth, setReauth] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  async function request(operation: "delete" | "export") {
    const response = await fetch(`/api/privacy/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tidy-Privacy": "1" },
      body: JSON.stringify(operation === "delete" ? { confirmation } : {}),
    });
    if (!response.ok) {
      if (response.status === 401) setReauth(true);
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(result?.error ?? "Could not complete your request. Please try again.");
    }
    return response;
  }
  async function download() {
    if (pending) return;
    setPending(true);
    setError("");
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
      setError(error instanceof Error ? error.message : "Download failed.");
    } finally {
      setPending(false);
    }
  }
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await request("delete");
      resetPostHogUser();
      await authClient.signOut().catch(() => {});
      window.location.replace("/login?deleted=1");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Deletion failed.");
      setPending(false);
    }
  }
  async function signInAgain() {
    setPending(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Could not sign out. Please try again.");
      resetPostHogUser();
      router.push("/login?next=/account/privacy");
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not sign out.");
      setPending(false);
    }
  }
  const status = (
    <>
      {error && (
        <p role="alert" className="my-4 text-sm text-danger">
          {error}
        </p>
      )}
      {reauth && (
        <Button variant="text" disabled={pending} onClick={() => void signInAgain()}>
          Sign out and sign in again
        </Button>
      )}
    </>
  );
  return (
    <div className="space-y-10">
      <p className="text-sm text-secondary-ink">
        For your security, exporting or deleting your account requires a sign-in within the last
        five minutes.
      </p>
      <section aria-labelledby={`${id}-export`} className="space-y-4">
        <h2 id={`${id}-export`} className="text-xl font-semibold">
          Export personal data
        </h2>
        <p className="text-sm text-secondary-ink">
          Download your profile, memberships, comments, connections, agent conversations and designs
          you created, plus feedback stored in Tidy, as JSON. Passwords and access tokens are
          excluded. Export complete design files with images from the editor. For historical
          analytics, legacy feedback or other records held outside Tidy, contact the operator.
        </p>
        <Button disabled={pending} onClick={() => void download()}>
          {pending ? "Working…" : "Download my data"}
        </Button>
        <p role="status" className="text-sm">
          {message}
        </p>
      </section>
      <section aria-labelledby={`${id}-delete`} className="space-y-4">
        <h2 id={`${id}-delete`} className="text-xl font-semibold">
          Delete account
        </h2>
        <p className="text-sm text-secondary-ink">
          Permanently delete your account, personal credentials and comments, and revoke all
          sessions and agent access. Shared designs remain with the organization under “Deleted
          user”. Transfer ownership or delete organizations where you are the last owner first.
          External storage and analytics cleanup continues after your account closes.
        </p>
        <Button
          variant="text"
          className="min-h-11 rounded-md text-sm font-medium text-danger hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4"
          disabled={pending}
          onClick={() => {
            setError("");
            setConfirmation("");
            setDialogOpen(true);
            dialog.current?.showModal();
          }}
        >
          Delete my account
        </Button>
      </section>
      {!dialogOpen && status}
      <Dialog
        ref={dialog}
        onClose={() => setDialogOpen(false)}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 id={`${id}-title`} className="text-xl font-semibold">
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
