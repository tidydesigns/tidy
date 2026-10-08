import { GitHubRequestError } from "./request-error";
import { withoutDatabaseScope } from "@/lib/database-scope";
import { createSign } from "node:crypto";
import { db } from "@/lib/db";
import { githubConfig } from "./config";
import { seal, unseal, type Sealed } from "./crypto";
import { requireOAuthSession } from "@/lib/connectors/oauth-session";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import {
  GitHubWorkLimitError,
  reserveGitHubRequest,
  consumeGitHubResponseBytes,
} from "./work-budget";
export { boundedGitHubOperation, GitHubWorkLimitError } from "./work-budget";

export class GitHubError extends Error {
  constructor(public status: number) {
    super(
      status === 401
        ? "Reconnect your GitHub account."
        : status === 403
          ? "GitHub denied access or its rate limit was reached."
          : status === 404
            ? "Repository or pull request not found, or access was removed."
            : "GitHub is unavailable. Try again.",
    );
  }
}
const responseBytes = 8 * 1024 * 1024;
const paginationBytes = 16 * 1024 * 1024;
const paginationPages = 20;

function requestSignal(caller?: AbortSignal | null, operation?: AbortSignal) {
  const budgetSignal = reserveGitHubRequest();
  const signals = [AbortSignal.timeout(15000)];
  if (caller) signals.push(caller);
  if (operation) signals.push(operation);
  if (budgetSignal) signals.push(budgetSignal);
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  return signal;
}

