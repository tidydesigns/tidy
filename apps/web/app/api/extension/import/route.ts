import { operationBudgetResponse, operationFailure } from "@/lib/security/operation-budget";
import { auth } from "@/lib/auth";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  readCaptureBody,
  extensionError,
} from "@/lib/extension/http";
import { submitCapture } from "@/lib/extension/submit";
import { CaptureInProgressError } from "@/lib/extension/receipts";

export const runtime = "nodejs";
export const OPTIONS = extensionPreflight;

export async function POST(request: Request) {
  const headers = extensionHeaders(request);
  if (!extensionRequestAllowed(request))
    return Response.json({ error: "Extension origin is not allowed." }, { status: 403, headers });
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session)
      return Response.json({ error: "Sign in to Tidy to continue." }, { status: 401, headers });
    const denied = await operationBudgetResponse("import-request", session.user.id);
    if (denied) {
      for (const [name, value] of headers) denied.headers.set(name, value);
      return denied;
    }
    return Response.json(await submitCapture(session.user.id, await readCaptureBody(request)), {
      headers,
    });
  } catch (error) {
    if (error instanceof CaptureInProgressError)
      return Response.json({ state: "pending" }, { status: 202, headers });
    const denied = operationFailure(error);
    if (denied) {
      for (const [name, value] of headers) denied.headers.set(name, value);
      return denied;
    }
    const { message, status } = extensionError(error);
    return Response.json({ error: message }, { status, headers });
  }
}
