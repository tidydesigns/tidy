import { clientAdmissionPlugin } from "@/lib/auth/client-admission";
import { hardenedMcp, oauthCodeBindingPlugin } from "@/lib/auth/oauth-issuance";
import { reserveClientRegistration } from "@/lib/auth/client-registration-budget";
import { MutationBudgetError, reserveInvitationMutation } from "@/lib/security/mutation-budget";
import {
  invitationAdmissionPlugin,
  INVITATION_LIMITS,
} from "@/lib/organizations/invitation-admission";
import { organizationRoles } from "@/lib/organizations/access-control";
import { canAssignRole } from "@/lib/organizations/roles";
import { requireOrganizationPermission } from "@/lib/organizations/authorization";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt, organization } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@/lib/mcp/client-metadata";
import { db } from "@/lib/db";
import { vaultSchema } from "@/lib/vault/schema";
import { requireOrganizationName } from "@/lib/organizations/deletion";
import { organizationConfirmationHeader } from "@/lib/organizations/constants";
import { organizationNameSchema } from "@/lib/organizations/name";
import { profileNameSchema } from "@/lib/profile";
import { sendAuthEmail } from "@/lib/auth-email";
import { socialProviderConfiguration } from "@/lib/auth-social";
import { checkInvitationPlan } from "@/lib/billing/plan-server";
import { planErrorsPlugin } from "@/lib/billing/auth-plugin";
import { planLimitMessage } from "@/lib/billing/plans";
import { assertNoActiveBilling } from "@/lib/billing/server";
import { authorizationVersion } from "@/lib/mcp/authorizations";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { consumeAuthRateLimit } from "@/lib/auth/guard-client";
import {
  assertRequestActive,
  requestSignal,
  traceAuthOperation,
  waitForSignal,
} from "@/lib/auth/request-lifecycle";
import { startOperation, traceOperation } from "@/lib/trace-context";

function workerRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

