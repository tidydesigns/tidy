import "server-only";
import { randomBytes } from "node:crypto";
import { verifyPassword } from "better-auth/crypto";
import { google, github } from "better-auth/social-providers";
import { verifyProviderIdToken } from "@better-auth/core/oauth2";
import { decodeJwt } from "jose";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { enabledSocialProviders, socialProviderConfiguration } from "@/lib/auth-social";
import { lockPrivacyAccount, PrivacyError } from "./access";

export async function checkPrivacyAuthentication(userId: string, sessionId: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    // Check the same persisted authentication required by deletion, without
    // deleting anything or renewing the five-minute verification window.
    await lockPrivacyAccount(client, userId, sessionId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Persist failures outside the verification transaction, including on Node hosts.
export async function reserveReauthAttempts(userId: string) {
  for (const [window, limit] of [
    [60, 5],
    [3600, 20],
  ]) {
    const identifier = `privacy-attempt:${userId}`;
    const result = await db.query(
      `insert into verification (id,identifier,value,"expiresAt")
      values ($1,$2,'1',clock_timestamp()+($3*interval '1 second'))
      on conflict(id) do update set
        value=case when verification."expiresAt"<=clock_timestamp() then '1' else (verification.value::integer+1)::text end,
        "expiresAt"=case when verification."expiresAt"<=clock_timestamp() then excluded."expiresAt" else verification."expiresAt" end,
        "updatedAt"=now()
      where verification."expiresAt"<=clock_timestamp() or verification.value::integer<$4 returning id`,
      [`${identifier}:${window}`, identifier, window, limit],
    );
    if (!result.rowCount)
      throw new PrivacyError("Too many authentication attempts. Try again shortly.", 429);
  }
}

const proofId = (sessionId: string) => `privacy-reauth:${sessionId}`;
export type ReauthSocialProvider = "google" | "github";
const providerLabels = { google: "Google", github: "GitHub" };
function socialProvider(name: ReauthSocialProvider) {
  const configuration = socialProviderConfiguration()[name];
  if (!configuration)
    throw new PrivacyError(`${providerLabels[name]} sign-in is unavailable.`, 503);
  const { clientId, clientSecret } = configuration;
  return name === "google"
    ? google({ clientId, clientSecret, prompt: "select_account", accessType: "online" })
    : github({ clientId, clientSecret, prompt: "select_account" });
}
function callbackUrl(name: ReauthSocialProvider) {
  if (!process.env.BETTER_AUTH_URL)
    throw new PrivacyError(`${providerLabels[name]} sign-in is unavailable.`, 503);
  // GitHub shares the registered sign-in callback; namespaced state routes only
  // these challenges to reauthentication without creating/replacing a session.
  const path = name === "github" ? "/api/auth/callback/github" : "/api/privacy/reauth/google";
  return new URL(path, process.env.BETTER_AUTH_URL).href;
}
export async function reauthMethods(userId: string) {
  const accounts = (
    await db.query<{ providerId: string; password: string | null }>(
      'select "providerId",password from account where "userId"=$1',
      [userId],
    )
  ).rows;
  const enabled = enabledSocialProviders();
  return {
    password: accounts.some((a) => a.providerId === "credential" && Boolean(a.password)),
    google: enabled.includes("google") && accounts.some((a) => a.providerId === "google"),
    github: enabled.includes("github") && accounts.some((a) => a.providerId === "github"),
  };
}
async function lockSession(client: PoolClient, userId: string, sessionId: string) {
  const user = await client.query(
    'select id from "user" where id=$1 and "emailVerified"=true for update',
    [userId],
  );
  const session = await client.query(
    'select id from session where id=$1 and "userId"=$2 and "expiresAt">clock_timestamp() for share',
    [sessionId, userId],
  );
  if (!user.rowCount || !session.rowCount)
    throw new PrivacyError("Your session has ended. Sign in to continue.", 401, "SESSION_REQUIRED");
}
async function recordProof(client: PoolClient, userId: string, sessionId: string) {
  // The persisted proof grants no access on its own: it requires this live session.
  await client.query(
    `insert into verification (id,identifier,value,"expiresAt") values ($1,$1,$2,clock_timestamp()+interval '5 minutes')
    on conflict(id) do update set value=excluded.value,"expiresAt"=excluded."expiresAt","updatedAt"=now()`,
    [proofId(sessionId), userId],
  );
}
export async function reauthenticatePassword(userId: string, sessionId: string, password: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockSession(client, userId, sessionId);
    const credential = (
      await client.query<{ password: string }>(
        `select password from account where "userId"=$1 and "providerId"='credential' for share`,
        [userId],
      )
    ).rows[0];
    if (!credential?.password || !(await verifyPassword({ hash: credential.password, password })))
      throw new PrivacyError("That password is incorrect. Try again.", 400);
    await recordProof(client, userId, sessionId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

type SocialChallenge = { userId: string; sessionId: string; verifier: string; nonce: string };
export async function startSocialReauth(
  name: ReauthSocialProvider,
  userId: string,
  sessionId: string,
) {
  const provider = socialProvider(name);
  const state = `${name === "github" ? "privacy-github:" : ""}${randomBytes(32).toString("base64url")}`;
  const challenge: SocialChallenge = {
    userId,
    sessionId,
    verifier: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
  };
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockSession(client, userId, sessionId);
    const linked = await client.query(
      `select id from account where "userId"=$1 and "providerId"=$2`,
      [userId, name],
    );
    if (!linked.rowCount)
      throw new PrivacyError(`${providerLabels[name]} is not linked to this account.`);
    await client.query(
      `insert into verification (id,identifier,value,"expiresAt") values ($1,$2,$3,now()+interval '10 minutes')
      on conflict(id) do update set identifier=excluded.identifier,value=excluded.value,"expiresAt"=excluded."expiresAt","updatedAt"=now()`,
      [`privacy-${name}:${sessionId}`, `privacy-${name}:${state}`, JSON.stringify(challenge)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  const url = await provider.createAuthorizationURL({
    state,
    redirectURI: callbackUrl(name),
    codeVerifier: challenge.verifier,
  });
  // The provider adapter filters nonce from additionalParams, so set our nonce explicitly.
  if (name === "google") url.searchParams.set("nonce", challenge.nonce);
  return url.href;
}
export async function finishSocialReauth(
  name: ReauthSocialProvider,
  userId: string,
  sessionId: string,
  state: string,
  code: string,
) {
  const label = providerLabels[name];
  const statePattern =
    name === "github" ? /^privacy-github:[A-Za-z0-9_-]{43}$/ : /^[A-Za-z0-9_-]{43}$/;
  if (!statePattern.test(state) || !code || code.length > 4096)
    throw new PrivacyError(`${label} verification expired. Try again.`);
  // Atomically consume the challenge; another session cannot consume or use it.
  const row = (
    await db.query<{ value: string }>(
      `delete from verification where id=$1 and identifier=$2 and "expiresAt">clock_timestamp() returning value`,
      [`privacy-${name}:${sessionId}`, `privacy-${name}:${state}`],
    )
  ).rows[0];
  if (!row) throw new PrivacyError(`${label} verification expired. Try again.`);
  const challenge = JSON.parse(row.value) as SocialChallenge;
  if (challenge.userId !== userId || challenge.sessionId !== sessionId)
    throw new PrivacyError(`Use the ${label} account linked to your current Tidy account.`);
  const provider = socialProvider(name);
  const tokens = await provider.validateAuthorizationCode({
    code,
    codeVerifier: challenge.verifier,
    redirectURI: callbackUrl(name),
  });
  if (!tokens?.accessToken)
    throw new PrivacyError(`${label} could not verify your identity. Try again.`);
  let subject: string;
  if (provider.id === "google") {
    if (
      !tokens.idToken ||
      !(await verifyProviderIdToken(provider, tokens.idToken, challenge.nonce))
    )
      throw new PrivacyError("Google could not verify your identity. Try again.");
    const claims = decodeJwt(tokens.idToken);
    if (!claims.sub || claims.email_verified !== true)
      throw new PrivacyError("Use a verified Google account.");
    subject = claims.sub;
  } else {
    // Read identity from GitHub using the newly exchanged token, never an email
    // match or a stored token. GitHub's immutable numeric ID is the linked subject.
    const profile = await provider.getUserInfo(tokens);
    if (!profile?.data.id || !profile.user.emailVerified)
      throw new PrivacyError("Use a verified GitHub account.");
    subject = String(profile.data.id);
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockSession(client, userId, sessionId);
    const linked = await client.query(
      `select id from account where "userId"=$1 and "providerId"=$2 and "accountId"=$3 for share`,
      [userId, name, subject],
    );
    if (!linked.rowCount)
      throw new PrivacyError(`Use the ${label} account linked to your current Tidy account.`);
    await recordProof(client, userId, sessionId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
