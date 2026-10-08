import "server-only";
import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { mcp } from "@better-auth/mcp";
import { db } from "@/lib/db";
import {
  authorizationVersion,
  invalidateMcpGrant,
  requireMcpGrant,
} from "@/lib/mcp/authorizations";
import type { McpGrant } from "@/lib/mcp/grant-context";
import { requireVerifiedUser } from "@/lib/security/user-authority";
import { PersonalBudgetError, reservePersonalAttempts } from "@/lib/security/personal-budget";
import {
  invalidOAuthGrant as invalidGrant,
  oauthAccountGate as accountGate,
  oauthTransaction as issuanceTransaction,
} from "./oauth-transaction";
import { oauthRevocationEndpoint } from "./oauth-revocation";
import { oauthIntrospectionEndpoint, oauthUserInfoEndpoint } from "./oauth-read";
import { oauthConsentEndpoint } from "./oauth-consent";

// Matches the pinned provider's default hashed token storage. Do not change
// independently of storeTokens/formatRefreshToken in the MCP configuration.
function tokenIdentifier(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

type Code = {
  type: "authorization_code";
  userId: string;
  sessionId: string;
  query: { client_id: string; scope?: string; resource?: string | string[] };
  resource?: string[];
  bella_grant_version?: string;
};
type StoredGrant = {
  userId: string;
  clientId: string;
  sessionId: string | null;
  scopes: string[];
  resources: string[] | null;
  expiresAt: Date;
  version?: string;
};

function codeValue(value: unknown): Code | undefined {
  if (typeof value !== "string") return;
  let code: Code;
  try {
    code = JSON.parse(value);
  } catch {
    return;
  }
  if (code?.type !== "authorization_code") return;
  if (
    ![code.userId, code.sessionId, code.query?.client_id].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 2048,
    ) ||
    (code.query.scope !== undefined && typeof code.query.scope !== "string")
  )
    throw invalidGrant();
  return code;
}

function fromCode(code: Code, expiresAt: Date): StoredGrant {
  const resources = code.resource ?? code.query.resource;
  return {
    userId: code.userId,
    clientId: code.query.client_id,
    sessionId: code.sessionId,
    scopes: (code.query.scope ?? "").split(" ").filter(Boolean),
    resources: typeof resources === "string" ? [resources] : (resources ?? null),
    expiresAt,
    // Legacy codes belong to the pre-revocation epoch, never the current one.
    version: code.bella_grant_version ?? "0",
  };
}

async function retainedGrant(source: StoredGrant): Promise<McpGrant> {
  if (!source.resources?.length || !source.sessionId) throw invalidGrant();
  const version = source.version ?? (await authorizationVersion(source.userId, source.clientId));
  const claims = {
    sub: source.userId,
    client_id: source.clientId,
    sid: source.sessionId,
    exp: source.expiresAt.getTime() / 1000,
    bella_grant_version: version,
  };
  // Protocol scopes don't authorize product operations. Retain every requested
  // product scope, including Linear capabilities, through the provider writes.
  const scopes = source.scopes.filter((scope) => /^(mcp|linear):/.test(scope));
  const grant = { claims, resource: source.resources[0], scopes };
  for (const resource of source.resources)
    await requireMcpGrant(db, { ...grant, resource }, source.userId);
  return grant;
}

/** Capture the epoch at the actual code insert, including provider-internal
 * consent/continue/sign-in paths that bypass the public authorize endpoint. */
export const oauthCodeBindingPlugin = {
  id: "tidy-oauth-code-binding",
  init(context) {
    const adapter = context.adapter;
    const create = adapter.create;
    Object.defineProperty(adapter, "create", {
      ...Object.getOwnPropertyDescriptor(adapter, "create"),
      value: async (...args: unknown[]) => {
        const input = args[0] as { model?: string; data?: Record<string, unknown> };
        if (input?.model === "oauthClientAssertion") {
          // A duplicate assertion key must roll back its savepoint before the
          // provider checks its tombstone. Otherwise PostgreSQL aborts the
          // outer transaction and a legitimate replay denial becomes a 500.
          return issuanceTransaction(() => Reflect.apply(create, adapter, args));
        }
        const code = input?.model === "verification" ? codeValue(input.data?.value) : undefined;
        if (!code) return Reflect.apply(create, adapter, args);
        return issuanceTransaction(async () => {
          await accountGate(code.userId);
          const version = await authorizationVersion(code.userId, code.query.client_id);
          const source = fromCode(code, new Date(input.data!.expiresAt as string));
          source.version = version;
          await retainedGrant(source);
          const result = await Reflect.apply(create, adapter, [
            {
              ...input,
              data: {
                ...input.data,
                value: JSON.stringify({ ...code, bella_grant_version: version }),
              },
            },
            ...args.slice(1),
          ]);
          await retainedGrant(source);
          return result;
        });
      },
    });
  },
} satisfies BetterAuthPlugin;