function isLoopbackOAuthRedirect(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function invitationCapacity(organizationId: string, email: string, role: string) {
  try {
    await checkInvitationPlan(organizationId, email, role);
  } catch (error) {
    const message = planLimitMessage(error);
    if (message) throw new APIError("FORBIDDEN", { code: "PLAN_LIMIT", message });
    throw error;
  }
}

function createAuth() {
  return betterAuth({
    database: db,
    advanced: {
      // Cloudflare overwrites this header at its public edge. Node development
      // uses Better Auth's normal IP handling instead of trusting client input.
      ...(workerRuntime() ? { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } } : {}),
      database: {
        // Runtime introspection shares one promise across requests. A stalled
        // Worker request must not block authentication for the whole instance.
        validateSchema: process.env.NODE_ENV !== "production",
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 5 },
        "/sign-in/social": { window: 60, max: 10 },
        "/oauth2/register": { window: 60, max: 10 },
        "/oauth2/authorize": { window: 60, max: 30 },
        "/oauth2/token": { window: 60, max: 60 },
      },
      ...(workerRuntime() ? { customStorage: { consume: consumeAuthRateLimit } } : {}),
    },
    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await sendAuthEmail(
            user.email,
            "Confirm your Tidy email change",
            `Confirm changing your Tidy email to ${newEmail}:\n\n${url}\n\nIf you did not request this change, ignore this email.`,
          );
        },
      },
      validateUserInfo: ({ user, source }) => {
        if (source.method === "oauth" && user.emailVerified !== true) {
          return {
            error: "email_not_verified",
            errorDescription: "Verify your email with your sign-in provider before continuing.",
          };
        }
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async ({ userId }, context) => {
            const user = await context?.context.internalAdapter.findUserById(userId);

            if (!user?.emailVerified) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message: "Verify your email before signing in.",
              });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Existing cookies may predate mandatory verification. Better Auth's
        // internal session middleware bypasses the public get-session hooks.
        const recovery =
          /^\/(get-session|sign-in\/|sign-up\/|callback\/|verify-email|send-verification-email|sign-out|request-password-reset|reset-password)/;
        if (ctx.headers?.get("cookie") && !recovery.test(ctx.path)) {
          const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
          if (session && !session.user.emailVerified) {
            throw new APIError("FORBIDDEN", {
              code: "EMAIL_NOT_VERIFIED",
              message: "Verify your email before continuing.",
            });
          }
        }
        const oauthScopes = String(ctx.query?.scope ?? ctx.body?.scope ?? "").split(" ");
        if (
          (ctx.path === "/oauth2/authorize" &&
            oauthScopes.some((scope) => scope.startsWith("mcp:")) &&
            !ctx.query?.resource) ||
          (ctx.path === "/oauth2/token" && !ctx.body?.resource)
        ) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_target",
            error_description:
              "Include the MCP resource indicator in authorization and token requests.",
          });
        }
        // The built-in resend path bypasses invitation hooks. Reissue through the invite UI instead.
        if (ctx.path === "/organization/invite-member" && ctx.body?.resend) {
          throw new APIError("FORBIDDEN", {
            message: "Cancel the old invitation and create a new one.",
          });
        }
        // Membership changes use our transactionally locked service, including last-owner protection.
        // Block the parallel Better Auth mutation endpoints so they cannot bypass that policy.
        if (
          [
            "/organization/update-member-role",
            "/organization/remove-member",
            "/organization/leave",
          ].includes(ctx.path)
        ) {
          throw new APIError("FORBIDDEN", { message: "Manage membership in workspace settings." });
        }
        // Creation records the authenticated creator and owner in one transaction.
        // The parallel Better Auth endpoint doesn't supply that attribution.
        if (ctx.path === "/organization/create") {
          throw new APIError("FORBIDDEN", {
            message: "Create organizations through the organization menu.",
          });
        }
        if (ctx.path === "/oauth2/register") await reserveClientRegistration();
        // CLI MCP clients commonly omit application_type during DCR. The OAuth
        // provider defaults that to web, which rejects their loopback callback.
        // Native registration keeps the provider's strict redirect validation.
        if (
          ctx.path === "/oauth2/register" &&
          ctx.body?.application_type === undefined &&
          ctx.body?.token_endpoint_auth_method === "none" &&
          Array.isArray(ctx.body?.redirect_uris) &&
          ctx.body.redirect_uris.length > 0 &&
          ctx.body.redirect_uris.every(isLoopbackOAuthRedirect)
        ) {
          ctx.body.application_type = "native";
        }
        if (ctx.path === "/update-user" && ctx.body?.name !== undefined) {
          const parsed = profileNameSchema.safeParse(ctx.body.name);
          if (!parsed.success)
            throw new APIError("BAD_REQUEST", { message: parsed.error.issues[0].message });
          ctx.body.name = parsed.data;
        }
        if (ctx.path !== "/organization/delete") return;
        const organization = await ctx.context.adapter.findOne<{ name: string }>({
          model: "organization",
          where: [{ field: "id", value: ctx.body?.organizationId }],
        });
        requireOrganizationName(
          organization?.name,
          ctx.headers?.get(organizationConfirmationHeader) ?? null,
        );
        await assertNoActiveBilling(ctx.body?.organizationId);
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/get-session" &&
          ctx.context.session &&
          !ctx.context.session.user.emailVerified
        ) {
          return ctx.json(null);
        }
      }),
    },
    socialProviders: socialProviderConfiguration(),
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, allowDifferentEmails: false, trustedProviders: [] },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail(
          user.email,
          "Reset your Tidy password",
          `Reset your Tidy password:\n\n${url}\n\nThis link expires in one hour. If you did not request it, ignore this email.`,
        );
      },
    },
    emailVerification: {
      expiresIn: 3600,
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail(
          user.email,
          "Verify your Tidy email",
          `Verify your email address for Tidy:\n\n${url}\n\nThis link expires in one hour. If you did not request it, ignore this email.`,
        );
      },
    },
    plugins: [
      planErrorsPlugin,
      invitationAdmissionPlugin,
      clientAdmissionPlugin,
      oauthCodeBindingPlugin,
      {
        id: "await-auth-delivery",
        // The default helper swallows delivery errors. These requests must wait
        // for delivery and surface failure instead of claiming an email was sent.
        init: () => ({
          context: { runInBackgroundOrAwait: async (task: Promise<unknown> | void) => await task },
        }),
      },
      organization({
        roles: organizationRoles,
        requireEmailVerificationOnInvitation: true,
        membershipLimit: INVITATION_LIMITS.members,
        invitationLimit: INVITATION_LIMITS.pending,
        organizationHooks: {
          beforeAcceptInvitation: async ({ invitation }) => {
            const role = await requireOrganizationPermission(
              invitation.inviterId,
              invitation.organizationId,
              "manage",
            );
            if (!canAssignRole(role, invitation.role ?? ""))
              throw new APIError("FORBIDDEN", {
                message:
                  "This invitation can no longer grant access. Ask an admin for a new invitation.",
              });
            await invitationCapacity(
              invitation.organizationId,
              invitation.email,
              invitation.role ?? "",
            );
          },
          beforeCancelInvitation: async ({ invitation, cancelledBy }) => {
            const role = await requireOrganizationPermission(
              cancelledBy.id,
              invitation.organizationId,
              "manage",
            );
            if (!canAssignRole(role, invitation.role ?? ""))
              throw new APIError("FORBIDDEN", {
                message: "Only owners can manage admin invitations.",
              });
          },
          beforeUpdateOrganization: async ({ organization }) => {
            if (organization.name === undefined) return;
            const parsed = organizationNameSchema.safeParse(organization.name);
            if (!parsed.success) {
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_ORGANIZATION_NAME",
                message: parsed.error.issues[0].message,
              });
            }
            return { data: { name: parsed.data } };
          },
          afterDeleteOrganization: async ({ organization }) => {
            await db.query(
              'update "session" set "activeOrganizationId" = null where "activeOrganizationId" = $1',
              [organization.id],
            );
          },
          beforeCreateInvitation: async ({ invitation }) => {
            const role = await requireOrganizationPermission(
              invitation.inviterId,
              invitation.organizationId,
              "manage",
            );
            if (!canAssignRole(role, invitation.role))
              throw new APIError("FORBIDDEN", { message: "You cannot invite this role." });
            try {
              await reserveInvitationMutation(invitation.inviterId, invitation.organizationId);
            } catch (error) {
              if (error instanceof MutationBudgetError)
                throw new APIError("TOO_MANY_REQUESTS", { message: error.message });
              throw error;
            }
            await invitationCapacity(invitation.organizationId, invitation.email, invitation.role);
          },
        },
      }),
      vaultSchema,
      jwt({ disableSettingJwtHeader: true }),
      hardenedMcp({
        loginPage: "/login",
        consentPage: "/mcp/consent",
        resource: new URL(
          "/api/mcp",
          process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
        ).toString(),
        scopes: [
          "openid",
          "profile",
          "offline_access",
          "mcp:read",
          "mcp:write",
          "linear:read",
          "linear:write",
        ],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 900,
        codeExpiresIn: 300,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        refreshTokenReuseInterval: 30,
        extensions: [
          {
            claims: {
              accessToken: async ({ user, client }) =>
                user
                  ? {
                      bella_grant_version: await authorizationVersion(user.id, client.clientId),
                    }
                  : {},
            },
          },
        ],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });
}

