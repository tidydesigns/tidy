import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { GenericEndpointContext } from "@better-auth/core";
import { consentRevision, readConsent, type Consent } from "./consent";

export const SIGNUP_COMPLETION_COOKIE = "tidy_signup_completion";
export const SIGNUP_COMPLETION_MAX_AGE = 86_400;
const purpose = "tidy:signup-completion:v1\0";
type Method = "email" | "google" | "github";
type Marker = {
  eventId: string;
  userId: string;
  at: number;
  consentRevision: string;
  method: Method;
};
type CreationContext = Pick<
  GenericEndpointContext,
  "path" | "params" | "body" | "headers" | "setCookie" | "context"
>;

function method(context: CreationContext): Method | null {
  if (context.path === "/sign-up/email") return "email";
  // Better Auth has already validated the provider and OAuth state/token before
  // inserting the user. Never infer a method from callback URLs or query flags.
  const provider =
    context.path === "/sign-in/social" && context.body?.idToken
      ? context.body.provider
      : context.path === "/callback/:id" || context.path === `/callback/${context.params?.id}`
        ? context.params?.id
        : null;
  return provider === "google" || provider === "github" ? provider : null;
}

function signature(payload: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("Signup marker signing unavailable");
  return createHmac("sha256", secret).update(purpose).update(payload).digest();
}

/** signup_completed means an actual NEW account insertion, for email and OAuth;
 * it does not mean email verification, first session, login or account linking.
 * Call ONLY from databaseHooks.user.create.after. No database or network work.
 * Better Auth 1.7.7 queues this hook after a surrounding transaction commits.
 * This bounded cookie is best effort, not a durable delivery/outbox guarantee.
 */
export function recordSignupCompletion(userId: string, context: CreationContext | null) {
  try {
    if (process.env.NEXT_PUBLIC_POSTHOG_ENABLED !== "1" || !context) return;
    const at = Date.now();
    const consent = readConsent(context.headers?.get("cookie"), at);
    if (!consent?.analytics || !userId || userId.length > 256) return;
    const signupMethod = method(context);
    if (!signupMethod) return;
    const marker: Marker = {
      eventId: randomUUID(),
      userId,
      at,
      consentRevision: consentRevision(consent),
      method: signupMethod,
    };
    const payload = Buffer.from(JSON.stringify(marker)).toString("base64url");
    context.setCookie(
      SIGNUP_COMPLETION_COOKIE,
      `${payload}.${signature(payload).toString("base64url")}`,
      {
        httpOnly: true,
        secure:
          new URL(process.env.BETTER_AUTH_URL || context.context.baseURL).protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: SIGNUP_COMPLETION_MAX_AGE,
        // Deliberately omit Domain: the marker is host-only.
      },
    );
  } catch {
    // Optional instrumentation (including signing/cookie failures) must never
    // prevent account creation or leak a marker, identifier or secret to logs.
  }
}

function readMarker(cookie: string | null, consent: Consent, now: number): Marker | null {
  const values = cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNUP_COMPLETION_COOKIE}=`));
  if (values?.length !== 1 || values[0].length > 2048) return null;
  const token = values[0].slice(SIGNUP_COMPLETION_COOKIE.length + 1);
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) return null;
  const expected = signature(parts[1]);
  const received = Buffer.from(parts[2], "base64url");
  if (
    received.length !== expected.length ||
    received.toString("base64url") !== parts[2] ||
    !timingSafeEqual(expected, received)
  )
    return null;
  try {
    const marker: Marker = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (
      !marker ||
      typeof marker.eventId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        marker.eventId,
      ) ||
      typeof marker.userId !== "string" ||
      !marker.userId ||
      marker.userId.length > 256 ||
      !Number.isSafeInteger(marker.at) ||
      marker.at < consent.at ||
      marker.at > now ||
      now - marker.at >= SIGNUP_COMPLETION_MAX_AGE * 1000 ||
      marker.consentRevision !== consentRevision(consent) ||
      !["email", "google", "github"].includes(marker.method)
    )
      return null;
    // readConsent also enforces expiry, so effective TTL is at most the lesser
    // of 24 hours and the remaining validity of the exact occurrence choice.
    return marker;
  } catch {
    return null;
  }
}

type ClaimDependencies = {
  authorizeTelemetry: (request: Request, consent: Consent) => Promise<boolean>;
  sessionUserId: (request: Request) => Promise<string | null>;
};

/** Repeated/concurrent claims of the same signed marker return the same event
 * UUID and occurrence time. The client uses both for ingestion deduplication;
 * Retain the bounded marker: an old response must never erase a newer signup's
 * cookie. The stable UUID/time provide ingestion deduplication.
 * No identifiers or event properties other than this fixed projection escape.
 */
export async function claimSignupCompletion(request: Request, dependencies: ClaimDependencies) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  try {
    const origin = new URL(process.env.BETTER_AUTH_URL || request.url);
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== origin.origin ||
      request.headers.get("x-tidy-privacy") !== "1" ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return new Response(null, { status: 403, headers });
    const empty = (status = 204) => new Response(null, { status, headers });
    const cookie = request.headers.get("cookie");
    const consent = readConsent(cookie);
    if (process.env.NEXT_PUBLIC_POSTHOG_ENABLED !== "1" || !consent?.analytics) return empty();
    const marker = readMarker(cookie, consent, Date.now());
    if (!marker) return empty();
    const receipt = request.headers.get("x-tidy-receipt");
    if (!receipt || receipt.length > 64) return empty(403);
    const userId = await dependencies.sessionUserId(request);
    if ((userId && userId !== marker.userId) || (!userId && marker.method !== "email"))
      return empty(403);
    // An email insertion may still be waiting for verification and have no
    // session. Its anonymous receipt must nevertheless be current and recorded.
    if (!(await dependencies.authorizeTelemetry(request, consent))) return empty(403);
    if (!readConsent(cookie) || !readMarker(cookie, consent, Date.now())) return empty();
    return Response.json(
      { eventId: marker.eventId, at: marker.at, method: marker.method },
      { headers },
    );
  } catch {
    // Transient auth/receipt/signing failures collect nothing; retain the bounded
    // marker for a later retry rather than allowing telemetry to affect auth.
    return new Response(null, { status: 503, headers });
  }
}
