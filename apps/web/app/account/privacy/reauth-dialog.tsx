"use client";
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from "react";
import { SocialProviderButton } from "@/components/auth/social-provider-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";

export function ReauthDialog({
  email,
  onVerified,
  onCancel,
}: {
  email: string;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const popup = useRef<Window | null>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const closedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [methods, setMethods] = useState<{
    password: boolean;
    google: boolean;
    github: boolean;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void fetch("/api/privacy/reauth", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Your session has ended. Sign in to continue.");
        setMethods(await response.json());
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error.message ?? "Could not load authentication methods.");
      });
    return () => {
      controller.abort();
      requestAbort.current?.abort();
    };
  }, []);
  const notifyVerified = useEffectEvent(onVerified);
  useEffect(() => {
    function message(event: MessageEvent) {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup.current ||
        event.data?.type !== "tidy-privacy-reauth"
      )
        return;
      if (closedTimer.current) clearInterval(closedTimer.current);
      popup.current?.close();
      popup.current = null;
      setPending(false);
      if (event.data.success === true) notifyVerified();
      else setError("Verification was not completed. Try again with an account linked to Tidy.");
    }
    window.addEventListener("message", message);
    return () => {
      window.removeEventListener("message", message);
      if (closedTimer.current) clearInterval(closedTimer.current);
      popup.current?.close();
    };
  }, []);
  async function verify(provider: "password" | "google" | "github") {
    if (pending) return;
    setError("");
    if (provider !== "password") {
      popup.current = window.open(
        "about:blank",
        "tidy-privacy-reauth",
        "popup,width=500,height=650",
      );
      if (!popup.current) {
        setError("Allow the sign-in window, then try again.");
        return;
      }
    }
    setPending(true);
    const controller = new AbortController();
    requestAbort.current = controller;
    try {
      const response = await fetch("/api/privacy/reauth", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Tidy-Privacy": "1" },
        body: JSON.stringify(provider === "password" ? { provider, password } : { provider }),
      });
      const result = (await response.json()) as {
        error?: string;
        url?: string;
        verified?: boolean;
      };
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.error ?? "Could not authenticate. Try again.");
      setPassword("");
      if (provider === "password") {
        onVerified();
        return;
      }
      if (!result.url) throw new Error("Could not open sign-in.");
      popup.current!.location.href = result.url;
      closedTimer.current = setInterval(() => {
        if (popup.current?.closed) {
          if (closedTimer.current) clearInterval(closedTimer.current);
          popup.current = null;
          setPending(false);
          setError("Sign-in was closed. Try again when you're ready.");
        }
      }, 500);
    } catch (error) {
      if (controller.signal.aborted) return;
      popup.current?.close();
      popup.current = null;
      setError(error instanceof Error ? error.message : "Could not authenticate. Try again.");
      setPassword("");
      setPending(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void verify("password");
  }
  return (
    <Dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={onCancel}
    >
      <h2 data-ph-public id={`${id}-title`} className="text-lg font-semibold">
        Authenticate again
      </h2>
      <p data-ph-public id={`${id}-description`} className="my-4 text-sm text-secondary-ink">
        Confirm it&#39;s you to access your data or delete your account. You&#39;ll stay signed in.
      </p>
      <p className="mb-5 break-all text-sm font-medium">{email}</p>
      <div className="space-y-3">
        {(["google", "github"] as const)
          .filter((provider) => methods?.[provider])
          .map((provider) => (
            <SocialProviderButton
              key={provider}
              provider={provider}
              disabled={pending}
              onClick={() => void verify(provider)}
            />
          ))}
      </div>
      {methods?.password && (
        <form method="post" onSubmit={submit} className="space-y-4 mt-4">
          <TextField
            replayLabel
            id={`${id}-password`}
            label="Password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
          />
          <Button type="submit" disabled={pending || !password}>
            <span data-ph-public style={{ display: "contents" }}>
              {pending ? "Authenticating…" : "Authenticate"}
            </span>
          </Button>
        </form>
      )}
      {!methods && !error && (
        <p data-ph-public role="status" className="text-sm">
          Loading sign-in methods…
        </p>
      )}
      {methods && !methods.password && !methods.google && !methods.github && (
        <p data-ph-public className="text-sm text-secondary-ink">
          No linked sign-in method is currently available. Sign in again to continue.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="text"
        className="mt-5 min-h-11 text-sm font-medium text-secondary-ink hover:text-ink"
        onClick={() => dialog.current?.close()}
      >
        <span data-ph-public style={{ display: "contents" }}>
          Cancel
        </span>
      </Button>
    </Dialog>
  );
}
