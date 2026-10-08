import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  readCaptureBody,
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
    const message =
      error instanceof ZodError
        ? "Capture is invalid or exceeds Tidy's design limits."
        : error instanceof Error
          ? error.message
          : "Could not import webpage.";
    const status = message.includes("access denied")
      ? 403
      : message.includes("16 MB")
        ? 413
        : message.includes("changed during import")
          ? 409
          : 400;
    return Response.json({ error: message }, { status, headers });
  }
}
