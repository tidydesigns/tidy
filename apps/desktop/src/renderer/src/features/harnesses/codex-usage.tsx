import { BankedResetDisclosure } from "./banked-reset-disclosure";
import type { HarnessUsage } from "../../../../shared/contracts/harness-usage";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import {
  availableResetCredits,
  type CodexUsage,
  type ResetSelection,
} from "../../../../shared/contracts/codex-usage";
import { WorkspaceRequestError } from "../../../../shared/contracts/workspace-response";
import "./codex-usage.css";

function resetExpiry(seconds: number | null) {
  if (seconds === null) return "No expiry";
  return `Expires ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(seconds * 1000))}`;
}

/** Exact reset selection lives inside the existing account-and-usage panel. */
export function CodexResetControls({
  api,
  projectId,
  onRedeemed,
  refreshing,
  fallbackResets,
}: {
  api: DesktopAPI;
  projectId: string;
  onRedeemed(): void;
  refreshing?: boolean;
  fallbackResets?: HarnessUsage["resets"];
}) {
  const [usage, setUsage] = useState<CodexUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discoveryUnsupported, setDiscoveryUnsupported] = useState(false);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState("");
  const [review, setReview] = useState<ResetSelection | null>(null);
  const [uncertain, setUncertain] = useState<ResetSelection | null>(null);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const working = useRef(false);
  const reading = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (working.current || reading.current) return;
    const current = ++generation.current;
    reading.current = true;
    setLoading(true);
    try {
      if (!api.codexUsage) throw new Error("Update Tidy to view banked reset details.");
      const next = await api.codexUsage(projectId);
      if (mounted.current && current === generation.current) {
        setDiscoveryUnsupported(false);
        setUsage(next);
        setNow(Date.now());
        setError("");
        setStale(false);
      }
    } catch (cause) {
      if (mounted.current && current === generation.current) {
        setDiscoveryUnsupported(
          cause instanceof WorkspaceRequestError &&
            /^(Unknown|Invalid) desktop request\.$/.test(cause.message),
        );
        setError(cause instanceof Error ? cause.message : "Couldn’t refresh Codex usage.");
        setStale(true);
      }
    } finally {
      reading.current = false;
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    if (refreshing) void refresh();
  }, [refreshing, refresh]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    const focus = () => {
      setNow(Date.now());
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);

  // Nothing counts down on screen: rerender at an actual expiry/reset boundary, not every second.
  useEffect(() => {
    const deadlines = [
      ...(usage?.resets?.credits ?? []).map((credit) => credit.expiresAt),
      ...(usage?.windows ?? []).map((window) => window.resetsAt),
      review?.expiresAt,
      uncertain?.expiresAt,
    ].filter((value): value is number => value != null && value * 1000 > now);
    if (!deadlines.length) return;
    const delay = Math.min(...deadlines) * 1000 - Date.now() + 20;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, delay)));
    return () => clearTimeout(timer);
  }, [usage, review, uncertain, now]);

  const credits = usage ? availableResetCredits(usage, now) : [];
  const complete = usage?.resets?.credits?.length === usage?.resets?.availableCount;
  const selected =
    credits.find((credit) => credit.id === choice) ??
    (!choice && complete ? credits[0] : undefined);
  const pending = uncertain ?? usage?.pendingReset;
  const selection = pending ?? review;
  const expired =
    selection?.expiresAt !== null &&
    selection?.expiresAt !== undefined &&
    selection.expiresAt * 1000 <= now;
  const changedAccount = selection && usage && usage.accountKey !== selection.accountKey;
  const unavailable = !usage || !!usage.redemptionUnavailable || !!usage.resetDetailsError || stale;

  async function redeem(attempt: ResetSelection) {
    if (working.current) return;
    working.current = true;
    ++generation.current;
    setLoading(false);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!api.consumeCodexReset) throw new Error("Update Tidy to redeem banked resets.");
      const result = await api.consumeCodexReset(projectId, attempt);
      onRedeemed();
      if (!mounted.current) return;
      setUsage(result.usage);
      setStale(!result.usage);
      if (result.outcome === "unconfirmed") {
        setUncertain(attempt);
        setNotice(
          "Codex hasn’t confirmed the result. Retry the same reset safely; another reset won’t be selected.",
        );
      } else {
        setUncertain(null);
        setReview(null);
        setChoice("");
        setNotice(
          result.outcome === "reset" || result.outcome === "alreadyRedeemed"
            ? `Reset applied. ${result.usage ? "Usage refreshed from Codex." : "Refresh to see your updated usage."}`
            : result.outcome === "nothingToReset"
              ? "No eligible usage window to reset. No reset was used."
              : "Codex reported no available reset credit. Refresh and review your resets.",
        );
      }
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "Couldn’t confirm the reset.");
      // A transport failure may happen after the host consumed the reset. Keep its exact retry key.
      if (!(cause instanceof WorkspaceRequestError)) setUncertain(attempt);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (discoveryUnsupported && !selection) return <BankedResetDisclosure resets={fallbackResets} />;

  if (
    usage &&
    (!usage.resets || usage.resets.availableCount === 0) &&
    !pending &&
    !notice &&
    !error
  )
    return null;

  return (
    <details className="account-usage-section account-usage-disclosure codex-reset-panel">
      <summary>
        Banked resets
        <span>{usage?.resets ? `${usage.resets.availableCount} available` : "Checking…"}</span>
      </summary>
      <div className="account-usage-reset-list">
        {loading && <small>Refreshing…</small>}
        {usage && (
          <small>
            Checked{" "}
            {new Date(usage.checkedAt).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short",
            })}
            {stale ? " · refresh needed" : ""}
          </small>
        )}
        {error && (
          <p role="alert" className="codex-usage-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!usage && !error && !notice && <p role="status">Loading usage…</p>}
        {usage && (
          <>
            <section className="codex-reset-section" aria-label="Banked resets">
              {usage.resets && <p>{usage.resets.availableCount} available</p>}
              {usage.redemptionUnavailable && <p>{usage.redemptionUnavailable}</p>}
              {usage.resetDetailsError && <p role="alert">{usage.resetDetailsError}</p>}
              {!usage.resets ? (
                <p>Codex hasn’t reported banked resets for this account.</p>
              ) : usage.resets.availableCount === 0 && !pending ? (
                <p>No banked resets available.</p>
              ) : (
                !selection && (
                  <>
                    {credits.length > 0 ? (
                      <>
                        {!complete && (
                          <p>
                            Showing {credits.length} of {usage.resets.availableCount} resets. Choose
                            the specific reset to use; other expiry dates are unavailable.
                          </p>
                        )}
                        <SelectMenu
                          label="Reset to use"
                          value={selected?.id ?? ""}
                          options={[
                            ...(!selected
                              ? [{ value: "", label: "Choose a reset", disabled: true }]
                              : []),
                            ...credits.map((credit) => ({
                              value: credit.id,
                              label: resetExpiry(credit.expiresAt),
                              description: `Granted ${new Date(credit.grantedAt * 1000).toLocaleDateString()}`,
                            })),
                          ]}
                          onChange={setChoice}
                        />
                        {complete && selected?.id === credits[0]?.id && credits.length > 1 && (
                          <small>Earliest expiry selected first.</small>
                        )}
                        <Button
                          className="codex-reset-button"
                          disabled={unavailable || !selected || busy}
                          onClick={() => {
                            if (!selected || !usage.accountKey) return;
                            setNotice("");
                            setReview({
                              accountKey: usage.accountKey,
                              creditId: selected.id,
                              expiresAt: selected.expiresAt,
                              idempotencyKey: crypto.randomUUID(),
                            });
                          }}
                        >
                          Use reset…
                        </Button>
                      </>
                    ) : (
                      <p>
                        {usage.resets.credits === null
                          ? "Reset details are unavailable. Refresh to check which reset expires first."
                          : "No unexpired, available reset details were returned. Refresh to check again."}
                      </p>
                    )}
                  </>
                )
              )}
            </section>
          </>
        )}
        {selection && (
          <section
            className="codex-reset-review"
            aria-label={pending ? "Unconfirmed reset" : "Confirm reset"}
          >
            <strong>{pending ? "Finish this reset" : "Use this banked reset?"}</strong>
            <p>{resetExpiry(selection.expiresAt)}</p>
            <p>
              {pending
                ? "Retrying checks the same redemption. It won’t spend a different reset."
                : "Uses one banked reset if Codex has an eligible usage window to reset."}
            </p>
            {!pending && expired && (
              <p role="alert">This reset has expired. Refresh and choose another.</p>
            )}
            {changedAccount && (
              <p role="alert">Your Codex account changed. Switch back to finish this reset.</p>
            )}
            <div className="codex-reset-actions">
              {!pending && (
                <Button className="quiet-button" disabled={busy} onClick={() => setReview(null)}>
                  Cancel
                </Button>
              )}
              <Button
                className="codex-reset-button"
                disabled={
                  busy ||
                  !!changedAccount ||
                  (!pending && (expired || unavailable)) ||
                  !!usage?.redemptionUnavailable
                }
                onClick={() => void redeem(selection)}
              >
                {busy ? "Applying reset…" : pending ? "Retry same reset" : "Use this reset"}
              </Button>
            </div>
          </section>
        )}
      </div>
    </details>
  );
}
