export function appOrigin(value?: string, requireHttps = false): string {
  const url = new URL(value ?? "http://localhost:3000");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.hostname === "localhost" && url.protocol === "http:"))
  )
    throw new Error("WXT_BELLA_URL must be an HTTPS origin or http://localhost:<port>.");
  if (requireHttps && (!value || url.protocol !== "https:"))
    throw new Error(
      "Production extension builds require an explicit HTTPS WXT_BELLA_URL. Use --mode development for a local build.",
    );
  return url.origin;
}
