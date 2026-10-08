import { validateClientIdUrl } from "@better-auth/cimd";
import { fetchClientMetadataResource as nodeFetch } from "@better-auth/cimd/node";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { authGuard } from "@/lib/auth/guard-client";
import { requestSignal, traceAuthOperation, waitForSignal } from "@/lib/auth/request-lifecycle";
import { traceOperation } from "@/lib/trace-context";

export const fetchClientMetadataResource: ClientMetadataResourceFetch = (input, init) =>
  traceOperation("oauth.client_metadata", () =>
    traceAuthOperation("client_metadata", async () => {
      const parent = requestSignal();
      if (parent)
        init = { ...init, signal: init?.signal ? AbortSignal.any([init.signal, parent]) : parent };
      // Detect the actual runtime, not NODE_ENV: production Next.js can also run in Node.
      if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") {
        return nodeFetch(input, init);
      }

      return workerFetch(input, init);
    }),
  );

const workerFetch = createWorkerMetadataFetch((request) => authGuard().fetch(request));

export function createWorkerMetadataFetch(
  fetchGuard: (request: Request) => Promise<Response>,
): ClientMetadataResourceFetch {
  return async (input, init) => {
    // Workers supports manual redirects, but not redirect: "error".
    const request = new Request(input, { ...init, redirect: "manual" });
    const error = validateClientIdUrl(request.url);
    if (error) throw new TypeError(error);
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new TypeError("CIMD transport supports only GET and HEAD");
    }

    // Workers does not implement the Node transport's dns.lookup(). Use its
    // public Internet fetch boundary instead (global_fetch_strictly_public in
    // wrangler.jsonc), never a service/VPC binding. DNS resolution and connection
    // routing stay inside that boundary; redirects must not bypass URL validation.
    const parent = requestSignal();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(6000),
      ...(parent ? [parent] : []),
    ]);
    const response = await traceAuthOperation("client_metadata", () =>
      waitForSignal(
        fetchGuard(
          new Request("https://auth-guard.internal/metadata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: request.url }),
            signal,
          }),
        ),
        signal,
      ),
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new TypeError("CIMD metadata redirects are not allowed");
    }
    return response;
  };
}