// Better Auth initializes its adapter and OAuth resources eagerly. Defer that work
// until a request so page collection during a build does not connect to Postgres.
type TidyAuth = ReturnType<typeof createAuth>;
const requestInstances = new WeakMap<object, TidyAuth>();
let nodeInstance: TidyAuth | undefined;
function createRequestAuth(): TidyAuth {
  const initialization = startOperation("auth.initialize");
  let instance: TidyAuth;
  try {
    instance = initialization.run(createAuth);
  } catch (error) {
    initialization.end(error);
    throw error;
  }
  const parent = requestSignal();
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(parent ? [parent] : [])]);
  const ready = traceAuthOperation("auth_initialization", () =>
    waitForSignal(instance.$context, signal),
  ).then(
    (context) => {
      initialization.end();
      return context;
    },
    (error) => {
      initialization.end(error);
      throw error;
    },
  );
  // Observe initialization failures even when the first access only reads options.
  void ready.catch(() => console.error(JSON.stringify({ event: "auth_initialization_failed" })));
  const api = new Proxy(instance.api, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) =>
        traceOperation("auth.api", async () => {
          await ready;
          assertRequestActive();
          return traceAuthOperation("auth_api", async () => Reflect.apply(method, target, args));
        });
    },
  });
  return new Proxy(instance, {
    get(target, key) {
      if (key === "$context") return ready;
      if (key === "api") return api;
      if (key === "handler" || key === "fetch")
        return (request: Request) =>
          traceOperation("auth.endpoint", async () => {
            await ready;
            assertRequestActive();
            return traceAuthOperation("auth_endpoint", () => target.handler(request));
          });
      return Reflect.get(target, key);
    },
  });
}
function getAuth() {
  let context: ReturnType<typeof getCloudflareContext>;
  try {
    context = getCloudflareContext();
  } catch {
    // A long-lived Node server has no Worker request lifetime restrictions.
    return (nodeInstance ??= createAuth());
  }
  // OAuth resource seeding performs I/O during initialization, even with schema
  // validation disabled. Never let another request inherit that pending promise
  // (or a rejected initialization) from an ended Worker invocation.
  const request = context.ctx;
  if (typeof request !== "object" || request === null)
    throw new Error("Cloudflare request context is unavailable.");
  let instance = requestInstances.get(request);
  if (!instance) {
    instance = createRequestAuth();
    requestInstances.set(request, instance);
  }
  return instance;
}
export const auth = new Proxy({} as TidyAuth, {
  get: (_target, key) => Reflect.get(getAuth(), key),
  has: (_target, key) => Reflect.has(getAuth(), key),
});
