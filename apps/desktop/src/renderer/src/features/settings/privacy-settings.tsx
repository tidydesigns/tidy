import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { AnalyticsChoices, AnalyticsState } from "@tidy/design/analytics";

/** Local choices render immediately; stale reads/actions cannot undo the user's next choice. */
export function PrivacySettings() {
  const api = window.tidy?.analytics;
  const [state, setState] = useState<AnalyticsState>();
  const current = useRef(state);
  const [error, setError] = useState("");
  const [separate, setSeparate] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const mutation = useRef(0);
  const pushed = useRef(0);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const receive = (value: AnalyticsState) => {
      if (!mounted) return;
      current.current = value;
      setState(value);
    };
    const unsubscribe = api.subscribe((value) => {
      pushed.current++;
      receive(value);
    });
    const read = () => {
      const generation = mutation.current;
      const revision = pushed.current;
      void api
        .state()
        .then((value) => {
          if (generation === mutation.current && revision === pushed.current) receive(value);
        })
        .catch(() => {
          if (mounted) setError("Privacy choices are unavailable. Sharing stays off.");
        });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", read);
    };
  }, [api]);
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
      choices.usage === current.current.usage &&
      choices.diagnostics === current.current.diagnostics
    )
      return;
    const generation = ++mutation.current;
    const next = { ...current.current, ...choices, linked: false };
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
    if (current.current)
      choose({
        usage: current.current.usage,
        diagnostics: current.current.diagnostics,
        [purpose]: !current.current[purpose],
      });
  }
  async function action(kind: "link" | "unlink" | "erase") {
    const generation = ++mutation.current;
    setError("");
    if (kind !== "link" && current.current) {
      const next = {
        ...current.current,
        linked: false,
        ...(kind === "erase" ? { usage: false, diagnostics: false } : {}),
      };
      current.current = next;
      setState(next);
    }
    try {
      await api![kind]();
      const value = await api!.state();
      if (generation === mutation.current) {
        current.current = value;
        setState(value);
      }
    } catch {
      if (generation === mutation.current)
        setError("Could not complete this action. Please retry.");
    }
  }
  async function download() {
    setError("");
    try {
      const text = await api!.reports();
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tidy-privacy-reports.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Could not download reports. Try again shortly or contact support.");
    }
  }
  const accepted = state?.usage && state.diagnostics;
  const denied = state && !state.usage && !state.diagnostics;
  return (
    <section className="settings-privacy" aria-labelledby="privacy-reports-title">
      <h2 id="privacy-reports-title">Optional reports</h2>
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
      <div className="settings-privacy-data">
        <Button
          className="settings-privacy-disclosure"
          aria-expanded={dataOpen}
          aria-controls="privacy-data"
          onClick={() => setDataOpen(!dataOpen)}
        >
          <span className="settings-disclosure-mark" aria-hidden="true">
            {dataOpen ? "−" : "+"}
          </span>
          Your data
        </Button>
        <div id="privacy-data" hidden={!dataOpen}>
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
          <div className="settings-privacy-data-actions">
            <Button
              className="settings-privacy-link"
              onClick={() => {
                void download();
              }}
            >
              Download my reports
            </Button>
            <Button
              className="settings-privacy-link settings-privacy-delete"
              onClick={() => {
                void action("erase");
              }}
            >
              Delete reports and stop sharing
            </Button>
          </div>
        </div>
      </div>
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
