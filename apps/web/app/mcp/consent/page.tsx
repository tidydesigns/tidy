import { DESKTOP_SYNC_SCOPE, desktopSyncResource } from "@tidy/design/cloud-sync";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AuthShell } from "@/components/auth/auth-shell";
import { ConsentChoice } from "./consent-choice";
import { verifyConsentQuery } from "@/lib/design/verify-consent-query";
import { createConsentApproval } from "@/lib/auth/oauth-consent";

export default async function McpConsentPage({ searchParams }: PageProps<"/mcp/consent">) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
  }
  const { secret } = await auth.$context;
  if (!(await verifyConsentQuery(query, secret))) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/login?next=${encodeURIComponent(`/mcp/consent?${query.toString()}`)}`);

  const clientId = query.get("client_id");
  if (!clientId) notFound();
  const client = await auth.api.getOAuthClientPublic({
    query: { client_id: clientId },
    headers: await headers(),
  });
  if (!client) notFound();
  const scopes = (query.get("scope") ?? "").split(" ");
  // MCP clients can retain desktop:sync from older discovery metadata. The
  // signed resource, rather than a scope or loopback callback, identifies sync.
  const desktopSync =
    scopes.includes(DESKTOP_SYNC_SCOPE) &&
    query
      .getAll("resource")
      .includes(desktopSyncResource(process.env.BETTER_AUTH_URL ?? "http://localhost:3000"));
  const redirectUri = query.get("redirect_uri");
  if (!redirectUri || !URL.canParse(redirectUri)) notFound();
  const callback = new URL(redirectUri);
  const localCallback = ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname);
  const oauthQuery = query.toString();
  const approval = await createConsentApproval(
    session.user.id,
    session.session.id,
    oauthQuery,
    secret,
  );

  return (
    <AuthShell
      title={desktopSync ? "Connect a desktop app" : "Connect a coding agent"}
      description={`${client.client_name ?? "This agent"} is requesting access to your Tidy account.`}
    >
      <p data-ph-public className="mt-8 text-sm text-primary-black/70">
        This connection can:
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-primary-black/80">
        {desktopSync && (
          <li data-ph-public>
            Read your workspaces and sync designs you choose to connect, including their images.
            Local projects stay on your computer until you choose to connect them.
          </li>
        )}
        {scopes.includes("mcp:read") && (
          <li data-ph-public>Read organizations and design files you can access.</li>
        )}
        {scopes.includes("mcp:write") && (
          <li data-ph-public>
            Create and edit design files, import editable UI screens, and upload design assets.
          </li>
        )}
        {scopes.includes("linear:read") && (
          <li data-ph-public>
            Read issues, comments and teams through your connected Linear accounts.
          </li>
        )}
        {scopes.includes("linear:write") && (
          <li data-ph-public>Create and update Linear issues and publish comments as you.</li>
        )}
        {scopes.includes("openid") && <li data-ph-public>Identify your Tidy account.</li>}
        {scopes.includes("profile") && <li data-ph-public>Read your name and profile image.</li>}
        {scopes.includes("offline_access") && (
          <li data-ph-public>
            Keep access using refresh tokens until you revoke the connection or they expire.
          </li>
        )}
      </ul>
      <p className="mt-5 break-words text-sm text-primary-black/70">
        <span data-ph-public style={{ display: "contents" }}>
          After authorization, return to
        </span>{" "}
        <span className="font-medium text-primary-black">{callback.host}</span>
        <span data-ph-public style={{ display: "contents" }}>
          .
        </span>
      </p>
      {localCallback && (
        <p data-ph-public className="mt-2 text-sm text-primary-black/70">
          This callback connects to an app on your computer. Continue only if you started this
          connection.
        </p>
      )}
      <ConsentChoice oauthQuery={oauthQuery} approval={approval} />
    </AuthShell>
  );
}
