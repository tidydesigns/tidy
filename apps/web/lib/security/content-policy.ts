/** Page policy shared by the request adapter and its compatibility checks. */
export function pageContentPolicy(nonce: string, development = false) {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) throw new Error("Invalid page nonce.");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: blob: https://fonts.gstatic.com",
    // The editor can load user-selected HTTPS resources and use a separate room host.
    `connect-src 'self' https: wss:${development ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob: data: https:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
