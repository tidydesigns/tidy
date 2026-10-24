import { browserConsent, consentRevision } from "@/lib/privacy/consent";
import { recordBrowserConsent } from "@/lib/privacy/receipt-client";
/** First-party cross-surface reports need the existing browser usage consent too. */
export function captureWebProduct(name: string) {
  const consent = browserConsent();
  if (!consent?.analytics) return;
  const mapped =
    name === "design_file_created"
      ? { name, storage: "cloud", kind: "new" }
      : name === "product_active_day"
        ? { name }
        : null;
  if (!mapped) return;
  const revision = consentRevision(consent);
  void recordBrowserConsent()
    .then((receipt) => {
      if (!receipt.productAnalytics) return;
      const latest = browserConsent();
      if (!latest?.analytics || consentRevision(latest) !== revision) return;
      return fetch("/api/telemetry/web", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-tidy-receipt": receipt.id,
          "x-tidy-consent": revision,
        },
        body: JSON.stringify({ id: crypto.randomUUID(), event: mapped }),
        signal: AbortSignal.timeout(5000),
      });
    })
    .catch(() => {});
}
