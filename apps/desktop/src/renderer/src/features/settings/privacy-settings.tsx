import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { AnalyticsChoices, AnalyticsState } from "@tidy/design/analytics";

/** Choices update immediately; serialized persistence cannot undo a subsequent interaction. */
export function PrivacySettings() {
  const api = window.tidy?.analytics;
  const [state, setState] = useState<AnalyticsState>();
  const current = useRef(state);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    let mounted = true;
    const read = () => {
      const generation = sequence.current;
      void api
        ?.state()
        .then((value) => {
          if (mounted && generation === sequence.current) {
            current.current = value;
            setState(value);
          }
        })
        .catch(() => {});
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      mounted = false;
      window.removeEventListener("focus", read);
    };
  }, [api]);
  if (!api) return null;
  function choose(purpose: keyof AnalyticsChoices) {
    if (!current.current) return;
    const next = { ...current.current, [purpose]: !current.current[purpose] };
    current.current = next;
    setState(next);
    setError("");
    window.dispatchEvent(new Event("tidy-privacy-change"));
    const generation = ++sequence.current;
    void api!
      .choose({ usage: next.usage, diagnostics: next.diagnostics })
      .then((value) => {
        if (generation === sequence.current) {
          current.current = value;
          setState(value);
          window.dispatchEvent(new Event("tidy-privacy-change"));
        }
      })
      .catch(() => {
        if (generation === sequence.current)
          setError("Could not store this choice. Sharing stays off; please retry.");
      });
  }
  async function action(kind: "link" | "unlink" | "erase") {
    setError("");
    try {
      await api![kind]();
      const value = await api!.state();
      current.current = value;
      setState(value);
    } catch {
      setError("Could not complete this privacy action. Retry when online.");
    }
  }
  async function download() {
    try {
      const text = await api!.reports();
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tidy-usage-reports.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Could not download reports. Retry when online or contact the operator.");
    }
  }
  return (
    <section
      className="settings-account settings-privacy"
      id="settings-privacy"
      aria-labelledby="settings-privacy-title"
    >
      <h2 id="settings-privacy-title">Privacy</h2>
      <p>
        Local work needs no account or usage sharing. Reports exclude prompts, designs, filenames,
        paths and terminal output.
      </p>
      {(
        [
          [
            "usage",
            "Share usage statistics",
            "Measure return visits, app versions, harness use and design creation.",
          ],
          [
            "diagnostics",
            "Share technical diagnostics",
            "Send reviewed error categories, update outcomes and performance summaries.",
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
            onClick={() => choose(key)}
          >
            {state?.[key] ? "On" : "Off"}
          </Button>
        </div>
      ))}
      {state?.usage && (
        <div className="settings-privacy-row">
          <div>
            <h3>Link desktop and web usage</h3>
            <p>
              Optional. Confirm in your browser to link future usage to your account. Signing in
              alone does not enable linking.
            </p>
          </div>
          <Button
            className="secondary-button"
            onClick={() => void action(state.linked ? "unlink" : "link")}
          >
            {state.linked ? "Unlink" : "Link account…"}
          </Button>
        </div>
      )}
      <div className="settings-privacy-actions">
        <Button className="secondary-button" onClick={() => void download()}>
          Download my reports
        </Button>
        <Button className="secondary-button" onClick={() => void action("erase")}>
          Stop sharing and delete reports
        </Button>
        <Button className="secondary-button" onClick={() => void api.policy()}>
          Privacy policy
        </Button>
      </div>
      {error && (
        <p role="alert" className="settings-account-error">
          {error}
        </p>
      )}
    </section>
  );
}
