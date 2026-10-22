import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { DESKTOP_SYNC_SCOPE, desktopSyncResource } from "@tidy/design/cloud-sync";
import { cloudAccountSchema } from "../shared/cloud-sync";
import { PrivateState } from "./private-state";

const tokens = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().positive().max(86400),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});
const sessionSchema = z.object({
  clientId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  accountId: z.string(),
});
type Session = z.infer<typeof sessionSchema>;
export type CredentialProtection = {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};

export function cloudOrigin(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Cloud sync requires an HTTPS origin or a loopback development server.");
  return url.origin;
}
export class CloudHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(
      status === 401
        ? "Sign in to reconnect cloud sync."
        : "Cloud sync could not complete this request.",
    );
  }
}

/** Native public client: S256 PKCE, system browser, ephemeral loopback callback, OS-protected credentials. */
export class CloudAuth {
  private session?: Session;
  private refresh?: Promise<void>;
  private login?: Promise<void>;
  private cancelLogin?: () => void;
  private loginAbort?: AbortController;
  private epoch = 0;
  private clientId?: string;
  private writes = Promise.resolve();
  private notBefore = 0;
  readonly origin: string;
  constructor(
    origin: string,
    private state: PrivateState,
    private protection: CredentialProtection,
    private openBrowser: (url: string) => Promise<void>,
    private fetcher: typeof fetch = fetch,
  ) {
    this.origin = cloudOrigin(origin);
  }
  get available() {
    return this.protection.available();
  }
  get accountId() {
    return this.session?.accountId;
  }
  cancelSignIn() {
    this.epoch++;
    this.cancelLogin?.();
    this.loginAbort?.abort();
  }
  async initialize() {
    if (!this.available) return;
    const client = z
      .object({ origin: z.string(), clientId: z.string() })
      .optional()
      .parse(await this.state.read("oauth-client"));
    if (client?.origin === this.origin) this.clientId = client.clientId;
    const stored = await this.state.read("credentials");
    if (!stored) return;
    const value = z.object({ origin: z.string(), encrypted: z.string() }).parse(stored);
    if (value.origin === this.origin)
      this.session = sessionSchema.parse(
        JSON.parse(this.protection.decrypt(Buffer.from(value.encrypted, "base64"))),
      );
  }
  private async persist(session: Session, epoch: number) {
    if (!this.available)
      throw new Error("Protected credential storage is unavailable on this computer.");
    const write = this.writes.then(async () => {
      if (epoch !== this.epoch) throw new CloudHTTPError(401);
      await this.state.write("credentials", {
        origin: this.origin,
        encrypted: this.protection.encrypt(JSON.stringify(session)).toString("base64"),
      });
      if (epoch === this.epoch) {
        if (this.session?.accountId !== session.accountId) this.notBefore = 0;
        this.session = session;
      }
    });
    this.writes = write.catch(() => {});
    await write;
  }
  private async raw(path: string, init?: RequestInit) {
    const epoch = this.epoch,
      accountId = this.accountId;
    const response = await this.fetcher(`${this.origin}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds = retry === null ? NaN : Number(retry);
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : Math.max(0, Date.parse(retry ?? "") - Date.now());
      const wait = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
      if (
        path.startsWith("/api/desktop/") &&
        epoch === this.epoch &&
        accountId === this.accountId &&
        (response.status === 429 || (response.status === 503 && wait > 0))
      )
        this.notBefore = Math.max(this.notBefore, Date.now() + (wait || 60_000));
      await response.body?.cancel().catch(() => {});
      throw new CloudHTTPError(response.status, wait);
    }
    return response;
  }
  signIn() {
    if (this.login) return this.login;
    const work = this.authorize();
    this.login = work;
    void work
      .finally(() => {
        if (this.login === work) this.login = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async authorize() {
    if (!this.available) throw new Error("Cloud login needs protected credential storage.");
    const epoch = this.epoch;
    const abort = new AbortController();
    this.loginAbort = abort;
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let accept!: (code: string) => void, reject!: (error: Error) => void;
    const code = new Promise<string>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    // Attach immediately so cancellation during client registration never becomes unhandled.
    void code.catch(() => {});
    const server = createServer((request, response) => {
      let callback: URL;
      try {
        callback = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        response.writeHead(400, { Connection: "close" }).end();
        return;
      }
      if (
        request.method !== "GET" ||
        callback.pathname !== "/callback" ||
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== state
      ) {
        response.writeHead(400).end();
        return;
      }
      const value = callback.searchParams.get("code");
      if (!value || callback.searchParams.getAll("code").length !== 1 || value.length > 4096) {
        response.writeHead(400).end("Sign-in was not completed.");
        reject(new Error("Sign-in was not completed."));
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
          "Referrer-Policy": "no-referrer",
        })
        .end("Connected to Tidy. You can return to the desktop app.");
      accept(value);
    });
    const cancel = () => reject(new Error("Cloud sign-in was cancelled."));
    this.cancelLogin = cancel;
    const timer = setTimeout(
      () => reject(new Error("Cloud sign-in timed out. Try again.")),
      300_000,
    );
    try {
      await new Promise<void>((resolve, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Could not start desktop sign-in.");
      const redirect = `http://127.0.0.1:${address.port}/callback`;
      const resource = desktopSyncResource(this.origin);
      const registered = this.clientId
        ? { client_id: this.clientId }
        : z.object({ client_id: z.string().min(1) }).parse(
            await (
              await this.raw("/api/auth/oauth2/register", {
                signal: abort.signal,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  client_name: "Tidy desktop",
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
      this.clientId = registered.client_id;
      await this.state.write("oauth-client", {
        origin: this.origin,
        clientId: registered.client_id,
      });
      const query = new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: redirect,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: `${DESKTOP_SYNC_SCOPE} offline_access`,
        resource,
      });
      if (epoch !== this.epoch) throw new Error("Cloud sign-in was cancelled.");
      await this.openBrowser(`${this.origin}/api/auth/oauth2/authorize?${query}`);
      const token = tokens.parse(
        await (
          await this.raw("/api/auth/oauth2/token", {
            signal: abort.signal,
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: await code,
              code_verifier: verifier,
              client_id: registered.client_id,
              redirect_uri: redirect,
              resource,
            }),
          })
        ).json(),
      );
      if (!token.refresh_token) throw new Error("The server did not authorize background sync.");
      const account = cloudAccountSchema.parse(
        await (
          await this.raw("/api/desktop/account", {
            signal: abort.signal,
            headers: { Authorization: `Bearer ${token.access_token}` },
          })
        ).json(),
      );
      if (epoch !== this.epoch) throw new Error("Cloud sign-in was cancelled.");
      await this.persist(
        {
          clientId: registered.client_id,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
          accountId: account.id,
        },
        epoch,
      );
    } finally {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (this.cancelLogin === cancel) this.cancelLogin = undefined;
      if (this.loginAbort === abort) this.loginAbort = undefined;
    }
  }
  private async renew() {
    const session = this.session,
      epoch = this.epoch;
    if (!session) throw new CloudHTTPError(401);
    const token = tokens.parse(
      await (
        await this.raw("/api/auth/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: session.clientId,
            refresh_token: session.refreshToken,
            resource: desktopSyncResource(this.origin),
          }),
        })
      ).json(),
    );
    if (epoch !== this.epoch) throw new CloudHTTPError(401);
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
  async request(path: string, init?: RequestInit) {
    if (!path.startsWith("/api/desktop/")) throw new Error("Invalid cloud API path.");
    if (!this.session) throw new CloudHTTPError(401);
    if (Date.now() < this.notBefore) throw new CloudHTTPError(429, this.notBefore - Date.now());
    if (this.session.expiresAt < Date.now() + 60_000) {
      if (!this.refresh)
        this.refresh = this.renew().finally(() => {
          this.refresh = undefined;
        });
      await this.refresh;
    }
    if (!this.session) throw new CloudHTTPError(401);
    return this.raw(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        Authorization: `Bearer ${this.session!.accessToken}`,
      },
    });
  }
  async signOut() {
    this.cancelSignIn();
    const session = this.session;
    this.session = undefined;
    this.notBefore = 0;
    await this.writes;
    await this.state.remove("credentials");
    if (session)
      void this.raw("/api/auth/oauth2/revoke", {
        method: "POST",
        body: new URLSearchParams({
          token: session.refreshToken,
          token_type_hint: "refresh_token",
          client_id: session.clientId,
        }),
      }).catch(() => {});
  }
}
