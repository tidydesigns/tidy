import {
  cachedAnalyticsState,
  readAnalyticsState,
  subscribeAnalyticsState,
  unexpiredAnalyticsState,
} from "./analytics-state";
import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { AnalyticsAPI, AnalyticsChoices, AnalyticsState } from "@tidy/design/analytics";

const readError = "Could not refresh privacy choices. Please try again.";

/** Local choices render immediately; stale reads/actions cannot undo the user's next choice. */
export function PrivacySettings({
  active = true,
  api = window.tidy?.analytics,
}: {
  active?: boolean;
  api?: AnalyticsAPI;
}) {
  const [storedState, setState] = useState<AnalyticsState | undefined>(() =>
    unexpiredAnalyticsState(cachedAnalyticsState(api)),
  );
  const state = unexpiredAnalyticsState(storedState);
  const current = useRef(state);
  const [error, setError] = useState("");
  const [separate, setSeparate] = useState(false);
  const mutation = useRef(0);
  const pushed = useRef(0);
  useEffect(() => {
    const expiresAt = storedState?.expiresAt;
    if (!expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const next = unexpiredAnalyticsState(current.current);
      if (next !== current.current) {
        current.current = next;
        setState(next);
      } else {
        timer = setTimeout(
          expire,
          Math.min(2_147_483_647, Math.max(1, Date.parse(expiresAt) - Date.now())),
        );
      }
    };
    timer = setTimeout(
      expire,
      Math.min(2_147_483_647, Math.max(1, Date.parse(expiresAt) - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [storedState?.expiresAt]);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const receive = (value: AnalyticsState) => {
      if (!mounted) return;
      const next = unexpiredAnalyticsState(value);
      current.current = next;
      setState(next);
      setError((previous) => (previous === readError ? "" : previous));
    };
    const unsubscribe = subscribeAnalyticsState(api, (value) => {
      pushed.current++;
      receive(value);
    });
    const read = () => {
      if (!active) return;
      const generation = mutation.current;
      const revision = pushed.current;
      void readAnalyticsState(api)
        .then((value) => {
          if (generation === mutation.current && revision === pushed.current) receive(value);
        })
        .catch(() => {
          if (mounted && generation === mutation.current && revision === pushed.current)
            setError(readError);
        });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", read);
    };
  }, [api, active]);
  if (!api)
    return (
      <p className="settings-privacy-unavailable">
        Privacy controls are available in the desktop app.
      </p>
    );

  function choose(choices: AnalyticsChoices) {
    if (!current.current) return;
    if (
      current.current.expiresAt &&
      Date.parse(current.current.expiresAt) > Date.now() &&
      choices.usage === current.current.usage &&
      choices.diagnostics === current.current.diagnostics
    )
      return;
    const generation = ++mutation.current;
    const next = { ...unexpiredAnalyticsState(current.current)!, ...choices, linked: false };
    current.current = next;
    setState(next);
    setError("");
    void api!
      .choose(choices)
      .then((value) => {
        if (generation === mutation.current) {
          current.current = value;
          setState(value);
        }
      })
      .catch(() => {
        if (generation === mutation.current) {
          const off = { ...next, usage: false, diagnostics: false };
          current.current = off;
          setState(off);
          setError("Could not store this choice. Sharing stays off; please retry.");
        }
      });
  }
  function toggle(purpose: keyof AnalyticsChoices) {
    const choices = unexpiredAnalyticsState(current.current);
    if (choices)
      choose({
        usage: choices.usage,
        diagnostics: choices.diagnostics,
        [purpose]: !choices[purpose],
      });
  }
  async function action(kind: "link" | "unlink") {
    const generation = ++mutation.current;
    setError("");
    if (kind !== "link" && current.current) {
      const next = {
        ...current.current,
        linked: false,
      };
      current.current = next;
      setState(next);
    }
    try {
      await api![kind]();
      const value = await readAnalyticsState(api!);
      if (generation === mutation.current) {
        current.current = value;
        setState(value);
      }
    } catch {
      if (generation === mutation.current)
        setError("Could not complete this action. Please retry.");
    }
  }
  const accepted = state?.usage && state.diagnostics;
  const denied = state && !state.usage && !state.diagnostics;
  return (
    <section className="settings-privacy" aria-labelledby="privacy-analytics-title">
      <h2 id="privacy-analytics-title">Analytics and diagnostics</h2>
      <p className="settings-privacy-intro">
        Usage statistics help improve features. Technical diagnostics help fix errors and slowdowns.
        Your designs, prompts and file paths are excluded.
      </p>
      <p className="settings-privacy-status" role="status">
        {!state
          ? "Loading your choices…"
          : accepted
            ? "Both enabled. Change your choice anytime."
            : denied
              ? "Both off. Tidy works normally without them."
              : "Custom choice. Change it anytime."}
      </p>
      <div className="settings-privacy-decisions" aria-label="Optional reporting choices">
        <Button
          className="settings-privacy-decision"
          aria-pressed={Boolean(accepted)}
          disabled={!state?.available}
          onClick={() => choose({ usage: true, diagnostics: true })}
        >
          Accept
        </Button>
        <Button
          className="settings-privacy-decision"
          aria-pressed={Boolean(denied)}
          disabled={!state?.available}
          onClick={() => choose({ usage: false, diagnostics: false })}
        >
          Deny
        </Button>
      </div>
      <Button
        className="settings-privacy-disclosure"
        aria-expanded={separate}
        aria-controls="privacy-purposes"
        onClick={() => setSeparate(!separate)}
      >
        <span className="settings-disclosure-mark" aria-hidden="true">
          {separate ? "−" : "+"}
        </span>
        Choose separately
      </Button>
      <div id="privacy-purposes" hidden={!separate}>
        {(
          [
            [
              "usage",
              "Usage statistics",
              "Active days, app versions, harness use and design activity.",
            ],
            [
              "diagnostics",
              "Technical diagnostics",
              "Error categories, update outcomes and coarse performance timings.",
            ],
          ] as const
        ).map(([key, label, description]) => (
          <div className="settings-privacy-row" key={key}>
            <div>
              <h3 id={`privacy-${key}`}>{label}</h3>
              <p>{description}</p>
            </div>
            <Button
              className="settings-privacy-switch"
              role="switch"
              aria-checked={state?.[key] ?? false}
              aria-labelledby={`privacy-${key}`}
              disabled={!state?.available}
              onClick={() => toggle(key)}
            >
              {state?.[key] ? "On" : "Off"}
            </Button>
          </div>
        ))}
        {state?.usage && (
          <div className="settings-privacy-row">
            <div>
              <h3>Link usage to your web account</h3>
              <p>
                {state.linked
                  ? "Linked for future usage. You can unlink anytime."
                  : "Optional. Confirm the account in your browser."}
              </p>
            </div>
            <Button
              className="settings-privacy-link"
              onClick={() => {
                void action(state.linked ? "unlink" : "link");
              }}
            >
              {state.linked ? "Unlink" : "Link account…"}
            </Button>
          </div>
        )}
        {state?.reference && (
          <p className="settings-privacy-reference">
            Privacy reference for support
            <code>{state.reference}</code>
          </p>
        )}
      </div>
      <p className="settings-privacy-policy">
        Off by default. No account needed.{" "}
        <Button
          className="settings-privacy-link"
          onClick={() => {
            void api.policy().catch(() => setError("Could not open the privacy policy."));
          }}
        >
          Privacy policy
        </Button>
      </p>
      {state?.pendingDeletion && (
        <p className="settings-privacy-notice" role="status">
          Previous reports are queued for deletion and will retry when online.
        </p>
      )}
      {state && !state.available && (
        <p className="settings-privacy-notice">Sharing is unavailable in this build.</p>
      )}
      {error && (
        <p role="alert" className="settings-privacy-error">
          {error}
        </p>
      )}
    </section>
  );
}
