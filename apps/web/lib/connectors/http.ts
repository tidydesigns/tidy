import "server-only";
import { auth } from "@/lib/auth";
import { boundedRequest, RequestBodyError } from "@/lib/http/request-body";
import { waitForSignal } from "@/lib/request-lifecycle";
import { ZodError } from "zod";

import { ConnectorError } from "./error";
import { OAuthSessionError } from "./oauth-session";
export { ConnectorError } from "./error";
export function connectorOrigin() {
  return new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
}
export async function connectorUser(request: Request, mutation = false) {
  return (await connectorSession(request, mutation)).user.id;
}
export async function connectorSession(request: Request, mutation = false) {
  if (mutation && request.headers.get("origin") !== connectorOrigin())
    throw new ConnectorError("Request origin denied.", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new ConnectorError("Sign in to manage connectors.", 401);
  return session;
}
export async function readLimited(
  response: Response,
  limit = 1024 * 1024,
  signal = AbortSignal.timeout(10_000),
  charge: (bytes: number) => void = () => {},
) {
  signal.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await waitForSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ConnectorError("Connector response is too large.", 413);
      charge(value.byteLength);
      parts.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(parts, size).toString("utf8");
}
export async function connectorJson(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ConnectorError("Expected JSON.", 415);
  try {
    return JSON.parse(await (await boundedRequest(request, 64 * 1024)).text()) as unknown;
  } catch (error) {
    if (error instanceof RequestBodyError) throw new ConnectorError(error.message, error.status);
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("Invalid JSON.");
  }
}

export function json(value: unknown) {
  return Response.json(value, { headers: { "Cache-Control": "private, no-store" } });
}
export function connectorError(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof ConnectorError || error instanceof OAuthSessionError
          ? error.message
          : error instanceof ZodError
            ? "Invalid connector fields."
            : "Could not complete the connector request. Try again.",
    },
    {
      status:
        error instanceof ConnectorError || error instanceof OAuthSessionError
          ? error.status
          : error instanceof ZodError
            ? 400
            : 500,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
