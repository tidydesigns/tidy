import { isAbsolute, relative, resolve, sep } from "node:path";

export const APP_SCHEME = "tidy";
export const APP_URL = "tidy://app/index.html";

/** Development never expands the packaged app's trusted origin. */
export function rendererURL(packaged: boolean, developmentURL?: string) {
  if (packaged || !developmentURL) return APP_URL;
  const url = new URL(developmentURL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("The desktop development renderer must use a loopback URL.");
  return url.href;
}

export function trustedRendererURL(actual: string, expected: string) {
  try {
    const url = new URL(actual);
    url.hash = "";
    return url.href === expected;
  } catch {
    return false;
  }
}

/** Only immutable renderer output is served. No project or arbitrary file routes. */
export function rendererAssetPath(root: string, requestURL: string) {
  const url = new URL(requestURL);
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== "app" || url.username || url.password)
    throw new Error("Unknown desktop resource.");
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\\") || pathname.includes("\0")) throw new Error("Invalid resource path.");
  if (pathname !== "/index.html" && !pathname.startsWith("/assets/"))
    throw new Error("Unknown desktop resource.");
  const path = resolve(root, `.${pathname}`);
  const within = relative(root, path);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error("Invalid resource path.");
  return path;
}
