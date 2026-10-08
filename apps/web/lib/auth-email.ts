import "server-only";
import { reserveEmailDelivery } from "./auth/email-budget";

export function authEmailConfigured() {
  return Boolean(
    process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim() &&
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() &&
    process.env.AUTH_EMAIL_FROM?.trim(),
  );
}

type SendResponse = {
  success?: boolean;
  result?: {
    delivered?: string[];
    queued?: string[];
    permanent_bounces?: string[];
    suppressed_recipients?: string[];
  } | null;
};

function sender(from: string) {
  const named = from.match(/^([^<>]+)\s*<([^<>\s]+@[^<>\s]+)>$/);
  return named ? { address: named[2], name: named[1].trim() } : from;
}

export async function sendAuthEmail(to: string, subject: string, text: string) {
  const token = process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!token || !accountId || !from)
    throw new Error(
      "Email delivery is not configured. Set CLOUDFLARE_EMAIL_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and AUTH_EMAIL_FROM.",
    );
  // Suppression preserves the generic auth response and does not disclose whether
  // a recipient exists. Signup still requires actual email verification to sign in.
  if (!(await reserveEmailDelivery(to))) return;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: sender(from), to: [to], subject, text }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error("Email delivery failed.");
    const body = (await response.json()) as SendResponse;
    const matches = (addresses: string[] | undefined) =>
      Array.isArray(addresses) &&
      addresses.some((address) => address.toLowerCase() === to.toLowerCase());
    if (
      body.success !== true ||
      matches(body.result?.permanent_bounces) ||
      matches(body.result?.suppressed_recipients) ||
      !(matches(body.result?.delivered) || matches(body.result?.queued))
    )
      throw new Error("Email delivery failed.");
  } catch {
    // Provider bodies may contain addresses or verification links; never return them.
    throw new Error("Could not send the email. Please try again later.");
  }
}
