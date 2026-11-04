"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@tidy/ui/button";
import {
  browserConsent,
  chooseConsent,
  ESSENTIAL_ONLY,
  subscribeConsent,
  type ConsentChoices,
} from "@tidy/ui/privacy-consent";
import {
  ANALYTICS_STATUS,
  linkWebsiteVisit,
  observeWebsiteSections,
  refreshWebsiteConsent,
  retryWebsiteConsent,
  startWebsiteAnalytics,
  websiteAnalyticsStatus,
  websiteCollectionEnabled,
  withdrawWebsiteConsent,
} from "../lib/website-analytics";
import styles from "./privacy-choices.module.css";

const openEvent = "tidy-website-privacy-choices";
const all: ConsentChoices = { analytics: true, replay: true, diagnostics: true };
const purposes = [
  {
    key: "analytics",
    label: "Usage analytics",
    description: "Page visits, clicks and traffic sources help us understand what works.",
  },
  {
    key: "replay",
    label: "Session replay",
    description:
      "Masked navigation, clicks and scrolling help us find usability problems. Inputs and the interactive demo are excluded.",
  },
  {
    key: "diagnostics",
    label: "Performance and errors",
    description: "Loading and interaction timings and technical errors help us fix problems.",
  },
] as const;

export function PrivacyChoicesButton() {
  return (
    <Button
      type="button"
      variant="text"
      className={styles.footerButton}
      onClick={(event) =>
        window.dispatchEvent(new CustomEvent(openEvent, { detail: event.currentTarget }))
      }
    >
      Privacy choices
    </Button>
  );
}

export function PrivacyChoices() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [customise, setCustomise] = useState(false);
  const [choices, setChoices] = useState<ConsentChoices>(ESSENTIAL_ONLY);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);

  useEffect(() => {
    startWebsiteAnalytics();
    const update = () => {
      const consent = browserConsent();
      setChoices(consent ?? ESSENTIAL_ONLY);
      if (!consent && websiteCollectionEnabled()) setVisible(true);
    };
    update();
    const open = (event: Event) => {
      trigger.current = (event as CustomEvent<HTMLButtonElement>).detail;
      setChoices(browserConsent() ?? ESSENTIAL_ONLY);
      setCustomise(false);
      setVisible(true);
    };
    const status = () => setFailed(websiteAnalyticsStatus() === "failed");
    status();
    const unsubscribe = subscribeConsent(update);
    window.addEventListener(openEvent, open);
    window.addEventListener(ANALYTICS_STATUS, status);
    return () => {
      unsubscribe();
      window.removeEventListener(openEvent, open);
      window.removeEventListener(ANALYTICS_STATUS, status);
    };
  }, []);

  useEffect(() => {
    if (visible) panel.current?.focus({ preventScroll: true });
  }, [visible]);

  useEffect(() => {
    let disconnect = () => {};
    const observe = () => {
      disconnect();
      disconnect = observeWebsiteSections();
      linkWebsiteVisit();
    };
    observe();
    window.addEventListener(ANALYTICS_STATUS, observe);
    return () => {
      disconnect();
      window.removeEventListener(ANALYTICS_STATUS, observe);
    };
  }, [pathname]);

  function close() {
    setVisible(false);
    trigger.current?.focus({ preventScroll: true });
  }

  function choose(next: ConsentChoices, dismiss = false) {
    setChoices(next);
    setError("");
    const remembered = chooseConsent(next);
    if (!remembered) {
      setError("Your browser could not remember this choice. Optional collection stays off.");
      void withdrawWebsiteConsent();
      return;
    }
    void refreshWebsiteConsent();
    if (dismiss) close();
  }

  return (
    <>
      {visible && (
        <aside
          ref={panel}
          tabIndex={-1}
          aria-labelledby="website-privacy-title"
          className={`${styles.panel} ph-no-capture`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className={styles.heading}>
            <h2 id="website-privacy-title">Privacy choices</h2>
            <Button
              type="button"
              variant="text"
              className={styles.close}
              aria-label="Close privacy choices"
              onClick={close}
            >
              ×
            </Button>
          </div>
          <p>
            We use optional analytics and masked session replay to understand how people use Tidy
            and improve it. <a href="/privacy">Privacy policy</a>
          </p>
          {customise && (
            <div id="website-privacy-options" className={styles.options}>
              {purposes.map(({ key, label, description }) => (
                <div key={key} className={styles.purpose}>
                  <div>
                    <span id={`website-${key}-label`}>{label}</span>
                    <p id={`website-${key}-description`}>{description}</p>
                  </div>
                  <Button
                    type="button"
                    role="switch"
                    aria-checked={choices[key]}
                    aria-labelledby={`website-${key}-label`}
                    aria-describedby={`website-${key}-description`}
                    className={styles.toggle}
                    onClick={() => choose({ ...choices, [key]: !choices[key] })}
                  >
                    {choices[key] ? "On" : "Off"}
                  </Button>
                </div>
              ))}
              <p className={styles.scope}>
                These choices apply to this website. The web app has its own privacy choices.
              </p>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <div className={styles.actions}>
            <Button type="button" className={styles.action} onClick={() => choose(all, true)}>
              Accept all
            </Button>
            <Button
              type="button"
              className={styles.action}
              onClick={() => choose(ESSENTIAL_ONLY, true)}
            >
              Reject all
            </Button>
          </div>
          <Button
            type="button"
            variant="text"
            className={styles.customise}
            aria-expanded={customise}
            aria-controls={customise ? "website-privacy-options" : undefined}
            onClick={() => setCustomise((value) => !value)}
          >
            Customise
          </Button>
        </aside>
      )}
      {failed && !visible && (
        <div role="status" className={`${styles.notice} ph-no-capture`}>
          Optional collection stays off while we confirm your choice.{" "}
          <Button
            type="button"
            variant="text"
            className={styles.footerButton}
            onClick={() => void retryWebsiteConsent()}
          >
            Retry
          </Button>
        </div>
      )}
    </>
  );
}
