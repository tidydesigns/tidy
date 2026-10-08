import { auth } from "@/lib/auth";
import { z } from "zod";
import { VersionError, versionSchemaReady } from "./file-versions";

export async function versionUser(request: Request, write = false) {
  if (write && request.headers.get("origin") !== new URL(request.url).origin)
    throw new VersionError("Untrusted request origin.", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (session && !session.user.emailVerified)
    throw new VersionError("Verify your email to access file history.", 403);
  if (!session) throw new VersionError("Authentication is required.", 401);
  if (!(await versionSchemaReady()))
    throw new VersionError("File history is not available on this database yet.", 503);
  return session.user.id;
}
export async function versionBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new VersionError("Request body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new VersionError("Version requests must be under 4 KB.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new VersionError("Invalid request body.", 400);
  }
}
export function versionFailure(error: unknown) {
  if (error instanceof VersionError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError)
    return Response.json({ error: "Invalid version request." }, { status: 400 });
  console.error("File history request failed", error);
  return Response.json({ error: "Could not read or change file history." }, { status: 500 });
}
export const versionHeaders = { "Cache-Control": "private, no-store" };
