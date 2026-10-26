import { NextResponse, type NextRequest } from "next/server";
import { pageContentPolicy } from "./lib/security/content-policy";

export function proxy(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const policy = pageContentPolicy(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-tidy-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  // Nonces belong to one document response, including anonymous account pages.
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!api(?:/|$)|_next(?:/|$)|\\.well-known(?:/|$)|.*\\.[^/]+$).*)"],
};
