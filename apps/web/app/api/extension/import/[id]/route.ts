import * as z from "zod";
import { auth } from "@/lib/auth";
import { operationBudgetResponse } from "@/lib/security/operation-budget";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  extensionError,
} from "@/lib/extension/http";
import { captureReceipt } from "@/lib/extension/receipts";

export const runtime = "nodejs";
export const OPTIONS = extensionPreflight;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
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
    const id = z.uuid().parse((await context.params).id);
    const receipt = await captureReceipt(session.user.id, id);
    return receipt
      ? Response.json(receipt, { headers })
      : Response.json({ error: "Capture receipt not found or expired." }, { status: 404, headers });
  } catch (error) {
    const { message, status } = extensionError(error);
    return Response.json({ error: message }, { status, headers });
  }
}
