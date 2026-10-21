import { browserConsent, consentRevision } from "./consent";
import { readJsonValue, responseError } from "@/lib/http/json-response";

export type ConsentReceipt = {
  id: string;
  browserId: string;
  user: { id: string; email: string } | null;
};
let revision = "";
let pending: Promise<ConsentReceipt> | undefined;
let queue: Promise<unknown> = Promise.resolve();

export function invalidateConsentReceipt() {
  revision = "";
}

export async function recordBrowserWithdrawal() {
  invalidateConsentReceipt();
  const task = queue
    .catch(() => {})
    .then(async () => {
      const response = await fetch("/api/privacy/consent", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
        headers: { "x-tidy-privacy": "1", "content-type": "application/json" },
        body: JSON.stringify({ revoke: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw responseError(response, undefined, "Withdrawal could not be recorded");
    });
  queue = task;
  return task;
}

export function recordBrowserConsent(): Promise<ConsentReceipt> {
  const consent = browserConsent();
  if (!consent) return Promise.reject(new Error("No current privacy choice"));
  const next = consentRevision(consent);
  if (revision === next && pending) return pending;
  revision = next;
  // Serialize first receipt creation so two changes cannot race Set-Cookie tokens.
  const task = queue
    .catch(() => {})
    .then(async () => {
      const current = browserConsent();
      if (!current || consentRevision(current) !== next) throw new Error("Choice superseded");
      const send = async () =>
        fetch("/api/privacy/consent", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "x-tidy-privacy": "1" },
          signal: AbortSignal.timeout(10_000),
        });
      // Share first-receipt creation across tabs where Web Locks is supported.
      // The server receipt/account check also rejects superseded tabs.
      const response =
        typeof navigator !== "undefined" && navigator.locks
          ? await navigator.locks.request("tidy-privacy-receipt", send)
          : await send();
      if (!response.ok)
        throw responseError(response, undefined, "Privacy choice could not be recorded");
      const receipt = (await readJsonValue(
        response,
        "Privacy choice could not be recorded",
      )) as ConsentReceipt;
      if (
        !receipt ||
        !/^[a-f0-9-]{36}$/.test(receipt.id) ||
        !/^[a-f0-9-]{36}$/.test(receipt.browserId)
      )
        throw new Error("Invalid privacy receipt");
      return receipt;
    });
  queue = task;
  pending = task;
  void task.catch(() => {
    if (pending === task) {
      revision = "";
      pending = undefined;
    }
  });
  return task;
}
