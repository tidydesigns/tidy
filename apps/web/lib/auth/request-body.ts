import { withRequestBodyLimit } from "@/lib/http/request-body";

const registrationLimits = { elements: 2048, depth: 16 };
// Match Better Call's JSON classification so alternate media types cannot
// reach its JSON parser without the same metadata admission checks.
const jsonContentType = /^application\/([a-z0-9.+-]*\+)?json/i;

/** Bound validation work before anonymous client metadata reaches provider schemas. */
function registrationWithinLimits(input: unknown) {
  const pending = [{ value: input, depth: 0 }];
  let elements = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++elements > registrationLimits.elements || depth > registrationLimits.depth) return false;
    if (!value || typeof value !== "object") continue;
    const children = Object.values(value);
    if (elements + pending.length + children.length > registrationLimits.elements) return false;
    for (const child of children) pending.push({ value: child, depth: depth + 1 });
  }
  return true;
}

export function withAuthRequestBodyLimit(handler: (request: Request) => Promise<Response>) {
  return withRequestBodyLimit(async (request) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname).replace(/\/+$/, "");
    } catch {
      return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (
      path === "/api/auth/oauth2/register" &&
      jsonContentType.test(request.headers.get("content-type") ?? "")
    ) {
      // The outer byte/deadline limit applies before this extra bounded JSON read.
      // Leave malformed JSON to the provider's ordinary protocol error handling.
      const input: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (!registrationWithinLimits(input))
        return Response.json(
          {
            error: "invalid_client_metadata",
            error_description: "Client metadata contains too many values or is nested too deeply.",
          },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
    }
    return handler(request);
  });
}
