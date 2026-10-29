import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { z } from "zod";
import { DESKTOP_SYNC_SCOPE, desktopSyncResource } from "@tidy/design/cloud-sync";
import { cloudAccountSchema } from "@tidy/agent-protocol/contracts/cloud-sync";
import { CloudError } from "./cloud";

const sessionSchema = z.object({
  origin: z.url(),
  clientId: z.string(),
  accountId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().positive().max(86400),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});
export function cloudOrigin(input: string) {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Enter the HTTPS address of your Tidy cloud.");
  return url.origin;
}
const key = "tidy.mobile.cloud.v1";
const redirect = "design.tidy.mobile:/oauth/callback";
export class MobileAuth {
  session?: z.infer<typeof sessionSchema>;
  private epoch = 0;
  private renewing?: Promise<void>;
  private writes = Promise.resolve();
  private notBefore = 0;
  async restore() {
    if (Platform.OS === "web") return;
    const value = await SecureStore.getItemAsync(key);
    if (value) {
      const session = sessionSchema.parse(JSON.parse(value));
      cloudOrigin(session.origin);
      this.session = session;
    }
  }
  private async persist(session: z.infer<typeof sessionSchema>, epoch: number) {
    if (epoch !== this.epoch) throw new Error("Cloud session changed.");
    const write = this.writes.then(async () => {
      if (epoch !== this.epoch) throw new Error("Cloud session changed.");
      await SecureStore.setItemAsync(key, JSON.stringify(session), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      if (epoch === this.epoch) this.session = session;
    });
    this.writes = write.catch(() => {});
    await write;
  }
  private async raw(origin: string, path: string, init?: RequestInit) {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      const value = response.headers.get("retry-after");
      const seconds = value ? Number(value) : 30;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value!) - Date.now();
      this.notBefore =
        Date.now() + Math.max(5_000, Math.min(300_000, Number.isFinite(delay) ? delay : 30_000));
    }
    if (!response.ok) throw new CloudError(response.status);
    return response;
  }
  async signIn(input: string) {
    if (Platform.OS === "web")
      throw new Error(
        "Cloud sign-in uses the installed iOS or Android app. This browser preview supports local design files.",
      );
    const epoch = ++this.epoch;
    const origin = cloudOrigin(input),
      resource = desktopSyncResource(origin);
    const registered = z.object({ client_id: z.string().min(1).max(4096) }).parse(
      await (
        await this.raw(origin, "/api/auth/oauth2/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Tidy mobile",
            application_type: "native",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: `${DESKTOP_SYNC_SCOPE} offline_access`,
            resources: [resource],
          }),
        })
      ).json(),
    );
    const request = new AuthSession.AuthRequest({
      clientId: registered.client_id,
      redirectUri: redirect,
      scopes: [DESKTOP_SYNC_SCOPE, "offline_access"],
      usePKCE: true,
      state: Crypto.randomUUID(),
      extraParams: { resource },
    });
    const discovery = { authorizationEndpoint: `${origin}/api/auth/oauth2/authorize` };
    await request.makeAuthUrlAsync(discovery);
    const result = await request.promptAsync(discovery);
    if (epoch !== this.epoch) throw new Error("Cloud sign-in was cancelled.");
    if (result.type !== "success" || !result.params.code || result.params.state !== request.state)
      throw new Error("Cloud sign-in was cancelled or could not be verified.");
    const callback = new URL(result.url);
    if (
      `${callback.protocol}${callback.pathname}` !== redirect ||
      callback.host ||
      callback.hash ||
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.getAll("code").length !== 1 ||
      result.params.code.length > 4096
    )
      throw new Error("Cloud sign-in returned an invalid callback.");
    const token = tokenSchema.parse(
      await (
        await this.raw(origin, "/api/auth/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: result.params.code,
            client_id: registered.client_id,
            redirect_uri: redirect,
            code_verifier: request.codeVerifier!,
            resource,
          }),
        })
      ).json(),
    );
    if (!token.refresh_token) throw new Error("Cloud did not authorize background sync.");
    const account = cloudAccountSchema.parse(
      await (
        await this.raw(origin, "/api/desktop/account", {
          headers: { Authorization: `Bearer ${token.access_token}` },
        })
      ).json(),
    );
    await this.persist(
      {
        origin,
        clientId: registered.client_id,
        accountId: account.id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      },
      epoch,
    );
  }
  private async renew() {
    const session = this.session,
      epoch = this.epoch;
    if (!session) throw new CloudError(401);
    const token = tokenSchema.parse(
      await (
        await this.raw(session.origin, "/api/auth/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: session.clientId,
            refresh_token: session.refreshToken,
            resource: desktopSyncResource(session.origin),
          }),
        })
      ).json(),
    );
    await this.persist(
      {
        ...session,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? session.refreshToken,
        expiresAt: Date.now() + token.expires_in * 1000,
      },
      epoch,
    );
  }
  request = async (path: string, init?: RequestInit) => {
    if (Date.now() < this.notBefore) throw new CloudError(429);
    if (!path.startsWith("/api/desktop/")) throw new Error("Invalid cloud API path.");
    if (!this.session) throw new CloudError(401);
    if (this.session.expiresAt < Date.now() + 60_000) {
      this.renewing ??= this.renew().finally(() => {
        this.renewing = undefined;
      });
      await this.renewing;
    }
    const session = this.session;
    if (!session) throw new CloudError(401);
    return this.raw(session.origin, path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
  };
  async signOut() {
    ++this.epoch;
    try {
      WebBrowser.dismissAuthSession();
    } catch {
      /* No open browser session. */
    }
    const session = this.session;
    this.session = undefined;
    const removal = this.writes.then(async () => {
      if (Platform.OS !== "web") await SecureStore.deleteItemAsync(key);
    });
    this.writes = removal.catch(() => {});
    await removal;
    if (session)
      void this.raw(session.origin, "/api/auth/oauth2/revoke", {
        method: "POST",
        body: new URLSearchParams({
          token: session.refreshToken,
          token_type_hint: "refresh_token",
          client_id: session.clientId,
        }),
      }).catch(() => {});
  }
}
