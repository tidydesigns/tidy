import { auth } from "@/lib/auth";
import { listDesignFiles, listDesignOrganizations } from "@/lib/design/service";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
} from "@/lib/extension/http";

export const runtime = "nodejs";
export const OPTIONS = extensionPreflight;

export async function GET(request: Request) {
  const headers = extensionHeaders(request);
  if (!extensionRequestAllowed(request))
    return Response.json({ error: "Extension origin is not allowed." }, { status: 403, headers });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json({ error: "Sign in to Tidy to continue." }, { status: 401, headers });
  const organizations = await listDesignOrganizations(session.user.id);
  return Response.json(
    {
      user: { id: session.user.id, name: session.user.name },
      organizations: await Promise.all(
        organizations
          .filter((organization) => organization.canEdit)
          .map(async (organization) => ({
            ...organization,
            files: (await listDesignFiles(session.user.id, organization.id)).map(
              ({ id, name }) => ({ id, name }),
            ),
          })),
      ),
    },
    { headers },
  );
}
