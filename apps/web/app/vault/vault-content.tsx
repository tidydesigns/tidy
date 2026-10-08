"use client";

import { Dialog } from "@/components/ui/dialog";
import { useRef, useState, type FormEvent } from "react";
import posthog from "posthog-js";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { EditLogin } from "./edit-login";
import { addVaultLogin, removeVaultLogin } from "./actions";

export function VaultContent({ logins }: { logins: { id: string; name: string }[] }) {
  const [currentLogins, setLogins] = useState(logins);
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  function resetDialog() {
    dialog.current?.querySelector("form")?.reset();
    setError("");
    setShowPassword(false);
  }

  function close() {
    dialog.current?.close();
    resetDialog();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");

    const form = event.currentTarget;
    try {
      const result = await addVaultLogin(new FormData(form));
      if (!result.ok) {
        setError(result.error || "Could not save this login.");
        return;
      }
      form.reset();
      close();
      const login = result.login;
      if (login) {
        setLogins((current) => [login, ...current]);
        posthog.capture("vault_login_created");
      }
    } catch {
      setError("Could not save this login. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">Vault</h1>
        <button
          type="button"
          onClick={() => dialog.current?.showModal()}
          className="rounded-lg bg-strong-action px-4 py-2.5 text-sm font-medium text-on-strong-action hover:bg-strong-action-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
        >
          + New login
        </button>
      </div>
      {currentLogins.length === 0 ? (
        <p className="pt-9 text-sm text-secondary-ink">No logins saved.</p>
      ) : (
        <ul className="mt-9 divide-y divide-primary-grey/70">
          {currentLogins.map((login) => (
            <li
              key={login.id}
              className="flex items-center justify-between gap-4 py-5 text-sm font-medium"
            >
              <span className="ph-mask break-all">{login.name}</span>
              <div className="flex items-center gap-4">
                <EditLogin
                  login={login}
                  onRename={(id, name) =>
                    setLogins((current) =>
                      current.map((item) => (item.id === id ? { ...item, name } : item)),
                    )
                  }
                />
                <ConfirmAction
                  label="Delete login"
                  title="Delete login?"
                  onConfirm={async () => {
                    const result = await removeVaultLogin(login.id);
                    if (result.error) throw new Error(result.error);
                    setLogins((current) => current.filter((item) => item.id !== login.id));
                  }}
                >
                  This permanently deletes the stored credentials.
                </ConfirmAction>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        ref={dialog}
        aria-labelledby="add-login-title"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onClose={resetDialog}
        size="lg"
        padded={false}
      >
        <div className="relative border-b border-primary-grey/50 px-6 py-7 text-center sm:px-10">
          <h2 id="add-login-title" className="text-2xl font-semibold tracking-tight">
            Add login
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label="Close"
            className="absolute right-5 top-5 rounded p-1 focus-visible:outline-2 focus-visible:outline-primary-orange"
          >
            <Icon name="xmark" />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="space-y-5 px-6 py-8 sm:px-10">
            <div className="space-y-2">
              <label htmlFor="vault-name" className="block text-sm font-medium">
                Name
              </label>
              <input
                id="vault-name"
                name="name"
                placeholder="e.g. Gmail"
                maxLength={100}
                autoFocus
                required
                className="h-12 w-full rounded-lg border border-primary-grey bg-transparent px-4 text-sm outline-none placeholder:text-secondary-ink focus-visible:border-primary-black focus-visible:ring-2 focus-visible:ring-primary-orange"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="vault-username" className="block text-sm font-medium">
                Username or email
              </label>
              <input
                id="vault-username"
                name="username"
                autoComplete="off"
                maxLength={320}
                required
                className="h-12 w-full rounded-lg border border-primary-grey bg-transparent px-4 text-sm outline-none focus-visible:border-primary-black focus-visible:ring-2 focus-visible:ring-primary-orange"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="vault-password" className="block text-sm font-medium">
                Password
              </label>
              <div className="relative">
                <input
                  id="vault-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  maxLength={4096}
                  required
                  className="h-12 w-full rounded-lg border border-primary-grey bg-transparent px-4 pr-12 text-sm outline-none focus-visible:border-primary-black focus-visible:ring-2 focus-visible:ring-primary-orange"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-3 flex items-center rounded px-1 focus-visible:outline-2 focus-visible:outline-primary-orange"
                >
                  <Icon name="eye" />
                </button>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-primary-black">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3 border-t border-primary-grey/50 px-6 py-5 sm:px-10">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded-lg border border-primary-grey px-5 py-2.5 text-sm font-medium hover:bg-primary-grey/20"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-primary-orange px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-primary-orange/90 disabled:opacity-60"
            >
              {pending ? "Adding…" : "Add login"}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