type SessionInput = {
  body?: unknown;
  context?: {
    session?: { user: { id: string }; session: { id: string } } | null;
  };
};

async function consentMutation<T>(
  input: SessionInput | undefined,
  remove: boolean,
  work: () => Promise<T>,
) {
  // Global auth middleware resolves cookie sessions without trusting its cache.
  // Retain the exact database identity again before the provider changes consent.
  const session = input?.context?.session;
  if (!session) throw new APIError("UNAUTHORIZED");
  try {
    await reservePersonalAttempts("oauth-revoke", session.user.id);
  } catch (error) {
    if (!(error instanceof PersonalBudgetError)) throw error;
    throw new APIError(error.status === 429 ? "TOO_MANY_REQUESTS" : "SERVICE_UNAVAILABLE", {
      message: error.message,
    });
  }
  const id = (input?.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id || id.length > 2048) throw invalidGrant();
  return issuanceTransaction(async () => {
    await accountGate(session.user.id);
    await requireVerifiedUser(db, session.user.id, true);
    const liveSession = async () => {
      if (
        !(
          await db.query(
            'select "id" from "session" where "id"=$1 and "userId"=$2 and "expiresAt">clock_timestamp() for share',
            [session.session.id, session.user.id],
          )
        ).rowCount
      )
        throw new APIError("UNAUTHORIZED");
    };
    await liveSession();
    const consent = (
      await db.query<{ clientId: string }>(
        'select "clientId" from "oauthConsent" where "id"=$1 and "userId"=$2 for update',
        [id, session.user.id],
      )
    ).rows[0];
    if (!consent) throw new APIError("NOT_FOUND");
    const result = await work();
    // Even a scope change followed by restoration cannot restore old JWTs or
    // outstanding codes. Keep the newly updated consent; delete on revocation.
    await invalidateMcpGrant(db, session.user.id, consent.clientId, remove);
    await liveSession();
    return result;
  });
}

/** Keep Better Auth's protocol validation and endpoint metadata, while making
 * consumption, signing, rotation and replay cleanup one serialized transaction. */
