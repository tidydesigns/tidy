import { auth } from "@/lib/auth";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  readCaptureBody,
  extensionError,
} from "@/lib/extension/http";
import { importWebCapture } from "@/lib/extension/import";

export const runtime = "nodejs";
export const OPTIONS = extensionPreflight;

export async function POST(request: Request) {
  const headers = extensionHeaders(request);
  if (!extensionRequestAllowed(request))
    return Response.json({ error: "Extension origin is not allowed." }, { status: 403, headers });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json({ error: "Sign in to Tidy to continue." }, { status: 401, headers });
  try {
    return Response.json(await importWebCapture(session.user.id, await readCaptureBody(request)), {
      headers,
    });
  } catch (error) {
    const { message, status } = extensionError(error);
    return Response.json({ error: message }, { status, headers });
  }
}
