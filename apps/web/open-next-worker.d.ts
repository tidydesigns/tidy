// OpenNext produces this module during build:worker, after Next's type check.
declare module "*.open-next/cloudflare/next-env.mjs" {
  export const production: Record<string, string>;
}
declare module "*.open-next/worker.js" {
  const handler: { fetch: NonNullable<ExportedHandler<CloudflareEnv>["fetch"]> };
  export default handler;
}