export function hardenedMcp(options: Parameters<typeof mcp>[0]) {
  const plugin = mcp(options);
  const consent = oauthConsentEndpoint(plugin.endpoints.oauth2Consent);
  plugin.endpoints.oauth2UserInfo = oauthUserInfoEndpoint(
    plugin.endpoints.oauth2UserInfo,
    plugin.options,
  );
  plugin.endpoints.oauth2Introspect = oauthIntrospectionEndpoint(
    plugin.endpoints.oauth2Introspect,
    plugin.options,
  );
  plugin.endpoints.oauth2Revoke = oauthRevocationEndpoint(
    plugin.endpoints.oauth2Revoke,
    plugin.options,
  );
  // Tidy uses standards-based registration and public client metadata. Private
  // owner-management APIs have no product caller and need no public HTTP route.
  // Retain their trusted server APIs with the provider's ownership checks.
  for (const key of [
    "createOAuthClient",
    "getOAuthClient",
    "getOAuthClients",
    "updateOAuthClient",
    "rotateClientSecret",
    "deleteOAuthClient",
  ] as const) {
    const endpoint = plugin.endpoints[key];
    endpoint.options.metadata = Object.assign({}, endpoint.options.metadata, { SERVER_ONLY: true });
  }
  // Tidy has no select-account/signup/post-login continuation UI. The provider
  // completes sign-in through its internal, code-guarded authorize routine.
  const continuation = plugin.endpoints.oauth2Continue;
  continuation.options.metadata = Object.assign({}, continuation.options.metadata, {
    SERVER_ONLY: true,
  });
  const remove = plugin.endpoints.deleteOAuthConsent;
  plugin.endpoints.deleteOAuthConsent = Object.assign(
    async (...args: Parameters<typeof remove>) =>
      consentMutation(args[0], true, () => remove(...args)),
    remove,
  );
  const update = plugin.endpoints.updateOAuthConsent;
  plugin.endpoints.updateOAuthConsent = Object.assign(
    async (...args: Parameters<typeof update>) =>
      consentMutation(args[0], false, () => update(...args)),
    update,
  );
  const endpoint = plugin.endpoints.oauth2Token;
  plugin.endpoints.oauth2Token = Object.assign(async (...args: Parameters<typeof endpoint>) => {
    const body = args[0]?.body as Record<string, unknown> | undefined;
    const kind = body?.grant_type;
    if (kind !== "authorization_code" && kind !== "refresh_token") return endpoint(...args);
    const raw = kind === "authorization_code" ? body?.code : body?.refresh_token;
    if (typeof raw !== "string" || !raw || raw.length > 4096) throw invalidGrant();
    const identifier = tokenIdentifier(raw);
    // Also serialize identical code/replay requests before source discovery.
    // Account revocation never takes this token gate, so lock order is acyclic.
    return issuanceTransaction(async () => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `oauth-issuance:${kind}:${identifier}`,
      ]);
      const lookup = async (): Promise<StoredGrant | undefined> => {
        if (kind === "refresh_token")
          return (
            await db.query<StoredGrant>(
              'select "userId","clientId","sessionId","scopes","resources","expiresAt" from "oauthRefreshToken" where "token"=$1',
              [identifier],
            )
          ).rows[0];
        const row = (
          await db.query<{ value: string; expiresAt: Date }>(
            'select "value","expiresAt" from "verification" where "identifier"=$1',
            [identifier],
          )
        ).rows[0];
        const code = row && codeValue(row.value);
        return code ? fromCode(code, row.expiresAt) : undefined;
      };
      const initial = await lookup();
      // A consumed authorization code can still identify the issued family.
      // Retain the same account gate during the provider's replay cleanup.
      const familyLookup = () =>
        db.query<{ id: string; userId: string; clientId: string }>(
          kind === "authorization_code"
            ? 'select "id","userId","clientId" from "oauthRefreshToken" where "authorizationCodeId"=$1 limit 1'
            : 'select "id","userId","clientId" from "oauthRefreshToken" where "token"=$1 limit 1',
          [identifier],
        );
      const initialFamily = (await familyLookup()).rows[0];
      let source: StoredGrant | undefined;
      const userId = initial?.userId ?? initialFamily?.userId;
      if (userId) {
        await accountGate(userId);
        // User first, including replay cleanup, to avoid account-delete cycles.
        await db.query('select "id" from "user" where "id"=$1 for share', [userId]);
      }
      if (initial) {
        source = await lookup();
        if (!source || source.userId !== initial.userId) throw invalidGrant();
        await retainedGrant(source);
      }
      const family = (await familyLookup()).rows[0];
      if (family && family.userId !== userId) throw invalidGrant();
      // Provider 4xx failures deliberately consume invalid codes and delete
      // replayed token families. Commit those effects, then rethrow outside
      // the transaction. Unknown/5xx failures and our guards roll back.
      let failure: APIError | undefined;
      let result: Awaited<ReturnType<typeof endpoint>> | undefined;
      try {
        result = await endpoint(...args);
      } catch (error) {
        if (!isAPIError(error) || error.statusCode < 400 || error.statusCode >= 500) throw error;
        failure = error;
      }
      if (!failure && source) await retainedGrant(source);
      if (failure && family && !(await familyLookup()).rowCount)
        await invalidateMcpGrant(db, family.userId, family.clientId);
      return { result, failure };
    }).then(({ result, failure }) => {
      if (failure) throw failure;
      return result!;
    });
  }, endpoint);
  return { ...plugin, endpoints: { ...plugin.endpoints, oauth2Consent: consent } };
}