async function readResponse(response: Response, limit: number, signal: AbortSignal) {
  if (!response.body) {
    signal.throwIfAborted();
    return { text: "", bytes: 0 };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("Request or response is too large.");
      consumeGitHubResponseBytes(value.byteLength);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cancellation acknowledgements from a remote stream must not extend the deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, length).toString("utf8"), bytes: length };
}
export async function readLimited(
  response: Response,
  limit = responseBytes,
  signal = AbortSignal.timeout(15000),
) {
  return (await readResponse(response, limit, signal)).text;
}
export async function githubRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return (await githubResponse<T>(token, path, init)).value;
}
async function githubResponse<T>(
  token: string,
  path: string,
  init: RequestInit,
  limit = responseBytes,
  operationSignal?: AbortSignal,
) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub API path.");
  const signal = requestSignal(init.signal, operationSignal);
  // Workers rejects redirect: "error". Manual mode keeps credentials on this
  // host, and the non-OK check below rejects redirects without following them.
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    cache: "no-store",
    redirect: "manual",
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "tidy-design-review",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new GitHubError(response.status);
  }
  const body = await readResponse(response, limit, signal);
  return { value: (body.text ? JSON.parse(body.text) : null) as T, bytes: body.bytes };
}
export async function paginated<T>(token: string, path: string, field?: string): Promise<T[]> {
  const items: T[] = [];
  const signal = AbortSignal.timeout(30000);
  let remaining = paginationBytes;
  for (let page = 1; page <= paginationPages; page++) {
    if (remaining <= 0) throw new GitHubWorkLimitError();
    const { value: data, bytes } = await githubResponse<unknown>(
      token,
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      {},
      Math.min(responseBytes, remaining),
      signal,
    );
    remaining -= bytes;
    const batch =
      field && data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)[field]
        : field
          ? undefined
          : data;
    if (!Array.isArray(batch) || batch.length > 100)
      throw new Error("GitHub returned an invalid result page.");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new GitHubWorkLimitError();
}
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
};
export async function exchangeToken(parameters: Record<string, string>) {
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!secret) throw new Error("GitHub authentication is not configured.");
  const signal = requestSignal();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: githubConfig().clientId,
      client_secret: secret,
      ...parameters,
    }),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new GitHubError(response.status);
  }
  const value = JSON.parse(await readLimited(response, 16000, signal)) as TokenResponse;
  if (value.error || !value.access_token)
    throw new GitHubRequestError("GitHub authorization expired or was declined. Connect again.");
  return value;
}
function expiry(seconds?: number) {
  return seconds ? new Date(Date.now() + seconds * 1000) : null;
}
export async function storeUserToken(
  userId: string,
  token: TokenResponse,
  authority: { sessionId: string; organizationId: string; stateHash: string },
) {
  const identity = await githubRequest<{ id: number; login: string }>(token.access_token, "/user");
  if (
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0 ||
    typeof identity.login !== "string" ||
    !identity.login ||
    identity.login.length > 100
  )
    throw new GitHubRequestError("GitHub did not return a supported account.", 502);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      authority.organizationId,
    ]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `github-states:${userId}`,
    ]);
    await requireOAuthSession(client, userId, authority.sessionId, true);
    const member = await client.query(
      `select 1 from "member" where "userId"=$1 and "organizationId"=$2 and "role" in ${VIEW_ROLES_SQL} for share`,
      [userId, authority.organizationId],
    );
    if (member.rows.length !== 1) throw new GitHubRequestError("Workspace access denied.", 403);
    const state = await client.query(
      `delete from "githubOAuthState" where "hash"=$1 and "userId"=$2 and "organizationId"=$3
       and "expiresAt">clock_timestamp() and "verifier" ? 'claimed' returning "hash"`,
      [authority.stateHash, userId, authority.organizationId],
    );
    if (state.rows.length !== 1)
      throw new GitHubRequestError("Authorization expired. Connect GitHub again.", 403);
    await client.query(
      `insert into "githubUser" ("userId", "githubId", "login", "credentials", "expiresAt", "refreshExpiresAt") values ($1,$2,$3,$4,$5,$6)
    on conflict ("userId") do update set "githubId" = $2, "login" = $3, "credentials" = $4, "expiresAt" = $5, "refreshExpiresAt" = $6`,
      [
        userId,
        identity.id,
        identity.login,
        seal(JSON.stringify(token), userId),
        expiry(token.expires_in),
        expiry(token.refresh_token_expires_in),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export const credentialVersionSql = `encode(sha256(convert_to(g."credentials"::text,'utf8')),'hex')`;
export async function userToken(userId: string) {
  return (await userAuthorization(userId)).token;
}
export function userAuthorization(userId: string) {
  return withoutDatabaseScope(() => readUserToken(userId));
}
async function readUserToken(userId: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    type Grant = {
      githubId: string;
      credentialVersion: string;
      credentials: Sealed;
      expiresAt: Date | null;
      refreshExpiresAt: Date | null;
    };
    const query = `select "githubId", ${credentialVersionSql} as "credentialVersion", "credentials", "expiresAt", "refreshExpiresAt" from "githubUser" g where "userId" = $1`;
    let row = (await client.query<Grant>(query, [userId])).rows[0];
    if (!row)
      throw new GitHubRequestError(
        "Connect your GitHub account in Settings → Connectors → GitHub.",
      );
    // Fresh credentials need no update lock. This also allows reads while an
    // enclosing tool transaction holds its publication share lock on this grant.
    let needsRefresh = Boolean(row.expiresAt && row.expiresAt.getTime() < Date.now() + 60000);
    if (needsRefresh) {
      row = (await client.query<Grant>(`${query} for update`, [userId])).rows[0];
      if (!row)
        throw new GitHubRequestError(
          "Connect your GitHub account in Settings → Connectors → GitHub.",
        );
      needsRefresh = Boolean(row.expiresAt && row.expiresAt.getTime() < Date.now() + 60000);
    }
    let credentialVersion = row.credentialVersion;
    let token = JSON.parse(unseal(row.credentials, userId)) as TokenResponse;
    if (needsRefresh) {
      if (
        !token.refresh_token ||
        (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= Date.now())
      )
        throw new GitHubRequestError("Reconnect your GitHub account.");
      token = await exchangeToken({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      });
      const rotated = await client.query<{ credentialVersion: string }>(
        `update "githubUser" g set "credentials" = $2, "expiresAt" = $3, "refreshExpiresAt" = $4 where "userId" = $1 returning ${credentialVersionSql} as "credentialVersion"`,
        [
          userId,
          seal(JSON.stringify(token), userId),
          expiry(token.expires_in),
          expiry(token.refresh_token_expires_in),
        ],
      );
      credentialVersion = rotated.rows[0].credentialVersion;
    }
    await client.query("commit");
    return { token: token.access_token, githubId: row.githubId, credentialVersion };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function installationToken(installationId: string) {
  const key = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!key) throw new Error("GitHub installation authentication is not configured.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: githubConfig().clientId })}`;
  const jwt = `${data}.${createSign("RSA-SHA256").update(data).sign(key, "base64url")}`;
  const token = await githubRequest<{ token: string }>(
    jwt,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        permissions: {
          contents: "read",
          pull_requests: "read",
          checks: "read",
          statuses: "read",
          deployments: "read",
        },
      }),
    },
  );
  return token.token;
}
