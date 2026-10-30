import * as z from "zod";
import { auth } from "@/lib/auth";
import { captureDestinations, authorizeCaptureDestination } from "@/lib/extension/destinations";
import { operationBudgetResponse } from "@/lib/security/operation-budget";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  extensionError,
} from "@/lib/extension/http";

export const runtime = "nodejs";
export const OPTIONS = extensionPreflight;
const destinationCheck = z.object({
  userId: z.string().min(1).max(120),
  organizationId: z.string().min(1).max(120),
  fileId: z.uuid().optional(),
});

export async function GET(request: Request) {
  const headers = extensionHeaders(request);
  if (!extensionRequestAllowed(request))
    return Response.json({ error: "Extension origin is not allowed." }, { status: 403, headers });
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session)
      return Response.json({ error: "Sign in to Tidy to continue." }, { status: 401, headers });
    const denied = await operationBudgetResponse("extension-read", session.user.id);
    if (denied) {
      for (const [name, value] of headers) denied.headers.set(name, value);
      return denied;
    }
    const user = {
      id: session.user.id,
      name: session.user.name,
      image: session.user.image ?? null,
    };
    const query = new URL(request.url).searchParams;
    if (query.has("organizationId")) {
      const destination = destinationCheck.parse(Object.fromEntries(query));
      if (destination.userId !== user.id)
        return Response.json(
          { error: "Your Tidy account changed. Choose the destination again." },
          { status: 409, headers },
        );
      await authorizeCaptureDestination(user.id, destination.organizationId, destination.fileId);
      return Response.json({ user }, { headers });
    }
    return Response.json({ user, organizations: await captureDestinations(user.id) }, { headers });
  } catch (error) {
    const { message, status } = extensionError(error);
    return Response.json({ error: message }, { status, headers });
  }
}
