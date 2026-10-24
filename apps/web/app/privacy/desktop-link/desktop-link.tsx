"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { NavigationLink } from "@/components/ui/navigation-link";
export function DesktopLink({ account }: { account: string | null }) {
  const challenge = useSearchParams().get("challenge");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/privacy/desktop-analytics-link", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-tidy-privacy": "1" },
        body: JSON.stringify({ action: "link", challenge }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Sign in, then reopen the link from desktop."
            : "This request expired or could not be completed. Start linking again from desktop.",
        );
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not link usage.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-lg space-y-5 px-6 py-16">
      <h1 className="text-xl font-medium">Link desktop and web usage</h1>
      {done ? (
        <p>
          Linked. Return to Tidy desktop. You can unlink in desktop Privacy settings or your account
          privacy controls.
        </p>
      ) : (
        <>
          <p>
            This optional choice links future desktop usage statistics to the account signed in
            here. Web activity is included only when you allow web usage analytics. It does not link
            earlier desktop activity or enable diagnostics.
          </p>
          <p>
            Reports exclude prompts, designs, filenames and paths. You can keep using desktop
            without linking.
          </p>
          {account && (
            <p>
              Link to <span className="ph-no-capture">{account}</span>.
            </p>
          )}
          {account && challenge && /^[a-f0-9]{64}$/.test(challenge) ? (
            <Button disabled={busy} onClick={() => void confirm()}>
              {busy ? "Linking…" : "Allow account linking"}
            </Button>
          ) : (
            <p>
              {account
                ? "Start this request from desktop Privacy settings."
                : "Sign in before confirming this request."}
            </p>
          )}
          {!account && (
            <NavigationLink
              href={`/login?next=${encodeURIComponent(`/privacy/desktop-link?challenge=${challenge ?? ""}`)}`}
              className="block underline"
            >
              Sign in to your account
            </NavigationLink>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
